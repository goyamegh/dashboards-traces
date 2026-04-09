/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTel TracerProvider management for evaluation telemetry.
 *
 * Manages a singleton TracerProvider that exports evaluation spans
 * via OTLP/HTTP to a collector or Data Prepper pipeline.
 */

import { trace, type Tracer } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { EVAL_TRACER_NAME } from './constants.js';

/**
 * Configuration for evaluation telemetry
 */
export interface EvalTelemetryConfig {
  /** Whether evaluation telemetry is enabled */
  enabled: boolean;
  /** OTLP exporter endpoint (e.g., http://localhost:4318/v1/traces) */
  exporterEndpoint: string;
  /** Optional headers for the OTLP exporter (e.g., auth) */
  exporterHeaders?: Record<string, string>;
  /** Service name for resource attributes */
  serviceName?: string;
}

let provider: NodeTracerProvider | null = null;
let telemetryEnabled = false;

/**
 * Resolve telemetry config from environment variables and optional user config
 */
export function resolveEvalTelemetryConfig(userConfig?: Partial<EvalTelemetryConfig>): EvalTelemetryConfig {
  const enabled = userConfig?.enabled
    ?? process.env.OTEL_EVAL_ENABLED === 'true';

  const exporterEndpoint = userConfig?.exporterEndpoint
    ?? process.env.OTEL_EVAL_EXPORTER_ENDPOINT
    ?? 'http://localhost:4318/v1/traces';

  let exporterHeaders = userConfig?.exporterHeaders;
  if (!exporterHeaders && process.env.OTEL_EVAL_EXPORTER_HEADERS) {
    try {
      exporterHeaders = JSON.parse(process.env.OTEL_EVAL_EXPORTER_HEADERS);
    } catch {
      console.warn('[Telemetry] Failed to parse OTEL_EVAL_EXPORTER_HEADERS as JSON');
    }
  }

  const serviceName = userConfig?.serviceName
    ?? process.env.OTEL_SERVICE_NAME
    ?? 'agent-health';

  return { enabled, exporterEndpoint, exporterHeaders, serviceName };
}

/**
 * Initialize the evaluation TracerProvider.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initEvalTracerProvider(config: EvalTelemetryConfig): void {
  if (provider) {
    return; // Already initialized
  }

  if (!config.enabled) {
    telemetryEnabled = false;
    return;
  }

  const resource = resourceFromAttributes({
    'service.name': config.serviceName ?? 'agent-health',
    'telemetry.sdk.name': 'agent-health',
    'telemetry.sdk.language': 'nodejs',
  });

  const exporter = new OTLPTraceExporter({
    url: config.exporterEndpoint,
    headers: config.exporterHeaders,
  });

  provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();

  telemetryEnabled = true;
  console.log(`[Telemetry] Evaluation telemetry enabled, exporting to ${config.exporterEndpoint}`);
}

/**
 * Get the evaluation tracer. Returns a no-op tracer if telemetry is disabled.
 */
export function getEvalTracer(): Tracer {
  return trace.getTracer(EVAL_TRACER_NAME);
}

/**
 * Check if evaluation telemetry is enabled
 */
export function isEvalTelemetryEnabled(): boolean {
  return telemetryEnabled;
}

/**
 * Flush pending spans and shut down the TracerProvider.
 */
export async function shutdownEvalTracer(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
    telemetryEnabled = false;
    console.log('[Telemetry] Evaluation telemetry shut down');
  }
}
