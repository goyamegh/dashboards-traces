/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Classifier for "AWS rejected the signature because the credentials behind
 * it are expired, rotated out or unknown" (#569). Decided from the HTTP
 * RESPONSE itself — its own status plus the AWS error TYPE in recognised
 * top-level places — never from an error message and never by substring
 * matching the whole body, so a nested `diagnostic.code: "ExpiredToken"` or a
 * mentioned "403" elsewhere cannot pass.
 */

/** AWS error codes for stale / unknown credentials (exact, after `:`-suffix stripping). */
const CREDENTIAL_ERROR_CODES = new Set([
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
]);

/** Message-field texts AWS uses when it reports the problem as a message only. */
const CREDENTIAL_ERROR_MESSAGE =
  /^The security token included in the request is (expired|invalid)\.?$/i;

/** The subset of `Response` the classifier reads (lets tests pass plain objects). */
export interface RejectionProbe {
  status: number;
  headers: { get(name: string): string | null | undefined };
  clone?: () => { text(): Promise<string> };
}

/** `ExpiredTokenException:http://internal.amazon.com/coral/…` → `ExpiredTokenException`; `#` prefixes too. */
function normalizeErrorType(raw: string): string {
  return raw.trim().split(':')[0].split('#').pop()!.trim();
}

function isCredentialErrorCode(raw: unknown): boolean {
  return typeof raw === 'string' && CREDENTIAL_ERROR_CODES.has(normalizeErrorType(raw));
}

/**
 * Decide from the body's TOP-LEVEL error fields only:
 *   JSON  — `__type` / `code` / `Code` (an explicit type decides, even when it
 *           is not ours), else `message` / `Message` equal to the AWS text;
 *   XML   — `<Error><Code>…</Code>` (the first `<Code>` directly under `<Error>`).
 * Anything nested deeper, or any other shape, is not a credential rejection.
 */
function bodyIndicatesCredentialRejection(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const top = parsed as Record<string, unknown>;
    const explicitType = [top.__type, top.code, top.Code].find((v) => typeof v === 'string');
    if (explicitType !== undefined) return isCredentialErrorCode(explicitType);
    const message = [top.message, top.Message].find((v) => typeof v === 'string');
    return typeof message === 'string' && CREDENTIAL_ERROR_MESSAGE.test(message.trim());
  }
  if (trimmed.startsWith('<')) {
    const error = trimmed.match(/<Error>([\s\S]*?)<\/Error>/);
    const code = error?.[1].match(/^\s*(?:<[^>]+>[^<]*<\/[^>]+>\s*)*?<Code>([^<]*)<\/Code>/);
    return !!code && isCredentialErrorCode(code[1]);
  }
  return false;
}

/**
 * True when `response` is a 401/403 whose AWS error type says the
 * credentials were expired / invalid / unknown. If `x-amzn-errortype` is
 * present it alone decides (so `AccessDeniedException` is never retried,
 * whatever the body says); otherwise the body's top-level error fields
 * decide. The body is read from a clone so the caller can still consume it.
 * An AWS front door rejects such a request before the agent runs, so
 * replaying it is safe.
 */
export async function isAwsCredentialRejection(response: RejectionProbe): Promise<boolean> {
  if (response.status !== 401 && response.status !== 403) return false;
  const errorType = response.headers.get('x-amzn-errortype');
  if (errorType) return isCredentialErrorCode(errorType);
  if (typeof response.clone !== 'function') return false;
  try {
    return bodyIndicatesCredentialRejection(await response.clone().text());
  } catch {
    return false;
  }
}
