/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ---------------------------------------------------------------------------
// fs mock — declared before importing the module under test.
// We use delegate functions so the mock factory (hoisted by Jest) captures
// references that we can reconfigure per-test via the outer jest.fn() handles.
// ---------------------------------------------------------------------------
const mockExistsSync = jest.fn().mockReturnValue(false);
const mockReadFileSync = jest.fn().mockReturnValue('');
const mockWriteFileSync = jest.fn();
const mockRenameSync = jest.fn();

jest.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  renameSync: (...args: any[]) => mockRenameSync(...args),
}));

// ---------------------------------------------------------------------------
// path mock — join simply concatenates with '/'
// ---------------------------------------------------------------------------
jest.mock('path', () => ({
  join: (...segments: string[]) => segments.join('/'),
}));

// ---------------------------------------------------------------------------
// js-yaml mock — controlled via mockYamlLoad
// ---------------------------------------------------------------------------
const mockYamlLoad = jest.fn();

// We need to intercept the dynamic `import('js-yaml')` inside the module.
// Jest doesn't natively mock dynamic imports, so we use a manual approach:
// mock the module so that when `import('js-yaml')` is called, it returns our mock.
jest.mock('js-yaml', () => ({
  load: (...args: any[]) => mockYamlLoad(...args),
}));

import { migrateYamlToJsonIfNeeded } from '@/server/services/configMigration';

// ---------------------------------------------------------------------------
// Suppress console output during tests
// ---------------------------------------------------------------------------
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Configure mockExistsSync to return different values based on path suffix */
function setupExistsSync(options: {
  yaml?: boolean;
  backup?: boolean;
  json?: boolean;
}) {
  mockExistsSync.mockImplementation((filePath: string) => {
    if (filePath.endsWith('.backup')) return options.backup ?? false;
    if (filePath.endsWith('.yaml')) return options.yaml ?? false;
    if (filePath.endsWith('.json')) return options.json ?? false;
    return false;
  });
}

