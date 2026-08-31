/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenSearch Client Factory
 *
 * Single factory function that creates an OpenSearch Client with either
 * basic auth or AWS SigV4 authentication.
 *
 * Usage:
 *   import { createOpenSearchClient, configToCacheKey } from './opensearchClientFactory.js';
 *   const client = createOpenSearchClient(config);
 */

import { createHash } from 'crypto';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws-v3';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { ClusterConfig } from '../../types/index.js';

/**
 * Create an OpenSearch Client from a ClusterConfig.
 *
 * - When `authType` is 'none': connects without any authentication
 * - When `authType` is 'basic' or absent: uses username/password (backwards compatible)
 * - When `authType` is 'sigv4': uses AwsSigv4Signer with the AWS credential chain
 *
 * @throws Error if SigV4 is requested but `awsRegion` is missing
 */
/**
 * Resolve the effective auth mode for a cluster config. Shared by
 * createOpenSearchClient() AND configToCacheKey() so the constructed client and
 * its pool/cache key always agree (otherwise an inferred-SigV4 config would be
 * built as SigV4 but keyed as 'basic', colliding clients + breaking drift
 * detection).
 *
 * - Infers 'sigv4' when authType is omitted but AWS fields (awsProfile/awsRegion)
 *   are present — basic auth could never have worked there.
 * - Throws on an unrecognized authType instead of silently using basic auth
 *   (the footgun: authType:'aws' → opaque 401/403 'Response Error').
 * - Defaults to 'basic' (backwards compatible) when nothing is specified.
 */
/**
 * Safety window used to force a SigV4 credential re-resolve even when the
 * resolved AWS credentials carry no `expiration` of their own.
 *
 * opensearch-js's AwsSigv4Signer transport only calls `getCredentials()`
 * again once it decides the CURRENTLY CACHED credentials object is expired
 * (see its internal `credentialsState.credentials` + expiry check). That
 * check is driven entirely by fields on the credentials object itself
 * (`needsRefresh()`, `.expired`, `.expireTime`, or `.expiration`). Long-lived
 * session credentials resolved from a profile in `~/.aws/credentials` (e.g.
 * as written by `ada credentials update`) commonly have NONE of those
 * fields set, even though the underlying STS session token rotates roughly
 * hourly. Without an `expiration`, the transport's expiry check never fires
 * again after the first successful request, so it keeps signing requests
 * with the FIRST credentials it ever resolved - forever. When `ada` rotates
 * the profile afterwards, every OpenSearch request starts failing with a
 * bodiless 403 ("Response Error") and only a process restart (which
 * re-resolves credentials at client construction) recovers.
 *
 * The fix: always attach a synthetic `expiration` (now + this window) to
 * credentials that don't already carry one, so opensearch-js's own expiry
 * check periodically forces a re-call to `getCredentials()`, which - since
 * we build a fresh provider chain on every call below, with `ignoreCache:
 * true` to also defeat the AWS SDK's own file-content cache (see the
 * `resolveSigv4Credentials` doc comment) - re-reads whatever is actually on
 * disk/in the environment right now, not whatever was there the first time
 * this process ever resolved credentials.
 */
// 5 minutes: bounds the worst-case "still signing with a rotated-out key"
// window to something short (opensearch-js re-checks ~30s before this
// elapses, per its own `expiryBufferMs`) without forcing excessive re-reads
// for credential sources that DO update in place cheaply (a profile file
// re-read, or an already-cached IMDS/SSO provider call).
export const SIGV4_CREDENTIAL_REFRESH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve fresh AWS credentials for the SigV4 signer via the standard node
 * credential provider chain, honoring an explicit `expiration` from the
 * provider (e.g. real STS temporary credentials, which are AWS SDK v3
 * objects and therefore only ever signal freshness via `.expiration` — the
 * `needsRefresh()`/`.expired`/`.expireTime` fields opensearch-js also checks
 * are AWS SDK v2-only and never present on anything `fromNodeProviderChain`
 * returns) or falling back to a synthetic near-term expiration so
 * opensearch-js re-resolves periodically even for long-lived/session
 * credentials that don't self-report expiry (see
 * SIGV4_CREDENTIAL_REFRESH_WINDOW_MS above). Returns a new object rather
 * than mutating the one handed back by the provider, since AWS SDK
 * credential providers may cache/memoize and hand out the same object
 * instance across calls — mutating it in place would leak our synthetic
 * expiration into other consumers of that provider.
 *
 * Exported for direct unit testing.
 *
 * IMPORTANT - a SECOND, process-wide cache sits underneath this "fresh
 * provider chain every call" strategy: `@smithy/shared-ini-file-loader`
 * memoizes the raw contents of `~/.aws/credentials` / `~/.aws/config` in a
 * module-level `filePromises` map, keyed only by file path, for the lifetime
 * of the Node process - a brand-new provider chain still calls into this
 * SAME shared file-read cache. `ada credentials update` rewriting a static
 * ini-file profile is therefore invisible to a long-running server until
 * the process restarts - the actual cause of the Aug 2026 incidents where
 * `/api/storage/config/retry` kept returning HTTP 403 after `ada` had
 * already refreshed valid credentials on disk. `ignoreCache: true` bypasses
 * that specific file-content cache (forwarded down to `readFile()`); it
 * does NOT change how AWS-side re-authentication works for profile shapes
 * that legitimately re-authenticate on their own (SSO, `credential_process`,
 * assume-role chains), so this is scoped to the static-profile case that bit
 * us, not a general credential-freshness guarantee.
 */
