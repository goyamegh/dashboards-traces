/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the stateless coding-agents insights engine
 * (server/services/codingAgents/insights.ts::generateInsights). Pure
 * function — no mocking needed. Each test isolates one insight rule by
 * supplying only the inputs that should trigger it, and asserts the exact
 * shape/copy of the generated Insight, plus the final priority sort +
 * 8-item cap.
 */

import { generateInsights } from '@/server/services/codingAgents/insights';
import type { AgentStats, EfficiencyAnalytics, AdvancedAnalytics } from '@/server/services/codingAgents/types';

function agentStat(overrides: Partial<AgentStats> = {}): AgentStats {
  return {
    agent: 'claude-code',
    totalSessions: 0,
    totalCost: 0,
    totalCacheSavings: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalToolCalls: 0,
    totalToolErrors: 0,
    toolSuccessRate: 1,
    completedSessions: 0,
    costPerCompletion: 0,
    activeDays: 0,
    avgSessionMinutes: 0,
    dailyActivity: [],
    ...overrides,
  };
}

function efficiencyAgent(overrides: Partial<EfficiencyAnalytics['agents'][number]> = {}) {
  return {
    agent: 'claude-code' as const,
    toolSuccessRate: 1,
    completedSessions: 0,
    totalSessions: 0,
    completionRate: 1,
    costPerCompletion: 0,
    totalToolErrors: 0,
    totalToolCalls: 0,
    ...overrides,
  };
}

function efficiency(overrides: Partial<EfficiencyAnalytics> = {}): EfficiencyAnalytics {
  return {
    agents: [],
    combined: { toolSuccessRate: 1, completionRate: 1, avgCostPerCompletion: 0 },
    ...overrides,
  };
}

