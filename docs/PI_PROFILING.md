<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# Profiling pi.dev sessions with Agent Health

**Agent profiling** is to an AI agent what a CPU/JVM profiler is to a running
program: you attach to a *real session*, sample its execution (OpenTelemetry
traces), and get back a report of where the agent went wrong and what to fix —
in the agent's **own codebase**, scored against an evaluator you choose as the
rubric. This guide covers profiling sessions of the [pi.dev](https://pi.dev)
coding agent.

For the cross-agent concept and the Claude Code path, see
[docs/skills/AGENT_PROFILE.md](skills/AGENT_PROFILE.md).

## Why pi needs an extension

Claude Code emits OpenTelemetry natively (`CLAUDE_CODE_ENABLE_TELEMETRY`), so
`agent-health profile` can read a session's traces directly. **pi has no native
telemetry**, so a live pi session leaves nothing for `profile` to read.

A small, **zero-dependency** pi extension supplies the missing half. It both:

1. **instruments** the running pi session — emitting OTel spans for the agent
   loop; and
2. **registers `/agent-health-profile`** — which runs the profile and feeds the
   result back into the conversation so pi proposes fixes.

The extension ships as a single file:
[`examples/pi-profiling/agent-health-profile.ts`](../examples/pi-profiling/agent-health-profile.ts)
(see its [README](../examples/pi-profiling/README.md)). It speaks OTLP/HTTP JSON
over the built-in `fetch`, so there is nothing to `npm install`.

## How it works

```
pi session  ──(extension emits OTel spans)──▶  OTLP endpoint ──▶ Agent Health trace store
                                                                      │
/agent-health-profile  ─────────────────────────────────────────────┤  resolves: evaluator rubric
                                                                      ▼  samples:  this session's spans → trajectory
                                              { evaluator, trajectory, signals }   + deterministic signal scan
                                                                      │
                       the in-session pi agent adds: the live chat + the codebase
                                                                      ▼
                                       prioritized edits → applied on a branch → you review
```

## Install

```bash
# 1. Drop the extension in. Global = every pi session; or .pi/extensions/ per project.
mkdir -p ~/.pi/agent/extensions
cp examples/pi-profiling/agent-health-profile.ts ~/.pi/agent/extensions/

# 2. Point telemetry at a trace store BEFORE starting pi (telemetry is opt-in —
#    the extension only exports when this is set).
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4001   # /v1/traces is appended
```

The simplest zero-infra path is **Agent Health in file mode** (no OpenSearch):
its embedded `/v1/traces` receiver persists spans to disk and matches them by
`session.id` out of the box. For an OpenSearch-backed deployment, export to the
**same OTLP ingest your cluster reads from** (your OTel Collector / OSIS
pipeline) — the embedded receiver intentionally drops payloads when a cluster is
configured (no split-brain).

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(unset → telemetry off)* | OTLP traces target; `/v1/traces` is appended if missing |
| `OTEL_SERVICE_NAME` | `pi-agent` | `service.name` on emitted spans (keep `pi-agent` so `--service` defaults line up) |
| `OTEL_ENABLED` | `true` | set `false` to disable telemetry |
| `AGENT_HEALTH_REDACT` | *(unset)* | `1` → stamp redaction placeholders instead of capturing prompt / tool I/O |
| `AGENT_HEALTH_CLI` | `npx @opensearch-project/agent-health` | how the command invokes the CLI |

## Usage

From inside a pi session, after you've worked normally and steered the agent:

```
/agent-health-profile -e <evaluator-id> [-f "focus on routing; it ignored the SOP"]
```

The command records the session id, runs the CLI, and feeds the JSON profile
(evaluator rubric + reconstructed trajectory + deterministic signals + your
feedback) back into the chat so pi proposes prioritized, evidence-cited edits on
a new branch.

Equivalently, from a shell:

```bash
agent-health profile --session <id> --service pi-agent --output json
```

`--service` auto-defaults to `pi-agent` when the session was resolved from the
pi marker file, so you can usually omit it.

## What the extension emits

Each span follows the OpenTelemetry [Gen AI semantic
conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) so Agent
Health categorizes it correctly:

| Span | `gen_ai.operation.name` | Notes |
|------|-------------------------|-------|
| `invoke_agent pi` (root) | `invoke_agent` | one per session; adopts a propagated `TRACEPARENT` when present |
| `chat <model>` (per turn) | `chat` | `gen_ai.usage.*` token counts + `llm.request` / `llm.response` prompt/completion events |
| `execute_tool <name>` | `execute_tool` | `gen_ai.tool.input` / `gen_ai.tool.output`; ERROR status on failure |

Every span carries `session.id`; the resource carries `service.name=pi-agent`.

The extension emits a **standard OTLP `session.id` attribute** — it is
schema-agnostic. The field path it lands on in OpenSearch (e.g. nested
`attributes.session.id` vs the legacy flattened `span.attributes.session@id`) is
decided by your **ingest pipeline**, not the extension; `agent-health profile`'s
session query and your ingest just need to agree on it.

## Session identification

`profile` resolves the session id in priority order:

1. `--session <id>` if you pass it,
2. `.pi/agent-health/current-session` — written by this extension on
   `session_start` (exact),
3. `.claude/agent-health/current-session` (Claude Code), then the newest Claude
   transcript for this cwd (heuristic fallback).

## Deterministic signals

Before any LLM reasoning, `profile` runs a cheap signal scan over the session's
spans and hands the results to the rubric as evidence:

| id | meaning |
|----|---------|
| `user_redirect` | you corrected/redirected the agent mid-session |
| `tool_error_retry` | a tool failed, then was retried — tool-usage / description gap |
| `repeated_tool_calls` | identical tool+args invoked more than once — loop / distrust |
| `long_session` | unusually many turns — confusion or scope creep |
| `write_before_read` | mutated state before reading — safety / grounding gap |

## Troubleshooting

- **"profile produced no JSON / no spans found"** — telemetry isn't reaching the
  store, or the ingest schema and the session query disagree on the `session.id`
  field path. Confirm `OTEL_EXPORTER_OTLP_ENDPOINT` is set and reachable, and
  that the session ran *after* the extension loaded. Litmus test: the session
  should appear in the Agent Health **Traces** tab.
- **Privacy** — set `AGENT_HEALTH_REDACT=1` to redact prompt / tool I/O (note:
  the `user_redirect` signal needs prompt text to fire).

## Caveats

- Profiling only sees sessions that ran **while the extension was loaded and
  telemetry was on** — you cannot profile a session retroactively. Run a
  session, then `/agent-health-profile`.
- The extension is read-only with respect to your code: it produces the profile
  + a plan; apply edits on a **branch**, never the working tree.

## See also

- [docs/skills/AGENT_PROFILE.md](skills/AGENT_PROFILE.md) — the cross-agent
  profiling concept (Claude Code, Kiro, headless).
- [docs/INSTRUMENT_WITH_OTEL.md](INSTRUMENT_WITH_OTEL.md) — instrumenting your
  own agent with OTel for Agent Health.
- [examples/pi-profiling/](../examples/pi-profiling/) — the distribution file
  and its README.
