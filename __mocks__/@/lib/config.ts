/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jest mock for lib/config
 * Provides test-friendly defaults without import.meta
 */

export interface EnvConfig {
  backendUrl: string;
  judgeApiUrl: string;
  storageApiUrl: string;
  agentProxyUrl: string;
  openSearchProxyUrl: string;
  awsRegion: string;
  awsProfile: string;
  bedrockModelId: string;
  openSearchLogsEndpoint: string;
  openSearchLogsUsername: string;
  openSearchLogsPassword: string;
  openSearchLogsTracesIndex: string;
  openSearchLogsIndex: string;
  mlcommonsEndpoint: string;
  mlcommonsHeaderOpenSearchUrl: string;
  mlcommonsHeaderAuthorization: string;
  mlcommonsHeaderAwsRegion: string;
  mlcommonsHeaderAwsServiceName: string;
  mlcommonsHeaderAwsAccessKeyId: string;
  mlcommonsHeaderAwsSecretAccessKey: string;
  mlcommonsHeaderAwsSessionToken: string;
  travelPlannerEndpoint: string;
  observioEndpoint: string;
  openaiCompatibleApiKey: string;
  openaiCompatibleEndpoint: string;
  claudeCodeTelemetryEnabled: boolean;
  otelExporterEndpoint: string;
  otelServiceName: string;
  otelExporterProtocol: string;
  otelExporterHeaders: string;
}

import { resolveBackendPort } from '@/lib/portConfig';

// Resolve the SAME way the real lib/config does on the server side: honor
// AH_PORT (legacy AGENT_HEALTH_PORT) and only then fall back to 4001. The
// previous hardcoded DEFAULT_BACKEND_PORT sent every service-layer jest suite
// to port 4001 — whatever happens to be running there (on dev boxes, a LIVE
// server) — silently ignoring the AH_PORT the test run was told to use.
//
// IMPORTANT: resolve per-access, not once at module-import time. A plain
// `const BACKEND_URL = ...` computed here freezes the value at first import
// for this module's lifetime in a given jest module registry — any suite
// that sets `process.env.AH_PORT` in `beforeEach`/per-test (rather than
// before the FIRST import anywhere in the run) would silently keep hitting
// whatever port was resolved the first time, without `jest.resetModules()`.
// Getters make every property read re-resolve `resolveBackendPort()` fresh,
// so env changes between tests take effect immediately with zero extra setup
// in the consuming suite.
function backendUrl(): string {
  return `http://localhost:${resolveBackendPort()}`;
}

export const ENV_CONFIG: EnvConfig = {
  awsRegion: 'us-east-1',
  awsProfile: 'default',
  bedrockModelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  openSearchLogsEndpoint: '',
  openSearchLogsUsername: '',
  openSearchLogsPassword: '',
  openSearchLogsTracesIndex: 'otel-v1-apm-span-*',
  openSearchLogsIndex: 'ml-commons-logs-*',
  mlcommonsEndpoint: 'http://localhost:9200/_plugins/_ml/agents/{agent_id}/_execute/stream',
  mlcommonsHeaderOpenSearchUrl: '',
  mlcommonsHeaderAuthorization: '',
  mlcommonsHeaderAwsRegion: '',
  mlcommonsHeaderAwsServiceName: 'es',
  mlcommonsHeaderAwsAccessKeyId: '',
  mlcommonsHeaderAwsSecretAccessKey: '',
  mlcommonsHeaderAwsSessionToken: '',
  travelPlannerEndpoint: 'http://localhost:3000',
  observioEndpoint: 'http://localhost:3001/run-agent',
  openaiCompatibleApiKey: '',
  openaiCompatibleEndpoint: 'http://localhost:4000/v1/chat/completions',
  claudeCodeTelemetryEnabled: false,
  otelExporterEndpoint: '',
  otelServiceName: 'claude-code-agent',
  otelExporterProtocol: '',
  otelExporterHeaders: '',
} as EnvConfig;

// Backend-URL-derived fields are defined as GETTERS (not plain string
// properties) so every read re-resolves `resolveBackendPort()` against the
// CURRENT `process.env.AH_PORT` — see the comment above `backendUrl()`.
Object.defineProperties(ENV_CONFIG, {
  backendUrl: { enumerable: true, configurable: true, get: () => backendUrl() },
  judgeApiUrl: { enumerable: true, configurable: true, get: () => `${backendUrl()}/api/judge` },
  storageApiUrl: { enumerable: true, configurable: true, get: () => `${backendUrl()}/api/storage` },
  agentProxyUrl: { enumerable: true, configurable: true, get: () => `${backendUrl()}/api/agent` },
  openSearchProxyUrl: {
    enumerable: true,
    configurable: true,
    get: () => `${backendUrl()}/api/opensearch/logs`,
  },
});

export function buildMLCommonsHeaders(): Record<string, string> {
  return {};
}
