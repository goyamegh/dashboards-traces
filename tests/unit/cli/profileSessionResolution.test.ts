/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the `profile` command's session-id resolution, focused on the
 * pi support added alongside the agent-health-profile pi extension: the pi
 * marker file (`.pi/agent-health/current-session`) must be picked up and
 * reported as agent 'pi' so the command can default `--service` to `pi-agent`.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveSessionId } from '@/cli/commands/profileSession';

describe('resolveSessionId (profile command)', () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'profile-resolve-'));
    cwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMarker(rel: string, id: string) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, id);
  }

  it('prefers an explicit --session over everything (agent undefined)', () => {
    writeMarker('.pi/agent-health/current-session', 'pi-1');
    const r = resolveSessionId('explicit-99');
    expect(r).toEqual({ sessionId: 'explicit-99', source: 'flag', agent: undefined });
  });

  it('resolves the pi marker file as agent "pi"', () => {
    writeMarker('.pi/agent-health/current-session', 'pi-sess-1');
    const r = resolveSessionId();
    expect(r.sessionId).toBe('pi-sess-1');
    expect(r.source).toBe('pi-extension');
    expect(r.agent).toBe('pi');
  });

  it('resolves the Claude hook file as agent "claude"', () => {
    writeMarker('.claude/agent-health/current-session', 'cc-sess-1');
    const r = resolveSessionId();
    expect(r.sessionId).toBe('cc-sess-1');
    expect(r.source).toBe('hook');
    expect(r.agent).toBe('claude');
  });

  it('prefers the pi marker over the Claude marker when both exist', () => {
    writeMarker('.pi/agent-health/current-session', 'pi-wins');
    writeMarker('.claude/agent-health/current-session', 'cc-loses');
    const r = resolveSessionId();
    expect(r.sessionId).toBe('pi-wins');
    expect(r.agent).toBe('pi');
  });

  it('returns null/none when nothing is resolvable', () => {
    const r = resolveSessionId();
    expect(r).toEqual({ sessionId: null, source: 'none', agent: undefined });
  });
});
