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
export function createOpenSearchClient(config: ClusterConfig): Client {
  if (config.authType === 'none') {
    return new Client({
      node: config.endpoint,
      ssl: { rejectUnauthorized: !config.tlsSkipVerify },
    });
  }

  if (config.authType === 'sigv4') {
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
  if (config.authType === 'none') {
    return `none|${config.endpoint}`;
  }
  if (config.authType === 'sigv4') {
    return `sigv4|${config.endpoint}|${config.awsRegion || ''}|${config.awsProfile || ''}|${config.awsService || 'es'}`;
  }
  return `basic|${config.endpoint}|${config.username || ''}|${config.password || ''}`;
}
