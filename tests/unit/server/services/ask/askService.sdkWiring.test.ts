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

  it('tool error paths: HTTP failures become {error} results, odd shapes pass through untouched, query_spans shapes runId/sessionId correlators', async () => {
    const { createAskToolsExtension } = require('@/server/services/ask/askService');
    const calls: Array<[string, any]> = [];
    let status = 404;
    let payload: any = {};
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      calls.push([url, init]);
      return { ok: status < 400, status, json: async () => payload };
    });
    const tools: Record<string, any> = {};
    createAskToolsExtension('http://localhost:5381')({ registerTool: (d: any) => { tools[d.name] = d; } });

    // 404s from our own API are reported, never thrown (the model sees the error text)
    expect((await tools.get_report.execute('id', { reportId: 'nope' })).details).toEqual({ error: 'HTTP 404 for /api/storage/runs/nope' });
    expect((await tools.get_evaluation_run.execute('id', { runId: 'nope' })).details).toEqual({ error: 'HTTP 404 for /api/storage/evaluation-runs/nope' });
    expect((await tools.get_test_case.execute('id', { testCaseId: 'nope' })).details).toEqual({ error: 'HTTP 404 for /api/storage/test-cases/nope' });
    expect((await tools.get_benchmark.execute('id', { benchmarkId: 'nope' })).details).toEqual({ error: 'HTTP 404 for /api/storage/benchmarks/nope?fields=full' });
    expect((await tools.query_spans.execute('id', { runId: 'r' })).details).toEqual({ error: 'traces query failed: HTTP 404' });

    // shapes without the optional fields: nothing to trim / rename
    status = 200;
    payload = { id: 'bare' };
    expect((await tools.get_report.execute('id', { reportId: 'r' })).details).toEqual({ id: 'bare' });
    expect((await tools.get_evaluation_run.execute('id', { runId: 'e' })).details).toEqual({ id: 'bare' });
    expect((await tools.get_benchmark.execute('id', { benchmarkId: 'b' })).details).toEqual({ id: 'bare' });
    payload = null;
    expect((await tools.get_test_case.execute('id', { testCaseId: 't' })).details).toBeNull();
    // a trajectory with non-string content / tool output is passed through; the benchmark's runs are capped to the last 30
    payload = { run: { trajectory: [{ type: 'tool_result', toolName: 'search', content: { a: 1 }, toolOutput: 'y'.repeat(2000), toolArgs: { q: 1 } }] } };
    const rep = (await tools.get_report.execute('id', { reportId: 'r' })).details;
    expect(rep.trajectory[0]).toEqual({ i: 0, type: 'tool_result', toolName: 'search', content: { a: 1 }, toolArgs: { q: 1 }, toolOutput: 'y'.repeat(1500) });
    payload = { benchmark: { runs: Array.from({ length: 40 }, (_, i) => ({ id: `run-${i}`, name: `n${i}`, stats: { passed: i }, extra: 'dropped' })) } };
    const bench = (await tools.get_benchmark.execute('id', { benchmarkId: 'b' })).details;
    expect(bench.runs).toHaveLength(30);
    expect(bench.runs[0].id).toBe('run-10');
    expect(bench.runs[0].extra).toBeUndefined();
    // an evaluation run whose results lack an entry for a snapshot still gets names for the ones it has
    payload = { evaluationRun: { id: 'e', testCaseSnapshots: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } };
    expect((await tools.get_evaluation_run.execute('id', { runId: 'e' })).details).toEqual({ id: 'e', results: {} });

    // query_spans: runId → runIds, sessionId → an agents hint; no `spans` array → empty, duration fallback
    payload = { correlation: { strategy: 'runIds' } };
    const empty = (await tools.query_spans.execute('id', { runId: 'run-1', sessionId: 'sess-1' })).details;
    expect(empty).toEqual({ correlation: { strategy: 'runIds' }, spanCount: 0, spans: [] });
    const body = JSON.parse(calls[calls.length - 1][1].body);
    expect(body).toMatchObject({ size: 300, runIds: ['run-1'], agents: [expect.objectContaining({ sessionId: 'sess-1', serviceName: 'unknown', startedAt: 0 })] });
    expect(body.traceId).toBeUndefined();
    payload = { spans: [{ spanId: 's1', name: 'chat', duration: 12, attributes: { 'gen_ai.operation.name': 'chat' } }, { spanId: 's2', name: 'execute_tool search', durationMs: 3 }] };
    const spans = (await tools.query_spans.execute('id', { traceId: 'abc' })).details;
    expect(spans.spanCount).toBe(2);
    expect(spans.spans[0]).toMatchObject({ spanId: 's1', durationMs: 12, attributes: { 'gen_ai.operation.name': 'chat' } });
    expect(spans.spans[1].durationMs).toBe(3);
    expect((await tools.query_spans.execute('id', { traceId: 'abc', nameFilter: 'tool' })).details.spans.map((x: any) => x.spanId)).toEqual(['s2']);
  });

  it('streamAsk failure modes: a thrown prompt releases the slot and reports the message; an empty answer is an error; abort suppresses callbacks; a busy session refuses a second question', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { streamAsk, prepareAsk, resetAskServiceState, askInFlight } = require('@/server/services/ask/askService');
    resetAskServiceState();

    // 1. the model call throws → onError with the message, slot released, session reusable
    createAgentSession.mockImplementationOnce(async () => ({
      session: { prompt: jest.fn(async () => { throw new Error('ThrottlingException: slow down'); }), subscribe: jest.fn(() => () => {}), messages: [] },
    }));
    const failed = await ask(streamAsk, { question: 'q', pageContext: { route: '/' } });
    expect(failed.error).toBe('ThrottlingException: slow down');
    expect(askInFlight()).toBe(0);

    // 2. a turn that streams nothing and leaves no assistant text → "returned no text" error, recorded on the turn
    createAgentSession.mockImplementationOnce(async () => ({
      session: { prompt: jest.fn(async () => {}), subscribe: jest.fn(() => () => {}), messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x' }] }] },
    }));
    const empty = await ask(streamAsk, { question: 'q', pageContext: { route: '/' } });
    expect(empty.error).toBe('The assistant returned no text.');
    expect(appendedCustom.filter(([t]) => t === 'agent-health.ask.turn').pop()![1]).toMatchObject({ error: 'The assistant returned no text.', answer: '' });

    // 3. a second assistant message mid-turn separates paragraphs; a tool error is flagged; the streamed text is the answer when messages carry none
    createAgentSession.mockImplementationOnce(async () => ({
      session: {
        prompt: jest.fn(async () => {}),
        subscribe: jest.fn((l: any) => {
          l({ type: 'message_start', message: { role: 'assistant' } }); // first → nothing yet to separate
          l({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } }); // empty delta ignored
          l({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Part one.' } });
          l({ type: 'tool_execution_start', toolName: 'query_spans', args: { traceId: 't' } });
          l({ type: 'tool_execution_end', toolName: 'query_spans', isError: true });
          l({ type: 'message_start', message: { role: 'assistant' } });
          l({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Part two.' } });
          return () => {};
        }),
        messages: [],
      },
    }));
    const two = await ask(streamAsk, { question: 'q', pageContext: { route: '/' } });
    expect(two.answer).toBe('Part one.\n\nPart two.');
    expect(two.events.filter((e: any) => e[0] === 'delta').map((e: any) => e[1])).toEqual(['Part one.', '\n\n', 'Part two.']);
    expect(two.events.filter((e: any) => e[0] === 'tool').map((e: any) => e[1])).toEqual([
      { name: 'query_spans', status: 'start', args: { traceId: 't' } },
      { name: 'query_spans', status: 'end', isError: true },
    ]);
    expect(two.toolCalls).toEqual(['query_spans']);
    expect(two.firstTokenMs).toBeGreaterThanOrEqual(0);

    // 4. abort while the prompt is in flight → pi's abort is called, no done/error reaches the client, slot released
    const sessionAbort = jest.fn(async () => {});
    createAgentSession.mockImplementationOnce(async () => ({
      session: {
        prompt: jest.fn(async () => { await new Promise<void>((r) => { promptGate = r; }); }),
        subscribe: jest.fn((l: any) => { l({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }); return () => {}; }),
        abort: sessionAbort,
        messages: [],
      },
    }));
    const events: string[] = [];
    let settled = false;
    const handle = streamAsk({ question: 'q', pageContext: { route: '/' } }, {
      onMeta: () => events.push('meta'), onDelta: () => events.push('delta'), onTool: () => {},
      onDone: () => { settled = true; }, onError: () => { settled = true; },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['meta', 'delta']);
    handle.abort();
    expect(sessionAbort).toHaveBeenCalledTimes(1);
    (promptGate as () => void)();
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(askInFlight()).toBe(0);

    // 5. asking the same prepared session twice at once → the second is refused
    promptGate = () => {};
    const p = await prepareAsk({ pageContext: { route: '/' } });
    const first = ask(streamAsk, { question: 'one', pageContext: { route: '/' }, sessionId: p.sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const second = await ask(streamAsk, { question: 'two', pageContext: { route: '/' }, sessionId: p.sessionId });
    expect(second.error).toMatch(/still answering a previous question/);
    (promptGate as () => void)();
    expect((await first).answer).toBe('the answer');
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('an abort that lands while the snapshot is still being built releases the concurrency slot (no permanent 429)', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    mockConfig.mockReturnValue({ assistant: { maxConcurrent: 1 } });
    const { streamAsk, resetAskServiceState, askInFlight } = require('@/server/services/ask/askService');
    resetAskServiceState();
    // a slow storage read: the client gives up (closes the SSE) before the first byte
    let releaseStorage: (() => void) | null = null;
    getById.mockImplementationOnce(() => new Promise((r) => { releaseStorage = () => r({ id: 'report-1', testCaseId: 'tc-1', trajectory: [] }); }));
    const prompt = jest.fn(async () => {});
    createAgentSession.mockImplementationOnce(async () => ({ session: { prompt, subscribe: jest.fn(() => () => {}), messages: [] } }));
    const events: string[] = [];
    const handle = streamAsk({ question: 'q', pageContext: { route: '/runs/report-1' } }, {
      onMeta: () => events.push('meta'), onDelta: () => events.push('delta'), onTool: () => {}, onDone: () => events.push('done'), onError: (e: string) => events.push('error:' + e),
    });
    await new Promise((r) => setTimeout(r, 20));
    handle.abort();
    (releaseStorage as unknown as () => void)();
    await new Promise((r) => setTimeout(r, 30));
    expect(prompt).not.toHaveBeenCalled(); // the model was never invoked for an abandoned question
    expect(events).toEqual([]); // nothing reaches a client that left
    expect(askInFlight()).toBe(0); // the slot is free again …
    const next = await ask(streamAsk, { question: 'next', pageContext: { route: '/' } });
    expect(next.answer).toBe('the answer'); // … so the next question is answered, not 429'd
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('model selection: a provider-qualified or bare modelId pins the model, an unknown pin falls back to the newest Claude, and an empty registry is an error', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const sdk = require('@earendil-works/pi-coding-agent');
    const other = { provider: 'anthropic', id: 'claude-opus-4-1' };
    sdk.ModelRuntime.create = jest.fn(async () => ({ getAvailable: jest.fn(async () => [other, mockModel]) }));
    const { prepareAsk, resetAskServiceState } = require('@/server/services/ask/askService');
    resetAskServiceState();
    expect((await prepareAsk({ pageContext: { route: '/' }, modelId: 'anthropic/claude-opus-4-1' })).model).toBe('anthropic/claude-opus-4-1');
    expect((await prepareAsk({ pageContext: { route: '/' }, modelId: 'claude-opus-4-1' })).model).toBe('anthropic/claude-opus-4-1');
    expect((await prepareAsk({ pageContext: { route: '/' }, modelId: 'does-not-exist' })).model).toBe(`${mockModel.provider}/${mockModel.id}`);
    // the config pin is honoured when the request carries none
    mockConfig.mockReturnValue({ assistant: { model: 'anthropic/claude-opus-4-1' } });
    resetAskServiceState();
    expect((await prepareAsk({ pageContext: { route: '/' } })).model).toBe('anthropic/claude-opus-4-1');
    // a registry with no Claude still yields its newest model; an EMPTY registry (nothing credentialed) is a clear error, not a crash
    sdk.ModelRuntime.create = jest.fn(async () => ({ getAvailable: jest.fn(async () => [{ provider: 'openai', id: 'gpt-x' }]) }));
    mockConfig.mockReturnValue({ assistant: {} });
    resetAskServiceState();
    expect((await prepareAsk({ pageContext: { route: '/' } })).model).toBe('openai/gpt-x');
    sdk.ModelRuntime.create = jest.fn(async () => ({ getAvailable: jest.fn(async () => []) }));
    resetAskServiceState();
    await expect(prepareAsk({ pageContext: { route: '/' } })).rejects.toThrow(/no credentialed model/);
    delete process.env.AH_ASK_SESSIONS_DIR;
  });
});
