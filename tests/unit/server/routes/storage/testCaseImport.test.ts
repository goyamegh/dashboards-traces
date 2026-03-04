/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import testCasesRoutes from '@/server/routes/storage/testCases';

// Mock the adapters module
jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn(),
}));

import { getStorageModule } from '@/server/adapters/index';

// Mock sample test cases
jest.mock('@/cli/demo/sampleTestCases', () => ({
  SAMPLE_TEST_CASES: [],
}));

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Create mock storage module
function createMockStorage() {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    testCases: {
      getAll: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getById: jest.fn().mockResolvedValue(null),
      getVersions: jest.fn().mockResolvedValue([]),
      getVersion: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      bulkCreate: jest.fn(),
      search: jest.fn(),
    },
    benchmarks: {},
    runs: {},
    analytics: {},
    health: jest.fn(),
  };
}

// Helper to create mock request/response
function createMocks(params: any = {}, body: any = {}, query: any = {}) {
  const req = {
    params,
    body,
    query,
  } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

// Helper to get route handler
function getRouteHandler(router: any, method: string, path: string) {
  const routes = router.stack;
  const route = routes.find(
    (layer: any) =>
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
  );
  return route?.route.stack[0].handle;
}

describe('POST /api/storage/test-cases/import', () => {
  let mockStorage: ReturnType<typeof createMockStorage>;
  let handler: Function;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage = createMockStorage();
    (getStorageModule as jest.Mock).mockReturnValue(mockStorage);
    handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases/import');
  });

  it('should reject non-array input', async () => {
    const { req, res } = createMocks({}, { testCases: 'not-an-array' });
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'testCases must be an array' });
  });

  it('should return empty result for empty array', async () => {
    const { req, res } = createMocks({}, { testCases: [] });
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      created: 0,
      reused: 0,
      updated: 0,
      testCases: [],
    });
  });

  it('should reject test cases with demo- prefix', async () => {
    const { req, res } = createMocks({}, {
      testCases: [{ id: 'demo-test', name: 'Bad' }],
    });
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('demo- prefix') })
    );
  });

  it('should create new test cases when no name match', async () => {
    mockStorage.testCases.getAll.mockResolvedValue({ items: [], total: 0 });
    mockStorage.testCases.create
      .mockResolvedValueOnce({ id: 'tc-new-1', name: 'Test Case A' })
      .mockResolvedValueOnce({ id: 'tc-new-2', name: 'Test Case B' });

    const { req, res } = createMocks({}, {
      testCases: [
        { name: 'Test Case A', initialPrompt: 'prompt A', expectedOutcomes: ['outcome A'] },
        { name: 'Test Case B', initialPrompt: 'prompt B', expectedOutcomes: ['outcome B'] },
      ],
    });
    await handler(req, res);

    expect(mockStorage.testCases.create).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith({
      created: 2,
      reused: 0,
      updated: 0,
      testCases: [
        { id: 'tc-new-1', name: 'Test Case A', status: 'created' },
        { id: 'tc-new-2', name: 'Test Case B', status: 'created' },
      ],
    });
  });

  it('should reuse test cases with identical name and content', async () => {
    mockStorage.testCases.getAll.mockResolvedValue({
      items: [
        {
          id: 'tc-existing-1',
          name: 'Existing Test',
          initialPrompt: 'same prompt',
          expectedOutcomes: ['outcome 1', 'outcome 2'],
        },
      ],
      total: 1,
    });

    const { req, res } = createMocks({}, {
      testCases: [
        { name: 'Existing Test', initialPrompt: 'same prompt', expectedOutcomes: ['outcome 2', 'outcome 1'] },
      ],
    });
    await handler(req, res);

    expect(mockStorage.testCases.create).not.toHaveBeenCalled();
    expect(mockStorage.testCases.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      created: 0,
      reused: 1,
      updated: 0,
      testCases: [
        { id: 'tc-existing-1', name: 'Existing Test', status: 'reused' },
      ],
    });
  });

  it('should update test cases with same name but different content', async () => {
    mockStorage.testCases.getAll.mockResolvedValue({
      items: [
        {
          id: 'tc-existing-1',
          name: 'Existing Test',
          initialPrompt: 'old prompt',
          expectedOutcomes: ['old outcome'],
        },
      ],
      total: 1,
    });
    mockStorage.testCases.update.mockResolvedValue({
      id: 'tc-existing-1',
      name: 'Existing Test',
      version: 2,
    });

    const { req, res } = createMocks({}, {
      testCases: [
        { name: 'Existing Test', initialPrompt: 'new prompt', expectedOutcomes: ['new outcome'] },
      ],
    });
    await handler(req, res);

    expect(mockStorage.testCases.update).toHaveBeenCalledWith('tc-existing-1', expect.objectContaining({
      name: 'Existing Test',
      initialPrompt: 'new prompt',
    }));
    expect(res.json).toHaveBeenCalledWith({
      created: 0,
      reused: 0,
      updated: 1,
      testCases: [
        { id: 'tc-existing-1', name: 'Existing Test', status: 'updated' },
      ],
    });
  });

  it('should handle mixed batch: created, reused, updated', async () => {
    mockStorage.testCases.getAll.mockResolvedValue({
      items: [
        {
          id: 'tc-1',
          name: 'Unchanged',
          initialPrompt: 'same',
          expectedOutcomes: ['same'],
        },
        {
          id: 'tc-2',
          name: 'Modified',
          initialPrompt: 'old',
          expectedOutcomes: ['old'],
        },
      ],
      total: 2,
    });
    mockStorage.testCases.create.mockResolvedValue({ id: 'tc-3', name: 'Brand New' });
    mockStorage.testCases.update.mockResolvedValue({ id: 'tc-2', name: 'Modified', version: 2 });

    const { req, res } = createMocks({}, {
      testCases: [
        { name: 'Unchanged', initialPrompt: 'same', expectedOutcomes: ['same'] },
        { name: 'Modified', initialPrompt: 'new', expectedOutcomes: ['new'] },
        { name: 'Brand New', initialPrompt: 'fresh', expectedOutcomes: ['fresh'] },
      ],
    });
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      created: 1,
      reused: 1,
      updated: 1,
      testCases: [
        { id: 'tc-1', name: 'Unchanged', status: 'reused' },
        { id: 'tc-2', name: 'Modified', status: 'updated' },
        { id: 'tc-3', name: 'Brand New', status: 'created' },
      ],
    });
  });

  it('should use case-insensitive name matching', async () => {
    mockStorage.testCases.getAll.mockResolvedValue({
      items: [
        {
          id: 'tc-1',
          name: 'My Test Case',
          initialPrompt: 'prompt',
          expectedOutcomes: ['outcome'],
        },
      ],
      total: 1,
    });

    const { req, res } = createMocks({}, {
      testCases: [
        { name: 'my test case', initialPrompt: 'prompt', expectedOutcomes: ['outcome'] },
      ],
    });
    await handler(req, res);

    expect(mockStorage.testCases.create).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reused: 1 })
    );
  });

  it('should detect content change when expectedOutcomes differ', async () => {
    mockStorage.testCases.getAll.mockResolvedValue({
      items: [
        {
          id: 'tc-1',
          name: 'Test',
          initialPrompt: 'prompt',
          expectedOutcomes: ['outcome A'],
        },
      ],
      total: 1,
    });
    mockStorage.testCases.update.mockResolvedValue({ id: 'tc-1', name: 'Test', version: 2 });

    const { req, res } = createMocks({}, {
      testCases: [
        { name: 'Test', initialPrompt: 'prompt', expectedOutcomes: ['outcome A', 'outcome B'] },
      ],
    });
    await handler(req, res);

    expect(mockStorage.testCases.update).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ updated: 1 })
    );
  });

  it('should detect content change when initialPrompt differs', async () => {
    mockStorage.testCases.getAll.mockResolvedValue({
      items: [
        {
          id: 'tc-1',
          name: 'Test',
          initialPrompt: 'old prompt',
          expectedOutcomes: ['outcome'],
        },
      ],
      total: 1,
    });
    mockStorage.testCases.update.mockResolvedValue({ id: 'tc-1', name: 'Test', version: 2 });

    const { req, res } = createMocks({}, {
      testCases: [
        { name: 'Test', initialPrompt: 'new prompt', expectedOutcomes: ['outcome'] },
      ],
    });
    await handler(req, res);

    expect(mockStorage.testCases.update).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ updated: 1 })
    );
  });

  it('should handle storage errors', async () => {
    mockStorage.testCases.getAll.mockRejectedValue(new Error('Storage down'));

    const { req, res } = createMocks({}, {
      testCases: [{ name: 'Test', initialPrompt: 'p', expectedOutcomes: ['o'] }],
    });
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Storage down' });
  });

  it('should handle duplicates within the same batch', async () => {
    mockStorage.testCases.getAll.mockResolvedValue({ items: [], total: 0 });
    mockStorage.testCases.create.mockResolvedValue({
      id: 'tc-new-1',
      name: 'Duplicate Name',
      initialPrompt: 'prompt',
      expectedOutcomes: ['outcome'],
    });

    const { req, res } = createMocks({}, {
      testCases: [
        { name: 'Duplicate Name', initialPrompt: 'prompt', expectedOutcomes: ['outcome'] },
        { name: 'Duplicate Name', initialPrompt: 'prompt', expectedOutcomes: ['outcome'] },
      ],
    });
    await handler(req, res);

    // First one created, second one reused (since first was added to map)
    expect(mockStorage.testCases.create).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({
      created: 1,
      reused: 1,
      updated: 0,
      testCases: [
        { id: 'tc-new-1', name: 'Duplicate Name', status: 'created' },
        { id: 'tc-new-1', name: 'Duplicate Name', status: 'reused' },
      ],
    });
  });
});
