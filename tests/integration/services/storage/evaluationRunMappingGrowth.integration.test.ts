/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: EvaluationRun.results must not blow up the
 * `evals_experiments` index's total field count as test-case results
 * accumulate, against a REAL OpenSearch cluster.
 *
 * Regression coverage for the 2026-08-26 incident: a 400-test-case
 * EvaluationRun crashed mid-run at 243/400 test cases with
 * "Limit of total fields [5000] has been exceeded". `results` is a
 * `Record<testCaseId, {...}>` map stored as a TOP-LEVEL field on the
 * EvaluationRun document (see OpenSearchEvaluationRunOperations — a
 * different code path than the legacy nested `runs.results`, which already
 * had this protection). Without an explicit non-dynamic mapping for the
 * top-level `results` field, every unique testCaseId across every run ever
 * created added new mapped fields to the index, shared across ALL documents
 * in the index — eventually exceeding the field-count ceiling.
 *
 * This test exercises the real production write paths (no mocks) against a
 * REAL OpenSearch cluster:
 *   1. A throwaway `ahtest-*` index is created from the exact
 *      `evals_experiments` entry in `INDEX_MAPPINGS` (the fix under test),
 *      and `STORAGE_INDEXES.benchmarks` is redirected at it for this test
 *      file's module registry (jest gives each test file its own registry,
 *      so nothing leaks to other files). The suite therefore runs the REAL
 *      `OpenSearchEvaluationRunOperations` code paths — while the real
 *      `evals_experiments` index is never touched. That isolation matters:
 *      the failure mode this suite exists to catch is MAPPING growth, and
 *      mapping growth in a real shared index is permanent (deleting
 *      documents does not shrink a mapping — only dropping the index does).
 *   2. Test A synthesizes a run with 500 test-case results in one write
 *      (comparable to, with margin, the 400-case run that crashed in
 *      production) via `OpenSearchEvaluationRunOperations.create()`, then
 *      reads it back and checks the index's total field count.
 *   3. Test B exercises `updateResult()` — the exact method the real
 *      evaluation runner calls per completed test case, via a painless
 *      partial update — repeatedly, proving incremental writes don't grow
 *      the mapping either (kept to a smaller count; each call round-trips
 *      to the cluster with `refresh: 'wait_for'`, matching production
 *      semantics but too slow at N=500 for a test).
 *
 * Cluster: STRICTLY OPT-IN via `TEST_OPENSEARCH_ENDPOINT` (with a
 * localhost:9200 fallback only under GitHub Actions, where the CI
 * `integration-tests` job provisions a disposable service container) — see
 * tests/helpers/rawOpenSearchCluster.ts. Without the opt-in the suite SKIPS:
 * it must never write synthetic garbage into an unknown local port 9200
 * (which may be a port-forward to a shared cluster).
 *
 * To run locally against a disposable cluster:
 *   docker run -d --rm -p 9200:9200 -e discovery.type=single-node \
 *     -e DISABLE_SECURITY_PLUGIN=true -e DISABLE_INSTALL_DEMO_CONFIG=true \
 *     opensearchproject/opensearch:2.17.0
 *   TEST_OPENSEARCH_ENDPOINT=http://localhost:9200 \
 *     npm run test:integration -- evaluationRunMappingGrowth
 */

import { Client } from '@opensearch-project/opensearch';
import { OpenSearchStorageModule } from '@/server/adapters/opensearch/StorageModule';
import { FileSessionMetadataOperations } from '@/server/adapters/file/StorageModule';
import { INDEX_MAPPINGS } from '@/server/constants/indexMappings';
import { STORAGE_INDEXES } from '@/server/middleware/dataSourceConfig';
import type { EvaluationRun } from '@/types';
import {
  RawOpenSearchTestData,
  createRawOpenSearchClient,
  rawClusterReachable,
  rawOpenSearchOptInHint,
  resolveRawOpenSearchEndpoint,
} from '../../../helpers/rawOpenSearchCluster';
import { uniqueTestName } from '../../../helpers/testDataTracker';

