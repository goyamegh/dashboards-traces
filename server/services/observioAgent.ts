/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Observio Sample Agent Process Management
 *
 * Handles spawning, health-checking, and killing the bundled
 * observio-sample-agent that ships alongside Agent Health.
 */

import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const OBSERVIO_DEFAULT_PORT = 3001;

/** Track the spawned child process for graceful shutdown */
let observioChild: ChildProcess | null = null;

/** The actual port observio bound to (may differ from default if auto-incremented) */
let observioActualPort: number | null = null;

/** Get the port the observio agent is actually running on */
export function getObservioPort(): number {
  return observioActualPort ?? OBSERVIO_DEFAULT_PORT;
}

/**
 * Find the observio-sample-agent directory relative to the package root.
 * Returns null when running via NPX (folder not included in npm package).
 */
export function findObservioRoot(): string | null {
  // From server/dist/ or server/services/, walk up to find package root
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'observio-sample-agent');
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Check if a port is free (nothing listening on it).
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (value: boolean) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(value);
      }
    };

    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
    socket.connect(port, 'localhost');
  });
}

/**
 * Spawn the observio sample agent as a child process.
 * Skips if dependencies are not installed — run `npm install` manually first.
 * Returns a promise that resolves with the actual port once the agent is listening,
 * or null if it failed to start.
 */
export function spawnObservioAgent(cwd: string): ChildProcess | null {
  // Only start if dependencies are already installed (avoid blocking event loop)
  if (!existsSync(join(cwd, 'node_modules', '@langchain', 'langgraph'))) {
    console.log('  [observio] Dependencies not installed. Run `cd observio-sample-agent && npm install --legacy-peer-deps` first.');
    return null;
  }

  const child = spawn('npm', ['run', 'start:ag-ui'], {
    cwd,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  observioChild = child;

  // Clean up reference when process exits
  child.once('exit', () => {
    if (observioChild === child) {
      observioChild = null;
      observioActualPort = null;
    }
  });

  // Forward observio output with prefix — detect the actual bound port
  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        console.log(`  [observio] ${line}`);
        // Detect: "AI Agent AG UI Server running at http://localhost:3002"
        const portMatch = line.match(/Server running at http:\/\/[^:]+:(\d+)/);
        if (portMatch) {
          observioActualPort = parseInt(portMatch[1], 10);
          console.log(`  [observio] Detected port: ${observioActualPort}`);
        }
      }
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        console.error(`  [observio] ${line}`);
      }
    }
  });

  return child;
}

/**
 * Kill the observio agent process.
 * Prefers killing the tracked child process; falls back to port-based lookup.
 * Attempts graceful SIGTERM first, then SIGKILL after timeout.
 */
export async function killObservioAgent(port: number = getObservioPort()): Promise<boolean> {
  // First, try to kill the tracked child process
  if (observioChild && !observioChild.killed) {
    try {
      observioChild.kill('SIGTERM');
      // Wait up to 5s for graceful shutdown
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (observioChild === null || observioChild.killed) break;
      }
      // Force kill if still alive
      if (observioChild && !observioChild.killed) {
        observioChild.kill('SIGKILL');
      }
      observioChild = null;
    } catch { /* process already exited */ }

    // Verify port is free
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isPortFree(port)) return true;
    }
  }

  // Fallback: check if port is in use by something else
  const free = await isPortFree(port);
  if (free) return false; // nothing to kill

  console.warn(`  [observio] Port ${port} is in use but not by a tracked process. Use 'lsof -i :${port}' to investigate.`);
  return false;
}
