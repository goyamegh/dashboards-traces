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
 * GET /api/skills/discover
 * Scan common locations for SKILL.md files and return available skills.
 */
router.get('/api/skills/discover', async (_req: Request, res: Response) => {
  const cwd = process.cwd();
  const skills: { path: string; name: string; description: string }[] = [];

  const scanDirs = [
    join(cwd, '.claude', 'skills'),
    join(cwd, 'docs', 'skills'),
    join(cwd, 'skills'),
  ];

  for (const dir of scanDirs) {
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
 * POST /api/skills/validate
 * Validate a skill directory (SKILL.md + optional evals.json)
 */
router.post('/api/skills/validate', async (req: Request, res: Response) => {
  const { path: skillPath } = req.body;

  if (!skillPath || typeof skillPath !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }

  const absolutePath = resolve(skillPath);
  debug('SkillsAPI', 'Validating skill at:', absolutePath);

  const result = parseSkill(absolutePath);
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

  const absolutePath = resolve(skillPath);

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
    const { withSkillGradings, withoutSkillGradings } = loadGradings(iterationDir, evalsFile.evals.length);

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

  const absolutePath = resolve(workspace);
  if (!existsSync(absolutePath)) {
    return res.status(404).json({ error: `Workspace not found: ${absolutePath}` });
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
function loadGradings(iterationDir: string, evalCount: number): {
  withSkillGradings: SkillGradingResult[];
  withoutSkillGradings: SkillGradingResult[];
} {
  const withSkillGradings: SkillGradingResult[] = [];
  const withoutSkillGradings: SkillGradingResult[] = [];

  for (let i = 1; i <= evalCount; i++) {
    const evalDir = join(iterationDir, `eval-${i}`);

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
