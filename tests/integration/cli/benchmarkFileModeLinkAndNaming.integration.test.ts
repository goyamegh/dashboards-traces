/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: `agent-health benchmark -f <file.eval.js> -n "<name>"`
 * (unified/code-import mode) end-to-end, covering two of the dogfood fixes:
 *
 *   1. The benchmark created for `-n "<name>"` is no longer a permanent
 *      shell (`testCaseIds: []`) — the resolved test case ids get linked
 *      in at run-creation time (services/benchmarkPromotion.ts).
 *   2. The run itself is named from `-n`, not the generic, undiscoverable
 *      "CLI Run - <agent> - <ISO>" (cli/utils/runNaming.ts).
 *
 * Spawns the real CLI subprocess against the backend under test — no
 * mocking of the CLI process itself, following the pattern in
 * benchmarkCodeSdk.integration.test.ts. Cleans up every doc it creates.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

const FIXTURE_CONTENT = `
const { test, expect } = require('@opensearch-project/agent-health');

test('cli-naming-link-check', {
  description: 'no-prompt path, body-only assertion',
  labels: ['category:Smoke', 'difficulty:Easy'],
}, ({ testInfo }) => {
  expect(testInfo.name).to.equal('cli-naming-link-check');
});
`;

describe('CLI benchmark -f (unified/code-import mode): testCaseIds linking + run naming', () => {
  let backendAvailable = false;
  let tempDir = '';
  let fixturePath = '';
  const createdBenchmarkIds: string[] = [];
  const createdRunIds: string[] = [];
  const createdTestCaseIds: string[] = [];
  const createdReportIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    if (!backendAvailable) return;
    for (const id of createdReportIds) {
      await fetch(`${BASE_URL}/api/storage/runs/${id}`, { method: 'DELETE' }).catch(() => {});
    }
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

  it('creates a named run whose benchmark has the test case id linked (not a shell)', async () => {
    if (!backendAvailable) {
      // eslint-disable-next-line no-console
      console.warn(`[cli-naming-link] Backend not reachable at ${BASE_URL} — skipping.`);
      return;
    }

    if (!existsSync(CLI_BUNDLE)) {
      const build = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (build.status !== 0) throw new Error(`CLI build failed: ${build.stderr}`);
    }

    tempDir = mkdtempSync(join(tmpdir(), 'cli-naming-link-int-'));
    fixturePath = join(tempDir, 'naming-link.eval.js');
    writeFileSync(fixturePath, FIXTURE_CONTENT, 'utf-8');

    const port = new URL(BASE_URL).port || '4001';
    const benchmarkName = `cli-naming-link-test-${Date.now()}`;

    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== 'string') continue;
      if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'AWS_REGION' || k.startsWith('AWS_') || k === 'TMPDIR') {
        cleanEnv[k] = v;
      }
    }
    cleanEnv.AH_PORT = port;
    cleanEnv.AH_SUPPRESS_EXPERIMENTAL = '1';
    cleanEnv.AH_QUIET_DEPRECATIONS = '1';

    const cli = spawnSync(
      'node',
      [CLI_BUNDLE, 'benchmark', '-f', fixturePath, '-a', 'demo', '-n', benchmarkName],
      { cwd: REPO_ROOT, env: cleanEnv, encoding: 'utf-8', timeout: TEST_TIMEOUT - 10_000 }
    );

    if (cli.status === null) {
      throw new Error(`CLI subprocess timed out or was killed.\nSTDOUT:\n${cli.stdout}\nSTDERR:\n${cli.stderr}`);
    }
    if (cli.status !== 0) {
      throw new Error(`CLI exited ${cli.status}.\nSTDOUT:\n${cli.stdout}\nSTDERR:\n${cli.stderr}`);
    }

    // Find the benchmark by the unique name we passed via -n.
    const listRes = await fetch(`${BASE_URL}/api/storage/benchmarks?includeSample=false`);
    const { benchmarks } = await listRes.json();
    const benchmark = benchmarks.find((b: any) => b.name === benchmarkName);
    if (!benchmark) {
      throw new Error(`Could not find benchmark named "${benchmarkName}" among ${benchmarks.length} benchmarks.\nCLI STDOUT:\n${cli.stdout}`);
    }
    createdBenchmarkIds.push(benchmark.id);

    // --- Fix #4: the benchmark must NOT be a testCaseIds-less shell. ---
    expect(benchmark.testCaseIds.length).toBeGreaterThan(0);

    // Find the linked run-first evaluation run for this benchmark.
    const runsRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmark.id)}`);
    const { evaluationRuns } = await runsRes.json();
    expect(evaluationRuns.length).toBeGreaterThan(0);
    const run = evaluationRuns[0];
    createdRunIds.push(run.id);
    for (const snap of run.testCaseSnapshots || []) createdTestCaseIds.push(snap.id);
    for (const result of Object.values((run.results || {}) as Record<string, any>)) {
      if (result?.reportId) createdReportIds.push(result.reportId);
    }

    // The linked test case id(s) must be a subset of (here: equal to) the
    // benchmark's testCaseIds.
    for (const snap of run.testCaseSnapshots || []) {
      expect(benchmark.testCaseIds).toContain(snap.id);
    }

    // --- Fix #5: the run name must be derived from -n, not the generic
    // "CLI Run - <agent> - <ISO>" fallback. ---
    expect(run.name.startsWith(`${benchmarkName} — `)).toBe(true);
    expect(run.name.startsWith('CLI Run -')).toBe(false);
  }, TEST_TIMEOUT);
});
