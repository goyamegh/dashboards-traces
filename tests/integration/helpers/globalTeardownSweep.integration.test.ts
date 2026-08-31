/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the crash safety net (jest.globalTeardown.cjs).
 *
 * Scenario reproduced: a suite creates entities, then its worker dies before
 * `afterAll` can run (jest timeout, `--forceExit`, OOM, Ctrl-C). The ids survive
 * in `.agent-health/.test-ledger/*.jsonl`, and globalTeardown must delete them.
 *
 * Also asserted, because these are the ways a safety net turns destructive:
 *  - a ledger owned by a LIVE process (another in-flight jest/playwright run)
 *    is left alone — even when its mtime looks ancient, because mtime only
 *    advances on append and a quiet-but-alive run must not have its data
 *    deleted out from under it;
 *  - a ledger owned by a provably DEAD process is adopted immediately;
 *  - an UNREADABLE ledger file is never unlinked — it may be the only record
 *    of leaked ids, so a transient fs error must not destroy it;
 *  - a successful `cleanup()` removes its own ledger, so teardown is a no-op
 *    (and therefore costs nothing) in the common case.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createTestDataTracker, uniqueTestName, LEDGER_DIR, RECONCILE_KIND } from '../../helpers/testDataTracker';
import { getTestBackendUrl } from '../testConfig';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const globalTeardown = require('../../../jest.globalTeardown.cjs') as (() => Promise<void>) & {
  readLedgers: (now?: number) => {
    entities: unknown[];
    files: string[];
    skipped: number;
    ledgers: Array<{ file: string; entities: unknown[]; readOk: boolean }>;
    unreadable: string[];
  };
};

/** Spawn a short-lived child process and return its (now dead) pid. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  if (!child.pid) throw new Error('failed to spawn child for dead-pid fixture');
  return child.pid;
}

const BASE_URL = getTestBackendUrl();
let backendAvailable = false;

/** Defensive net for anything a failing assertion leaves behind. */
const safetyNet = createTestDataTracker(BASE_URL);

beforeAll(async () => {
  try {
    backendAvailable = (await fetch(`${BASE_URL}/health`)).ok;
  } catch {
    backendAvailable = false;
  }
});

beforeEach(() => {
  // If AH_TEST_SKIP_SWEEP leaks in from the ambient environment the sweep
  // short-circuits and these cases pass vacuously. AH_TEST_CLEANUP_STRICT (set
  // by CI) would make inline globalTeardown() calls throw on unrelated noise.
  delete process.env.AH_TEST_SKIP_SWEEP;
  delete process.env.AH_TEST_CLEANUP_STRICT;
  process.env.AH_TEST_RUN_ID = `itest-${process.pid}`;
});

afterAll(async () => {
  if (backendAvailable) await safetyNet.cleanup();
  delete process.env.AH_TEST_SKIP_SWEEP;
});

async function createBenchmarkNamed(name: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: 'safety-net probe' }),
  });
  if (!response.ok) throw new Error(`create benchmark -> HTTP ${response.status}`);
  const body = await response.json();
  return body.benchmark?.id ?? body.id;
}

