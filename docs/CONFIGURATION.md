# Configuration Guide

Agent Health uses a unified configuration system with multiple tiers:

1. **`agent-health.config.json`** - Unified JSON config file (primary, auto-created)
2. **Environment Variables** - for quick overrides and secrets
3. **TypeScript Config File** - for power users with custom agents/connectors (optional)

Settings are consolidated into `agent-health.config.json`, which is created automatically on first startup. Priority: **file config > env vars > defaults**.

## Quick Start (Zero Config)

Most users can start immediately with no configuration:

```bash
# If you have AWS credentials configured (aws configure)
npx agent-health run -t demo-tc-1 -a claude-code
```

This works because:
- Claude Code uses your `AWS_PROFILE` automatically
- Travel Planner demo test cases are built-in
- File-based storage is used by default (no OpenSearch needed)
- Results shown in terminal

## Two config files, and why

Agent Health has **two** config files that serve different roles. Knowing which
is which avoids the most common confusion:

| File | Authored by | Holds | Lifecycle |
|------|-------------|-------|-----------|
| `agent-health.config.ts` | you (code) | **agents, connectors, models, judge, reporters, telemetry**, and optionally **storage/observability** cluster config | hand-written, loaded at startup |
| `agent-health.config.json` | the app (Settings UI) | **data** — storage/observability cluster endpoints + credentials | read **and written back** at runtime |

