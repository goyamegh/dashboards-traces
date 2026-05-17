/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill Parser
 * Parses and validates SKILL.md files and evals/evals.json
 * following the AgentSkills open standard.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import yaml from 'js-yaml';
import type { Skill, SkillMetadata, SkillEvalsFile, SkillEval, SkillValidationResult } from '@/types';

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Parse and validate a skill directory.
 * Reads SKILL.md, extracts YAML frontmatter, validates fields.
 */
export function parseSkill(dirPath: string): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const absolutePath = resolve(dirPath);

  if (!existsSync(absolutePath)) {
    return { valid: false, errors: [`Directory does not exist: ${absolutePath}`], warnings };
  }

  const skillMdPath = join(absolutePath, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    return { valid: false, errors: [`SKILL.md not found in ${absolutePath}`], warnings };
  }

  let content: string;
  try {
    content = readFileSync(skillMdPath, 'utf-8');
  } catch (err) {
    return { valid: false, errors: [`Cannot read SKILL.md: ${err}`], warnings };
  }

  const { frontmatter, body } = extractFrontmatter(content);
  if (!frontmatter) {
    errors.push('SKILL.md must have YAML frontmatter delimited by ---');
    return { valid: false, errors, warnings };
  }

  let parsed: Record<string, any>;
  try {
    parsed = yaml.load(frontmatter) as Record<string, any>;
  } catch (err) {
    errors.push(`Invalid YAML frontmatter: ${err}`);
    return { valid: false, errors, warnings };
  }

  if (!parsed || typeof parsed !== 'object') {
    errors.push('Frontmatter must be a YAML mapping');
    return { valid: false, errors, warnings };
  }

  // Validate required fields
  if (!parsed.name || typeof parsed.name !== 'string') {
    errors.push('Missing required field: name');
  } else {
    if (parsed.name.length > MAX_NAME_LENGTH) {
      errors.push(`name must be ≤${MAX_NAME_LENGTH} characters (got ${parsed.name.length})`);
    }
    if (!KEBAB_CASE_REGEX.test(parsed.name)) {
      errors.push(`name must be lowercase kebab-case (got "${parsed.name}")`);
    }
  }

  if (!parsed.description || typeof parsed.description !== 'string') {
    errors.push('Missing required field: description');
  } else if (parsed.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description must be ≤${MAX_DESCRIPTION_LENGTH} characters (got ${parsed.description.length})`);
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Warnings for best practices
  const instructionTokenEstimate = Math.ceil(body.length / 4);
  if (instructionTokenEstimate > 5000) {
    warnings.push(`Instructions are ~${instructionTokenEstimate} tokens (recommended <5000)`);
  }

  if (!body.trim()) {
    warnings.push('SKILL.md body is empty — no instructions for the agent');
  }

  const metadata: SkillMetadata = {
    name: parsed.name,
    description: parsed.description,
    license: parsed.license,
    compatibility: parsed.compatibility,
    metadata: parsed.metadata,
    allowedTools: parsed['allowed-tools']
      ? String(parsed['allowed-tools']).split(/\s+/)
      : undefined,
  };

  const skill: Skill = {
    metadata,
    instructions: body.trim(),
    path: absolutePath,
  };

  // Try to parse evals
  const evalsFile = parseEvals(absolutePath);
  if (!evalsFile) {
    warnings.push('No evals/evals.json found — skill cannot be evaluated without test cases');
  }

  return { valid: true, skill, evalsFile: evalsFile || undefined, errors, warnings };
}

/**
 * Parse evals/evals.json from a skill directory.
 */
export function parseEvals(dirPath: string): SkillEvalsFile | null {
  const evalsPath = join(dirPath, 'evals', 'evals.json');
  if (!existsSync(evalsPath)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(evalsPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed.skill_name || !Array.isArray(parsed.evals)) {
    return null;
  }

  const evals: SkillEval[] = parsed.evals
    .filter((e: any) => e.prompt && typeof e.prompt === 'string')
    .map((e: any, idx: number) => ({
      id: e.id ?? idx + 1,
      prompt: e.prompt,
      expected_output: e.expected_output || '',
      files: Array.isArray(e.files) ? e.files : undefined,
      assertions: Array.isArray(e.assertions) ? e.assertions : [],
    }));

  return { skill_name: parsed.skill_name, evals };
}

/**
 * Extract YAML frontmatter from markdown content.
 * Frontmatter is delimited by --- at the start of the file.
 */
function extractFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: null, body: content };
  }

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) {
    return { frontmatter: null, body: content };
  }

  const frontmatter = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3);

  return { frontmatter, body };
}
