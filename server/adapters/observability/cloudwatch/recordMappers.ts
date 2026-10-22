/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CloudWatch record mappers.
 *
 * Transaction Search writes every OTLP span to the `aws/spans` log group as
 * one JSON record per span (verified shape, Sept 2026):
 *
 *   { traceId, spanId, parentSpanId?, name, kind: 'SERVER'|'INTERNAL'|…,
 *     startTimeUnixNano, endTimeUnixNano, durationNano,
 *     attributes: { 'gen_ai.operation.name': …, … },
 *     resource: { attributes: { 'service.name': …, … } },
 *     scope: { name, version }, status: { code: 'UNSET'|'OK'|'ERROR' }, flags }
 *
 * We map that into the OTel plain-raw shape the OpenSearch reader already
 * understands (`transformSpan` in server/services/tracesService.ts), so
 * categorization, trajectory extraction and metrics are shared verbatim.
 *
 * OTel log records exported to a CloudWatch log group look like:
 *   { traceId, spanId, flags, severityText, severityNumber, body,
 *     timeUnixNano, attributes: {...}, resource: { attributes: {...} } }
 */

import type { OpenSearchSpanSource } from '../../../services/tracesService.js';
import type { LogEntry } from '../../../services/logsService.js';

export interface CloudWatchSpanRecord {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: string;
  startTimeUnixNano?: number | string;
  endTimeUnixNano?: number | string;
  durationNano?: number | string;
  attributes?: Record<string, unknown>;
  resource?: { attributes?: Record<string, unknown> };
  scope?: { name?: string; version?: string };
  status?: { code?: string | number; message?: string };
  events?: Array<{ name: string; timeUnixNano?: number | string; time?: string; attributes?: Record<string, unknown> }>;
  [key: string]: unknown;
}

export interface CloudWatchLogRecord {
  traceId?: string;
  spanId?: string;
  severityText?: string;
  severityNumber?: number;
  body?: unknown;
  timeUnixNano?: number | string;
  observedTimeUnixNano?: number | string;
  attributes?: Record<string, unknown>;
  resource?: { attributes?: Record<string, unknown> };
  [key: string]: unknown;
}

/**
 * Nanosecond timestamps exceed 2^53, so a decimal string must be parsed as a
 * BigInt to keep sub-millisecond precision; a JSON number has already been
 * rounded by the parser and is accepted as-is.
 */
export function toNanos(v: number | string | undefined | null): bigint | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.round(v)) : undefined;
  return /^-?\d+$/.test(v.trim()) ? BigInt(v.trim()) : undefined;
}

/** Nanoseconds (number or decimal string) → ISO-8601 with millisecond precision. */
export function nanosToIso(ns: number | string | undefined): string | undefined {
  const n = toNanos(ns);
  if (n === undefined) return undefined;
  return new Date(Number(n / 1_000_000n)).toISOString();
}

/** OTel status code: CloudWatch stores the enum name; OpenSearch stores the number. */
export function statusCodeToNumber(code: string | number | undefined): number {
  if (typeof code === 'number') return code;
  switch ((code || '').toString().toUpperCase()) {
    case 'ERROR': case 'STATUS_CODE_ERROR': return 2;
    case 'OK': case 'STATUS_CODE_OK': return 1;
    default: return 0;
  }
}

/** Parse one `aws/spans` event message; returns null if it is not a span record. */
export function parseSpanRecord(message: string): CloudWatchSpanRecord | null {
  try {
    const rec = JSON.parse(message);
    if (!rec || typeof rec !== 'object' || typeof rec.traceId !== 'string' || typeof rec.spanId !== 'string') return null;
    return rec as CloudWatchSpanRecord;
  } catch {
    return null;
  }
}

/** `aws/spans` record → OTel plain-raw span source (what `transformSpan` consumes). */
export function cloudWatchSpanToSource(rec: CloudWatchSpanRecord): OpenSearchSpanSource {
  const startNs = toNanos(rec.startTimeUnixNano);
  const endNs = toNanos(rec.endTimeUnixNano);
  const durationBig = toNanos(rec.durationNano) ?? (startNs !== undefined && endNs !== undefined ? endNs - startNs : undefined);
  const durationNs = durationBig === undefined ? undefined : Number(durationBig);
  const resourceAttrs = rec.resource?.attributes || {};
  const serviceName = typeof resourceAttrs['service.name'] === 'string' ? (resourceAttrs['service.name'] as string) : undefined;

  const source: OpenSearchSpanSource = {
    traceId: rec.traceId,
    spanId: rec.spanId,
    parentSpanId: rec.parentSpanId || undefined,
    name: rec.name,
    kind: rec.kind,
    serviceName,
    startTime: nanosToIso(rec.startTimeUnixNano),
    endTime: nanosToIso(rec.endTimeUnixNano),
    durationInNanos: durationNs,
    status: { code: statusCodeToNumber(rec.status?.code) },
    attributes: { ...(rec.attributes || {}) },
    resource: { attributes: resourceAttrs },
    instrumentationScope: rec.scope?.name ? { name: rec.scope.name, version: rec.scope.version } : undefined,
    events: (rec.events || []).map((e) => ({
      name: e.name,
      time: e.time || nanosToIso(e.timeUnixNano) || '',
      attributes: e.attributes as Record<string, any> | undefined,
    })),
  };
  // Mirror the plain-raw convention of a `service.name` span attribute so
  // service filters that read `attributes['service.name']` keep working.
  if (serviceName && source.attributes && source.attributes['service.name'] === undefined) {
    source.attributes['service.name'] = serviceName;
  }
  return source;
}

/** CloudWatch log event (OTel log record JSON, or plain text) → LogEntry. */
export function cloudWatchLogToEntry(
  message: string,
  eventTimestampMs: number | undefined,
  logGroup: string
): LogEntry {
  let rec: CloudWatchLogRecord | null = null;
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === 'object') rec = parsed as CloudWatchLogRecord;
  } catch {
    // plain-text line
  }

  const fallbackTs = eventTimestampMs !== undefined ? new Date(eventTimestampMs).toISOString() : new Date().toISOString();
  if (!rec) {
    return { timestamp: fallbackTs, index: logGroup, message, level: 'info', source: logGroup };
  }

  const resourceAttrs = rec.resource?.attributes || {};
  const body = rec.body === undefined ? message : typeof rec.body === 'string' ? rec.body : JSON.stringify(rec.body);
  return {
    timestamp: nanosToIso(rec.timeUnixNano) || nanosToIso(rec.observedTimeUnixNano) || fallbackTs,
    index: logGroup,
    message: body,
    level: (rec.severityText || 'info').toString().toLowerCase(),
    source: (resourceAttrs['service.name'] as string | undefined) || logGroup,
    traceId: rec.traceId,
    spanId: rec.spanId,
    severityNumber: rec.severityNumber,
    attributes: rec.attributes,
    resource: rec.resource,
  };
}

/** Resolve a log-group template like `/agent-health/{service.name}` for a service. */
export function resolveLogGroupTemplate(template: string, serviceName?: string): string | null {
  if (!template.includes('{service.name}')) return template;
  if (!serviceName) return null;
  return template.replace('{service.name}', serviceName);
}

/** Fixed prefix of a log-group template (everything before the first `{`). */
export function logGroupTemplatePrefix(template: string): string {
  const i = template.indexOf('{');
  return i === -1 ? template : template.slice(0, i);
}
