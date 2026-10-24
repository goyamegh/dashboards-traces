/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';

// Mock the version utility
jest.mock('@/server/utils/version', () => ({
  getVersion: jest.fn().mockReturnValue('1.0.0'),
}));

// Mock coding agents module
jest.mock('@/server/services/codingAgents', () => ({
  codingAnalyticsEnabled: true,
}));

// Eval telemetry export status (lib/telemetry/exportMonitor.ts) — swapped per test.
const telemetryMock = { enabled: false as boolean, status: undefined as any };
jest.mock('@/lib/telemetry', () => ({
  isEvalTelemetryEnabled: () => telemetryMock.enabled,
  getEvalExportStatus: () => telemetryMock.status,
}));

import healthRoutes from '@/server/routes/health';

// Helper to create mock request/response. `remoteAddress` defaults to
// loopback since the CLI ownership check always dials over localhost.
function createMocks(remoteAddress = '127.0.0.1') {
  const req = { socket: { remoteAddress } } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('Health Routes', () => {
  describe('GET /health', () => {
    it('returns health status', () => {
      const { req, res } = createMocks();

      // Get the route handler from the router
      const routes = (healthRoutes as any).stack;
      const healthRoute = routes.find(
        (layer: any) => layer.route && layer.route.path === '/health'
      );

      expect(healthRoute).toBeDefined();

      // Call the handler
      const handler = healthRoute.route.stack[0].handle;
      handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          version: '1.0.0',
          service: 'agent-health',
          features: {
            codingAgentAnalytics: true,
          },
        })
      );
    });

    it('includes an instance identity block (pid / cwd / port / startedAt)', () => {
      const { req, res } = createMocks();
      const prev = process.env.AH_PORT;
      process.env.AH_PORT = '4042';
      try {
        const routes = (healthRoutes as any).stack;
        const healthRoute = routes.find(
          (layer: any) => layer.route && layer.route.path === '/health'
        );
        const handler = healthRoute.route.stack[0].handle;
        handler(req, res);

        const payload = (res.json as jest.Mock).mock.calls[0][0];
        expect(payload.instance).toBeDefined();
        expect(payload.instance.pid).toBe(process.pid);
        expect(payload.instance.cwd).toBe(process.cwd());
        // `port` reflects AH_PORT (the actual bound port after auto-increment).
        expect(payload.instance.port).toBe(4042);
        expect(typeof payload.instance.startedAt).toBe('string');
        expect(Number.isNaN(Date.parse(payload.instance.startedAt))).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.AH_PORT;
        else process.env.AH_PORT = prev;
      }
    });

    it('omits the instance block for non-loopback (off-host) callers', () => {
      const { req, res } = createMocks('203.0.113.7');
      const routes = (healthRoutes as any).stack;
      const healthRoute = routes.find(
        (layer: any) => layer.route && layer.route.path === '/health'
      );
      const handler = healthRoute.route.stack[0].handle;
      handler(req, res);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.instance).toBeUndefined();
      // non-sensitive fields still returned
      expect(payload.status).toBe('ok');
      expect(payload.features).toBeDefined();
    });

    describe('telemetry block (eval span export health)', () => {
      const handle = (remoteAddress?: string) => {
        const { req, res } = createMocks(remoteAddress);
        const routes = (healthRoutes as any).stack;
        routes.find((l: any) => l.route && l.route.path === '/health').route.stack[0].handle(req, res);
        return (res.json as jest.Mock).mock.calls[0][0];
      };

      afterEach(() => { telemetryMock.enabled = false; telemetryMock.status = undefined; });

      it('reports enabled:false when eval telemetry is off', () => {
        expect(handle().telemetry).toEqual({ enabled: false });
      });

      it('reports the exporter counters + last error, with the endpoint for loopback callers only', () => {
        telemetryMock.enabled = true;
        telemetryMock.status = {
          exporter: 'otlp', endpoint: 'https://gw.example.com/v1/traces',
          exportedSpans: 7, failedBatches: 2, droppedSpans: 2,
          lastError: { at: '2026-01-01T00:00:00.000Z', message: 'HTTP 404 Not Found' },
          lastSuccessAt: '2026-01-01T00:01:00.000Z',
        };
        expect(handle().telemetry).toEqual({
          enabled: true, exporter: 'otlp', endpoint: 'https://gw.example.com/v1/traces',
          exportedSpans: 7, failedBatches: 2, droppedSpans: 2,
          lastError: { at: '2026-01-01T00:00:00.000Z', message: 'HTTP 404 Not Found' },
          lastSuccessAt: '2026-01-01T00:01:00.000Z',
        });
        const remote = handle('10.0.0.5').telemetry;
        expect(remote.endpoint).toBeUndefined();
        expect(remote).toMatchObject({ enabled: true, exportedSpans: 7, failedBatches: 2 });
      });
    });
  });
});
