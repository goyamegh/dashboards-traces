/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

# Configuration

This guide covers all configuration options for Agent Health. Configuration is split into two files:

1. **`agent-health.config.ts`** - Agent and model definitions (TypeScript/JavaScript)
2. **`.env`** - Environment variables (credentials, endpoints, feature flags)

---

## Table of Contents

1. [Quick Reference](#quick-reference)
2. [Agent Configuration](#agent-configuration)
3. [Connector Types](#connector-types)
4. [Model Configuration](#model-configuration)
5. [Environment Variables](#environment-variables)
6. [Common Scenarios](#common-scenarios)
7. [Troubleshooting](#troubleshooting)

---

## Quick Reference

### Minimal Setup

**For demo mode** (no configuration needed):
```bash
npx @opensearch-project/agent-health
```

**For your own agent** - create `agent-health.config.ts`:
```typescript
export default {
  agents: [
    {
      key: "my-agent",
      name: "My Agent",
      endpoint: "http://localhost:8000/agent",
      connectorType: "rest",
      models: ["claude-sonnet-4"],
    }
  ],
};
```

**For LLM judge** - create `.env`:
```bash
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
```

---

## Agent Configuration

### Creating the Config File

**Option 1: Auto-generate**
```bash
npx @opensearch-project/agent-health init
```

**Option 2: Manual creation**
Create `agent-health.config.ts` in your working directory:

```typescript
export default {
  agents: [
    // Your agent configurations
  ],
  models: [
    // Optional: custom models
  ],
  extends: true,  // Merge with built-in agents/models (default: true)
};
```

### Agent Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `key` | string | ✓ | Unique identifier (used in CLI: `--agent my-agent`) |
| `name` | string | ✓ | Display name shown in UI |
| `endpoint` | string | ✓ | Agent URL or CLI path |
| `connectorType` | string | ✓ | Protocol type (see [Connector Types](#connector-types)) |
| `models` | string[] | ✓ | List of model keys this agent supports |
| `useTraces` | boolean | | Enable OpenTelemetry trace collection (default: `false`) |
| `headers` | object | | Custom headers sent with every request |
| `description` | string | | Optional description shown in UI |
| `hooks` | object | | Lifecycle hooks (see [Hooks](#lifecycle-hooks)) |

### Example Configuration

```typescript
export default {
  agents: [
    {
      key: "production-agent",
      name: "Production RCA Agent",
      endpoint: "https://api.example.com/v1/agent",
      connectorType: "rest",
      models: ["claude-sonnet-4", "gpt-4"],
      useTraces: true,
      description: "Production agent with full telemetry",
      headers: {
        "X-Environment": "production",
      },
    },
    {
      key: "dev-agent",
      name: "Development Agent",
      endpoint: "http://localhost:8000/agent/stream",
      connectorType: "agui-streaming",
      models: ["claude-sonnet-4"],
      useTraces: false,
    },
  ],
};
```

### Overriding Built-in Agents

If your agent `key` matches a built-in agent (e.g., `"langgraph"`, `"demo"`), it will override the built-in configuration:

```typescript
export default {
  agents: [
    {
      key: "demo",  // Overrides the built-in demo agent
      name: "My Custom Demo",
      endpoint: "http://localhost:3000/custom-demo",
      connectorType: "rest",
      models: ["claude-sonnet-4"],
    }
  ],
};
```

### Using Only Your Agents

Set `extends: false` to ignore built-in agents:

```typescript
export default {
  agents: [
    // Only these agents will be available
  ],
  extends: false,  // Don't merge with built-in agents
};
```

---

## Connector Types

Connectors define how Agent Health communicates with your agent.

### REST Connector

**Use for:** Synchronous JSON APIs that return complete responses.

```typescript
{
  key: "rest-agent",
  endpoint: "http://localhost:8000/api/agent",
  connectorType: "rest",
}
```

**Expected behavior:**
- Agent Health sends POST request with JSON payload
- Agent processes and returns complete JSON response
- No streaming, entire response sent at once

**Request format:**
```typescript
POST /api/agent
Content-Type: application/json

{
  "messages": [
    { "role": "user", "content": "Your prompt here" }
  ],
  "context": { /* test case context */ },
  "modelId": "claude-sonnet-4"
}
```

**Response format:**
```typescript
{
  "trajectory": [
    { "type": "thinking", "content": "..." },
    { "type": "action", "toolName": "searchLogs", "toolArgs": {...} },
    { "type": "tool_result", "content": "..." },
    { "type": "response", "content": "Final answer" }
  ]
}
```

### AG-UI Streaming Connector (SSE)

**Use for:** Server-Sent Events streaming protocol (similar to ML-Commons agents).

```typescript
{
  key: "streaming-agent",
  endpoint: "http://localhost:9000/agent/stream",
  connectorType: "agui-streaming",
}
```

**Expected behavior:**
- Agent Health establishes SSE connection
- Agent streams events as they occur
- Real-time trajectory updates in UI

**Event format:**
```typescript
data: {"type": "thinking", "content": "Analyzing logs..."}

data: {"type": "action", "toolName": "searchLogs", "toolArgs": {...}}

data: {"type": "tool_result", "content": "Found 142 errors"}

data: {"type": "response", "content": "Root cause identified"}
```

### Subprocess Connector

**Use for:** CLI tools that accept JSON on stdin and write to stdout.

```typescript
{
  key: "cli-agent",
  endpoint: "/usr/local/bin/my-agent",  // Path to executable
  connectorType: "subprocess",
}
```

**Expected behavior:**
- Agent Health spawns the CLI process
- Sends JSON payload via stdin
- Reads JSON response from stdout

**CLI contract:**
```bash
# Your CLI should:
# 1. Read JSON from stdin
# 2. Process the request
# 3. Write JSON response to stdout
# 4. Exit with code 0 on success

echo '{"messages":[...]}' | /usr/local/bin/my-agent
```

### Claude Code Connector

**Use for:** Comparing your agent against Claude Code CLI.

```typescript
{
  key: "claude-code",
  endpoint: "claude",  // CLI command name
  connectorType: "claude-code",
  models: ["claude-sonnet-4"],
}
```

**Note:** Requires Claude Code CLI installed and authenticated.

### Mock Connector

**Use for:** Testing and demos without a real agent.

```typescript
{
  key: "demo-agent",
  endpoint: "mock://demo",
  connectorType: "mock",
  models: ["demo-model"],
}
```

---

## Lifecycle Hooks

Hooks allow you to customize requests before they're sent to your agent.

### beforeRequest Hook

Called before each evaluation request. Use it to:
- Add authentication headers
- Create sessions or resources
- Modify the payload
- Transform the endpoint

```typescript
{
  key: "authenticated-agent",
  endpoint: "https://api.example.com/agent",
  connectorType: "rest",
  hooks: {
    beforeRequest: async ({ endpoint, payload, headers }) => {
      // Example 1: Add API key
      return {
        endpoint,
        payload,
        headers: {
          ...headers,
          'Authorization': `Bearer ${process.env.API_TOKEN}`,
          'X-API-Key': process.env.API_KEY,
        },
      };
    },
  },
}
```

**Example 2: Create a session**
```typescript
hooks: {
  beforeRequest: async ({ endpoint, payload, headers }) => {
    // Pre-create a session
    const baseUrl = new URL(endpoint).origin;
    const res = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
    const { sessionId } = await res.json();

    // Add session to request
    return {
      endpoint: `${endpoint}?session=${sessionId}`,
      payload: { ...payload, sessionId },
      headers,
    };
  },
}
```

**Example 3: Transform payload**
```typescript
hooks: {
  beforeRequest: async ({ endpoint, payload, headers }) => {
    // Convert to your agent's format
    const customPayload = {
      query: payload.messages[0].content,
      context: payload.context,
      config: {
        model: payload.modelId,
        temperature: 0.7,
      },
    };

    return { endpoint, payload: customPayload, headers };
  },
}
```

---

## Model Configuration

### Using Built-in Models

Agent Health includes several pre-configured models:

```typescript
models: ["claude-sonnet-4.5", "claude-sonnet-4", "claude-opus-4", "gpt-4"]
```

See `lib/constants.ts` for the full list.

### Adding Custom Models

```typescript
export default {
  models: [
    {
      key: "my-custom-model",
      model_id: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      display_name: "My Custom Sonnet",
      provider: "bedrock",  // "bedrock" | "openai" | "ollama" | "demo"
      context_window: 200000,
      max_output_tokens: 4096,
    }
  ],
};
```

---

## Environment Variables

Create a `.env` file in your working directory for environment-specific configuration.

### AWS Credentials (LLM Judge)

Required for Bedrock LLM judge to evaluate trajectories.

```bash
# Recommended: Use AWS profile
AWS_PROFILE=your_profile
AWS_REGION=us-west-2

# Or explicit credentials
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_SESSION_TOKEN=your_session_token  # If using temporary credentials
```

**Verify AWS credentials:**
```bash
aws sts get-caller-identity
```

### Storage (OpenSearch)

Optional. Enables persistence for test cases, experiments, and runs.

```bash
OPENSEARCH_STORAGE_ENDPOINT=https://your-cluster.opensearch.amazonaws.com
OPENSEARCH_STORAGE_USERNAME=admin
OPENSEARCH_STORAGE_PASSWORD=your_password
OPENSEARCH_STORAGE_TLS_SKIP_VERIFY=false  # true for self-signed certs

# Optional: Custom index names (defaults shown)
OPENSEARCH_STORAGE_TEST_CASES_INDEX=evals_test_cases
OPENSEARCH_STORAGE_BENCHMARKS_INDEX=evals_benchmarks
OPENSEARCH_STORAGE_RUNS_INDEX=evals_runs
```

**Without storage:** Sample data is displayed, but changes are not persisted.

### Traces (OpenSearch)

Optional. Enables OpenTelemetry trace visualization.

```bash
OPENSEARCH_LOGS_ENDPOINT=https://your-traces-cluster.opensearch.amazonaws.com
OPENSEARCH_LOGS_USERNAME=admin
OPENSEARCH_LOGS_PASSWORD=your_password
OPENSEARCH_LOGS_TLS_SKIP_VERIFY=false

# Optional: Custom index pattern (default shown)
OPENSEARCH_LOGS_TRACES_INDEX=otel-v1-apm-span-*
```

**Without traces:** Trace features are hidden in the UI.

### Agent Endpoints

Override default agent endpoints:

```bash
# Built-in agent endpoints (all optional)
LANGGRAPH_ENDPOINT=http://localhost:3000
HOLMESGPT_ENDPOINT=http://localhost:5050/api/agui/chat
MLCOMMONS_ENDPOINT=http://localhost:9200/_plugins/_ml/agents/{agent_id}/_execute/stream
```

**Note:** Agent endpoints in `agent-health.config.ts` take precedence over these environment variables.

### ML-Commons Headers

Required if using ML-Commons agents with data source authentication:

```bash
MLCOMMONS_HEADER_X_OPENSEARCH_USERNAME=your_username
MLCOMMONS_HEADER_X_OPENSEARCH_PASSWORD=your_password
```

See [docs/ML-COMMONS-SETUP.md](./docs/ML-COMMONS-SETUP.md) for details.

### Debug Mode

Enable verbose logging:

```bash
DEBUG=true
```

Or toggle at runtime via Settings page or API:
```bash
curl -X POST http://localhost:4001/api/debug \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true}'
```

---

## Common Scenarios

### Scenario 1: REST API with Authentication

```typescript
// agent-health.config.ts
export default {
  agents: [
    {
      key: "secure-agent",
      name: "Secure REST Agent",
      endpoint: "https://api.example.com/v1/agent",
      connectorType: "rest",
      models: ["claude-sonnet-4"],
      hooks: {
        beforeRequest: async ({ endpoint, payload, headers }) => {
          return {
            endpoint,
            payload,
            headers: {
              ...headers,
              'Authorization': `Bearer ${process.env.API_TOKEN}`,
            },
          };
        },
      },
    }
  ],
};
```

```bash
# .env
API_TOKEN=your_secret_token
AWS_REGION=us-west-2
AWS_PROFILE=your_profile
```

### Scenario 2: Streaming Agent with Traces

```typescript
// agent-health.config.ts
export default {
  agents: [
    {
      key: "streaming-agent",
      name: "Streaming Agent",
      endpoint: "http://localhost:9000/agent/stream",
      connectorType: "agui-streaming",
      models: ["claude-sonnet-4"],
      useTraces: true,  // Enable trace collection
    }
  ],
};
```

```bash
# .env
# Traces configuration
OPENSEARCH_LOGS_ENDPOINT=https://traces.opensearch.amazonaws.com
OPENSEARCH_LOGS_USERNAME=admin
OPENSEARCH_LOGS_PASSWORD=your_password
OPENSEARCH_LOGS_TRACES_INDEX=otel-v1-apm-span-*

# AWS for judge
AWS_REGION=us-west-2
AWS_PROFILE=your_profile
```

### Scenario 3: Multiple Agents, Same Cluster

```typescript
// agent-health.config.ts
export default {
  agents: [
    {
      key: "agent-v1",
      name: "Agent V1",
      endpoint: "http://localhost:8001/agent",
      connectorType: "rest",
      models: ["claude-sonnet-4"],
      useTraces: true,
    },
    {
      key: "agent-v2",
      name: "Agent V2 (Improved)",
      endpoint: "http://localhost:8002/agent",
      connectorType: "rest",
      models: ["claude-sonnet-4.5"],
      useTraces: true,
    },
  ],
};
```

```bash
# .env
# Shared storage for both agents
OPENSEARCH_STORAGE_ENDPOINT=https://storage.opensearch.amazonaws.com
OPENSEARCH_STORAGE_USERNAME=admin
OPENSEARCH_STORAGE_PASSWORD=your_password

# Shared traces
OPENSEARCH_LOGS_ENDPOINT=https://traces.opensearch.amazonaws.com
OPENSEARCH_LOGS_USERNAME=admin
OPENSEARCH_LOGS_PASSWORD=your_password

# AWS for judge
AWS_REGION=us-west-2
AWS_PROFILE=your_profile
```

### Scenario 4: CLI Agent

```typescript
// agent-health.config.ts
export default {
  agents: [
    {
      key: "cli-agent",
      name: "My CLI Agent",
      endpoint: "/usr/local/bin/my-agent",
      connectorType: "subprocess",
      models: ["gpt-4"],
    }
  ],
};
```

Ensure your CLI accepts JSON on stdin:
```bash
#!/usr/bin/env python3
import json
import sys

# Read request from stdin
request = json.load(sys.stdin)

# Process...
result = process_request(request)

# Write response to stdout
json.dump(result, sys.stdout)
sys.exit(0)
```

---

## Troubleshooting

### Config File Not Loading

**Symptoms:** Your agents don't appear in the UI/CLI.

**Solutions:**
- Ensure file is named exactly `agent-health.config.ts` (or `.js`, `.mjs`)
- Place file in your current working directory
- Check for syntax errors: `node -c agent-health.config.ts`
- Run with debug mode: `DEBUG=true npx @opensearch-project/agent-health`

### Agent Connection Failed

**Symptoms:** "Failed to connect to agent" or timeout errors.

**Solutions:**
- Verify endpoint is correct and accessible: `curl http://localhost:8000/agent`
- Check agent is running: `ps aux | grep my-agent`
- For subprocess: Ensure executable has correct permissions: `chmod +x /path/to/agent`
- Enable debug logging to see full error details

### AWS Credentials Not Working

**Symptoms:** "Unable to authenticate with AWS" or "Access Denied".

**Solutions:**
- Verify credentials: `aws sts get-caller-identity`
- Check Bedrock model access in AWS console
- Ensure correct region: Some models only available in specific regions
- Try explicit credentials instead of profile (or vice versa)

### Traces Not Appearing

**Symptoms:** Traces tab is empty or shows "No traces found".

**Solutions:**
- Wait 2-5 minutes after evaluation (traces take time to propagate)
- Verify `useTraces: true` in agent config
- Check OpenSearch connection: `curl -u user:pass https://your-cluster.opensearch.amazonaws.com/_cat/indices?v`
- Verify index pattern matches: `OPENSEARCH_LOGS_TRACES_INDEX=otel-v1-apm-span-*`
- Ensure agent actually emits OpenTelemetry spans

### Storage Connection Failed

**Symptoms:** "OpenSearch not configured" messages or save operations fail.

**Solutions:**
- Test connection: `curl -u user:pass https://your-cluster.opensearch.amazonaws.com`
- Check credentials are correct in `.env`
- For self-signed certs: Set `OPENSEARCH_STORAGE_TLS_SKIP_VERIFY=true`
- Verify network access (firewall, VPN, security groups)

### Environment Variables Not Loading

**Symptoms:** Configuration from `.env` file is ignored.

**Solutions:**
- Ensure file is named exactly `.env` (not `env.txt` or `.env.local`)
- Place `.env` in the directory where you run the command
- Use `--env-file` flag to specify custom path: `npx @opensearch-project/agent-health --env-file config/.env`
- Check for syntax errors (no spaces around `=`, no quotes needed for values)

---

## Configuration File Reference

### Supported File Names (Priority Order)

1. `agent-health.config.ts`
2. `agent-health.config.js`
3. `agent-health.config.mjs`

### Full Schema

```typescript
export default {
  // Agent definitions
  agents: [
    {
      key: string,              // Required: Unique identifier
      name: string,             // Required: Display name
      endpoint: string,         // Required: URL or CLI path
      connectorType: "rest" | "agui-streaming" | "subprocess" | "claude-code" | "mock",
      models: string[],         // Required: Model keys
      useTraces?: boolean,      // Optional: Enable traces
      headers?: Record<string, string>,  // Optional: Custom headers
      description?: string,     // Optional: Description
      hooks?: {
        beforeRequest?: (params: {
          endpoint: string;
          payload: any;
          headers: Record<string, string>;
        }) => Promise<{
          endpoint: string;
          payload: any;
          headers: Record<string, string>;
        }>;
      },
    }
  ],

  // Optional: Custom models
  models?: [
    {
      key: string,
      model_id: string,
      display_name: string,
      provider: "bedrock" | "openai" | "ollama" | "demo",
      context_window: number,
      max_output_tokens: number,
    }
  ],

  // Optional: Merge with built-in configs
  extends?: boolean,  // Default: true
};
```

---

## Additional Resources

- [Getting Started Guide](./GETTING_STARTED.md) - First-time setup
- [CLI Reference](./docs/CLI.md) - Command-line usage
- [Connectors Guide](./docs/CONNECTORS.md) - Create custom connectors
- [ML-Commons Setup](./docs/ML-COMMONS-SETUP.md) - OpenSearch ML integration
- [Development Guide](./CLAUDE.md) - Contributing and architecture
