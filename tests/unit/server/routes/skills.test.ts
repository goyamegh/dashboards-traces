/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for server/routes/skills.ts path resolution.
 *
 * Regression: GET /api/skills/discover returns user-scope skills
 * (~/.claude/skills) with a `~/`-prefixed display path, but
 * POST /api/skills/validate resolved every path against cwd — so selecting
 * any user-scope skill in the Skills page failed validation with
 * "Directory does not exist: <cwd>/~/.claude/skills/...".
 */

import { resolve } from 'path';
import { homedir } from 'os';
import { resolveSkillPath } from '@/server/routes/skills';

describe('resolveSkillPath', () => {
  it('expands ~/ to the user home directory (discover returns ~/ paths for user-scope skills)', () => {
    expect(resolveSkillPath('~/.claude/skills/my-skill')).toBe(
      resolve(homedir(), '.claude/skills/my-skill')
    );
  });

  it('expands a bare ~ to the home directory itself', () => {
    expect(resolveSkillPath('~')).toBe(resolve(homedir()));
  });

  it('does NOT expand ~ in the middle of a path or a ~-prefixed filename', () => {
    // `~foo` is a legitimate relative directory name, not a home reference.
    expect(resolveSkillPath('~backup/skill')).toBe(resolve(process.cwd(), '~backup/skill'));
    expect(resolveSkillPath('skills/~archived')).toBe(resolve(process.cwd(), 'skills/~archived'));
  });

  it('resolves relative paths against cwd', () => {
    expect(resolveSkillPath('.claude/skills/add-connector')).toBe(
      resolve(process.cwd(), '.claude/skills/add-connector')
    );
  });

  it('passes absolute paths through unchanged', () => {
    expect(resolveSkillPath('/tmp/some-skill')).toBe('/tmp/some-skill');
  });
});
