# Architecture Guide

This document describes the core architecture patterns in Agent Health. It serves as a reference to ensure architectural consistency across the codebase.

## System Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Agent Health                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────┐     HTTP API      ┌──────────────┐    ┌────────────┐ │
│  │   CLI    │ ─────────────────▶│    Server    │───▶│ OpenSearch │ │
│  └──────────┘                   │  (port 4001) │    │  Storage   │ │
│                                 └──────────────┘    └────────────┘ │
│                                        ▲                           │
│                                        │                           │
│  ┌──────────┐     HTTP API             │                           │
│  │ Browser  │ ─────────────────────────┘                           │
│  │   (UI)   │                                                      │
│  └──────────┘                                                      │
│                                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Principle: Server-Mediated Access

**All clients (CLI, UI) access OpenSearch through the server HTTP API.**

This pattern ensures:
1. **Single source of truth** - All business logic lives in server routes
2. **Consistent behavior** - CLI and UI always produce identical results
3. **Maintainability** - Add features once, both consumers get them
4. **Security** - Credentials never exposed to CLI or browser

**Never do this:**
```
CLI ──────────────────▶ OpenSearch   (WRONG: bypasses server)
```

**Always do this:**
```
CLI ────── HTTP ──────▶ Server ──────▶ OpenSearch   (CORRECT)
```

## Server Lifecycle (Playwright Pattern)

The CLI manages server lifecycle using a Playwright-inspired config pattern.

### Default Behavior (No Config File)

| Environment | Server Running? | Behavior |
|-------------|-----------------|----------|
| Development | Yes | Reuse existing server |
| Development | No | Start server, keep running after CLI exits |
| CI (`CI=true`) | Yes | Error (explicit failure) |
| CI (`CI=true`) | No | Start server, stop after CLI exits |

### Optional Config File

Create `agent-health.config.ts` only if you need to customize defaults:

```typescript
import { defineConfig } from '@opensearch-project/agent-health';

export default defineConfig({
  server: {
    port: 4001,                    // Default: 4001
    reuseExistingServer: true,     // Default: !process.env.CI
    startTimeout: 30000,           // Default: 30000 (30s)
  },

  // Other config sections...
  agents: [/* ... */],
  models: [/* ... */],
});
```

### Port Auto-Increment

When starting, both the standalone server (`npm run dev:server`) and the CLI (`npx @opensearch-project/agent-health`) automatically handle port conflicts. If the configured port (default 4001) is already in use, the server tries the next port (4002, 4003, etc.) up to 10 consecutive attempts before failing. The actual port is:

- Printed to the console: `Backend Server running on http://0.0.0.0:<port>`
- Propagated to `VITE_BACKEND_PORT` so the frontend connects to the correct backend
- Returned by `ensureServer()` so CLI subcommands use the correct `baseUrl`

### Implementation Details

The server lifecycle is implemented in `cli/utils/serverLifecycle.ts`:

- `isServerRunning(port)` - Check if server is listening on port
- `startServer(port, timeout)` - Spawn server process, parse stdout for actual port, wait for ready
- `stopServer(process)` - Gracefully terminate server
- `ensureServer(config)` - Main entry point, handles all scenarios including port auto-increment
- `createServerCleanup(result, isCI)` - Returns cleanup function for CI mode

The port retry logic uses a recursive `tryListen()` pattern in both `server/index.ts` and `cli/utils/startServer.ts`:

```typescript
const tryListen = (port: number): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0');
    server.on('listening', () => resolve(port));
    server.on('error', (err: NodeJS.ErrnoException) => {
      server.close();
      if (err.code === 'EADDRINUSE' && port <= startPort + MAX_PORT_ATTEMPTS) {
        resolve(tryListen(port + 1));
      } else {
        reject(err);
      }
    });
  });
};
```

## API Client Pattern

The CLI uses `cli/utils/apiClient.ts` to communicate with the server:

```typescript
const api = new ApiClient('http://localhost:4001');

// Find benchmark by name or ID
const benchmark = await api.findBenchmark('My Benchmark');

// Execute benchmark with progress streaming
const run = await api.executeBenchmark(benchmark.id, runConfig, (event) => {
  if (event.type === 'progress') {
    console.log(`Progress: ${event.currentTestCaseIndex}/${event.totalTestCases}`);
  }
});

// Get detailed reports
const reports = await api.getRunReports(benchmark.id, run.id);
```

