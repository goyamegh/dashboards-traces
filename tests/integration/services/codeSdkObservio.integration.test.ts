/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the Code-Based Test Case SDK with Observio agent.
 *
 * These tests verify the full evaluation path:
 * 1. Loading an .eval.js fixture via resolveTestCaseSources (code-import)
 * 2. Verifying the evaluateFnMap is populated correctly
 * 3. Simulating agent execution and calling the evaluate function
 * 4. Verifying pass/fail results based on evaluate function behavior
 *
 * Uses FileStorageModule for persistence (no OpenSearch required).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { resolveTestCaseSources } from '@/services/sourceResolver';
import type { EvaluateFn } from '@/services/sourceResolver';
import type { TestCaseSource, TrajectoryStep } from '@/types';
import type { EvalResult } from '@/lib/testCases/types';

describe('Code SDK - Observio integration (code-import + evaluate)', () => {
  let tmpDir: string;
  let storage: FileStorageModule;
  const fixtureFile = path.resolve(__dirname, '../../fixtures/observio-sample.eval.js');

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-sdk-observio-'));
    storage = new FileStorageModule(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveTestCaseSources with code-import', () => {
    it('loads the observio fixture and populates evaluateFnMap', async () => {
      const sources: TestCaseSource[] = [
        { type: 'code-import', filenames: [fixtureFile], testCaseIds: [] },
      ];

      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toHaveLength(2);
      expect(result.evaluateFnMap.size).toBe(2);

      const firstTc = result.testCases[0];
      expect(firstTc.name).toBe('Observio Basic Response');
      expect(firstTc.sourceFile).toBeDefined();
      expect(firstTc.sourceHash).toBeDefined();

      const secondTc = result.testCases[1];
      expect(secondTc.name).toBe('Observio Trajectory Structure');

      expect(result.evaluateFnMap.has(firstTc.id)).toBe(true);
      expect(result.evaluateFnMap.has(secondTc.id)).toBe(true);
    });

    it('produces idempotent results on second import', async () => {
      const sources: TestCaseSource[] = [
        { type: 'code-import', filenames: [fixtureFile], testCaseIds: [] },
      ];

      const first = await resolveTestCaseSources(sources, storage);
      const second = await resolveTestCaseSources(sources, storage);

      expect(second.testCases).toHaveLength(2);
      expect(second.testCases[0].id).toBe(first.testCases[0].id);
      expect(second.testCases[1].id).toBe(first.testCases[1].id);
    });
  });

  describe('evaluate function execution - pass scenarios', () => {
    let evaluateFnMap: Map<string, EvaluateFn>;
    let testCaseIds: string[];

    beforeAll(async () => {
      const sources: TestCaseSource[] = [
        { type: 'code-import', filenames: [fixtureFile], testCaseIds: [] },
      ];
      const result = await resolveTestCaseSources(sources, storage);
      evaluateFnMap = result.evaluateFnMap;
      testCaseIds = result.testCases.map(tc => tc.id);
    });

    it('passes when trajectory has steps and agent produces output', async () => {
      const evalFn = evaluateFnMap.get(testCaseIds[0])!;
      expect(evalFn).toBeDefined();

      const mockResult: EvalResult = {
        trajectory: [
          { type: 'thinking', content: 'Analyzing the situation...' } as TrajectoryStep,
          { type: 'action', content: 'search_logs', toolName: 'search_logs', toolArgs: {} } as unknown as TrajectoryStep,
          { type: 'tool_result', content: 'Found high CPU process: java', status: 'SUCCESS' } as unknown as TrajectoryStep,
          { type: 'response', content: 'The root cause is a Java process consuming excessive CPU.' } as TrajectoryStep,
        ],
        agentOutput: 'The root cause is a Java process consuming excessive CPU.',
        rawEvents: [],
        runId: 'test-run-1',
        durationMs: 1500,
      };

      await expect(Promise.resolve().then(() => evalFn(mockResult))).resolves.toBeUndefined();
    });

    it('passes when trajectory has response step (second test case)', async () => {
      const evalFn = evaluateFnMap.get(testCaseIds[1])!;
      expect(evalFn).toBeDefined();

      const mockResult: EvalResult = {
        trajectory: [
          { type: 'thinking', content: 'Looking at the error logs...' } as TrajectoryStep,
          { type: 'response', content: 'The payment-service is failing due to database connectivity.' } as TrajectoryStep,
        ],
        agentOutput: 'The payment-service is failing due to database connectivity.',
        rawEvents: [],
        runId: 'test-run-2',
        durationMs: 800,
      };

      await expect(Promise.resolve().then(() => evalFn(mockResult))).resolves.toBeUndefined();
    });
  });

  describe('evaluate function execution - fail scenarios', () => {
    let evaluateFnMap: Map<string, EvaluateFn>;
    let testCaseIds: string[];

    beforeAll(async () => {
      const sources: TestCaseSource[] = [
        { type: 'code-import', filenames: [fixtureFile], testCaseIds: [] },
      ];
      const result = await resolveTestCaseSources(sources, storage);
      evaluateFnMap = result.evaluateFnMap;
      testCaseIds = result.testCases.map(tc => tc.id);
    });

    it('fails when trajectory is empty', async () => {
      const evalFn = evaluateFnMap.get(testCaseIds[0])!;

      const mockResult: EvalResult = {
        trajectory: [],
        agentOutput: '',
        rawEvents: [],
        runId: 'test-run-fail-1',
        durationMs: 100,
      };

      await expect(Promise.resolve().then(() => evalFn(mockResult))).rejects.toThrow(
        'Expected trajectory to have at least one step'
      );
    });

    it('fails when agent output is empty', async () => {
      const evalFn = evaluateFnMap.get(testCaseIds[0])!;

      const mockResult: EvalResult = {
        trajectory: [
          { type: 'thinking', content: 'Processing...' } as TrajectoryStep,
        ],
        agentOutput: '',
        rawEvents: [],
        runId: 'test-run-fail-2',
        durationMs: 500,
      };

      await expect(Promise.resolve().then(() => evalFn(mockResult))).rejects.toThrow(
        'Expected non-empty agent output'
      );
    });

    it('fails when durationMs is zero or negative', async () => {
      const evalFn = evaluateFnMap.get(testCaseIds[0])!;

      const mockResult: EvalResult = {
        trajectory: [
          { type: 'response', content: 'Some response' } as TrajectoryStep,
        ],
        agentOutput: 'Some response',
        rawEvents: [],
        runId: 'test-run-fail-3',
        durationMs: 0,
      };

      await expect(Promise.resolve().then(() => evalFn(mockResult))).rejects.toThrow(
        'Expected positive durationMs'
      );
    });

    it('fails when trajectory has no response step (second test case)', async () => {
      const evalFn = evaluateFnMap.get(testCaseIds[1])!;

      const mockResult: EvalResult = {
        trajectory: [
          { type: 'thinking', content: 'Thinking...' } as TrajectoryStep,
          { type: 'action', content: 'search', toolName: 'search', toolArgs: {} } as unknown as TrajectoryStep,
        ],
        agentOutput: 'Some output',
        rawEvents: [],
        runId: 'test-run-fail-4',
        durationMs: 500,
      };

      await expect(Promise.resolve().then(() => evalFn(mockResult))).rejects.toThrow(
        'Expected at least one response step in trajectory'
      );
    });
  });

  describe('deterministic evaluation pattern', () => {
    let evaluateFnMap: Map<string, EvaluateFn>;
    let testCaseIds: string[];

    beforeAll(async () => {
      const sources: TestCaseSource[] = [
        { type: 'code-import', filenames: [fixtureFile], testCaseIds: [] },
      ];
      const result = await resolveTestCaseSources(sources, storage);
      evaluateFnMap = result.evaluateFnMap;
      testCaseIds = result.testCases.map(tc => tc.id);
    });

    it('produces passFailStatus=passed when evaluate does not throw', async () => {
      const testCaseId = testCaseIds[0];
      const evalFn = evaluateFnMap.get(testCaseId)!;

      const trajectory: TrajectoryStep[] = [
        { type: 'thinking', content: 'Analyzing...' } as TrajectoryStep,
        { type: 'response', content: 'Root cause identified: Java process' } as TrajectoryStep,
      ];

      const agentOutput = trajectory
        .filter(s => s.type === 'response')
        .map(s => s.content)
        .join('\n');

      let passFailStatus: 'passed' | 'failed';
      let assertionError: string | undefined;

      try {
        await evalFn({
          trajectory,
          agentOutput,
          rawEvents: [],
          runId: 'sim-run-1',
          durationMs: 1200,
        });
        passFailStatus = 'passed';
      } catch (err: any) {
        passFailStatus = 'failed';
        assertionError = err.message;
      }

      expect(passFailStatus).toBe('passed');
      expect(assertionError).toBeUndefined();
    });

    it('produces passFailStatus=failed with assertionError when evaluate throws', async () => {
      const testCaseId = testCaseIds[0];
      const evalFn = evaluateFnMap.get(testCaseId)!;

      let passFailStatus: 'passed' | 'failed';
      let assertionError: string | undefined;

      try {
        await evalFn({
          trajectory: [],
          agentOutput: '',
          rawEvents: [],
          runId: 'sim-run-2',
          durationMs: 50,
        });
        passFailStatus = 'passed';
      } catch (err: any) {
        passFailStatus = 'failed';
        assertionError = err.message;
      }

      expect(passFailStatus).toBe('failed');
      expect(assertionError).toContain('Expected trajectory to have at least one step');
    });
  });
});
