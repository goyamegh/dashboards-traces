/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sweep test-created entities out of a storage backend.
 *
 * Two jobs:
 *   1. **Retroactive cleanup** — delete the clutter that leaked into the shared
 *      OpenSearch cluster from test runs that predate the cleanup harness.
 *   2. **Safety net** — run after a test suite (or from jest globalTeardown) to
 *      catch entities orphaned by a crashed/killed test whose `afterAll` never ran.
 *
 * SAFETY MODEL (this points at a shared cluster holding real benchmark data):
 *   - **dry-run by default** — you must pass `--apply` to delete anything;
 *   - plain `--apply` only ever touches the unambiguous `ahtest-` name prefix
 *     stamped by the harness. Nothing else;
 *   - the broad legacy name patterns (pre-harness tests used names a human
 *     could plausibly reuse, e.g. "E2E Test Case") require an EXPLICIT
 *     `--legacy` opt-in, and every candidate is printed for review;
 *   - report docs carry NO name, so name matching CANNOT see them; the `run`
 *     kind is reported as unmatchable instead of printing a reassuring zero.
 *     Test-created reports are deleted BY ID via the tracker / crash ledger;
 *   - unknown flags are a hard error, never silently ignored — a typo'd flag
 *     must not quietly run a different (broader or narrower) sweep;
 *   - there is deliberately NO structural "orphan" mode. An earlier revision
 *     shipped `--orphans` ("delete reports whose parent benchmark /
 *     evaluation-run no longer resolves") and an audit against the real shared
 *     cluster proved the premise wrong: parent-reference absence is NOT a junk
 *     signal on real data. Reports from the classic benchmark `/execute` era
 *     carry `experimentRunId: run-<ts>-<rand>` ids that only ever existed
 *     EMBEDDED in `benchmark.runs[]` (never as standalone evaluation-run
 *     docs), so "eval-run doc 404" mis-flagged every old real run; and even
 *     the corrected rule (benchmark-anchored resolution) selected hundreds of
 *     reports of genuine historical work from real, currently-configured
 *     agents whose parents were simply deleted later. Reclaiming historical
 *     parentless reports needs a bespoke, manually-reviewed audit — see
 *     AGENTS.md § "Retroactive cleanup".
 *
 * Usage:
 *   node scripts/sweep-test-data.mjs                  # dry run, ahtest-* only
 *   node scripts/sweep-test-data.mjs --apply          # delete ahtest-* matches
 *   node scripts/sweep-test-data.mjs --legacy         # also match legacy names (review!)
 *   node scripts/sweep-test-data.mjs --legacy --apply # delete legacy matches too
 *   node scripts/sweep-test-data.mjs --prefix-only    # compat alias (prefix-only IS the default)
 *   node scripts/sweep-test-data.mjs --url http://localhost:4321
 *   node scripts/sweep-test-data.mjs --json           # machine-readable summary
 */

const AH_TEST_PREFIX = 'ahtest-';

/**
 * Patterns identifying test-created entities.
 *
 * `prefix` entries are the modern, always-safe case: the cleanup harness stamps
 * `ahtest-` on everything it creates. This is the ONLY thing plain `--apply`
 * deletes.
 *
 * `legacy` entries are literal names/prefixes hard-coded by tests written before
 * the harness existed. A real user can create data with names like these, so
 * they are opt-in via `--legacy` and every candidate is printed for human
 * review before you re-run with `--apply`. Keep these EXACT and narrow — a
 * loose pattern like /test/i would match real user benchmarks such as
 * "Pulsar-regression-tests", "mstest", "Jason Test",
 * "otel-multi-turn-test-cases" or "petclinic-multi-turn-test-cases".
 */
const TEST_NAME_PATTERNS = {
  prefix: [AH_TEST_PREFIX],
  legacy: [
    // tests/e2e/fixtures/test-fixtures.ts sample entities + e2e specs create
    // "E2E Test Case" / "E2E Test Benchmark" / other "E2E Test …" names.
    // (Deliberately NOT the bare /^E2E / — that would match a human's
    // "E2E checkout flow" benchmark.)
    /^E2E Test /,
    // CLI integration tests
    /^cli-naming-link-test-\d+$/,
    /^sample-import-test-cases$/,
    /^cli-dx-/,
    /^doctor-test-/,
    // integration-test fixtures ("Integration Test Case", "Integration Test
    // Benchmark", "Integration Test Run", "Integration Test - Trace Blocking …")
    /^Integration Test /,
    /^integration-test-/,
    /^Test Benchmark \d+$/,
    /^Test Case \d+$/,
  ],
};

const CURSOR_PAGE_SIZE = 500;
/**
 * Default page size for non-cursor endpoints.
 *
 * Deliberately conservative: `/api/storage/evaluation-runs` returns HTTP 500 when
 * asked for 10000 rows, so "just ask for everything" is not portable across
 * these routes.
 */
const DEFAULT_PAGE_SIZE = 1000;
/**
 * Highest `size` the runs endpoint tolerates.
 *
 * `GET /api/storage/runs` passes `size` straight through to OpenSearch, so
 * `size > 10000` trips `max_result_window` — and the route swallows the error and
 * returns ONLY the 6 bundled sample runs. Asking for too much therefore looks
 * exactly like "nothing to clean", which would be a false all-clear. Stay under
 * the window and treat a full page as possible truncation.
 */
const MAX_WINDOW = 10000;

const ENDPOINTS = [
  // order matters: children before parents
  { kind: 'evaluation-run', list: '/api/storage/evaluation-runs', collection: 'evaluationRuns', cursor: false, del: (id) => `/api/storage/evaluation-runs/${encodeURIComponent(id)}` },
  // Report docs ("runs") have NO `name` field at all — name matching can never
  // see them, so the name sweep must not even pretend to scan them (a
  // "run: N total, 0 test-created" line was a false clean signal). They are
  // exactly the kind that leaks the most, because deleting a benchmark or an
  // evaluation run does NOT cascade to its report docs. Test-created reports
  // are deleted BY ID via TestDataTracker / the crash ledger; historical ones
  // need a bespoke manual audit (see header — structural "orphan" detection
  // was removed after mis-flagging real data).
  { kind: 'run', list: '/api/storage/runs', collection: 'runs', cursor: false, pageSize: MAX_WINDOW, fields: 'id,experimentId,experimentRunId,timestamp,createdAt', nameless: true, del: (id) => `/api/storage/runs/${encodeURIComponent(id)}` },
  { kind: 'test-case', list: '/api/storage/test-cases', collection: 'testCases', cursor: true, del: (id) => `/api/storage/test-cases/${encodeURIComponent(id)}` },
  { kind: 'benchmark', list: '/api/storage/benchmarks', collection: 'benchmarks', cursor: false, del: (id) => `/api/storage/benchmarks/${encodeURIComponent(id)}` },
  { kind: 'evaluator', list: '/api/storage/evaluators', collection: 'evaluators', cursor: false, del: (id) => `/api/storage/evaluators/${encodeURIComponent(id)}` },
];

function parseArgs(argv) {
  const args = {
    apply: false,
    prefixOnly: false,
    legacy: false,
    json: false,
    url: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--prefix-only') args.prefixOnly = true; // compat alias: prefix-only is the default
    else if (a === '--legacy') args.legacy = true;
    else if (a === '--json') args.json = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--orphans' || a === '--min-age-minutes') {
      // Removed on purpose — refuse loudly rather than silently running a
      // different sweep. See the header SAFETY MODEL: structural dangling-
      // parent detection mis-classified real historical reports (classic
      // benchmark runs whose `run-<ts>-<rand>` ids never existed as standalone
      // eval-run docs, and real work whose parents were deleted later) as junk.
      throw new Error(
        `${a} was removed: parent-reference absence is not a reliable junk signal — ` +
          'an audit against the shared cluster showed it selects real historical runs. ' +
          'Reclaiming parentless reports needs a bespoke, manually-reviewed audit ' +
          '(AGENTS.md § "Retroactive cleanup"). Nothing was scanned or deleted.'
      );
    } else {
      throw new Error(`unknown flag: ${a} (see --help). Nothing was scanned or deleted.`);
    }
  }
  // `--prefix-only` beats `--legacy` if someone passes both.
  if (args.prefixOnly) args.legacy = false;
  return args;
}

