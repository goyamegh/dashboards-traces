/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Safety regression tests for scripts/sweep-test-data.mjs.
 *
 * Encodes the trap found by auditing the removed `--orphans` mode against the
 * real shared cluster (2026-08-29): report docs from the classic benchmark
 * `/execute` era carry `experimentRunId: run-<ts>-<rand>` ids that only ever
 * existed EMBEDDED inside the parent benchmark's `runs[]` array — never as
 * standalone evaluation-run documents. "GET /evaluation-runs/<id> → 404" is
 * therefore a guaranteed-false orphan signal for every old real run, and even
 * a benchmark-anchored rule still selected hundreds of reports of genuine
 * historical work whose parents were merely deleted later.
 *
 * The sweeper must therefore NEVER delete a report doc based on parent
 * absence: a report with a dangling `run-<ts>-<rand>` reference and no
 * resolvable parent must survive every supported invocation, and the removed
 * `--orphans` flag must be refused loudly (non-zero exit, nothing scanned,
 * nothing deleted) rather than silently running some other sweep.
 *
 * These tests run the real script as a child process against an in-process
 * mock backend (127.0.0.1, ephemeral port) — no real cluster is involved.
 */

import { execFile } from 'child_process';
import { createServer, Server } from 'http';
import { join } from 'path';

const SCRIPT = join(__dirname, '../../../scripts/sweep-test-data.mjs');

/**
 * The trap fixture: a REAL historical report (not test-created) whose parent
 * benchmark was deleted and whose `experimentRunId` uses the classic embedded
 * `run-<ts>-<rand>` format that never exists as a standalone eval-run doc.
 */
const CLASSIC_ERA_REPORT = {
  id: 'report-1700000000000-realwork',
  experimentId: 'bench-1690000000000-deleted',
  experimentRunId: 'run-1699999999999-abc1234',
  timestamp: '2023-11-14T22:13:20.000Z', // years old — no age gate can save it
  createdAt: '2023-11-14T22:13:20.000Z',
};

interface MockBackend {
  server: Server;
  url: string;
  deletes: string[];
  requests: string[];
}

function startMockBackend(): Promise<MockBackend> {
  const deletes: string[] = [];
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    requests.push(`${req.method} ${path}`);
    if (req.method === 'DELETE') {
      deletes.push(path);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (path === '/api/storage/runs') {
      // One classic-era report, parents dangling by construction (benchmark
      // list below is empty, evaluation-run list below is empty).
      res.end(JSON.stringify({ runs: [CLASSIC_ERA_REPORT], total: 1 }));
    } else if (path === '/api/storage/evaluation-runs') {
      res.end(JSON.stringify({ evaluationRuns: [], total: 0 }));
    } else if (path === '/api/storage/test-cases') {
      res.end(JSON.stringify({ testCases: [], total: 0, hasMore: false }));
    } else if (path === '/api/storage/benchmarks') {
      res.end(JSON.stringify({ benchmarks: [], total: 0 }));
    } else if (path === '/api/storage/evaluators') {
      res.end(JSON.stringify({ evaluators: [], total: 0 }));
    } else {
      res.end(JSON.stringify({}));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, deletes, requests });
    });
  });
}

function runSweeper(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((error as unknown as { code: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

describe('sweep-test-data.mjs safety regressions', () => {
  let backend: MockBackend;

  beforeAll(async () => {
    backend = await startMockBackend();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => backend.server.close(() => resolve()));
  });

  beforeEach(() => {
    backend.deletes.length = 0;
    backend.requests.length = 0;
  });

  it('never deletes a report whose classic run-<ts>-<rand> parent reference does not resolve (--apply)', async () => {
    const result = await runSweeper(['--url', backend.url, '--apply']);
    expect(result.code).toBe(0);
    // The report survived: not one DELETE was issued for anything, and the
    // run kind is reported as un-scannable rather than silently skipped.
    expect(backend.deletes).toEqual([]);
    expect(result.stdout).toContain('cannot match by name');
    expect(result.stdout).toContain('deleted 0');
  });

  it('never deletes it under --legacy --apply either (broadest supported sweep)', async () => {
    const result = await runSweeper(['--url', backend.url, '--legacy', '--apply']);
    expect(result.code).toBe(0);
    expect(backend.deletes).toEqual([]);
  });

  it('refuses the removed --orphans flag: non-zero exit, explains why, deletes nothing', async () => {
    const result = await runSweeper(['--url', backend.url, '--orphans', '--apply']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--orphans was removed');
    expect(result.stderr).toContain('not a reliable junk signal');
    expect(result.stderr).toContain('Nothing was scanned or deleted');
    // Refusal happens before any network traffic: the backend saw nothing.
    expect(backend.requests).toEqual([]);
    expect(backend.deletes).toEqual([]);
  });

  it('refuses unknown flags instead of silently running a different sweep', async () => {
    const result = await runSweeper(['--url', backend.url, '--orphan']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('unknown flag: --orphan');
    expect(backend.requests).toEqual([]);
    expect(backend.deletes).toEqual([]);
  });

  it('still deletes genuinely harness-stamped ahtest-* entities (the safe path keeps working)', async () => {
    // Swap in a backend where a test-created benchmark exists alongside the
    // classic-era report; only the ahtest-* benchmark may die.
    const deletes: string[] = [];
    const server = createServer((req, res) => {
      const path = (req.url || '').split('?')[0];
      if (req.method === 'DELETE') {
        deletes.push(path);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: true }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (path === '/api/storage/runs') {
        res.end(JSON.stringify({ runs: [CLASSIC_ERA_REPORT], total: 1 }));
      } else if (path === '/api/storage/benchmarks') {
        res.end(
          JSON.stringify({
            benchmarks: [
              { id: 'bench-ahtest-1', name: 'ahtest-sweeper-check-1-2-3' },
              { id: 'bench-real-1', name: 'Pulsar-regression-tests' },
            ],
            total: 2,
          })
        );
      } else if (path === '/api/storage/evaluation-runs') {
        res.end(JSON.stringify({ evaluationRuns: [], total: 0 }));
      } else if (path === '/api/storage/test-cases') {
        res.end(JSON.stringify({ testCases: [], total: 0, hasMore: false }));
      } else if (path === '/api/storage/evaluators') {
        res.end(JSON.stringify({ evaluators: [], total: 0 }));
      } else {
        res.end(JSON.stringify({}));
      }
    });
    const url = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    try {
      const result = await runSweeper(['--url', url, '--apply']);
      expect(result.code).toBe(0);
      expect(deletes).toEqual(['/api/storage/benchmarks/bench-ahtest-1']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
