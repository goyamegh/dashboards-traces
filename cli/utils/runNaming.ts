/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for CLI `benchmark` run naming and `-n`/file-path
 * disambiguation. Deliberately dependency-light (no chalk/ora/commander) so
 * unit tests can import it directly — `cli/commands/benchmark.ts` pulls in
 * `chalk` (ESM-only) at module scope, which breaks under ts-jest's CJS
 * transform if imported straight from a test file.
 */

import { isCodeFile } from '@/lib/testCases/loader.js';

/**
 * Check if a string looks like a file path (JSON test-case data or a
 * `.eval.js`/`.ts`/`.mjs` code file), as opposed to a benchmark name.
 */
export function isFilePath(value: string): boolean {
  return value.toLowerCase().endsWith('.json') || isCodeFile(value);
}

/**
 * Derive the name for a unified-mode (`runUnifiedMode`) evaluation run.
 *
 * `-n <name>` is overloaded: it names the *benchmark* the run gets
 * associated with, but the run document itself always got the generic,
 * undiscoverable `CLI Run - <agent> - <ISO>` name regardless — so
 * `benchmark -f redkite-cost.eval.js -n "autoresearch-redkite"` produced a
 * benchmark named "autoresearch-redkite" whose one run was named
 * "CLI Run - cc-redkite - 2026-...", with no textual link between them in
 * the runs list. When `-n` is a real name (not a JSON/code file path — the
 * legacy `-n <file>` single-file mode), the run inherits it as a prefix.
 */
export function deriveUnifiedRunName(name: string | undefined, agentKey: string, now: Date = new Date()): string {
  if (name && !isFilePath(name)) {
    return `${name} — ${now.toISOString()}`;
  }
  return `CLI Run - ${agentKey} - ${now.toISOString()}`;
}
