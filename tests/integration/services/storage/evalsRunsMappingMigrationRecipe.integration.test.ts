/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: the migration recipe for an ALREADY-POISONED `evals_runs`
 * index (real OpenSearch, no mocks).
 *
 * `ensureIndexes()`'s best-effort `putMapping` (server/services/indexInitializer.ts)
 * cannot retroactively set `dynamic: false` on an object field that already
 * has real, dynamically-inferred sub-properties — OpenSearch rejects it with
 * `mapper_exception: the [dynamic] parameter can't be updated`. That's the
 * documented, accepted trade-off (mirrors #418's `EvaluationRun.results` fix,
 * see its indexMappings.ts comment): fresh/unpoisoned indexes are protected
 * immediately on next boot; an already-poisoned index (e.g. the shared
 * cluster, if `evals_runs.metrics`/`matcherResults.judgeMetrics` already
 * accumulated dynamic sub-fields before this fix shipped) needs an explicit
 * reindex to actually shed the poisoned sub-fields.
 *
 * The reindex mechanism itself is NOT new — `reindexSingleIndex()`
 * (server/services/mappingFixer.ts), exposed at `POST /api/storage/reindex`
 * (server/routes/storage/admin.ts), already recreates an index from
 * `INDEX_MAPPINGS` (delete temp-if-stale → create temp with correct mapping →
 * reindex old→temp → delete original → recreate original with correct
 * mapping → reindex temp→original → delete temp), with doc-count validation
 * and a recovery message if the copy-back fails. This test proves that
 * EXISTING mechanism, unmodified, is a sufficient migration recipe for THIS
 * fix when pointed at a poisoned `evals_runs` index — no new reindex code
 * needed, just documentation of when/how to invoke it (see
 * docs/STORAGE_INDEX_FIELD_LIMITS.md).
 *
 * Never run automatically, never touches a shared/production index — this
 * test creates its own throwaway index under `evals_runs_test_poison_<tag>`
 * and points `reindexSingleIndex` at it via a mapping-lookup override, so it
 * never assumes it owns (and never deletes) the real `evals_runs` index used
 * by other integration tests in this file's directory.
 *
 * Skips gracefully if no cluster is reachable (see TEST_OPENSEARCH_ENDPOINT).
 */

import { Client } from '@opensearch-project/opensearch';
import { reindexSingleIndex } from '@/server/services/mappingFixer';
import { INDEX_MAPPINGS } from '@/server/constants/indexMappings';
import { STORAGE_INDEXES } from '@/server/middleware/dataSourceConfig';

const ENDPOINT = process.env.TEST_OPENSEARCH_ENDPOINT || 'http://localhost:9200';
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// A throwaway index name, NOT the real `evals_runs` — registered into a
// process-local copy of INDEX_MAPPINGS below so reindexSingleIndex() can
// look up its target mapping the same way it would for the real index.
const POISONED_INDEX = `evals_runs_test_poison_${RUN_TAG}`;

async function clusterUp(client: Client): Promise<boolean> {
  try {
    await client.cluster.health({ wait_for_status: 'yellow', timeout: '5s' });
    return true;
  } catch {
    return false;
  }
}

describe('Migration recipe: reindexSingleIndex() heals an already-poisoned evals_runs-shaped index', () => {
  let client: Client;
  let available = false;

  beforeAll(async () => {
    client = new Client({ node: ENDPOINT, ssl: { rejectUnauthorized: false } });
    available = await clusterUp(client);
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping migration-recipe test`);
      return;
    }

    // Register the throwaway index under the real runs mapping so
    // reindexSingleIndex() (which looks up INDEX_MAPPINGS[indexName]) finds
    // the fixed (dynamic:false) mapping for it, exactly as it would for the
    // real `evals_runs` index.
    (INDEX_MAPPINGS as Record<string, unknown>)[POISONED_INDEX] = INDEX_MAPPINGS[STORAGE_INDEXES.runs];

    // Simulate the shared cluster's pre-fix state: create the index with the
    // OLD (dynamically-mappable) shape for `metrics`/`judgeMetrics` — no
    // `dynamic: false` — then write a document that exercises a custom
    // metric name, which OpenSearch dynamically maps as a real sub-field.
    // This is exactly what the shared cluster's `evals_runs` looks like today
    // if any code-QA benchmark run emitted a custom evaluator metric before
    // this fix shipped.
    await client.indices.create({
      index: POISONED_INDEX,
      body: {
        mappings: {
          properties: {
            id: { type: 'keyword' },
            testCaseId: { type: 'keyword' },
            metrics: {
              properties: { accuracy: { type: 'float' } }, // no dynamic:false — poisonable
            },
          },
        },
      },
    });
    await client.index({
      index: POISONED_INDEX,
      id: 'poisoned-doc',
      body: {
        id: 'poisoned-doc',
        testCaseId: `tc-${RUN_TAG}`,
        metrics: { accuracy: 0.5, custom_evaluator_dimension_x: 0.9 },
      },
      refresh: 'wait_for',
    });
  }, 30000);

  afterAll(async () => {
    if (available) {
      await client.indices.delete({ index: POISONED_INDEX }).catch(() => {});
      delete (INDEX_MAPPINGS as Record<string, unknown>)[POISONED_INDEX];
      await client.close().catch(() => {});
    }
  });

  it('confirms the pre-fix state is actually poisoned (sanity check)', async () => {
    if (!available) return;
    const mapping = await client.indices.getMapping({ index: POISONED_INDEX });
    const metricsMapping = (mapping.body as any)[POISONED_INDEX].mappings.properties.metrics;
    expect(metricsMapping.properties.custom_evaluator_dimension_x).toBeDefined();
    expect(metricsMapping.dynamic).toBeUndefined(); // not yet dynamic:false
  });

  it('reindexSingleIndex() resets the mapping to dynamic:false and preserves all document data', async () => {
    if (!available) return;

    const result = await reindexSingleIndex(client, POISONED_INDEX);
    expect(result.documentsReindexed).toBe(1);

    await client.indices.refresh({ index: POISONED_INDEX });

    // The mapping is now the fixed shape: dynamic:false, only the legacy
    // four metric names mapped — the poisoned `custom_evaluator_dimension_x`
    // sub-field is gone from the MAPPING (never remapped on the fresh
    // index/reindex-back), even though...
    const afterMapping = await client.indices.getMapping({ index: POISONED_INDEX });
    const metricsMapping = (afterMapping.body as any)[POISONED_INDEX].mappings.properties.metrics;
    expect(String(metricsMapping.dynamic)).toBe('false');
    expect(metricsMapping.properties.custom_evaluator_dimension_x).toBeUndefined();
    expect(metricsMapping.properties.accuracy).toEqual({ type: 'float' });

    // ...the DATA is fully preserved in `_source` — no data loss, exactly
    // the trade-off `enabled:false`/`dynamic:false` documents (opaque to the
    // mapping, not to the application).
    const doc = await client.get({ index: POISONED_INDEX, id: 'poisoned-doc' });
    expect((doc.body._source as any).metrics).toEqual({
      accuracy: 0.5,
      custom_evaluator_dimension_x: 0.9,
    });
  }, 60000);
});
