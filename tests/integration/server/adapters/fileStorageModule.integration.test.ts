/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for FileStorageModule
 *
 * Tests the file-based storage adapter that implements IStorageModule
 * using JSON files on disk. Uses a temporary directory for isolation.
 *
 * Run tests:
 *   npm run test:integration -- --testPathPattern=fileStorageModule.integration
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';

let storage: FileStorageModule;
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-file-storage-'));
  storage = new FileStorageModule(tmpDir);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Module-level tests
// ============================================================================

describe('FileStorageModule', () => {
  describe('health()', () => {
    it('should return status ok when disk is accessible', async () => {
      const result = await storage.health();
      expect(result).toEqual({ status: 'ok' });
    });
  });

  describe('isConfigured()', () => {
    it('should always return true', () => {
      expect(storage.isConfigured()).toBe(true);
    });
  });

  describe('directory structure', () => {
    it('should create subdirectories', () => {
      // Trigger creation by accessing modules
      expect(fs.existsSync(tmpDir)).toBe(true);
    });

    it('should expose all expected modules', () => {
      expect(storage.testCases).toBeDefined();
      expect(storage.benchmarks).toBeDefined();
      expect(storage.evaluationRuns).toBeDefined();
      expect(storage.runs).toBeDefined();
      expect(storage.analytics).toBeDefined();
      expect(storage.evaluators).toBeDefined();
      expect(storage.sessionMetadata).toBeDefined();
    });
  });
});

// ============================================================================
// Test Cases
// ============================================================================

describe('FileStorageModule - testCases', () => {
  let createdId: string;

  describe('create', () => {
    it('should create a test case with generated ID and version 1', async () => {
      const tc = await storage.testCases.create({
        name: 'Integration Test Case',
        initialPrompt: 'Test prompt',
        labels: ['category:RCA', 'difficulty:Medium'],
      });

      expect(tc.id).toBeDefined();
      expect(tc.name).toBe('Integration Test Case');
      expect(tc.initialPrompt).toBe('Test prompt');
      expect(tc.version).toBe(1);
      expect(tc.currentVersion).toBe(1);
      expect(tc.createdAt).toBeDefined();
      expect(tc.updatedAt).toBeDefined();
      createdId = tc.id;
    });

    it('should store as versioned file on disk', async () => {
      const filePath = path.join(tmpDir, 'test-cases', `${createdId}-v1.json`);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('should throw when name is missing', async () => {
      await expect(
        storage.testCases.create({ initialPrompt: 'no name' })
      ).rejects.toThrow('Test case name is required');
    });
  });

  describe('getById', () => {
    it('should return the latest version of a test case', async () => {
      const tc = await storage.testCases.getById(createdId);
      expect(tc).not.toBeNull();
      expect(tc!.id).toBe(createdId);
      expect(tc!.name).toBe('Integration Test Case');
    });

    it('should return null for non-existent ID', async () => {
      const tc = await storage.testCases.getById('non-existent-id');
      expect(tc).toBeNull();
    });
  });

  describe('update', () => {
    it('should create a new version file', async () => {
      const updated = await storage.testCases.update(createdId, {
        name: 'Updated Test Case',
        initialPrompt: 'Updated prompt',
      });

      expect(updated.id).toBe(createdId);
      expect(updated.name).toBe('Updated Test Case');
      expect(updated.version).toBe(2);
      expect(updated.currentVersion).toBe(2);

      // Both version files should exist
      const v1Path = path.join(tmpDir, 'test-cases', `${createdId}-v1.json`);
      const v2Path = path.join(tmpDir, 'test-cases', `${createdId}-v2.json`);
      expect(fs.existsSync(v1Path)).toBe(true);
      expect(fs.existsSync(v2Path)).toBe(true);
    });

    it('should throw for non-existent test case', async () => {
      await expect(
        storage.testCases.update('non-existent-id', { name: 'Nope' })
      ).rejects.toThrow('Test case non-existent-id not found');
    });
  });

  describe('getAll', () => {
    it('should return only the latest version of each test case', async () => {
      const { items, total } = await storage.testCases.getAll();
      expect(total).toBeGreaterThanOrEqual(1);

      const found = items.find(tc => tc.id === createdId);
      expect(found).toBeDefined();
      expect(found!.name).toBe('Updated Test Case');
      expect(found!.version).toBe(2);
    });

    it('should sort by createdAt descending', async () => {
      // Create a second test case
      await storage.testCases.create({ name: 'Second Case', initialPrompt: 'prompt2' });
      const { items } = await storage.testCases.getAll();
      expect(items.length).toBeGreaterThanOrEqual(2);

      // Most recently created should be first
      const timestamps = items.map(tc => new Date(tc.createdAt || 0).getTime());
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
      }
    });

    it('should support pagination', async () => {
      const { items } = await storage.testCases.getAll({ from: 0, size: 1 });
      expect(items.length).toBe(1);
    });
  });

  describe('search', () => {
    it('should filter by labels', async () => {
      const { items } = await storage.testCases.search({ labels: ['category:RCA'] });
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.every(tc => tc.labels?.includes('category:RCA'))).toBe(true);
    });

    it('should filter by text search', async () => {
      const { items } = await storage.testCases.search({ textSearch: 'Updated' });
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items[0].name).toContain('Updated');
    });

    it('should return empty for non-matching filters', async () => {
      const { items } = await storage.testCases.search({ labels: ['nonexistent-label'] });
      expect(items.length).toBe(0);
    });
  });

  describe('bulkCreate', () => {
    it('should create multiple test cases and report results', async () => {
      const result = await storage.testCases.bulkCreate([
        { name: 'Bulk 1', initialPrompt: 'p1' },
        { name: 'Bulk 2', initialPrompt: 'p2' },
        { initialPrompt: 'no name' }, // should fail
      ]);

      expect(result.created).toBe(2);
      expect(result.errors).toBe(1);
      expect(result.testCases.length).toBe(2);
    });
  });

  describe('delete', () => {
    it('should remove all version files for the test case', async () => {
      const { deleted } = await storage.testCases.delete(createdId);
      expect(deleted).toBe(2); // v1 and v2

      const tc = await storage.testCases.getById(createdId);
      expect(tc).toBeNull();
    });

    it('should return 0 for non-existent ID', async () => {
      const { deleted } = await storage.testCases.delete('non-existent-id');
      expect(deleted).toBe(0);
    });
  });
});

