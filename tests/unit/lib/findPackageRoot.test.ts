/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { findPackageRootFrom } from '@/lib/findPackageRoot';

/**
 * These tests build small synthetic directory layouts under os.tmpdir()
 * and assert that findPackageRootFrom() returns the right anchor regardless
 * of where the walk starts. They do NOT chdir() — the resolver is supposed
 * to be CWD-independent.
 */

function makeLayout(structure: Record<string, string | null>): string {
  const root = mkdtempSync(join(tmpdir(), 'ah-pkg-test-'));
  for (const [relPath, content] of Object.entries(structure)) {
    const full = join(root, relPath);
    if (content === null) {
      mkdirSync(full, { recursive: true });
    } else {
      mkdirSync(full.split(sep).slice(0, -1).join(sep), { recursive: true });
      writeFileSync(full, content);
    }
  }
  return root;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe('lib/findPackageRoot', () => {
  describe('findPackageRootFrom', () => {
    it('finds the package root when starting from a deep nested file', () => {
      const root = makeLayout({
        'package.json': JSON.stringify({ name: '@opensearch-project/agent-health' }),
        'server/dist/index.js': '// bundled',
      });
      try {
        expect(findPackageRootFrom(join(root, 'server', 'dist'))).toBe(root);
      } finally {
        cleanup(root);
      }
    });

    it('returns the same root when starting from the root itself', () => {
      const root = makeLayout({
        'package.json': JSON.stringify({ name: '@opensearch-project/agent-health' }),
      });
      try {
        expect(findPackageRootFrom(root)).toBe(root);
      } finally {
        cleanup(root);
      }
    });

    it('skips a parent monorepo package.json and prefers the agent-health one', () => {
      // Layout:
      //   /tmp/xxx/                 ← parent "monorepo" package.json
      //     package.json (name: my-monorepo)
      //     packages/agent-health/  ← our package
      //       package.json (name: @opensearch-project/agent-health)
      //       server/dist/index.js
      const root = makeLayout({
        'package.json': JSON.stringify({ name: 'my-monorepo' }),
        'packages/agent-health/package.json': JSON.stringify({
          name: '@opensearch-project/agent-health',
        }),
        'packages/agent-health/server/dist/index.js': '// bundled',
      });
      try {
        const start = join(root, 'packages', 'agent-health', 'server', 'dist');
        expect(findPackageRootFrom(start)).toBe(
          join(root, 'packages', 'agent-health'),
        );
      } finally {
        cleanup(root);
      }
    });

    it('falls back to the nearest package.json when no name match is found (forks)', () => {
      const root = makeLayout({
        'package.json': JSON.stringify({ name: 'my-forked-agent-health' }),
        'server/dist/index.js': '// bundled',
      });
      try {
        expect(findPackageRootFrom(join(root, 'server', 'dist'))).toBe(root);
      } finally {
        cleanup(root);
      }
    });

    it('handles unparseable package.json gracefully and keeps walking', () => {
      // Layout: child has a corrupt package.json, parent has the canonical one.
      const root = makeLayout({
        'package.json': JSON.stringify({ name: '@opensearch-project/agent-health' }),
        'sub/package.json': '{ this is not json',
        'sub/file.ts': '// nested',
      });
      try {
        expect(findPackageRootFrom(join(root, 'sub'))).toBe(root);
      } finally {
        cleanup(root);
      }
    });

    it('throws when no package.json exists within maxLevels', () => {
      const root = makeLayout({
        'a/b/c/file.ts': '// no package.json anywhere',
      });
      try {
        expect(() =>
          findPackageRootFrom(join(root, 'a', 'b', 'c'), 1),
        ).toThrow(/Could not locate package root/);
      } finally {
        cleanup(root);
      }
    });

    it('respects the maxLevels cap', () => {
      // package.json sits 4 levels above the start dir; cap at 2 should fail.
      const root = makeLayout({
        'package.json': JSON.stringify({ name: '@opensearch-project/agent-health' }),
        'a/b/c/d/file.ts': '// deep',
      });
      try {
        expect(() =>
          findPackageRootFrom(join(root, 'a', 'b', 'c', 'd'), 2),
        ).toThrow(/Could not locate package root/);
      } finally {
        cleanup(root);
      }
    });

    it('is CWD-independent (process.cwd does not affect the result)', () => {
      const root = makeLayout({
        'package.json': JSON.stringify({ name: '@opensearch-project/agent-health' }),
        'server/dist/index.js': '// bundled',
      });
      const originalCwd = process.cwd();
      try {
        // Change cwd to somewhere unrelated; resolver should still find root.
        process.chdir(tmpdir());
        expect(findPackageRootFrom(join(root, 'server', 'dist'))).toBe(root);
      } finally {
        process.chdir(originalCwd);
        cleanup(root);
      }
    });
  });
});
