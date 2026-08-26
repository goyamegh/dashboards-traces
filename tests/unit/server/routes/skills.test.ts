/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for resolveSkillPath (server/routes/skills.ts).
 *
 * Regression: /api/skills/discover returns user-scope skills with a `~/`
 * display prefix (e.g. `~/.claude/skills/foo`), but resolveSkillPath resolved
 * that literally against cwd — producing `<cwd>/~/.claude/skills/foo` — so
 * validating (and therefore evaluating) any user-scope skill always failed
 * with "Directory does not exist".
 */

import { resolveSkillPath } from '@/server/routes/skills';
import { homedir } from 'os';
import { join, resolve } from 'path';

describe('resolveSkillPath', () => {
  it('expands ~/ against the home directory', () => {
    expect(resolveSkillPath('~/.claude/skills/foo')).toBe(
      join(homedir(), '.claude', 'skills', 'foo')
    );
  });

  it('expands a bare ~ to the home directory', () => {
    expect(resolveSkillPath('~')).toBe(homedir());
  });

  it('does NOT expand ~user-style prefixes (resolved against cwd like any relative path)', () => {
    expect(resolveSkillPath('~other/skills')).toBe(resolve(process.cwd(), '~other/skills'));
  });

  it('resolves relative paths against cwd', () => {
    expect(resolveSkillPath('.claude/skills/foo')).toBe(
      resolve(process.cwd(), '.claude/skills/foo')
    );
  });

  it('passes absolute paths through', () => {
    expect(resolveSkillPath('/abs/skills/foo')).toBe('/abs/skills/foo');
  });
});