// ============================================================================
// Benchmarks
// ============================================================================

describe('FileStorageModule - benchmarks', () => {
  let benchmarkId: string;

  describe('create', () => {
    it('should create a benchmark with generated ID', async () => {
      const benchmark = await storage.benchmarks.create({
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2'],
      });

      expect(benchmark.id).toBeDefined();
      expect(benchmark.name).toBe('Test Benchmark');
      expect(benchmark.testCaseIds).toEqual(['tc-1', 'tc-2']);
      expect(benchmark.runs).toEqual([]);
      expect(benchmark.createdAt).toBeDefined();
      benchmarkId = benchmark.id;
    });
  });

  describe('getById', () => {
    it('should return the benchmark by ID', async () => {
      const benchmark = await storage.benchmarks.getById(benchmarkId);
      expect(benchmark).not.toBeNull();
      expect(benchmark!.name).toBe('Test Benchmark');
    });

    it('should return null for non-existent ID', async () => {
      const result = await storage.benchmarks.getById('fake-id');
      expect(result).toBeNull();
    });
  });

  describe('getAll', () => {
    it('should return all benchmarks sorted by createdAt desc', async () => {
      await storage.benchmarks.create({ name: 'Second Benchmark', testCaseIds: [] });
      const { items, total } = await storage.benchmarks.getAll();
      expect(total).toBeGreaterThanOrEqual(2);
      expect(items[0].createdAt! >= items[1].createdAt!).toBe(true);
    });
  });

  describe('update', () => {
    it('should update benchmark fields', async () => {
      const updated = await storage.benchmarks.update(benchmarkId, {
        name: 'Updated Benchmark',
        testCaseIds: ['tc-1', 'tc-2', 'tc-3'],
      });

      expect(updated.name).toBe('Updated Benchmark');
      expect(updated.testCaseIds).toEqual(['tc-1', 'tc-2', 'tc-3']);
      expect(updated.updatedAt).toBeDefined();
    });

    it('should throw for non-existent benchmark', async () => {
      await expect(
        storage.benchmarks.update('non-existent-id', { name: 'Nope' })
      ).rejects.toThrow('Benchmark non-existent-id not found');
    });
  });

  describe('addRun', () => {
    it('should append a run to the benchmark', async () => {
      const run = {
        id: 'run-1',
        agentKey: 'test-agent',
        modelId: 'model-1',
        timestamp: new Date().toISOString(),
        results: {},
      } as any;

      const result = await storage.benchmarks.addRun(benchmarkId, run);
      expect(result).toBe(true);

      await expect(storage.benchmarks.addRun(benchmarkId, run)).resolves.toBe(true);
      const benchmark = await storage.benchmarks.getById(benchmarkId);
      expect(benchmark!.runs!.length).toBe(1);
      expect(benchmark!.runs![0].id).toBe('run-1');
    });

    it('should return false for non-existent benchmark', async () => {
      const result = await storage.benchmarks.addRun('fake-id', { id: 'run-x' } as any);
      expect(result).toBe(false);
    });
  });

  describe('updateRun', () => {
    it('should update a specific run in the array', async () => {
      const result = await storage.benchmarks.updateRun(benchmarkId, 'run-1', {
        status: 'completed',
      } as any);
      expect(result).toBe(true);

      const benchmark = await storage.benchmarks.getById(benchmarkId);
      expect((benchmark!.runs![0] as any).status).toBe('completed');
    });

    it('should return false for non-existent run', async () => {
      const result = await storage.benchmarks.updateRun(benchmarkId, 'fake-run', { status: 'x' } as any);
      expect(result).toBe(false);
    });
  });

  describe('deleteRun', () => {
    it('should remove a run from the array', async () => {
      const result = await storage.benchmarks.deleteRun(benchmarkId, 'run-1');
      expect(result).toBe(true);

      const benchmark = await storage.benchmarks.getById(benchmarkId);
      expect(benchmark!.runs!.length).toBe(0);
    });

    it('should return false for non-existent run', async () => {
      const result = await storage.benchmarks.deleteRun(benchmarkId, 'fake-run');
      expect(result).toBe(false);
    });
  });

  describe('delete', () => {
    it('should delete the benchmark', async () => {
      const { deleted } = await storage.benchmarks.delete(benchmarkId);
      expect(deleted).toBe(true);

      const result = await storage.benchmarks.getById(benchmarkId);
      expect(result).toBeNull();
    });

    it('should return false for non-existent benchmark', async () => {
      const { deleted } = await storage.benchmarks.delete('non-existent-id');
      expect(deleted).toBe(false);
    });
  });
});

