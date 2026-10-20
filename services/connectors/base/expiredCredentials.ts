/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retry-once policy for signed requests rejected because the AWS credentials
 * behind them expired or were rotated (#569). Pure — no AWS SDK import — so
 * it can sit on the `invokeAgent` path that the browser bundle also includes;
 * the credential refresh itself is delegated to the connector
 * (`AgentConnector.refreshCredentials`).
 */

import type { ConnectorAuth } from '@/services/connectors/types';

/**
 * Does this connector error describe a 401/403 caused by expired or invalid
 * AWS credentials (as opposed to an authorization denial or any other 4xx)?
 * Matches the messages HTTP connectors throw (`… failed: 403 - <body>`,
 * `HTTP 403: … - <body>`) against the signals AWS-fronted endpoints return.
 */
export function isExpiredCredentialsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /\b40[13]\b/.test(message) &&
    /ExpiredToken(Exception)?\b|InvalidClientTokenId|UnrecognizedClientException|security token included in the request is (expired|invalid)/i.test(
      message
    )
  );
}

/**
 * Run `attempt` and, if it fails because the signed request was rejected for
 * expired/invalid credentials, call `refreshCredentials` and run it exactly
 * once more (the retry re-signs the same request; connector bodies are fixed
 * strings, so the replay is byte-identical). Anything else — other 403s,
 * network errors, non-SigV4 auth — propagates untouched. A second failure
 * surfaces the original error annotated with the retry.
 */
export async function retryOnceOnExpiredCredentials<T>(
  auth: ConnectorAuth,
  attempt: () => Promise<T>,
  refreshCredentials: () => Promise<void>
): Promise<T> {
  try {
    return await attempt();
  } catch (first) {
    if (auth.type !== 'aws-sigv4' || !isExpiredCredentialsError(first)) throw first;
    try {
      await refreshCredentials();
      return await attempt();
    } catch (second) {
      const firstMessage = first instanceof Error ? first.message : String(first);
      const secondMessage = second instanceof Error ? second.message : String(second);
      throw new Error(`${firstMessage} (retried once with refreshed credentials; retry failed: ${secondMessage})`, {
        cause: second,
      });
    }
  }
}
