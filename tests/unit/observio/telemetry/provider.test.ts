/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for observio-sample-agent telemetry provider.
 *
 * Verifies OTLP export initialization behavior via console output.
 */

describe('observio telemetry provider', () => {
  const originalEnv = process.env;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.OTEL_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    process.env = originalEnv;
  });

  describe('initTelemetry', () => {
    it('disables telemetry when OTEL_ENABLED=false', () => {
      process.env.OTEL_ENABLED = 'false';
      const { initTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      initTelemetry();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Telemetry] Observio telemetry disabled (OTEL_ENABLED=false)'
      );
    });

    it('disables telemetry when OTEL_EXPORTER_OTLP_ENDPOINT is not set', () => {
      const { initTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      initTelemetry();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Telemetry] Observio telemetry disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)'
      );
    });

    it('enables OTLP export when OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://api-gw.example.com/v1/traces';

      const { initTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      initTelemetry();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Telemetry] Observio telemetry enabled → OTLP (https://api-gw.example.com/v1/traces)'
      );
    });

    it('is idempotent - second call is a no-op', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://api-gw.example.com/v1/traces';

      const { initTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      initTelemetry();
      consoleSpy.mockClear();
      initTelemetry(); // second call

      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Observio telemetry enabled')
      );
    });
  });

  describe('shutdownTelemetry', () => {
    it('is safe to call when not initialized', async () => {
      const { shutdownTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      await expect(shutdownTelemetry()).resolves.toBeUndefined();
    });
  });

  describe('getTracer', () => {
    it('returns a tracer instance', () => {
      const { getTracer } = require('@/observio-sample-agent/src/telemetry/provider');
      const tracer = getTracer();
      expect(tracer).toBeDefined();
      expect(tracer.startSpan).toBeDefined();
    });
  });

  describe('OBSERVIO_TRACER_NAME', () => {
    it('exports the correct tracer name', () => {
      const { OBSERVIO_TRACER_NAME } = require('@/observio-sample-agent/src/telemetry/provider');
      expect(OBSERVIO_TRACER_NAME).toBe('observio-sample-agent');
    });
  });
});
