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
// Accessor properties make every property read re-resolve `resolveBackendPort()`
// fresh, so env changes between tests take effect immediately with zero extra
// setup in the consuming suite.
//
// Each accessor also has a SETTER that records an explicit override. Plain
// getter-only accessors would make `ENV_CONFIG.backendUrl = '...'` throw (or
// silently no-op) in any suite that monkeypatches this mock directly — a
// pattern this repo's own mocks otherwise allow for every other field. The
// setter preserves that: an explicit assignment always wins over the
// env-derived default, exactly like a normal mutable property would.
const overrides: Partial<Pick<EnvConfig, typeof urlFieldNames[number]>> = {};
const urlFieldNames = [
  'backendUrl',
  'judgeApiUrl',
  'storageApiUrl',
  'agentProxyUrl',
  'openSearchProxyUrl',
] as const;

function backendUrl(): string {
  return overrides.backendUrl ?? `http://localhost:${resolveBackendPort()}`;
}

/**
 * Base config fields, typed against everything EXCEPT the URL fields defined
 * as accessors below. Using `Omit<EnvConfig, ...>` here (rather than casting
 * the whole literal to `EnvConfig`) keeps the compiler's exhaustiveness check
 * on every field this object literal is actually responsible for — a plain
 * `as EnvConfig` cast on an object literal missing 5 required fields would
 * silently swallow a "forgot to add a new EnvConfig field" mistake instead of
 * failing to compile.
 */
const baseConfig: Omit<EnvConfig, typeof urlFieldNames[number]> = {
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
};

// Backend-URL-derived fields are defined as GET/SET accessor properties (not
// plain string properties) so every read re-resolves `resolveBackendPort()`
// against the CURRENT `process.env.AH_PORT` — see the comment above
// `backendUrl()` — while a write still behaves like assigning a normal field.
export const ENV_CONFIG: EnvConfig = Object.defineProperties(
  { ...baseConfig } as EnvConfig,
  {
    backendUrl: {
      enumerable: true,
      configurable: true,
      get: () => backendUrl(),
      set: (v: string) => { overrides.backendUrl = v; },
    },
    judgeApiUrl: {
      enumerable: true,
      configurable: true,
      get: () => overrides.judgeApiUrl ?? `${backendUrl()}/api/judge`,
      set: (v: string) => { overrides.judgeApiUrl = v; },
    },
    storageApiUrl: {
      enumerable: true,
      configurable: true,
      get: () => overrides.storageApiUrl ?? `${backendUrl()}/api/storage`,
      set: (v: string) => { overrides.storageApiUrl = v; },
    },
    agentProxyUrl: {
      enumerable: true,
      configurable: true,
      get: () => overrides.agentProxyUrl ?? `${backendUrl()}/api/agent`,
      set: (v: string) => { overrides.agentProxyUrl = v; },
    },
    openSearchProxyUrl: {
      enumerable: true,
      configurable: true,
      get: () => overrides.openSearchProxyUrl ?? `${backendUrl()}/api/opensearch/logs`,
      set: (v: string) => { overrides.openSearchProxyUrl = v; },
    },
  },
);

export function buildMLCommonsHeaders(): Record<string, string> {
  return {};
}
