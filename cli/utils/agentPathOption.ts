/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Apply --agent-path / AH_AGENT_PATH from a CLI subcommand.
 *
 * Sets process.env.AH_AGENT_PATH to the resolved absolute path so that
 * any server we subsequently spawn inherits it (the spawn site uses
 * `env: { ...process.env }`).
 *
 * Safe to call when the option is absent — it's a no-op in that case.
 *
 * NOTE: when the CLI subcommand attaches to an *already-running* server
 * (via cli/utils/serverLifecycle.ts), the running server's environment is
 * not retroactively updated. Users running long-lived servers should set
 * AH_AGENT_PATH before starting the server, not on each subcommand.
 */

import { resolve } from 'path';
import chalk from 'chalk';

export interface AgentPathOptions {
  agentPath?: string;
}

export function applyAgentPathOption(options: AgentPathOptions): void {
  if (!options.agentPath) return;
  const abs = resolve(options.agentPath);
  process.env.AH_AGENT_PATH = abs;
  console.log(chalk.gray(`Agent path: ${abs}`));
}
