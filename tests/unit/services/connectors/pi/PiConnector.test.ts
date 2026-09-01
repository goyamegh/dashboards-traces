/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PiConnector, createAgentHealthPiConnector, piConnector } from '@/services/connectors/pi/PiConnector';
import type { ConnectorAuth, ConnectorRequest } from '@/services/connectors/types';
import type { TestCase, TrajectoryStep } from '@/types';
import { ToolCallStatus } from '@/types';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

function makeProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: jest.fn(), end: jest.fn() };
  proc.kill = jest.fn();
  proc.pid = 1234;
  return proc;
}

describe('PiConnector', () => {
  let connector: PiConnector;
  let mockTestCase: TestCase;
  let mockAuth: ConnectorAuth;
  const originalAwsProfile = process.env.AWS_PROFILE;
  const originalAwsRegion = process.env.AWS_REGION;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new PiConnector();
    mockAuth = { type: 'none' };
    mockTestCase = {
      id: 'tc-1',
      name: 'Pi test',
      initialPrompt: 'Investigate the incident',
      context: [{ description: 'Cluster', value: 'prod-a' }],
      expectedOutcomes: [],
      labels: [],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as TestCase;

    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    process.env.AWS_PROFILE = originalAwsProfile;
    process.env.AWS_REGION = originalAwsRegion;
    jest.restoreAllMocks();
  });

  function buildRequest(overrides: Partial<ConnectorRequest> = {}): ConnectorRequest {
    return {
      testCase: mockTestCase,
      agentKey: 'pi',
      modelId: undefined,
      ...overrides,
    } as ConnectorRequest;
  }

  async function runMock(
    chunks: Array<['stdout' | 'stderr', string]>,
    options?: { exitCode?: number; request?: Partial<ConnectorRequest> }
  ): Promise<{ result: any; progressSteps: TrajectoryStep[]; rawEvents: any[] }> {
    const proc = makeProcess();
    (spawn as jest.Mock).mockReturnValueOnce(proc);
    const progressSteps: TrajectoryStep[] = [];
    const rawEvents: any[] = [];

    const promise = connector.execute(
      'pi',
      buildRequest(options?.request),
      mockAuth,
      (step) => progressSteps.push(step),
      (event) => rawEvents.push(event),
    );

    await Promise.resolve();
    for (const [stream, chunk] of chunks) {
      proc[stream].emit('data', Buffer.from(chunk));
      await Promise.resolve();
    }
    proc.emit('close', options?.exitCode ?? 0, null);

    return {
      result: await promise,
      progressSteps,
      rawEvents,
    };
  }

  describe('properties', () => {
    it('exposes the expected protocol identity and helpers', () => {
      expect(connector.type).toBe('pi');
      expect(connector.name).toBe('Pi (pi.dev)');
      expect(connector.traceContext).toEqual({ propagateEnv: true, serviceName: 'pi-agent' });
      expect(piConnector).toBeInstanceOf(PiConnector);

      const preconfigured = createAgentHealthPiConnector('/pkg');
      expect(preconfigured).toBeInstanceOf(PiConnector);
      expect((preconfigured as any).config.args).toEqual([
        '--print',
        '--mode',
        'json',
        '--skill',
        '/pkg/skills/*',
        '--extension',
        '/pkg/extensions/agent-health.ts',
        '--append-system-prompt',
        '/pkg/prompts/agent-health.md',
      ]);
    });
  });

  describe('buildPayload', () => {
    it('formats context and task sections', () => {
      const payload = connector.buildPayload(buildRequest());
      expect(payload).toContain('## Context');
      expect(payload).toContain('**Cluster:**');
      expect(payload).toContain('prod-a');
      expect(payload).toContain('## Task');
      expect(payload).toContain('Investigate the incident');
    });

    it('omits the context section when none is present', () => {
      const payload = connector.buildPayload(buildRequest({
        testCase: { ...mockTestCase, context: [] } as TestCase,
      }));
      expect(payload).not.toContain('## Context');
      expect(payload).toContain('## Task');
    });
  });

  describe('execute', () => {
    it('parses message_end assistant content blocks into trajectory steps', async () => {
      const { result, progressSteps, rawEvents } = await runMock([
        ['stdout', '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Plan first"},{"type":"text","text":"Answer now"},{"type":"tool_use","name":"search_logs","input":{"query":"panic"}}]}}\n'],
      ]);

      expect(progressSteps.map((step) => step.type)).toEqual(['thinking', 'assistant', 'action']);
      expect(progressSteps[2]).toMatchObject({
        type: 'action',
        toolName: 'search_logs',
        toolArgs: { query: 'panic' },
      });
      expect(result.trajectory).toEqual(progressSteps);
      expect(rawEvents).toEqual([
        expect.objectContaining({ type: 'stdout' }),
      ]);
    });

    it('accumulates deltas and flushes them on agent_end', async () => {
      const { result } = await runMock([
        ['stdout', '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello "}}\n'],
        ['stdout', '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"Need data. "}}\n'],
        ['stdout', '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"world"}}\n'],
        ['stdout', '{"type":"agent_end"}\n'],
      ]);

      expect(result.trajectory).toEqual([
        expect.objectContaining({ type: 'thinking', content: 'Need data. ' }),
        expect.objectContaining({ type: 'response', content: 'Hello world' }),
      ]);
    });

    it('handles tool_result events and trailing buffered JSON at stream end', async () => {
      const { result } = await runMock([
        ['stdout', '{"type":"tool_result","content":{"ok":true},"is_error":false}\n'],
        ['stdout', '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"tail"}}'],
      ]);

      expect(result.trajectory).toEqual([
        expect.objectContaining({
          type: 'tool_result',
          content: '{"ok":true}',
          status: ToolCallStatus.SUCCESS,
        }),
        expect.objectContaining({ type: 'response', content: 'tail' }),
      ]);
    });

    it('treats non-JSON stdout as assistant text and flushes unterminated text chunks', async () => {
      const { result } = await runMock([
        ['stdout', 'plain line\n'],
        ['stdout', 'partial line without newline'],
      ]);

      expect(result.trajectory).toEqual([
        expect.objectContaining({ type: 'assistant', content: 'plain line' }),
        expect.objectContaining({ type: 'assistant', content: 'partial line without newline' }),
      ]);
    });

    it('applies connectorConfig overrides for a single run and restores defaults afterwards', async () => {
      process.env.AWS_PROFILE = 'dev-profile';
      process.env.AWS_REGION = 'us-west-2';

      const firstProc = makeProcess();
      const secondProc = makeProcess();
      (spawn as jest.Mock).mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

      const firstRun = connector.execute(
        'pi-cli',
        buildRequest({
          modelId: 'request-model',
          connectorConfig: {
            env: { PI_DEBUG: '1' },
            packagePath: '/pkg',
            model: 'config-model',
            workingDir: '/tmp/pi-work',
            timeout: 1234,
            additionalArgs: ['--verbose'],
          } as any,
        }),
        mockAuth,
      );
      await Promise.resolve();
      firstProc.emit('close', 0, null);
      await firstRun;

      const secondRun = connector.execute('pi-cli', buildRequest(), mockAuth);
      await Promise.resolve();
      secondProc.emit('close', 0, null);
      await secondRun;

      expect(spawn).toHaveBeenNthCalledWith(
        1,
        'pi-cli',
        [
          '--print',
          '--mode',
          'json',
          '--skill',
          '/pkg/skills/*',
          '--extension',
          '/pkg/extensions/agent-health.ts',
          '--append-system-prompt',
          '/pkg/prompts/agent-health.md',
          '--model',
          'config-model',
          '--verbose',
          '--model',
          'request-model',
        ],
        expect.objectContaining({
          cwd: '/tmp/pi-work',
          shell: false,
          env: expect.objectContaining({
            PI_DEBUG: '1',
            AWS_PROFILE: 'dev-profile',
            AWS_REGION: 'us-west-2',
          }),
        })
      );

      expect(spawn).toHaveBeenNthCalledWith(
        2,
        'pi-cli',
        ['--print', '--mode', 'json'],
        expect.objectContaining({
          cwd: undefined,
          shell: false,
        })
      );
    });
  });

  describe('parseResponse', () => {
    it('returns a response step and a failure step for stderr on non-zero exit', () => {
      const steps = connector.parseResponse({
        stdout: 'final answer\n',
        stderr: 'boom',
        exitCode: 2,
      });

      expect(steps).toEqual([
        expect.objectContaining({ type: 'response', content: 'final answer' }),
        expect.objectContaining({
          type: 'tool_result',
          content: 'Error: boom',
          status: ToolCallStatus.FAILURE,
        }),
      ]);
    });
  });

  describe('healthCheck', () => {
    it('checks for the pi command when no endpoint is provided', async () => {
      const proc = makeProcess();
      (spawn as jest.Mock).mockReturnValueOnce(proc);

      const promise = connector.healthCheck('', mockAuth);
      proc.emit('close', 0);

      await expect(promise).resolves.toBe(true);
      expect(spawn).toHaveBeenCalledWith('which', ['pi'], { shell: false });
    });
  });
});
