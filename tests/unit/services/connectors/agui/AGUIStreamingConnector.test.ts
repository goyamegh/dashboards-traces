/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { AGUIStreamingConnector, aguiStreamingConnector } from '@/services/connectors/agui/AGUIStreamingConnector';
import type { ConnectorRequest, ConnectorAuth } from '@/services/connectors/types';
import type { TestCase, TrajectoryStep } from '@/types';

// Mock the SSE stream module
jest.mock('@/services/agent/sseStream', () => ({
  consumeSSEStream: jest.fn(),
}));

// Mock the AG-UI converter
jest.mock('@/services/agent/aguiConverter', () => ({
  AGUIToTrajectoryConverter: jest.fn().mockImplementation(() => ({
    processEvent: jest.fn().mockReturnValue([]),
    getRunId: jest.fn().mockReturnValue('test-run-id'),
    getThreadId: jest.fn().mockReturnValue('test-thread-id'),
    getRunFinishedResult: jest.fn().mockReturnValue(null),
  })),
  computeTrajectoryFromRawEvents: jest.fn().mockReturnValue([]),
}));

// Mock the payload builder
jest.mock('@/services/agent/payloadBuilder', () => ({
  buildAgentPayload: jest.fn().mockReturnValue({
    threadId: 'thread-1',
    runId: 'run-1',
    messages: [{ content: 'test' }],
    model: 'test-model',
  }),
  buildMultiTurnPayload: jest.fn().mockReturnValue({
    threadId: 'thread-1',
    runId: 'run-2',
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }),
}));

import { consumeSSEStream } from '@/services/agent/sseStream';
import { AGUIToTrajectoryConverter, computeTrajectoryFromRawEvents } from '@/services/agent/aguiConverter';
import { buildAgentPayload, buildMultiTurnPayload } from '@/services/agent/payloadBuilder';

