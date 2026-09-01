/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Opt-in guard + cleanup harness for integration tests that talk to an
 * OpenSearch cluster with a RAW `@opensearch-project/opensearch` client,
 * bypassing the app server entirely.
 *
 * ## Why the endpoint is strictly opt-in
 *
 * The raw-client suites (the mapping-growth regression tests and friends)
 * synthesize large volumes of garbage documents — and, worse, thousands of
 * DISTINCT FIELD NAMES — to prove index-mapping behavior. They are designed
 * for a DISPOSABLE cluster, like the throwaway OpenSearch service container
 * the CI `integration-tests` job provisions.
 *
 * The old convention (`TEST_OPENSEARCH_ENDPOINT || 'http://localhost:9200'`)
 * silently fell back to whatever happens to listen on local port 9200. On a
 * developer box where 9200 is a real local cluster — or a port-forward to the
 * SHARED team cluster, a routine debugging move — a plain
 * `npm run test:integration` would quietly write synthetic junk into real
 * indices. Deleting the docs doesn't even undo the damage: dynamic mapping
 * growth is permanent until a full reindex.
 *
 * `resolveRawOpenSearchEndpoint()` therefore returns, in order:
 *   1. `TEST_OPENSEARCH_ENDPOINT` when set — the operator explicitly opted in
 *      and vouches that the target cluster is disposable;
 *   2. `http://localhost:9200` ONLY under GitHub Actions (`GITHUB_ACTIONS` is
 *      set by the runner itself, never by developer shells): the CI
 *      `integration-tests` job provisions a disposable OpenSearch service
 *      container on that port without setting `TEST_OPENSEARCH_ENDPOINT`
 *      (see .github/workflows/ci.yml). In jobs without a container (e.g.
 *      release-rehearsal) the endpoint is unreachable and suites skip
 *      gracefully, exactly as before;
 *   3. `null` otherwise — the suite must skip (`describe.skip`), never guess.
 *
 * ## Cleanup
 *
 * `RawOpenSearchTestData` mirrors `TestDataTracker`'s conventions for data
 * created without the app's DELETE routes: track everything the moment it is
 * created, clean up in `afterAll` (which runs even when assertions fail),
 * tolerate 404s (already gone), and never throw from cleanup. Throwaway
 * indices are created with the `ahtest-` prefix so any leftover from a
 * crashed worker is instantly recognizable (`_cat/indices/ahtest-*`).
 */

import { Client } from '@opensearch-project/opensearch';
import { uniqueTestName } from './testDataTracker';

/** Resolve the opt-in raw-cluster endpoint. `null` = the suite must skip. */
export function resolveRawOpenSearchEndpoint(): string | null {
  const explicit = process.env.TEST_OPENSEARCH_ENDPOINT?.trim();
  if (explicit) return explicit;
  // The GitHub Actions runner always sets GITHUB_ACTIONS=true; the CI
  // integration-tests job exposes its disposable service container on
  // localhost:9200. Never fall back to localhost:9200 anywhere else.
  if (process.env.GITHUB_ACTIONS === 'true') return 'http://localhost:9200';
  return null;
}

/**
 * One-line skip explanation for suites gated on `resolveRawOpenSearchEndpoint()`.
 * Printed at module scope so a skipped run says WHY it skipped.
 */
export function rawOpenSearchOptInHint(suiteLabel: string): string {
  return (
    `[skip] ${suiteLabel}: TEST_OPENSEARCH_ENDPOINT is not set. ` +
    `This suite writes synthetic test data with a raw OpenSearch client and must only ` +
    `run against a DISPOSABLE cluster you explicitly opt into, e.g.:\n` +
    `  docker run -d --rm -p 9200:9200 -e discovery.type=single-node \\\n` +
    `    -e DISABLE_SECURITY_PLUGIN=true -e DISABLE_INSTALL_DEMO_CONFIG=true \\\n` +
    `    opensearchproject/opensearch:2.17.0\n` +
    `  TEST_OPENSEARCH_ENDPOINT=http://localhost:9200 npm run test:integration -- <pattern>`
  );
}

/** Build a raw client the way the raw-cluster suites always have. */
export function createRawOpenSearchClient(endpoint: string): Client {
  return new Client({ node: endpoint, ssl: { rejectUnauthorized: false } });
}

/** True when the target cluster answers a basic health probe. */
export async function rawClusterReachable(client: Client): Promise<boolean> {
  try {
    await client.cluster.health({ wait_for_status: 'yellow', timeout: '5s' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tracks raw-client writes so `afterAll` can remove every trace of the suite:
 * individual documents (deleted + index refreshed) and throwaway indices
 * (dropped wholesale — the only way to also discard mapping growth).
 */
export class RawOpenSearchTestData {
  private readonly docs: Array<{ index: string; id: string }> = [];
  private readonly throwawayIndices: string[] = [];

  constructor(private readonly client: Client) {}

  /** Record one raw-indexed document for deletion in cleanup(). */
  trackDoc(index: string, id: string): void {
    this.docs.push({ index, id });
  }

  /**
   * Create a uniquely-named `ahtest-*` throwaway index (same body as a real
   * one, e.g. `INDEX_MAPPINGS[STORAGE_INDEXES.runs]`) and register it for
   * deletion in cleanup(). Dropping the whole index is the only cleanup that
   * also discards dynamic-mapping growth, which doc deletion can never undo.
   */
  async createThrowawayIndex(label: string, body: Record<string, unknown>): Promise<string> {
    // uniqueTestName() output (ahtest-<label>-<pid>-<ts>-<n>) is lowercase for
    // lowercase labels, which makes it a valid OpenSearch index name.
    const name = uniqueTestName(label);
    await this.client.indices.create({ index: name, body: body as any });
    this.throwawayIndices.push(name);
    return name;
  }

  /**
   * Delete everything this suite created. 404s are success (already gone);
   * anything else is warned about but never thrown — cleanup must not turn a
   * passing suite red, and it must run to completion for every entry.
   */
  async cleanup(): Promise<void> {
    const failures: string[] = [];

    const docs = this.docs.splice(0, this.docs.length);
    for (const { index, id } of docs) {
      try {
        await this.client.delete({ index, id });
      } catch (error: any) {
        if (error?.meta?.statusCode !== 404) {
          failures.push(`doc ${index}/${id} (${error?.message ?? error})`);
        }
      }
    }

    // Make the deletions visible to any subsequent reader of a surviving
    // index. Indices about to be dropped don't need a refresh.
    const surviving = new Set(
      docs.map((d) => d.index).filter((index) => !this.throwawayIndices.includes(index))
    );
    for (const index of surviving) {
      try {
        await this.client.indices.refresh({ index });
      } catch {
        /* best effort */
      }
    }

    const indices = this.throwawayIndices.splice(0, this.throwawayIndices.length);
    for (const index of indices) {
      try {
        await this.client.indices.delete({ index });
      } catch (error: any) {
        if (error?.meta?.statusCode !== 404) {
          failures.push(`index ${index} (${error?.message ?? error})`);
        }
      }
    }

    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[raw-cluster-cleanup] failed to delete ${failures.length} item(s) — ` +
          `grep the cluster for 'ahtest-' leftovers:\n  ${failures.join('\n  ')}`
      );
    }
  }
}