function baseUrl(explicit) {
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = process.env.AH_PORT || process.env.AGENT_HEALTH_PORT || '4001';
  return `http://localhost:${port}`;
}

/**
 * Does this entity name look test-created?
 *
 * Default is PREFIX-ONLY: just the `ahtest-` prefix, which no human-authored
 * entity carries. The broad legacy patterns only apply with `legacy: true`
 * (CLI flag `--legacy`), because a real user could plausibly name a benchmark
 * "E2E Test Benchmark". `prefixOnly: true` forces legacy matching off (kept
 * for backwards compatibility with the old flag semantics).
 */
export function matchesTestPattern(name, { prefixOnly = false, legacy = false } = {}) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (TEST_NAME_PATTERNS.prefix.some((p) => name.startsWith(p))) return true;
  if (prefixOnly || !legacy) return false;
  return TEST_NAME_PATTERNS.legacy.some((re) => re.test(name));
}

/**
 * List every entity of a kind, following pagination to the end.
 *
 * The storage API is not uniform, and each quirk silently truncates:
 *  - `/api/storage/test-cases` caps a single response at 1000 rows while
 *    reporting the true `total` (e.g. 1537), and offers an `after` cursor.
 *  - `/api/storage/runs` ignores `from` entirely and reports `total` as merely
 *    "rows returned", so offset paging terminates after one page. It needs one
 *    big request bounded by `MAX_WINDOW`.
 *
 * `truncated` is returned so the caller can warn instead of printing a
 * misleading zero.
 */
