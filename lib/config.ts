/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment Configuration
 *
 * Environment variables are manually exposed via vite.config.ts using loadEnv()
 * This allows us to use variables without the VITE_ prefix
 * See: vite.config.ts and https://vitejs.dev/guide/env-and-mode.html
 */

// =============================================================================
// Backend URL Configuration (single source of truth)
// =============================================================================

// Detect if running server-side (Node.js) vs browser
const isServerSide = typeof window === 'undefined';

// Empty string = relative URLs (works in browser)
// Full URL needed for server-side (Node.js) since fetch() has no base URL context
const SERVER_PORT = isServerSide ? (process.env?.VITE_BACKEND_PORT || process.env?.PORT || '4001') : '4001';
const BACKEND_URL = isServerSide ? `http://localhost:${SERVER_PORT}` : '';

export interface EnvConfig {
  // Backend server
  backendUrl: string;

  // API endpoints (derived from backend URL)
  judgeApiUrl: string;
  storageApiUrl: string;
  agentProxyUrl: string;
  openSearchProxyUrl: string;

  // AWS/Bedrock
  awsRegion: string;
  awsProfile: string;
  bedrockModelId: string;

  // OpenSearch Logs (for fetching agent observability data)
  openSearchLogsEndpoint: string;
  openSearchLogsUsername: string;
  openSearchLogsPassword: string;
  openSearchLogsTracesIndex: string;
  openSearchLogsIndex: string;

  // Travel Planner multi-agent endpoint (OTel Demo in Docker)
  travelPlannerEndpoint: string;

  // LiteLLM (optional - for OpenAI-compatible judge/agent endpoints)
  litellmApiKey: string;
  litellmEndpoint: string;

  // Claude Code Telemetry (optional - for OTEL traces from Claude Code)
  claudeCodeTelemetryEnabled: boolean;
  otelExporterEndpoint: string;
  otelServiceName: string;
  otelExporterProtocol: string;
  otelExporterHeaders: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browserEnv: Record<string, string> = {};

// Only access import.meta in browser context (Vite bundles this)
// In Node.js/Jest, this block is skipped and browserEnv stays empty
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    browserEnv = (import.meta as any)?.env || {};
  } catch {
    // Ignore - we're in a test environment
  }
}

const getEnvVar = (key: string, defaultValue?: string): string => {
  // Server: use process.env (Node.js native)
  // Client: use import.meta.env (Vite replaces at build time, see vite.config.ts)
  if (isServerSide) {
    return process.env?.[key] || defaultValue || '';
  }
  // Browser: use pre-loaded env
  return browserEnv[key] || defaultValue || '';
};

export const ENV_CONFIG: EnvConfig = {
  // Backend server - empty string means relative URLs
  backendUrl: BACKEND_URL,

  // API endpoints (derived from backend URL)
  judgeApiUrl: `${BACKEND_URL}/api/judge`,
  storageApiUrl: `${BACKEND_URL}/api/storage`,
  agentProxyUrl: `${BACKEND_URL}/api/agent`,
  openSearchProxyUrl: `${BACKEND_URL}/api/opensearch/logs`,

  // AWS/Bedrock
  awsRegion: getEnvVar('AWS_REGION', 'us-east-1'),
  awsProfile: getEnvVar('AWS_PROFILE', 'default'),
  bedrockModelId: getEnvVar('BEDROCK_MODEL_ID', 'anthropic.claude-3-5-sonnet-20241022-v2:0'),

  // OpenSearch Logs (for fetching agent observability data)
  openSearchLogsEndpoint: getEnvVar('OPENSEARCH_LOGS_ENDPOINT', ''),
  openSearchLogsUsername: getEnvVar('OPENSEARCH_LOGS_USERNAME', ''),
  openSearchLogsPassword: getEnvVar('OPENSEARCH_LOGS_PASSWORD', ''),
  openSearchLogsTracesIndex: getEnvVar('OPENSEARCH_LOGS_TRACES_INDEX', 'otel-v1-apm-span-*'),
  openSearchLogsIndex: getEnvVar('OPENSEARCH_LOGS_INDEX', 'ml-commons-logs-*'),

  // Travel Planner multi-agent endpoint (OTel Demo in Docker)
  travelPlannerEndpoint: getEnvVar('TRAVEL_PLANNER_ENDPOINT', 'http://localhost:3000'),

  // LiteLLM (optional - for OpenAI-compatible judge/agent endpoints)
  litellmApiKey: getEnvVar('LITELLM_API_KEY', ''),
  litellmEndpoint: getEnvVar('LITELLM_ENDPOINT', 'http://localhost:4000/v1/chat/completions'),

  // Claude Code Telemetry (optional - for OTEL traces from Claude Code)
  claudeCodeTelemetryEnabled: getEnvVar('CLAUDE_CODE_TELEMETRY_ENABLED', 'false') === 'true',
  otelExporterEndpoint: getEnvVar('OTEL_EXPORTER_OTLP_ENDPOINT', ''),
  otelServiceName: getEnvVar('OTEL_SERVICE_NAME', 'claude-code-agent'),
  otelExporterProtocol: getEnvVar('OTEL_EXPORTER_OTLP_PROTOCOL', ''),
  otelExporterHeaders: getEnvVar('OTEL_EXPORTER_OTLP_HEADERS', ''),
};