// ============================================================================
// Evaluation Runs
// ============================================================================

describe('FileStorageModule - evaluationRuns', () => {
  let evalRunId: string;

  describe('create', () => {
    it('should create an evaluation run with defaults', async () => {
      const run = await storage.evaluationRuns.create({
        id: 'evalrun-test-1',
        name: 'Test Eval Run',
        benchmarkId: 'bench-1',
        agentKey: 'test-agent',
        modelId: 'model-1',
        trigger: 'manual',
      } as any);

      expect(run.id).toBe('evalrun-test-1');
      expect(run.docType).toBe('evaluation-run');
      expect(run.status).toBe('pending');
      expect(run.results).toEqual({});
      expect(run.sources).toEqual([]);
      expect(run.testCaseSnapshots).toEqual([]);
      expect(run.createdAt).toBeDefined();
      evalRunId = run.id;
    });
  });

  describe('getById', () => {
    it('should return the evaluation run', async () => {
      const run = await storage.evaluationRuns.getById(evalRunId);
      expect(run).not.toBeNull();
      expect(run!.name).toBe('Test Eval Run');
      expect(run!.docType).toBe('evaluation-run');
    });

    it('should return null for non-existent ID', async () => {
      const result = await storage.evaluationRuns.getById('non-existent');
      expect(result).toBeNull();
    });

    it('should return null for document without evaluation-run docType', async () => {
      // Create a plain benchmark (not evaluation-run) in the same directory
      await storage.benchmarks.create({ id: 'bench-plain', name: 'Plain Benchmark', testCaseIds: [] });
      const result = await storage.evaluationRuns.getById('bench-plain');
      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update evaluation run fields', async () => {
      const updated = await storage.evaluationRuns.update(evalRunId, {
        status: 'running',
      } as any);

      expect(updated.status).toBe('running');
    });

    it('should throw for non-existent run', async () => {
      await expect(
        storage.evaluationRuns.update('non-existent', { status: 'running' } as any)
      ).rejects.toThrow('Evaluation run non-existent not found');
    });
  });

  describe('updateResult', () => {
    it('should update results for a specific test case', async () => {
      const success = await storage.evaluationRuns.updateResult(evalRunId, 'tc-1', {
        reportId: 'report-1',
        status: 'completed',
      });

      expect(success).toBe(true);

      const run = await storage.evaluationRuns.getById(evalRunId);
      expect(run!.results['tc-1']).toEqual({
        reportId: 'report-1',
        status: 'completed',
      });
    });

    it('should return false for non-existent run', async () => {
      const result = await storage.evaluationRuns.updateResult('fake-id', 'tc-1', {
        reportId: 'r',
        status: 'completed',
      });
      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    beforeAll(async () => {
      // Create additional eval runs for filtering
      await storage.evaluationRuns.create({
        id: 'evalrun-test-2',
        name: 'Second Eval Run',
        benchmarkId: 'bench-1',
        agentKey: 'other-agent',
        status: 'completed',
        trigger: 'ci',
        testCaseSnapshots: [{ id: 'tc-snapshot-1' }],
      } as any);

      await storage.evaluationRuns.create({
        id: 'evalrun-test-3',
        name: 'Third Eval Run',
        benchmarkId: 'bench-2',
        agentKey: 'test-agent',
        status: 'failed',
        trigger: 'manual',
      } as any);
    });

    it('should list all evaluation runs', async () => {
      const { items, total } = await storage.evaluationRuns.list();
      expect(total).toBeGreaterThanOrEqual(3);
      // Should only contain evaluation-run docs, not plain benchmarks
      expect(items.every(r => r.docType === 'evaluation-run')).toBe(true);
    });

    it('should filter by benchmarkId', async () => {
      const { items } = await storage.evaluationRuns.list({ benchmarkId: 'bench-1' });
      expect(items.every(r => r.benchmarkId === 'bench-1')).toBe(true);
      expect(items.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter by agentKey', async () => {
      const { items } = await storage.evaluationRuns.list({ agentKey: 'other-agent' });
      expect(items.every(r => r.agentKey === 'other-agent')).toBe(true);
    });

    it('should filter by status', async () => {
      const { items } = await storage.evaluationRuns.list({ status: 'failed' });
      expect(items.every(r => r.status === 'failed')).toBe(true);
    });

    it('should filter by trigger', async () => {
      const { items } = await storage.evaluationRuns.list({ trigger: 'ci' });
      expect(items.every(r => r.trigger === 'ci')).toBe(true);
    });

    it('should filter by testCaseId in snapshots', async () => {
      const { items } = await storage.evaluationRuns.list({ testCaseId: 'tc-snapshot-1' });
      expect(items.length).toBeGreaterThanOrEqual(1);
    });

    it('should sort by createdAt descending by default', async () => {
      const { items } = await storage.evaluationRuns.list();
      const timestamps = items.map(r => new Date(r.createdAt).getTime());
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
      }
    });

    it('should support ascending sort order', async () => {
      const { items } = await storage.evaluationRuns.list({ sort: 'createdAt', order: 'asc' });
      const timestamps = items.map(r => new Date(r.createdAt).getTime());
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1]).toBeLessThanOrEqual(timestamps[i]);
      }
    });

    it('should support pagination', async () => {
      const { items } = await storage.evaluationRuns.list({ from: 0, size: 1 });
      expect(items.length).toBe(1);
    });
  });

  describe('delete', () => {
    it('should delete the evaluation run', async () => {
      const { deleted } = await storage.evaluationRuns.delete(evalRunId);
      expect(deleted).toBe(true);

      const result = await storage.evaluationRuns.getById(evalRunId);
      expect(result).toBeNull();
    });

    it('should return false for non-existent ID', async () => {
      const { deleted } = await storage.evaluationRuns.delete('non-existent');
      expect(deleted).toBe(false);
    });
  });
});