async function listEntities(url, endpoint) {
  const all = [];
  let after = null;
  let truncated = false;

  for (let guard = 0; guard < 500; guard += 1) {
    const pageSize = endpoint.cursor
      ? CURSOR_PAGE_SIZE
      : (endpoint.pageSize ?? DEFAULT_PAGE_SIZE);
    const params = new URLSearchParams({ size: String(pageSize) });
    // Project down to the few fields the sweeper needs. Without this the
    // runs endpoint tries to serialise ~8k FULL run documents (each carrying
    // trajectories and raw SSE events, KBs-MBs apiece), blows up server-side and
    // falls back to the 6 bundled sample runs -- indistinguishable from "clean".
    if (endpoint.fields) params.set('fields', endpoint.fields);
    if (after) params.set('after', after);

    const response = await fetch(`${url}${endpoint.list}?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`GET ${endpoint.list} -> HTTP ${response.status}`);
    }
    const body = await response.json();

    if (Array.isArray(body)) return { entities: body, truncated: false };

    const page = body[endpoint.collection] ?? body.items ?? body.results ?? [];
    all.push(...page);

    // Non-cursor endpoints: one request is all we get.
    if (!endpoint.cursor) {
      truncated = page.length >= pageSize;
      break;
    }

    if (page.length === 0 || body.hasMore === false || !body.after) break;
    after = typeof body.after === 'string' ? body.after : JSON.stringify(body.after);
  }

  return { entities: all, truncated };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // Usage errors (unknown/removed flags) print the message alone — no stack —
    // and exit non-zero so wrappers cannot mistake refusal for a clean sweep.
    // eslint-disable-next-line no-console
    console.error(`sweep-test-data: ${error.message}`);
    process.exit(2);
  }
  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(
      [
        'Sweep test-created entities out of a storage backend. Dry-run by default.',
        '',
        '  --apply                actually delete (default: dry run)',
        '  --legacy               ALSO match broad legacy name patterns (candidates are',
        '                         printed for review; default matches only ahtest-*)',
        '  --prefix-only          compat alias for the default ahtest-*-only matching',
        '  --url <url>            backend base url (default http://localhost:${AH_PORT:-4001})',
        '  --json                 machine-readable summary',
        '',
        'Report docs carry no name and are cleaned BY ID via the test-data tracker /',
        'crash ledger. There is deliberately no structural "orphan" scan: parent-',
        'reference absence mis-classifies real historical runs as junk (see the',
        'header comment and AGENTS.md § "Retroactive cleanup").',
      ].join('\n')
    );
    return;
  }

  const url = baseUrl(args.url);
  const summary = {
    url,
    dryRun: !args.apply,
    mode: 'names',
    legacy: args.legacy,
    kinds: {},
    totalMatched: 0,
    totalDeleted: 0,
    errors: [],
  };

  {
    for (const endpoint of ENDPOINTS) {
      // Never pretend to name-scan a kind that has no name: a "0 test-created"
      // line for reports would be a false clean signal (they can never match).
      if (endpoint.nameless) {
        summary.kinds[endpoint.kind] = {
          skipped: 'no name field — report docs are deleted by id via the tracker/ledger',
        };
        if (!args.json) {
          // eslint-disable-next-line no-console
          console.log(
            `\n${endpoint.kind}: cannot match by name (report docs carry no name) — test-created reports are deleted by id via the tracker/crash ledger; historical reclaim needs a manual audit`
          );
        }
        continue;
      }

      let entities;
      let truncated = false;
      try {
        ({ entities, truncated } = await listEntities(url, endpoint));
      } catch (error) {
        summary.errors.push(`${endpoint.kind}: ${error.message}`);
        continue;
      }

      const matched = entities.filter((e) =>
        matchesTestPattern(e?.name, { prefixOnly: args.prefixOnly, legacy: args.legacy })
      );
      summary.kinds[endpoint.kind] = { total: entities.length, matched: matched.length, deleted: 0, truncated, names: matched.map((e) => e.name) };
      summary.totalMatched += matched.length;
      if (truncated) {
        summary.errors.push(
          `${endpoint.kind}: response filled the requested page — results may be incomplete, re-run after deleting a batch`
        );
      }

      if (!args.json) {
        // eslint-disable-next-line no-console
        console.log(`\n${endpoint.kind}: ${entities.length} total, ${matched.length} test-created${args.legacy ? ' (legacy patterns ON — review each line)' : ''}`);
        for (const e of matched) {
          // eslint-disable-next-line no-console
          console.log(`  ${args.apply ? 'DELETE' : 'would delete'}  ${e.name}  (${e.id})`);
        }
      }

      if (args.apply) {
        for (const e of matched) {
          try {
            const response = await fetch(`${url}${endpoint.del(e.id)}`, { method: 'DELETE' });
            if (response.ok || response.status === 404 || response.status === 410) {
              summary.kinds[endpoint.kind].deleted += 1;
              summary.totalDeleted += 1;
            } else {
              summary.errors.push(`${endpoint.kind} ${e.id}: HTTP ${response.status}`);
            }
          } catch (error) {
            summary.errors.push(`${endpoint.kind} ${e.id}: ${error.message}`);
          }
        }
      }
    }
  }

  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `\n${summary.dryRun ? '[dry run] ' : ''}matched ${summary.totalMatched}, deleted ${summary.totalDeleted}` +
        (summary.errors.length ? `, ${summary.errors.length} error(s):\n  ${summary.errors.join('\n  ')}` : '')
    );
    if (summary.dryRun && summary.totalMatched > 0) {
      // eslint-disable-next-line no-console
      console.log('\nRe-run with --apply to delete the entities listed above.');
    }
    if (!args.legacy) {
      // eslint-disable-next-line no-console
      console.log('(name matching covered ahtest-* only; pass --legacy to also scan pre-harness literal names)');
    }
  }

  if (summary.errors.length > 0) process.exitCode = 1;
}

// Only auto-run as a CLI, so tests can import `matchesTestPattern`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
