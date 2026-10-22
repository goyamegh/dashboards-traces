/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the assistant's tool surface and its pi-SDK wiring. The READ-ONLY
 * guarantee is `tools: ASK_TOOLS` passed to `createAgentSession` — nothing
 * built-in (read/bash/edit/write), no MCP, no user extensions. If someone
 * widens the list, this test is what goes red.
 */

const mockModel = { provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-4-6' };

describe('askService — pi SDK wiring (read-only by construction)', () => {
  let createAgentSession: jest.Mock;
  let resourceLoaderOpts: any;
  let sessionCreate: jest.Mock;
  let prompted: string[];
  let appendedCustom: Array<[string, unknown]>;

  beforeEach(() => {
    jest.resetModules();
    resourceLoaderOpts = undefined;
    prompted = [];
    appendedCustom = [];
    const fakeSm = {
      getSessionId: () => 'ask-test-session',
      getSessionFile: () => '/tmp/ask-sessions/x_ask-test-session.jsonl',
      getEntries: () => [],
      getSessionName: () => undefined,
      getHeader: () => null,
      appendCustomEntry: (t: string, d: unknown) => { appendedCustom.push([t, d]); return 'id'; },
      appendSessionInfo: jest.fn(() => 'id'),
    };
    sessionCreate = jest.fn(() => fakeSm);
    createAgentSession = jest.fn(async () => ({
      session: {
        prompt: jest.fn(async (p: string) => { prompted.push(p); }),
        subscribe: jest.fn(() => () => {}),
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'the answer' }] }],
      },
    }));
    jest.doMock(
      '@earendil-works/pi-coding-agent',
      () => ({
        createAgentSession,
        SessionManager: { create: sessionCreate, open: jest.fn(), inMemory: jest.fn() },
        ModelRuntime: { create: jest.fn(async () => ({ getAvailable: jest.fn(async () => [mockModel]) })) },
        DefaultResourceLoader: jest.fn().mockImplementation((opts: any) => { resourceLoaderOpts = opts; return { reload: jest.fn(async () => {}) }; }),
        getAgentDir: jest.fn(() => '/tmp/mock-agent-dir'),
      }),
      { virtual: true }
    );
    jest.doMock('@/lib/debug', () => ({ debug: jest.fn() }));
    jest.doMock('@/server/adapters/index', () => ({
      getStorageModule: () => ({
        runs: { getById: async () => null, getByExperimentRun: async () => [] },
        evaluationRuns: { getById: async () => null },
        testCases: { getById: async () => null },
        benchmarks: { getById: async () => null },
      }),
    }));
  });

  afterEach(() => {
    jest.dontMock('@earendil-works/pi-coding-agent');
    jest.dontMock('@/lib/debug');
    jest.dontMock('@/server/adapters/index');
  });

  it('ASK_TOOLS is exactly the five read-only tools', () => {
    const { ASK_TOOLS } = require('@/server/services/ask/askService');
    expect([...ASK_TOOLS]).toEqual(['get_report', 'get_evaluation_run', 'get_test_case', 'get_benchmark', 'query_spans']);
  });

  it('createAgentSession gets tools: ASK_TOOLS (no built-ins), an isolated resource loader, and a FILE-backed pi session in the ask dir', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { streamAsk, ASK_TOOLS, resetAskServiceState } = require('@/server/services/ask/askService');
    resetAskServiceState();
    const done = await new Promise<any>((resolve, reject) => {
      streamAsk(
        { question: 'why?', selections: [{ text: 'hl' }], pageContext: { route: '/runs/report-1' } },
        { onMeta: () => {}, onDelta: () => {}, onTool: () => {}, onDone: resolve, onError: (e: string) => reject(new Error(e)) }
      );
    });
    expect(done.answer).toBe('the answer');

    expect(createAgentSession).toHaveBeenCalledTimes(1);
    const opts = createAgentSession.mock.calls[0][0];
    expect(opts.tools).toEqual([...ASK_TOOLS]);
    expect(opts.model).toEqual(mockModel);
    expect(opts.sessionManager).toBe(sessionCreate.mock.results[0].value);

    // pi session persisted by pi itself, in OUR directory (not ~/.pi/agent/sessions/<cwd>).
    expect(sessionCreate).toHaveBeenCalledWith(process.cwd(), '/tmp/ask-proto-unit-sessions', expect.objectContaining({ id: expect.stringMatching(/^ask-/) }));

    // Isolation: no user extensions / skills / prompt templates / context files; only our tools extension.
    expect(resourceLoaderOpts).toMatchObject({ noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    expect(resourceLoaderOpts.extensionFactories).toHaveLength(1);
    const registered: string[] = [];
    resourceLoaderOpts.extensionFactories[0]({ registerTool: (d: any) => registered.push(d.name) });
    expect(registered).toEqual([...ASK_TOOLS]);

    // The prompt carried the highlight + question; metadata rode along as pi custom entries.
    expect(prompted[0]).toContain('> hl');
    expect(prompted[0]).toContain('## Question\nwhy?');
    expect(appendedCustom.map(([t]) => t)).toEqual(['agent-health.ask', 'agent-health.ask.turn']);
    expect(appendedCustom[1][1]).toMatchObject({ question: 'why?', answer: 'the answer', selections: [{ text: 'hl' }] });
    delete process.env.AH_ASK_SESSIONS_DIR;
  });
});
