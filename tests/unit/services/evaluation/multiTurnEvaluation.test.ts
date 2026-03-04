/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects
import type { AgentConfig, TestCase, TrajectoryStep } from '@/types';

// Mock dependencies
jest.mock('@/services/agent', () => ({
  AGUIToTrajectoryConverter: jest.fn().mockImplementation(() => ({
    processEvent: jest.fn().mockReturnValue([]),
    getRunId: jest.fn().mockReturnValue('mock-run-id'),
  })),
  consumeSSEStream: jest.fn().mockResolvedValue(undefined),
  buildAgentPayload: jest.fn().mockReturnValue({ prompt: 'test' }),
}));

jest.mock('@/services/agent/payloadBuilder', () => ({
  buildMultiTurnPayload: jest.fn().mockReturnValue({
    threadId: 'thread-mt',
    runId: 'run-mt',
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }),
  buildAgentPayload: jest.fn().mockReturnValue({ prompt: 'test' }),
}));

jest.mock('@/services/evaluation/userSimulator', () => ({
  generateFollowUp: jest.fn(),
}));

jest.mock('@/services/evaluation/bedrockJudge', () => ({
  callBedrockJudge: jest.fn().mockResolvedValue({
    passFailStatus: 'passed',
    metrics: {
      accuracy: 85,
      faithfulness: 80,
      latency_score: 90,
      trajectory_alignment_score: 75,
    },
    llmJudgeReasoning: 'Good single-turn performance',
    improvementStrategies: [],
  }),
}));

