/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';

import {
  extractIdentifiers,
  getRelevantAgentFiles,
  renderRetrievalMarkdown,
} from '@/server/services/agentPath/retrieve';
import { _resetDiscoveryCacheForTests } from '@/server/services/agentPath/discover';
import type { TrajectoryStep } from '@/types';

function makeTree(structure: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ah-retrieve-test-'));
  for (const [relPath, content] of Object.entries(structure)) {
    const full = join(root, relPath);
    const parts = full.split(sep);
    mkdirSync(parts.slice(0, -1).join(sep), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const traj = (steps: Partial<TrajectoryStep>[]): TrajectoryStep[] =>
  steps.map((s, i) => ({ type: 'action', timestamp: i, ...s } as TrajectoryStep));

describe('agentPath/retrieve', () => {
  beforeEach(() => {
    _resetDiscoveryCacheForTests();
  });

  describe('extractIdentifiers', () => {
    it('extracts trajectory tool names verbatim', () => {
      const ids = extractIdentifiers(
        traj([{ toolName: 'search_logs' }, { toolName: 'getMetrics' }]),
      );
      expect(ids).toContain('search_logs');
      expect(ids).toContain('getMetrics');
    });

    it('extracts backticked identifiers from outcomes', () => {
      const ids = extractIdentifiers(traj([]), [
        'The agent should call `search_logs` with the right index',
      ]);
      expect(ids).toContain('search_logs');
    });

    it('extracts camelCase / snake_case / kebab-case tokens', () => {
      const ids = extractIdentifiers(
        traj([{ content: 'invoked retrieveMetrics and search_logs and my-tool' }]),
      );
      expect(ids).toContain('retrieveMetrics');
      expect(ids).toContain('search_logs');
      expect(ids).toContain('my-tool');
    });

    it('drops English stop words', () => {
      const ids = extractIdentifiers(
        traj([{ content: 'The agent failed because the response was wrong' }]),
      );
      expect(ids).not.toContain('agent');
      expect(ids).not.toContain('response');
      expect(ids).not.toContain('the');
    });

    it('extracts file paths', () => {
      const ids = extractIdentifiers(
        traj([{ content: 'see src/tools/search.ts' }]),
      );
      expect(ids.some(i => i.includes('src/tools/search.ts'))).toBe(true);
    });
  });

  describe('getRelevantAgentFiles', () => {
    it('matches files whose path contains a trajectory tool name', () => {
      const root = makeTree({
        'AGENTS.md': '# x',
        'src/tools/search_logs.ts': 'export function search_logs() { return []; }',
        'src/tools/unrelated.ts': 'export function unrelated() {}',
        'src/search_logs_helpers.ts': 'export const helpers = {};',
      });
      try {
        const result = getRelevantAgentFiles(
          root,
          traj([{ toolName: 'search_logs' }]),
        );
        const matched = result.files.map(f => f.path);
        expect(matched).toContain('src/tools/search_logs.ts');
        expect(matched).toContain('src/search_logs_helpers.ts');
        expect(matched).not.toContain('src/tools/unrelated.ts');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns empty when no identifiers exist', () => {
      const root = makeTree({ 'src/x.ts': 'ok' });
      try {
        const result = getRelevantAgentFiles(root, []);
        expect(result.files).toEqual([]);
        expect(result.identifiers).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns empty when identifiers exist but nothing in tree matches', () => {
      const root = makeTree({ 'src/foo.ts': 'ok' });
      try {
        const result = getRelevantAgentFiles(
          root,
          traj([{ toolName: 'completely_unrelated_tool' }]),
        );
        expect(result.identifiers).toContain('completely_unrelated_tool');
        expect(result.files).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('respects per-file size cap (skips huge files silently)', () => {
      const huge = 'x'.repeat(200_000); // > MAX_FILE_BYTES (50_000)
      const root = makeTree({
        'src/search_logs_big.ts': huge,
        'src/search_logs_small.ts': 'ok',
      });
      try {
        const result = getRelevantAgentFiles(
          root,
          traj([{ toolName: 'search_logs' }]),
        );
        const paths = result.files.map(f => f.path);
        expect(paths).toContain('src/search_logs_small.ts');
        expect(paths).not.toContain('src/search_logs_big.ts');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('renderRetrievalMarkdown', () => {
    it('returns empty when no files matched', () => {
      expect(
        renderRetrievalMarkdown({ files: [], identifiers: ['x'], truncated: false }),
      ).toBe('');
    });

    it('produces a markdown block with file contents', () => {
      const md = renderRetrievalMarkdown({
        files: [{ path: 'src/foo.ts', content: 'export const x = 1;' }],
        identifiers: ['foo'],
        truncated: false,
      });
      expect(md).toContain('### Files matched to trajectory identifiers');
      expect(md).toContain('#### src/foo.ts');
      expect(md).toContain('export const x = 1;');
    });
  });
});