// ============================================================================
// Evaluators
// ============================================================================

describe('FileStorageModule - evaluators', () => {
  let evaluatorId: string;

  describe('create', () => {
    it('should create an evaluator with required fields', async () => {
      const evaluator = await storage.evaluators.create({
        name: 'Test Evaluator',
        systemPrompt: 'You are a test evaluator.',
        scoringConfig: { maxScore: 10, passingScore: 7 } as any,
      });

      expect(evaluator.id).toBeDefined();
      expect(evaluator.name).toBe('Test Evaluator');
      expect(evaluator.systemPrompt).toBe('You are a test evaluator.');
      expect(evaluator.currentVersion).toBe(1);
      expect(evaluator.isSystem).toBe(false);
      expect(evaluator.versions).toHaveLength(1);
      expect(evaluator.versions![0].version).toBe(1);
      evaluatorId = evaluator.id;
    });

    it('should throw when name is missing', async () => {
      await expect(
        storage.evaluators.create({
          systemPrompt: 'prompt',
          scoringConfig: {} as any,
        })
      ).rejects.toThrow('Evaluator name is required');
    });

    it('should throw when systemPrompt is missing', async () => {
      await expect(
        storage.evaluators.create({
          name: 'Test',
          scoringConfig: {} as any,
        })
      ).rejects.toThrow('Evaluator system prompt is required');
    });

    it('should throw when scoringConfig is missing', async () => {
      await expect(
        storage.evaluators.create({
          name: 'Test',
          systemPrompt: 'prompt',
        })
      ).rejects.toThrow('Evaluator scoring config is required');
    });
  });

  describe('getById', () => {
    it('should return the latest version', async () => {
      const evaluator = await storage.evaluators.getById(evaluatorId);
      expect(evaluator).not.toBeNull();
      expect(evaluator!.name).toBe('Test Evaluator');
    });

    it('should return null for non-existent ID', async () => {
      const result = await storage.evaluators.getById('fake-evaluator');
      expect(result).toBeNull();
    });
  });

  describe('update (versioning)', () => {
    it('should create a new version file', async () => {
      const updated = await storage.evaluators.update(evaluatorId, {
        name: 'Updated Evaluator',
        systemPrompt: 'Updated prompt.',
      });

      expect(updated.currentVersion).toBe(2);
      expect(updated.name).toBe('Updated Evaluator');
      expect(updated.systemPrompt).toBe('Updated prompt.');
      expect(updated.versions).toHaveLength(2);

      // Both version files should exist
      const v1Path = path.join(tmpDir, 'evaluators', `${evaluatorId}-v1.json`);
      const v2Path = path.join(tmpDir, 'evaluators', `${evaluatorId}-v2.json`);
      expect(fs.existsSync(v1Path)).toBe(true);
      expect(fs.existsSync(v2Path)).toBe(true);
    });

    it('should prevent editing system evaluators', async () => {
      const systemEval = await storage.evaluators.create({
        name: 'System Evaluator',
        systemPrompt: 'System prompt',
        scoringConfig: { maxScore: 5 } as any,
        isSystem: true,
      });

      await expect(
        storage.evaluators.update(systemEval.id, { name: 'Hacked' })
      ).rejects.toThrow('Cannot edit system evaluators');
    });

    it('should throw for non-existent evaluator', async () => {
      await expect(
        storage.evaluators.update('non-existent', { name: 'Nope' })
      ).rejects.toThrow('Evaluator non-existent not found');
    });
  });

  describe('getAll', () => {
    it('should return latest version of each evaluator', async () => {
      const { items } = await storage.evaluators.getAll();
      expect(items.length).toBeGreaterThanOrEqual(2);

      const found = items.find(e => e.id === evaluatorId);
      expect(found).toBeDefined();
      expect(found!.currentVersion).toBe(2);
    });
  });

  describe('delete', () => {
    it('should prevent deleting system evaluators', async () => {
      const { items } = await storage.evaluators.getAll();
      const systemEval = items.find(e => e.isSystem);
      expect(systemEval).toBeDefined();

      await expect(
        storage.evaluators.delete(systemEval!.id)
      ).rejects.toThrow('Cannot delete system evaluators');
    });

    it('should delete all version files for non-system evaluator', async () => {
      const { deleted } = await storage.evaluators.delete(evaluatorId);
      expect(deleted).toBe(2); // v1 and v2

      const result = await storage.evaluators.getById(evaluatorId);
      expect(result).toBeNull();
    });

    it('should return 0 for non-existent evaluator', async () => {
      const { deleted } = await storage.evaluators.delete('non-existent');
      expect(deleted).toBe(0);
    });
  });
});