async function benchmarkExists(id: string): Promise<boolean> {
  return (await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`)).ok;
}

describe('globalTeardown crash safety net (integration)', () => {
  it('reclaims an orphan whose suite never ran afterAll', async () => {
    if (!backendAvailable) return;

    // Simulate the crash: track (which writes the ledger) but never clean up.
    const tracker = createTestDataTracker(BASE_URL);
    const orphanId = await createBenchmarkNamed(uniqueTestName('orphan-bench'));
    tracker.benchmark(orphanId);
    safetyNet.benchmark(orphanId); // belt & braces if the sweep fails

    expect(await benchmarkExists(orphanId)).toBe(true);

    await globalTeardown();

    expect(await benchmarkExists(orphanId)).toBe(false);
  }, 60_000);

  it('is a cheap no-op once a suite has cleaned up after itself', async () => {
    if (!backendAvailable) return;

    const tracker = createTestDataTracker(BASE_URL);
    const id = await createBenchmarkNamed(uniqueTestName('clean-bench'));
    tracker.benchmark(id);
    const ledger = tracker.ledgerFile as string;
    expect(fs.existsSync(ledger)).toBe(true);

    await tracker.cleanup();

    // A successful cleanup removes its own ledger, so teardown has nothing to do.
    expect(fs.existsSync(ledger)).toBe(false);

    const started = Date.now();
    await globalTeardown();
    // No listing, no HTTP: must be effectively instant. The name-matching sweep
    // this replaced took ~60s per run against the shared cluster.
    expect(Date.now() - started).toBeLessThan(2000);
  }, 60_000);

  it("skips a different run's ledger while its owning process is alive", async () => {
    if (!backendAvailable) return;

    const foreignId = await createBenchmarkNamed(uniqueTestName('foreign-bench'));
    safetyNet.benchmark(foreignId);

    // Hand-write a ledger tagged with someone else's run id. The writer-pid
    // suffix is OUR live pid, so liveness detection must leave it alone.
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const foreignLedger = path.join(LEDGER_DIR, `run-someone-else--${process.pid}-${Date.now()}-1.jsonl`);
    fs.writeFileSync(foreignLedger, `${JSON.stringify({ kind: 'benchmark', id: foreignId })}\n`);

    try {
      const seenBefore = globalTeardown.readLedgers();
      expect(seenBefore.files).not.toContain(foreignLedger);
      expect(seenBefore.skipped).toBeGreaterThan(0);

      await globalTeardown();

      // Untouched: still in storage, ledger still on disk for its owner to drain.
      expect(await benchmarkExists(foreignId)).toBe(true);
      expect(fs.existsSync(foreignLedger)).toBe(true);
    } finally {
      fs.rmSync(foreignLedger, { force: true });
    }
  }, 60_000);

  it('never adopts a live run just because its ledger LOOKS old (mtime is not liveness)', async () => {
    if (!backendAvailable) return;

    const liveId = await createBenchmarkNamed(uniqueTestName('live-bench'));
    safetyNet.benchmark(liveId);

    // Owning run id encodes OUR pid (alive). Backdate the file well past any
    // staleness threshold: a run that tracked its entities early and then went
    // quiet for hours looks exactly like this — and must NOT be adopted.
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const liveLedger = path.join(
      LEDGER_DIR,
      `run-${process.pid}-${Date.now() - 10 * 60 * 60 * 1000}--${process.pid}-${Date.now()}-2.jsonl`
    );
    fs.writeFileSync(liveLedger, `${JSON.stringify({ kind: 'benchmark', id: liveId })}\n`);
    const old = Date.now() - 10 * 60 * 60 * 1000;
    fs.utimesSync(liveLedger, old / 1000, old / 1000);

    try {
      expect(globalTeardown.readLedgers().files).not.toContain(liveLedger);

      await globalTeardown();

      expect(await benchmarkExists(liveId)).toBe(true);
      expect(fs.existsSync(liveLedger)).toBe(true);
    } finally {
      fs.rmSync(liveLedger, { force: true });
    }
  }, 60_000);

  it("adopts another run's ledger once its owning process is dead — even when fresh", async () => {
    if (!backendAvailable) return;

    const staleId = await createBenchmarkNamed(uniqueTestName('stale-bench'));
    safetyNet.benchmark(staleId);

    // Owning run id encodes a pid that provably exited. No backdating: a dead
    // owner can never drain its own ledger, so adoption should be immediate
    // rather than waiting hours for an mtime threshold.
    const gonePid = deadPid();
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const staleLedger = path.join(LEDGER_DIR, `run-${gonePid}-${Date.now()}--${gonePid}-${Date.now()}-2.jsonl`);
    fs.writeFileSync(staleLedger, `${JSON.stringify({ kind: 'benchmark', id: staleId })}\n`);

    expect(globalTeardown.readLedgers().files).toContain(staleLedger);

    await globalTeardown();

    expect(await benchmarkExists(staleId)).toBe(false);
    expect(fs.existsSync(staleLedger)).toBe(false);
  }, 60_000);

  it('falls back to a conservative mtime rule when no pid can be parsed', async () => {
    if (!backendAvailable) return;

    const mtimeId = await createBenchmarkNamed(uniqueTestName('mtime-bench'));
    safetyNet.benchmark(mtimeId);

    // Neither the run-id segment nor the filename suffix is pid-shaped.
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const oddLedger = path.join(LEDGER_DIR, `run-mystery-run--handwritten.jsonl`);
    fs.writeFileSync(oddLedger, `${JSON.stringify({ kind: 'benchmark', id: mtimeId })}\n`);

    try {
      // Fresh: skipped.
      expect(globalTeardown.readLedgers().files).not.toContain(oddLedger);

      // Backdate past the raised (6h) fallback threshold: adopted.
      const old = Date.now() - 7 * 60 * 60 * 1000;
      fs.utimesSync(oddLedger, old / 1000, old / 1000);
      expect(globalTeardown.readLedgers().files).toContain(oddLedger);

      await globalTeardown();

      expect(await benchmarkExists(mtimeId)).toBe(false);
      expect(fs.existsSync(oddLedger)).toBe(false);
    } finally {
      fs.rmSync(oddLedger, { force: true });
    }
  }, 60_000);

  it('keeps an unreadable ledger (never destroys the only record of leaked ids)', async () => {
    if (!backendAvailable) return;

    // A directory with a .jsonl name makes readFileSync fail deterministically
    // (EISDIR) for every user, simulating a transient read error on an adopted
    // ledger. It must survive teardown untouched.
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const unreadable = path.join(
      LEDGER_DIR,
      `run-${process.env.AH_TEST_RUN_ID}--${process.pid}-${Date.now()}-9.jsonl`
    );
    fs.mkdirSync(unreadable);

    // A healthy sibling ledger must still be drained + unlinked — the bad file
    // must not block per-file cleanup of the rest.
    const drainedId = await createBenchmarkNamed(uniqueTestName('drained-bench'));
    safetyNet.benchmark(drainedId);
    const healthy = path.join(
      LEDGER_DIR,
      `run-${process.env.AH_TEST_RUN_ID}--${process.pid}-${Date.now()}-10.jsonl`
    );
    fs.writeFileSync(healthy, `${JSON.stringify({ kind: 'benchmark', id: drainedId })}\n`);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const seen = globalTeardown.readLedgers();
      expect(seen.unreadable).toContain(unreadable);

      await globalTeardown();

      expect(fs.existsSync(unreadable)).toBe(true); // kept for the next run
      expect(fs.existsSync(healthy)).toBe(false); // drained + removed
      expect(await benchmarkExists(drainedId)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could NOT read'));
    } finally {
      warn.mockRestore();
      fs.rmdirSync(unreadable);
    }
  }, 60_000);

  it('ignores a torn final line from a mid-append kill', async () => {
    if (!backendAvailable) return;

    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const tornLedger = path.join(
      LEDGER_DIR,
      `run-${process.env.AH_TEST_RUN_ID}--${process.pid}-${Date.now()}-3.jsonl`
    );
    const goodId = await createBenchmarkNamed(uniqueTestName('torn-bench'));
    safetyNet.benchmark(goodId);
    fs.writeFileSync(
      tornLedger,
      `${JSON.stringify({ kind: 'benchmark', id: goodId })}\n{"kind":"benchmark","id":"tr`
    );

    await globalTeardown();

    // The valid line was honoured; the torn line did not throw.
    expect(await benchmarkExists(goodId)).toBe(false);
  }, 60_000);

  it('honours AH_TEST_SKIP_SWEEP', async () => {
    if (!backendAvailable) return;

    const tracker = createTestDataTracker(BASE_URL);
    const keptId = await createBenchmarkNamed(uniqueTestName('skip-sweep-bench'));
    tracker.benchmark(keptId);
    safetyNet.benchmark(keptId);

    process.env.AH_TEST_SKIP_SWEEP = '1';
    await globalTeardown();

    expect(await benchmarkExists(keptId)).toBe(true);
    expect(fs.existsSync(tracker.ledgerFile as string)).toBe(true);

    // Drain for real, so this spec leaves neither storage rows nor ledger files.
    delete process.env.AH_TEST_SKIP_SWEEP;
    await globalTeardown();
    expect(fs.existsSync(tracker.ledgerFile as string)).toBe(false);
  }, 60_000);

  // ── End-of-run late-report reconciliation (RECONCILE_KIND markers) ───────

  it('deletes a late-written report referenced by a RECONCILE_KIND marker', async () => {
    if (!backendAvailable) return;

    // The scenario: a suite created + deleted a test case; a background
    // evaluation persisted a report doc referencing it AFTER that suite's
    // cleanup (and settle-poll) finished. The rewritten ledger carries a
    // reconcile marker for the test-case id; teardown must find and delete
    // the report by id-scoped search.
    const lateTcId = uniqueTestName('late-tc');
    const createResponse = await fetch(`${BASE_URL}/api/storage/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCaseId: lateTcId,
        testCaseName: uniqueTestName('late-report'),
        status: 'completed',
        timestamp: new Date().toISOString(),
        trajectory: [],
      }),
    });
    expect(createResponse.ok).toBe(true);
    const reportId: string = (await createResponse.json()).id;
    safetyNet.run(reportId);

    // Wait until the doc is SEARCHABLE (OpenSearch index refresh is ~1s) so
    // the assertion tests teardown's deletion, not the backend's refresh lag.
    let visible = false;
    for (let attempt = 0; attempt < 30 && !visible; attempt++) {
      const search = await fetch(`${BASE_URL}/api/storage/runs/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseId: lateTcId, size: 10 }),
      });
      const body = await search.json();
      visible = (body.runs ?? []).some((r: { id?: string }) => r.id === reportId);
      if (!visible) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(visible).toBe(true);

    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const markerLedger = path.join(
      LEDGER_DIR,
      `run-${process.env.AH_TEST_RUN_ID}--${process.pid}-${Date.now()}-20.jsonl`
    );
    fs.writeFileSync(markerLedger, `${JSON.stringify({ kind: RECONCILE_KIND, id: lateTcId })}\n`);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await globalTeardown();

      expect(
        (await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(reportId)}`)).status
      ).toBe(404);
      expect(fs.existsSync(markerLedger)).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('late-written report doc')
      );
    } finally {
      warn.mockRestore();
      fs.rmSync(markerLedger, { force: true });
    }
  }, 90_000);

  it('unlinks a marker ledger whose test case attracted no late reports', async () => {
    if (!backendAvailable) return;

    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const markerLedger = path.join(
      LEDGER_DIR,
      `run-${process.env.AH_TEST_RUN_ID}--${process.pid}-${Date.now()}-21.jsonl`
    );
    // A test-case id that never existed: the search finds nothing, twice.
    fs.writeFileSync(
      markerLedger,
      `${JSON.stringify({ kind: RECONCILE_KIND, id: uniqueTestName('never-existed-tc') })}\n`
    );

    try {
      await globalTeardown();
      expect(fs.existsSync(markerLedger)).toBe(false);
    } finally {
      fs.rmSync(markerLedger, { force: true });
    }
  }, 60_000);
});