### SSE Streaming

Long-running operations (benchmark execution) use Server-Sent Events:

```typescript
// Server side (Express route)
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.flushHeaders();

res.write(`data: ${JSON.stringify({ type: 'progress', ... })}\n\n`);

// Client side (API client)
const reader = res.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // Parse SSE events from buffer
}
```

## Directory Structure

```
.
├── cli/
│   ├── commands/           # CLI commands (benchmark, serve, etc.)
│   ├── utils/
│   │   ├── apiClient.ts    # HTTP client for server API
│   │   └── serverLifecycle.ts  # Server start/stop utilities
│   └── demo/               # Sample data generators
├── server/
│   ├── routes/             # Express route handlers
│   │   └── storage/        # Storage API routes
│   ├── services/           # Backend-only services
│   └── middleware/         # Express middleware
├── lib/
│   └── config/             # Configuration loading
│       ├── types.ts        # ServerConfig, UserConfig, etc.
│       ├── loader.ts       # Config file loading
│       └── defineConfig.ts # Type-safe config helper
└── services/               # Shared services (used by server)
```

## Adding New CLI Commands

When adding a new CLI command that needs server functionality:

1. **Use the API client** - Never import server internals or OpenSearch client directly
2. **Handle server lifecycle** - Call `ensureServer()` at the start
3. **Clean up in CI** - Call the cleanup function in a finally block

```typescript
import { ensureServer, createServerCleanup } from '@/cli/utils/serverLifecycle.js';
import { ApiClient } from '@/cli/utils/apiClient.js';
import { loadConfig, DEFAULT_SERVER_CONFIG } from '@/lib/config/index.js';

export async function myCommand() {
  const config = await loadConfig();
  const serverConfig = { ...DEFAULT_SERVER_CONFIG, ...config.server };
  const isCI = !!process.env.CI;

  const serverResult = await ensureServer(serverConfig);
  const cleanup = createServerCleanup(serverResult, isCI);

  try {
    const api = new ApiClient(serverResult.baseUrl);
    // Use api.* methods to interact with server
  } finally {
    cleanup();
  }
}
```

## Server API Endpoints

Key endpoints used by CLI:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/debug` | GET | Get current debug logging state |
| `/api/debug` | POST | Toggle debug logging (`{ enabled: boolean }`) |
| `/api/storage/benchmarks` | GET | List benchmarks |
| `/api/storage/benchmarks/:id` | GET | Get benchmark by ID |
| `/api/storage/benchmarks/:id/execute` | POST | Execute benchmark (SSE) |
| `/api/storage/benchmarks/:id/cancel` | POST | Cancel running benchmark |
| `/api/storage/runs/by-benchmark-run/:benchmarkId/:runId` | GET | Get reports for a run |

## Why This Architecture?

### Before (Direct OpenSearch Access)

```typescript
// CLI command
import { getOpenSearchClient } from '@/server/services/opensearchClient';

const client = getOpenSearchClient();
const result = await client.search({ index: 'benchmarks', ... });
// Duplicate logic from server routes
```

**Problems:**
- Duplicated business logic between CLI and server routes
- CLI needs OpenSearch credentials
- Inconsistent behavior possible
- Hard to maintain two code paths

### After (Server-Mediated)

```typescript
// CLI command
import { ApiClient } from '@/cli/utils/apiClient';