const ENDPOINT = resolveRawOpenSearchEndpoint();
/** Real index name, captured before the suite redirects STORAGE_INDEXES.benchmarks. */
const REAL_INDEX = STORAGE_INDEXES.benchmarks;
const NUM_TEST_CASES = 500; // > the 400 that crashed in production, with margin
const NUM_INCREMENTAL_UPDATES = 25; // smaller: each updateResult() round-trips with refresh:'wait_for'
// The index is now private to this suite (throwaway, created fresh), so no
// concurrent test file can race the before/after mapping snapshots. A small
// slack remains purely as defense against OpenSearch inferring an incidental
// field this test didn't anticipate — the bug this guards against adds ~1000+
// fields for one 500-case run, orders of magnitude past it.
const FIELD_COUNT_SLACK = 5;
// Unique per test run (Date.now()-seeded) so this suite's synthetic
// testCaseIds are recognizable and collision-free.
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Opt-in gate: without an explicitly-provided disposable cluster this suite
// SKIPS (visible in jest output) instead of guessing at localhost:9200.
const describeIfOptedIn = ENDPOINT ? describe : describe.skip;
if (!ENDPOINT) {
  // eslint-disable-next-line no-console
  console.warn(rawOpenSearchOptInHint('EvaluationRun results mapping growth'));
}

/** Recursively count mapped fields the way OpenSearch's total_fields.limit does. */
function countMappedFields(properties: Record<string, any>): number {
  let total = 0;
  for (const spec of Object.values(properties)) {
    total += 1;
    if (spec && typeof spec === 'object') {
      if (spec.fields) total += Object.keys(spec.fields).length;
      if (spec.properties) total += countMappedFields(spec.properties);
    }
  }
  return total;
}

function buildResults(count: number, prefix = 'tc'): EvaluationRun['results'] {
  const results: EvaluationRun['results'] = {};
  for (let i = 0; i < count; i++) {
    results[`${prefix}-${i}`] = { reportId: `report-${i}`, status: 'completed' };
  }
  return results;
}