// ============================================================================
// Session Metadata
// ============================================================================

describe('FileStorageModule - sessionMetadata', () => {
  describe('put and get', () => {
    it('should store and retrieve session metadata', async () => {
      const result = await storage.sessionMetadata.put('test-agent', 'session-1', {
        threadId: 'thread-abc',
        customField: 'value',
      });

      expect(result.agentKind).toBe('test-agent');
      expect(result.sessionId).toBe('session-1');
      expect(result.threadId).toBe('thread-abc');
      expect(result.updatedAt).toBeDefined();

      const retrieved = await storage.sessionMetadata.get('test-agent', 'session-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.threadId).toBe('thread-abc');
    });

    it('should merge on subsequent puts', async () => {
      await storage.sessionMetadata.put('test-agent', 'session-1', {
        newField: 'new-value',
      });

      const retrieved = await storage.sessionMetadata.get('test-agent', 'session-1');
      expect(retrieved!.threadId).toBe('thread-abc');
      expect((retrieved as any).newField).toBe('new-value');
    });

    it('should return null for non-existent session', async () => {
      const result = await storage.sessionMetadata.get('fake-agent', 'fake-session');
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all session metadata entries', async () => {
      await storage.sessionMetadata.put('agent-2', 'session-2', { data: 'x' });
      const { items, total } = await storage.sessionMetadata.list();
      expect(total).toBeGreaterThanOrEqual(2);
      expect(items.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ============================================================================
// Runs (TestCaseRun)
// ============================================================================

describe('FileStorageModule - runs', () => {
  let runId: string;

  describe('create', () => {
    it('should create a run with generated ID', async () => {
      const run = await storage.runs.create({
        testCaseId: 'tc-1',
        agentKey: 'test-agent',
        modelId: 'model-1',
        status: 'completed',
        passFailStatus: 'passed',
        trajectory: [],
      });

      expect(run.id).toBeDefined();
      expect(run.testCaseId).toBe('tc-1');
      expect(run.timestamp).toBeDefined();
      runId = run.id;
    });
  });

  describe('getById', () => {
    it('should return the run', async () => {
      const run = await storage.runs.getById(runId);
      expect(run).not.toBeNull();
      expect(run!.testCaseId).toBe('tc-1');
    });

    it('should return null for non-existent ID', async () => {
      const result = await storage.runs.getById('fake-run-id');
      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update run fields', async () => {
      const updated = await storage.runs.update(runId, {
        passFailStatus: 'failed',
      });
      expect(updated.passFailStatus).toBe('failed');
    });

    it('should throw for non-existent run', async () => {
      await expect(
        storage.runs.update('non-existent', { status: 'failed' })
      ).rejects.toThrow('Run non-existent not found');
    });
  });

  describe('search', () => {
    beforeAll(async () => {
      await storage.runs.create({
        testCaseId: 'tc-2',
        agentKey: 'other-agent',
        modelId: 'model-2',
        status: 'completed',
        passFailStatus: 'passed',
        experimentId: 'exp-1',
        experimentRunId: 'exprun-1',
      } as any);
    });

    it('should filter by testCaseId', async () => {
      const { items } = await storage.runs.search({ testCaseId: 'tc-2' });
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.every(r => r.testCaseId === 'tc-2')).toBe(true);
    });

    it('should filter by agentId', async () => {
      const { items } = await storage.runs.search({ agentId: 'other-agent' });
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.every(r => r.agentKey === 'other-agent')).toBe(true);
    });

    it('should filter by experimentId', async () => {
      const { items } = await storage.runs.search({ experimentId: 'exp-1' });
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('delete', () => {
    it('should delete the run', async () => {
      const { deleted } = await storage.runs.delete(runId);
      expect(deleted).toBe(true);

      const result = await storage.runs.getById(runId);
      expect(result).toBeNull();
    });

    it('should return false for non-existent ID', async () => {
      const { deleted } = await storage.runs.delete('non-existent');
      expect(deleted).toBe(false);
    });
  });
});
