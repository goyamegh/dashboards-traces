/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for `updateMemoryFile`'s path-containment guard in
 * claudeCodeWorkspace.ts. Covers the legitimate happy path and several
 * traversal / prefix-bypass / symlink-escape attempts that the guard must
 * reject.
 */

const mockWriteFile = jest.fn();
const mockRealpath = jest.fn();

jest.mock('fs/promises', () => ({
  writeFile: (...args: any[]) => mockWriteFile(...args),
  realpath: (...args: any[]) => mockRealpath(...args),
}));

jest.mock('os', () => ({
  homedir: () => '/mock/home',
}));

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

import { updateMemoryFile } from '@/server/services/codingAgents/readers/claudeCodeWorkspace';
import path from 'path';

const PROJECTS_ROOT = '/mock/home/.claude/projects';

describe('updateMemoryFile', () => {
  beforeEach(() => {
    mockWriteFile.mockReset();
    mockWriteFile.mockResolvedValue(undefined);
    mockRealpath.mockReset();
    // Default: realpath is the identity function (no symlinks in play).
    mockRealpath.mockImplementation(async (p: string) => p);
  });

  it('writes a legitimate memory file under <slug>/memory/<file>.md (happy path)', async () => {
    const filePath = `${PROJECTS_ROOT}/my-slug/memory/MEMORY.md`;

    const result = await updateMemoryFile(filePath, '# notes');

    expect(result).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledWith(filePath, '# notes', 'utf-8');
  });

  it('writes a legitimate nested-slug memory file (slug names may contain dashes/dots)', async () => {
    const filePath = `${PROJECTS_ROOT}/-home-user-my.project/memory/context.md`;

    const result = await updateMemoryFile(filePath, 'content');

    expect(result).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledWith(filePath, 'content', 'utf-8');
  });

  it('rejects a sibling-directory prefix-trick path (projectsEVIL shares the "projects" string prefix)', async () => {
    // Regression: the old guard was `resolved.startsWith(claudePath('projects'))`,
    // a bare string-prefix check with no separator boundary, so
    // '/mock/home/.claude/projectsEVIL/...'.startsWith('/mock/home/.claude/projects')
    // was true even though projectsEVIL is a completely different directory.
    const filePath = '/mock/home/.claude/projectsEVIL/memory/pwned.md';

    const result = await updateMemoryFile(filePath, 'pwned');

    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('rejects a "-leaked" sibling directory sharing the projects prefix', async () => {
    const filePath = '/mock/home/.claude/projects-leaked/memory/pwned.md';

    const result = await updateMemoryFile(filePath, 'pwned');

    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('rejects ../ traversal escaping the projects root entirely', async () => {
    const filePath = `${PROJECTS_ROOT}/my-slug/memory/../../../../etc/passwd.md`;

    const result = await updateMemoryFile(filePath, 'pwned');

    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('rejects a path with a "/memory/" substring that is not the real memory segment (extra nesting)', async () => {
    // Old guard only checked resolved.includes('/memory/') anywhere in the
    // string; this has that substring but is not <slug>/memory/<file>.md.
    const filePath = `${PROJECTS_ROOT}/my-slug/notes/memory/nested/pwned.md`;

    const result = await updateMemoryFile(filePath, 'pwned');

    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('rejects a file directly inside the projects root (no slug, no memory segment)', async () => {
    const filePath = `${PROJECTS_ROOT}/pwned.md`;

    const result = await updateMemoryFile(filePath, 'pwned');

    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('rejects the projects root itself', async () => {
    const result = await updateMemoryFile(PROJECTS_ROOT, 'pwned');

    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('rejects a non-.md file under a legitimate slug/memory path', async () => {
    const filePath = `${PROJECTS_ROOT}/my-slug/memory/config.json`;

    const result = await updateMemoryFile(filePath, '{}');

    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('rejects a path with a "memory" segment that is a decoy inside a deeper subtree', async () => {
    const filePath = `${PROJECTS_ROOT}/my-slug/memory/subdir/pwned.md`;

    const result = await updateMemoryFile(filePath, 'pwned');

    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('returns false (not throw) when the underlying writeFile rejects', async () => {
    mockWriteFile.mockRejectedValue(new Error('EACCES'));
    const filePath = `${PROJECTS_ROOT}/my-slug/memory/MEMORY.md`;

    const result = await updateMemoryFile(filePath, 'content');

    expect(result).toBe(false);
  });

  describe('symlink-escape hardening (codex_review finding)', () => {
    it('rejects a write when the memory directory is a symlink that resolves outside the real projects root', async () => {
      // Lexically the path looks fine (<slug>/memory/<file>.md under
      // PROJECTS_ROOT), but `<slug>/memory` is a symlink whose real target
      // is outside the projects tree entirely.
      const filePath = `${PROJECTS_ROOT}/my-slug/memory/pwned.md`;
      mockRealpath.mockImplementation(async (p: string) => {
        if (p === path.dirname(filePath)) {
          return '/mock/home/somewhere-else/attacker-controlled';
        }
        return p;
      });

      const result = await updateMemoryFile(filePath, 'pwned');

      expect(result).toBe(false);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('rejects a write when the projects root itself resolves (via realpath) outside where it lexically appears', async () => {
      const filePath = `${PROJECTS_ROOT}/my-slug/memory/pwned.md`;
      mockRealpath.mockImplementation(async (p: string) => {
        if (p === PROJECTS_ROOT) {
          return '/mock/home/.claude/projects';
        }
        if (p === path.dirname(filePath)) {
          // Real target has escaped one directory level up from where the
          // real projects root resolves to.
          return '/mock/home/.claude/escaped/my-slug/memory';
        }
        return p;
      });

      const result = await updateMemoryFile(filePath, 'pwned');

      expect(result).toBe(false);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('fails closed (rejects) when realpath throws (directory does not exist)', async () => {
      const filePath = `${PROJECTS_ROOT}/my-slug/memory/pwned.md`;
      mockRealpath.mockRejectedValue(new Error('ENOENT'));

      const result = await updateMemoryFile(filePath, 'pwned');

      expect(result).toBe(false);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('still allows a legitimate write when realpath resolves to the identical (non-symlinked) path', async () => {
      const filePath = `${PROJECTS_ROOT}/my-slug/memory/MEMORY.md`;
      // mockRealpath default (identity) already covers this, but assert
      // explicitly so the happy path stays green alongside the new check.
      const result = await updateMemoryFile(filePath, '# notes');

      expect(result).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(filePath, '# notes', 'utf-8');
    });
  });
});
