<!--
  ~ Copyright OpenSearch Contributors
  ~ SPDX-License-Identifier: Apache-2.0
-->

# Sample evals

Runnable, copy-paste-friendly examples of the Agent Health **code-based eval SDK**
(`test(...)` + `expect(...)` + `judge(...)`). Point the CLI at one with
`-f <file>` and it builds the test case, runs the agent, and grades the
trajectory with an LLM judge.

> The SDK is experimental — the API may change in a minor release. Set
> `AH_SUPPRESS_EXPERIMENTAL=1` to silence the runtime notice.

## Examples

| File | What it shows |
|------|---------------|
| [`cc-vs-pi-redundant-apis.eval.js`](./cc-vs-pi-redundant-apis.eval.js) | A **public A/B**: point two coding agents (e.g. Claude Code vs Pi) at the Agent Health codebase and ask each to find redundant customer-facing HTTP APIs, explain why they arose, and suggest fixes. Combines **deterministic guards** (`expect(...).to.haveStepsOfType('action')`, output regex) with **custom-evaluator, LLM-judged claims** (`judge(result, claim, { model, evaluatorId })`). Leak-proof: the grading criteria live only in the judge claims + the custom evaluator, never in the agent's prompt. |

Custom evaluators referenced by the samples live in
[`./evaluators/`](./evaluators) — they're registered into file storage on the
first run, so no manual registration is needed.

## Running a sample

```bash
# AWS creds for the Bedrock judge (use your own account / role / profile):
ada credentials update --account=<acct> --role=<role> --profile=default --once

# One agent per command (each agent's model comes from its agent-health.config.ts):
AH_PORT=4191 AWS_PROFILE=default AWS_REGION=us-east-1 AH_SUPPRESS_EXPERIMENTAL=1 \
  npx @opensearch-project/agent-health benchmark \
    -f docs/sample-evals/cc-vs-pi-redundant-apis.eval.js \
    -a claude-code \
    --evaluator api-redundancy-correctness --judge-model claude-opus-4.8 \
    --stop-server -v
# then repeat with another agent (e.g. -a pi) and compare the runs in the UI:
#   AH_PORT=4191 npx @opensearch-project/agent-health serve -p 4191

# AH_PORT keeps the ephemeral run server off your main one. With no storage
# block configured the run uses file storage under .agent-health/data/.
```

See [docs/SDK.md](../SDK.md) for the full SDK reference.