jest.mock('@/services/evaluation/mockTrajectory', () => ({
  generateMockTrajectory: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/services/opensearch', () => ({
  openSearchClient: {
    fetchLogsForRun: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('@/lib/hooks', () => ({
  executeBeforeRequestHook: jest.fn().mockImplementation(async (_hooks, context) => context),
}));

jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-report-id'),
}));

// Mock global fetch for the multi-turn judge API call
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('Multi-Turn Evaluation', () => {
  // Import the function under test
  let runEvaluationWithConnector: any;

  const mockAgent: AgentConfig = {
    key: 'test-agent',
    name: 'Test Agent',
    endpoint: 'http://test/agent',
    models: ['test-model'],
    protocol: 'agui' as const,
    type: 'langgraph',
    useTraces: false,
  };

  const mockSingleTurnTestCase: TestCase = {
    id: 'tc-single',
    name: 'Single-turn test',
    description: 'A standard single-turn test case',
    labels: [],
    category: 'RCA',
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [],
    isPromoted: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'What is wrong with the cluster?',
    context: [],
    expectedOutcomes: ['Find root cause'],
  };

  const mockMultiTurnTestCase: TestCase = {
    id: 'tc-mt-1',
    name: 'Multi-turn test',
    description: 'A multi-turn investigation scenario',
    labels: [],
    category: 'RCA',
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [],
    isPromoted: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'What is wrong?',
    context: [],
    expectedOutcomes: ['Find root cause'],
    multiTurnScenario: {
      userMotivation: 'Investigating incident',
      acceptanceCriteria: ['Root cause found'],
      idealAnswer: 'Redis failure caused cascading timeouts',
      turnLimit: 5,
      referenceTurns: [
        { turn: 1, user: 'What is wrong?', expectedTopics: ['error'], groundTruth: 'Redis down' },
        { turn: 2, user: 'Is it Redis?', expectedTopics: ['Redis'], groundTruth: 'Yes' },
      ],
    },
  };

  const createMockConnector = (overrides = {}) => ({
    type: 'agui-streaming',
    name: 'Mock Connector',
    supportsStreaming: true,
    buildPayload: jest.fn().mockReturnValue({
      threadId: 'thread-1',
      runId: 'run-1',
      messages: [{ id: 'msg-1', role: 'user', content: 'test' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
    execute: jest.fn().mockResolvedValue({
      trajectory: [
        { id: 's1', timestamp: Date.now(), type: 'response', content: 'Agent response' },
      ],
      runId: 'run-1',
      rawEvents: [],
      metadata: { threadId: 'thread-1' },
    }),
    parseResponse: jest.fn(),
    ...overrides,
  });

  const createMockRegistry = (connector: any) => ({
    getForAgent: jest.fn().mockReturnValue(connector),
    register: jest.fn(),
    get: jest.fn(),
    getAll: jest.fn(),
    has: jest.fn(),
    getRegisteredTypes: jest.fn(),
    clear: jest.fn(),
  });

  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Re-import the module fresh for each test
    jest.resetModules();
    const module = await import('@/services/evaluation');
    runEvaluationWithConnector = module.runEvaluationWithConnector;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe('single-turn dispatch', () => {
    it('single-turn test case uses existing flow unchanged', async () => {
      const { callBedrockJudge } = require('@/services/evaluation/bedrockJudge');
      const mockConnector = createMockConnector();
      const mockRegistry = createMockRegistry(mockConnector);
      const onStepMock = jest.fn();

      const result = await runEvaluationWithConnector(
        mockAgent,
        'test-model',
        mockSingleTurnTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      // connector.execute called exactly once (no multi-turn loop)
      expect(mockConnector.execute).toHaveBeenCalledTimes(1);

      // Single-turn judge is callBedrockJudge, not fetch to /api/judge/multi-turn
      expect(callBedrockJudge).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();

      // Report should be completed with single-turn metrics
      expect(result.status).toBe('completed');
      expect(result.passFailStatus).toBe('passed');
      expect(result.multiTurnResult).toBeUndefined();
      expect(result.connectorProtocol).toBe('agui-streaming');
    });
  });

  describe('multi-turn dispatch', () => {
    it('multi-turn test case dispatches to multi-turn evaluation', async () => {
      const { generateFollowUp } = require('@/services/evaluation/userSimulator');
      const { buildMultiTurnPayload } = require('@/services/agent/payloadBuilder');
      const { callBedrockJudge } = require('@/services/evaluation/bedrockJudge');

      // Simulator generates one follow-up, then signals done
      generateFollowUp
        .mockResolvedValueOnce({ done: false, message: 'Is it Redis?' })
        .mockResolvedValueOnce({ done: true, message: 'Thanks, that answers my question.' });

      const mockConnector = createMockConnector();
      const mockRegistry = createMockRegistry(mockConnector);

      // Mock the multi-turn judge API response
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          passFailStatus: 'passed',
          weightedScore: 88,
          rootCauseScore: 90,
          remediationScore: 85,
          contextRetentionScore: 80,
          concisenessScore: 95,
          reasoning: 'Agent correctly identified Redis as the root cause.',
          improvementStrategies: [],
        }),
      });

      const onStepMock = jest.fn();

      const result = await runEvaluationWithConnector(
        mockAgent,
        'test-model',
        mockMultiTurnTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      // connector.execute called for initial turn + 1 follow-up = 2 times
      expect(mockConnector.execute).toHaveBeenCalledTimes(2);

      // generateFollowUp called to get follow-up questions
      expect(generateFollowUp).toHaveBeenCalled();

      // buildMultiTurnPayload called for the follow-up turn
      expect(buildMultiTurnPayload).toHaveBeenCalled();

      // fetch called with /api/judge/multi-turn for holistic judge
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/judge/multi-turn'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      // callBedrockJudge should NOT be called for multi-turn
      expect(callBedrockJudge).not.toHaveBeenCalled();

      // Report should contain multiTurnResult
      expect(result.status).toBe('completed');
      expect(result.passFailStatus).toBe('passed');
      expect(result.multiTurnResult).toBeDefined();
      expect(result.multiTurnResult.totalTurns).toBe(2);
      expect(result.multiTurnResult.turns).toHaveLength(2);
      expect(result.multiTurnResult.acceptanceCriteriaMet).toBe(true);
      expect(result.multiTurnResult.rootCauseScore).toBe(90);
      expect(result.multiTurnResult.remediationScore).toBe(85);
      expect(result.multiTurnResult.contextRetentionScore).toBe(80);
      expect(result.multiTurnResult.concisenessScore).toBe(95);
      expect(result.multiTurnResult.reasoning).toContain('Redis');
      expect(result.metrics.accuracy).toBe(88);
      expect(result.connectorProtocol).toBe('agui-streaming');
    });

    it('multi-turn stops when simulator signals done', async () => {
      const { generateFollowUp } = require('@/services/evaluation/userSimulator');

      // Simulator does 1 follow-up, then signals done on the second call
      generateFollowUp
        .mockResolvedValueOnce({ done: false, message: 'Can you check Redis?' })
        .mockResolvedValueOnce({ done: true, message: 'That is sufficient, thanks.' });

      const mockConnector = createMockConnector();
      const mockRegistry = createMockRegistry(mockConnector);

      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          passFailStatus: 'passed',
          weightedScore: 75,
          rootCauseScore: 80,
          remediationScore: 70,
          contextRetentionScore: 75,
          concisenessScore: 90,
          reasoning: 'Good investigation with early resolution.',
          improvementStrategies: [],
        }),
      });

      const onStepMock = jest.fn();

      const result = await runEvaluationWithConnector(
        mockAgent,
        'test-model',
        mockMultiTurnTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      // Initial turn + 1 follow-up = 2 connector.execute calls
      // The second generateFollowUp returns done=true so the loop breaks
      expect(mockConnector.execute).toHaveBeenCalledTimes(2);
      expect(generateFollowUp).toHaveBeenCalledTimes(2);

      // Result should have 2 turns (initial + 1 follow-up)
      expect(result.multiTurnResult).toBeDefined();
      expect(result.multiTurnResult.totalTurns).toBe(2);
      expect(result.multiTurnResult.turns).toHaveLength(2);

      // First turn is the initial prompt
      expect(result.multiTurnResult.turns[0].turn).toBe(1);
      expect(result.multiTurnResult.turns[0].userMessage).toBe('What is wrong?');

      // Second turn is the follow-up
      expect(result.multiTurnResult.turns[1].turn).toBe(2);
      expect(result.multiTurnResult.turns[1].userMessage).toBe('Can you check Redis?');
    });

    it('multi-turn stops at turnLimit', async () => {
      const { generateFollowUp } = require('@/services/evaluation/userSimulator');

      // Use a test case with turnLimit of 2
      const limitedTestCase: TestCase = {
        ...mockMultiTurnTestCase,
        multiTurnScenario: {
          ...mockMultiTurnTestCase.multiTurnScenario!,
          turnLimit: 2,
        },
      };

      // Simulator never says done - always returns a follow-up
      generateFollowUp.mockResolvedValue({ done: false, message: 'Tell me more.' });

      const mockConnector = createMockConnector();
      const mockRegistry = createMockRegistry(mockConnector);

      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          passFailStatus: 'failed',
          weightedScore: 40,
          rootCauseScore: 30,
          remediationScore: 50,
          contextRetentionScore: 60,
          concisenessScore: 40,
          reasoning: 'Turn limit reached before acceptance criteria met.',
          improvementStrategies: [
            { category: 'depth', issue: 'Shallow analysis', recommendation: 'Dig deeper', priority: 'high' },
          ],
        }),
      });

      const onStepMock = jest.fn();

      const result = await runEvaluationWithConnector(
        mockAgent,
        'test-model',
        limitedTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      // turnLimit=2: initial turn (turn 1) + loop runs for turnIdx=1 (turn 2) = 2 execute calls
      // Loop runs from turnIdx=1 to turnIdx < turnLimit (2), so one iteration
      expect(mockConnector.execute).toHaveBeenCalledTimes(2);

      // generateFollowUp called once (for turnIdx=1)
      expect(generateFollowUp).toHaveBeenCalledTimes(1);

      // Result should have exactly 2 turns
      expect(result.multiTurnResult).toBeDefined();
      expect(result.multiTurnResult.totalTurns).toBe(2);
      expect(result.multiTurnResult.turns).toHaveLength(2);

      // Judge was still called even though limit was reached
      expect(mockFetch).toHaveBeenCalled();
      expect(result.passFailStatus).toBe('failed');
    });

    it('multi-turn handles judge API failure gracefully', async () => {
      const { generateFollowUp } = require('@/services/evaluation/userSimulator');

      // One follow-up turn then done
      generateFollowUp.mockResolvedValueOnce({ done: true, message: 'Done.' });

      const mockConnector = createMockConnector();
      const mockRegistry = createMockRegistry(mockConnector);

      // Judge API returns an error
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: jest.fn().mockResolvedValue({ error: 'Internal server error' }),
      });

      const onStepMock = jest.fn();

      const result = await runEvaluationWithConnector(
        mockAgent,
        'test-model',
        mockMultiTurnTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      // Should return failed status with partial results
      expect(result.status).toBe('failed');
      expect(result.llmJudgeReasoning).toContain('Multi-turn evaluation failed');

      // Partial multiTurnResult should still have the completed turns
      expect(result.multiTurnResult).toBeDefined();
      expect(result.multiTurnResult.turns).toHaveLength(1);
      expect(result.multiTurnResult.acceptanceCriteriaMet).toBe(false);
    });

    it('multi-turn accumulates trajectory and rawEvents from all turns', async () => {
      const { generateFollowUp } = require('@/services/evaluation/userSimulator');

      generateFollowUp
        .mockResolvedValueOnce({ done: false, message: 'Follow-up 1' })
        .mockResolvedValueOnce({ done: true, message: 'Done' });

      let callCount = 0;
      const mockConnector = createMockConnector({
        execute: jest.fn().mockImplementation(async () => {
          callCount++;
          return {
            trajectory: [
              { id: `step-${callCount}`, timestamp: Date.now(), type: 'response', content: `Response ${callCount}` },
            ],
            runId: `run-${callCount}`,
            rawEvents: [{ type: `event-${callCount}` }],
            metadata: { threadId: 'thread-1' },
          };
        }),
      });
      const mockRegistry = createMockRegistry(mockConnector);

      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          passFailStatus: 'passed',
          weightedScore: 80,
          rootCauseScore: 80,
          remediationScore: 80,
          contextRetentionScore: 80,
          concisenessScore: 80,
          reasoning: 'Good',
          improvementStrategies: [],
        }),
      });

      const onStepMock = jest.fn();

      const result = await runEvaluationWithConnector(
        mockAgent,
        'test-model',
        mockMultiTurnTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      // Trajectory should contain steps from both turns
      expect(result.trajectory).toHaveLength(2);
      expect(result.trajectory[0].content).toBe('Response 1');
      expect(result.trajectory[1].content).toBe('Response 2');

      // rawEvents should contain events from both turns
      expect(result.rawEvents).toHaveLength(2);
      expect(result.rawEvents[0].type).toBe('event-1');
      expect(result.rawEvents[1].type).toBe('event-2');
    });

    it('multi-turn passes conversation history to buildMultiTurnPayload', async () => {
      const { generateFollowUp } = require('@/services/evaluation/userSimulator');
      const { buildMultiTurnPayload } = require('@/services/agent/payloadBuilder');

      generateFollowUp
        .mockResolvedValueOnce({ done: false, message: 'Is it Redis?' })
        .mockResolvedValueOnce({ done: true, message: 'Got it' });

      const mockConnector = createMockConnector();
      const mockRegistry = createMockRegistry(mockConnector);

      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          passFailStatus: 'passed',
          weightedScore: 90,
          rootCauseScore: 90,
          remediationScore: 90,
          contextRetentionScore: 90,
          concisenessScore: 90,
          reasoning: 'Excellent',
          improvementStrategies: [],
        }),
      });

      const onStepMock = jest.fn();

      await runEvaluationWithConnector(
        mockAgent,
        'test-model',
        mockMultiTurnTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      // buildMultiTurnPayload should have been called for the follow-up turn
      expect(buildMultiTurnPayload).toHaveBeenCalledTimes(1);

      // Note: conversationHistory is passed by reference and mutated after the call,
      // so we verify the call was made with the expected arguments using argument matchers.
      expect(buildMultiTurnPayload).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'What is wrong?' }),
          expect.objectContaining({ role: 'assistant' }),
          expect.objectContaining({ role: 'user', content: 'Is it Redis?' }),
        ]),
        'thread-1', // threadId from turn 1 metadata
        undefined,   // new runId per turn
        [],          // context from test case
        undefined    // tools from test case
      );
    });

    it('multi-turn sends judge request with correct payload shape', async () => {
      const { generateFollowUp } = require('@/services/evaluation/userSimulator');

      // End immediately after the initial turn
      generateFollowUp.mockResolvedValueOnce({ done: true, message: 'Done.' });

      const mockConnector = createMockConnector();
      const mockRegistry = createMockRegistry(mockConnector);

      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          passFailStatus: 'passed',
          weightedScore: 80,
          rootCauseScore: 80,
          remediationScore: 80,
          contextRetentionScore: 80,
          concisenessScore: 80,
          reasoning: 'Good',
          improvementStrategies: [],
        }),
      });

      const onStepMock = jest.fn();

      await runEvaluationWithConnector(
        mockAgent,
        'test-model',
        mockMultiTurnTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      // Verify the fetch call body has the correct structure
      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);

      expect(body.multiTurnConversation).toBeDefined();
      expect(body.multiTurnConversation.turns).toHaveLength(1);
      expect(body.multiTurnConversation.idealAnswer).toBe('Redis failure caused cascading timeouts');
      expect(body.modelId).toBeDefined();
    });
  });
});
