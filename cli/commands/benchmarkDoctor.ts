/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `agent-health benchmark doctor` — detect and clean up duplicated / debris
 * benchmark entities.
 *
 * Dry-run by default: prints the plan and exits. `--apply` executes it:
 *   - content-duplicate groups: embedded runs merged into the canonical,
 *     eval-runs re-pointed, husks deleted (runs/reports NEVER deleted);
 *   - timestamped debris (quick-<ts>, *-<epoch-ms>) with no runs anywhere
 *     and age > 24h: deleted.
 *
 * `--migrate-images` (phase 4 of the dedup plan): converts every remaining
 * real benchmark into a content-addressed benchmark image tagged with the
 * benchmark's name — the forward-looking grouping entity. Benchmarks are NOT
 * deleted by migration (back-compat); new runs converge on images by digest.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '@/lib/config/index.js';
import { ensureServer, createServerCleanup, type EnsureServerResult } from '@/cli/utils/serverLifecycle.js';
import { ApiClient } from '@/cli/utils/apiClient.js';
import {
  buildDoctorPlan,
  applyDoctorPlan,
  migrateBenchmarksToImages,
  type DoctorPlan,
} from '@/services/benchmarkDoctor.js';

function printPlan(plan: DoctorPlan): void {
  console.log(chalk.bold('\nBenchmark Doctor — plan\n'));
  console.log(chalk.gray(`  Benchmarks scanned: ${plan.summary.totalBenchmarks}`));

  if (plan.debrisDeletions.length === 0 && plan.contentDupGroups.length === 0) {
    console.log(chalk.green('\n  ✓ No debris or content duplicates found. Nothing to do.\n'));
    return;
  }

  if (plan.debrisDeletions.length > 0) {
    console.log(chalk.yellow(`\n  Debris to delete (${plan.debrisDeletions.length}):`));
    for (const d of plan.debrisDeletions) {
      console.log(chalk.gray(`    - ${d.name} (${d.id}) — ${d.reason}`));
    }
  }

  if (plan.contentDupGroups.length > 0) {
    console.log(chalk.yellow(`\n  Content-duplicate groups (${plan.contentDupGroups.length}):`));
    for (const g of plan.contentDupGroups) {
      console.log(chalk.white(`    Canonical: ${g.canonicalName} (${g.canonicalId})`));
      for (const h of g.husks) {
        console.log(chalk.gray(`      merge+delete: ${h.name} (${h.id}, ${h.embeddedRunCount} embedded runs)`));
      }
      if (g.runRepoints.length > 0) {
        console.log(chalk.gray(`      re-point ${g.runRepoints.length} eval-run(s) → canonical`));
      }
    }
  }

  console.log(
    chalk.cyan(
      `\n  Summary: delete ${plan.summary.debrisCount} debris, merge ${plan.summary.husksToMerge} duplicates, re-point ${plan.summary.runsToRepoint} runs.`
    )
  );
  console.log(chalk.gray('  Runs and reports are never deleted.\n'));
}

export function createBenchmarkDoctorCommand(): Command {
  return new Command('doctor')
    .description('Detect and clean up duplicated / debris benchmarks (dry-run by default)')
    .option('--dry-run', 'Preview only — this is already the default; use --apply to execute')
    .option('--apply', 'Execute the plan (default: dry-run report only)')
    .option('--migrate-images', 'Also convert remaining benchmarks into tagged benchmark images')
    // NOT `-o/--output <format>`: the parent `benchmark` command already owns
    // `-o/--output` (and `--format`) for ITS OWN options, and commander
    // resolves a parent command's registered options against the full argv
    // before dispatching to a subcommand — so `benchmark doctor -o json`
    // silently gets consumed by the PARENT's `-o` and this subcommand never
    // sees it (verified: parent.opts().output ends up 'json', this
    // subcommand's options.output stays its own default). A boolean flag
    // with a name that collides with nothing on `benchmark` sidesteps the
    // whole class of bug (and there are only two output shapes, so a
    // string enum was unnecessary anyway).
    .option('--json', 'Output as JSON instead of the human-readable report', false)
    .addHelpText('after', '\n  Dry-run by default. Nothing is changed without --apply.\n')
    .action(async (options: { apply?: boolean; migrateImages?: boolean; json?: boolean; dryRun?: boolean }) => {
      // Validate mutually exclusive flags
      if (options.dryRun && options.apply) {
        console.error(chalk.red('\n  Error: --dry-run and --apply are mutually exclusive.'));
        console.error(chalk.gray('  Dry-run is the default. Use --apply to execute changes.\n'));
        process.exit(1);
      }
      const config = await loadConfig();
      // For dry-run diagnostic (no --apply, no --migrate-images), safely reuse
      // foreign servers in read-only mode. With mutating flags, keep strict guard.
      const isReadOnly = !options.apply && !options.migrateImages;
      config.server.readOnly = isReadOnly;
      const serverResult: EnsureServerResult = await ensureServer(config.server);
      const cleanup = createServerCleanup(serverResult, false);

      try {
        const api = new ApiClient(serverResult.baseUrl);
        const [benchmarks, evalRuns] = await Promise.all([
          api.listBenchmarks(),
          api.listEvaluationRuns({ size: 1000 }),
        ]);
        const plan = buildDoctorPlan(benchmarks, evalRuns);
        const isJson = options.json === true;
        // Accumulated and printed once at the end so `-o json` produces a
        // single valid JSON document instead of separate top-level
        // {plan}/{result}/{migration} lines.
        const jsonOutput: { plan: DoctorPlan; result?: unknown; migration?: unknown } = { plan };

        if (!isJson) {
          printPlan(plan);
        }

        if (options.apply) {
          const result = await applyDoctorPlan(api, plan);
          if (isJson) {
            jsonOutput.result = result;
          } else {
            console.log(chalk.green(
              `  Applied: ${result.debrisDeleted} debris deleted, ${result.husksDeleted} husks merged+deleted, ` +
              `${result.runsRepointed} runs re-pointed, ${result.embeddedRunsMerged} embedded runs merged.`
            ));
            for (const err of result.errors) console.log(chalk.red(`  ! ${err}`));
            console.log();
          }
        } else if (!isJson && (plan.debrisDeletions.length > 0 || plan.contentDupGroups.length > 0)) {
          console.log(chalk.gray('  Dry-run only. Re-run with --apply to execute.\n'));
        }

        if (options.migrateImages) {
          const migration = await migrateBenchmarksToImages(api, serverResult.baseUrl);
          if (isJson) {
            jsonOutput.migration = migration;
          } else {
            console.log(chalk.bold('  Image migration:'));
            for (const m of migration.migrated) {
              console.log(chalk.green(`    ✓ ${m.name} → ${m.digest.slice(0, 12)}`));
            }
            for (const s of migration.skipped) {
              console.log(chalk.gray(`    - ${s.name}: skipped (${s.reason})`));
            }
            for (const err of migration.errors) console.log(chalk.red(`    ! ${err}`));
            console.log();
          }
        }

        if (isJson) {
          console.log(JSON.stringify(jsonOutput, null, 2));
        }
      } catch (error: any) {
        console.error(chalk.red(`\n  Error: ${error.message}`));
        process.exit(1);
      } finally {
        cleanup();
      }
    });
}
