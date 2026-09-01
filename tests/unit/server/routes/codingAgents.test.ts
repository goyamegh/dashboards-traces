/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const mockGetAvailableReaders = jest.fn();
const mockGetRemoteServerNames = jest.fn();
const mockGetCombinedStats = jest.fn();
const mockIsBackfilling = jest.fn();
const mockLoadedDays = jest.fn();
const mockGetAllSessions = jest.fn();
const mockGetSessionDetail = jest.fn();
const mockGetCostAnalytics = jest.fn();
const mockGetActivityData = jest.fn();
const mockGetToolsAnalytics = jest.fn();
const mockGetEfficiencyAnalytics = jest.fn();
const mockGetProjectAnalytics = jest.fn();
const mockGetAdvancedAnalytics = jest.fn();
const mockGetFailurePatterns = jest.fn();
const mockExportData = jest.fn();
const mockGetTeamAnalytics = jest.fn();

class MockRemoteAggregator {
  getAvailableReaders(...args: any[]) {
    return mockGetAvailableReaders(...args);
  }

  getRemoteServerNames(...args: any[]) {
    return mockGetRemoteServerNames(...args);
  }

  getCombinedStats(...args: any[]) {
    return mockGetCombinedStats(...args);
  }

  isBackfilling(...args: any[]) {
    return mockIsBackfilling(...args);
  }

  loadedDays(...args: any[]) {
    return mockLoadedDays(...args);
  }

  getAllSessions(...args: any[]) {
    return mockGetAllSessions(...args);
  }

  getSessionDetail(...args: any[]) {
    return mockGetSessionDetail(...args);
  }

  getCostAnalytics(...args: any[]) {
    return mockGetCostAnalytics(...args);
  }

  getActivityData(...args: any[]) {
    return mockGetActivityData(...args);
  }

  getToolsAnalytics(...args: any[]) {
    return mockGetToolsAnalytics(...args);
  }

  getEfficiencyAnalytics(...args: any[]) {
    return mockGetEfficiencyAnalytics(...args);
  }

  getProjectAnalytics(...args: any[]) {
    return mockGetProjectAnalytics(...args);
  }

  getAdvancedAnalytics(...args: any[]) {
    return mockGetAdvancedAnalytics(...args);
  }

  getFailurePatterns(...args: any[]) {
    return mockGetFailurePatterns(...args);
  }

  exportData(...args: any[]) {
    return mockExportData(...args);
  }

  getTeamAnalytics(...args: any[]) {
    return mockGetTeamAnalytics(...args);
  }
}

const mockRegistry = new MockRemoteAggregator();

jest.mock('@/server/services/codingAgents/remoteAggregator', () => ({
  RemoteAggregator: MockRemoteAggregator,
}));

jest.mock('@/server/services/codingAgents', () => ({
  codingAgentRegistry: mockRegistry,
}));

import express, { Application } from 'express';
const request = require('supertest');
import codingAgentsRouter from '@/server/routes/codingAgents';

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(codingAgentsRouter);
  return app;
}