const api = new ApiClient('http://localhost:4001');
const benchmarks = await api.listBenchmarks();
// Server handles all logic
```

**Benefits:**
- Single source of truth (server routes)
- CLI is a thin HTTP wrapper (~200 lines vs ~550 lines)
- No credential exposure
- Guaranteed consistent behavior
- Easier testing and maintenance

## Storage Adapter Pattern

The storage layer uses an adapter pattern to support multiple backends without changing route or service code.

### IStorageModule Interface

All storage backends implement the `IStorageModule` interface, which exposes sub-modules for each entity type:

```typescript
interface IStorageModule {
  testCases: ITestCaseStorage;
  benchmarks: IBenchmarkStorage;
  runs: IRunStorage;
  isConfigured: boolean;
}
```

Each sub-module (`ITestCaseStorage`, `IBenchmarkStorage`, `IRunStorage`) provides standard CRUD operations: `getAll()`, `getById()`, `create()`, `update()`, `delete()`.

### Built-in Adapters

| Adapter | Backend | Config Required | Use Case |
|---------|---------|-----------------|----------|
| `FileStorageModule` | Local filesystem (`.agent-health/data/`) | None (default) | Zero-config local development, demos |
| `OpenSearchStorageModule` | OpenSearch cluster | `OPENSEARCH_STORAGE_*` env vars | Production, shared teams |

**FileStorageModule** is the default adapter. It stores data as JSON files in a `.agent-health/data/` directory relative to the working directory. No external services are needed - the application works out of the box.

**OpenSearchStorageModule** connects to an OpenSearch cluster for persistent, shared storage. It is activated when `OPENSEARCH_STORAGE_ENDPOINT` is configured. Supports both basic auth (username/password) and AWS SigV4 authentication for managed OpenSearch domains and OpenSearch Serverless. The `opensearchClientFactory.ts` handles client creation with the appropriate auth strategy based on `authType` in the cluster config.

### Adapter Factory Singleton

The active storage module is managed via a singleton factory:

```typescript
import { getStorageModule, setStorageModule } from '@/server/services/storage';

// Get the current storage module (creates FileStorageModule by default)
const storage = getStorageModule();

// Override with a different adapter (e.g., during server startup)
setStorageModule(new OpenSearchStorageModule(config));
```

### Usage in Routes

Routes use the `getStorageModule()` singleton and never reference a specific backend directly:

```typescript
// In a route handler
import { getStorageModule } from '@/server/services/storage';

router.get('/api/storage/test-cases', async (req, res) => {
  const storage = getStorageModule();
  const testCases = await storage.testCases.getAll();
  res.json(testCases);
});

