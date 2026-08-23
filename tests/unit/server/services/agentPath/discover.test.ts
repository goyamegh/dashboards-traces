/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';

import {
  discoverAgentPath,
  renderDiscoveryMarkdown,
  _resetDiscoveryCacheForTests,
} from '@/server/services/agentPath/discover';

function makeTree(structure: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ah-discover-test-'));
  for (const [relPath, content] of Object.entries(structure)) {
    const full = join(root, relPath);
    const parts = full.split(sep);
    mkdirSync(parts.slice(0, -1).join(sep), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe('agentPath/discover', () => {
  let root: string;

  beforeEach(() => {
    _resetDiscoveryCacheForTests();
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  describe('discoverAgentPath', () => {
    it('reads marker files and walks the tree', () => {
      root = makeTree({
        'AGENTS.md': '# My agent\nDoes things.',
        'README.md': '# Project',
        'package.json': '{"name":"my-agent","version":"1.0.0"}',
        'src/main.ts': 'export const x = 1;',
        'src/tools/search.ts': 'export function search() {}',
      });

      const d = discoverAgentPath(root);

      expect(d.rootPath).toBe(root);
      expect(d.markers['AGENTS.md']).toContain('My agent');
      expect(d.markers['README.md']).toContain('Project');
      expect(d.markers['package.json']).toContain('"name":"my-agent"');
      expect(d.markersTotalBytes).toBeGreaterThan(0);
      expect(d.markersTruncated).toBe(false);

      const paths = d.tree.map(t => t.path);
      expect(paths).toContain('AGENTS.md');
      expect(paths).toContain('README.md');
      expect(paths).toContain('src/');
      expect(paths).toContain('src/main.ts');
      expect(paths).toContain('src/tools/search.ts');
    });

    it('skips well-known ignored directories (node_modules, .git, dist, etc.)', () => {
      root = makeTree({
        'AGENTS.md': '# x',
        'node_modules/foo/index.js': '// dep',
        '.git/HEAD': 'ref: refs/heads/main',
        'dist/bundle.js': '// built',
        '__pycache__/foo.pyc': 'binary',
        'src/keep.ts': '// real source',
      });

      const d = discoverAgentPath(root);
      const paths = d.tree.map(t => t.path);

      expect(paths.some(p => p.startsWith('node_modules/'))).toBe(false);
      expect(paths.some(p => p.startsWith('.git'))).toBe(false);
      expect(paths.some(p => p.startsWith('dist/'))).toBe(false);
      expect(paths.some(p => p.startsWith('__pycache__/'))).toBe(false);
      expect(paths).toContain('src/keep.ts');
    });

    it('skips well-known binary file extensions', () => {
      root = makeTree({
        'AGENTS.md': '# x',
        'src/code.ts': 'ok',
        'assets/photo.png': 'binary',
        'logs/run.log': 'lines',
        'package-lock.json.lock': 'noise',
        'bundle.min.js': '// minified',
      });
      const paths = discoverAgentPath(root).tree.map(t => t.path);
      expect(paths).toContain('src/code.ts');
      expect(paths.some(p => p.endsWith('.png'))).toBe(false);
      expect(paths.some(p => p.endsWith('.log'))).toBe(false);
      expect(paths.some(p => p.endsWith('.lock'))).toBe(false);
      expect(paths.some(p => p.endsWith('.min.js'))).toBe(false);
    });

    it('caches discovery per root path', () => {
      root = makeTree({ 'README.md': 'hi' });
      const a = discoverAgentPath(root);
      const b = discoverAgentPath(root);
      expect(a).toBe(b); // identity, not just deep equality
    });

    it('returns gracefully on unreadable directory', () => {
      // Use a bogus path; should not throw, just return empty.
      const d = discoverAgentPath('/tmp/__definitely_not_a_real_path__/abc');
      expect(d.tree).toEqual([]);
      expect(d.markers).toEqual({});
    });
  });

  describe('renderDiscoveryMarkdown', () => {
    it('returns empty string when discovery is empty', () => {
      const empty = {
        rootPath: '/x',
        tree: [],
        treeTruncated: false,
        markers: {},
        markersTruncated: false,
        markersTotalBytes: 0,
      };
      expect(renderDiscoveryMarkdown(empty)).toBe('');
    });

    it('produces a markdown block with marker files and file tree', () => {
      root = makeTree({
        'AGENTS.md': '# Hi',
        'src/x.ts': 'ok',
      });
      const md = renderDiscoveryMarkdown(discoverAgentPath(root));
      expect(md).toContain('### Repository overview');
      expect(md).toContain('### Marker files');
      expect(md).toContain('#### AGENTS.md');
      expect(md).toContain('### File tree');
      expect(md).toContain('src/x.ts');
    });
  });
});
