/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for lib/debug.ts
 *
 * The `isBrowser` constant is evaluated at module load time via
 * `typeof window !== 'undefined'`. To test both browser and Node.js paths
 * we use jest.resetModules() + require() so the module re-evaluates in the
 * correct environment context.
 */

describe('Debug Utility', () => {
  let consoleDebugSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleDebugSpy.mockRestore();
    delete process.env.DEBUG;
    jest.resetModules();
  });

  describe('Browser environment (window defined)', () => {
    // testEnvironment is 'node', so we need to create a window object
    // so the debug module's `typeof window !== 'undefined'` evaluates to true
    let mod: typeof import('@/lib/debug');
    const originalWindow = global.window;
    const originalLocalStorage = global.localStorage;

    beforeEach(() => {
      // Set up localStorage mock
      const localStorageMock: Storage = {
        getItem: jest.fn(),
        setItem: jest.fn(),
        removeItem: jest.fn(),
        clear: jest.fn(),
        length: 0,
        key: jest.fn(),
      };

      // Create a minimal window object so `typeof window !== 'undefined'` is true
      // @ts-ignore - creating minimal window for test
      global.window = { localStorage: localStorageMock } as any;
      Object.defineProperty(global, 'localStorage', {
        value: localStorageMock,
        writable: true,
        configurable: true,
      });

      jest.resetModules();
      mod = require('@/lib/debug');
    });

    afterEach(() => {
      // Restore original window (undefined in node env)
      if (originalWindow === undefined) {
        // @ts-ignore
        delete global.window;
      } else {
        global.window = originalWindow;
      }
      Object.defineProperty(global, 'localStorage', {
        value: originalLocalStorage,
        writable: true,
        configurable: true,
      });
    });

    describe('isDebugEnabled', () => {
      it('should return true when localStorage has debug set to true', () => {
        (localStorage.getItem as jest.Mock).mockReturnValue('true');
        expect(mod.isDebugEnabled()).toBe(true);
        expect(localStorage.getItem).toHaveBeenCalledWith('agenteval_debug');
      });

      it('should return false when localStorage has debug set to false', () => {
        (localStorage.getItem as jest.Mock).mockReturnValue('false');
        expect(mod.isDebugEnabled()).toBe(false);
      });

      it('should return false when localStorage has no debug setting', () => {
        (localStorage.getItem as jest.Mock).mockReturnValue(null);
        expect(mod.isDebugEnabled()).toBe(false);
      });

      it('should return false when localStorage throws an error', () => {
        (localStorage.getItem as jest.Mock).mockImplementation(() => {
          throw new Error('localStorage not available');
        });
        expect(mod.isDebugEnabled()).toBe(false);
      });
    });

    describe('setDebugEnabled', () => {
      it('should set debug to true in localStorage', () => {
        mod.setDebugEnabled(true);
        expect(localStorage.setItem).toHaveBeenCalledWith('agenteval_debug', 'true');
      });

      it('should set debug to false in localStorage', () => {
        mod.setDebugEnabled(false);
        expect(localStorage.setItem).toHaveBeenCalledWith('agenteval_debug', 'false');
      });
    });

    describe('debug', () => {
      it('should log to console.debug when debug is enabled', () => {
        (localStorage.getItem as jest.Mock).mockReturnValue('true');
        mod.debug('TestModule', 'test message', { data: 123 });
        expect(consoleDebugSpy).toHaveBeenCalledWith('[TestModule]', 'test message', { data: 123 });
      });

      it('should not log when debug is disabled', () => {
        (localStorage.getItem as jest.Mock).mockReturnValue('false');
        mod.debug('TestModule', 'test message');
        expect(consoleDebugSpy).not.toHaveBeenCalled();
      });

      it('should handle multiple arguments', () => {
        (localStorage.getItem as jest.Mock).mockReturnValue('true');
        mod.debug('Module', 'arg1', 'arg2', 123, { obj: true });
        expect(consoleDebugSpy).toHaveBeenCalledWith('[Module]', 'arg1', 'arg2', 123, { obj: true });
      });

      it('should not log when localStorage is not available', () => {
        (localStorage.getItem as jest.Mock).mockImplementation(() => {
          throw new Error('localStorage not available');
        });
        mod.debug('TestModule', 'test message');
        expect(consoleDebugSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Node.js environment (no window)', () => {
    const originalWindow = global.window;

    afterEach(() => {
      Object.defineProperty(global, 'window', {
        value: originalWindow,
        writable: true,
        configurable: true,
      });
    });

    it('should read in-memory flag when window is undefined', () => {
      // @ts-ignore - removing window to simulate Node.js
      delete global.window;
      jest.resetModules();

      const mod = require('@/lib/debug');
      expect(mod.isDebugEnabled()).toBe(false);
    });

    it('should initialize from process.env.DEBUG=true', () => {
      // @ts-ignore
      delete global.window;
      process.env.DEBUG = 'true';

      // Mock fs.existsSync to return false so the env var path is reached
      // (agent-health.yaml may exist in the project root)
      jest.resetModules();
      const realFs = jest.requireActual('fs');
      jest.mock('fs', () => ({
        ...realFs,
        existsSync: jest.fn().mockReturnValue(false),
      }));

      const mod = require('@/lib/debug');
      expect(mod.isDebugEnabled()).toBe(true);
    });

    it('should toggle server-side flag with setDebugEnabled', () => {
      // @ts-ignore
      delete global.window;
      jest.resetModules();

      const mod = require('@/lib/debug');
      expect(mod.isDebugEnabled()).toBe(false);

      mod.setDebugEnabled(true);
      expect(mod.isDebugEnabled()).toBe(true);

      mod.setDebugEnabled(false);
      expect(mod.isDebugEnabled()).toBe(false);
    });

    it('should call console.debug when server-side debug is enabled', () => {
      // @ts-ignore
      delete global.window;
      jest.resetModules();

      const mod = require('@/lib/debug');
      mod.setDebugEnabled(true);
      mod.debug('ServerTest', 'hello', 42);

      expect(consoleDebugSpy).toHaveBeenCalledWith('[ServerTest]', 'hello', 42);
    });

    it('should not call console.debug when server-side debug is disabled', () => {
      // @ts-ignore
      delete global.window;
      jest.resetModules();

      const mod = require('@/lib/debug');
      mod.setDebugEnabled(false);
      mod.debug('ServerTest', 'should not appear');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
    });
  });
});
