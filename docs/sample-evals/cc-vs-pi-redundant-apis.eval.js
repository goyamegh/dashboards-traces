/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * cc-vs-pi-redundant-apis.eval.js
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC A/B: pick the coding agent (Claude Code vs Pi) by pointing each at the
 * Agent Health codebase and asking it to (1) find redundant customer-exposed
 * HTTP APIs, (2) understand WHY the redundancy happened (if any), and
 * (3) suggest ways to improve. Same prompt, same codebase, same judge, same
 * evaluator — whichever agents you pass via `-a` get the same blind treatment.
 *
 * The agent gets the codebase PATH as context and uses its tools (read/grep/
 * glob) to go through the code. Tool calls are expected.
 *
 * Idempotent + not tied to specifics:
 *   The verification does NOT hard-code "the answer" (a fixed list of redundant
 *   endpoints) — that would rot as the API changes. It grades the agent against
 *   (1) the evidence it CITED from the code during this run (provenance), and
 *   (2) general principles: sound dedup logic, a plausible root cause, sound
 *   improvement suggestions, correct customer-facing scope. A correct
 *   "little/no redundancy found, here's what I surveyed" is a valid answer.
 *
 * Leak-proof:
 *   The agent sees the codebase, never the redundancy answer. Grading criteria
 *   live only in the judge(...) claims + custom evaluator (judge sees them,
 *   the agent does not).
 *
 * Judge:
 *   model     = us.anthropic.claude-opus-4-8 (raw profile; published @goyamegh still maps the
 *               `claude-opus-4.8` alias to a non-existent `-v1` profile, so the judge 500'd /
 *               errored. The fix is merged (PR #347) but unpublished; the raw id bypasses the
 *               broken alias — the server forwards unknown ids straight to Bedrock.)
 *   evaluator = api-redundancy-correctness (evals/evaluators/api-redundancy-correctness.json)
 *
 * ── Run (one CLI command per agent; isolated on AH_PORT) ──────────────────────
 *   # AH_PORT=4191 keeps the run off the live :4001 server; the worktree config
 *   # has no storage block -> file storage. The evaluator persists in
 *   # .agent-health/data/ so no per-run registration is needed.
 *   #
 *   # Notes (agent owns its model; judge is independent):
 *   #   - the agent's model comes from its agent-health.config.ts (no -m flag);
 *   #   - the agent under test and the judge model are independent;
 *   #   - do NOT use -n (benchmark-by-name) — it fetches the server before
 *   #     starting it and crashes; run ad-hoc and group later;
 *   #   - ad-hoc runs ONE agent at a time, so run each agent separately;
 *   #   - use --stop-server so the ephemeral server tears down.
 *
 *   ada credentials update --account=651304888251 --role=Admin --profile=default --once
 *
 *   AH_PORT=4191 AWS_PROFILE=default AWS_REGION=us-east-1 AH_SUPPRESS_EXPERIMENTAL=1 \
 *   npx @opensearch-project/agent-health benchmark \
 *     -f docs/sample-evals/cc-vs-pi-redundant-apis.eval.js \
 *     -a claude-code \
 *     --evaluator api-redundancy-correctness --judge-model claude-opus-4.8 \
 *     --stop-server -v
 *   # then repeat with: -a pi   (each agent owns its model via its agent-health.config.ts)
 *
 *   # View results:  AH_PORT=4191 npx @opensearch-project/agent-health serve -p 4191
 */

const { test, expect } = require('@opensearch-project/agent-health');

// The codebase the agent audits = where the benchmark is invoked from (repo root).
// Passed as context ("agentpath") so the agent knows where to look; it also runs
// with this as its working directory.
const CODEBASE_PATH = process.cwd();

// Strong judge model. The agent under test and the judge are independent — any
// model id from your agent-health config works here.
const JUDGE_MODEL = 'claude-opus-4.8';
const EVALUATOR_ID = 'api-redundancy-correctness';
const judgeOpts = { model: JUDGE_MODEL, evaluatorId: EVALUATOR_ID };

// NOTE: the custom evaluator is registered once into file storage
// (.agent-health/data/evaluators/) and persists across runs, so the benchmark
// server resolves `api-redundancy-correctness` from disk — no per-run
// registration needed. To (re)seed it on a fresh machine, POST the JSON once:
//   AH_PORT=4191 npx @opensearch-project/agent-health serve -p 4191 --headless &
//   curl -X POST localhost:4191/api/storage/evaluators \
//     --data-binary @evals/evaluators/api-redundancy-correctness.json

test('agent-health--find-redundant-customer-apis', {
  prompt: [
    'Go through the Agent Health codebase (your current working directory; path in',
    'the context below) and audit its customer-facing HTTP API surface.',
    '',
    'Do THREE things:',
    '  1. FIND — identify any REDUNDANT customer-exposed API endpoints: two (or more)',
    '     endpoints a customer/integrator could call that overlap so much that one is',
    '     unnecessary (the same resource under two names, or a special-case endpoint',
    '     that a filterable/list/search endpoint already covers).',
    '  2. UNDERSTAND WHY — for the redundancy you find (if any), explain how it likely',
    '     arose, grounded in what you see in the code: e.g. two resources that evolved',
    '     in parallel, backward-compat aliases, a rename that kept the old path, or a',
    '     copy-pasted route family. If you find no real redundancy, say so.',
    '  3. SUGGEST IMPROVEMENTS — propose concrete, safe ways to reduce it: consolidate',
    '     to a canonical endpoint, deprecate + alias, replace special-case routes with',
    '     query filters, etc. Call out any backward-compatibility concerns.',
    '',
    'SCOPE: only customer-facing endpoints under server/. EXCLUDE internal/admin/debug/',
    'ingestion plumbing (/api/storage/admin/*, /api/debug, /health, *test-connection*,',
    'the OTLP receiver).',
    '',
    'Read the actual route files to ground every claim — cite the file and the',
    "router.<verb>('/path') line for each endpoint. Do NOT invent endpoints.",
    'Communicate your final answer as a clear, structured list: for each redundant',
    'group, the ENDPOINTS (METHOD /path), the file EVIDENCE, the WHY, and the FIX.',
  ].join('\n'),
  context: [
    {
      description: 'Codebase to audit (the agent\'s working directory)',
      value: CODEBASE_PATH,
    },
  ],
  description:
    'Pick the coding agent: which one goes through the codebase, finds real ' +
    'code-grounded redundant customer APIs, explains why they arose, and suggests ' +
    'sound improvements — Claude Code vs Pi.',
  labels: [
    'category:Code-Audit',
    'difficulty:Hard',
    'demo',
    'agent:any',
    'comparison:claude-code-vs-pi',
    'public',
    'source:agent-health-repo',
  ],
}, async function ({ agent, judge }) {
  const result = await agent.run();

  // ── Deterministic guards (generic; not tied to any endpoint) ──
  expect(result.trajectory).to.have.length.greaterThan(0);
  expect(result).to.haveCompletedWithin(600_000);          // 10-min budget (Opus is slower; latency still captured for cost compare)
  // It must actually GO THROUGH the code (tool calls), not answer from memory.
  expect(result.trajectory).to.haveStepsOfType('action');
  // The final answer must engage with the real API surface (any /api/ path).
  expect(result.agentOutput).to.haveOutputMatching(/\/api\//i);

  // ── Custom-evaluator, Opus-4.8-judged claims ──
  // Specifics-free + idempotent: graded against the agent's OWN cited evidence +
  // general principles, never a hard-coded list. The agent never sees these.

  // GATES — decide pass/fail.

  // (a) PROVENANCE — endpoints are real and cited from code it read (no hallucination).
  await judge(
    result,
    'Every API endpoint it reports is a real, customer-facing route that the agent located in ' +
      'the codebase during this run, each backed by a cited file path and the route-definition ' +
      'line it read. No invented, guessed, misquoted, or uncited endpoints.',
    judgeOpts
  );

  // (b) SOUNDNESS — the redundancy logic follows from the cited code + names a canonical.
  await judge(
    result,
    'For every group it calls redundant, the redundancy is justified by the cited code itself — ' +
      'same resource under two paths, or one endpoint a special case of a more general ' +
      'filterable/list/search endpoint — and it names a canonical endpoint. It does not call ' +
      'genuinely different endpoints redundant (no fabricated overlap).',
    judgeOpts
  );

  // (c) WHY / ROOT CAUSE — explains how the redundancy arose, grounded in the code.
  await judge(
    result,
    'For the redundancy it finds, it gives a plausible, code-grounded explanation of HOW it ' +
      'likely arose (e.g. parallel-evolved resources, backward-compat aliases, a rename that ' +
      'kept the old path, a copy-pasted route family) rather than only listing endpoints. If it ' +
      'finds no real redundancy, it says so and supports that with what it surveyed.',
    judgeOpts
  );

  // (d) IMPROVEMENT — concrete, safe suggestions with backward-compat awareness.
  await judge(
    result,
     'It suggests concrete, sound ways to improve (consolidate to a canonical endpoint, ' +
      'deprecate + alias, replace special-case routes with query filters, etc.) and notes ' +
      'backward-compatibility concerns where relevant — not vague advice.',
    judgeOpts
  );

  // OBSERVE — scored + surfaced, never gates; differentiates the agents.

  // (e) COVERAGE — went through the breadth of server/, not just one file.
  await judge.observe(
    result,
    'The audit is systematic: the agent went through the route surface across server/ — reading ' +
      'multiple router files / enumerating routes — rather than stopping at the first overlap.',
    judgeOpts
  );

  // (f) SCOPE — customer-facing only.
  await judge.observe(
    result,
    'Findings stay within customer-facing routes; internal/admin/debug/ingestion endpoints ' +
      '(/api/storage/admin/*, /api/debug, /health, *test-connection*, the OTLP receiver) are not ' +
      'presented as customer-API redundancy.',
    judgeOpts
  );
});
