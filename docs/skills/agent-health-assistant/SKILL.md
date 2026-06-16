---
name: agent-health-assistant
description: Guides an AI agent through using the Agent Health CLI and APIs to evaluate, benchmark, and improve AI agent performance. Activates when users ask about running evaluations, interpreting benchmark results, or improving agent pass rates.
---

# Agent Health Assistant

You are helping a user evaluate and improve their AI agent using the Agent Health evaluation framework.

## Key Commands

```bash
# Setup
npx @opensearch-project/agent-health doctor --output json
npx @opensearch-project/agent-health init

# List resources
npx @opensearch-project/agent-health list agents --output json
npx @opensearch-project/agent-health list test-cases --output json
npx @opensearch-project/agent-health list benchmarks --output json

# Run evaluations
npx @opensearch-project/agent-health run -t <test-case-id> -a <agent-key> --output json
npx @opensearch-project/agent-health benchmark -n <name> -a <agent-key> --export results.json
npx @opensearch-project/agent-health benchmark -f ./test-cases.json -a <agent-key>
```

## Improvement Workflow

1. **Baseline**: Run a benchmark and export results
2. **Analyze**: Find `passFailStatus: "failed"` entries, read `matcherResults[*].reasoning` (the canonical judge verdict) and `improvementStrategies`
3. **Fix**: Focus on `priority: "high"` strategies first — they indicate real failures
4. **Verify**: Re-run the benchmark and compare pass rates
5. **Iterate**: Repeat until high-priority issues are resolved

## Interpreting Results

Key fields in evaluation reports:
- `passFailStatus`: "passed" or "failed" — the overall judgment
- `metricsStatus`: when `"error"`, the *evaluator* couldn't run (an **errored**
  run, distinct from a `failed` agent answer) — excluded from pass-rate aggregation
- `metrics`: evaluator-defined numeric scores. Names are **heterogeneous** — only
  the RCA Default evaluator emits `accuracy`; others emit `tool_selection_accuracy`,
  `reasoning_coherence`, etc. A run's overall score is the mean of whatever it emitted.
- `matcherResults[]`: the canonical judge surface — per-matcher `passed` / `score` /
  `reasoning` (`method: 'llm-judge'` for the LLM judge). `llmJudgeReasoning` is a
  deprecated backward-compatible shim of the same text.
- `improvementStrategies`: Actionable recommendations with category, issue, recommendation, and priority
- `trajectory`: Step-by-step agent execution (thinking → action → tool_result → response)

## Tips

- Always use `--output json` for reliable parsing
- Fix high-priority issues first — they cause actual test failures
- Compare trajectories between passing and failing cases to spot differences
- Make incremental changes: one fix, then re-test
- Don't over-engineer — fix the specific issue identified by the judge
