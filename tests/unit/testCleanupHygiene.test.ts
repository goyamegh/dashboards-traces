/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test-cleanup hygiene guard: integration/e2e cleanup hooks must delete ONLY
 * ids the run itself created — never enumerate shared storage and delete by
 * name/pattern.
 *
 * Why this exists (incident, 2026-08-29): several integration suites carried
 * afterAll "fallback" blocks that called `getAll()` (or GET a collection
 * endpoint) and deleted every entity whose *name* matched a hardcoded list
 * ('Single Import Test', 'Delete Test', 'OTEL Demo:…', …) — regardless of
 * whether this run created them. Against the shared OpenSearch cluster that
 * pattern deletes OTHER PEOPLE'S data: "name looks test-ish" is not proof of
 * ownership (real benchmarks on the shared cluster are named things like
 * `mstest` and `Jason Test`, and a real user importing the bundled OTEL demo
 * file gets docs named exactly 'OTEL Demo: …'). The same anti-pattern was
 * deliberately removed from scripts/sweep-test-data.mjs (`--legacy` opt-in,
 * dry-run default) — it must not re-enter through test cleanup either.
 *
 * The rule these assertions encode:
 *   1. Cleanup hooks (afterAll/afterEach) never call a listing API
 *      (`.getAll(`, GET on a collection endpoint) — deletion must be driven
 *      by ids captured at creation time (testDataTracker, or a hand-rolled
 *      created-ids array).
 *   2. Cleanup hooks never gate a delete on a name comparison.
 *
 * If this test fails on your new suite: record every id you create (use
 * `createTestDataTracker()` / `uniqueTestName()` from
 * tests/helpers/testDataTracker.ts) and delete exactly those ids. If you are
 * worried about leftovers from crashed runs, that is already handled — the
 * tracker's crash ledger + jest.globalTeardown.cjs reap dead runs' ids, and
 * `scripts/sweep-test-data.mjs` exists for reviewed, opt-in sweeps.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Directories whose test files run against a real (often shared) backend. */
const SCANNED_DIRS = ['tests/integration', 'tests/e2e'];

/** Recursively collect .ts files under a directory. */
function collectTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Extract the body of every afterAll/afterEach callback via brace matching. */
export function extractCleanupBlocks(source: string): Array<{ hook: string; line: number; body: string }> {
  const blocks: Array<{ hook: string; line: number; body: string }> = [];
  const re = /\b(afterAll|afterEach)\s*\(\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const start = m.index + m[0].length - 1; // position of the opening brace
    let depth = 0;
    let end = start;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push({
      hook: m[1],
      line: source.slice(0, m.index).split('\n').length,
      body: source.slice(start, end + 1),
    });
  }
  return blocks;
}

/** Listing calls that enumerate shared storage. */
const LISTING_PATTERNS: RegExp[] = [
  /\.getAll(?:Reports)?\s*\(/,
  // GET (no method ⇒ GET) of a collection endpoint: /api/storage/<collection>
  // not followed by /<id>. Matches fetch(`${BASE_URL}/api/storage/test-cases`)
  // and .../test-cases?size=500 but not .../test-cases/${id}.
  /\/api\/storage\/(test-cases|benchmarks|evaluation-runs|runs|evaluators)\s*(\?[^`'"]*)?[`'"]\s*\)/,
];

/** Deletion calls. */
const DELETE_PATTERNS: RegExp[] = [
  /\.delete\w*\s*\(/i,
  /method:\s*['"`]DELETE['"`]/,
  /\bdelete(TestCase|Benchmark|Experiment|Report|Evaluator|Run)\w*\s*\(/,
];

/** Name-comparison guards used to select deletion victims. */
const NAME_MATCH_PATTERNS: RegExp[] = [
  /\.name\s*===/,
  /\.name\s*\?\.?\s*startsWith\s*\(/,
  /\.name\s*\?\.?\s*includes\s*\(/,
  /\bnames\.includes\s*\(/,
  /includes\s*\(\s*\w+\.name\s*\)/,
];

describe('test-cleanup hygiene: cleanup hooks delete only ids this run created', () => {
  const files = SCANNED_DIRS.flatMap((d) => collectTsFiles(path.join(REPO_ROOT, d)));

  it('scans a non-trivial number of integration/e2e files (sanity)', () => {
    // If globbing breaks (dir rename), this guard must fail loudly instead of
    // silently scanning nothing and green-lighting the anti-pattern.
    expect(files.length).toBeGreaterThan(10);
  });

  it('no cleanup hook enumerates storage (list + delete) or deletes by name match', () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const block of extractCleanupBlocks(source)) {
        const lists = LISTING_PATTERNS.some((re) => re.test(block.body));
        const deletes = DELETE_PATTERNS.some((re) => re.test(block.body));
        const nameMatches = NAME_MATCH_PATTERNS.some((re) => re.test(block.body));

        if (lists && deletes) {
          violations.push(
            `${path.relative(REPO_ROOT, file)}:${block.line} — ${block.hook} lists storage AND deletes; ` +
              `cleanup must delete only tracked ids (see tests/helpers/testDataTracker.ts)`
          );
        } else if (nameMatches && deletes) {
          violations.push(
            `${path.relative(REPO_ROOT, file)}:${block.line} — ${block.hook} gates a delete on a name match; ` +
              `"name looks test-ish" is not proof of ownership on a shared cluster`
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