describe('Coding agents router', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAvailableReaders.mockResolvedValue([
      { agentName: 'claude-code', displayName: 'Claude Code' },
      { agentName: 'codex', displayName: 'Codex' },
    ]);
    mockGetRemoteServerNames.mockReturnValue(['shared-dev', 'shared-prod']);
    mockGetCombinedStats.mockResolvedValue({ totalSessions: 12, totalCost: 4.2 });
    mockIsBackfilling.mockReturnValue(true);
    mockLoadedDays.mockReturnValue(250000);
    mockGetAllSessions.mockResolvedValue([
      {
        agent: 'claude-code',
        session_id: 's1',
        session_completed: true,
        project_path: '/workspace/alpha',
        first_prompt: 'Fix login bug',
      },
      {
        agent: 'codex',
        session_id: 's2',
        session_completed: false,
        project_path: '/workspace/beta',
        first_prompt: 'Write tests for router',
      },
      {
        agent: 'codex',
        session_id: 's3',
        session_completed: true,
        project_path: '/workspace/gamma',
        first_prompt: 'Refactor "quoted" prompt',
      },
    ]);
    mockGetSessionDetail.mockResolvedValue({ session_id: 's1', turns: [{ role: 'user', content: 'hello' }] });
    mockGetCostAnalytics.mockResolvedValue({ totalCost: 3.14 });
    mockGetActivityData.mockResolvedValue({ streak: 7 });
    mockGetToolsAnalytics.mockResolvedValue({ topTools: ['grep'] });
    mockGetEfficiencyAnalytics.mockResolvedValue({ byAgent: [{ name: 'claude-code' }] });
    mockGetProjectAnalytics.mockResolvedValue([{ project: 'alpha' }]);
    mockGetAdvancedAnalytics.mockResolvedValue({ depth: { average: 3 } });
    mockGetFailurePatterns.mockResolvedValue([{ tool: 'bash', failures: 2 }]);
    mockExportData.mockResolvedValue({
      sessions: [
        {
          agent: 'codex',
          session_id: 's1',
          project_path: '/workspace/alpha',
          start_time: '2024-05-01T00:00:00.000Z',
          duration_minutes: 12.345,
          user_message_count: 3,
          assistant_message_count: 5,
          input_tokens: 101,
          output_tokens: 202,
          estimated_cost: 0.45678,
          session_completed: true,
          first_prompt: 'Quoted "prompt" here',
        },
      ],
      summary: { totalSessions: 1 },
    });
    mockGetTeamAnalytics.mockResolvedValue({ users: [{ name: 'dev1', sessions: 8 }] });
    app = makeApp();
  });

  describe('GET /api/coding-agents/available', () => {
    it('returns available readers and remote server names', async () => {
      const res = await request(app).get('/api/coding-agents/available');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        agents: [
          { name: 'claude-code', displayName: 'Claude Code' },
          { name: 'codex', displayName: 'Codex' },
        ],
        remoteServers: ['shared-dev', 'shared-prod'],
      });
    });

    it('returns 500 when reader discovery fails', async () => {
      mockGetAvailableReaders.mockRejectedValueOnce(new Error('discovery failed'));

      const res = await request(app).get('/api/coding-agents/available');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'discovery failed' });
    });
  });

  describe('GET /api/coding-agents/stats', () => {
    it('returns combined stats with warming state and loaded day cap', async () => {
      const res = await request(app).get('/api/coding-agents/stats?from=2024-01-01&to=2024-01-31');

      expect(res.status).toBe(200);
      expect(mockGetCombinedStats).toHaveBeenCalledWith({ from: '2024-01-01', to: '2024-01-31' });
      expect(res.body).toEqual({
        totalSessions: 12,
        totalCost: 4.2,
        warming: true,
        loadedDays: 99999,
      });
    });

    it('returns 500 when combined stats lookup fails', async () => {
      mockGetCombinedStats.mockRejectedValueOnce(new Error('stats failed'));

      const res = await request(app).get('/api/coding-agents/stats');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'stats failed' });
    });
  });

  describe('GET /api/coding-agents/sessions', () => {
    it('filters and paginates sessions', async () => {
      const res = await request(app).get(
        '/api/coding-agents/sessions?agent=codex&search=quoted&completed=true&project=gamma&offset=0&limit=1&from=2024-06-01'
      );

      expect(res.status).toBe(200);
      expect(mockGetAllSessions).toHaveBeenCalledWith({ from: '2024-06-01', to: undefined });
      expect(res.body).toEqual({
        sessions: [
          {
            agent: 'codex',
            session_id: 's3',
            session_completed: true,
            project_path: '/workspace/gamma',
            first_prompt: 'Refactor "quoted" prompt',
          },
        ],
        total: 1,
        offset: 0,
        limit: 1,
      });
    });

    it('supports completed=false and default pagination', async () => {
      const res = await request(app).get('/api/coding-agents/sessions?completed=false');

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.offset).toBe(0);
      expect(res.body.limit).toBe(100);
      expect(res.body.sessions[0].session_id).toBe('s2');
    });

    it('returns 500 when session listing fails', async () => {
      mockGetAllSessions.mockRejectedValueOnce(new Error('sessions failed'));

      const res = await request(app).get('/api/coding-agents/sessions');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'sessions failed' });
    });
  });

  describe('GET /api/coding-agents/sessions/:agent/:sessionId', () => {
    it('returns session detail and forwards the optional server name', async () => {
      const res = await request(app).get('/api/coding-agents/sessions/codex/s1?server=shared-dev');

      expect(res.status).toBe(200);
      expect(mockGetSessionDetail).toHaveBeenCalledWith('codex', 's1', 'shared-dev');
      expect(res.body).toEqual({ session_id: 's1', turns: [{ role: 'user', content: 'hello' }] });
    });

    it('returns 404 when the session detail is missing', async () => {
      mockGetSessionDetail.mockResolvedValueOnce(null);

      const res = await request(app).get('/api/coding-agents/sessions/codex/missing');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Session not found' });
    });

    it('returns 500 when session detail lookup fails', async () => {
      mockGetSessionDetail.mockRejectedValueOnce(new Error('detail failed'));

      const res = await request(app).get('/api/coding-agents/sessions/codex/s1');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'detail failed' });
    });
  });

  describe('simple analytics endpoints', () => {
    it.each([
      ['/api/coding-agents/costs?from=2024-01-01', mockGetCostAnalytics, { totalCost: 3.14 }],
      ['/api/coding-agents/activity?to=2024-02-01', mockGetActivityData, { streak: 7 }],
      ['/api/coding-agents/tools', mockGetToolsAnalytics, { topTools: ['grep'] }],
      ['/api/coding-agents/efficiency', mockGetEfficiencyAnalytics, { byAgent: [{ name: 'claude-code' }] }],
      ['/api/coding-agents/advanced', mockGetAdvancedAnalytics, { depth: { average: 3 } }],
      ['/api/coding-agents/team', mockGetTeamAnalytics, { users: [{ name: 'dev1', sessions: 8 }] }],
    ])('returns success payload for %s', async (path, mockFn, expectedBody) => {
      const res = await request(app).get(path as string);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(expectedBody);
      expect(mockFn).toHaveBeenCalled();
    });

    it.each([
      ['/api/coding-agents/costs', mockGetCostAnalytics],
      ['/api/coding-agents/activity', mockGetActivityData],
      ['/api/coding-agents/tools', mockGetToolsAnalytics],
      ['/api/coding-agents/efficiency', mockGetEfficiencyAnalytics],
      ['/api/coding-agents/advanced', mockGetAdvancedAnalytics],
      ['/api/coding-agents/team', mockGetTeamAnalytics],
    ])('returns 500 for %s when the registry throws', async (path, mockFn) => {
      mockFn.mockRejectedValueOnce(new Error('analytics failed'));

      const res = await request(app).get(path as string);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'analytics failed' });
    });
  });

  describe('GET /api/coding-agents/projects', () => {
    it('wraps project analytics in a projects object', async () => {
      const res = await request(app).get('/api/coding-agents/projects');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ projects: [{ project: 'alpha' }] });
    });

    it('returns 500 when project analytics fails', async () => {
      mockGetProjectAnalytics.mockRejectedValueOnce(new Error('projects failed'));

      const res = await request(app).get('/api/coding-agents/projects');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'projects failed' });
    });
  });

  describe('GET /api/coding-agents/failure-patterns', () => {
    it('wraps failure analytics in a patterns object', async () => {
      const res = await request(app).get('/api/coding-agents/failure-patterns');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ patterns: [{ tool: 'bash', failures: 2 }] });
    });

    it('returns 500 when failure analytics fails', async () => {
      mockGetFailurePatterns.mockRejectedValueOnce(new Error('patterns failed'));

      const res = await request(app).get('/api/coding-agents/failure-patterns');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'patterns failed' });
    });
  });

  describe('GET /api/coding-agents/export', () => {
    it('returns export data as JSON by default', async () => {
      const res = await request(app).get('/api/coding-agents/export?to=2024-07-01');

      expect(res.status).toBe(200);
      expect(mockExportData).toHaveBeenCalledWith({ from: undefined, to: '2024-07-01' });
      expect(res.body).toEqual({
        sessions: [
          {
            agent: 'codex',
            session_id: 's1',
            project_path: '/workspace/alpha',
            start_time: '2024-05-01T00:00:00.000Z',
            duration_minutes: 12.345,
            user_message_count: 3,
            assistant_message_count: 5,
            input_tokens: 101,
            output_tokens: 202,
            estimated_cost: 0.45678,
            session_completed: true,
            first_prompt: 'Quoted "prompt" here',
          },
        ],
        summary: { totalSessions: 1 },
      });
    });

    it('returns CSV when format=csv', async () => {
      const res = await request(app).get('/api/coding-agents/export?format=csv');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe('attachment; filename=coding-agents-export.csv');
      expect(res.text).toContain('agent,session_id,project_path,start_time,duration_minutes');
      expect(res.text).toContain('codex,s1,"/workspace/alpha",2024-05-01T00:00:00.000Z,12.3,3,5,101,202,0.4568,true,"Quoted ""prompt"" here"');
    });

    it('returns 500 when export fails', async () => {
      mockExportData.mockRejectedValueOnce(new Error('export failed'));

      const res = await request(app).get('/api/coding-agents/export');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'export failed' });
    });
  });
});
