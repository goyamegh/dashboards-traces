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
      getCredentials: () => {
        const provider = fromNodeProviderChain({
          ...(config.awsProfile && { profile: config.awsProfile }),
        });
        return provider();
      },
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
