/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';

// Mock the debug module
jest.mock('@/lib/debug', () => ({
  isDebugEnabled: jest.fn().mockReturnValue(false),
  setDebugEnabled: jest.fn(),
}));

import debugRoutes from '@/server/routes/debug';
import { isDebugEnabled, setDebugEnabled } from '@/lib/debug';

const mockIsDebugEnabled = isDebugEnabled as jest.MockedFunction<typeof isDebugEnabled>;
const mockSetDebugEnabled = setDebugEnabled as jest.MockedFunction<typeof setDebugEnabled>;

function createMocks(body?: any) {
  const req = { body } as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

function getRouteHandler(method: string, path: string) {
  const routes = (debugRoutes as any).stack;
  const layer = routes.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method]
  );
  return layer?.route.stack[0].handle;
}

describe('Debug Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/debug', () => {
    it('returns enabled: false by default', () => {
      mockIsDebugEnabled.mockReturnValue(false);
      const { req, res } = createMocks();
      const handler = getRouteHandler('get', '/api/debug');

      handler(req, res);

      expect(res.json).toHaveBeenCalledWith({ enabled: false });
    });

    it('returns enabled: true when debug is on', () => {
      mockIsDebugEnabled.mockReturnValue(true);
      const { req, res } = createMocks();
      const handler = getRouteHandler('get', '/api/debug');

      handler(req, res);

      expect(res.json).toHaveBeenCalledWith({ enabled: true });
    });
  });

  describe('POST /api/debug', () => {
    it('enables debug mode', () => {
      mockIsDebugEnabled.mockReturnValue(true);
      const { req, res } = createMocks({ enabled: true });
      const handler = getRouteHandler('post', '/api/debug');

      handler(req, res);

      expect(mockSetDebugEnabled).toHaveBeenCalledWith(true);
      expect(res.json).toHaveBeenCalledWith({ enabled: true });
    });

    it('disables debug mode', () => {
      mockIsDebugEnabled.mockReturnValue(false);
      const { req, res } = createMocks({ enabled: false });
      const handler = getRouteHandler('post', '/api/debug');

      handler(req, res);

      expect(mockSetDebugEnabled).toHaveBeenCalledWith(false);
      expect(res.json).toHaveBeenCalledWith({ enabled: false });
    });

    it('returns 400 when enabled is not a boolean', () => {
      const { req, res } = createMocks({ enabled: 'yes' });
      const handler = getRouteHandler('post', '/api/debug');

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'enabled must be a boolean' });
      expect(mockSetDebugEnabled).not.toHaveBeenCalled();
    });

    it('returns 400 when body is empty', () => {
      const { req, res } = createMocks({});
      const handler = getRouteHandler('post', '/api/debug');

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'enabled must be a boolean' });
    });
  });
});
