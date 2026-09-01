/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockRunEvaluationWithConnector = jest.fn();
const mockGradeAssertions = jest.fn();
const mockAggregateResults = jest.fn();
const mockDebug = jest.fn();

jest.mock('@/services/evaluation', () => ({
  runEvaluationWithConnector: (...args: any[]) => mockRunEvaluationWithConnector(...args),
}));

jest.mock('@/services/skills/grader', () => ({
  gradeAssertions: (...args: any[]) => mockGradeAssertions(...args),
}));

jest.mock('@/services/skills/aggregator', () => ({
  aggregateResults: (...args: any[]) => mockAggregateResults(...args),
}));

jest.mock('@/lib/debug', () => ({
  debug: (...args: any[]) => mockDebug(...args),
}));

import { runSkillEval } from '@/services/skills/runner';

describe('services/skills/runner', () => {
  let workspacePath: string;

  const skill = {
    path: '/skills/debug-skill',
    metadata: { name: 'Debug Skill' },
    instructions: 'Always inspect traces before answering.',
  } as any;

  const agent = {
    key: 'claude-agent',
    name: 'Claude Agent',
    endpoint: 'claude',
    connectorType: 'claude-code',
    connectorConfig: {},
  } as any;

  const registry = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    workspacePath = mkdtempSync(join(tmpdir(), 'skill-runner-'));
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('runs both conditions, injects the skill prompt, grades assertions, and writes output files', async () => {
    const progressEvents: any[] = [];
    const benchmark = { summary: 'ok' };

    mockRunEvaluationWithConnector.mockImplementation(
      async (_effectiveAgent: any, _endpoint: string, _testCase: any, onStep: any) => {
        onStep({
          id: `step-${_testCase.id}`,
          type: 'assistant',
          content: `handled ${_testCase.id}`,
          timestamp: Date.now(),
        });
      }
    );
    mockGradeAssertions
      .mockResolvedValueOnce({
        assertion_results: [{ text: 'assert A', passed: true, evidence: 'ok' }],
        summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
      })
      .mockResolvedValueOnce({
        assertion_results: [{ text: 'assert A', passed: false, evidence: 'missed' }],
        summary: { passed: 0, failed: 1, total: 1, pass_rate: 0 },
      });
    mockAggregateResults.mockReturnValue(benchmark);

    const result = await runSkillEval({
      skill,
      evals: {
        evals: [{
          id: 'eval-1',
          prompt: 'Find the root cause',
          expected_output: 'Identify root cause',
          assertions: ['assert A'],
        }],
      } as any,
      agent,
      modelId: 'judge-model',
      workspacePath,
      iteration: 2,
      registry,
      serverBaseUrl: 'http://localhost:4001',
      onProgress: (event) => progressEvents.push(event),
    });

    expect(result).toBe(benchmark);
    expect(mockRunEvaluationWithConnector).toHaveBeenCalledTimes(2);
    expect(mockRunEvaluationWithConnector).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connectorType: 'claude-code',
        connectorConfig: expect.objectContaining({ dangerouslySkipPermissions: true }),
      }),
      '',
      expect.objectContaining({
        id: 'skill-eval-eval-1-with_skill',
        initialPrompt: expect.stringContaining('<skill name="Debug Skill">'),
      }),
      expect.any(Function),
      { registry }
    );
    expect(mockRunEvaluationWithConnector).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        connectorType: 'claude-code',
        connectorConfig: expect.objectContaining({ dangerouslySkipPermissions: true }),
      }),
      '',
      expect.objectContaining({
        id: 'skill-eval-eval-1-without_skill',
        initialPrompt: 'Find the root cause',
      }),
      expect.any(Function),
      { registry }
    );
    expect(mockGradeAssertions).toHaveBeenCalledTimes(2);
    expect(mockAggregateResults).toHaveBeenCalledWith(
      [{ grading: expect.any(Object), timing: expect.any(Object) }],
      [{ grading: expect.any(Object), timing: expect.any(Object) }],
      {
        skillName: 'Debug Skill',
        skillPath: '/skills/debug-skill',
        iteration: 2,
        agentKey: 'claude-agent',
        modelId: 'judge-model',
      }
    );

    const benchmarkPath = join(workspacePath, 'iteration-2', 'benchmark.json');
    const withSkillTimingPath = join(workspacePath, 'iteration-2', 'eval-eval-1', 'with_skill', 'timing.json');
    const withSkillGradingPath = join(workspacePath, 'iteration-2', 'eval-eval-1', 'with_skill', 'grading.json');

    expect(existsSync(benchmarkPath)).toBe(true);
    expect(existsSync(withSkillTimingPath)).toBe(true);
    expect(existsSync(withSkillGradingPath)).toBe(true);
    expect(JSON.parse(readFileSync(benchmarkPath, 'utf8'))).toEqual(benchmark);
    expect(JSON.parse(readFileSync(withSkillGradingPath, 'utf8'))).toEqual({
      assertion_results: [{ text: 'assert A', passed: true, evidence: 'ok' }],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
    });

    expect(progressEvents.map((event) => event.type)).toEqual([
      'started',
      'eval_running',
      'eval_grading',
      'eval_done',
      'eval_running',
      'eval_grading',
      'eval_done',
      'completed',
    ]);
  });

  it('marks zero-assertion evals as failed without calling the grader', async () => {
    mockRunEvaluationWithConnector.mockResolvedValue(undefined);
    mockAggregateResults.mockReturnValue({ summary: 'no assertions' });
    const progressEvents: any[] = [];

    await runSkillEval({
      skill,
      evals: {
        evals: [{
          id: 'eval-2',
          prompt: 'Collect context',
          expected_output: 'Summarize findings',
          assertions: [],
        }],
      } as any,
      agent: { ...agent, connectorType: 'mock' } as any,
      modelId: 'judge-model',
      workspacePath,
      iteration: 1,
      registry,
      serverBaseUrl: 'http://localhost:4001',
      onProgress: (event) => progressEvents.push(event),
    });

    expect(mockGradeAssertions).not.toHaveBeenCalled();
    expect(progressEvents).toContainEqual(expect.objectContaining({
      type: 'eval_done',
      condition: 'with_skill',
      passRate: 0,
      evalStatus: 'failed',
    }));
  });

  it('records execution errors as errored results, skips grading for that condition, and continues', async () => {
    mockRunEvaluationWithConnector
      .mockRejectedValueOnce(new Error('tool exploded'))
      .mockImplementationOnce(async (_effectiveAgent: any, _endpoint: string, _testCase: any, onStep: any) => {
        onStep({
          id: 'step-success',
          type: 'assistant',
          content: 'fallback answer',
          timestamp: Date.now(),
        });
      });
    mockGradeAssertions.mockResolvedValueOnce({
      assertion_results: [{ text: 'assert B', passed: false, evidence: 'weak evidence' }],
      summary: { passed: 0, failed: 1, total: 1, pass_rate: 0 },
    });
    mockAggregateResults.mockReturnValue({ summary: 'errored path' });

    const progressEvents: any[] = [];
    await runSkillEval({
      skill,
      evals: {
        evals: [{
          id: 'eval-3',
          prompt: 'Check alarms',
          expected_output: 'Find alarm cause',
          assertions: ['assert B'],
        }],
      } as any,
      agent,
      modelId: 'judge-model',
      workspacePath,
      iteration: 3,
      registry,
      serverBaseUrl: 'http://localhost:4001',
      onProgress: (event) => progressEvents.push(event),
    });

    expect(mockGradeAssertions).toHaveBeenCalledTimes(1);
    expect(mockDebug).toHaveBeenCalledWith(
      'SkillRunner',
      'Execution failed for eval eval-3 (with_skill):',
      expect.any(Error)
    );
    expect(mockAggregateResults).toHaveBeenCalledWith(
      [{
        grading: {
          assertion_results: [{
            text: 'assert B',
            passed: false,
            evidence: 'Skipped: agent execution errored before grading (tool exploded)',
          }],
          summary: { passed: 0, failed: 1, total: 1, pass_rate: 0 },
        },
        timing: expect.any(Object),
      }],
      [{ grading: expect.any(Object), timing: expect.any(Object) }],
      expect.any(Object)
    );
    expect(progressEvents).toContainEqual(expect.objectContaining({
      type: 'eval_done',
      evalId: 'eval-3',
      condition: 'with_skill',
      evalStatus: 'errored',
      errorMessage: 'tool exploded',
    }));
    expect(JSON.parse(
      readFileSync(
        join(workspacePath, 'iteration-3', 'eval-eval-3', 'with_skill', 'grading.json'),
        'utf8'
      )
    )).toEqual({
      assertion_results: [{
        text: 'assert B',
        passed: false,
        evidence: 'Skipped: agent execution errored before grading (tool exploded)',
      }],
      summary: { passed: 0, failed: 1, total: 1, pass_rate: 0 },
    });
  });
});
