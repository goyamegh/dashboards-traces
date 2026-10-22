/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-step failure classification.
 *
 * Node's `fetch` (undici) reports every transport failure as the opaque
 * `TypeError: fetch failed`; the real reason (`HeadersTimeoutError`,
 * `ECONNREFUSED`, …) sits on `error.cause`. `describeAgentError()` unwraps
 * that chain into one human-readable line and classifies it
 * (`timeout` / `connection` / `http_<status>` / `unknown`) so the report can
 * carry `agentError` + `failureStage: 'agent'` and the UI can show the cause.
 * Pure and dependency-free so the browser bundle can import it too.
 */

import type { AgentErrorInfo, AgentErrorKind } from '@/types';

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR',
]);

const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

interface Hop { name?: string; code?: string; message: string }

/** Walk `error.cause` (bounded, cycle-safe) collecting each hop's name/code/message. */
function unwrapCauseChain(error: unknown): Hop[] {
  const chain: Hop[] = [];
  const seen = new Set<unknown>();
  let current: any = error;
  for (let i = 0; i < 6 && current !== undefined && current !== null && !seen.has(current); i++) {
    seen.add(current);
    if (typeof current === 'string') { chain.push({ message: current }); break; }
    chain.push({
      name: typeof current.name === 'string' ? current.name : undefined,
      code: typeof current.code === 'string' ? current.code : undefined,
      message: typeof current.message === 'string' ? current.message : String(current),
    });
    current = current.cause;
  }
  return chain;
}

/** Wrapper messages that carry no information on their own (`fetch failed`). */
function isOpaque(hop: Hop): boolean {
  const m = hop.message.trim().toLowerCase();
  return m === '' || m === 'fetch failed' || m === 'failed to fetch';
}

/**
 * One-line cause: the outermost informative hop (`HeadersTimeoutError:
 * Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT)`), with the deepest distinct
 * error code appended for traceability.
 */
export function unwrapErrorMessage(error: unknown): string {
  const chain = unwrapCauseChain(error);
  if (chain.length === 0) return 'Unknown error';
  const primary = chain.find(h => !isOpaque(h)) ?? chain[0];
  const label = primary.name && !['Error', 'TypeError'].includes(primary.name) && !primary.message.startsWith(primary.name) ? `${primary.name}: ` : '';
  let text = `${label}${primary.message}`;
  if (primary.code && !text.includes(primary.code)) text += ` (${primary.code})`;
  const deepestCode = [...chain].reverse().find(h => h !== primary && h.code && !text.includes(h.code))?.code;
  if (deepestCode) text += ` [${deepestCode}]`;
  return text;
}

/** Extract an HTTP status from the connector's own error wording, if present. */
function httpStatusFromMessage(message: string): number | undefined {
  // RESTConnector: "REST request failed: 503 - <body>"; others: "HTTP 502", "status 504".
  const m = message.match(/(?:request failed:|HTTP|status(?: code)?)\s*(\d{3})\b/i);
  const status = m ? Number(m[1]) : undefined;
  return status !== undefined && status >= 100 && status <= 599 ? status : undefined;
}

/** Classify an agent-step error into a coarse kind. */
export function classifyAgentError(error: unknown): { kind: AgentErrorKind; httpStatus?: number } {
  const chain = unwrapCauseChain(error);
  const codes = chain.map(h => h.code).filter((c): c is string => !!c);
  const names = chain.map(h => h.name).filter((n): n is string => !!n);
  const text = chain.map(h => h.message).join(' ');

  if (codes.some(c => TIMEOUT_CODES.has(c)) || names.some(n => /Timeout|AbortError/i.test(n)) || /\btimed? ?out\b/i.test(text)) {
    return { kind: 'timeout' };
  }
  if (codes.some(c => CONNECTION_CODES.has(c)) || /ECONNREFUSED|ECONNRESET|ENOTFOUND|socket hang up|certificate/i.test(text)) {
    return { kind: 'connection' };
  }
  const status = (error as any)?.httpStatus ?? (error as any)?.status ?? httpStatusFromMessage(text);
  if (typeof status === 'number' && status >= 100 && status <= 599) {
    return { kind: `http_${status}` as AgentErrorKind, httpStatus: status };
  }
  return { kind: 'unknown' };
}

/** Build the persisted `agentError` record for a connector failure. */
export function describeAgentError(error: unknown, ctx: { endpoint?: string; elapsedMs?: number } = {}): AgentErrorInfo {
  const { kind, httpStatus } = classifyAgentError(error);
  let message = unwrapErrorMessage(error);
  if (ctx.endpoint && !message.includes(ctx.endpoint)) message = `${message} (${ctx.endpoint})`;
  const info: AgentErrorInfo = { kind, message };
  if (ctx.elapsedMs !== undefined) info.elapsedMs = Math.max(0, Math.round(ctx.elapsedMs));
  if (ctx.endpoint) info.endpoint = ctx.endpoint;
  if (httpStatus !== undefined) info.httpStatus = httpStatus;
  return info;
}
