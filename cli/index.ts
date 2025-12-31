#!/usr/bin/env node

/**
 * Agent Health CLI
 * Main entry point for the NPX command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

// Import command handlers
import { runDemoMode } from './commands/demo.js';
import { runConfigureMode } from './commands/configure.js';

// Re-export types for use by commands
export type { CLIConfig } from './types.js';

// Get package.json for version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '..', 'package.json');

let version = '0.1.0';
try {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  version = packageJson.version;
} catch {
  // Use default version if package.json not found
}

// Create the CLI program
const program = new Command();

program
  .name('agent-health')
  .description('Agent Health Evaluation Framework - Evaluate and monitor AI agent performance')
  .version(version);

// CLI options
program
  .option('-d, --demo', 'Run in demo mode with sample data (default)')
  .option('-c, --configure', 'Run interactive configuration wizard')
  .option('-p, --port <number>', 'Server port', '4001')
  .option('--no-browser', 'Do not open browser automatically');

program.action(async (options) => {
  console.log(chalk.cyan.bold('\n  Agent Health - AI Agent Evaluation Framework\n'));

  const port = parseInt(options.port, 10);

  // Determine mode
  if (options.configure) {
    await runConfigureMode({ port, noBrowser: !options.browser });
  } else {
    // Default: demo mode (sample data + mock agent/judge)
    await runDemoMode({ port, noBrowser: !options.browser });
  }
});

// Parse command line arguments
program.parse();
