/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTel TracerProvider for the Observio sample agent.
 *
 * Supports two export modes:
 *   1. Direct OpenSearch — writes spans directly to the Agent Health cluster
 *      (preferred, uses OPENSEARCH_LOGS_ENDPOINT)
 *   2. OTLP/HTTP — exports via OTLP to an OSI pipeline endpoint
 *      (fallback, uses OTEL_EXPORTER_OTLP_ENDPOINT)
 *
 * Configuration (via .env):
 *   OPENSEARCH_LOGS_ENDPOINT — OpenSearch cluster URL (preferred)
 *   OPENSEARCH_LOGS_USERNAME / OPENSEARCH_LOGS_PASSWORD — basic auth
 *   OTEL_EXPORTER_OTLP_ENDPOINT — OTLP pipeline URL (fallback)
 *   OTEL_SERVICE_NAME — service name (default: observio-sample-agent)
 *   OTEL_ENABLED — set to 'false' to disable (default: enabled)
 */

import { trace, context, type Tracer, type Context, type Span } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OpenSearchSpanExporter, type OpenSearchExporterConfig } from './opensearchExporter';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

export const OBSERVIO_TRACER_NAME = 'observio-sample-agent';

let provider: NodeTracerProvider | null = null;

/**
 * Read the observability config from the parent project's agent-health.config.json.
 * This ensures observio exports to the same cluster that the dashboard reads from.
 */
function readObservabilityConfig(): OpenSearchExporterConfig | null {
  // Walk up to find agent-health.config.json (from observio-sample-agent/)
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'agent-health.config.json');
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, 'utf-8'));
        const obs = raw.observability;
        if (obs?.endpoint) {
          return {
            endpoint: obs.endpoint,
            authType: obs.authType || 'basic',
            username: obs.username,
            password: obs.password,
            awsRegion: obs.awsRegion,
            awsProfile: obs.awsProfile,
            awsService: obs.awsService || 'es',
            indexName: obs.indexes?.traces?.replace('*', '000001') || 'otel-v1-apm-span-000001',
            tlsSkipVerify: obs.tlsSkipVerify,
          };
        }
      } catch { /* ignore parse errors */ }
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Initialize OTel telemetry for the observio agent.
 *
 * Priority:
 *   1. Direct OpenSearch via env vars (OPENSEARCH_LOGS_ENDPOINT)
 *   2. Direct OpenSearch via agent-health.config.json observability data source
 *   3. OTLP/HTTP fallback (OTEL_EXPORTER_OTLP_ENDPOINT)
 */
export function initTelemetry(): void {
  if (provider) return;

  const enabled = process.env.OTEL_ENABLED !== 'false'; // enabled by default
  if (!enabled) {
    console.log('[Telemetry] Observio telemetry disabled (OTEL_ENABLED=false)');
    return;
  }

  let exporter: SpanExporter;
  const osEndpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (osEndpoint) {
    exporter = new OpenSearchSpanExporter({
      endpoint: osEndpoint,
      username: process.env.OPENSEARCH_LOGS_USERNAME,
      password: process.env.OPENSEARCH_LOGS_PASSWORD,
      authType: (process.env.OPENSEARCH_LOGS_AUTH_TYPE as any) || 'basic',
      awsRegion: process.env.OPENSEARCH_LOGS_AWS_REGION,
      awsProfile: process.env.OPENSEARCH_LOGS_AWS_PROFILE,
      awsService: (process.env.OPENSEARCH_LOGS_AWS_SERVICE as any) || 'es',
      indexName: process.env.OPENSEARCH_LOGS_TRACES_INDEX?.replace('*', '000001') || 'otel-v1-apm-span-000001',
      tlsSkipVerify: true,
    });
    console.log(`[Telemetry] Observio telemetry enabled → OpenSearch (${osEndpoint})`);
  } else {
    // Try reading from shared config file
    const obsConfig = readObservabilityConfig();
    if (obsConfig) {
      exporter = new OpenSearchSpanExporter(obsConfig);
      console.log(`[Telemetry] Observio telemetry enabled → OpenSearch via config (${obsConfig.endpoint})`);
    } else if (otlpEndpoint) {
      exporter = new OTLPTraceExporter({ url: otlpEndpoint });
      console.log(`[Telemetry] Observio telemetry enabled → OTLP (${otlpEndpoint})`);
    } else {
      console.log('[Telemetry] Observio telemetry disabled (no data source configured)');
      return;
    }
  }

  const resource = resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME || 'observio-sample-agent',
    'telemetry.sdk.name': 'observio-sample-agent',
    'telemetry.sdk.language': 'nodejs',
  });

  // Use SimpleSpanProcessor for immediate export (agent runs are infrequent)
  const spanProcessors = [
    new SimpleSpanProcessor(exporter),
  ];

  provider = new NodeTracerProvider({ resource, spanProcessors });
  provider.register();
}

/**
 * Get the observio tracer instance.
 */
export function getTracer(): Tracer {
  return trace.getTracer(OBSERVIO_TRACER_NAME);
}

/**
 * Flush all pending spans to the exporter.
 * Call after ending the root span to ensure immediate export.
 */
export async function flushTelemetry(): Promise<void> {
  if (provider) {
    try {
      await provider.forceFlush();
    } catch (err) {
      console.warn('[Telemetry] forceFlush failed:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Shut down the tracer provider (flush pending spans).
 */
export async function shutdownTelemetry(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
    console.log('[Telemetry] Observio telemetry shut down');
  }
}

// Re-export for convenience
export { trace, context, type Context, type Span };
