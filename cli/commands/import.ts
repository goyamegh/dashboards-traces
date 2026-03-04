/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Import Command
 * Import test cases from a JSON file with name-based dedup.
 * Optionally create a benchmark from the imported test cases.
 *
 * Architecture: CLI → Server HTTP API → Storage
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig, DEFAULT_SERVER_CONFIG } from '@/lib/config/index.js';
import { ensureServer, createServerCleanup, isServerRunning } from '@/cli/utils/serverLifecycle.js';
import { ApiClient } from '@/cli/utils/apiClient.js';
import { loadAndValidateTestCasesFile } from '@/cli/utils/testCaseFile.js';

interface ImportOptions {
  file: string;
  benchmark?: string;
  verbose?: boolean;
  stopServer?: boolean;
}

/**
 * Create the import command
 */
export function createImportCommand(): Command {
  const command = new Command('import')
    .description('Import test cases from a JSON file (with name-based dedup)')
    .requiredOption('-f, --file <path>', 'JSON file of test cases to import')
    .option('-b, --benchmark <name>', 'Also create a benchmark from the imported test cases')
    .option('-v, --verbose', 'Show per-test-case status')
    .option('--stop-server', 'Stop the server after import completes')
    .action(async (options: ImportOptions) => {
      console.log(chalk.bold('\nAgent Health - Import Test Cases\n'));

      // Load config
      const config = await loadConfig();
      const serverConfig = { ...DEFAULT_SERVER_CONFIG, ...config.server };
      const isCI = !!process.env.CI;

      const serverWasRunning = await isServerRunning(serverConfig.port);
      const shouldStopServer = isCI || options.stopServer;

      // Ensure server is running
      const connectSpinner = ora('Connecting to server...').start();
      let cleanup: () => void;

      try {
        const serverResult = await ensureServer(serverConfig);
        cleanup = createServerCleanup(serverResult, shouldStopServer);

        if (serverResult.wasStarted) {
          connectSpinner.succeed(`Started server on port ${serverConfig.port}`);
        } else {
          connectSpinner.succeed(`Connected to existing server on port ${serverConfig.port}`);
        }

        const api = new ApiClient(serverResult.baseUrl);

        try {
          // Load and validate file
          const loadSpinner = ora(`Loading test cases from ${options.file}...`).start();
          let validatedTestCases;
          try {
            validatedTestCases = loadAndValidateTestCasesFile(options.file);
            loadSpinner.succeed(`Validated ${validatedTestCases.length} test cases from file`);
          } catch (error) {
            loadSpinner.fail(`File validation failed: ${error instanceof Error ? error.message : error}`);
            process.exit(1);
          }

          // Import with dedup
          const importSpinner = ora('Importing test cases (with dedup)...').start();
          const importResult = await api.importTestCases(validatedTestCases);

          const summary: string[] = [];
          if (importResult.created > 0) summary.push(`${importResult.created} created`);
          if (importResult.reused > 0) summary.push(`${importResult.reused} reused`);
          if (importResult.updated > 0) summary.push(`${importResult.updated} updated`);
          importSpinner.succeed(
            `Imported ${importResult.testCases.length} test cases (${summary.join(', ')})`
          );

          // Verbose: show per-test-case status
          if (options.verbose) {
            console.log('');
            for (const tc of importResult.testCases) {
              const icon = tc.status === 'created' ? chalk.green('+')
                : tc.status === 'updated' ? chalk.yellow('~')
                : chalk.gray('=');
              console.log(`  ${icon} ${tc.name} ${chalk.gray(`(${tc.id})`)} [${tc.status}]`);
            }
          }

          // Optionally create benchmark
          if (options.benchmark) {
            const benchSpinner = ora('Creating benchmark...').start();
            const benchmark = await api.createBenchmark({
              name: options.benchmark,
              description: `Imported from ${options.file}`,
              testCaseIds: importResult.testCases.map(tc => tc.id),
            });
            benchSpinner.succeed(`Created benchmark: ${benchmark.name} (${benchmark.id})`);
            console.log(chalk.gray(`  ${benchmark.testCaseIds.length} test cases`));
            console.log(chalk.gray(`  View: ${serverResult.baseUrl}/benchmarks/${benchmark.id}`));
          }

          // Print test case IDs
          console.log('');
          console.log(chalk.cyan('Test case IDs:'));
          for (const tc of importResult.testCases) {
            console.log(chalk.gray(`  ${tc.id}`));
          }
          console.log('');
        } finally {
          cleanup!();
        }
      } catch (error) {
        connectSpinner.fail(
          `Failed to connect to server: ${error instanceof Error ? error.message : error}`
        );
        process.exit(1);
      }
    });

  return command;
}