The JSON file exists because the **Settings page writes config back to disk** at
runtime (you can't safely round-trip edits into hand-authored TypeScript). The
TypeScript file is your committed, version-controlled source of truth.

For **storage** and **observability**, both files can express the same thing.
Resolution precedence (highest wins):

```
1. agent-health.config.json   (written by the Settings UI)
2. agent-health.config.ts     (defineConfig storage/observability)
3. OPENSEARCH_STORAGE_* / OPENSEARCH_LOGS_* env vars
4. file-based storage fallback (storage only)
```

Keeping the JSON highest means runtime edits from the Settings UI still win;
the TypeScript file is the committed default. If you never touch the Settings
UI, a single `agent-health.config.ts` (reading secrets from `process.env`) is
all you need — no JSON file required.

## Unified Config File (`agent-health.config.json`)

When you configure storage/observability through the **Settings page** (or when
an older `agent-health.yaml` is auto-migrated), Agent Health writes
`agent-health.config.json` in your working directory. It holds data-source
cluster config (and any custom agents added via the UI):

```json
{
  "storage": {
    "endpoint": "https://my-cluster.us-east-1.es.amazonaws.com",
    "authType": "sigv4",
    "awsRegion": "us-east-1",
    "awsService": "es",
    "awsProfile": "default"
  },
  "observability": {
    "endpoint": "https://my-traces-cluster.us-east-1.es.amazonaws.com",
    "authType": "sigv4",
    "awsRegion": "us-east-1",
    "indexes": { "traces": "otel-v1-apm-span-*", "logs": "ml-commons-logs-*" }
  },
  "debug": false
}
```

Settings saved through the UI are persisted to this file automatically. If you
prefer a single committed config, set these in `agent-health.config.ts` instead
(see [TypeScript Config File](#typescript-config-file-optional)) and don't edit
them from the Settings page.

### YAML to JSON Auto-Migration

If you have an existing `agent-health.yaml` configuration file, it will be automatically migrated to `agent-health.config.json` on the first startup. The migration is handled by `configMigration.ts` and preserves all your existing settings. The original YAML file is left in place for reference but is no longer read.

## File-Based Storage (Default)

By default, Agent Health uses **file-based storage** that requires no external services. Data is stored as JSON files in a `.agent-health-data/` directory:

```
.agent-health-data/
├── test-cases/       # Test case definitions
├── benchmarks/       # Benchmark configurations
├── runs/             # Evaluation run results
└── analytics/        # Analytics data
```

This means you can start using Agent Health immediately without setting up OpenSearch. To switch to OpenSearch storage, configure the `OPENSEARCH_STORAGE_*` environment variables (see below).

## Environment Variables

### AWS Credentials

Required for Claude Code agent and Bedrock judge.

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_PROFILE` | AWS profile to use | `default` |
| `AWS_REGION` | AWS region | `us-west-2` |
| `AWS_ACCESS_KEY_ID` | Explicit access key (alternative to profile) | - |
| `AWS_SECRET_ACCESS_KEY` | Explicit secret key | - |
| `AWS_SESSION_TOKEN` | Session token (for temporary credentials) | - |

**Note:** If you've run `aws configure`, credentials are auto-detected.

### OpenSearch Storage (Optional)

Override the default file-based storage with an OpenSearch cluster for shared, production-grade persistence. Without these settings, file-based storage is used automatically.

**Basic Auth (username/password):**

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENSEARCH_STORAGE_ENDPOINT` | Storage cluster URL | - |
| `OPENSEARCH_STORAGE_USERNAME` | Username | - |
| `OPENSEARCH_STORAGE_PASSWORD` | Password | - |
| `OPENSEARCH_STORAGE_TLS_SKIP_VERIFY` | Skip TLS verification | `false` |

**AWS SigV4 Auth (instead of username/password):**

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENSEARCH_STORAGE_ENDPOINT` | Storage cluster URL | - |
| `OPENSEARCH_STORAGE_AUTH_TYPE` | Auth type: `none` \| `basic` \| `sigv4` (defaults to `basic` when a username/password is set) | - |
| `OPENSEARCH_STORAGE_AWS_REGION` | AWS region (required for SigV4) | - |
| `OPENSEARCH_STORAGE_AWS_PROFILE` | AWS profile name (uses default credential chain if omitted) | - |
| `OPENSEARCH_STORAGE_AWS_SERVICE` | `es` for managed OpenSearch, `aoss` for Serverless | `es` |
| `OPENSEARCH_STORAGE_TLS_SKIP_VERIFY` | Skip TLS verification | `false` |

SigV4 uses the AWS credential chain (`AWS_PROFILE`, `~/.aws/credentials`, IAM role, etc.) — no explicit access keys needed. You can also configure SigV4 via the Settings UI or the `agent-health.config.json` file.

### OpenSearch Observability (Optional)

View agent traces and logs. Only needed for ML-Commons agent.

**Basic Auth (username/password):**

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENSEARCH_LOGS_ENDPOINT` | Logs cluster URL | - |
| `OPENSEARCH_LOGS_USERNAME` | Username | - |
| `OPENSEARCH_LOGS_PASSWORD` | Password | - |
| `OPENSEARCH_LOGS_TRACES_INDEX` | Traces index pattern | `otel-v1-apm-span-*` |
| `OPENSEARCH_LOGS_INDEX` | Logs index pattern | `ml-commons-logs-*` |

**AWS SigV4 Auth (instead of username/password):**

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENSEARCH_LOGS_ENDPOINT` | Logs cluster URL | - |
| `OPENSEARCH_LOGS_AUTH_TYPE` | Auth type: `none` \| `basic` \| `sigv4` (defaults to `basic` when a username/password is set) | - |
| `OPENSEARCH_LOGS_AWS_REGION` | AWS region (required for SigV4) | - |
| `OPENSEARCH_LOGS_AWS_PROFILE` | AWS profile name (uses default credential chain if omitted) | - |
| `OPENSEARCH_LOGS_AWS_SERVICE` | `es` for managed OpenSearch, `aoss` for Serverless | `es` |
| `OPENSEARCH_LOGS_TRACES_INDEX` | Traces index pattern | `otel-v1-apm-span-*` |
| `OPENSEARCH_LOGS_INDEX` | Logs index pattern | `ml-commons-logs-*` |

SigV4 authentication is also configurable via the Settings UI (select "AWS SigV4" from the Authentication Type dropdown) or the `agent-health.config.json` file.

### Agent Endpoints (Optional)

Override default agent endpoints.

| Variable | Description | Default |
|----------|-------------|---------|
| `TRAVEL_PLANNER_ENDPOINT` | Travel Planner demo agent URL (requires OTel Demo Docker) | `http://localhost:3000` |

To configure additional agents (LangGraph, ML-Commons, HolmesGPT, Claude Code, etc.), use `agent-health.config.ts`. See [TypeScript Config File](#typescript-config-file-optional) below.

### Debug Logging

| Variable | Description | Default |
|----------|-------------|---------|
| `DEBUG` | Enable verbose debug logging on server startup | `false` |

Debug logging can also be toggled at runtime via the Settings page "Verbose Logging" toggle or the `POST /api/debug` endpoint. When enabled, structured debug output appears in both the browser console and server terminal.

### Advanced Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_BACKEND_PORT` | Backend server port | `4001` |
| `BEDROCK_MODEL_ID` | Judge model ID | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |

## TypeScript Config File (Optional)

Create `agent-health.config.ts` for custom agents, models, or connectors.

### When to Use a Config File

- Adding custom agents
- Custom connectors
- CI/CD (version-controlled config)
- Custom test case locations

### When NOT to Use a Config File

- Just running Claude Code
- Using default file-based storage (works out of the box)
- Simple storage setup (use env vars for OpenSearch)
- Quick testing with Travel Planner demo

### Example Config

```typescript
// agent-health.config.ts
import { defineConfig } from '@opensearch-project/agent-health';

export default defineConfig({
  // Add custom agents (built-ins still work)
  agents: [
    {
      key: 'my-agent',
      name: 'My Custom Agent',
      connectorType: 'rest', // or 'agui-streaming', 'langgraph', 'strands', 'subprocess'
      endpoint: 'http://localhost:8080/chat',
      useTraces: true,
    },
  ],

  // Optional: OpenSearch storage for eval results (can also use env vars / the
  // Settings UI). Read secrets from process.env so this file stays committable.
  storage: {
    endpoint: process.env.OPENSEARCH_STORAGE_ENDPOINT!,
    authType: 'sigv4',          // 'none' | 'basic' | 'sigv4'
    awsRegion: 'us-east-1',
    awsService: 'es',           // 'es' (managed) | 'aoss' (serverless)
    awsProfile: process.env.AWS_PROFILE,
  },

  // Optional: OpenSearch observability cluster for traces/logs (Traces tab).
  observability: {
    endpoint: process.env.OPENSEARCH_LOGS_ENDPOINT!,
    authType: 'sigv4',
    awsRegion: 'us-east-1',
    indexes: { traces: 'otel-v1-apm-span-*', logs: 'ml-commons-logs-*' },
  },

  // Custom test cases location
  testCases: './my-tests/*.yaml',
});
```

> **Precedence:** `agent-health.config.json` (Settings UI) > `agent-health.config.ts`
> (above) > `OPENSEARCH_*` env vars > file-based fallback. See
> [Two config files, and why](#two-config-files-and-why).

### Config File Options

| Option | Type | Description |
|--------|------|-------------|
| `agents` | `UserAgentConfig[]` | Custom agents (merged with defaults) |
| `models` | `UserModelConfig[]` | Custom models (merged with defaults) |
| `connectors` | `AgentConnector[]` | Custom connectors |
| `storage` | `StorageClusterConfig` | OpenSearch storage cluster (endpoint + auth) |
| `observability` | `ObservabilityClusterConfig` | OpenSearch traces/logs cluster (endpoint + auth + index patterns) |
| `testCases` | `string \| string[]` | Test case file patterns |
| `reporters` | `ReporterConfig[]` | Output reporters |
| `judge` | `JudgeConfig` | Judge model configuration |
| `telemetry` | `TelemetryConfig` | OTel evaluation span emission |
| `extends` | `boolean` | Extend defaults (`true`) or replace (`false`) |

### Agent Config Options

```typescript
interface UserAgentConfig {
  key: string;              // Unique identifier
  name: string;             // Display name
  endpoint: string;         // URL or command name
  connectorType?: string;   // 'agui-streaming', 'rest', 'langgraph', 'strands', 'subprocess', 'claude-code', 'mock'
  headers?: Record<string, string>;  // HTTP headers
  useTraces?: boolean;      // Enable trace collection
  connectorConfig?: Record<string, any>;  // Connector-specific config
  hooks?: AgentHooks;       // beforeRequest hook, etc.
  description?: string;     // Description
  enabled?: boolean;        // Enable/disable agent (default true)
}
```

## Built-in Agents

These agents work out of the box:

| Agent | Key | Connector | Notes |
|-------|-----|-----------|-------|
| Demo Agent | `demo` | `mock` | Simulated responses for testing |
| Claude Code | `claude-code` | `claude-code` | Requires `claude` CLI installed |
| Amazon Strands | `strands` | `strands` | Bedrock Agent Runtime (disabled by default) |
| LangGraph (REST) | `langgraph-rest` | `langgraph` | Direct REST API (disabled by default) |

## Built-in Connectors

| Type | Protocol | Use Case |
|------|----------|----------|
| `agui-streaming` | AG-UI SSE | ML-Commons and AG-UI compatible agents |
| `rest` | HTTP POST | Simple REST APIs |
| `openai-compatible` | OpenAI Chat Completions | LiteLLM, Ollama, vLLM |
| `langgraph` | LangGraph REST `/invoke` | Non-AG-UI LangGraph instances |
| `strands` | Bedrock Agent Runtime | Amazon Strands agents (server-only) |
| `subprocess` | CLI | Generic CLI tools |
| `claude-code` | CLI | Claude Code CLI specifically |
| `mock` | In-memory | Testing and demos |

## Configuration Hierarchy

Settings are loaded in this order (later overrides earlier):

```
1. Built-in defaults (lib/constants.ts)
      ↓
2. Environment variables (.env file)
      ↓
3. TypeScript config file (agent-health.config.ts) — agents/connectors/models/judge
   and optionally storage/observability
      ↓
4. JSON config file (agent-health.config.json) — storage/observability written
   by the Settings UI (highest precedence for data sources)
```

**Note:** For **agents/models/connectors/judge/reporters/telemetry**, the
TypeScript config (`agent-health.config.ts`) is authoritative. For **storage and
observability** data sources, the resolution order is
`agent-health.config.json` (Settings UI) > `agent-health.config.ts` >
`OPENSEARCH_*` env > file-based fallback — see
[Two config files, and why](#two-config-files-and-why).

## Validation

Check your configuration:

```bash
npx agent-health doctor
```

This shows:
- Config file status
- AWS credentials
- Storage configuration
- Available agents and connectors
