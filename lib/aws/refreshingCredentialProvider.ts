/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An AWS credential provider for long-running processes that must notice when
 * the credentials on disk are rotated underneath them (`aws configure`, SSO
 * helpers, any tool that rewrites `~/.aws/credentials`).
 *
 * Why the stock chain is not enough: `fromNodeProviderChain()` memoises the
 * credentials it resolves and only re-resolves when they carry an
 * `expiration` that is about to pass. Static profile credentials
 * (`aws_access_key_id` / `aws_secret_access_key` / `aws_session_token` in the
 * ini file) carry NO expiration, so the first key ever resolved is used for
 * the life of the process — once that session token expires on the AWS side
 * every signed request fails with 403 until the server is restarted.
 * `ignoreCache: true` only bypasses the ini-file *read* cache when a
 * resolution actually happens; it never forces one.
 *
 * This provider:
 *   - resolves through a FRESH `fromNodeProviderChain({ profile, ignoreCache })`
 *     on every refresh, so whatever is on disk / in the environment NOW wins;
 *   - honours a real `expiration` when the source provides one (STS, SSO,
 *     IMDS, `credential_process`), refreshing shortly before it passes;
 *   - for credentials WITHOUT an expiration, re-resolves after
 *     {@link DEFAULT_CREDENTIAL_TTL_MS} and stamps that deadline as a
 *     synthetic `expiration` on the returned object. AWS SDK clients wrap
 *     user-supplied providers in `memoizeIdentityProvider`, which treats an
 *     identity without `expiration` as constant and never calls the provider
 *     again — the synthetic deadline is what makes the SDK come back to us;
 *   - coalesces concurrent refreshes into one chain resolution.
 */

import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

// Derived rather than imported from `@smithy/types` (a transitive dependency
// only) so the SDK's own type stays the single source of truth.
export type AwsCredentialIdentityProvider = ReturnType<typeof fromNodeProviderChain>;
export type AwsCredentialIdentity = Awaited<ReturnType<AwsCredentialIdentityProvider>>;

/**
 * How long credentials that do not self-report an expiration are reused
 * before the chain is consulted again. 60 s bounds the worst case "still
 * signing with a rotated-out key" window to a minute while keeping the cost
 * (one ini-file read, no network) negligible — 1 re-read/min versus the ~5
 * min the AWS SDK itself uses as its "about to expire" threshold.
 */
export const DEFAULT_CREDENTIAL_TTL_MS = 60_000;

/**
 * Refresh real (source-provided) expirations this far ahead of time — the
 * same 5-minute lead the AWS SDK's own memoisation uses.
 */
const EXPIRATION_LEAD_MS = 5 * 60_000;

export interface RefreshingCredentialProviderOptions {
  /** Shared-config profile. Omit to use `$AWS_PROFILE` / the default chain order. */
  profile?: string;
  /** Reuse window for credentials without an `expiration`. Default {@link DEFAULT_CREDENTIAL_TTL_MS}. */
  ttlMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export function createRefreshingCredentialProvider(
  options: RefreshingCredentialProviderOptions = {}
): AwsCredentialIdentityProvider {
  const { profile, ttlMs = DEFAULT_CREDENTIAL_TTL_MS, now = Date.now } = options;
  let cached: { credentials: AwsCredentialIdentity; refreshAt: number } | undefined;
  let pending: Promise<AwsCredentialIdentity> | undefined;

  const refresh = async (): Promise<AwsCredentialIdentity> => {
    const resolved = await fromNodeProviderChain({
      ...(profile ? { profile } : {}),
      // Bypass @smithy/shared-ini-file-loader's process-lifetime cache of the
      // ini file contents so this resolution sees the file as it is NOW.
      ignoreCache: true,
    })();
    const resolvedAt = now();
    let credentials: AwsCredentialIdentity;
    let refreshAt: number;
    if (resolved.expiration) {
      credentials = resolved;
      // Never spin on a source that hands out credentials already inside the
      // lead window: reuse them for at least one TTL.
      refreshAt = Math.max(resolvedAt + ttlMs, resolved.expiration.getTime() - EXPIRATION_LEAD_MS);
    } else {
      refreshAt = resolvedAt + ttlMs;
      // New object: the chain may hand out a shared instance; do not leak the
      // synthetic expiration into other consumers.
      credentials = { ...resolved, expiration: new Date(refreshAt) };
    }
    cached = { credentials, refreshAt };
    return credentials;
  };

  return async () => {
    if (cached && now() < cached.refreshAt) return cached.credentials;
    if (!pending) {
      pending = refresh().finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}