router.get('/api/storage/benchmarks/:id', async (req, res) => {
  const storage = getStorageModule();
  const benchmark = await storage.benchmarks.getById(req.params.id);
  if (!benchmark) return res.status(404).json({ error: 'Not found' });
  res.json(benchmark);
});
```

This pattern means:
- **Routes are backend-agnostic** - the same route code works with file storage or OpenSearch
- **Swapping backends is a one-line change** at startup via `setStorageModule()`
- **Testing is simple** - inject a mock `IStorageModule` for unit tests

## Trace Span Categorization

Every span the Traces UI renders is bucketed into one `SpanCategory` by
[`services/traces/spanCategorization.ts`](../services/traces/spanCategorization.ts)
(`getSpanCategory`). The rules are standards-first — OTel semantic conventions
decide; span-name patterns are only a fallback for legacy agents — and are
applied in this order:

| Order | Rule | Category |
|-------|------|----------|
| 0 | `status === 'ERROR'` | `ERROR` |
| 1 | OTel **GenAI** `gen_ai.operation.name` is a **known** value: `evaluation` / `create_agent`,`invoke_agent` / `chat`,`text_completion`,`generate_content`,`embeddings` / `execute_tool` | `EVAL` / `AGENT` / `LLM` / `TOOL` |
| 2 | OTel **DB** semconv: `db.system.name` (or legacy `db.system`) present | `RETRIEVAL` |
| 3 | Unknown (framework-specific) `gen_ai.operation.name` **with** GenAI context (`gen_ai.provider.name`, `gen_ai.system` or `gen_ai.agent.name`): reporting `gen_ai.request.model` or token usage ⇒ a model call; otherwise orchestration (e.g. an agent-loop iteration span) | `LLM` / `AGENT` |
| 4 | HTTP **SERVER** span (`http.request.method` / legacy `http.method`, `spanKind` exactly `SPAN_KIND_SERVER` / `SERVER` / `2`) — the agent service's inbound request boundary. The **outermost** such span in the tree is additionally flagged `isEntrypoint: true` on the `CategorizedSpan` so time attribution can use self time; nested server spans are not entrypoints. | `AGENT` |
| 5 | Span-name patterns (`bedrock`, `converse`, `llm`, `executetool`, `test_case`, `agent.run`, …) for legacy / un-instrumented agents | `LLM` / `TOOL` / `EVAL` / `AGENT` |
| 6 | Anything else — the explicit "we do not know" bucket | `OTHER` |

**Precedence when a span carries both `gen_ai.*` and `db.*`:** a *known* GenAI
operation is authoritative — an `execute_tool` span that also carries `db.*`
stays `TOOL` (it keeps its place in tool stats and tool-similarity grouping;
its DB details are still surfaced in the span detail views). Only when no known
GenAI operation claims the span do the `db.*` attributes — the span's own leaf
semantic — make it `RETRIEVAL`, including over an unknown framework-specific
operation name. Outbound HTTP **CLIENT** spans with no `db.*` are not retrieval
and stay `OTHER` unless a name pattern matches.

| Category | Colour | Icon | Compliance expectation (`checkOTelCompliance`) |
|----------|--------|------|-----------------------------------------------|
| `AGENT` | indigo | Bot | `gen_ai.operation.name`, `gen_ai.agent.name` |
| `LLM` | purple | Zap | `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.system` |
| `TOOL` | amber | Wrench | `gen_ai.operation.name`, `gen_ai.tool.name` |
| `RETRIEVAL` | cyan | Database | `db.system.name`, and `db.query.text` **or** `db.operation.name` |
| `AGENT` (entrypoint) | indigo | Bot | HTTP server-span semconv instead of GenAI: `http.request.method`\|`http.method`, `http.route`\|`url.path`\|`http.target`, `http.response.status_code`\|`http.status_code` |
| `EVAL` | emerald | ClipboardCheck | `gen_ai.operation.name` |
| `ERROR` | red | AlertCircle | — |
| `OTHER` | slate | Circle | — |

### RETRIEVAL span display

[`services/traces/retrievalSpan.ts`](../services/traces/retrievalSpan.ts)
(`extractRetrievalIO`) turns a DB-semconv span into what the span-detail
surfaces show:

- **Input** — `db.query.text` (legacy `db.statement`), pretty-printed when it
  is JSON, captioned `{db.operation.name} {db.collection.name | db.namespace} ({db.system.name})`.
- **Output** — `db.response.returned_rows`, `db.response.status_code`, and any
  retrieved-id list (below).
- **Display name** — `{db.operation.name} {collection}` per the DB span-name
  convention (falls back to the span name).

**Retrieved-id convention.** The DB conventions have no attribute for *which*
documents came back, which is exactly what a retrieval-quality judge needs.
Agents can expose it with any attribute whose key ends in `.hit_ids` or
`.result_ids`, or the neutral key `retrieval.ids` (e.g.
`myagent.search.hit_ids`). The value should be an OTel string array or a JSON
array serialised to text (a Python-style single-quoted list literal is accepted
too). Agent Health renders each such attribute as an id list in the span's
output; a value that is not list-shaped is shown verbatim rather than guessed
at (no comma-splitting of arbitrary strings). Nothing about it is specific to
one agent.

## Claude Code Judge

The Claude Code judge is an alternative evaluation provider that spawns the `claude` CLI to evaluate agent trajectories, giving the judge access to full tool use and the AGENT_HEALTH.md skill context.

### How It Works

```
┌──────────┐      spawn        ┌──────────────┐     stdout      ┌──────────┐
│  Server   │ ───────────────▶│  claude CLI   │ ─────────────▶ │  JSON    │
│ judge.ts  │   --print        │  (subprocess) │  JudgeResponse │  parse   │
└──────────┘   --output-format │               │                └──────────┘
               json            └──────────────┘
