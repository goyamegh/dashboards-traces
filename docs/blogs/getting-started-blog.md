## Getting Started with Agent Health: A Complete Walkthrough

In our [introductory blog post](https://opensearch.org/blog/opensearch-agent-health/), we showed you what Agent Health is and why it matters. Now let's roll up our sleeves and go through a hands-on walkthrough.

This guide is progressive — you can stop at any point and come back later:

1. **Try sample data** — explore the UI with zero setup
2. **Try it yourself** — connect your own agent endpoint, configure a judge, and run your first evaluation (no OpenSearch required)
3. **Add tracing** — connect or instrument OpenTelemetry traces for deep observability

**What you'll need to start:** You have an agent (any protocol), an LLM provider, and optionally tracing via OpenTelemetry to some backend. Agent Health plugs into all of these.

<!-- TODO: Diagram — high-level: Agent + LLM + (optional) OTel tracing → Agent Health -->

### Prerequisites
* [Node.js](https://nodejs.org/) 18 or later
* [Docker](https://www.docker.com/) (optional — for the local OpenSearch stack or the Docker Compose setup)
* AWS credentials (for the Bedrock LLM judge) or an OpenAI-compatible endpoint (for LiteLLM, Ollama, etc.)

### Launch Agent Health

```
npx @opensearch-project/agent-health
```

Open your browser to `http://localhost:4001`. You'll land on the Agent Health home screen with three main sections: **Traces**, **Benchmarks**, and **Compare**.

<!-- TODO: Screenshot — Agent Health home screen -->

---

## Part I: Try Sample Data

Before connecting your own agent, explore with the pre-loaded demo data. This gives you a feel for the interface with zero configuration.

### Traces view

Navigate to the **Traces** tab. You'll see pre-loaded agent execution traces. Click any trace to open the detail view:
* **Timeline view** — a chronological breakdown of every span (LLM call, tool invocation, retrieval step) with durations
* **Flow view** — a visual graph of how data flows between agent components
* **Span details** — click any span to see its attributes, inputs, outputs, and metadata

<!-- TODO: Screenshot — Traces list + detail view -->

### Benchmarks view

Navigate to **Benchmarks**. You'll find a demo benchmark called "Travel Planning Accuracy - Demo". Click into it to see the test cases, then run it to watch the LLM judge evaluate each case in real time.

<!-- TODO: Screenshot — Benchmark detail with test cases -->

### Compare view

After running a benchmark, go to **Compare**. Select two runs to see side-by-side metrics: pass rate, latency, cost, and per-test-case diffs.

<!-- TODO: Screenshot — Compare view side-by-side -->

---

## Part II: Try It Yourself

Now let's connect your own agent and run a real evaluation. No OpenSearch storage required — Agent Health stores data locally on disk by default.

<!-- TODO: Diagram — build-up: Agent Health box, now adding "Your Agent" arrow -->

### Step 1: Configure your agent endpoint

Create an `agent-health.config.ts` file in your working directory (or run `npx @opensearch-project/agent-health init` to generate one):

```typescript
export default {
  agents: [
    {
      key: "my-agent",
      name: "My Agent",
      endpoint: "http://localhost:3000/agent",
      connectorType: "agui-streaming",
      models: ["claude-sonnet-4"],
      useTraces: false,   // No OpenSearch tracing required for basic evaluation
    }
  ],
};
```

**Connector types** determine how Agent Health communicates with your agent. They fall into three categories:

**Agent Protocol** — connectors that know the full request/response contract of a specific agent framework:

| Connector | Protocol |
|-----------|----------|
| `agui-streaming` | [AG-UI](https://docs.ag-ui.com) SSE streaming protocol (default) |
| `claude-code` | Claude Code CLI — NDJSON streaming with MCP tool support |

**Transport** — generic communication channels where you control the payload format via hooks or a custom connector:

| Connector | Protocol |
|-----------|----------|
| `rest` | Standard HTTP POST — Agent Health sends JSON and parses common response shapes |
| `cli` | Spawns a CLI command as a child process, captures stdout |

**LLM Protocol** — talks directly to an LLM endpoint (useful for evaluating raw model responses, not a full agent loop):

| Connector | Protocol |
|-----------|----------|
| `openai-compatible` | OpenAI Chat Completions standard: `POST /v1/chat/completions` with `messages` array. Works with LiteLLM, Ollama, vLLM, Azure OpenAI, OpenAI, etc. |

**Testing:**

| Connector | Protocol |
|-----------|----------|
| `mock` | In-memory demo trajectory, no real agent needed |

#### Writing your own connector

If none of the built-in connectors fit your agent's protocol, you can write a custom one. Create a class that extends `BaseConnector` and implement three methods: `buildPayload`, `execute`, and `parseResponse`.

```typescript
import { BaseConnector } from '@opensearch-project/agent-health/connectors';
import type {
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
} from '@opensearch-project/agent-health/connectors';
import type { TrajectoryStep } from '@opensearch-project/agent-health/types';

class MyCustomConnector extends BaseConnector {
  readonly type = 'my-protocol' as const;
  readonly name = 'My Custom Protocol';
  readonly supportsStreaming = false;

  buildPayload(request: ConnectorRequest): any {
    // Transform the standard request into your agent's expected format
    return {
      query: request.testCase.initialPrompt,
      model: request.modelId,
    };
  }

  async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    const payload = request.payload || this.buildPayload(request);
    const headers = this.buildAuthHeaders(auth);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    onRawEvent?.(data);

    const trajectory = this.parseResponse(data);
    trajectory.forEach(step => onProgress?.(step));

    return { trajectory, runId: data.id || null };
  }

  parseResponse(data: any): TrajectoryStep[] {
    // Convert your agent's response format into TrajectoryStep array
    return [
      this.createStep('thinking', data.reasoning || ''),
      this.createStep('response', data.answer || JSON.stringify(data)),
    ];
  }
}
```

Register your connector in `agent-health.config.ts`:

```typescript
export default {
  connectors: [new MyCustomConnector()],
  agents: [
    {
      key: "my-agent",
      name: "My Agent",
      endpoint: "http://localhost:3000/agent",
      connectorType: "my-protocol",
      models: ["claude-sonnet-4"],
      useTraces: false,
    }
  ],
};
```

#### Lifecycle hooks

For simpler customizations — adding auth tokens, modifying payloads, pre-creating threads — you can use lifecycle hooks without writing a full connector:

```typescript
{
  key: "my-agent",
  // ...
  hooks: {
    beforeRequest: async ({ endpoint, payload, headers }) => {
      // e.g., add auth tokens, modify payload, pre-create threads
      return { endpoint, payload, headers };
    },
  },
}
```

<!-- TODO: Diagram — build-up: Agent Health ↔ Your Agent (with connector arrow) -->

### Step 2: Configure the judge

The LLM judge evaluates your agent's responses against expected outcomes. Agent Health supports two judge providers:

**Option A: AWS Bedrock (default)**

```bash
# AWS profile (recommended)
export AWS_PROFILE=your-profile
export AWS_REGION=us-east-1

# Or explicit credentials
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...
```

**Option B: OpenAI-compatible endpoint** — any provider that implements the OpenAI Chat Completions standard (`POST /v1/chat/completions` with `messages` array). This includes LiteLLM, Ollama, vLLM, Azure OpenAI, or OpenAI directly.

```bash
export OPENAI_COMPATIBLE_ENDPOINT=http://localhost:4000/v1/chat/completions
export OPENAI_COMPATIBLE_API_KEY=your-api-key  # optional, depends on provider
```

You can also configure the judge in `agent-health.config.ts`:

```typescript
export default {
  judge: {
    provider: "openai-compatible",  // or "bedrock" (default)
    model: "gpt-4o",               // model name forwarded to the endpoint
  },
  // ...agents, etc.
};
```

<!-- TODO: This section will expand once judge configuration UI is implemented -->

<!-- TODO: Diagram — build-up: Agent Health ↔ Your Agent, Agent Health ↔ Judge -->

### Step 3: Run your first evaluation

With your agent endpoint and judge configured, you can run an evaluation — no OpenSearch storage or tracing required.

#### Create test cases

<!-- TODO: Replace these sample test cases with ones based on our own shipped evaluation engine / sample agent -->

Create a file called `travel-benchmark.json` with test cases for your agent:

```json
[
  {
    "name": "Basic flight search",
    "description": "User asks for a simple flight search",
    "labels": ["category:Travel", "difficulty:Easy"],
    "initialPrompt": "Find me flights from Seattle to New York next Friday",
    "expectedOutcomes": [
      "Agent should call search_flights tool with origin=Seattle and destination=New York",
      "Agent should present flight options with times and prices"
    ]
  },
  {
    "name": "Hotel search with dates",
    "description": "User asks for hotel availability",
    "labels": ["category:Travel", "difficulty:Easy"],
    "initialPrompt": "Are there any hotels available in Manhattan for March 20-22?",
    "expectedOutcomes": [
      "Agent should call search_hotels tool with location=Manhattan",
      "Agent should present hotel options with prices and ratings"
    ]
  },
  {
    "name": "Multi-step trip planning",
    "description": "User asks for both flights and hotels in one query",
    "labels": ["category:Travel", "difficulty:Medium"],
    "initialPrompt": "Plan a trip from Seattle to New York next weekend. I need both flights and a hotel.",
    "expectedOutcomes": [
      "Agent should call search_flights tool",
      "Agent should call search_hotels tool",
      "Agent should present a combined itinerary with flight and hotel options"
    ]
  }
]
```

You can also create test cases directly in the UI via **Settings > Use Cases**.

#### Run via CLI

```
npx @opensearch-project/agent-health benchmark \
  -f travel-benchmark.json \
  -a my-agent \
  -v
```

This will:
* Import the test cases
* Send each `initialPrompt` to your agent
* Have the LLM judge score agent responses against `expectedOutcomes`

#### Run via UI

Alternatively, in the Agent Health UI:
* Go to **Benchmarks**
* Click **Import JSON** and select `travel-benchmark.json`
* Click **Run** on your benchmark
* Select your agent endpoint and judge model
* Watch as each test case runs and gets evaluated in real time

<!-- TODO: Screenshot — Benchmark run in progress -->

#### Analyze results

Open the benchmark run results to see:
* **Overall pass rate** — what percentage of test cases passed
* **Per-test-case results** — each test case with its pass/fail status, the LLM judge's reasoning, and a score
* **Improvement strategies** — prioritized recommendations for what to fix first

For failed test cases, the LLM judge explains exactly _why_ it failed — for example, "the agent did not call search_hotels as expected" or "the response was missing price information."

#### Iterate and compare

Make improvements to your agent (update prompts, add tools, change models), then re-run the benchmark. Use the **Compare** view to see side-by-side how your changes affected:
* Pass rates across all test cases
* Individual test case outcomes that flipped from fail to pass (or vice versa)
* Latency and cost changes

<!-- TODO: Diagram — build-up: full eval loop: Agent Health ↔ Agent ↔ Judge, with results -->

---

## Part III: Add Tracing

Tracing gives you deep visibility into what your agent does internally — every LLM call, tool invocation, and reasoning step. Pick the scenario that matches your situation:

### Scenario A: You already have traces in OpenSearch

If your agent already sends OTel traces to an OpenSearch cluster, just point Agent Health at it.

**Configure the Observability Storage connection** (pick one):

* **Via Settings UI** — Go to **Settings** and fill in the **Observability Storage** section with your OpenSearch cluster URL and credentials. Choose "Basic Auth" for username/password or "AWS SigV4" for AWS-managed clusters.
* **Via environment variables** — Add the connection details to your `.env` file:

```bash
# Option A: Basic Auth (username/password)
OPENSEARCH_LOGS_ENDPOINT=https://your-opensearch-cluster:9200
OPENSEARCH_LOGS_USERNAME=admin
OPENSEARCH_LOGS_PASSWORD=admin

# Option B: AWS SigV4 (for AWS-managed OpenSearch or Serverless)
OPENSEARCH_LOGS_ENDPOINT=https://your-cluster.us-east-1.es.amazonaws.com
OPENSEARCH_LOGS_AUTH_TYPE=sigv4
OPENSEARCH_LOGS_AWS_REGION=us-east-1
OPENSEARCH_LOGS_AWS_SERVICE=es        # 'es' for managed, 'aoss' for Serverless
# OPENSEARCH_LOGS_AWS_PROFILE=MyProfile  # optional, uses default credential chain
```

Then enable traces for your agent in `agent-health.config.ts`:

```typescript
{
  key: "my-agent",
  name: "My Agent",
  endpoint: "http://localhost:3000/agent",
  connectorType: "rest",
  useTraces: true,   // Enable trace collection for this agent
  models: ["claude-sonnet-4"],
}
```

Navigate to the **Traces** tab — you should see your agent's traces immediately.

Now re-run your benchmark from Step 3. Each evaluation run will also pull in the associated traces — giving you full visibility into what the agent did internally, alongside the judge's assessment.

<!-- TODO: Screenshot — Traces tab showing real agent traces -->

### Scenario B: Your traces go to another backend (Jaeger, Grafana, etc.)

If your agent already has OTel instrumentation but traces go to a non-OpenSearch backend, you need a local OpenSearch + OTel Collector stack to receive them. Two options:

**Option 1: Observability Stack shell script**

```
curl -fsSL https://raw.githubusercontent.com/opensearch-project/observability-stack/main/install.sh | bash
```

This launches:
* **OpenSearch** on port `9200` — stores traces
* **OTEL Collector** on port `4317` — receives OpenTelemetry traces

**Option 2: Docker Compose**

<!-- TODO: Add Docker Compose instructions — this may be consolidated into a single Docker Compose that ships with Agent Health itself, which would simplify both options into one -->

Both options give you the same result. Then:
1. Swap your agent's OTEL exporter endpoint to `http://localhost:4317`
2. Configure the Observability Storage connection in Agent Health (via Settings UI or `.env` file, as shown in Scenario A)
3. Enable `useTraces: true` for your agent in `agent-health.config.ts`

<!-- TODO: Test shell script with Docker and add detailed instructions -->

### Scenario C: Your agent has no OTel instrumentation yet

If your agent doesn't have OpenTelemetry instrumentation, you'll need to add it. Here's a walkthrough using a Python agent as an example.

<!-- TODO: Ship a sample agent with Agent Health that users can run to test the tracing flow end-to-end without needing their own instrumented agent -->

#### A sample agent (before instrumentation)

```python
# travel_agent.py
import openai

client = openai.OpenAI()

tools = [
    {
        "type": "function",
        "function": {
            "name": "search_flights",
            "description": "Search for available flights",
            "parameters": {
                "type": "object",
                "properties": {
                    "origin": {"type": "string"},
                    "destination": {"type": "string"},
                    "date": {"type": "string"}
                },
                "required": ["origin", "destination", "date"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_hotels",
            "description": "Search for available hotels",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string"},
                    "check_in": {"type": "string"},
                    "check_out": {"type": "string"}
                },
                "required": ["location", "check_in", "check_out"]
            }
        }
    }
]

def run_agent(user_query: str) -> str:
    messages = [
        {"role": "system", "content": "You are a helpful travel planning assistant."},
        {"role": "user", "content": user_query}
    ]
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,
        tools=tools,
    )
    return response.choices[0].message.content

if __name__ == "__main__":
    result = run_agent("Find me flights from Seattle to New York next Friday")
    print(result)
```

#### Add OpenTelemetry instrumentation

Install the required packages:

```
pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp \
    opentelemetry-instrumentation-openai
```

Now add tracing to the agent:

```python
# travel_agent_traced.py
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource

# Configure the tracer to send spans to the OTEL Collector
resource = Resource.create({"service.name": "travel-agent"})
provider = TracerProvider(resource=resource)
exporter = OTLPSpanExporter(endpoint="http://localhost:4317", insecure=True)
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)

tracer = trace.get_tracer("travel-agent")

# Auto-instrument OpenAI calls (captures LLM spans automatically)
from opentelemetry.instrumentation.openai import OpenAIInstrumentor
OpenAIInstrumentor().instrument()

import openai

client = openai.OpenAI()

tools = [
    # ... same tool definitions as above ...
]

def search_flights(origin, destination, date):
    """Simulated flight search."""
    with tracer.start_as_current_span("tool.search_flights") as span:
        span.set_attribute("tool.name", "search_flights")
        span.set_attribute("tool.parameters.origin", origin)
        span.set_attribute("tool.parameters.destination", destination)
        results = [
            {"flight": "AA123", "time": "8:00 AM", "price": "$350"},
            {"flight": "UA456", "time": "2:00 PM", "price": "$280"},
        ]
        span.set_attribute("tool.result_count", len(results))
        return results

def search_hotels(location, check_in, check_out):
    """Simulated hotel search."""
    with tracer.start_as_current_span("tool.search_hotels") as span:
        span.set_attribute("tool.name", "search_hotels")
        span.set_attribute("tool.parameters.location", location)
        results = [
            {"hotel": "Hilton Manhattan", "price": "$200/night", "rating": 4.5},
        ]
        span.set_attribute("tool.result_count", len(results))
        return results

def run_agent(user_query: str) -> str:
    with tracer.start_as_current_span("agent.run") as span:
        span.set_attribute("agent.name", "travel-agent")
        span.set_attribute("agent.input", user_query)

        messages = [
            {"role": "system", "content": "You are a helpful travel planning assistant."},
            {"role": "user", "content": user_query}
        ]

        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            tools=tools,
        )

        result = response.choices[0].message.content
        span.set_attribute("agent.output", result or "")
        return result

if __name__ == "__main__":
    result = run_agent("Find me flights from Seattle to New York next Friday")
    print(result)
    # Flush spans before exit
    provider.force_flush()
```

#### Run the agent and view traces

```
python travel_agent_traced.py
```

Now go back to **Traces** in Agent Health (`http://localhost:4001`). You should see a new trace appear showing:
* The top-level `agent.run` span with your query
* Nested LLM call spans (auto-instrumented by the OpenAI instrumentor)
* Tool call spans like `tool.search_flights`

Click into the trace to explore the timeline and flow views. You can now see exactly what your agent did, how long each step took, and what data flowed between components.

<!-- TODO: Screenshot — Trace detail with timeline and flow views -->

Once traces are flowing, re-run your benchmark from Step 3 to get evaluations with full trace data.

<!-- TODO: Diagram — complete picture: Agent Health ↔ Agent ↔ Judge + OTel traces flowing in -->

---

## Next steps

You now have a complete Agent Health workflow — from exploring sample data, to evaluating your own agent, to adding deep observability with OTel traces. From here, you can:
* Add more test cases to cover edge cases and failure modes
* Integrate benchmark runs into your CI/CD pipeline for automated regression testing
* Explore the trace views to debug specific agent failures in detail
* Use the **Compare** view to A/B test agent configurations over time

We'll cover each of these topics in upcoming posts. Stay tuned!

## Resources
* **GitHub Repository**: [opensearch-project/agent-health](https://github.com/opensearch-project/agent-health)
* **First blog post**: [OpenSearch Agent Health: Open-Source Observability and Evaluation for AI Agents](https://opensearch.org/blog/opensearch-agent-health/)
* **OpenTelemetry instrumentation guides**: [opentelemetry.io/docs/instrumentation](https://opentelemetry.io/docs/instrumentation/)
* **OpenSearch Observability Stack**: [opensearch-project/observability-stack](https://github.com/opensearch-project/observability-stack)
