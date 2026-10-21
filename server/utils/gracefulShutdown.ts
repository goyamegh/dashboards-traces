/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Graceful HTTP server shutdown shared by every entrypoint that listens with an
 * app from `createApp()` (`server/index.ts` and the CLI's `startServer`).
 *
 * On SIGTERM/SIGINT: run the cleanup hooks, close the listener, exit 0. The
 * whole sequence is bounded by `timeoutMs`: a hung hook, a never-ending
 * in-flight request, or a lingering keep-alive connection cannot keep the
 * process alive past the deadline — at that point remaining connections are
 * destroyed and the process exits anyway.
 *
 * Any `process.on('SIGTERM')` listener suppresses Node's default termination,
 * so whoever installs one MUST exit. Installing this helper is the only
 * sanctioned way for server code to listen for termination signals.
 */

import type { Server } from 'http';

export type CleanupHook = () => void | Promise<void>;

export interface GracefulShutdownOptions {
  /** Run (concurrently) before the listener is closed. Failures are logged, never fatal. */
  cleanup?: CleanupHook[];
  /** Upper bound for the entire shutdown, in ms. Default 5000. */
  timeoutMs?: number;
  log?: (message: string) => void;
  /** Exit function; defaults to `process.exit`. Injected by tests. */
  exit?: (code: number) => void;
}

export interface GracefulShutdownHandle {
  /** Run the shutdown sequence as if `signal` had been received. Idempotent. */
  shutdown: (signal: string) => Promise<void>;
  /** Remove the signal listeners (tests). Does not abort a shutdown in progress. */
  dispose: () => void;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

export function installGracefulShutdown(server: Server, options: GracefulShutdownOptions = {}): GracefulShutdownHandle {
  const {
    cleanup = [],
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    log = (message) => console.log(message),
    exit = (code) => process.exit(code),
  } = options;

  let started = false;
  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (started) return;
    started = true;
    log(`\n  Received ${signal}, shutting down gracefully...`);

    const deadline = setTimeout(() => {
      log(`  Shutdown did not finish within ${timeoutMs}ms; closing remaining connections and exiting.`);
      server.closeAllConnections();
      exitOnce(0);
    }, timeoutMs);
    deadline.unref();

    const results = await Promise.allSettled(cleanup.map((hook) => Promise.resolve().then(hook)));
    for (const result of results) {
      if (result.status === 'rejected') {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        log(`  Shutdown cleanup step failed: ${reason}`);
      }
    }
    if (exited) return;

    server.close(() => {
      clearTimeout(deadline);
      log('  Server closed.');
      exitOnce(0);
    });
    // Keep-alive sockets with no request in flight would otherwise hold
    // `close()` open until the keep-alive timeout.
    server.closeIdleConnections();
  };

  const listeners = (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]).map((signal) => {
    const listener = () => { void shutdown(signal); };
    process.on(signal, listener);
    return { signal, listener };
  });

  return {
    shutdown,
    dispose: () => {
      for (const { signal, listener } of listeners) process.removeListener(signal, listener);
    },
  };
}
