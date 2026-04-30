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

import { ChildProcess, spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const OBSERVIO_PORT = 3001;

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
    const socket = new net.Socket();
    socket.setTimeout(1000);

    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      resolve(true);
    });

    socket.connect(port, 'localhost');
  });
}

/**
 * Spawn the observio sample agent as a child process.
 * Installs dependencies first if node_modules is missing.
 */
export function spawnObservioAgent(cwd: string): ChildProcess {
  // Install deps if needed
  if (!existsSync(join(cwd, 'node_modules', '@langchain', 'langgraph'))) {
    console.log('  Observio sample agent: installing dependencies...');
    execSync('npm install --legacy-peer-deps --silent', { cwd, stdio: 'ignore' });
  }

  const child = spawn('npm', ['run', 'start:ag-ui'], {
    cwd,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  // Forward observio output with prefix
  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        console.log(`  [observio] ${line}`);
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
 * Kill whatever process is listening on the observio port.
 * Cross-platform: lsof on Unix/Mac, netstat on Windows.
 */
export async function killObservioAgent(port: number = OBSERVIO_PORT): Promise<boolean> {
  const free = await isPortFree(port);
  if (free) {
    return false; // nothing to kill
  }

  try {
    if (process.platform !== 'win32') {
      execSync(`lsof -t -i:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    } else {
      try {
        const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' });
        const lines = result.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && !isNaN(parseInt(pid))) {
            execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
          }
        }
      } catch { /* no process on port */ }
    }

    // Wait for port to free
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isPortFree(port)) return true;
    }
    console.warn(`  [observio] Port ${port} may still be in use after retries`);
    return true;
  } catch {
    return false;
  }
}