```

- **Provider key**: `'claude-code'` in the `JudgeProvider` union type
- **Model ID**: `claude-code-judge` in `DEFAULT_CONFIG.models`
- **Service**: `server/services/claudeCodeJudgeService.ts`
- **Route branch**: `server/routes/judge.ts` — `if (provider === 'claude-code')`

### Key Details

- Spawns `claude --print --output-format json --dangerously-skip-permissions --append-system-prompt <system-prompt>`
- System prompt combines `JUDGE_SYSTEM_PROMPT` from `server/prompts/judgePrompt.ts` with AGENT_HEALTH.md skill content
- Pipes `buildEvaluationPrompt()` output (same as Bedrock) to stdin
- Parses JSON from stdout into `JudgeResponse` shape (handles bare JSON and markdown-wrapped)
- Inherits `AWS_PROFILE` and `AWS_REGION` from process environment
- 3-minute timeout per evaluation

## AI Assistant

The AI Assistant provides conversational help powered by Claude Code CLI (with Bedrock/LiteLLM fallback). Two UI interfaces share one backend.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Frontend (React)                                  │
│                                                                         │
│  ┌───────────────────┐    ┌──────────────────────┐                     │
│  │  AssistantModal    │    │   AssistantChat       │                    │
│  │  (floating "?")    │    │   (/assistant route)  │                    │
│  └────────┬──────────┘    └──────────┬───────────┘                     │
│           │                          │                                  │
│           └──────────┬───────────────┘                                  │
│                      ▼                                                  │
│           ┌──────────────────┐                                         │
│           │ AssistantProvider │                                         │
│           │ (runtime context) │                                         │
│           └────────┬─────────┘                                         │
│                    ▼                                                    │
│           ┌──────────────────┐                                         │
│           │useAssistantRuntime│                                        │
│           │ (ChatModelAdapter)│                                        │
│           └────────┬─────────┘                                         │
│                    ▼                                                    │
│           ┌──────────────────┐                                         │
│           │  assistantApi.ts  │  ← ReadableStream SSE consumption      │
│           └────────┬─────────┘                                         │
└────────────────────┼───────────────────────────────────────────────────┘
                     │ POST /api/assistant/chat (SSE)
                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Backend (Express)                                │
│                                                                        │
│  ┌──────────────────┐    ┌──────────────────────────┐                 │
│  │ assistant.ts      │───▶│ assistantService.ts       │                │
│  │ (SSE route)       │    │ (session mgmt + streaming)│                │
│  └──────────────────┘    └────────────┬─────────────┘                 │
│                                       │                                │
│                          ┌────────────┼────────────┐                  │
│                          ▼            ▼            ▼                   │
│                    ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│                    │claude CLI│ │ Bedrock  │ │ LiteLLM  │            │
│                    │(primary) │ │(fallback)│ │(fallback)│            │
│                    └──────────┘ └──────────┘ └──────────┘            │
└────────────────────────────────────────────────────────────────────────┘
```

### Streaming Pipeline

The end-to-end streaming pipeline converts Claude CLI NDJSON output to real-time UI updates:

1. **Claude CLI** outputs NDJSON lines: `{"type":"assistant","subtype":"text","content":"Hello"}`
2. **assistantService.ts** parses NDJSON → calls `onDelta(content)` callback
3. **assistant.ts route** converts to SSE: `data: {"type":"delta","content":"Hello"}\n\n`
4. **assistantApi.ts** reads SSE via `ReadableStream` → buffers on `\n\n` → calls `onChunk(content)`
5. **ChatModelAdapter** (in `useAssistantRuntime.ts`) accumulates text → yields `{ content: [{ type: "text", text }] }`
6. **assistant-ui Thread** renders incrementally with auto-scroll and typing indicator

### Session Management

- In-memory `Map<sessionId, Session>` with 30-minute TTL
- Periodic cleanup every 5 minutes (timer uses `unref()` to not block process exit)
- Sessions persist across page navigation within the same browser session

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/assistant/chat` | POST | Stream assistant response (SSE) |
| `/api/assistant/session/:sessionId` | DELETE | Clear session history |
| `/api/assistant/health` | GET | Check Claude CLI availability |

### UI Components

| Component | Location | Library Primitive |
|-----------|----------|-------------------|
| `AssistantModal` | `components/assistant-ui/AssistantModal.tsx` | `AssistantModalPrimitive` |
| `AssistantChat` | `components/assistant-ui/AssistantChat.tsx` | `ThreadPrimitive` |
| `AssistantProvider` | `components/assistant-ui/AssistantProvider.tsx` | `AssistantRuntimeProvider` |

- **AssistantModal**: Floating "?" button fixed bottom-right, opens 500x400 popup. Mobile-responsive (full viewport on small screens).
- **AssistantChat**: Full-page chat at `/assistant` route with welcome screen and suggested prompts.
- **AssistantProvider**: Mounted once in `Layout.tsx`, provides shared runtime context to both interfaces.
