---
name: agent-health-profile
description: Use when the user wants to profile or improve the agent/codebase based on the current session. Profiles this session's traces against a chosen evaluator and proposes concrete edits.
---

# Agent Health — Profile this session

When the user asks to profile/improve the agent (or runs `/agent-health:profile`):

1. Determine the evaluator id (the rubric). If the user gave one (e.g. `-e my-eval`),
   use it; otherwise default to `system-rca-default`. You can list options with
   `agent-health list` if needed.

1b. **Ask the user for any upfront feedback** on the session before profiling
   (e.g. "anything you want me to focus on — a wrong decision, a skipped step?").
   If they give some, pass it via `--feedback "..."`; it becomes the primary lens
   over the deterministic signals. Skip if they have nothing to add.

2. Run:
   ```bash
   __AH_CLI__ profile -e <evaluator-id> [--feedback "<their feedback>"] --output json
   ```
   It auto-detects the current session id (from `.claude/agent-health/current-session`,
   written by the setup hook) and prints a JSON profile: the evaluator rubric,
   the session trajectory (reconstructed from traces), deterministic signals, and
   your `userFeedback`.

3. Using `evaluator.systemPrompt` as the rubric, review together:
   - the `userFeedback` (weight it highest, if present),
   - the `trajectory` and `signals` from the JSON profile,
   - THIS conversation (including any corrections the user made while steering you),
   - the codebase in the current working directory.

4. Produce a prioritized list of concrete edits. For each: the file, the change,
   why (tie it to a signal or a rubric criterion), a priority, and **cite the
   evidence** — the signal that triggered it and the session's `traceIds`
   (open them in the Traces tab to verify).

5. Apply the edits on a new branch (never the working tree directly), then
   summarize the diff for the user to review.
