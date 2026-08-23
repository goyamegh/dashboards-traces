/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Remote server configuration reader.
 * Reads remoteServers from agent-health.config.json.
 */

import type { RemoteServerConfig } from '@/lib/config/types';
import { readLayeredState } from '@/lib/config/statePaths';

export function getRemoteServers(): RemoteServerConfig[] {
  const servers = readLayeredState().remoteServers;
  if (Array.isArray(servers)) {
    return servers.filter(
      (s: unknown): s is RemoteServerConfig =>
        typeof s === 'object' && s !== null &&
        typeof (s as RemoteServerConfig).name === 'string' &&
        typeof (s as RemoteServerConfig).url === 'string'
    );
  }
  return [];
}