describeIfOptedIn('EvaluationRun results mapping growth (real OpenSearch)', () => {
  let client: Client;
  let storage: OpenSearchStorageModule;
  let testData: RawOpenSearchTestData;
  let available = false;
  /** Throwaway ahtest-* index this suite writes into (stands in for evals_experiments). */
  let index: string;

  beforeAll(async () => {
    client = createRawOpenSearchClient(ENDPOINT!);
    available = await rawClusterReachable(client);
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping mapping-growth tests`);
      return;
    }

    // Create a throwaway index from the REAL evals_experiments mapping (the
    // fix under test), then point the storage module's lazily-read index name
    // at it so every production code path below runs against the throwaway.
    testData = new RawOpenSearchTestData(client);
    index = await testData.createThrowawayIndex(
      'mapping-growth-experiments',
      INDEX_MAPPINGS[REAL_INDEX] as Record<string, unknown>
    );
    (STORAGE_INDEXES as { benchmarks: string }).benchmarks = index;

    storage = new OpenSearchStorageModule(client, new FileSessionMetadataOperations());
  }, 30000);

  afterAll(async () => {
    // Runs even when assertions fail. Restore the redirected index name,
    // then drop the throwaway index (docs AND any mapping growth with it).
    (STORAGE_INDEXES as { benchmarks: string }).benchmarks = REAL_INDEX;
    if (available && testData) {
      await testData.cleanup();
    }
    if (client) {
      await client.close().catch(() => {});
    }
  });

  it('synthesizes a run with 500 test-case results: persists, reads back correctly, and does not grow the mapping', async () => {
    if (!available) return; // graceful skip, see beforeAll warning

    // Baseline field count from an empty-results run, so the assertion below
    // is attributable to the 500 results, not index bootstrap noise. Uses a
    // populated (not empty) testCaseSnapshots array too, matching the 500-case
    // run below — an empty array never triggers dynamic field inference at
    // all, which would otherwise mask the one-time (not per-item) cost of
    // OpenSearch inferring testCaseSnapshots.{id,name,version} the first time
    // it sees a populated array. That one-time cost is expected/fine — it's
    // bounded regardless of array length, unlike the unbounded `results` map
    // this test actually guards against.
    const baselineRunId = uniqueTestName('eval-run-mapping-baseline');
    testData.trackDoc(index, baselineRunId);
    await storage.evaluationRuns.create({
      id: baselineRunId,
      docType: 'evaluation-run',
      name: uniqueTestName('mapping-baseline-empty-results'),
      createdAt: new Date().toISOString(),
      status: 'running',
      agentKey: 'demo',
      modelId: 'test-model',
      sources: [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: [{ id: `tc-baseline-${RUN_TAG}`, version: 1, name: 'Baseline test case' }],
      results: {},
    } as EvaluationRun);
    await client.indices.refresh({ index });
    const baselineMapping = await client.indices.getMapping({ index });
    const baselineFieldCount = countMappedFields(
      (baselineMapping.body as any)[index].mappings.properties
    );

    const runId = uniqueTestName('eval-run-mapping-growth');
    const tcPrefix = `mg-tc-${RUN_TAG}`;
    const run: EvaluationRun = {
      id: runId,
      docType: 'evaluation-run',
      name: uniqueTestName('mapping-growth-500-test-cases'),
      createdAt: new Date().toISOString(),
      status: 'completed',
      agentKey: 'demo',
      modelId: 'test-model',
      sources: [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: Array.from({ length: NUM_TEST_CASES }, (_, i) => ({
        id: `${tcPrefix}-${i}`,
        version: 1,
        name: `Test case ${i}`,
      })),
      results: buildResults(NUM_TEST_CASES, tcPrefix),
    };

    testData.trackDoc(index, runId);
    await storage.evaluationRuns.create(run);
    await client.indices.refresh({ index });

    // 1. Reads back correctly: all 500 results present with correct shape.
    const fetched = await storage.evaluationRuns.getById(runId);
    expect(fetched).not.toBeNull();
    expect(Object.keys(fetched!.results)).toHaveLength(NUM_TEST_CASES);
    expect(fetched!.results[`${tcPrefix}-0`]).toEqual({ reportId: 'report-0', status: 'completed' });
    expect(fetched!.results[`${tcPrefix}-499`]).toEqual({ reportId: 'report-499', status: 'completed' });

    // 2. No meaningful mapping growth: field count with 500 distinct
    // testCaseId keys in `results` stays within FIELD_COUNT_SLACK of the
    // empty-results baseline. Before the fix, this grows by ~2-5 fields per
    // test case (results.<id>.reportId, .status, their .keyword sub-fields,
    // ...) — i.e. 1000+ new fields for this one run alone, dwarfing the slack.
    const afterMapping = await client.indices.getMapping({ index });
    const afterFieldCount = countMappedFields((afterMapping.body as any)[index].mappings.properties);
    expect(afterFieldCount - baselineFieldCount).toBeLessThanOrEqual(FIELD_COUNT_SLACK);

    // 3. The `results` field itself stays the disabled opaque-object shape —
    // never gains per-testCaseId sub-properties. This is the deterministic,
    // race-proof assertion.
    const resultsMapping = (afterMapping.body as any)[index].mappings.properties.results;
    expect(resultsMapping).toEqual({ type: 'object', enabled: false });
  }, 60000);

  it('incrementally written results (real updateResult() painless path, per-test-case) also do not grow the mapping', async () => {
    if (!available) return;

    const beforeMapping = await client.indices.getMapping({ index });
    const beforeFieldCount = countMappedFields((beforeMapping.body as any)[index].mappings.properties);

    const runId = uniqueTestName('eval-run-mapping-incremental');
    const tcPrefix = `incr-tc-${RUN_TAG}`;
    testData.trackDoc(index, runId);
    await storage.evaluationRuns.create({
      id: runId,
      docType: 'evaluation-run',
      name: uniqueTestName('mapping-incremental-updateresult'),
      createdAt: new Date().toISOString(),
      status: 'running',
      agentKey: 'demo',
      modelId: 'test-model',
      sources: [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: [],
      results: {},
    } as EvaluationRun);

    // Exercise the exact method the real evaluation runner calls per
    // completed test case (server/routes/storage/evaluationRuns.ts
    // onTestCaseComplete → storage.evaluationRuns.updateResult), via a
    // painless partial update — not a full-document reindex.
    for (let i = 0; i < NUM_INCREMENTAL_UPDATES; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await storage.evaluationRuns.updateResult(runId, `${tcPrefix}-${i}`, {
        reportId: `report-${i}`,
        status: 'completed',
      });
      expect(ok).toBe(true);
    }

    const fetched = await storage.evaluationRuns.getById(runId);
    expect(Object.keys(fetched!.results)).toHaveLength(NUM_INCREMENTAL_UPDATES);

    await client.indices.refresh({ index });
    const afterMapping = await client.indices.getMapping({ index });
    const afterFieldCount = countMappedFields((afterMapping.body as any)[index].mappings.properties);
    expect(afterFieldCount - beforeFieldCount).toBeLessThanOrEqual(FIELD_COUNT_SLACK);

    const resultsMapping = (afterMapping.body as any)[index].mappings.properties.results;
    expect(resultsMapping).toEqual({ type: 'object', enabled: false });
  }, 60000);
});
