---
name: instrument-otel
description: >
  Add OpenTelemetry instrumentation to an AI agent for Agent Health observability.
  Use when a user wants to make their agent's traces visible in Agent Health dashboards,
  or when debugging why traces aren't appearing. Covers span structure, Gen AI semantic
  conventions, required attributes, and OTLP exporter setup.
---

# Instrument Agent with OpenTelemetry

You are helping the user add OpenTelemetry instrumentation to their AI agent so it produces traces that Agent Health can consume and visualize.

## What Agent Health Expects

Agent Health categorizes spans by reading `gen_ai.operation.name`:
- `invoke_agent` → AGENT span (root)
- `chat` → LLM span (model calls)
- `execute_tool` → TOOL span (tool invocations)

All other spans are categorized as FRAMEWORK.

## Step 1: Determine the User's Stack

Ask the user:
1. What language/runtime? (Node.js, Python, Java, Go)
2. What LLM provider? (Bedrock, OpenAI, Anthropic, etc.)
3. What framework? (LangChain, LangGraph, Strands, custom)
4. Where should traces export to? (OSIS pipeline, local collector, direct to OpenSearch)

## Step 2: Set Up the Tracer Provider

Generate a telemetry provider module. Requirements:
- Use `BatchSpanProcessor` (not Simple) for production
- Set `service.name` resource attribute to identify the agent
- Export via OTLP/HTTP to the configured endpoint
- Make it opt-in via environment variable

### Reference Pattern (Node.js/TypeScript)

```typescript
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

const resource = resourceFromAttributes({
  'service.name': process.env.OTEL_SERVICE_NAME || 'my-agent',
});

const provider = new NodeTracerProvider({
  resource,
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT })
    ),
  ],
});
provider.register();
```

### Python Equivalent

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource

resource = Resource.create({"service.name": "my-agent"})
provider = TracerProvider(resource=resource)
provider.add_span_processor(BatchSpanExporter(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
```

## Step 3: Create Span Helpers

Generate helper functions for each span type. These MUST follow the naming and attribute conventions exactly.

### Root Agent Span

```typescript
function startAgentSpan(runId: string) {
  const span = tracer.startSpan('invoke_agent <agent-name>', {
    kind: SpanKind.SERVER,
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.system': '<provider>',        // e.g. 'aws.bedrock'
      'gen_ai.agent.name': '<agent-name>',
      'gen_ai.request.id': runId,
    },
  });
  return { span, ctx: trace.setSpan(context.active(), span) };
}
```

### LLM Call Span (child of agent)

```typescript
function startLLMSpan(parentCtx: Context, opts: { modelId: string; temperature?: number; maxTokens?: number }) {
  const span = tracer.startSpan('chat <system>', {
    kind: SpanKind.CLIENT,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': '<provider>',
      'gen_ai.request.model': opts.modelId,
      'gen_ai.request.temperature': opts.temperature,
      'gen_ai.request.max_tokens': opts.maxTokens,
    },
  }, parentCtx);
  return { span, ctx: trace.setSpan(parentCtx, span) };
}

function endLLMSpan(span: Span, opts: { inputTokens?: number; outputTokens?: number; stopReason?: string }) {
  if (opts.inputTokens) span.setAttribute('gen_ai.usage.input_tokens', opts.inputTokens);
  if (opts.outputTokens) span.setAttribute('gen_ai.usage.output_tokens', opts.outputTokens);
  if (opts.stopReason) span.setAttribute('gen_ai.response.finish_reason', opts.stopReason);

  // Add content events
  span.addEvent('gen_ai.content.prompt', { 'gen_ai.prompt': '...' });
  span.addEvent('gen_ai.content.completion', { 'gen_ai.completion': '...' });
  span.end();
}
```

### Tool Execution Span (child of agent)

```typescript
function startToolSpan(parentCtx: Context, toolName: string, toolInput?: any) {
  const span = tracer.startSpan(`execute_tool ${toolName}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': toolName,
    },
  }, parentCtx);

  if (toolInput) {
    span.addEvent('gen_ai.tool.input', {
      'gen_ai.tool.input': JSON.stringify(toolInput).slice(0, 3000),
    });
  }
  return { span, ctx: trace.setSpan(parentCtx, span) };
}

function endToolSpan(span: Span, result?: any, error?: Error) {
  if (result) {
    span.addEvent('gen_ai.tool.output', {
      'gen_ai.tool.output': JSON.stringify(result).slice(0, 3000),
    });
  }
  if (error) span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  span.end();
}
```

## Step 4: Wire Into the Agent Loop

Show the user where to place span calls in their agent's execution flow:

```
┌─────────────────────────────────────────────┐
│ startAgentSpan(runId)                        │  ← Root span
│                                              │
│   ┌─── Loop ───────────────────────────┐    │
│   │ startLLMSpan(agentCtx, {...})       │    │  ← Each model call
│   │   → call LLM                        │    │
│   │ endLLMSpan(span, {tokens, reason})  │    │
│   │                                      │    │
│   │ if tool_calls:                       │    │
│   │   startToolSpan(agentCtx, name)     │    │  ← Each tool execution
│   │     → execute tool                   │    │
│   │   endToolSpan(span, result)         │    │
│   └─────────────────────────────────────┘    │
│                                              │
│ agentSpan.end()                              │  ← End root span
└─────────────────────────────────────────────┘
```

## Step 5: Verify

After instrumentation, help the user verify:

1. **Exporter connectivity**: Check OTLP endpoint is reachable
2. **Span hierarchy**: Root agent span has LLM + tool children
3. **Required attributes**: All `gen_ai.*` attributes present
4. **Events**: Prompt/completion events on LLM spans, input/output on tool spans
5. **Agent Health visibility**: Traces appear in the Traces tab with correct categorization

Use the `validate_spans` tool to check their code automatically.

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| No traces in Agent Health | Exporter endpoint wrong or unreachable | Check `OTEL_EXPORTER_OTLP_ENDPOINT` |
| Spans show as FRAMEWORK | Missing `gen_ai.operation.name` attribute | Add the attribute to every span |
| No token metrics | Missing `gen_ai.usage.*` attributes | Set on LLM span end |
| Flat span list (no tree) | Not passing parent context | Use `parentCtx` in startSpan |
| Traces appear but no cost data | Missing model attribute | Set `gen_ai.request.model` |

## Environment Variables

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-osis-pipeline/v1/traces
OTEL_SERVICE_NAME=my-agent
OTEL_ENABLED=true  # optional, default true
```
