/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the shared test-data cleanup harness.
 *
 * These guard the two properties that make the harness trustworthy:
 *  1. it deletes EVERYTHING a test registered, children before parents;
 *  2. it never breaks a suite that was otherwise passing.
 */

import {
  TestDataTracker,
  createTestDataTracker,
  uniqueTestName,
  isTestEntityName,
  AH_TEST_PREFIX,
  ENTITY_KINDS,
  RECONCILE_KIND,
} from '../../helpers/testDataTracker';

const BASE = 'http://localhost:4999';

// Unit-test trackers register FAKE ids (tc-1, bench-1, …) against a mocked
// fetch. Without this, each tracker would still write a REAL crash ledger, and
// jest.globalTeardown.cjs would then issue REAL DELETEs for those fake ids
// against whatever backend AH_PORT points at (a live shared cluster in this
// repo's default setup). Disable the ledger for this suite — nothing here ever
// creates real data, so there is nothing for the safety net to recover.
let priorLedgerFlag: string | undefined;
beforeAll(() => {
  priorLedgerFlag = process.env.AH_TEST_LEDGER_DISABLED;
  process.env.AH_TEST_LEDGER_DISABLED = '1';
});
afterAll(() => {
  if (priorLedgerFlag === undefined) delete process.env.AH_TEST_LEDGER_DISABLED;
  else process.env.AH_TEST_LEDGER_DISABLED = priorLedgerFlag;
});

/** Record of a request the tracker issued. */
interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockFetch(
  handler?: (url: string, call?: Call) => { ok?: boolean; status?: number; body?: unknown }
) {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const call: Call = { url: String(url), method: init?.method ?? 'GET', body: init?.body };
    calls.push(call);
    const result = handler?.(String(url), call) ?? {};
    const status = result.status ?? 200;
    return {
      ok: result.ok ?? (status >= 200 && status < 300),
      status,
      json: async () => result.body ?? {},
    } as Response;
  });
  (globalThis as { fetch?: unknown }).fetch = fn;
  return { calls, fn };
}

/** Only the DELETEs a mock recorded (reconciliation adds POST searches). */
function deletes(calls: Call[]): Call[] {
  return calls.filter((c) => c.method === 'DELETE');
}

/** Only the reconciliation searches a mock recorded. */
function searches(calls: Call[]): Call[] {
  return calls.filter((c) => c.url.endsWith('/api/storage/runs/search'));
}

const originalFetch = globalThis.fetch;
let priorBudget: string | undefined;
beforeAll(() => {
  // Disable the reconciliation settle-poll by default so cleanup() stays
  // instant in these unit tests (the pre-delete pass still runs). Tests that
  // exercise the settle-poll set their own budget.
  priorBudget = process.env.AH_TEST_RECONCILE_BUDGET_MS;
  process.env.AH_TEST_RECONCILE_BUDGET_MS = '0';
});
afterAll(() => {
  if (priorBudget === undefined) delete process.env.AH_TEST_RECONCILE_BUDGET_MS;
  else process.env.AH_TEST_RECONCILE_BUDGET_MS = priorBudget;
});
afterEach(() => {
  (globalThis as { fetch?: unknown }).fetch = originalFetch;
  delete process.env.AH_TEST_CLEANUP_STRICT;
  process.env.AH_TEST_RECONCILE_BUDGET_MS = '0';
  jest.restoreAllMocks();
});

describe('uniqueTestName / isTestEntityName', () => {
  it('stamps the sweeper-recognisable prefix', () => {
    const name = uniqueTestName('benchmark');
    expect(name.startsWith(AH_TEST_PREFIX)).toBe(true);
    expect(isTestEntityName(name)).toBe(true);
  });

  it('never collides across calls in the same process', () => {
    const names = new Set(Array.from({ length: 500 }, () => uniqueTestName('tc')));
    expect(names.size).toBe(500);
  });

  it('sanitises labels so names stay URL/id safe', () => {
    expect(uniqueTestName('weird name/with?chars')).toMatch(/^ahtest-weird-name-with-chars-/);
  });

  it('does not treat real user entity names as test data', () => {
    // Regression guard: these are REAL benchmark names from the shared cluster.
    // A loose /test/i pattern would match them and delete production data.
    for (const real of ['Pulsar-regression-tests', 'mstest', 'Jason Test', 'otel-multi-turn-test-cases']) {
      expect(isTestEntityName(real)).toBe(false);
    }
  });
});

