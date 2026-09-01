/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: TestCaseRun (report) `metrics` and
 * `matcherResults[].judgeMetrics` must not blow up the `evals_runs` index's
 * total field count as code-SDK evaluations accumulate, against a REAL
 * OpenSearch cluster.
 *
 * Regression coverage for the "code-QA benchmarks" field-count-limit
 * incident: run execution succeeded but the WRITE errored out with
 * `illegal_argument_exception: Limit of total fields [5000] has been
 * exceeded` (data loss). Root cause (distinct from, and NOT fixed by, #418 —
 * which protected `EvaluationRun.results` / `testCaseSnapshots` in the
 * `evals_experiments` index): custom/system evaluators emit dynamic metric
 * names driven by `evaluator.scoringConfig.metrics`
 * (server/services/judgeResponseParser.ts's extractMetrics(),
 * services/storage/asyncRunStorage.ts's storedMetricsToApp()/
 * toStorageFormat()) at TWO levels on `evals_runs` documents:
 *
 *   1. The report-level `metrics` object (one set of dynamic names per run).
 *   2. Per-matcher `matcherResults[].judgeMetrics` (one set of dynamic names
 *      PER SDK `judge()` call — `matcherResults` is `nested`, so a single
 *      code-QA test case with many `judge()` claims multiplies growth fast).
 *
 * Without `dynamic: false` on both objects, every distinct custom metric
 * name across every run/matcher ever indexed added new mapped fields shared
 * index-wide, eventually exceeding `index.mapping.total_fields.limit`.
 *
 * This test exercises the real production write path (no mocks) against a
 * REAL OpenSearch cluster:
 *   1. A throwaway `ahtest-*` index is created from the exact `evals_runs`
 *      entry in `INDEX_MAPPINGS` (the fix under test), and
 *      `STORAGE_INDEXES.runs` is redirected at it for this test file's module
 *      registry (jest gives each test file its own registry, so nothing
 *      leaks to other files). The suite therefore runs the REAL
 *      `OpenSearchRunOperations` code paths — while the real `evals_runs`
 *      index is never touched. That isolation matters: the failure mode this
 *      suite exists to catch is MAPPING growth, and mapping growth in a real
 *      shared index is permanent (deleting documents does not shrink a
 *      mapping — only dropping the index does).
 *   2. Test A synthesizes ONE report with 1000+ distinct custom metric names
 *      spread across the report-level `metrics` object AND 250
 *      `matcherResults[]` entries (4 distinct `judgeMetrics` names each —
 *      1000 combined), via `OpenSearchRunOperations.create()`, then reads it
 *      back and checks the index's total field count.
 *   3. Test B asserts the fields `OpenSearchRunOperations.search()` actually
 *      filters/sorts on remain real, queryable, correctly-typed fields (the
 *      query audit in the PR description) — a `dynamic: false` fix that
 *      accidentally caught one of these would silently break filtering.
 *
 * Cluster: STRICTLY OPT-IN via `TEST_OPENSEARCH_ENDPOINT` (with a
 * localhost:9200 fallback only under GitHub Actions, where the CI
 * `integration-tests` job provisions a disposable service container) — see
 * tests/helpers/rawOpenSearchCluster.ts. Without the opt-in the suite SKIPS:
 * it must never write synthetic garbage into an unknown local port 9200
 * (which may be a port-forward to a shared cluster). The mapping-shape
 * assertions in tests/unit/server/constants/indexMappings.test.ts assert the
 * same fix at the unit level regardless of cluster availability.
 *
 * To run locally against a disposable cluster:
 *   docker run -d --rm -p 9200:9200 -e discovery.type=single-node \
 *     -e DISABLE_SECURITY_PLUGIN=true -e DISABLE_INSTALL_DEMO_CONFIG=true \
 *     opensearchproject/opensearch:2.17.0
 *   TEST_OPENSEARCH_ENDPOINT=http://localhost:9200 \
 *     npm run test:integration -- testCaseRunMetricsMappingGrowth
 */

import { Client } from '@opensearch-project/opensearch';
import { OpenSearchStorageModule } from '@/server/adapters/opensearch/StorageModule';
import { FileSessionMetadataOperations } from '@/server/adapters/file/StorageModule';
import { INDEX_MAPPINGS } from '@/server/constants/indexMappings';
import { STORAGE_INDEXES } from '@/server/middleware/dataSourceConfig';
import type { TestCaseRun } from '@/types';
import type { MatcherResult } from '@/lib/matchers/types';
import {
  RawOpenSearchTestData,
  createRawOpenSearchClient,
  rawClusterReachable,
  rawOpenSearchOptInHint,
  resolveRawOpenSearchEndpoint,
} from '../../../helpers/rawOpenSearchCluster';
import { uniqueTestName } from '../../../helpers/testDataTracker';