export async function resolveSigv4Credentials(awsProfile?: string) {
  const provider = fromNodeProviderChain({
    ...(awsProfile && { profile: awsProfile }),
    // Bypass @smithy/shared-ini-file-loader's process-lifetime file-content
    // cache (see comment above) so a rotated ~/.aws/credentials is picked up
    // on the very next resolution instead of requiring a process restart.
    ignoreCache: true,
  });
  const credentials = await provider();
  if (credentials.expiration) {
    return credentials;
  }
  return {
    ...credentials,
    expiration: new Date(Date.now() + SIGV4_CREDENTIAL_REFRESH_WINDOW_MS),
  };
}

/**
 * Best-effort extraction of an HTTP status code from an OpenSearch client
 * error (opensearch-js's `ResponseError`/`ConnectionError` etc). Used to
 * distinguish an auth failure (403 - e.g. expired/rotated SigV4 credentials)
 * from a cluster-side failure (5xx) in logs, without needing to touch every
 * call site's error handling.
 */
export function opensearchErrorStatusCode(error: unknown): number | undefined {
  const err = error as { statusCode?: number; meta?: { statusCode?: number; body?: { status?: number } } } | null | undefined;
  if (!err) return undefined;
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (typeof err.meta?.statusCode === 'number') return err.meta.statusCode;
  if (typeof err.meta?.body?.status === 'number') return err.meta.body.status;
  return undefined;
}

/**
 * Format an OpenSearch client error for logs/UI with its HTTP status code
 * appended when available, e.g. "Response Error (HTTP 403)" instead of the
 * opaque, bodiless "Response Error" opensearch-js reports for IAM denials.
 *
 * Returns '' (not a stringified object) when the error carries no `.message`
 * and no status code, so existing `describeOpenSearchError(error) || 'fallback'`
 * call sites keep their original fallback behavior for message-less errors.
 */
export function describeOpenSearchError(error: unknown): string {
  const message = (error as { message?: string } | null | undefined)?.message || '';
  const statusCode = opensearchErrorStatusCode(error);
  if (!message) {
    return statusCode ? `Request failed (HTTP ${statusCode})` : '';
  }
  return statusCode ? `${message} (HTTP ${statusCode})` : message;
}

export function resolveAuthType(config: ClusterConfig): 'none' | 'basic' | 'sigv4' {
  let authType = config.authType as string | undefined;
  if (!authType && (config.awsProfile || config.awsRegion)) {
    authType = 'sigv4';
  }
  if (authType && authType !== 'none' && authType !== 'basic' && authType !== 'sigv4') {
    throw new Error(
      `Invalid storage/observability authType '${authType}'. Expected 'sigv4', 'basic', or 'none'` +
      (config.awsProfile || config.awsRegion ? ` (use 'sigv4' for AWS OpenSearch).` : '.')
    );
  }
  return (authType as 'none' | 'basic' | 'sigv4' | undefined) ?? 'basic';
}

export function createOpenSearchClient(config: ClusterConfig): Client {
  const authType = resolveAuthType(config);

  if (authType === 'none') {
    return new Client({
      node: config.endpoint,
      ssl: { rejectUnauthorized: !config.tlsSkipVerify },
    });
  }

  if (authType === 'sigv4') {
    if (!config.awsRegion) {
      throw new Error('awsRegion is required when authType is "sigv4"');
    }

    const signer = AwsSigv4Signer({
      region: config.awsRegion,
      service: config.awsService || 'es',
      getCredentials: () => resolveSigv4Credentials(config.awsProfile),
    });

    return new Client({
      ...signer,
      node: config.endpoint,
      ssl: { rejectUnauthorized: !config.tlsSkipVerify },
    });
  }

  // Basic auth (default)
  const clientConfig: any = {
    node: config.endpoint,
    ssl: { rejectUnauthorized: !config.tlsSkipVerify },
  };

  if (config.username && config.password) {
    clientConfig.auth = {
      username: config.username,
      password: config.password,
    };
  }

  return new Client(clientConfig);
}

/**
 * Generate a cache key from cluster configuration.
 * Used for client pool keying to avoid creating new clients per request.
 */
export function configToCacheKey(config: ClusterConfig): string {
  // Use the SAME resolution as createOpenSearchClient so the key reflects the
  // actually-constructed auth mode (incl. inferred SigV4).
  const authType = resolveAuthType(config);
  if (authType === 'none') {
    return `none|${config.endpoint}`;
  }
  if (authType === 'sigv4') {
    return `sigv4|${config.endpoint}|${config.awsRegion || ''}|${config.awsProfile || ''}|${config.awsService || 'es'}`;
  }
  const credentialHash = createHash('sha256')
    .update(`${config.username || ''}:${config.password || ''}`)
    .digest('hex')
    .substring(0, 16);
  return `basic|${config.endpoint}|${credentialHash}`;
}
