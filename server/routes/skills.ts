/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skills Routes - Evaluate and improve AgentSkills
 */

import { Router, Request, Response } from 'express';
import { resolve } from 'path';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { platform } from 'os';
import { debug } from '@/lib/debug';
import { loadConfigSync } from '@/lib/config/index';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { parseSkill } from '@/services/skills/parser';
import { runSkillEval } from '@/services/skills/runner';
import { proposeImprovement } from '@/services/skills/improver';
import { generateEvals } from '@/services/skills/evalGenerator';
import { connectorRegistry } from '@/services/connectors/server';
import type { SkillEvalProgressEvent, SkillBenchmarkResult, SkillGradingResult } from '@/types';

const router = Router();

/**
 * Validate that a resolved path is within the current working directory.
 * Prevents path traversal attacks by rejecting absolute paths or paths
 * that escape the workspace root.
 */
function validatePathWithinCwd(inputPath: string): { valid: boolean; absolutePath: string; error?: string } {
  const cwd = process.cwd();
  const absolutePath = resolve(cwd, inputPath);

  // Ensure the resolved path is within cwd (no parent traversal)
  if (!absolutePath.startsWith(cwd + '/') && absolutePath !== cwd) {
    return { valid: false, absolutePath, error: `Path must be within the workspace: ${cwd}` };
  }

  return { valid: true, absolutePath };
}

/** Managed workspace root for skill evaluation results */
const SKILL_EVALS_ROOT = resolve(process.cwd(), 'agent-health-data', 'skill-evals');

/**
 * GET /api/skills/discover
 * Scan common locations for SKILL.md files and return available skills.
 */
