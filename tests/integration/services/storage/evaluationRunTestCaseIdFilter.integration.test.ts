/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: `GET /api/storage/evaluation-runs?testCaseId=<id>` (i.e.
 * `OpenSearchEvaluationRunOperations.list({ testCaseId })`) against a REAL
 * OpenSearch cluster.
 *
 * Regression: `testCaseSnapshots` on EvaluationRun docs is a plain
 * dynamically-mapped `object` array (see server/constants/indexMappings.ts —
 * it's intentionally left out of the explicit mapping since it's a bounded
 * 3-property shape regardless of array length, so it's not the field-count
 * growth vector that mapping change addresses), NOT `nested`. The `list()`
 * testCaseId filter used a `nested` query against it, which OpenSearch
 * rejects outright — `query_shard_exception: nested object under path
 * [testCaseSnapshots] is not of nested type` — a 400/500 on every call to
 * `GET /api/storage/evaluation-runs?testCaseId=...`, not just a silent
 * zero-results bug. Discovered via `codex_review` while reviewing the
 * `results` field-count-growth fix in this same PR (mocked unit tests for
 * `list()` never exercise real OpenSearch mapping-compatibility errors).
 *
 * Fixed by using a plain `term` on the array's flattened `.keyword`
 * multi-field (`testCaseSnapshots.id.keyword`) instead of a `nested` query —
 * a plain `object`-type array flattens each leaf field's values across all
 * elements, so a term query matches if ANY element has that id, which is
 * exactly the filter semantics this needs.
 *
 * Unlike the mapping-growth suites (which write thousands of distinct field
 * names and therefore run against throwaway `ahtest-*` indices), this suite
 * uses the real `evals_experiments` index bootstrapped by the production
 * `ensureIndexesWithValidation()` path: its two docs contain only standard
 * production field shapes (no synthetic field names, so no mapping impact),
 * and both are tracked and deleted in `afterAll`.
 *
 * Cluster: STRICTLY OPT-IN via `TEST_OPENSEARCH_ENDPOINT` (with a
 * localhost:9200 fallback only under GitHub Actions, where the CI
 * `integration-tests` job provisions a disposable service container) — see
 * tests/helpers/rawOpenSearchCluster.ts. Without the opt-in the suite SKIPS:
 * it must never write synthetic docs into an unknown local port 9200 (which
 * may be a port-forward to a shared cluster). Skips gracefully if the opted-
 * in cluster is unreachable, same as the mapping-growth suites.
 */

import { Client } from '@opensearch-project/opensearch';
import { OpenSearchStorageModule } from '@/server/adapters/opensearch/StorageModule';
import { FileSessionMetadataOperations } from '@/server/adapters/file/StorageModule';
import { ensureIndexesWithValidation } from '@/server/services/indexInitializer';
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
const INDEX = STORAGE_INDEXES.benchmarks;

// Opt-in gate: without an explicitly-provided disposable cluster this suite
// SKIPS (visible in jest output) instead of guessing at localhost:9200.
const describeIfOptedIn = ENDPOINT ? describe : describe.skip;
if (!ENDPOINT) {
  // eslint-disable-next-line no-console
  console.warn(rawOpenSearchOptInHint('EvaluationRun list({ testCaseId }) filter'));
}

describeIfOptedIn('EvaluationRun list({ testCaseId }) filter (real OpenSearch)', () => {
  let client: Client;
  let storage: OpenSearchStorageModule;
  let testData: RawOpenSearchTestData;
  let available = false;
  const matchingRunId = uniqueTestName('eval-run-filter-match');
  const otherRunId = uniqueTestName('eval-run-filter-other');
  const targetTestCaseId = uniqueTestName('tc-filter-target');
  const otherTestCaseId = uniqueTestName('tc-filter-other');

  beforeAll(async () => {
    client = createRawOpenSearchClient(ENDPOINT!);
    available = await rawClusterReachable(client);
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping testCaseId filter tests`);
      return;
    }

    // Real production bootstrap path: idempotently ensure the evals_* indices
    // exist with the actual INDEX_MAPPINGS. Never deletes/truncates anything.
    await ensureIndexesWithValidation(client);
    storage = new OpenSearchStorageModule(client, new FileSessionMetadataOperations());
    testData = new RawOpenSearchTestData(client);

    testData.trackDoc(INDEX, matchingRunId);
    await storage.evaluationRuns.create({
      id: matchingRunId,
      docType: 'evaluation-run',
      name: uniqueTestName('filter-target-run'),
      createdAt: new Date().toISOString(),
      status: 'completed',
      agentKey: 'demo',
      modelId: 'test-model',
      sources: [{ type: 'test-case-ids', ids: [targetTestCaseId] }],
      trigger: 'api',
      testCaseSnapshots: [{ id: targetTestCaseId, version: 1, name: 'Target test case' }],
      results: {},
    } as EvaluationRun);

    testData.trackDoc(INDEX, otherRunId);
    await storage.evaluationRuns.create({
      id: otherRunId,
      docType: 'evaluation-run',
      name: uniqueTestName('filter-non-matching-run'),
      createdAt: new Date().toISOString(),
      status: 'completed',
      agentKey: 'demo',
      modelId: 'test-model',
      sources: [{ type: 'test-case-ids', ids: [otherTestCaseId] }],
      trigger: 'api',
      testCaseSnapshots: [{ id: otherTestCaseId, version: 1, name: 'Other test case' }],
      results: {},
    } as EvaluationRun);

    await client.indices.refresh({ index: INDEX });
  }, 30000);

  afterAll(async () => {
    // Runs even when assertions fail: delete both synthetic eval-run docs
    // from the shared index (404-tolerant) and refresh so the deletions are
    // immediately visible to whatever runs next.
    if (available && testData) {
      await testData.cleanup();
    }
    if (client) {
      await client.close().catch(() => {});
    }
  });

  it('does not throw a query_shard_exception (nested-vs-object mapping mismatch)', async () => {
    if (!available) return;
    await expect(storage.evaluationRuns.list({ testCaseId: targetTestCaseId })).resolves.toBeDefined();
  }, 30000);

  it('returns only runs whose testCaseSnapshots contain the requested testCaseId', async () => {
    if (!available) return;

    const { items } = await storage.evaluationRuns.list({ testCaseId: targetTestCaseId });
    const ids = items.map((r) => r.id);
    expect(ids).toContain(matchingRunId);
    expect(ids).not.toContain(otherRunId);
  }, 30000);
});
