<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# Pi session profiling — drop-in extension

Profile your **pi.dev** coding sessions with Agent Health, the way a CPU profiler
profiles a running process: instrument a real session, then get back what to fix
(scored against an evaluator rubric) to improve the agent and your own
productivity.

pi has **no native OpenTelemetry telemetry**, so `agent-health profile` has
nothing to read for a live pi session. This single file supplies that missing
half: it instruments the running session (emitting OTel spans) **and** registers
the `/agent-health-profile` command. It is **zero-dependency** — it speaks OTLP
over the built-in `fetch`, so there is nothing to `npm install`.

## Install (out of the box)

```bash
# 1. Drop the extension in (global = every pi session; or .pi/extensions/ per project)
mkdir -p ~/.pi/agent/extensions
cp agent-health-profile.ts ~/.pi/agent/extensions/

# 2. Point telemetry at a trace store BEFORE starting pi.
#    Simplest: Agent Health in FILE mode (no OpenSearch) — its embedded receiver
#    persists spans and matches sessions out of the box:
agent-health serve            # or any command that boots the server on :4001
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4001   # /v1/traces is appended
```

That's it. Use pi normally, then run `/agent-health-profile` (or
`/agent-health-profile -e <evaluator-id> -f "focus on X"`).

## How it routes (important for OpenSearch users)

The extension exports OTLP/JSON to `OTEL_EXPORTER_OTLP_ENDPOINT`:

- **File mode (recommended for getting started):** point it at Agent Health's
  embedded `:4001/v1/traces`. Spans persist to disk and `profile` matches them by
  `session.id` directly. Zero infra.
- **OpenSearch-backed Agent Health:** the embedded `:4001` receiver *drops*
  payloads when a cluster is configured (no split-brain). Point the extension at
  the **same OTLP ingest the cluster reads from** (your OTel Collector / OSIS
  pipeline). The extension emits a standard OTLP `session.id` attribute — it is
  schema-agnostic; what matters is that your ingest and `agent-health profile`'s
  session query agree on where `session.id` lands. Agent Health is standardizing
  on the plain/nested schema (`attributes.session.id`; OSIS
  `trace-analytics-plain-raw`), moving off the legacy `@`-flattened
  `span.attributes.session@id` layout.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4001` | OTLP traces target (`/v1/traces` appended) |
| `OTEL_SERVICE_NAME` | `pi-agent` | service.name on spans (keep `pi-agent` for `--service` defaults) |
| `OTEL_ENABLED` | `true` | set `false` to disable telemetry |
| `AGENT_HEALTH_REDACT` | unset | `1` → redact prompt / tool I/O |
| `AGENT_HEALTH_CLI` | `npx @opensearch-project/agent-health` | how the command invokes the CLI |

## What it emits

| Span | `gen_ai.operation.name` | Notes |
|------|-------------------------|-------|
| `invoke_agent pi` (root) | `invoke_agent` | one per session; carries `session.id` |
| `chat <model>` (per turn) | `chat` | token usage + `llm.request`/`llm.response` events |
| `execute_tool <name>` | `execute_tool` | `gen_ai.tool.input`/`output`; ERROR status on failure |

Every span carries `session.id`; the resource carries `service.name=pi-agent`.

## Caveat

Profiling only sees sessions that ran **while the extension was loaded and
telemetry was on** — you can't profile a session retroactively. Run a session,
then `/agent-health-profile`.
