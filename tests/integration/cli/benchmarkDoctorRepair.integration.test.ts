/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for `agent-health benchmark doctor [--apply]` — detects
 * (and repairs) benchmarks whose linked run-first EvaluationRun documents
 * reference test case ids missing from `benchmark.testCaseIds` (see
 * cli/utils/benchmarkDoctor.ts for the pure planner and cli/commands/
 * benchmark.ts:createBenchmarkDoctorCommand for the CLI wiring).
 *
 * Seeds a shell benchmark + run-first run directly via the storage API
 * (bypassing the now-fixed CLI write path so this test still exercises the
 * *backfill* path even after fix #4 stops new shells from forming), then
 * spawns the real CLI subprocess: dry-run must report without writing,
 * --apply must write and be idempotent on a second pass.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 60_000;
const BASE_URL = getTestBackendUrl();
const REPO_ROOT = process.cwd();
const CLI_BUNDLE = join(REPO_ROOT, 'cli/dist/index.js');

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await r.json();
    return data.status === 'ok' || data.status === 'connected';
  } catch {
    return false;
  }
};

function cleanEnv(port: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'AWS_REGION' || k.startsWith('AWS_') || k === 'TMPDIR') {
      env[k] = v;
    }
  }
  env.AH_PORT = port;
  env.AH_SUPPRESS_EXPERIMENTAL = '1';
  env.AH_QUIET_DEPRECATIONS = '1';
  return env;
}

describe('CLI benchmark doctor: repairs shell benchmarks missing run-first test case links', () => {
  let backendAvailable = false;
  const createdTestCaseIds: string[] = [];
  const createdBenchmarkIds: string[] = [];
  const createdRunIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) return;
    if (!existsSync(CLI_BUNDLE)) {
      const build = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (build.status !== 0) throw new Error(`CLI build failed: ${build.stderr}`);
    }
  });

  afterAll(async () => {
    if (!backendAvailable) return;
    for (const id of createdRunIds) {
      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of createdBenchmarkIds) {
      await fetch(`${BASE_URL}/api/storage/benchmarks/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of createdTestCaseIds) {
      await fetch(`${BASE_URL}/api/storage/test-cases/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  it('reports the stale link in dry-run (no write), then fixes it with --apply, and is idempotent', async () => {
    if (!backendAvailable) {
      // eslint-disable-next-line no-console
      console.warn(`[benchmark-doctor] Backend not reachable at ${BASE_URL} — skipping.`);
      return;
    }

    // --- Seed: a test case, a shell benchmark, and a run-first run that
    // references the benchmark but was never linked (mirrors
    // bench-1787626453329-ofvke6py4 pre-fix). ---
    const tcRes = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Doctor Repair Test Case',
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'Doctor repair test prompt',
        context: [],
        expectedTrajectory: [],
        labels: ['@integration-test', '@traces-cost-attrs'],
      }),
    });
    const testCase = await tcRes.json();
    createdTestCaseIds.push(testCase.id);

    const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `doctor-repair-shell-${Date.now()}`, testCaseIds: [] }),
    });
    const benchmark = await bmRes.json();
    createdBenchmarkIds.push(benchmark.id);

    const runId = `eval-run-doctor-test-${Date.now()}`;
    const runPatchRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: runId,
        name: 'Doctor Repair Seed Run',
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCase.id] }],
        trigger: 'api',
        testCaseSnapshots: [{ id: testCase.id, version: 1, name: testCase.name }],
        results: {},
        benchmarkId: benchmark.id,
        createdAt: new Date().toISOString(),
      }),
    });
    expect(runPatchRes.ok).toBe(true);
    createdRunIds.push(runId);

    // Sanity: the seeded benchmark is a genuine shell.
    const beforeBm = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmark.id}`)).json();
    expect(beforeBm.testCaseIds).toEqual([]);

    const port = new URL(BASE_URL).port || '4001';

    // --- Dry-run: must report the stale link but NOT write anything. ---
    const dryRun = spawnSync('node', [CLI_BUNDLE, 'benchmark', 'doctor'], {
      cwd: REPO_ROOT, env: cleanEnv(port), encoding: 'utf-8', timeout: TEST_TIMEOUT - 10_000,
    });
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain(benchmark.id);
    expect(dryRun.stdout.toLowerCase()).toContain('--apply');

    const afterDryRun = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmark.id}`)).json();
    expect(afterDryRun.testCaseIds).toEqual([]); // unchanged — dry-run wrote nothing

    // --- --apply: must fix it. ---
    const apply = spawnSync('node', [CLI_BUNDLE, 'benchmark', 'doctor', '--apply'], {
      cwd: REPO_ROOT, env: cleanEnv(port), encoding: 'utf-8', timeout: TEST_TIMEOUT - 10_000,
    });
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain(benchmark.id);

    const afterApply = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmark.id}`)).json();
    expect(afterApply.testCaseIds).toContain(testCase.id);
    expect(afterApply.currentVersion).toBeGreaterThan(beforeBm.currentVersion);

    // --- Second --apply pass must be a no-op (already healthy). ---
    const applyAgain = spawnSync('node', [CLI_BUNDLE, 'benchmark', 'doctor', '--apply'], {
      cwd: REPO_ROOT, env: cleanEnv(port), encoding: 'utf-8', timeout: TEST_TIMEOUT - 10_000,
    });
    expect(applyAgain.status).toBe(0);
    expect(applyAgain.stdout).not.toContain(benchmark.id);
    expect(applyAgain.stdout.toLowerCase()).toContain('healthy');

    const afterSecondApply = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmark.id}`)).json();
    expect(afterSecondApply.currentVersion).toBe(afterApply.currentVersion); // no spurious re-bump
  }, TEST_TIMEOUT);
});
