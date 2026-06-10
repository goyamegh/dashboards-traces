/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Setup Command
 *
 * One-time, out-of-the-box wiring so a coding agent can use Agent Health and
 * profile itself from its own session traces. For Claude Code it installs:
 *   1. A `PreToolUse` hook that records the current `session.id` to
 *      `.claude/agent-health/current-session` (so `profile` fetches the right
 *      session's spans deterministically — no mtime guessing).
 *   2. A `/agent-health:profile` slash command.
 *   3. The curated set of customer-facing skills bundled in `docs/skills/`
 *      (auto-discovered by Claude Code).
 *
 * Telemetry (the OTel env block) is handled by `agent-health setup-telemetry`;
 * this command reminds the user to run it.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOOK_COMMAND = "mkdir -p .claude/agent-health && jq -r '.session_id' > .claude/agent-health/current-session";
const HOOK_MATCHER = 'Bash';

/**
 * Resolve how the CLI should be invoked from generated files (slash command +
 * skills). Always uses `npx <packageName>` so the generated artifacts work
 * without a global install (and still resolve a global/local install if one
 * exists, since npx prefers those). The package name is read from our own
 * package.json so a forked/renamed publish keeps working without editing this
 * file.
 */
function resolveInvoke(): string {
  let pkgName = '@opensearch-project/agent-health';
  for (const p of [join(__dirname, '..', '..', 'package.json'), join(__dirname, '..', '..', '..', 'package.json')]) {
    try { pkgName = JSON.parse(readFileSync(p, 'utf-8')).name || pkgName; break; } catch { /* keep default */ }
  }
  return `npx ${pkgName}`;
}

/**
 * Customer-facing skills shipped in `docs/skills/`. Each is a directory with a
 * `SKILL.md` (frontmatter `name` + `description`). Contributor-only skills
 * (add-connector, config-auth, create-pr, write-test) are intentionally
 * excluded. Add new customer skills here to have `setup` install them.
 */
const CUSTOMER_SKILLS = [
  'agent-health-profile',   // profile the agent from a live session (this PR)
  'agent-health-assistant', // run evals/benchmarks, interpret results, raise pass rates
  'instrument-otel',        // instrument the customer's app with OTel for Agent Health
];

function buildCommandBody(invoke: string): string {
  return `---
description: Profile this agent from the current session's traces using an evaluator rubric
argument-hint: -e <evaluator-id>
---

Profile the agent based on the current session.

Run \`${invoke} profile $ARGUMENTS --output json\` (default evaluator
\`system-rca-default\` if none given). Then, using the returned evaluator rubric +
trajectory + signals together with THIS conversation and the codebase here,
propose a prioritized list of concrete edits (file, change, why, priority) and
apply them on a new branch for review.
`;
}

/** Resolve the bundled docs/skills directory (works from source and dist). */
function getBundledSkillsDir(): string {
  // From cli/commands/ (source via tsx) or cli/dist/ (bundled) → ../../docs/skills
  const candidates = [
    join(__dirname, '..', '..', 'docs', 'skills'),
    join(__dirname, '..', 'docs', 'skills'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

interface ClaudeSettings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  [k: string]: unknown;
}

/** Merge our PreToolUse hook into .claude/settings.json idempotently. */
function installHook(): 'added' | 'exists' {
  const path = join('.claude', 'settings.json');
  let settings: ClaudeSettings = {};
  if (existsSync(path)) {
    try { settings = JSON.parse(readFileSync(path, 'utf-8')); } catch { settings = {}; }
  } else {
    mkdirSync('.claude', { recursive: true });
  }

  settings.hooks = settings.hooks || {};
  const preToolUse = settings.hooks.PreToolUse || (settings.hooks.PreToolUse = []);

  const already = preToolUse.some(entry =>
    entry.matcher === HOOK_MATCHER && entry.hooks?.some(h => h.command === HOOK_COMMAND)
  );
  if (already) return 'exists';

  preToolUse.push({ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  writeFileSync(path, JSON.stringify(settings, null, 2));
  return 'added';
}

/** Write a file only if absent (or if --force); returns the action taken. */
function writeIfNeeded(path: string, content: string, force: boolean): 'written' | 'exists' {
  if (existsSync(path) && !force) return 'exists';
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return 'written';
}

/** Copy a bundled skill's SKILL.md into .claude/skills/<name>/SKILL.md.
 *  Replaces the `__AH_CLI__` placeholder with the resolved CLI invocation so
 *  installed skills never reference a bare `agent-health` binary that may not
 *  be on PATH. */
function installSkill(skillsDir: string, name: string, invoke: string, force: boolean): 'written' | 'exists' | 'missing' {
  const src = join(skillsDir, name, 'SKILL.md');
  if (!existsSync(src)) return 'missing';
  const dest = join('.claude', 'skills', name, 'SKILL.md');
  if (existsSync(dest) && !force) return 'exists';
  mkdirSync(join(dest, '..'), { recursive: true });
  const body = readFileSync(src, 'utf-8').replace(/__AH_CLI__/g, invoke);
  writeFileSync(dest, body);
  return 'written';
}

export function createSetupCommand(): Command {
  return new Command('setup')
    .description('Install Agent Health skills + the agent-profiling hook into your coding tool (Claude Code)')
    .option('--force', 'Overwrite existing skill/command files')
    .action(async (options: { force?: boolean }) => {
      console.log(chalk.bold('\nAgent Health - Setup\n'));

      if (!existsSync('.claude')) {
        console.log(chalk.gray('  No .claude directory found — creating Claude Code layout.'));
      }

      // 1. Session hook (deterministic session id for `profile`).
      const hook = installHook();
      console.log(
        hook === 'added'
          ? chalk.green('  ✓ Installed PreToolUse session hook → .claude/settings.json')
          : chalk.gray('  • Session hook already present in .claude/settings.json')
      );

      // 2. /agent-health:profile slash command.
      const invoke = resolveInvoke();
      const cmd = writeIfNeeded(join('.claude', 'commands', 'agent-health', 'profile.md'), buildCommandBody(invoke), !!options.force);
      console.log(
        cmd === 'written'
          ? chalk.green('  ✓ Installed slash command → /agent-health:profile')
          : chalk.gray('  • Slash command already present (use --force to overwrite)')
      );

      // 3. Curated customer-facing skills.
      const skillsDir = getBundledSkillsDir();
      console.log(chalk.bold('\n  Skills:'));
      for (const name of CUSTOMER_SKILLS) {
        const result = installSkill(skillsDir, name, invoke, !!options.force);
        if (result === 'written') console.log(chalk.green(`    ✓ ${name}`));
        else if (result === 'exists') console.log(chalk.gray(`    • ${name} (already present, use --force to overwrite)`));
        else console.log(chalk.yellow(`    ⚠ ${name} (not found in bundle: ${skillsDir})`));
      }

      console.log(chalk.cyan('\n  Next steps:'));
      console.log(chalk.gray('    1. Enable telemetry so sessions stream to Agent Health:'));
      console.log(chalk.gray('         agent-health setup-telemetry'));
      console.log(chalk.gray('    2. Use your agent normally (steer it as you like).'));
      console.log(chalk.gray('    3. When done, run /agent-health:profile -e <evaluator-id>'));
      console.log(chalk.gray('       (or: agent-health profile -e <evaluator-id>)\n'));
    });
}
