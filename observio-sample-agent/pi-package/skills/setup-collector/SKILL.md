---
name: setup-collector
description: >
  Set up an OpenTelemetry collector or OSIS pipeline to route traces from an agent
  to OpenSearch for Agent Health consumption. Covers OSIS, OTel Collector, and
  direct export configurations.
---

# Set Up Trace Collection Pipeline

You are helping the user configure a pipeline to get their agent's OTel traces into OpenSearch where Agent Health can read them.

## Architecture Options

```
Agent → OTLP/HTTP → [Pipeline] → OpenSearch
```

Three pipeline options:

| Option | Best For | Complexity |
|--------|----------|------------|
| OSIS (OpenSearch Ingestion) | AWS-managed, production | Low (managed) |
| OTel Collector | Self-hosted, flexible routing | Medium |
| Direct export | Dev/testing only | Lowest |

## Option 1: OSIS Pipeline (Recommended for AWS)

### Prerequisites
- AWS account with OSIS access
- OpenSearch domain (managed or serverless)

### Pipeline Configuration

```yaml
version: "2"
otel-trace-pipeline:
  source:
    otel_trace_source:
      path: "/v1/traces"
  processor:
    - otel_trace_raw:
  sink:
    - opensearch:
        hosts: ["https://your-opensearch-domain.us-west-2.es.amazonaws.com"]
        index: "otel-v1-apm-span-*"
        aws:
          sts_role_arn: "arn:aws:iam::ACCOUNT:role/osis-role"
          region: "us-west-2"
```

### Agent Configuration

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-osis-pipeline.us-west-2.osis.amazonaws.com/v1/traces
OTEL_SERVICE_NAME=my-agent
```

## Option 2: OTel Collector (Self-hosted)

### docker-compose.yml

```yaml
services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    ports:
      - "4318:4318"  # OTLP HTTP
    volumes:
      - ./otel-config.yaml:/etc/otelcol-contrib/config.yaml
```

### otel-config.yaml

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 100

exporters:
  opensearch:
    http:
      endpoint: "https://your-opensearch:9200"
      tls:
        insecure: false
    dataset: "traces"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [opensearch]
```

### Agent Configuration

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
OTEL_SERVICE_NAME=my-agent
```

## Option 3: Direct Export (Dev Only)

Export directly to OpenSearch Data Prepper format. Not recommended for production (no batching, no retry).

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-opensearch:9200/_plugins/_trace_analytics/v1/traces
```

## Agent Health Configuration

Once traces are flowing to OpenSearch, configure Agent Health to read them:

```bash
# In your Agent Health .env
OPENSEARCH_LOGS_ENDPOINT=https://your-opensearch:9200
OPENSEARCH_LOGS_USERNAME=admin
OPENSEARCH_LOGS_PASSWORD=admin
# Or for AWS SigV4:
# OPENSEARCH_LOGS_AUTH_TYPE=sigv4
# OPENSEARCH_LOGS_AWS_REGION=us-west-2
```

## Verification Checklist

1. **Agent sends spans**: Check agent logs for "telemetry enabled" message
2. **Pipeline receives**: Check OSIS/Collector metrics for incoming spans
3. **OpenSearch has data**: Query `otel-v1-apm-span-*` index
4. **Agent Health sees traces**: Open Traces tab, verify spans appear with correct categorization

## Troubleshooting

| Issue | Check |
|-------|-------|
| No spans arriving | Is `OTEL_EXPORTER_OTLP_ENDPOINT` correct? Is the agent calling `provider.register()`? |
| Spans in OS but not in Agent Health | Check index pattern matches what Agent Health queries (`otel-v1-apm-span-*`) |
| Auth errors | Check IAM role for OSIS, or username/password for basic auth |
| Spans arrive but incomplete | Ensure `provider.shutdown()` is called on agent exit (flushes batch) |
