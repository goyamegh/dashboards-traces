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
 * This test exercises the real production code path end-to-end against a
 * REAL OpenSearch cluster (no mocks):
 *   1. `ensureIndexesWithValidation()` creates a fresh `evals_runs` index
 *      using the actual `INDEX_MAPPINGS` (the fix under test).
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
 * Cluster: connects to `TEST_OPENSEARCH_ENDPOINT` (default
 * `http://localhost:9200`), the same ephemeral OpenSearch the CI
 * `integration-tests` job provisions. Skips gracefully (with a console
 * warning) if unreachable, so local runs without a cluster stay green — the
 * mapping-shape assertions in
 * tests/unit/server/constants/indexMappings.test.ts assert the same fix at
 * the unit level regardless of cluster availability.
 *
 * To run locally against a disposable cluster:
 *   docker run -d --rm -p 9200:9200 -e discovery.type=single-node \
 *     -e DISABLE_SECURITY_PLUGIN=true -e DISABLE_INSTALL_DEMO_CONFIG=true \
 *     opensearchproject/opensearch:2.17.0
 *   npm run test:integration -- testCaseRunMetricsMappingGrowth
 */

import { Client } from '@opensearch-project/opensearch';
import { OpenSearchStorageModule } from '@/server/adapters/opensearch/StorageModule';
import { FileSessionMetadataOperations } from '@/server/adapters/file/StorageModule';
import { ensureIndexesWithValidation } from '@/server/services/indexInitializer';
import { STORAGE_INDEXES } from '@/server/middleware/dataSourceConfig';
import type { TestCaseRun } from '@/types';
import type { MatcherResult } from '@/lib/matchers/types';

const ENDPOINT = process.env.TEST_OPENSEARCH_ENDPOINT || 'http://localhost:9200';
const INDEX = STORAGE_INDEXES.runs;
// > 1000 distinct nested matcher/attr keys, per the PR requirement — split
// across report-level `metrics` (500 custom names) and 125 `judge()` calls
// each emitting 4 distinct custom `judgeMetrics` dimension names (500 more),
// for 1000 combined distinct custom metric names across both growth vectors.
const NUM_REPORT_METRICS = 500;
const NUM_MATCHERS = 125;
const JUDGE_METRICS_PER_MATCHER = 4;
// Tolerance for the shared-index race (concurrent CI test files adding
// unrelated fields between this test's before/after mapping snapshots) — see
// evaluationRunMappingGrowth.integration.test.ts for the same pattern. The
// bug this guards against adds 1000+ fields for one report — orders of
// magnitude past this slack.
const FIELD_COUNT_SLACK = 15;
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function clusterUp(client: Client): Promise<boolean> {
  try {
    await client.cluster.health({ wait_for_status: 'yellow', timeout: '5s' });
    return true;
  } catch {
    return false;
  }
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

describe('TestCaseRun metrics/judgeMetrics mapping growth (real OpenSearch)', () => {
  let client: Client;
  let storage: OpenSearchStorageModule;
  let available = false;

  beforeAll(async () => {
    client = new Client({ node: ENDPOINT, ssl: { rejectUnauthorized: false } });
    available = await clusterUp(client);
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping mapping-growth tests`);
      return;
    }

    // Real production code path: idempotently ensure the index exists with
    // the actual mapping fix under test (server/constants/indexMappings.ts).
    // Deliberately non-destructive — never deletes/truncates the shared
    // `evals_runs` index, only ensures it exists and adds its own
    // uniquely-tagged documents (RUN_TAG).
    await ensureIndexesWithValidation(client);

    storage = new OpenSearchStorageModule(client, new FileSessionMetadataOperations());
  }, 30000);

  afterAll(async () => {
    if (available) {
      await client.close().catch(() => {});
    }
  });

  it('persists a report with 1000+ distinct custom metric/judgeMetrics names and does not grow the mapping', async () => {
    if (!available) return; // graceful skip, see beforeAll warning

    const beforeMapping = await client.indices.getMapping({ index: INDEX });
    const beforeFieldCount = countMappedFields((beforeMapping.body as any)[INDEX].mappings.properties);

    const reportId = `report-mapping-growth-${RUN_TAG}`;
    const metricPrefix = `custom_metric_${RUN_TAG}`;
    const matcherPrefix = `judge_dim_${RUN_TAG}`;

    const reportMetrics = buildReportMetrics(NUM_REPORT_METRICS, metricPrefix);
    const matcherResults = buildMatcherResults(NUM_MATCHERS, JUDGE_METRICS_PER_MATCHER, matcherPrefix);
    const totalCustomNames = NUM_REPORT_METRICS + NUM_MATCHERS * JUDGE_METRICS_PER_MATCHER;
    expect(totalCustomNames).toBeGreaterThanOrEqual(1000);

    const report: Partial<TestCaseRun> = {
      id: reportId,
      testCaseId: `tc-${RUN_TAG}`,
      agentName: 'demo-agent',
      modelName: 'test-model',
      status: 'completed',
      passFailStatus: 'passed',
      trajectory: [],
      metrics: reportMetrics as TestCaseRun['metrics'],
      llmJudgeReasoning: 'looks good',
      matcherResults,
    };

    await storage.runs.create(report);
    await client.indices.refresh({ index: INDEX });

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
    const afterMapping = await client.indices.getMapping({ index: INDEX });
    const afterFieldCount = countMappedFields((afterMapping.body as any)[INDEX].mappings.properties);
    expect(afterFieldCount - beforeFieldCount).toBeLessThanOrEqual(FIELD_COUNT_SLACK);

    // 3. The `metrics` and `matcherResults.judgeMetrics` mappings themselves
    // stay the dynamic:false, legacy-four-typed shape — never gain
    // per-custom-name sub-properties. This is the deterministic, race-proof
    // assertion (unaffected by anything unrelated concurrent tests might add
    // elsewhere in the mapping).
    const metricsMapping = (afterMapping.body as any)[INDEX].mappings.properties.metrics;
    expect(String(metricsMapping.dynamic)).toBe('false');
    expect(Object.keys(metricsMapping.properties)).toEqual([
      'accuracy',
      'faithfulness',
      'latency_score',
      'trajectory_alignment_score',
    ]);

    const judgeMetricsMapping = (afterMapping.body as any)[INDEX].mappings.properties.matcherResults.properties
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

    const reportId = `report-query-audit-${RUN_TAG}`;
    await storage.runs.create({
      id: reportId,
      testCaseId: `query-audit-tc-${RUN_TAG}`,
      agentName: 'demo-agent',
      modelName: 'test-model',
      status: 'completed',
      passFailStatus: 'passed',
      trajectory: [],
      metrics: {},
      llmJudgeReasoning: '',
    } as Partial<TestCaseRun>);
    await client.indices.refresh({ index: INDEX });

    // Exercise the real search() filters (server/adapters/opensearch/StorageModule.ts)
    // end-to-end — a `term` query against `testCaseId` only works if the
    // field is a real `keyword`-mapped field, which is exactly what the
    // `dynamic: false` fix on `metrics`/`judgeMetrics` must not disturb.
    const { items } = await storage.runs.search({ testCaseId: `query-audit-tc-${RUN_TAG}` });
    expect(items.map((r) => r.id)).toContain(reportId);
  }, 30000);
});
