/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Presentation of a run's `agentFailureSummary` (see
 * `services/evaluation/agentReachability.ts` → `EndpointCircuitBreaker.summary()`).
 * Two shapes exist:
 *   - `Agent endpoint unreachable — N consecutive … (CODE, host); …` when the
 *     run's endpoint circuit breaker opened (connection failures and/or
 *     empty responses);
 *   - `N cases returned an empty response (no steps, no answer, no results) —
 *     not judged` when cases came back empty but the breaker never tripped.
 * The runs-list badge and the run-page banners word themselves accordingly.
 */

export interface AgentFailureSummaryPresentation {
  /** The endpoint breaker opened during the run. */
  unreachable: boolean;
  /** Short badge label for the runs list. */
  badge: string;
  /** Remedy sentence appended to the banner. */
  remedy: string;
}

export function presentAgentFailureSummary(summary: string): AgentFailureSummaryPresentation {
  const unreachable = summary.startsWith('Agent endpoint unreachable');
  return unreachable
    ? {
        unreachable,
        badge: 'Agent unreachable',
        remedy: 'check the agent endpoint and re-run; nothing was judged.',
      }
    : {
        unreachable,
        badge: 'Empty responses',
        remedy: 'the agent answered with nothing to judge on these cases; check the agent and re-run them.',
      };
}
