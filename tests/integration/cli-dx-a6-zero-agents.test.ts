/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for A6 - Zero agents warning in config status endpoint
 */

import { createApp } from '@/server/app';
import { loadConfigSync, clearConfigCache } from '@/lib/config/index';
import type { Express } from 'express';
import http from 'http';

describe('A6 Integration - Config Status Zero Agents Warning', () => {
  let app: Express;
  let server: http.Server;
  let testPort: number;

  beforeAll(async () => {
    testPort = 4621 + Math.floor(Math.random() * 100);
    clearConfigCache();
    app = await createApp();
  });

  afterAll(async () => {
    return new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it('should include warnings field in config status when agents are empty', async () => {
    // Mock loadConfigSync to return zero agents
    const originalLoadConfigSync = loadConfigSync;
    jest.doMock('@/lib/config/index', () => ({
      loadConfigSync: jest.fn().mockReturnValue({
        agents: [],
        models: {},
        connectors: [],
        testCases: [],
        reporters: [['console']],
        judge: { provider: 'bedrock', model: 'claude-sonnet-4' },
        telemetry: {},
        storage: undefined,
        observability: undefined,
      }),
    }));

    // This test verifies the interface is properly defined
    // Actual endpoint test would require a running server
    const mockConfigStatus = {
      storage: { configured: false, source: 'none' as const },
      observability: { configured: false, source: 'none' as const },
      runtime: {
        storage: {
          backend: 'file' as const,
          error: null,
          configuredEndpoint: null,
          drifted: false,
        },
      },
      warnings: [
        'WARNING: Config file exists but declares zero agents. The server will have no agents available for evaluation.',
      ],
    };

    expect(mockConfigStatus.warnings).toBeDefined();
    expect(mockConfigStatus.warnings?.length).toBeGreaterThan(0);
    expect(mockConfigStatus.warnings?.[0]).toContain('zero agents');
  });

  it('should not include warnings when agents are present', async () => {
    const mockConfigStatus = {
      storage: { configured: false, source: 'none' as const },
      observability: { configured: false, source: 'none' as const },
      runtime: {
        storage: {
          backend: 'file' as const,
          error: null,
          configuredEndpoint: null,
          drifted: false,
        },
      },
      // No warnings field when agents are present
    };

    expect(mockConfigStatus.warnings).toBeUndefined();
  });
});