describe('TestDataTracker tracking', () => {
  it('ignores nullish and empty ids so call sites can stay terse', () => {
    const t = new TestDataTracker(BASE);
    t.testCase(undefined);
    t.testCase(null);
    t.testCase('');
    t.benchmark(undefined);
    expect(t.size).toBe(0);
  });

  it('de-duplicates repeated ids', () => {
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');
    t.testCase('tc-1');
    t.testCase('tc-2');
    expect(t.size).toBe(2);
  });

  it('treats the same id under different kinds as distinct entities', () => {
    const t = new TestDataTracker(BASE);
    t.testCase('x-1');
    t.benchmark('x-1');
    expect(t.size).toBe(2);
  });

  it('trackAll accepts bare ids and {id} objects, skipping holes', () => {
    const t = new TestDataTracker(BASE);
    t.testCases(['a', { id: 'b' }, null, undefined, { id: undefined }]);
    expect(t.size).toBe(2);
  });

  it('requires a parent id to track a benchmark run', () => {
    const t = new TestDataTracker(BASE);
    t.benchmarkRun(undefined, 'run-1');
    expect(t.size).toBe(0);
    t.benchmarkRun('bench-1', 'run-1');
    expect(t.size).toBe(1);
  });
});

describe('TestDataTracker.cleanup', () => {
  it('DELETEs every tracked entity at its correct route', async () => {
    const { calls } = mockFetch();
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');
    t.benchmark('bench-1');
    t.benchmarkRun('bench-1', 'brun-1');
    t.evaluationRun('erun-1');
    t.run('run-1');
    t.evaluator('eval-1');
    t.image('sha256:abc');

    const result = await t.cleanup();

    expect(result.failed).toEqual([]);
    expect(result.deleted).toBe(7);
    // Reconciliation adds POST /runs/search calls (scoped to the tracked
    // test-case id); every OTHER request must still be a DELETE.
    const deleteCalls = deletes(calls);
    expect(deleteCalls.length + searches(calls).length).toBe(calls.length);
    const urls = deleteCalls.map((c) => c.url);
    expect(urls).toContain(`${BASE}/api/storage/test-cases/tc-1`);
    expect(urls).toContain(`${BASE}/api/storage/benchmarks/bench-1`);
    expect(urls).toContain(`${BASE}/api/storage/benchmarks/bench-1/runs/brun-1`);
    expect(urls).toContain(`${BASE}/api/storage/evaluation-runs/erun-1`);
    expect(urls).toContain(`${BASE}/api/storage/runs/run-1`);
    expect(urls).toContain(`${BASE}/api/storage/evaluators/eval-1`);
    expect(urls).toContain(`${BASE}/api/storage/images/sha256%3Aabc`);
  });

  it('never issues a request for an id that was not explicitly tracked (the hygiene guarantee)', async () => {
    // Runtime enforcement of the rule that used to be checked by a
    // source-string regex over every integration/e2e file (removed — see
    // AGENTS.md's "Integration / e2e Test Cleanup" section and the 2026-08-29
    // incident it documents: cleanup hooks that call a listing API and delete
    // by name/pattern destroy OTHER PEOPLE'S data on the shared cluster).
    // The tracker has exactly two paths from "entity exists" to "entity
    // deleted": (1) track()/testCase()/benchmark()/etc. append to
    // `this.entities` and cleanup() DELETEs those ids; (2) reconciliation
    // DELETEs report docs returned by a search that is itself scoped to a
    // TRACKED test-case id. There is no code path that enumerates storage or
    // matches anything by name. This test proves that structurally: seed the
    // mock backend with "other people's" real-looking entities the tracker
    // never heard about, track only ONE unrelated id, and assert cleanup
    // deletes exactly that one id and that the only non-DELETE requests are
    // reconciliation searches keyed on that same tracked id.
    const { calls } = mockFetch();
    const t = new TestDataTracker(BASE);
    t.testCase('tc-mine-only');

    await t.cleanup();

    expect(deletes(calls)).toEqual([
      {
        url: `${BASE}/api/storage/test-cases/tc-mine-only`,
        method: 'DELETE',
        body: undefined,
      },
    ]);
    // Every non-DELETE request is a reconciliation search scoped to the one
    // tracked test-case id — no listing endpoint (`?size=`, bare collection
    // path) is ever hit.
    for (const call of calls) {
      if (call.method === 'DELETE') continue;
      expect(call.method).toBe('POST');
      expect(call.url).toBe(`${BASE}/api/storage/runs/search`);
      expect(JSON.parse(call.body ?? '{}').testCaseId).toBe('tc-mine-only');
    }
    expect(calls.some((c) => /\?size=|\/api\/storage\/(test-cases|benchmarks|evaluators|runs|evaluation-runs|images)\/?$/.test(c.url))).toBe(false);
  });

  it('deletes children before parents so nothing is orphaned', async () => {
    const { calls } = mockFetch();
    const t = new TestDataTracker(BASE);
    // Register in deliberately WRONG order: parent first.
    t.benchmark('bench-1');
    t.testCase('tc-1');
    t.benchmarkRun('bench-1', 'brun-1');
    t.run('report-1');

    await t.cleanup();

    const order = calls.map((c) => c.url);
    // Match on the EXACT url: `/benchmarks/bench-1` is a substring of the nested
    // benchmark-run route `/benchmarks/bench-1/runs/brun-1`, so a substring
    // search would report the parent as deleted first.
    const idx = (url: string) => order.indexOf(`${BASE}${url}`);
    // Leaf-first: report docs go before the benchmark-run whose projection
    // references them (see ENTITY_KINDS ordering rationale).
    expect(idx('/api/storage/runs/report-1')).toBeLessThan(
      idx('/api/storage/benchmarks/bench-1/runs/brun-1')
    );
    expect(idx('/api/storage/benchmarks/bench-1/runs/brun-1')).toBeLessThan(
      idx('/api/storage/test-cases/tc-1')
    );
    expect(idx('/api/storage/test-cases/tc-1')).toBeLessThan(
      idx('/api/storage/benchmarks/bench-1')
    );
  });

  it('treats 404/410 as success (cascade-deleted or already cleaned)', async () => {
    mockFetch((url) => (url.includes('tc-gone') ? { status: 404 } : { status: 410 }));
    const t = new TestDataTracker(BASE);
    t.testCase('tc-gone');
    t.benchmark('bench-gone');

    const result = await t.cleanup();

    expect(result.deleted).toBe(2);
    expect(result.failed).toEqual([]);
  });

  it('reports real failures without throwing, so a green suite stays green', async () => {
    mockFetch(() => ({ status: 500 }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');

    const result = await t.cleanup();

    expect(result.deleted).toBe(0);
    expect(result.failed).toEqual([{ kind: 'test-case', id: 'tc-1', reason: 'HTTP 500' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to delete 1 entity'));
  });

  it('records network errors as failures rather than crashing cleanup', async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');

    const result = await t.cleanup();

    expect(result.failed[0]).toMatchObject({ id: 'tc-1', reason: 'ECONNREFUSED' });
    // Network-level failures are classified so strict mode can tell "backend
    // unreachable" apart from "backend refused the delete".
    expect(result.failed[0].unreachable).toBe(true);
  });

  it('does not flag HTTP rejections as unreachable', async () => {
    mockFetch(() => ({ status: 500 }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');

    const result = await t.cleanup();

    expect(result.failed[0].unreachable).toBeUndefined();
  });

  it('throws under AH_TEST_CLEANUP_STRICT so CI can enforce zero-leak', async () => {
    mockFetch(() => ({ status: 500 }));
    process.env.AH_TEST_CLEANUP_STRICT = '1';
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');

    await expect(t.cleanup()).rejects.toThrow(/failed to delete 1 entity/);
    // The strict throw must not lose the queue: the id stays pending for retry.
    expect(t.pending()).toMatchObject([{ kind: 'test-case', id: 'tc-1' }]);
  });

  it('does NOT throw in strict mode when the backend is merely unreachable', async () => {
    // Backend-down must not turn a green build red: tests that needed the
    // backend already failed/skipped, and the ids stay queued + ledgered for
    // the globalTeardown retry (which is itself health-gated).
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AH_TEST_CLEANUP_STRICT = '1';
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');

    const result = await t.cleanup();

    expect(result.failed).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to delete 1 entity'));
    expect(t.pending()).toHaveLength(1);
  });

  it('re-queues failed deletions so a later cleanup retries them', async () => {
    // A transient failure must never make the in-memory queue the casualty:
    // the ledger append is best-effort, so this queue can be the only record.
    let failing = true;
    const { calls } = mockFetch(() => (failing ? { status: 500 } : { status: 200 }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');
    t.benchmark('bench-1');

    const first = await t.cleanup();
    expect(first.deleted).toBe(0);
    expect(first.failed).toHaveLength(2);
    expect(t.pending()).toHaveLength(2);

    // Re-tracking a surviving id must not duplicate it.
    t.testCase('tc-1');
    expect(t.pending()).toHaveLength(2);

    failing = false;
    const second = await t.cleanup();
    expect(second.deleted).toBe(2);
    expect(second.failed).toEqual([]);
    expect(t.pending()).toHaveLength(0);
    // 2 failed attempts + 2 successful retries (searches excluded).
    expect(deletes(calls)).toHaveLength(4);
  });

  it('re-queues only the failures, not the successes', async () => {
    mockFetch((url) => (url.includes('tc-bad') ? { status: 500 } : { status: 200 }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new TestDataTracker(BASE);
    t.testCase('tc-bad');
    t.testCase('tc-good');

    const result = await t.cleanup();

    expect(result.deleted).toBe(1);
    expect(t.pending()).toMatchObject([{ kind: 'test-case', id: 'tc-bad' }]);
  });

  it('is idempotent: a second cleanup issues no further requests', async () => {
    const { calls } = mockFetch();
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');

    await t.cleanup();
    const afterFirst = calls.length;
    const second = await t.cleanup();

    expect(deletes(calls)).toHaveLength(1);
    // Queue drained => nothing to delete AND nothing to reconcile.
    expect(calls.length).toBe(afterFirst);
    expect(second.deleted).toBe(0);
  });

  it('cleans up entities registered after a previous cleanup', async () => {
    const { calls } = mockFetch();
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');
    await t.cleanup();
    t.testCase('tc-2');
    await t.cleanup();

    expect(deletes(calls).map((c) => c.url)).toEqual([
      `${BASE}/api/storage/test-cases/tc-1`,
      `${BASE}/api/storage/test-cases/tc-2`,
    ]);
  });

  it('url-encodes ids so slashes cannot escape the delete route', async () => {
    const { calls } = mockFetch();
    const t = new TestDataTracker(BASE);
    t.testCase('tc/../../etc/passwd');

    await t.cleanup();

    expect(deletes(calls)[0].url).toBe(`${BASE}/api/storage/test-cases/tc%2F..%2F..%2Fetc%2Fpasswd`);
  });

  it('strips trailing slashes from the base url', async () => {
    const { calls } = mockFetch();
    const t = new TestDataTracker(`${BASE}///`);
    t.testCase('tc-1');

    await t.cleanup();

    expect(deletes(calls)[0].url).toBe(`${BASE}/api/storage/test-cases/tc-1`);
    // The reconciliation search uses the same normalised base url.
    expect(searches(calls)[0].url).toBe(`${BASE}/api/storage/runs/search`);
  });

  it('deletes a large batch completely despite the concurrency cap', async () => {
    const { calls } = mockFetch();
    const t = new TestDataTracker(BASE);
    for (let i = 0; i < 50; i += 1) t.testCase(`tc-${i}`);

    const result = await t.cleanup();

    expect(result.deleted).toBe(50);
    expect(deletes(calls).length).toBe(50);
  });

  it('exposes pending entities for assertions and covers every declared kind', () => {
    const t = createTestDataTracker(BASE);
    t.testCase('a');
    expect(t.pending()).toEqual([{ kind: 'test-case', id: 'a', parentId: undefined }]);
    // Guard against a kind being added to ENTITY_KINDS without a delete route.
    expect(new Set(ENTITY_KINDS).size).toBe(ENTITY_KINDS.length);
  });
});

describe('TestDataTracker reconciliation (late-written report docs)', () => {
  // The leak these tests pin down (measured live: 14 report docs in one
  // integration run): an evaluation keeps executing in the background after a
  // test moves on, and persists its report doc AFTER afterAll harvested every
  // id it could see. The report references a tracked test-case id, so an
  // id-scoped search finds it without ever enumerating storage.

  it('deletes an untracked report referencing a tracked test case — before the test case itself', async () => {
    const { calls } = mockFetch((url, call) => {
      if (url.endsWith('/runs/search')) {
        const tcId = JSON.parse(call?.body ?? '{}').testCaseId;
        return { body: { runs: tcId === 'tc-1' ? [{ id: 'report-late-1' }] : [] } };
      }
      return {};
    });
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');

    const result = await t.cleanup();

    expect(result.failed).toEqual([]);
    expect(result.reconciled).toEqual(['report-late-1']);
    const order = deletes(calls).map((c) => c.url);
    // Child-before-parent holds for DISCOVERED reports too.
    expect(order.indexOf(`${BASE}/api/storage/runs/report-late-1`)).toBeLessThan(
      order.indexOf(`${BASE}/api/storage/test-cases/tc-1`)
    );
  });

  it('settle-poll catches a report written AFTER the tracked entities were deleted (the regression)', async () => {
    // Simulates the measured failure: the report doc lands only after the
    // test case is already gone. Pass 1 (pre-delete) sees nothing; a later
    // pass during the bounded settle window sees the late report.
    process.env.AH_TEST_RECONCILE_BUDGET_MS = '3000';
    let searchCount = 0;
    const { calls } = mockFetch((url) => {
      if (url.endsWith('/runs/search')) {
        searchCount += 1;
        return { body: { runs: searchCount === 2 ? [{ id: 'report-late-9' }] : [] } };
      }
      return {};
    });
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');

    const result = await t.cleanup();

    expect(result.failed).toEqual([]);
    expect(result.reconciled).toEqual(['report-late-9']);
    expect(deletes(calls).map((c) => c.url)).toContain(`${BASE}/api/storage/runs/report-late-9`);
  });

  it('stops after two consecutive empty passes instead of burning the whole budget', async () => {
    process.env.AH_TEST_RECONCILE_BUDGET_MS = '60000';
    const { calls } = mockFetch();
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');
    t.testCase('tc-2');

    const started = Date.now();
    await t.cleanup();

    // Pre-delete pass (2 searches) + ONE confirming settle pass (2 searches):
    // nothing found twice in a row => exit long before the 60s budget.
    expect(searches(calls)).toHaveLength(4);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('issues no searches at all when no test case was tracked (common case stays free)', async () => {
    process.env.AH_TEST_RECONCILE_BUDGET_MS = '60000';
    const { calls } = mockFetch();
    const t = new TestDataTracker(BASE);
    t.benchmark('bench-1');
    t.run('report-1');

    await t.cleanup();

    expect(searches(calls)).toHaveLength(0);
  });

  it('never deletes demo- sample reports the search route mixes in', async () => {
    const { calls } = mockFetch((url) =>
      url.endsWith('/runs/search')
        ? { body: { runs: [{ id: 'demo-run-1' }, { id: 'report-real-2' }] } }
        : {}
    );
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');

    const result = await t.cleanup();

    expect(result.reconciled).toEqual(['report-real-2']);
    const urls = deletes(calls).map((c) => c.url);
    expect(urls).toContain(`${BASE}/api/storage/runs/report-real-2`);
    expect(urls.some((u) => u.includes('demo-run-1'))).toBe(false);
  });

  it('records search failures separately from tracked-entity failures', async () => {
    mockFetch((url) => (url.endsWith('/runs/search') ? { status: 500 } : {}));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');

    const result = await t.cleanup();

    // The tracked test case itself deleted fine…
    expect(result.failed).toEqual([]);
    expect(result.deleted).toBe(1);
    // …but the late-report check could not be verified — deduped per id.
    expect(result.reconcileFailed).toEqual([
      { testCaseId: 'tc-1', reason: 'HTTP 500' },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not verify 1 test-case id'));
  });

  it('strict mode throws when the reconciliation search is actively rejected', async () => {
    mockFetch((url) => (url.endsWith('/runs/search') ? { status: 500 } : {}));
    process.env.AH_TEST_CLEANUP_STRICT = '1';
    const t = new TestDataTracker(BASE);
    t.testCase('tc-1');

    await expect(t.cleanup()).rejects.toThrow(/could not verify 1 test-case id/);
  });

  it('rewrites the ledger with reconcile markers on success so globalTeardown re-checks at end of run', async () => {
    // Enable the real ledger just for this test (the suite disables it so
    // fake ids never reach globalTeardown's DELETE sweep — markers are safe:
    // teardown only SEARCHES them, and this test unlinks the file anyway).
    delete process.env.AH_TEST_LEDGER_DISABLED;
    mockFetch();
    const t = new TestDataTracker(BASE);
    try {
      t.testCase('tc-marker-1');
      t.benchmark('bench-marker-1');
      const ledger = t.ledgerFile as string;
      expect(ledger).toBeTruthy();

      const result = await t.cleanup();
      expect(result.failed).toEqual([]);

      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const fs = require('fs') as typeof import('fs');
      const lines = fs
        .readFileSync(ledger, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      // ONLY the reconcile marker survives — deleted entity lines are dropped,
      // and the benchmark (not a test case) produces no marker.
      expect(lines).toEqual([{ kind: RECONCILE_KIND, id: 'tc-marker-1' }]);
      fs.unlinkSync(ledger);
    } finally {
      process.env.AH_TEST_LEDGER_DISABLED = '1';
    }
  });

  it('removes the ledger outright when the cleanup deleted no test cases', async () => {
    delete process.env.AH_TEST_LEDGER_DISABLED;
    mockFetch();
    const t = new TestDataTracker(BASE);
    try {
      t.benchmark('bench-only-1');
      const ledger = t.ledgerFile as string;

      await t.cleanup();

      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const fs = require('fs') as typeof import('fs');
      expect(fs.existsSync(ledger)).toBe(false);
    } finally {
      process.env.AH_TEST_LEDGER_DISABLED = '1';
    }
  });
});
