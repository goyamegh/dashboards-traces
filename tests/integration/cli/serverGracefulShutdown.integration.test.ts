/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real child servers, real SIGTERM, real HTTP — no lifecycle mocks.
 *
 * Both entrypoints that listen with an app from createApp() must react to
 * SIGTERM the same way: stop accepting, drain/flush, exit 0 — within the shared
 * 5 s bound, even while a client holds an in-flight connection open. The CLI's
 * stopServer() only escalates to SIGKILL after 7 s; a server that still needs
 * that escalation has NOT shut down gracefully.
 *
 * Regression: before the shared helper, createApp() registered a bare SIGTERM
 * listener (telemetry flush only). That suppressed Node's default termination,
 * so a `cli.js serve` child survived SIGTERM indefinitely.
 *
 * Build first: npm run build:all. Staged under node_modules/ so the server
 * bundle cannot find the repo's observio-sample-agent and never touches port 3030.
 */
import { spawn, type ChildProcess } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { connect, type Socket } from 'net';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const GRACEFUL_BOUND_MS = 5_000;
const CLI_SIGKILL_ESCALATION_MS = 7_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function reserveEphemeralPort(): Promise<number> {
  const reservation: Server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => resolve((reservation.address() as { port: number }).port));
  });
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return port;
}

function stagePackage(): { project: string; packageDir: string } {
  for (const file of ['bin/cli.js', 'cli/dist/index.js', 'server/dist/app.js', 'server/dist/index.js']) {
    if (!existsSync(join(ROOT, file))) throw new Error(`Missing ${file}; run npm run build:all first`);
  }
  const scratchRoot = join(ROOT, '.agent-health');
  mkdirSync(scratchRoot, { recursive: true });
  const project = mkdtempSync(join(scratchRoot, 'graceful-shutdown-'));
  const packageDir = join(project, 'node_modules/@opensearch-project/agent-health');
  mkdirSync(packageDir, { recursive: true });
  for (const file of ['package.json', 'bin', 'cli/dist', 'server/dist', 'lib/dist', 'dist']) {
    if (existsSync(join(ROOT, file))) cpSync(join(ROOT, file), join(packageDir, file), { recursive: true });
  }
  // Empty project config: code-first mode ignores any ~/.agent-health user
  // config; storage still comes from the OPENSEARCH_* environment.
  writeFileSync(join(project, 'agent-health.config.mjs'), 'export default {};\n');
  return { project, packageDir };
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(25);
  return predicate();
}

async function waitForHealth(port: number, child: ChildProcess, timeoutMs: number, output: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited(child)) throw new Error(`server exited before /health (code ${child.exitCode})\n${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        // Must be OUR child on this port, not something that raced onto the ephemeral port.
        const health = await response.json() as { instance?: { pid?: number } };
        if (health.instance?.pid !== child.pid) {
          throw new Error(`port ${port} answered /health from pid ${health.instance?.pid}, expected our child ${child.pid}`);
        }
        return;
      }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`server on ${port} did not become healthy within ${timeoutMs}ms\n${output()}`);
}

/** A connection with a request in flight: `server.close()` alone waits on it forever. */
function openHeldRequest(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write('GET /health HTTP/1.1\r\nHost: x\r\n'); // headers never terminated
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function connectRefused(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(undefined); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code));
  });
}

const ENTRYPOINTS = {
  'bin/cli.js serve (CLI-owned listener via createApp)': (dir: string, port: number) => [join(dir, 'bin/cli.js'), 'serve', '-p', String(port), '--no-browser'],
  'server/dist/index.js (standalone entrypoint)': (dir: string) => [join(dir, 'server/dist/index.js')],
};
const CASES = Object.entries(ENTRYPOINTS).flatMap(([name, args]) => [
  { name, args, hold: false, title: 'idle: exits 0 promptly, before the deadline' },
  { name, args, hold: true, title: 'in-flight connection held: exits 0 at the deadline, before the CLI would SIGKILL' },
]);

describe('graceful shutdown of real child servers on SIGTERM', () => {
  it.each(CASES)('$name — $title', async ({ args, hold }) => {
    const { project, packageDir } = stagePackage();
    const port = await reserveEphemeralPort();
    const env: NodeJS.ProcessEnv = {
      ...process.env, AH_PORT: String(port), PORT: String(port), NO_COLOR: '1',
      BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1',
    };
    delete env.CI;
    let output = '';
    const child = spawn(process.execPath, args(packageDir, port), { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr!.on('data', (chunk) => { output += chunk.toString(); });
    let held: Socket | undefined;
    try {
      await waitForHealth(port, child, 90_000, () => output);
      if (hold) held = await openHeldRequest(port);
      const heldClosed = held ? new Promise<void>((resolve) => held!.once('close', resolve)) : Promise.resolve();

      const sentAt = Date.now();
      child.kill('SIGTERM'); // exact PID we spawned, nothing else
      const done = await waitUntil(() => exited(child), CLI_SIGKILL_ESCALATION_MS);
      const elapsed = Date.now() - sentAt;
      if (!done) {
        throw new Error(`REGRESSION: server (pid ${child.pid}) still alive ${CLI_SIGKILL_ESCALATION_MS}ms after SIGTERM; ` +
          `the CLI would have to SIGKILL it. Output:\n${output}`);
      }
      expect(child.signalCode).toBeNull();
      expect(child.exitCode).toBe(0);
      expect(elapsed).toBeLessThanOrEqual(GRACEFUL_BOUND_MS + 1_000);
      if (!hold) expect(elapsed).toBeLessThan(GRACEFUL_BOUND_MS - 1_000); // natural close, not the deadline
      // Pin shutdown behavior, not the wording of the deadline diagnostic.
      await heldClosed;
      expect(await connectRefused(port)).toBe('ECONNREFUSED');
      expect(output).toContain('Received SIGTERM, shutting down gracefully');
      console.log(`[graceful] pid ${child.pid} exited 0 in ${elapsed}ms after SIGTERM (held connection: ${hold}); port ${port} refused`);
    } finally {
      held?.destroy();
      if (!exited(child)) {
        child.kill('SIGKILL'); // emergency cleanup of OUR child only
        await waitUntil(() => exited(child), 5_000);
      }
      rmSync(project, { recursive: true, force: true });
    }
  }, 150_000);
});