/** Configure mockReadFileSync to return different content based on path suffix */
function setupReadFileSync(options: { yaml?: string; json?: string }) {
  mockReadFileSync.mockImplementation((filePath: string) => {
    if (filePath.endsWith('.yaml')) return options.yaml ?? '';
    if (filePath.endsWith('.json')) return options.json ?? '{}';
    return '';
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('configMigration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
    mockWriteFileSync.mockReset();
    mockRenameSync.mockReset();
    mockYamlLoad.mockReset();
  });

  // -----------------------------------------------------------------------
  // No-op conditions (early returns)
  // -----------------------------------------------------------------------

  describe('early return conditions', () => {
    it('should no-op when YAML file does not exist', async () => {
      setupExistsSync({ yaml: false });

      await migrateYamlToJsonIfNeeded();

      expect(mockReadFileSync).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
    });

    it('should no-op when backup already exists (already migrated)', async () => {
      setupExistsSync({ yaml: true, backup: true });

      await migrateYamlToJsonIfNeeded();

      expect(mockReadFileSync).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Invalid YAML content
  // -----------------------------------------------------------------------

  describe('invalid YAML content', () => {
    it('should warn and return when YAML parses to null', async () => {
      setupExistsSync({ yaml: true, backup: false });
      setupReadFileSync({ yaml: '' });
      mockYamlLoad.mockReturnValue(null);

      await migrateYamlToJsonIfNeeded();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('YAML file is empty or invalid'),
      );
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
    });

    it('should warn and return when YAML parses to a non-object (string)', async () => {
      setupExistsSync({ yaml: true, backup: false });
      setupReadFileSync({ yaml: 'just a string' });
      mockYamlLoad.mockReturnValue('just a string');

      await migrateYamlToJsonIfNeeded();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('YAML file is empty or invalid'),
      );
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
    });

    it('should warn and return when YAML parses to a number', async () => {
      setupExistsSync({ yaml: true, backup: false });
      setupReadFileSync({ yaml: '42' });
      mockYamlLoad.mockReturnValue(42);

      await migrateYamlToJsonIfNeeded();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('YAML file is empty or invalid'),
      );
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Successful migrations
  // -----------------------------------------------------------------------

  describe('successful migration', () => {
    it('should merge YAML storage section into new JSON file', async () => {
      const storageConfig = {
        endpoint: 'https://opensearch.example.com',
        username: 'admin',
        password: 'secret',
      };

      setupExistsSync({ yaml: true, backup: false, json: false });
      setupReadFileSync({ yaml: 'storage:\n  endpoint: ...' });
      mockYamlLoad.mockReturnValue({ storage: storageConfig });

      await migrateYamlToJsonIfNeeded();

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [writePath, writeContent] = mockWriteFileSync.mock.calls[0];
      expect(writePath).toContain('agent-health.config.json');

      const written = JSON.parse(writeContent);
      expect(written.storage).toEqual(storageConfig);
    });

    it('should merge YAML observability section into new JSON file', async () => {
      const observabilityConfig = {
        endpoint: 'https://otel.example.com',
        indexes: { traces: 'otel-v1-*' },
      };

      setupExistsSync({ yaml: true, backup: false, json: false });
      setupReadFileSync({ yaml: 'observability:\n  endpoint: ...' });
      mockYamlLoad.mockReturnValue({ observability: observabilityConfig });

      await migrateYamlToJsonIfNeeded();

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [, writeContent] = mockWriteFileSync.mock.calls[0];
      const written = JSON.parse(writeContent);
      expect(written.observability).toEqual(observabilityConfig);
    });

    it('should merge both storage and observability from YAML', async () => {
      const yamlConfig = {
        storage: { endpoint: 'https://storage.example.com' },
        observability: { endpoint: 'https://obs.example.com' },
      };

      setupExistsSync({ yaml: true, backup: false, json: false });
      setupReadFileSync({ yaml: 'yaml content' });
      mockYamlLoad.mockReturnValue(yamlConfig);

      await migrateYamlToJsonIfNeeded();

      const [, writeContent] = mockWriteFileSync.mock.calls[0];
      const written = JSON.parse(writeContent);
      expect(written.storage).toEqual(yamlConfig.storage);
      expect(written.observability).toEqual(yamlConfig.observability);
    });

    it('should preserve existing customAgents in JSON during merge', async () => {
      const existingJson = {
        customAgents: [
          { key: 'my-agent', name: 'My Agent', endpoint: 'http://localhost:3000' },
        ],
        theme: 'dark',
      };
      const yamlConfig = {
        storage: { endpoint: 'https://storage.example.com' },
      };

      setupExistsSync({ yaml: true, backup: false, json: true });
      setupReadFileSync({
        yaml: 'storage:\n  endpoint: ...',
        json: JSON.stringify(existingJson),
      });
      mockYamlLoad.mockReturnValue(yamlConfig);

      await migrateYamlToJsonIfNeeded();

      const [, writeContent] = mockWriteFileSync.mock.calls[0];
      const written = JSON.parse(writeContent);
      expect(written.customAgents).toEqual(existingJson.customAgents);
      expect(written.theme).toBe('dark');
      expect(written.storage).toEqual(yamlConfig.storage);
    });

    it('should rename YAML to .backup after successful write', async () => {
      setupExistsSync({ yaml: true, backup: false, json: false });
      setupReadFileSync({ yaml: 'storage:\n  endpoint: ...' });
      mockYamlLoad.mockReturnValue({ storage: { endpoint: 'https://example.com' } });

      await migrateYamlToJsonIfNeeded();

      expect(mockRenameSync).toHaveBeenCalledTimes(1);
      const [src, dest] = mockRenameSync.mock.calls[0];
      expect(src).toContain('agent-health.yaml');
      expect(dest).toContain('agent-health.yaml.backup');
    });

    it('should log success messages after migration', async () => {
      setupExistsSync({ yaml: true, backup: false, json: false });
      setupReadFileSync({ yaml: 'storage:\n  endpoint: ...' });
      mockYamlLoad.mockReturnValue({ storage: { endpoint: 'https://example.com' } });

      await migrateYamlToJsonIfNeeded();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Migrated agent-health.yaml'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Original YAML saved as'),
      );
    });

    it('should write JSON with 2-space indentation and trailing newline', async () => {
      setupExistsSync({ yaml: true, backup: false, json: false });
      setupReadFileSync({ yaml: 'storage:\n  endpoint: ...' });
      mockYamlLoad.mockReturnValue({ storage: { endpoint: 'https://example.com' } });

      await migrateYamlToJsonIfNeeded();

      const [, writeContent, encoding] = mockWriteFileSync.mock.calls[0];
      expect(writeContent).toMatch(/^\{[\s\S]*\}\n$/);
      expect(writeContent).toContain('  '); // 2-space indent
      expect(encoding).toBe('utf-8');
    });

    it('should create empty JSON config when YAML has no storage or observability', async () => {
      setupExistsSync({ yaml: true, backup: false, json: false });
      setupReadFileSync({ yaml: 'other_key: value' });
      mockYamlLoad.mockReturnValue({ other_key: 'value' });

      await migrateYamlToJsonIfNeeded();

      const [, writeContent] = mockWriteFileSync.mock.calls[0];
      const written = JSON.parse(writeContent);
      expect(written).toEqual({});
      expect(written.storage).toBeUndefined();
      expect(written.observability).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Existing JSON edge cases
  // -----------------------------------------------------------------------

  describe('existing JSON handling', () => {
    it('should start fresh when existing JSON is corrupt', async () => {
      setupExistsSync({ yaml: true, backup: false, json: true });
      setupReadFileSync({
        yaml: 'storage:\n  endpoint: ...',
        json: 'NOT VALID JSON {{{',
      });
      mockYamlLoad.mockReturnValue({
        storage: { endpoint: 'https://example.com' },
      });

      await migrateYamlToJsonIfNeeded();

      // Should still write — corrupt JSON is ignored, starts fresh
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [, writeContent] = mockWriteFileSync.mock.calls[0];
      const written = JSON.parse(writeContent);
      expect(written.storage).toEqual({ endpoint: 'https://example.com' });
    });

    it('should start fresh when existing JSON is an array (not an object)', async () => {
      setupExistsSync({ yaml: true, backup: false, json: true });
      setupReadFileSync({
        yaml: 'storage:\n  endpoint: ...',
        json: '["not", "an", "object"]',
      });
      mockYamlLoad.mockReturnValue({
        storage: { endpoint: 'https://example.com' },
      });

      await migrateYamlToJsonIfNeeded();

      const [, writeContent] = mockWriteFileSync.mock.calls[0];
      const written = JSON.parse(writeContent);
      // Array is ignored; starts with empty config, then merges YAML storage
      expect(written.storage).toEqual({ endpoint: 'https://example.com' });
    });

    it('should start fresh when existing JSON is null', async () => {
      setupExistsSync({ yaml: true, backup: false, json: true });
      setupReadFileSync({
        yaml: 'storage:\n  endpoint: ...',
        json: 'null',
      });
      mockYamlLoad.mockReturnValue({
        storage: { endpoint: 'https://example.com' },
      });

      await migrateYamlToJsonIfNeeded();

      const [, writeContent] = mockWriteFileSync.mock.calls[0];
      const written = JSON.parse(writeContent);
      expect(written.storage).toEqual({ endpoint: 'https://example.com' });
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('should catch and log error when js-yaml import fails', async () => {
      setupExistsSync({ yaml: true, backup: false });

      // Override the js-yaml mock to throw on load (simulating import failure)
      mockYamlLoad.mockImplementation(() => {
        throw new Error('Cannot find module js-yaml');
      });

      // readFileSync is called before yaml.load
      setupReadFileSync({ yaml: 'storage:\n  endpoint: ...' });

      await migrateYamlToJsonIfNeeded();

      expect(console.error).toHaveBeenCalledWith(
        '[ConfigMigration] Migration failed:',
        expect.any(Error),
      );
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
    });

    it('should catch and log error when fs.writeFileSync fails', async () => {
      setupExistsSync({ yaml: true, backup: false, json: false });
      setupReadFileSync({ yaml: 'storage:\n  endpoint: ...' });
      mockYamlLoad.mockReturnValue({
        storage: { endpoint: 'https://example.com' },
      });
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      await migrateYamlToJsonIfNeeded();

      expect(console.error).toHaveBeenCalledWith(
        '[ConfigMigration] Migration failed:',
        expect.any(Error),
      );
      // Rename should NOT be called since write failed
      expect(mockRenameSync).not.toHaveBeenCalled();
    });

    it('should catch and log error when fs.renameSync fails', async () => {
      setupExistsSync({ yaml: true, backup: false, json: false });
      setupReadFileSync({ yaml: 'storage:\n  endpoint: ...' });
      mockYamlLoad.mockReturnValue({
        storage: { endpoint: 'https://example.com' },
      });
      mockRenameSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      await migrateYamlToJsonIfNeeded();

      expect(console.error).toHaveBeenCalledWith(
        '[ConfigMigration] Migration failed:',
        expect.any(Error),
      );
      // Write should have been called before rename failed
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    });

    it('should not throw — errors are caught gracefully', async () => {
      setupExistsSync({ yaml: true, backup: false });
      mockYamlLoad.mockImplementation(() => {
        throw new Error('Unexpected error');
      });
      setupReadFileSync({ yaml: 'some yaml' });

      // Should resolve without throwing
      await expect(migrateYamlToJsonIfNeeded()).resolves.toBeUndefined();
    });

    it('should catch error when fs.readFileSync fails for YAML', async () => {
      setupExistsSync({ yaml: true, backup: false });
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      await migrateYamlToJsonIfNeeded();

      expect(console.error).toHaveBeenCalledWith(
        '[ConfigMigration] Migration failed:',
        expect.any(Error),
      );
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Path construction
  // -----------------------------------------------------------------------

  describe('path construction', () => {
    it('should use process.cwd() to resolve file paths', async () => {
      const originalCwd = process.cwd;
      process.cwd = jest.fn().mockReturnValue('/custom/working/dir');

      setupExistsSync({ yaml: false });

      await migrateYamlToJsonIfNeeded();

      // existsSync should have been called with a path based on cwd
      expect(mockExistsSync).toHaveBeenCalledWith(
        expect.stringContaining('/custom/working/dir'),
      );

      process.cwd = originalCwd;
    });
  });
});