router.get('/api/skills/discover', async (_req: Request, res: Response) => {
  const cwd = process.cwd();
  const skills: { path: string; name: string; description: string; source: string }[] = [];

  const scanDirs: { dir: string; source: string }[] = [
    { dir: join(cwd, '.claude', 'skills'), source: 'Claude Code' },
    { dir: join(cwd, '.kiro', 'skills'), source: 'Kiro' },
    { dir: join(cwd, '.kiro', 'steering'), source: 'Kiro' },
    { dir: join(cwd, '.codex'), source: 'Codex' },
    { dir: join(cwd, '.cursor', 'rules'), source: 'Cursor' },
    { dir: join(cwd, '.github', 'copilot'), source: 'Copilot' },
    { dir: join(cwd, '.continue', 'skills'), source: 'Continue' },
    { dir: join(cwd, 'skills'), source: 'Project' },
  ];

  for (const { dir, source } of scanDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(dir, entry.name);
        const skillMd = join(skillDir, 'SKILL.md');
        if (!existsSync(skillMd)) continue;

        const result = parseSkill(skillDir);
        if (result.valid && result.skill) {
          const relativePath = skillDir.startsWith(cwd)
            ? skillDir.slice(cwd.length + 1)
            : skillDir;
          skills.push({
            path: relativePath,
            name: result.skill.metadata.name,
            description: result.skill.metadata.description,
            source,
          });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  res.json({ skills });
});

/**
 * POST /api/skills/browse
 * Open native OS folder picker dialog and return the selected path.
 */
router.post('/api/skills/browse', async (_req: Request, res: Response) => {
  try {
    let selectedPath: string | null = null;

    if (platform() === 'darwin') {
      const result = execSync(
        `osascript -e 'POSIX path of (choose folder with prompt "Select a skill folder")'`,
        { encoding: 'utf-8', timeout: 60000 }
      ).trim();
      if (result) selectedPath = result.replace(/\/$/, '');
    } else if (platform() === 'linux') {
      const result = execSync(
        `zenity --file-selection --directory --title="Select a skill folder" 2>/dev/null || kdialog --getexistingdirectory ~ 2>/dev/null`,
        { encoding: 'utf-8', timeout: 60000 }
      ).trim();
      if (result) selectedPath = result;
    } else {
      // Windows - PowerShell folder browser
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select a skill folder'; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }`;
      const result = execSync(`powershell -Command "${ps}"`, { encoding: 'utf-8', timeout: 60000 }).trim();
      if (result) selectedPath = result;
    }

    if (!selectedPath) {
      return res.json({ cancelled: true, path: null });
    }

    res.json({ cancelled: false, path: selectedPath });
  } catch (err: any) {
    if (err.status === 1 || err.message?.includes('User canceled')) {
      return res.json({ cancelled: true, path: null });
    }
    res.status(500).json({ error: `Failed to open folder picker: ${err.message}` });
  }
});

/**
 * POST /api/skills/validate
 * Validate a skill directory (SKILL.md + optional evals.json)
 */
router.post('/api/skills/validate', async (req: Request, res: Response) => {
  const { path: skillPath } = req.body;

  if (!skillPath || typeof skillPath !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }

  const pathCheck = validatePathWithinCwd(skillPath);
  if (!pathCheck.valid) {
    return res.status(400).json({ error: pathCheck.error });
  }

  debug('SkillsAPI', 'Validating skill at:', pathCheck.absolutePath);

  const result = parseSkill(pathCheck.absolutePath);
  res.json(result);
});

/**
 * POST /api/skills/eval
 * Run full skill evaluation + improvement cycle. Streams progress via SSE.
 *
 * Body: {
 *   path: string,
 *   agentKey?: string,
 *   modelId?: string,
 *   auto?: boolean       // Auto-apply improvements without confirmation
 * }
 *
 * SSE events: started → eval_running → eval_grading → eval_done → improvement → completed
 */
router.post('/api/skills/eval', async (req: Request, res: Response) => {
  const { path: skillPath, agentKey, modelId, auto } = req.body;

  if (!skillPath || typeof skillPath !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }

  const pathCheck = validatePathWithinCwd(skillPath);
  if (!pathCheck.valid) {
    return res.status(400).json({ error: pathCheck.error });
  }
  const absolutePath = pathCheck.absolutePath;

  // Validate skill
  const validation = parseSkill(absolutePath);
  if (!validation.valid || !validation.skill) {
    return res.status(400).json({ error: 'Invalid skill', details: validation.errors });
  }

  // Resolve agent
  const config = loadConfigSync();
  const allAgents = [...config.agents, ...getCustomAgents()];

  let agent;
  if (agentKey) {
    agent = allAgents.find(a => a.key === agentKey || a.name.toLowerCase() === agentKey.toLowerCase());
    if (!agent) {
      return res.status(400).json({ error: `Agent not found: ${agentKey}` });
    }
  } else {
    agent = allAgents.find(a => a.connectorType === 'claude-code') || allAgents[0];
  }

  if (!agent) {
    return res.status(400).json({ error: 'No agents configured' });
  }

  // Resolve model — skip mock/demo models, resolve to Bedrock model_id
  const modelKey = modelId || Object.keys(config.models).find(
    k => !config.models[k].model_id.startsWith('mock://')
  ) || 'claude-sonnet';
  const effectiveModelId = config.models[modelKey]?.model_id || modelKey;

  // Determine server base URL for judge/generation calls
  const port = req.socket.localPort || 4001;
  const serverBaseUrl = `http://localhost:${port}`;

  // Generate evals if none exist
  let evalsFile = validation.evalsFile;
  if (!evalsFile || evalsFile.evals.length === 0) {
    debug('SkillsAPI', 'No evals found, generating...');

    // Can't use SSE yet for the generation step — return error asking to retry
    // Actually, let's generate inline and continue
    try {
      evalsFile = await generateEvals(validation.skill, serverBaseUrl, effectiveModelId);
    } catch (err) {
      return res.status(500).json({
        error: 'Failed to generate eval cases',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Determine workspace and iteration
  const workspacePath = resolve('agent-health-data', 'skill-evals', validation.skill.metadata.name);
  const iteration = getNextIteration(workspacePath);

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: SkillEvalProgressEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    // Step 1: Run A/B evaluation
    const benchmark = await runSkillEval({
      skill: validation.skill,
      evals: evalsFile,
      agent,
      modelId: effectiveModelId,
      workspacePath,
      iteration,
      registry: connectorRegistry,
      serverBaseUrl,
      onProgress: sendEvent,
    });

    // Step 2: Propose improvement (if there are failures)
    const iterationDir = join(workspacePath, `iteration-${iteration}`);
    const { withSkillGradings, withoutSkillGradings } = loadGradings(iterationDir, evalsFile.evals.map(e => e.id));

    const hasFailures = withSkillGradings.some(g => g.summary.pass_rate < 1);

    if (hasFailures) {
      sendEvent({ type: 'improving', message: 'Analyzing failures and proposing improvements...' });

      const proposal = await proposeImprovement({
        skill: validation.skill,
        withSkillGradings,
        withoutSkillGradings,
        benchmark,
        serverBaseUrl,
        modelId: effectiveModelId,
      });

      // Write proposal to workspace
      writeFileSync(
        join(iterationDir, 'improvement-proposal.json'),
        JSON.stringify(proposal, null, 2)
      );

      if (auto && proposal.improvedInstructions !== proposal.originalInstructions) {
        // Auto-apply: write improved SKILL.md
        const skillMdPath = join(absolutePath, 'SKILL.md');
        const original = readFileSync(skillMdPath, 'utf-8');
        const updated = original.replace(proposal.originalInstructions, proposal.improvedInstructions);
        writeFileSync(skillMdPath, updated);

        sendEvent({
          type: 'improved',
          applied: true,
          changes: proposal.changesDescription,
          reasoning: proposal.reasoning,
        });
      } else {
        sendEvent({
          type: 'improved',
          applied: false,
          changes: proposal.changesDescription,
          reasoning: proposal.reasoning,
          improvedInstructions: proposal.improvedInstructions,
        });
      }
    }

    sendEvent({ type: 'completed', benchmark });
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendEvent({ type: 'error', message });
    res.end();
  }
});

/**
 * GET /api/skills/results
 * Read benchmark results from a workspace directory.
 */
router.get('/api/skills/results', async (req: Request, res: Response) => {
  const workspace = req.query.workspace as string;

  if (!workspace) {
    return res.status(400).json({ error: 'workspace query parameter is required' });
  }

  // Constrain results to the managed skill-evals root
  const absolutePath = resolve(SKILL_EVALS_ROOT, workspace);
  if (!absolutePath.startsWith(SKILL_EVALS_ROOT + '/') && absolutePath !== SKILL_EVALS_ROOT) {
    return res.status(400).json({ error: 'workspace must be a skill name within the managed skill-evals directory' });
  }
  if (!existsSync(absolutePath)) {
    return res.status(404).json({ error: `Workspace not found: ${workspace}` });
  }

  const iterations: SkillBenchmarkResult[] = [];

  try {
    const entries = readdirSync(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('iteration-')) {
        const benchmarkPath = resolve(absolutePath, entry.name, 'benchmark.json');
        if (existsSync(benchmarkPath)) {
          const data = JSON.parse(readFileSync(benchmarkPath, 'utf-8'));
          iterations.push(data);
        }
      }
    }
  } catch (err) {
    return res.status(500).json({ error: `Failed to read workspace: ${err}` });
  }

  iterations.sort((a, b) => a.iteration - b.iteration);
  res.json({ iterations });
});

/**
 * Load grading results from an iteration directory.
 */
function loadGradings(iterationDir: string, evalIds: (string | number)[]): {
  withSkillGradings: SkillGradingResult[];
  withoutSkillGradings: SkillGradingResult[];
} {
  const withSkillGradings: SkillGradingResult[] = [];
  const withoutSkillGradings: SkillGradingResult[] = [];

  for (const id of evalIds) {
    const evalDir = join(iterationDir, `eval-${id}`);

    const withPath = join(evalDir, 'with_skill', 'grading.json');
    if (existsSync(withPath)) {
      withSkillGradings.push(JSON.parse(readFileSync(withPath, 'utf-8')));
    }

    const withoutPath = join(evalDir, 'without_skill', 'grading.json');
    if (existsSync(withoutPath)) {
      withoutSkillGradings.push(JSON.parse(readFileSync(withoutPath, 'utf-8')));
    }
  }

  return { withSkillGradings, withoutSkillGradings };
}

/**
 * Determine the next iteration number for a workspace.
 */
function getNextIteration(workspacePath: string): number {
  if (!existsSync(workspacePath)) return 1;

  try {
    const entries = readdirSync(workspacePath);
    const iterations = entries
      .filter(e => e.startsWith('iteration-'))
      .map(e => parseInt(e.replace('iteration-', ''), 10))
      .filter(n => !isNaN(n));

    return iterations.length > 0 ? Math.max(...iterations) + 1 : 1;
  } catch {
    return 1;
  }
}

export default router;
