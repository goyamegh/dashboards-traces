/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';

import {
  gatherAgentFiles,
  isGatherEnabled,
  renderGatherMarkdown,
  _resetDefaultInvokerForTests,
} from '@/server/services/agentPath/gather';
import { _resetDiscoveryCacheForTests } from '@/server/services/agentPath/discover';
import type { TrajectoryStep } from '@/types';

function makeTree(structure: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ah-gather-test-'));
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

describe('agentPath/gather', () => {
  beforeEach(() => {
    _resetDiscoveryCacheForTests();
    _resetDefaultInvokerForTests();
    delete process.env.AH_AGENT_GATHER;
  });

  describe('isGatherEnabled', () => {
    it('defaults to enabled', () => {
      expect(isGatherEnabled()).toBe(true);
    });

    it('returns false when AH_AGENT_GATHER=off', () => {
      process.env.AH_AGENT_GATHER = 'off';
      expect(isGatherEnabled()).toBe(false);
    });

    it.each(['false', 'FALSE', '0', 'OFF'])(
      'accepts case-insensitive disable values: %s',
      (val) => {
        process.env.AH_AGENT_GATHER = val;
        expect(isGatherEnabled()).toBe(false);
      },
    );

    it('treats other values as enabled', () => {
      process.env.AH_AGENT_GATHER = 'on';
      expect(isGatherEnabled()).toBe(true);
    });
  });

  describe('gatherAgentFiles', () => {
    it('skips when AH_AGENT_GATHER=off', async () => {
      process.env.AH_AGENT_GATHER = 'off';
      const root = makeTree({ 'src/x.ts': 'ok' });
      try {
        const r = await gatherAgentFiles({
          rootPath: root,
          trajectory: traj([{ toolName: 'foo' }]),
          modelId: 'm',
          phase2FileCount: 0,
          invoker: jest.fn(),
        });
        expect(r.ran).toBe(false);
        expect(r.files).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('skips when phase2FileCount >= threshold', async () => {
      const root = makeTree({ 'src/x.ts': 'ok' });
      try {
        const invoker = jest.fn();
        const r = await gatherAgentFiles({
          rootPath: root,
          trajectory: traj([{ toolName: 'foo' }]),
          modelId: 'm',
          phase2FileCount: 5, // well above threshold
          invoker,
        });
        expect(r.ran).toBe(false);
        expect(invoker).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('reads files the invoker selects', async () => {
      const root = makeTree({
        'AGENTS.md': '# x',
        'src/keep.ts': 'export const a = 1;',
        'src/skip.ts': 'export const b = 2;',
      });
      try {
        const invoker = jest.fn().mockResolvedValue(
          JSON.stringify({ files: ['src/keep.ts'] }),
        );
        const r = await gatherAgentFiles({
          rootPath: root,
          trajectory: traj([{ toolName: 'foo' }]),
          modelId: 'm',
          phase2FileCount: 0,
          invoker,
        });
        expect(r.ran).toBe(true);
        expect(r.files.map(f => f.path)).toEqual(['src/keep.ts']);
        expect(r.files[0].content).toContain('export const a = 1;');
        expect(invoker).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('rejects paths not in the tree (model hallucination guard)', async () => {
      const root = makeTree({ 'src/real.ts': 'ok' });
      try {
        const invoker = jest.fn().mockResolvedValue(
          JSON.stringify({ files: ['src/fabricated.ts'] }),
        );
        const r = await gatherAgentFiles({
          rootPath: root,
          trajectory: traj([{ toolName: 'foo' }]),
          modelId: 'm',
          phase2FileCount: 0,
          invoker,
        });
        expect(r.ran).toBe(true);
        expect(r.files).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('tolerates fenced JSON output', async () => {
      const root = makeTree({ 'src/foo.ts': 'ok' });
      try {
        const invoker = jest.fn().mockResolvedValue(
          '```json\n{"files":["src/foo.ts"]}\n```',
        );
        const r = await gatherAgentFiles({
          rootPath: root,
          trajectory: traj([{ toolName: 'foo' }]),
          modelId: 'm',
          phase2FileCount: 0,
          invoker,
        });
        expect(r.files.map(f => f.path)).toEqual(['src/foo.ts']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns errorReason when invoker throws', async () => {
      const root = makeTree({ 'src/foo.ts': 'ok' });
      try {
        const invoker = jest.fn().mockRejectedValue(new Error('boom'));
        const r = await gatherAgentFiles({
          rootPath: root,
          trajectory: traj([{ toolName: 'foo' }]),
          modelId: 'm',
          phase2FileCount: 0,
          invoker,
        });
        expect(r.ran).toBe(true);
        expect(r.files).toEqual([]);
        expect(r.errorReason).toContain('boom');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns ran=true with empty files when JSON is malformed', async () => {
      const root = makeTree({ 'src/foo.ts': 'ok' });
      try {
        const invoker = jest.fn().mockResolvedValue('not json');
        const r = await gatherAgentFiles({
          rootPath: root,
          trajectory: traj([{ toolName: 'foo' }]),
          modelId: 'm',
          phase2FileCount: 0,
          invoker,
        });
        expect(r.ran).toBe(true);
        expect(r.files).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('renderGatherMarkdown', () => {
    it('returns empty when no files', () => {
      expect(renderGatherMarkdown({ files: [], ran: true })).toBe('');
    });

    it('produces a markdown block', () => {
      const md = renderGatherMarkdown({
        files: [{ path: 'src/foo.ts', content: 'ok' }],
        ran: true,
      });
      expect(md).toContain('### Additional files selected by gatherer');
      expect(md).toContain('#### src/foo.ts');
    });
  });
});
