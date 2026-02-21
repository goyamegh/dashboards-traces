# Configuration Consolidation — Full Release Plan

## Problem Statement

Agent Health has 4+ configuration sources (YAML, JSON, TS, .env, UI Settings, hardcoded constants) creating confusion. Storage requires OpenSearch just to save test cases. UX is fragmented for normal users, power users, and first-time users.

## Design Decisions

### 1. Config Priority (highest → lowest)
```
agent-health.config.ts  →  agent-health.config.json  →  .env (secrets fallback only)
     (power users)            (normal users / UI)         (CI/CD secrets only)
```

### 2. Storage: JSON Files by Default, OpenSearch Optional
- **Default**: JSON files on disk in `agent-health-data/` directory
- **Optional**: OpenSearch when storage endpoint is configured
- **Same data model**: Documents have identical shape regardless of backend (OpenSearch index format)
- **Migration**: CLI command `npx agent-health migrate --to opensearch` moves files → OpenSearch
- **REUSE existing interfaces**: `server/adapters/types.ts` already defines `IStorageModule`, `IObservabilityModule`, `IDataSourceAdapter` — DO NOT create new abstractions
- **Two implementations**: `OpenSearchStorageModule` (extract from current route handlers) and `FileStorageModule` (new, JSON files)

```
agent-health-data/
├── test-cases/
│   ├── tc-1234567890-abc.json       # Same doc shape as OpenSearch index
│   └── tc-1234567890-def.json
├── benchmarks/
│   ├── bench-1234567890-abc.json
│   └── bench-1234567890-def.json
└── runs/
    ├── report-1234567890-abc.json
    └── report-1234567890-def.json
```

### 3. What Goes Where

| Config Area | config.json | config.ts | .env | UI Settings |
|-------------|------------|-----------|------|-------------|
| Agent endpoints | ✓ | ✓ | — | ✓ CRUD |
| Connector type | ✓ per agent | ✓ per agent | — | ✓ dropdown |
| Traces toggle | ✓ per agent | ✓ per agent | — | ✓ checkbox |
| Models | ✓ | ✓ | — | ✓ add/edit |
| Model auth | — | ✓ hooks | ✓ API keys | ✓ guided |
| Storage cluster | ✓ storage{} | ✓ | ✓ OPENSEARCH_* | ✓ form |
| Observability | ✓ observability{} | ✓ | ✓ OPENSEARCH_LOGS_* | ✓ form |
| Auth hooks | — | ✓ hooks{} | — | → redirect to TS |
| LiteLLM proxy | ✓ litellm{} | ✓ | ✓ LITELLM_* | ✓ form |
| Judge config | ✓ judge{} | ✓ | ✓ AWS_* | ✓ dropdown |

### 4. Demo: Travel Planner (replaces Baseline/RCA)
- Source: github.com/kylehounslow/observability-stack
- 3 agents: Weather (8000), Events (8002), Travel Planner orchestrator (8003)
- All produce OTel traces via OTLP gRPC
- Pre-packaged benchmark with normal + fault injection test cases

---

## Work Streams

### Stream 1: Storage Backend Abstraction + Config Consolidation
**Foundation — everything depends on this**

1.1. Implement `IStorageModule` as `OpenSearchStorageModule` — extract OpenSearch query logic from `server/routes/storage/*.ts` (currently routes use raw `req.storageClient` and hand-roll queries)
1.2. Implement `IStorageModule` as `FileStorageModule` — JSON files in `agent-health-data/`, same document shape
1.3. Implement `IDataSourceAdapter` in `server/adapters/index.ts` — factory returns file-based (default) or OpenSearch (when configured)
1.4. Refactor routes to use adapter instead of `requireStorageClient(req)` + raw OpenSearch queries
1.5. Merge YAML into JSON — rewrite `configService.ts` to read/write `agent-health.config.json`
1.6. Unify `customAgentStore.ts` + `configService.ts` into single JSON file manager
1.7. YAML→JSON auto-migration on startup
1.8. CLI `migrate` command: files ↔ OpenSearch
1.9. Update config loader priority: config.ts → config.json → .env

### Stream 2: UI Settings Enhancement
**Depends on Stream 1**

2.1. Agent form: add connector type dropdown, traces checkbox, auth type selector
2.2. Source attribution badges on all config values
2.3. Model management CRUD in UI (add/edit/remove with provider selection)
2.4. Auth config UI: Basic/Bearer/API-key inline; Sigv4 with AWS fields; hooks → redirect to TS
2.5. LiteLLM proxy config form (endpoint, API key, model discovery)
2.6. "Advanced: Edit config.ts" callout for power-user features

### Stream 3: Travel Planner Demo + Onboarding
**Depends on Stream 1 (file storage), parallel with Stream 2**

3.1. Remove old Baseline/RCA demo data from `cli/demo/`
3.2. Create Travel Planner test cases (weather, events, orchestrator, fault injection)
3.3. Create pre-packaged benchmark JSON file
3.4. Generate sample OTel trace data matching observability-stack span conventions
3.5. First-time onboarding flow (welcome → configure agent → try demo → connect observability)

### Stream 4: Auth + LiteLLM Integration
**Depends on Streams 1+2**

4.1. Auth type system on `AgentConfig` with .env reference support
4.2. Proper Sigv4 request signing in REST connector
4.3. LiteLLM proxy connector (OpenAI-compatible API)
4.4. Model discovery endpoint (`GET /api/models/discover`)

### Stream 5: Documentation Rewrite
**After Streams 1-4**

5.1. CLAUDE.md — update all config references
5.2. GETTING_STARTED.md — rewrite for config-first, file-storage-default flow
5.3. CONFIGURATION.md — comprehensive config guide
5.4. README.md — update overview and quickstart
5.5. .env.example + agent-health.config.example.ts — update examples

---

## Agent Team

```
Senior SDE (Coordinator) — orchestrates, reviews, resolves conflicts
├── Test Agent 1 — dev server monitor (background)
├── Test Agent 2 — build watcher (background)
├── Test Agent 3 — test runner (on-demand after each commit)
├── Dev Agent 1 — Stream 1: Storage + Config Core
├── Dev Agent 2 — Stream 2: UI Settings (after Stream 1)
├── Dev Agent 3 — Stream 3: Demo + Onboarding (parallel with Stream 2)
├── Dev Agent 4 — Stream 4: Auth + LiteLLM (after Streams 1+2)
└── Doc Agent   — Stream 5: Documentation (after all dev streams)
```

## Commit Strategy
Each dev agent commits on `feat/config-consolidation` branch.
Order: Dev 1 → (Dev 2 + Dev 3 parallel) → Dev 4 → Doc Agent.
Test agents validate after each commit.