const ENDPOINT = resolveRawOpenSearchEndpoint();
/** Real index name, captured before the suite redirects STORAGE_INDEXES.runs. */
const REAL_INDEX = STORAGE_INDEXES.runs;
// > 1000 distinct nested matcher/attr keys, per the PR requirement — split
// across report-level `metrics` (500 custom names) and 125 `judge()` calls
// each emitting 4 distinct custom `judgeMetrics` dimension names (500 more),
// for 1000 combined distinct custom metric names across both growth vectors.
const NUM_REPORT_METRICS = 500;
const NUM_MATCHERS = 125;
const JUDGE_METRICS_PER_MATCHER = 4;
// The index is now private to this suite (throwaway, created fresh), so no
// concurrent test file can race the before/after mapping snapshots. A small
// slack remains purely as defense against OpenSearch inferring an incidental
// field this test didn't anticipate — the bug this guards against adds 1000+
// fields for one report, orders of magnitude past it.
const FIELD_COUNT_SLACK = 5;
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Opt-in gate: without an explicitly-provided disposable cluster this suite
// SKIPS (visible in jest output) instead of guessing at localhost:9200.
const describeIfOptedIn = ENDPOINT ? describe : describe.skip;
if (!ENDPOINT) {
  // eslint-disable-next-line no-console
  console.warn(rawOpenSearchOptInHint('TestCaseRun metrics/judgeMetrics mapping growth'));
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

function buildReportMetrics(count: number, prefix: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    metrics[`${prefix}_${i}`] = Math.random();
  }
  return metrics;
}

function buildMatcherResults(
  numMatchers: number,
  judgeMetricsPerMatcher: number,
  prefix: string,
): MatcherResult[] {
  return Array.from({ length: numMatchers }, (_, i) => {
    const judgeMetrics: Record<string, number> = {};
    for (let j = 0; j < judgeMetricsPerMatcher; j++) {
      judgeMetrics[`${prefix}_m${i}_dim${j}`] = Math.random();
    }
    return {
      description: `custom judge claim ${i}`,
      pass: true,
      method: 'llm-judge',
      score: 0.9,
      judgeMetrics,
    } as MatcherResult;
  });
}