describe('generateInsights', () => {
  it('returns an empty array for empty/neutral inputs', () => {
    expect(generateInsights([], efficiency())).toEqual([]);
  });

  it('warns about wasted cost on abandoned sessions when thresholds are met', () => {
    const stats = [agentStat({ totalSessions: 20 })];
    const insights = generateInsights(stats, efficiency(), 5.5, 3);
    expect(insights.some(i => i.type === 'warning' && i.title.includes('abandoned sessions'))).toBe(true);
    const insight = insights.find(i => i.title.includes('abandoned sessions'))!;
    expect(insight.title).toContain('$5.50');
    expect(insight.description).toContain('15%'); // 3/20
    expect(insight.linkTab).toBe('sessions');
  });

  it('does not warn about wasted cost below the $0.50/2-session thresholds', () => {
    const insights = generateInsights([agentStat()], efficiency(), 0.2, 1);
    expect(insights.some(i => i.title.includes('abandoned sessions'))).toBe(false);
  });

  it('warns about low tool success rate per agent (>=10 calls, <90%)', () => {
    const eff = efficiency({ agents: [efficiencyAgent({ agent: 'kiro', totalToolCalls: 20, totalToolErrors: 5, toolSuccessRate: 0.75 })] });
    const insights = generateInsights([], eff);
    const insight = insights.find(i => i.title.includes('Kiro tool success rate'));
    expect(insight).toBeDefined();
    expect(insight!.title).toContain('75%');
    expect(insight!.description).toBe('5 of 20 tool calls are failing. Check which tools error most in the Tools tab.');
    expect(insight!.agent).toBe('kiro');
    expect(insight!.linkTab).toBe('tools');
  });

  it('does not warn about tool success rate under 10 calls', () => {
    const eff = efficiency({ agents: [efficiencyAgent({ totalToolCalls: 5, toolSuccessRate: 0.2 })] });
    expect(generateInsights([], eff).some(i => i.title.includes('tool success rate'))).toBe(false);
  });

  it('warns about low session completion rate (>=5 sessions, <60%)', () => {
    const eff = efficiency({ agents: [efficiencyAgent({ agent: 'codex', totalSessions: 10, completedSessions: 4, completionRate: 0.4 })] });
    const insight = generateInsights([], eff).find(i => i.title.includes('Codex CLI session completion rate'));
    expect(insight).toBeDefined();
    expect(insight!.description).toBe('Only 4 of 10 sessions completed. Consider breaking complex tasks into smaller prompts.');
  });

  it('tips a cost comparison when the priciest agent costs 2x+ the cheapest (both with 3+ completions)', () => {
    const eff = efficiency({
      agents: [
        efficiencyAgent({ agent: 'kiro', costPerCompletion: 0.10, completedSessions: 5 }),
        efficiencyAgent({ agent: 'claude-code', costPerCompletion: 0.50, completedSessions: 4 }),
      ],
    });
    const insight = generateInsights([], eff).find(i => i.type === 'tip' && i.title.includes('costs'));
    expect(insight).toBeDefined();
    expect(insight!.title).toContain('Claude Code costs $0.50/completion vs $0.10 for Kiro');
    expect(insight!.linkTab).toBe('costs');
  });

  it('does not tip cost comparison when fewer than 2 agents qualify', () => {
    const eff = efficiency({ agents: [efficiencyAgent({ costPerCompletion: 0.5, completedSessions: 5 })] });
    expect(generateInsights([], eff).some(i => i.title.includes('costs'))).toBe(false);
  });

  it('tips about the most-used agent having low completion, unless already warned', () => {
    const eff = efficiency({ agents: [efficiencyAgent({ agent: 'codex', totalSessions: 8, completionRate: 0.65 })] });
    const insight = generateInsights([], eff).find(i => i.title.includes('use Codex CLI most'));
    expect(insight).toBeDefined();
    expect(insight!.type).toBe('tip');
  });

  it('suppresses the most-used-agent tip when the completion-rate warning already fired for it', () => {
    // totalSessions>=5 & completionRate<0.60 triggers BOTH the warning and would
    // trigger the tip, but the tip is deduped against an existing sessions warning.
    const eff = efficiency({ agents: [efficiencyAgent({ agent: 'codex', totalSessions: 8, completedSessions: 2, completionRate: 0.25 })] });
    const insights = generateInsights([], eff);
    expect(insights.filter(i => i.agent === 'codex' && i.linkTab === 'sessions')).toHaveLength(1);
    expect(insights[0].type).toBe('warning');
  });

  it('tips about low cache utilisation for Claude Code with heavy input and low cache hit rate', () => {
    const stats = [agentStat({
      agent: 'claude-code', totalSessions: 6, totalInputTokens: 200_000, totalCacheSavings: 0.05, totalCost: 10,
    })];
    const insight = generateInsights(stats, efficiency()).find(i => i.title === 'Low cache utilisation in Claude Code');
    expect(insight).toBeDefined();
    expect(insight!.type).toBe('tip');
    expect(insight!.agent).toBe('claude-code');
  });

  it('does not tip cache utilisation for a non-claude-code agent or under the token threshold', () => {
    const stats = [agentStat({ agent: 'kiro', totalSessions: 6, totalInputTokens: 200_000 })];
    expect(generateInsights(stats, efficiency()).some(i => i.title.includes('cache utilisation'))).toBe(false);
  });

  it('surfaces cache savings as an info insight when savings exceed $1', () => {
    const stats = [agentStat({ agent: 'kiro', totalCacheSavings: 2.5 })];
    const insight = generateInsights(stats, efficiency()).find(i => i.title.includes('saved'));
    expect(insight).toBeDefined();
    expect(insight!.type).toBe('info');
    expect(insight!.title).toContain('$2.50');
  });

  it('reports multi-agent usage as an info insight when 2+ agents are active', () => {
    const stats = [agentStat({ agent: 'kiro', totalSessions: 3 }), agentStat({ agent: 'codex', totalSessions: 1 })];
    const insight = generateInsights(stats, efficiency()).find(i => i.title.includes('agents detected'));
    expect(insight).toBeDefined();
    expect(insight!.title).toBe('2 agents detected: Kiro, Codex CLI');
    expect(insight!.linkTab).toBe('efficiency');
  });

  it('reports high overall tool success rate as a success insight', () => {
    const eff = efficiency({
      agents: [efficiencyAgent({ totalToolCalls: 25 })],
      combined: { toolSuccessRate: 0.97, completionRate: 0, avgCostPerCompletion: 0 },
    });
    const insight = generateInsights([], eff).find(i => i.title.includes('Overall tool success rate'));
    expect(insight).toBeDefined();
    expect(insight!.type).toBe('success');
  });

  it('reports high session completion rate as a success insight', () => {
    const stats = [agentStat({ totalSessions: 15 })];
    const eff = efficiency({ combined: { toolSuccessRate: 0, completionRate: 0.9, avgCostPerCompletion: 0 } });
    const insight = generateInsights(stats, eff).find(i => i.title.includes('session completion rate'));
    expect(insight).toBeDefined();
    expect(insight!.type).toBe('success');
  });

  describe('advanced insights (Phase 3)', () => {
    function advanced(overrides: Partial<AdvancedAnalytics> = {}): AdvancedAnalytics {
      return {
        mcp: { servers: [], total_mcp_calls: 0, total_mcp_errors: 0 },
        hourly_effectiveness: [],
        duration_distribution: [],
        conversation_depth: { avg_depth: 0, high_backforth_sessions: 0, high_backforth_completion_rate: 0, low_backforth_completion_rate: 0, depth_buckets: [] },
        ...overrides,
      };
    }

    it('warns about a high-error MCP server (>=5 calls, <85% success)', () => {
      const adv = advanced({
        mcp: {
          servers: [{ server: 'filesystem', agent: 'claude-code', total_calls: 10, error_count: 3, success_rate: 0.7, tools: [], session_count: 4 }],
          total_mcp_calls: 10, total_mcp_errors: 3,
        },
      });
      const insight = generateInsights([], efficiency(), undefined, undefined, adv).find(i => i.title.includes('filesystem'));
      expect(insight).toBeDefined();
      expect(insight!.type).toBe('warning');
      expect(insight!.title).toContain('30%'); // 1 - 0.7
      expect(insight!.description).toBe('3 errors across 10 calls. Check server configuration.');
    });

    it('tips about a peak-productivity hour gap greater than 20 points', () => {
      const adv = advanced({
        hourly_effectiveness: [
          { hour: 9, total_sessions: 5, completed_sessions: 5, completion_rate: 0.95, avg_cost: 1 },
          { hour: 22, total_sessions: 4, completed_sessions: 1, completion_rate: 0.25, avg_cost: 1 },
        ],
      });
      const insight = generateInsights([], efficiency(), undefined, undefined, adv).find(i => i.title.includes('9:00'));
      expect(insight).toBeDefined();
      expect(insight!.title).toBe('Sessions at 9:00 complete 95% vs 25% at 22:00');
    });

    it('ignores hourly buckets with fewer than 3 sessions', () => {
      const adv = advanced({
        hourly_effectiveness: [
          { hour: 9, total_sessions: 2, completed_sessions: 2, completion_rate: 1, avg_cost: 1 },
        ],
      });
      expect(generateInsights([], efficiency(), undefined, undefined, adv).some(i => i.linkTab === 'activity')).toBe(false);
    });

    it('tips about conversation depth when high-backforth sessions complete much worse', () => {
      const adv = advanced({
        conversation_depth: { avg_depth: 4, high_backforth_sessions: 5, high_backforth_completion_rate: 0.3, low_backforth_completion_rate: 0.8, depth_buckets: [] },
      });
      const insight = generateInsights([], efficiency(), undefined, undefined, adv).find(i => i.title.includes('5+ turns'));
      expect(insight).toBeDefined();
      expect(insight!.title).toContain('30%');
      expect(insight!.description).toContain('80%');
    });

    it('tips about long sessions costing 3x+ more with a lower completion rate than short sessions', () => {
      const adv = advanced({
        duration_distribution: [
          { label: '30m+', min_minutes: 30, max_minutes: 999, session_count: 4, completed_count: 1, completion_rate: 0.25, avg_cost: 3, total_cost: 12 },
          { label: '<15m', min_minutes: 0, max_minutes: 15, session_count: 4, completed_count: 4, completion_rate: 1, avg_cost: 0.5, total_cost: 2 },
        ],
      });
      const insight = generateInsights([], efficiency(), undefined, undefined, adv).find(i => i.title.includes('>30m'));
      expect(insight).toBeDefined();
      expect(insight!.title).toContain('$3.00');
      expect(insight!.description).toContain('$0.50');
    });

    it('skips duration-distribution insight when there are no qualifying long or short buckets', () => {
      const adv = advanced({
        duration_distribution: [
          { label: '15-30m', min_minutes: 15, max_minutes: 30, session_count: 4, completed_count: 4, completion_rate: 1, avg_cost: 1, total_cost: 4 },
        ],
      });
      expect(generateInsights([], efficiency(), undefined, undefined, adv).some(i => i.title.includes('>30m'))).toBe(false);
    });

    it('omits advanced insights entirely when `advanced` is not provided', () => {
      const insights = generateInsights([], efficiency());
      expect(insights.every(i => !i.title.includes('MCP server'))).toBe(true);
    });
  });

  it('sorts by priority (warning < tip < info < success) and caps the result at 8', () => {
    // Build enough distinct agents/conditions to generate >8 insights, spanning all 4 types.
    const stats: AgentStats[] = [
      agentStat({ agent: 'claude-code', totalSessions: 20, totalCacheSavings: 5 }),
      agentStat({ agent: 'kiro', totalSessions: 10, totalCacheSavings: 3 }),
      agentStat({ agent: 'codex', totalSessions: 15 }),
    ];
    const eff = efficiency({
      agents: [
        efficiencyAgent({ agent: 'claude-code', totalToolCalls: 30, totalToolErrors: 10, toolSuccessRate: 0.6, totalSessions: 20, completedSessions: 5, completionRate: 0.25, costPerCompletion: 1 }),
        efficiencyAgent({ agent: 'kiro', totalToolCalls: 30, totalToolErrors: 12, toolSuccessRate: 0.5, totalSessions: 10, completedSessions: 3, completionRate: 0.3, costPerCompletion: 0.1 }),
        efficiencyAgent({ agent: 'codex', totalToolCalls: 30, totalToolErrors: 1, toolSuccessRate: 0.97, totalSessions: 15, completedSessions: 14, completionRate: 0.93 }),
      ],
      combined: { toolSuccessRate: 0.97, completionRate: 0.9, avgCostPerCompletion: 0.2 },
    });

    const insights = generateInsights(stats, eff, 5, 4);
    expect(insights.length).toBeLessThanOrEqual(8);

    const priority: Record<string, number> = { warning: 0, tip: 1, info: 2, success: 3 };
    for (let i = 1; i < insights.length; i++) {
      expect(priority[insights[i].type]).toBeGreaterThanOrEqual(priority[insights[i - 1].type]);
    }
    expect(insights.some(i => i.type === 'warning')).toBe(true);
  });
});
