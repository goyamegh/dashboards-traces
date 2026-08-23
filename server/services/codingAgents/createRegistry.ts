/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Factory for the coding agent registry singleton.
 * Separated from registry.ts to avoid circular imports with remoteAggregator.ts.
 *
 * Checks the feature toggle before creating a real registry. When disabled,
 * exports a lightweight stub that returns empty data for all methods.
 */

import { CodingAgentRegistry } from './registry';
import { RemoteAggregator } from './remoteAggregator';
import { getRemoteServers } from './remoteConfig';
import { readEnv } from '@/lib/envCompat';
import { readLayeredState } from '@/lib/config/statePaths';

/**
 * Check whether Coding Agent Analytics is enabled.
 * Disabled when:
 *   - env AH_DISABLE_CODING_ANALYTICS=true (legacy: AGENT_HEALTH_DISABLE_CODING_ANALYTICS)
 *   - config codingAgentAnalytics === false
 */
function isCodingAnalyticsEnabled(): boolean {
  if (readEnv('AH_DISABLE_CODING_ANALYTICS', 'AGENT_HEALTH_DISABLE_CODING_ANALYTICS') === 'true') return false;

  // Check runtime state file (same source remoteConfig reads). In code-first
  // mode this is {} — the .ts's codingAgentAnalytics is honored via loadConfig.
  try {
    if (readLayeredState().codingAgentAnalytics === false) return false;
  } catch { /* state not available — default enabled */ }

  return true;
}

export const codingAnalyticsEnabled = isCodingAnalyticsEnabled();

function createRegistry(): CodingAgentRegistry | null {
  if (!codingAnalyticsEnabled) {
    console.log('[CodingAgents] Feature disabled via toggle');
    return null;
  }

  const remotes = getRemoteServers();
  if (remotes.length > 0) {
    console.log(`[CodingAgents] Remote aggregation enabled: ${remotes.map(r => r.name).join(', ')}`);
    return new RemoteAggregator(remotes);
  }
  return new CodingAgentRegistry();
}

export const codingAgentRegistry = createRegistry();
