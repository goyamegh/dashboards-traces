# Agent Health Pi Package

> A [pi.dev](https://pi.dev) coding agent specialized in Agent Health — helps customers instrument their agents with OpenTelemetry AND helps contributors implement features, fix bugs, and raise PRs.

## Install

```bash
# From npm (once published)
pi install @opensearch-project/agent-health-pi

# From local path (for development)
# Add to your pi settings.json:
{
  "packages": [
    { "source": "path:/path/to/observio-sample-agent/pi-package" }
  ]
}
```

## What It Does

### For Customers (DIY Agent Observability)

You have an AI agent and want to see its traces in Agent Health dashboards.

```
/instrument-otel     → Add OTel spans with Gen AI semantic conventions
/setup-collector     → Configure OSIS pipeline or OTel Collector
```

### For Contributors (Implement & Ship)

You want to add features or fix bugs in Agent Health itself.

```
/implement-feature   → Guided implementation following architecture & conventions
/fix-bug             → Systematic diagnosis → fix → verify workflow
/create-pr           → Full compliance (SPDX, DCO, CHANGELOG, tests)
/write-test          → Generate tests matching project conventions
```

## Tools

The extension registers 4 tools the agent uses automatically:

| Tool | Purpose |
|------|---------|
| `validate_spans` | Check OTel instrumentation against Gen AI conventions |
| `check_compliance` | Verify PR readiness (headers, signoff, changelog, build) |
| `find_architecture` | Route queries to the correct code layer |
| `run_validation` | Run build & test suite |

## Usage Examples

### "I want my agent's traces in Agent Health"

```
> /instrument-otel

Pi will ask about your stack (language, LLM provider, framework) and generate
the complete OTel setup: tracer provider, span helpers, and wiring into your
agent loop.
```

### "Implement a new API endpoint for trace filtering"

```
> /implement-feature

Pi identifies the correct layer (server/routes/), generates the route following
existing validation patterns, adds types, writes tests, and prepares the PR.
```

### "Traces show up but token metrics are wrong"

```
> /fix-bug

Pi traces the issue through spanCategorization.ts → metrics.ts, identifies the
root cause, applies a minimal fix, writes a regression test, and runs validation.
```

## How It Works

This package contains **domain knowledge, not runtime infrastructure**. Pi.dev handles:
- The agent loop (reasoning, tool calling)
- LLM provider access (any of 15+ providers)
- File editing, git operations, shell commands
- Interactive TUI / RPC / SDK modes

We supply:
- **Skills** — structured workflows for common tasks
- **Tools** — validation and architecture navigation
- **Prompt** — system context about Agent Health's architecture and conventions

The agent reads the actual codebase at runtime (Option 1: always fresh) rather than relying on stale snapshots.

## Development

```bash
# Test locally with pi
pi --package ./pi-package

# The old ReAct agent in src/ remains as a reference implementation
# that the instrument-otel skill points to as an example of good instrumentation
```

## Reference Agent

The `src/` directory contains a full ReAct agent (LangGraph + Bedrock + MCP) with
OTel instrumentation. It serves as a working example of what the `instrument-otel`
skill helps users build. See the main [README.md](../README.md) for details.
