/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Export-side visibility for evaluation telemetry.
 *
 * Two silent-failure modes made the eval `test_case` span disappear with no
 * trace in the server log (2026-10-24 incident, a server started from a shell
 * that exported the OTel-standard BASE url `OTEL_EXPORTER_OTLP_ENDPOINT=
 * https://<gateway>` and a config that used it verbatim as the traces url):
 *
 *   1. The OTLP/HTTP exporter POSTs to exactly the url it is given. A base
 *      url (no path) hits `/`, which every OTLP receiver answers with 404 —
 *      the span is dropped on every export. {@link normalizeOtlpTracesEndpoint}
 *      applies the OTel spec's own rule for a base endpoint: append
 *      `/v1/traces` when the url carries no path.
 *   2. `BatchSpanProcessor` reports export failures only through the OTel
 *      `diag` logger, which this process never registers — so a 404 / ECONNREFUSED
 *      / 403 from the pipeline was invisible while `[Telemetry] Finalized
 *      test_case span` kept logging success. {@link MonitoredSpanExporter}
 *      wraps the real exporter, counts exported spans / failed batches, keeps
 *      the last error, logs failures (throttled) and exposes the counters via
 *      {@link getEvalExportStatus} for `/health` and the telemetry smoke.
 */

import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';

/** OTLP/HTTP traces signal path (OTel spec: appended to a base endpoint). */
export const OTLP_TRACES_PATH = '/v1/traces';

/**
 * Append `/v1/traces` to an OTLP/HTTP endpoint that has no path.
 *
 * Mirrors the OTel SDK's handling of `OTEL_EXPORTER_OTLP_ENDPOINT` (a base
 * url the SDK completes per signal) vs `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
 * (used verbatim). A url that already carries ANY path is returned unchanged
 * — custom ingest paths (e.g. `/<pipeline>/v1/traces`) are legitimate and the
 * export-failure log, not a guess, reports when they are wrong. Unparseable
 * input is returned as-is so the exporter surfaces its own error.
 */
export function normalizeOtlpTracesEndpoint(endpoint: string): { url: string; appendedPath: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { url: endpoint, appendedPath: false };
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return { url: endpoint, appendedPath: false };
  }
  parsed.pathname = OTLP_TRACES_PATH;
  return { url: parsed.toString(), appendedPath: true };
}

/** Snapshot of the eval exporter's health, as reported on `/health`. */
export interface EvalExportStatus {
  /** Which exporter backs the eval tracer. */
  exporter: 'otlp' | 'opensearch';
  /** Where spans are sent (OTLP url or OpenSearch endpoint). */
  endpoint: string;
  /** Spans the backend acknowledged. */
  exportedSpans: number;
  /** Export batches the backend rejected or that never reached it. */
  failedBatches: number;
  /** Spans lost in those batches. */
  droppedSpans: number;
  /** Most recent failure, if any. */
  lastError?: { at: string; message: string };
  /** Most recent successful export, if any. */
  lastSuccessAt?: string;
}

/** Minimum gap between two "export failed" log lines for the same exporter. */
export const EXPORT_FAILURE_LOG_INTERVAL_MS = 60_000;

/** Render the exporter's error (OTLPExporterError carries an HTTP status + body). */
export function describeExportError(error: unknown): string {
  if (!error) return 'unknown error';
  const e = error as { message?: string; code?: unknown; data?: unknown };
  const parts: string[] = [];
  if (typeof e.code === 'number') parts.push(`HTTP ${e.code}`);
  if (e.message) parts.push(String(e.message));
  if (typeof e.code === 'string' && e.code && e.code !== e.message) parts.push(e.code);
  if (typeof e.data === 'string' && e.data.trim() && e.data !== e.message) {
    // Response body: one line, tags stripped (an Express default 404 is an HTML page), bounded.
    const body = e.data.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (body) parts.push(body.length > 160 ? `${body.slice(0, 160)}…` : body);
  }
  return parts.join(' ') || String(error);
}

/**
 * SpanExporter decorator: forwards everything to the real exporter and records
 * the outcome. Never changes the result the processor sees.
 */
export class MonitoredSpanExporter implements SpanExporter {
  private readonly status: EvalExportStatus;
  private lastFailureLogAt = -Infinity;
  private failuresSinceLog = 0;

  constructor(
    private readonly inner: SpanExporter,
    exporter: EvalExportStatus['exporter'],
    endpoint: string,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {
    this.status = { exporter, endpoint, exportedSpans: 0, failedBatches: 0, droppedSpans: 0 };
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      this.record(spans.length, result);
      resultCallback(result);
    });
  }

  private record(spanCount: number, result: ExportResult): void {
    const at = new Date(this.now()).toISOString();
    if (result.code === ExportResultCode.SUCCESS) {
      this.status.exportedSpans += spanCount;
      this.status.lastSuccessAt = at;
      return;
    }
    const message = describeExportError(result.error);
    this.status.failedBatches += 1;
    this.status.droppedSpans += spanCount;
    this.status.lastError = { at, message };
    this.failuresSinceLog += 1;
    const t = this.now();
    if (t - this.lastFailureLogAt >= EXPORT_FAILURE_LOG_INTERVAL_MS) {
      const suppressed = this.failuresSinceLog - 1;
      this.log(
        `[Telemetry] Eval span export FAILED → ${this.status.endpoint}: ${message} ` +
        `(${spanCount} span(s) dropped; ${this.status.droppedSpans} total${suppressed > 0 ? `, ${suppressed} earlier failure(s) not logged` : ''}). ` +
        `Check the exporter endpoint (OTLP/HTTP receivers expect …${OTLP_TRACES_PATH}) and its auth; /health → telemetry reports these counters.`,
      );
      this.lastFailureLogAt = t;
      this.failuresSinceLog = 0;
    }
  }

  getStatus(): EvalExportStatus {
    return { ...this.status, lastError: this.status.lastError ? { ...this.status.lastError } : undefined };
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}
