# Observio Sample Agent

> A reference ReAct agent for practicing agent health improvements. Based on [osd-agents](https://github.com/opensearch-project/OpenSearch-Dashboards/tree/main/packages/osd-agents) from OpenSearch Dashboards.

## What is Observio?

Observio is a sample AI agent included in the Agent Health repository as a **practice target** for evaluating and improving agent performance using the Agent Health framework. It implements the ReAct (Reasoning and Acting) pattern using AWS Bedrock models and MCP tool integration.

**Use Observio to:**
- Learn how to evaluate agents with Agent Health
- Practice improving agent reasoning, tool selection, and error handling
- Benchmark agent performance across different scenarios
- Experiment with agent instrumentation and observability

## How It Works

Observio runs a ReAct loop:

1. **Receives** a user request or task
2. **Reasons** about what information or actions are needed
3. **Acts** by calling appropriate tools from connected MCP servers
4. **Observes** the results returned by those tools
5. **Repeats** steps 2-4 until the task is complete

The agent supports two operation modes:
- **Interactive CLI** (`src/main.ts`) — for terminal-based testing
- **AG-UI HTTP Server** (`src/main_ag_ui.ts`) — REST API with SSE streaming at `/run-agent` and `/health`

## Quick Start

### Prerequisites
- Node.js 18+
- AWS credentials with Bedrock access (Claude models)

### Setup

```bash
cd observio-sample-agent
npm install

# Configure AWS credentials
export AWS_REGION=us-west-2
export AWS_PROFILE=default
```

Configure MCP servers in `configuration/mcp_config.json` (see `configuration/mcp_config.example.json`).

### Running

```bash
# Interactive CLI mode
npm start

# AG-UI HTTP server mode (for Agent Health integration)
npm run start:ag-ui
```

## Using with Agent Health

### Connect Observio as an Agent

Add Observio to your `agent-health.config.ts`:

```typescript
export default {
  agents: [
    {
      key: "observio",
      name: "Observio Sample Agent",
      endpoint: "http://localhost:3001/run-agent",
      connectorType: "agui-streaming",
    }
  ],
};
```

### Evaluate

```bash
# Start Observio
cd observio-sample-agent && npm run start:ag-ui

# In another terminal, run an evaluation
npx @opensearch-project/agent-health run -t your-test-case -a observio
```

### What to Improve

Observio is intentionally a baseline implementation with room for improvement:

| Area | What to Improve | Files |
|------|----------------|-------|
| **Reasoning** | Better system prompts, chain-of-thought | `src/agents/langgraph/prompt_manager.ts`, `src/prompts/` |
| **Tool Selection** | Smarter tool choice, fewer unnecessary calls | `src/agents/langgraph/react_graph_nodes.ts` |
| **Error Handling** | Recovery from tool failures, retries | `src/agents/langgraph/tool_executor.ts` |
| **Observability** | Add OpenTelemetry instrumentation | `src/utils/metrics_emitter.ts` |
| **Performance** | Reduce token usage, optimize context | `src/agents/langgraph/bedrock_client.ts` |
| **Logging** | Structured logging for debugging | `src/utils/logger.ts` |

## Architecture

```
src/
├── main.ts                    # CLI entry point
├── main_ag_ui.ts              # AG-UI HTTP server entry point
├── agents/
│   ├── agent_factory.ts       # Creates agent instances
│   ├── base_agent.ts          # Base agent interface
│   └── langgraph/             # ReAct agent implementation
│       ├── react_agent.ts     # Main agent class
│       ├── react_graph_builder.ts  # LangGraph graph construction
│       ├── react_graph_nodes.ts    # Reason/Act/Observe nodes
│       ├── bedrock_client.ts       # AWS Bedrock LLM client
│       ├── prompt_manager.ts       # System prompt management
│       └── tool_executor.ts        # Tool call execution
├── mcp/                       # MCP client (local + HTTP)
├── server/                    # Express.js HTTP server
├── config/                    # Configuration loading
├── prompts/                   # System prompt templates
├── types/                     # TypeScript types
└── utils/                     # Logging, metrics, utilities
```

## Configuration

### Environment Variables
- `AWS_REGION`: AWS region for Bedrock (default: us-west-2)
- `AWS_PROFILE`: AWS profile for authentication
- `AG_UI_PORT`: HTTP server port (default: 3000)
- `AG_UI_CORS_ORIGINS`: Allowed CORS origins

### MCP Server Configuration
Configure in `configuration/mcp_config.json`. Supports both local (stdio) and remote (HTTP) MCP servers.

## Limitations

- **Not production-ready** — this is a learning and evaluation target
- Requires AWS Bedrock access with Claude model permissions
- Single-threaded request processing
- Tool execution is synchronous
- No conversation history persistence

## Attribution

This agent is based on the [osd-agents](https://github.com/opensearch-project/OpenSearch-Dashboards/tree/main/packages/osd-agents) package from OpenSearch Dashboards, licensed under Apache 2.0.
