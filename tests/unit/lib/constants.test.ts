/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_PRICING, DEFAULT_CONFIG, MOCK_TOOLS } from '@/lib/constants';
import { ENV_CONFIG } from '@/lib/config';

describe('lib/constants', () => {
  describe('MODEL_PRICING', () => {
    it('should have Claude Sonnet 4 model pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-sonnet-4-20250514-v1:0']).toEqual({
        input: 3.0,
        output: 15.0,
      });
    });

    it('should have Claude Sonnet 4.5 model pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-sonnet-4-5-20250929-v1:0']).toEqual({
        input: 3.0,
        output: 15.0,
      });
    });

    it('should have Claude Haiku 3.5 pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-3-5-haiku-20241022-v1:0']).toEqual({
        input: 0.80,
        output: 4.0,
      });
    });

    it('should have default fallback', () => {
      expect(MODEL_PRICING['default']).toEqual({
        input: 3.0,
        output: 15.0,
      });
    });

    it('should have all required pricing fields', () => {
      Object.entries(MODEL_PRICING).forEach(([key, pricing]) => {
        expect(pricing.input).toBeGreaterThanOrEqual(0);
        expect(pricing.output).toBeGreaterThanOrEqual(0);
        expect(typeof pricing.input).toBe('number');
        expect(typeof pricing.output).toBe('number');
      });
    });
  });

  describe('DEFAULT_CONFIG', () => {
    describe('agents', () => {
      it('should have at least one agent configured', () => {
        expect(DEFAULT_CONFIG.agents.length).toBeGreaterThan(0);
      });

      it('should have langgraph agent', () => {
        const langgraph = DEFAULT_CONFIG.agents.find(a => a.key === 'langgraph');
        expect(langgraph).toBeDefined();
        expect(langgraph?.name).toBe('Langgraph');
        expect(langgraph?.endpoint).toContain('localhost:3000');
      });

      it('should have ml-commons agent', () => {
        const mlcommons = DEFAULT_CONFIG.agents.find(a => a.key === 'mlcommons-local');
        expect(mlcommons).toBeDefined();
        expect(mlcommons?.name).toBe('ML-Commons (Localhost)');
        expect(mlcommons?.endpoint).toContain('_plugins/_ml/agents');
      });

      it('should have holmesgpt agent', () => {
        const holmesgpt = DEFAULT_CONFIG.agents.find(a => a.key === 'holmesgpt');
        expect(holmesgpt).toBeDefined();
        expect(holmesgpt?.name).toBe('HolmesGPT');
        expect(holmesgpt?.endpoint).toContain('agui/chat');
      });

      it('should have valid agent structure', () => {
        DEFAULT_CONFIG.agents.forEach(agent => {
          expect(agent.key).toBeDefined();
          expect(agent.name).toBeDefined();
          expect(agent.endpoint).toBeDefined();
          expect(agent.models).toBeInstanceOf(Array);
          expect(agent.models.length).toBeGreaterThan(0);
          expect(typeof agent.useTraces).toBe('boolean');
        });
      });
    });

    describe('models', () => {
      it('should have multiple models configured', () => {
        expect(Object.keys(DEFAULT_CONFIG.models).length).toBeGreaterThan(0);
      });

      it('should have claude-sonnet-4 model', () => {
        const model = DEFAULT_CONFIG.models['claude-sonnet-4'];
        expect(model).toBeDefined();
        expect(model.model_id).toContain('claude-sonnet-4');
        expect(model.display_name).toBe('Claude Sonnet 4');
        expect(model.context_window).toBe(200000);
        expect(model.max_output_tokens).toBeGreaterThan(0);
      });

      it('should have claude-sonnet-4.5 model', () => {
        const model = DEFAULT_CONFIG.models['claude-sonnet-4.5'];
        expect(model).toBeDefined();
        expect(model.display_name).toBe('Claude Sonnet 4.5');
      });

      it('should have claude-haiku-3.5 model', () => {
        const model = DEFAULT_CONFIG.models['claude-haiku-3.5'];
        expect(model).toBeDefined();
        expect(model.display_name).toBe('Claude Haiku 3.5');
      });

      it('should have valid model structure', () => {
        Object.entries(DEFAULT_CONFIG.models).forEach(([key, model]) => {
          expect(model.model_id).toBeDefined();
          expect(model.display_name).toBeDefined();
          expect(model.context_window).toBeGreaterThan(0);
          expect(model.max_output_tokens).toBeGreaterThan(0);
        });
      });
    });

    describe('defaults', () => {
      it('should have retry configuration', () => {
        expect(DEFAULT_CONFIG.defaults.retry_attempts).toBe(2);
        expect(DEFAULT_CONFIG.defaults.retry_delay_ms).toBe(1000);
      });
    });
  });

  describe('MOCK_TOOLS', () => {
    it('should have multiple mock tools', () => {
      expect(MOCK_TOOLS.length).toBeGreaterThan(0);
    });

    it('should have cluster_health tool', () => {
      const tool = MOCK_TOOLS.find(t => t.name === 'opensearch_cluster_health');
      expect(tool).toBeDefined();
      expect(tool?.description).toContain('cluster health');
    });

    it('should have cat_nodes tool', () => {
      const tool = MOCK_TOOLS.find(t => t.name === 'opensearch_cat_nodes');
      expect(tool).toBeDefined();
    });

    it('should have nodes_stats tool', () => {
      const tool = MOCK_TOOLS.find(t => t.name === 'opensearch_nodes_stats');
      expect(tool).toBeDefined();
    });

    it('should have valid tool structure', () => {
      MOCK_TOOLS.forEach(tool => {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
      });
    });

    it('should have opensearch-prefixed tool names', () => {
      MOCK_TOOLS.forEach(tool => {
        expect(tool.name).toMatch(/^opensearch_/);
      });
    });
  });

  describe('Claude Code telemetry configuration', () => {
    const savedTelemetryEnabled = ENV_CONFIG.claudeCodeTelemetryEnabled;
    const savedOtelEndpoint = ENV_CONFIG.otelExporterEndpoint;
    const savedOtelServiceName = ENV_CONFIG.otelServiceName;
    const savedOtelProtocol = ENV_CONFIG.otelExporterProtocol;
    const savedOtelHeaders = ENV_CONFIG.otelExporterHeaders;

    afterEach(() => {
      // Restore original values
      (ENV_CONFIG as any).claudeCodeTelemetryEnabled = savedTelemetryEnabled;
      (ENV_CONFIG as any).otelExporterEndpoint = savedOtelEndpoint;
      (ENV_CONFIG as any).otelServiceName = savedOtelServiceName;
      (ENV_CONFIG as any).otelExporterProtocol = savedOtelProtocol;
      (ENV_CONFIG as any).otelExporterHeaders = savedOtelHeaders;
    });

    it('should disable telemetry by default', () => {
      const claudeCode = DEFAULT_CONFIG.agents.find(a => a.key === 'claude-code');
      expect(claudeCode).toBeDefined();
      expect(claudeCode!.useTraces).toBe(false);

      const connectorEnv = claudeCode!.connectorConfig?.env as Record<string, string>;
      expect(connectorEnv).toBeDefined();
      expect(connectorEnv.DISABLE_TELEMETRY).toBe('1');
      expect(connectorEnv.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    });

    it('should enable telemetry when claudeCodeTelemetryEnabled=true and endpoint is set', () => {
      (ENV_CONFIG as any).claudeCodeTelemetryEnabled = true;
      (ENV_CONFIG as any).otelExporterEndpoint = 'http://localhost:4317';
      (ENV_CONFIG as any).otelServiceName = 'test-service';
      (ENV_CONFIG as any).otelExporterProtocol = 'grpc';
      (ENV_CONFIG as any).otelExporterHeaders = 'Authorization=Bearer token';

      const claudeCode = DEFAULT_CONFIG.agents.find(a => a.key === 'claude-code');
      expect(claudeCode).toBeDefined();
      expect(claudeCode!.useTraces).toBe(true);

      const connectorEnv = claudeCode!.connectorConfig?.env as Record<string, string>;
      expect(connectorEnv).toBeDefined();
      expect(connectorEnv.DISABLE_TELEMETRY).toBeUndefined();
      expect(connectorEnv.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
      expect(connectorEnv.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4317');
      expect(connectorEnv.OTEL_SERVICE_NAME).toBe('test-service');
      expect(connectorEnv.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('grpc');
      expect(connectorEnv.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=Bearer token');
    });

    it('should disable telemetry when enabled but no endpoint is set', () => {
      (ENV_CONFIG as any).claudeCodeTelemetryEnabled = true;
      (ENV_CONFIG as any).otelExporterEndpoint = '';

      const claudeCode = DEFAULT_CONFIG.agents.find(a => a.key === 'claude-code');
      expect(claudeCode).toBeDefined();
      expect(claudeCode!.useTraces).toBe(false);

      const connectorEnv = claudeCode!.connectorConfig?.env as Record<string, string>;
      expect(connectorEnv).toBeDefined();
      expect(connectorEnv.DISABLE_TELEMETRY).toBe('1');
      expect(connectorEnv.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    });

    it('should not forward optional OTEL vars when they are not set', () => {
      (ENV_CONFIG as any).claudeCodeTelemetryEnabled = true;
      (ENV_CONFIG as any).otelExporterEndpoint = 'http://localhost:4317';
      (ENV_CONFIG as any).otelExporterProtocol = '';
      (ENV_CONFIG as any).otelExporterHeaders = '';

      const claudeCode = DEFAULT_CONFIG.agents.find(a => a.key === 'claude-code');
      const connectorEnv = claudeCode!.connectorConfig?.env as Record<string, string>;
      expect(connectorEnv.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
      expect(connectorEnv.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4317');
      expect(connectorEnv.OTEL_SERVICE_NAME).toBe('claude-code-agent'); // default
      expect(connectorEnv.OTEL_EXPORTER_OTLP_PROTOCOL).toBeUndefined();
      expect(connectorEnv.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    });
  });
});
