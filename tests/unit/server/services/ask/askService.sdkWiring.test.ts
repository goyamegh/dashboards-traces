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
const mockConfig = jest.fn(() => ({ assistant: {} }));
jest.mock('@/lib/config/index', () => ({ loadConfigSync: () => mockConfig() }));

describe('askService — pi SDK wiring (read-only by construction)', () => {
  let createAgentSession: jest.Mock;
  let resourceLoaderOpts: any;
  let sessionCreate: jest.Mock;
  let sessionOpen: jest.Mock;
  let prompted: string[];
  let appendedCustom: Array<[string, unknown]>;
  let promptGate: (() => void) | null;
  let getById: jest.Mock;
  let fakeSm: any;

  beforeEach(() => {
    jest.resetModules();
    resourceLoaderOpts = undefined;
    prompted = [];
    appendedCustom = [];
    mockConfig.mockReturnValue({ assistant: {} });
    promptGate = null;
    fakeSm = {
      getSessionId: () => 'ask-test-session',
      getSessionFile: () => '/tmp/ask-sessions/x_ask-test-session.jsonl',
      getEntries: () => [],
      getSessionName: () => undefined,
      getHeader: () => null,
      appendCustomEntry: (t: string, d: unknown) => { appendedCustom.push([t, d]); return 'id'; },
      appendSessionInfo: jest.fn(() => 'id'),
    };
    sessionCreate = jest.fn(() => fakeSm);
    sessionOpen = jest.fn(() => ({ ...fakeSm, getSessionId: () => 'ask-from-disk', getEntries: () => [{ type: 'custom', customType: 'agent-health.ask', data: { page: { route: '/runs/report-1' }, selections: [], createdAt: 'x' } }, { type: 'custom', customType: 'agent-health.ask.turn', data: { id: 't0', question: 'earlier', answer: 'said', selections: [], startedAt: 'x', toolCalls: [] } }] }));
    createAgentSession = jest.fn(async () => ({
      session: {
        prompt: jest.fn(async (p: string) => {
          prompted.push(p);
          if (promptGate) await new Promise<void>((r) => { promptGate = r; });
        }),
        subscribe: jest.fn((l: any) => { l({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'the ' } }); l({ type: 'tool_execution_start', toolName: 'get_report' }); l({ type: 'tool_execution_end', toolName: 'get_report' }); return () => {}; }),
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'the answer' }] }],
      },
    }));
    getById = jest.fn(async (id: string) => (id === 'report-1' ? { id: 'report-1', testCaseId: 'tc-1', passFailStatus: 'failed', trajectory: [] } : null));
    jest.doMock(
      '@earendil-works/pi-coding-agent',
      () => ({
        createAgentSession,
        SessionManager: { create: sessionCreate, open: sessionOpen, inMemory: jest.fn() },
        ModelRuntime: { create: jest.fn(async () => ({ getAvailable: jest.fn(async () => [mockModel]) })) },
        DefaultResourceLoader: jest.fn().mockImplementation((opts: any) => { resourceLoaderOpts = opts; return { reload: jest.fn(async () => {}) }; }),
        getAgentDir: jest.fn(() => '/tmp/mock-agent-dir'),
      }),
      { virtual: true }
    );
    jest.doMock('@/lib/debug', () => ({ debug: jest.fn() }));
    jest.doMock('@/server/adapters/index', () => ({
      getStorageModule: () => ({
        runs: { getById: (id: string) => getById(id), getByExperimentRun: async () => [] },
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

  function ask(streamAsk: any, req: any) {
    const events: any[] = [];
    const done = new Promise<any>((resolve) => {
      streamAsk(req, {
        onMeta: (m: any) => events.push(['meta', m]),
        onDelta: (d: string) => events.push(['delta', d]),
        onTool: (t: any) => events.push(['tool', t]),
        onDone: (r: any) => resolve({ ...r, events }),
        onError: (e: string) => resolve({ error: e, events }),
      });
    });
    return done;
  }

  it('prepareAsk builds the snapshot + pi session once; the first ask reuses them (prepared: true) and never re-reads storage', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { prepareAsk, streamAsk, resetAskServiceState } = require('@/server/services/ask/askService');
    resetAskServiceState();
    const p = await prepareAsk({ pageContext: { route: '/runs/report-1' }, selections: [{ text: 'hl' }] });
    expect(p).toMatchObject({ sessionId: 'ask-test-session', loaded: ['report report-1'], model: `${mockModel.provider}/${mockModel.id}` });
    expect(getById).toHaveBeenCalledTimes(1);
    expect(createAgentSession).toHaveBeenCalledTimes(1);

    const r = await ask(streamAsk, { question: 'why?', selections: [{ text: 'hl' }], pageContext: { route: '/runs/report-1' }, sessionId: p.sessionId });
    expect(r.answer).toBe('the answer');
    expect(r.events[0][1]).toMatchObject({ sessionId: 'ask-test-session', prepared: true, loaded: ['report report-1'] });
    expect(r.events.filter((e: any) => e[0] === 'delta').map((e: any) => e[1])).toEqual(['the ']);
    expect(r.toolCalls).toEqual(['get_report']);
    expect(getById).toHaveBeenCalledTimes(1); // no second snapshot
    expect(createAgentSession).toHaveBeenCalledTimes(1); // same pi session
    expect(prompted[0]).toContain('## Data snapshot');

    // follow-up on the same page: no snapshot, pi has it in context
    const r2 = await ask(streamAsk, { question: 'and?', pageContext: { route: '/runs/report-1' }, sessionId: p.sessionId });
    expect(r2.answer).toBe('the answer');
    expect(prompted[1]).toContain('Follow-up: the data snapshot from earlier');
    expect(prompted[1]).not.toContain('## Data snapshot');
    expect(getById).toHaveBeenCalledTimes(1);
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('an unknown sessionId that exists on disk is re-opened through pi (restart) and continues without a snapshot', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { streamAsk, resetAskServiceState } = require('@/server/services/ask/askService');
    resetAskServiceState();
    const fs = require('fs');
    fs.mkdirSync('/tmp/ask-proto-unit-sessions', { recursive: true });
    fs.writeFileSync('/tmp/ask-proto-unit-sessions/2026_ask-from-disk.jsonl', '');
    try {
      const r = await ask(streamAsk, { question: 'repeat', pageContext: { route: '/runs/report-1' }, sessionId: 'ask-from-disk' });
      expect(r.answer).toBe('the answer');
      expect(sessionOpen).toHaveBeenCalledWith('/tmp/ask-proto-unit-sessions/2026_ask-from-disk.jsonl', '/tmp/ask-proto-unit-sessions');
      expect(createAgentSession.mock.calls[0][0].sessionManager.getSessionId()).toBe('ask-from-disk');
      expect(r.events[0][1]).toMatchObject({ sessionId: 'ask-from-disk', prepared: false, loaded: [] });
      expect(prompted[0]).toContain('Follow-up');
      const missing = await ask(streamAsk, { question: 'x', pageContext: { route: '/' }, sessionId: 'ask-nope' });
      expect(missing.error).toMatch(/not found/);
    } finally {
      fs.rmSync('/tmp/ask-proto-unit-sessions', { recursive: true, force: true });
      delete process.env.AH_ASK_SESSIONS_DIR;
    }
  });

  it('maxConcurrent caps simultaneous answers with AskBusyError; the slot is released afterwards', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    mockConfig.mockReturnValue({ assistant: { maxConcurrent: 1 } });
    const { streamAsk, resetAskServiceState, askInFlight } = require('@/server/services/ask/askService');
    resetAskServiceState();
    promptGate = () => {}; // first prompt blocks until released
    const first = ask(streamAsk, { question: 'slow', pageContext: { route: '/' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(askInFlight()).toBe(1);
    const second = await ask(streamAsk, { question: 'fast', pageContext: { route: '/' } });
    expect(second.error).toMatch(/already answering 1 question;/);
    (promptGate as () => void)();
    const r1 = await first;
    expect(r1.answer).toBe('the answer');
    expect(askInFlight()).toBe(0);
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('the registered tools are plain GETs (and the traces POST) against this server and never anything else', async () => {
    const { createAskToolsExtension } = require('@/server/services/ask/askService');
    const calls: Array<[string, any]> = [];
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ run: { id: 'r', trajectory: [{ type: 'assistant', content: 'x'.repeat(2000) }], rawEvents: [1] }, evaluationRun: { id: 'e', results: { tc: { reportId: 'r' } }, testCaseSnapshots: [{ id: 'tc', name: 'case' }] }, testCase: { id: 'tc', sourceCode: 'secret' }, benchmark: { id: 'b', runs: [{ id: 'x', stats: {} }] }, spans: [{ spanId: 's', name: 'llm_request', attributes: {} }], correlation: { strategy: 'traceId' } }) };
    });
    const tools: Record<string, any> = {};
    createAskToolsExtension('http://localhost:5381')({ registerTool: (d: any) => { tools[d.name] = d; } });
    const report = await tools.get_report.execute('id', { reportId: 'r/../x' });
    expect(calls[0][0]).toBe('http://localhost:5381/api/storage/runs/r%2F..%2Fx');
    expect(report.details.rawEvents).toBeUndefined();
    expect(report.details.trajectory[0].content).toHaveLength(1500);
    const run = await tools.get_evaluation_run.execute('id', { runId: 'e' });
    expect(run.details.results.tc.testCase).toBe('case');
    const tc = await tools.get_test_case.execute('id', { testCaseId: 'tc' });
    expect(tc.details.sourceCode).toBeUndefined();
    await tools.get_benchmark.execute('id', { benchmarkId: 'b' });
    const spans = await tools.query_spans.execute('id', { traceId: 'abc', nameFilter: 'LLM' });
    expect(spans.details.spanCount).toBe(1);
    const noArgs = await tools.query_spans.execute('id', {});
    expect(noArgs.details.error).toMatch(/Provide traceId/);
    for (const [url, init] of calls) {
      expect(url.startsWith('http://localhost:5381/api/')).toBe(true);
      expect(init?.method ?? 'GET').toBe(url.endsWith('/api/traces') ? 'POST' : 'GET');
    }
  });
});
