/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTel TracerProvider for the Observio sample agent.
 *
 * Exports spans via OTLP/HTTP to an OSI pipeline endpoint.
 * Uses a diagnostic wrapper around OTLPTraceExporter that surfaces
 * export failures instead of swallowing them silently.
 *
 * Configuration (via .env or inherited from parent process):
 *   OTEL_EXPORTER_OTLP_ENDPOINT — OTLP pipeline URL (required)
 *   OTEL_SERVICE_NAME — service name (default: observio-sample-agent)
 *   OTEL_ENABLED — set to 'false' to disable (default: enabled)
 */

import { trace, context, type Tracer, type Context, type Span } from '@opentelemetry/api';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';

export const OBSERVIO_TRACER_NAME = 'observio-sample-agent';

let provider: NodeTracerProvider | null = null;

/**
 * Wraps an OTLP exporter to log export results — both success and failure.
 * The default OTLPTraceExporter swallows errors internally; this makes them visible.
 */
class DiagnosticExporterWrapper implements SpanExporter {
  private delegate: SpanExporter;
  private exportCount = 0;
  private errorCount = 0;

  constructor(delegate: SpanExporter) {
    this.delegate = delegate;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.delegate.export(spans, (result) => {
      this.exportCount++;
      if (result.code === ExportResultCode.SUCCESS) {
        console.log(`[Telemetry] OTLP export success: ${spans.length} span(s) sent`);
      } else {
        this.errorCount++;
        const errMsg = result.error?.message || 'unknown error';
        console.error(`[Telemetry] OTLP export FAILED (${this.errorCount}/${this.exportCount} total failures): ${errMsg}`);
        if (this.errorCount === 1) {
          console.error('[Telemetry] Hint: Check that OTEL_EXPORTER_OTLP_ENDPOINT is reachable and accepts unauthenticated OTLP/HTTP requests.');
        }
      }
      resultCallback(result);
    });
  }

  async shutdown(): Promise<void> {
    if (this.errorCount > 0) {
      console.warn(`[Telemetry] Observio OTLP exporter shutting down with ${this.errorCount}/${this.exportCount} failed exports`);
    }
    return this.delegate.shutdown?.() ?? Promise.resolve();
  }

  async forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}

/**
 * Initialize OTel telemetry for the observio agent.
 * Requires OTEL_EXPORTER_OTLP_ENDPOINT to be set (typically inherited from parent .env).
 */
export function initTelemetry(): void {
  if (provider) return;

  const enabled = process.env.OTEL_ENABLED !== 'false'; // enabled by default
  if (!enabled) {
    console.log('[Telemetry] Observio telemetry disabled (OTEL_ENABLED=false)');
    return;
  }

  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!otlpEndpoint) {
    console.log('[Telemetry] Observio telemetry disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)');
    return;
  }

  const otlpExporter = new OTLPTraceExporter({ url: otlpEndpoint });
  const exporter = new DiagnosticExporterWrapper(otlpExporter);
  console.log(`[Telemetry] Observio telemetry enabled → OTLP (${otlpEndpoint})`);

  const resource = resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME || 'observio-sample-agent',
    'telemetry.sdk.name': 'observio-sample-agent',
    'telemetry.sdk.language': 'nodejs',
  });

  // Use SimpleSpanProcessor for immediate export — agent runs are infrequent
  // and we need spans to land before the trace poller starts looking
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