describe('AGUIStreamingConnector', () => {
  let connector: AGUIStreamingConnector;
  let mockTestCase: TestCase;
  let mockAuth: ConnectorAuth;

  beforeEach(() => {
    connector = new AGUIStreamingConnector();
    mockTestCase = {
      id: 'tc-123',
      name: 'Test Case',
      initialPrompt: 'What is the cluster health?',
      context: [],
      expectedOutcomes: ['Check cluster health'],
      labels: [],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockAuth = { type: 'none' };
    jest.clearAllMocks();
  });

  describe('properties', () => {
    it('should have correct type', () => {
      expect(connector.type).toBe('agui-streaming');
    });

    it('should have correct name', () => {
      expect(connector.name).toBe('AG-UI Streaming');
    });

    it('should support streaming', () => {
      expect(connector.supportsStreaming).toBe(true);
    });
  });

  describe('buildPayload', () => {
    it('should delegate to buildAgentPayload', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        threadId: 'thread-123',
        runId: 'run-456',
      };

      connector.buildPayload(request);

      expect(buildAgentPayload).toHaveBeenCalledWith(
        mockTestCase,
        'test-model',
        'thread-123',
        'run-456'
      );
    });
  });

  describe('execute', () => {
    it('should call consumeSSEStream with correct parameters', async () => {
      (consumeSSEStream as jest.Mock).mockResolvedValue(undefined);

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      await connector.execute('http://localhost:8080/stream', request, mockAuth);

      expect(consumeSSEStream).toHaveBeenCalledWith(
        'http://localhost:8080/stream',
        expect.any(Object),
        expect.any(Function),
        {}
      );
    });

    it('should include auth headers', async () => {
      (consumeSSEStream as jest.Mock).mockResolvedValue(undefined);

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      await connector.execute(
        'http://localhost:8080/stream',
        request,
        { type: 'bearer', token: 'my-token' }
      );

      expect(consumeSSEStream).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
        expect.objectContaining({ 'Authorization': 'Bearer my-token' })
      );
    });

    it('should return response with trajectory and metadata', async () => {
      (consumeSSEStream as jest.Mock).mockResolvedValue(undefined);

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const response = await connector.execute(
        'http://localhost:8080/stream',
        request,
        mockAuth
      );

      expect(response.trajectory).toEqual([]);
      expect(response.runId).toBe('test-run-id');
      expect(response.metadata?.threadId).toBe('test-thread-id');
    });

    it('should call onProgress for converted steps', async () => {
      const mockStep: TrajectoryStep = {
        id: '1',
        type: 'thinking',
        content: 'Test',
        timestamp: Date.now(),
      };

      // Make the converter return a step
      (AGUIToTrajectoryConverter as jest.Mock).mockImplementation(() => ({
        processEvent: jest.fn().mockReturnValue([mockStep]),
        getRunId: jest.fn().mockReturnValue('test-run-id'),
        getThreadId: jest.fn().mockReturnValue('test-thread-id'),
      }));

      // Capture the callback and call it
      (consumeSSEStream as jest.Mock).mockImplementation(
        async (endpoint, payload, callback) => {
          callback({ type: 'TEXT_MESSAGE_START' });
        }
      );

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      await connector.execute(
        'http://localhost:8080/stream',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      expect(progressSteps).toContainEqual(mockStep);
    });

    it('should call onRawEvent for each AG-UI event', async () => {
      const mockEvent = { type: 'TEXT_MESSAGE_START', data: 'test' };

      (consumeSSEStream as jest.Mock).mockImplementation(
        async (endpoint, payload, callback) => {
          callback(mockEvent);
        }
      );

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const rawEvents: any[] = [];

      await connector.execute(
        'http://localhost:8080/stream',
        request,
        mockAuth,
        undefined,
        (event) => rawEvents.push(event)
      );

      expect(rawEvents).toContainEqual(mockEvent);
    });
  });

  describe('parseResponse', () => {
    it('should delegate to computeTrajectoryFromRawEvents', () => {
      const rawEvents = [{ type: 'TEXT_MESSAGE_START' }];

      connector.parseResponse(rawEvents);

      expect(computeTrajectoryFromRawEvents).toHaveBeenCalledWith(rawEvents);
    });
  });

  describe('healthCheck', () => {
    beforeEach(() => {
      jest.spyOn(global, 'fetch').mockImplementation();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return true when OPTIONS request succeeds', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

      const result = await connector.healthCheck('http://localhost:8080', mockAuth);

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('http://localhost:8080', {
        method: 'OPTIONS',
        headers: {},
      });
    });

    it('should return true even for non-ok response (endpoint reachable)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false });

      const result = await connector.healthCheck('http://localhost:8080', mockAuth);

      // AG-UI considers endpoint reachable if fetch doesn't throw
      expect(result).toBe(true);
    });

    it('should return false when fetch throws', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

      const result = await connector.healthCheck('http://localhost:8080', mockAuth);

      expect(result).toBe(false);
    });
  });

  describe('default instance', () => {
    it('should export a default instance', () => {
      expect(aguiStreamingConnector).toBeInstanceOf(AGUIStreamingConnector);
    });
  });

  describe('interrupt handling (multiTurnOptions)', () => {
    it('should execute single pass when multiTurnOptions not enabled', async () => {
      (consumeSSEStream as jest.Mock).mockResolvedValue(undefined);

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const response = await connector.execute(
        'http://localhost:8080/stream',
        request,
        mockAuth
      );

      expect(consumeSSEStream).toHaveBeenCalledTimes(1);
      expect(response.runId).toBe('test-run-id');
    });

    it('should execute single pass when multiTurnOptions.enabled is false', async () => {
      (consumeSSEStream as jest.Mock).mockResolvedValue(undefined);

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        multiTurnOptions: { enabled: false },
      };

      const response = await connector.execute(
        'http://localhost:8080/stream',
        request,
        mockAuth
      );

      expect(consumeSSEStream).toHaveBeenCalledTimes(1);
    });

    it('should handle interrupt with auto-approve and make second call', async () => {
      let callCount = 0;

      // Mock converter that returns interrupt on first call, no interrupt on second
      (AGUIToTrajectoryConverter as jest.Mock).mockImplementation(() => {
        callCount++;
        const currentCall = callCount;
        return {
          processEvent: jest.fn().mockReturnValue([
            { id: `step-${currentCall}`, timestamp: Date.now(), type: 'response', content: `Response ${currentCall}` },
          ]),
          getRunId: jest.fn().mockReturnValue(`run-${currentCall}`),
          getThreadId: jest.fn().mockReturnValue('thread-1'),
          getRunFinishedResult: jest.fn().mockReturnValue(
            currentCall === 1 ? { outcome: 'interrupt', reason: 'Tool approval needed' } : null
          ),
        };
      });

      // consumeSSEStream must invoke the callback to trigger processEvent
      (consumeSSEStream as jest.Mock).mockImplementation(
        async (_endpoint: string, _payload: any, callback: (event: any) => void) => {
          callback({ type: 'TEXT_MESSAGE_CONTENT' });
        }
      );

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        multiTurnOptions: { enabled: true, maxTurns: 5, interruptPolicy: 'auto-approve' },
      };

      const response = await connector.execute(
        'http://localhost:8080/stream',
        request,
        mockAuth
      );

      // Should have been called twice: initial + after interrupt
      expect(consumeSSEStream).toHaveBeenCalledTimes(2);
      // Trajectory should have steps from both calls
      expect(response.trajectory.length).toBe(2);
      expect(response.metadata?.interruptCount).toBe(1);
      expect(response.metadata?.threadId).toBe('thread-1');
    });

    it('should stop when interrupt policy is skip', async () => {
      (AGUIToTrajectoryConverter as jest.Mock).mockImplementation(() => ({
        processEvent: jest.fn().mockReturnValue([
          { id: 'step-1', timestamp: Date.now(), type: 'response', content: 'Response' },
        ]),
        getRunId: jest.fn().mockReturnValue('run-1'),
        getThreadId: jest.fn().mockReturnValue('thread-1'),
        getRunFinishedResult: jest.fn().mockReturnValue({ outcome: 'interrupt', reason: 'Needs approval' }),
      }));

      (consumeSSEStream as jest.Mock).mockImplementation(
        async (_endpoint: string, _payload: any, callback: (event: any) => void) => {
          callback({ type: 'TEXT_MESSAGE_CONTENT' });
        }
      );

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        multiTurnOptions: { enabled: true, maxTurns: 5, interruptPolicy: 'skip' },
      };

      const response = await connector.execute(
        'http://localhost:8080/stream',
        request,
        mockAuth
      );

      // Should only call once since skip policy stops the loop
      expect(consumeSSEStream).toHaveBeenCalledTimes(1);
      expect(response.trajectory.length).toBe(1);
    });

    it('should respect maxTurns limit for interrupts', async () => {
      // Always return interrupt
      (AGUIToTrajectoryConverter as jest.Mock).mockImplementation(() => ({
        processEvent: jest.fn().mockReturnValue([]),
        getRunId: jest.fn().mockReturnValue('run-1'),
        getThreadId: jest.fn().mockReturnValue('thread-1'),
        getRunFinishedResult: jest.fn().mockReturnValue({ outcome: 'interrupt', reason: 'Needs approval' }),
      }));

      (consumeSSEStream as jest.Mock).mockImplementation(
        async (_endpoint: string, _payload: any, callback: (event: any) => void) => {
          callback({ type: 'TEXT_MESSAGE_CONTENT' });
        }
      );

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        multiTurnOptions: { enabled: true, maxTurns: 3, interruptPolicy: 'auto-approve' },
      };

      const response = await connector.execute(
        'http://localhost:8080/stream',
        request,
        mockAuth
      );

      // Should stop at maxTurns
      expect(consumeSSEStream).toHaveBeenCalledTimes(3);
    });

    it('should preserve threadId across interrupt sub-turns', async () => {
      let callCount = 0;
      (AGUIToTrajectoryConverter as jest.Mock).mockImplementation(() => {
        callCount++;
        const currentCall = callCount;
        return {
          processEvent: jest.fn().mockReturnValue([
            { id: `s${currentCall}`, timestamp: Date.now(), type: 'response', content: `R${currentCall}` },
          ]),
          getRunId: jest.fn().mockReturnValue(`run-${currentCall}`),
          getThreadId: jest.fn().mockReturnValue('preserved-thread'),
          getRunFinishedResult: jest.fn().mockReturnValue(
            currentCall === 1 ? { outcome: 'interrupt', reason: 'approve' } : null
          ),
        };
      });

      (consumeSSEStream as jest.Mock).mockImplementation(
        async (_endpoint: string, _payload: any, callback: (event: any) => void) => {
          callback({ type: 'TEXT_MESSAGE_CONTENT' });
        }
      );

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        multiTurnOptions: { enabled: true, interruptPolicy: 'auto-approve' },
      };

      const response = await connector.execute(
        'http://localhost:8080/stream',
        request,
        mockAuth
      );

      expect(response.metadata?.threadId).toBe('preserved-thread');
      // buildMultiTurnPayload should have been called with the preserved threadId
      expect(buildMultiTurnPayload).toHaveBeenCalledWith(
        expect.any(Array),
        'preserved-thread',
        undefined,
        expect.any(Array),
        undefined
      );
    });
  });
});