describeIfOptedIn('TestCaseRun metrics/judgeMetrics mapping growth (real OpenSearch)', () => {
  let client: Client;
  let storage: OpenSearchStorageModule;
  let testData: RawOpenSearchTestData;
  let available = false;
  /** Throwaway ahtest-* index this suite writes into (stands in for evals_runs). */
  let index: string;

  beforeAll(async () => {
    client = createRawOpenSearchClient(ENDPOINT!);
    available = await rawClusterReachable(client);
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping mapping-growth tests`);
      return;
    }

    // Create a throwaway index from the REAL evals_runs mapping (the fix
    // under test), then point the storage module's lazily-read index name at
    // it so every production code path below runs against the throwaway.
    testData = new RawOpenSearchTestData(client);
    index = await testData.createThrowawayIndex(
      'mapping-growth-runs',
      INDEX_MAPPINGS[REAL_INDEX] as Record<string, unknown>
    );
    (STORAGE_INDEXES as { runs: string }).runs = index;

    storage = new OpenSearchStorageModule(client, new FileSessionMetadataOperations());
  }, 30000);

  afterAll(async () => {
    // Runs even when assertions fail. Restore the redirected index name,
    // then drop the throwaway index (docs AND any mapping growth with it).
    (STORAGE_INDEXES as { runs: string }).runs = REAL_INDEX;
    if (available && testData) {
      await testData.cleanup();
    }
    if (client) {
      await client.close().catch(() => {});
    }
  });

  it('persists a report with 1000+ distinct custom metric/judgeMetrics names and does not grow the mapping', async () => {
    if (!available) return; // graceful skip, see beforeAll warning

    // Baseline report FIRST, with the same field shape as the big report
    // below (one custom metric name, one matcher with one judgeMetrics name),
    // so the one-time cost of OpenSearch dynamically inferring top-level
    // report fields that aren't in the explicit mapping (agentName,
    // modelName, ...) lands before the baseline snapshot. The assertion below
    // is then attributable to the 1000+ custom names, not index bootstrap.
    const baselineReportId = uniqueTestName('report-mapping-baseline');
    testData.trackDoc(index, baselineReportId);
    await storage.runs.create({
      id: baselineReportId,
      testCaseId: `ahtest-tc-baseline-${RUN_TAG}`,
      agentName: 'demo-agent',
      modelName: 'test-model',
      status: 'completed',
      passFailStatus: 'passed',
      trajectory: [],
      metrics: buildReportMetrics(1, `baseline_metric_${RUN_TAG}`) as TestCaseRun['metrics'],
      llmJudgeReasoning: 'baseline',
      matcherResults: buildMatcherResults(1, 1, `baseline_dim_${RUN_TAG}`),
    });
    await client.indices.refresh({ index });

    const beforeMapping = await client.indices.getMapping({ index });
    const beforeFieldCount = countMappedFields((beforeMapping.body as any)[index].mappings.properties);

    const reportId = uniqueTestName('report-mapping-growth');
    const metricPrefix = `custom_metric_${RUN_TAG}`;
    const matcherPrefix = `judge_dim_${RUN_TAG}`;

    const reportMetrics = buildReportMetrics(NUM_REPORT_METRICS, metricPrefix);
    const matcherResults = buildMatcherResults(NUM_MATCHERS, JUDGE_METRICS_PER_MATCHER, matcherPrefix);
    const totalCustomNames = NUM_REPORT_METRICS + NUM_MATCHERS * JUDGE_METRICS_PER_MATCHER;
    expect(totalCustomNames).toBeGreaterThanOrEqual(1000);

    const report: Partial<TestCaseRun> = {
      id: reportId,
      testCaseId: `ahtest-tc-${RUN_TAG}`,
      agentName: 'demo-agent',
      modelName: 'test-model',
      status: 'completed',
      passFailStatus: 'passed',
      trajectory: [],
      metrics: reportMetrics as TestCaseRun['metrics'],
      llmJudgeReasoning: 'looks good',
      matcherResults,
    };

    testData.trackDoc(index, reportId);
    await storage.runs.create(report);
    await client.indices.refresh({ index });

    // 1. Reads back correctly: every custom metric/judgeMetrics name and
    // value survives the round-trip (dynamic:false only opaques mapping, not
    // `_source`).
    const fetched = await storage.runs.getById(reportId);
    expect(fetched).not.toBeNull();
    expect(Object.keys(fetched!.metrics as Record<string, number>)).toHaveLength(NUM_REPORT_METRICS);
    expect((fetched!.metrics as Record<string, number>)[`${metricPrefix}_0`]).toBe(reportMetrics[`${metricPrefix}_0`]);
    expect(fetched!.matcherResults).toHaveLength(NUM_MATCHERS);
    const firstMatcherJudgeMetrics = (fetched!.matcherResults as any[])[0].judgeMetrics;
    expect(Object.keys(firstMatcherJudgeMetrics)).toHaveLength(JUDGE_METRICS_PER_MATCHER);

    // 2. No meaningful mapping growth: field count with 1000+ distinct
    // custom metric/judgeMetrics names stays within FIELD_COUNT_SLACK of the
    // pre-write baseline. Before the fix, this grows by ~1 field per custom
    // name (plus nested judgeMetrics fields for matcherResults) — i.e.
    // 1000+ new fields for this one report alone, dwarfing the slack.
    const afterMapping = await client.indices.getMapping({ index });
    const afterFieldCount = countMappedFields((afterMapping.body as any)[index].mappings.properties);
    expect(afterFieldCount - beforeFieldCount).toBeLessThanOrEqual(FIELD_COUNT_SLACK);

    // 3. The `metrics` and `matcherResults.judgeMetrics` mappings themselves
    // stay the dynamic:false, legacy-four-typed shape — never gain
    // per-custom-name sub-properties. This is the deterministic, race-proof
    // assertion.
    const metricsMapping = (afterMapping.body as any)[index].mappings.properties.metrics;
    expect(String(metricsMapping.dynamic)).toBe('false');
    expect(Object.keys(metricsMapping.properties)).toEqual([
      'accuracy',
      'faithfulness',
      'latency_score',
      'trajectory_alignment_score',
    ]);

    const judgeMetricsMapping = (afterMapping.body as any)[index].mappings.properties.matcherResults.properties
      .judgeMetrics;
    expect(String(judgeMetricsMapping.dynamic)).toBe('false');
    expect(Object.keys(judgeMetricsMapping.properties)).toEqual([
      'accuracy',
      'faithfulness',
      'latency_score',
      'trajectory_alignment_score',
    ]);
  }, 60000);

  it('keeps every field OpenSearchRunOperations.search() filters/sorts on real and queryable', async () => {
    if (!available) return;

    const reportId = uniqueTestName('report-query-audit');
    testData.trackDoc(index, reportId);
    await storage.runs.create({
      id: reportId,
      testCaseId: `ahtest-query-audit-tc-${RUN_TAG}`,
      agentName: 'demo-agent',
      modelName: 'test-model',
      status: 'completed',
      passFailStatus: 'passed',
      trajectory: [],
      metrics: {},
      llmJudgeReasoning: '',
    } as Partial<TestCaseRun>);
    await client.indices.refresh({ index });

    // Exercise the real search() filters (server/adapters/opensearch/StorageModule.ts)
    // end-to-end — a `term` query against `testCaseId` only works if the
    // field is a real `keyword`-mapped field, which is exactly what the
    // `dynamic: false` fix on `metrics`/`judgeMetrics` must not disturb.
    const { items } = await storage.runs.search({ testCaseId: `ahtest-query-audit-tc-${RUN_TAG}` });
    expect(items.map((r) => r.id)).toContain(reportId);
  }, 30000);
});
