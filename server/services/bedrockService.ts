/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bedrock Service - LLM Judge evaluation using AWS Bedrock
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import config from '../config';
import { TrajectoryStep, ImprovementStrategy, Evaluator, EvaluationMetrics } from '@/types';
import { debug } from '@/lib/debug';
import { getDefaultEvaluator } from '@/server/prompts/evaluatorTemplates';
import { AGENT_PATH_SYSTEM_ADDENDUM } from '@/server/prompts/judgePrompt';
import { parseJudgeResponse } from '@/server/services/judgeResponseParser';
import { buildJudgeDebug } from '@/server/services/judgeDebug';
import { getAgentSourceForPrompt, isAgentPathConfigured } from '@/server/services/agentPath';

// ============================================================================
// Types
// ============================================================================

export interface JudgeRequest {
  trajectory: TrajectoryStep[];
  expectedOutcomes?: string[];
  expectedTrajectory?: any[];
  logs?: any[];
  /**
   * Agent run id for trace/log correlation. Forwarded by the SDK `judge()`
   * from `result.runId`. Required by the agentic trace judge so its
   * read-only trace-query tools can be scoped to this single run (RFC 004
   * §4.4, #244).
   */
  runId?: string;
  /**
   * Bedrock/registry model id the run is configured to judge with. Used by the
   * agent trace judge to select the matching in-process pi model.
   */
  modelId?: string;
  /**
   * Optional time-window/service-name correlation hints for the agent
   * (trace) judge. Pre-fix `traceJudgeTools` queried `/api/traces` with
   * just `runIds: [runId]` (Strategy B), which only matches spans the
   * agent emits with `gen_ai.request.id = runId` — i.e. agent-health's
   * own eval-emitter spans, NOT the subprocess agent's instrumentation.
   * Forwarding `agents` lets the tool union Strategy C (service.name +
   * time-window) so claude-code's emitted spans are findable. See #264.
   */
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number }>;
}

export interface JudgeResponse {
  passFailStatus: 'passed' | 'failed';
  metrics: EvaluationMetrics;
  llmJudgeReasoning: string;
  improvementStrategies: ImprovementStrategy[];
  duration: number;
  /**
   * Raw judge text exactly as the model returned it (pre-JSON-parse,
   * pre-trimming). Captured by every provider so the run-detail UI's
   * "Judge debug" surface can show what the model actually emitted vs. what
   * we coerced into typed fields. Optional for back-compat with reports
   * persisted before this field existed.
   */
  rawResponse?: string;
  /**
   * Any JSON keys the judge emitted that did NOT map onto a typed field
   * (`pass_fail_status` / `reasoning` / `metrics` / `improvement_strategies`)
   * or onto an evaluator-declared metric. This is the escape hatch that lets
   * users iterate on the judge prompt — asking for a new field like
   * `failure_tags` or `confidence` — without a code change. Empty/undefined
   * when the model only emitted typed fields.
   */
  extraFields?: Record<string, unknown>;
  /**
   * Optional debug breadcrumbs the routing/persistence layer can use to
   * answer "did my saved prompt actually reach the model?". Set by services
   * when `AH_JUDGE_DEBUG=1` or `NODE_ENV=development`; otherwise omitted to
   * keep persisted run docs lean (system prompts can be 10–20 KB).
   */
  judgeDebug?: {
    provider?: string;
    modelId?: string;
    evaluatorId?: string;
    systemPrompt?: string;
    userPrompt?: string;
  };
}

// ============================================================================
// Bedrock Client Initialization
// ============================================================================

const bedrockClient = new BedrockRuntimeClient({
  region: config.AWS_REGION,
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Truncate large strings to reduce token count
 */
export function truncateString(str: string | undefined | null, maxLength: number = 1000): string {
  if (!str || str.length <= maxLength) return str || '';
  return str.substring(0, maxLength) + `... [truncated ${str.length - maxLength} chars]`;
}

/**
 * Reduce trajectory size by truncating large tool outputs
 */
export function compactTrajectory(trajectory: TrajectoryStep[]): TrajectoryStep[] {
  return trajectory.map(step => {
    const compacted = { ...step };

    // Truncate large content fields
    if (compacted.content && typeof compacted.content === 'string') {
      compacted.content = truncateString(compacted.content, 500);
    }

    // Truncate large tool outputs
    if (compacted.toolOutput) {
      if (typeof compacted.toolOutput === 'string') {
        compacted.toolOutput = truncateString(compacted.toolOutput, 1000);
      } else if (typeof compacted.toolOutput === 'object') {
        compacted.toolOutput = truncateString(JSON.stringify(compacted.toolOutput), 1000);
      }
    }

    return compacted;
  });
}

/**
 * Build the evaluation prompt for the LLM judge.
 *
 * If `agentSource` is non-null/non-empty, it is appended as an
 * `## Agent Source` section so the judge can ground its reasoning in the
 * user's actual agent codebase. Callers compute this asynchronously via
 * `getAgentSourceForPrompt()` (which runs all three agent-path phases) and
 * pass it in here; this function stays sync for use in tests and any
 * caller that doesn't want agent-path injection.
 */
export function buildEvaluationPrompt(
  trajectory: TrajectoryStep[],
  expectedOutcomes?: string[],
  expectedTrajectory?: any[],
  logs?: any[],
  agentSource?: string | null,
): string {
  // Compact trajectory to reduce size
  const compactedTrajectory = compactTrajectory(trajectory);
  const trajectoryJson = JSON.stringify(compactedTrajectory, null, 2);

  // Limit logs to 20 most recent
  const logsJson = logs && logs.length > 0
    ? JSON.stringify(logs.slice(0, 20), null, 2)
    : 'No logs available';

  // Build expected section based on what's provided
  let expectedSection = '';
  if (expectedOutcomes && expectedOutcomes.length > 0) {
    // Use expectedOutcomes (new format)
    expectedSection = `## Expected Outcomes
The agent should achieve the following outcomes:
${expectedOutcomes.map((outcome, i) => `${i + 1}. ${outcome}`).join('\n')}`;
  } else if (expectedTrajectory && expectedTrajectory.length > 0) {
    // Fall back to expectedTrajectory (legacy format)
    const expectedJson = JSON.stringify(expectedTrajectory, null, 2);
    expectedSection = `## Expected Trajectory (Legacy)
\`\`\`json
${expectedJson}
\`\`\``;
  } else {
    expectedSection = '## Expected Outcomes\nNo expected outcomes defined.';
  }

  const agentSourceSection = agentSource && agentSource.trim().length > 0
    ? `\n## Agent Source\n${agentSource}\n`
    : '';

  return `# Evaluation Task

## Actual Agent Trajectory
\`\`\`json
${trajectoryJson}
\`\`\`

${expectedSection}

## OpenSearch Logs (Recent 20)
\`\`\`json
${logsJson}
\`\`\`
${agentSourceSection}
Please evaluate the agent's performance and provide your assessment in the JSON format specified.`;
}

// ============================================================================
// Main Evaluation Function
// ============================================================================

/**
 * Evaluate agent trajectory using AWS Bedrock LLM Judge
 * @param request - The judge request containing trajectory and expected outcomes
 * @param modelId - Optional model ID to use for evaluation (falls back to config.BEDROCK_MODEL_ID)
 * @param evaluator - Optional evaluator to use (falls back to default RCA evaluator)
 */
export async function evaluateTrajectory(
  request: JudgeRequest,
  modelId?: string,
  evaluator?: Evaluator
): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs } = request;

  // Use default evaluator if none provided (backward compatibility)
  const effectiveEvaluator = evaluator || getDefaultEvaluator();

  // Use provided modelId or fall back to configured default
  const effectiveModelId = modelId || config.BEDROCK_MODEL_ID;

  debug('JudgeAPI', '========== BEDROCK JUDGE REQUEST ==========');
  debug('JudgeAPI', 'Received evaluation request');
  debug('JudgeAPI', 'Evaluator:', effectiveEvaluator.name, `(${effectiveEvaluator.id})`);
  debug('JudgeAPI', 'Trajectory steps:', trajectory.length);
  debug('JudgeAPI', 'Expected outcomes:', expectedOutcomes?.length || 0);
  debug('JudgeAPI', 'Expected trajectory steps:', expectedTrajectory?.length || 0);
  debug('JudgeAPI', 'Logs provided:', logs?.length || 0);
  debug('JudgeAPI', 'Model:', effectiveModelId, modelId ? '(from request)' : '(default)');

  // Log trajectory summary for debugging
  debug('JudgeAPI', '--- Trajectory Summary ---');
  trajectory.forEach((step, idx) => {
    debug('JudgeAPI', `Step ${idx + 1}: ${step.type} ${step.toolName ? `(${step.toolName})` : ''}`);
  });

  // Log expected outcomes or trajectory
  if (expectedOutcomes?.length) {
    debug('JudgeAPI', '--- Expected Outcomes ---');
    expectedOutcomes.forEach((outcome, idx) => {
      debug('JudgeAPI', `${idx + 1}. ${outcome}`);
    });
  } else if (expectedTrajectory?.length) {
    debug('JudgeAPI', '--- Expected Trajectory (Legacy) ---');
    expectedTrajectory.forEach((step: any, idx) => {
      debug('JudgeAPI', `Step ${idx + 1}: ${step.description} (Tools: ${step.requiredTools?.join(', ') || 'none'})`);
    });
  }

  // Build evaluation prompt — pull agent source for grounded reasoning when
  // AH_AGENT_PATH is configured. Phase 3 (gather) uses the same model as the
  // judge so the user doesn't need separate API credentials.
  const agentSource = isAgentPathConfigured()
    ? await getAgentSourceForPrompt({
        trajectory,
        expectedOutcomes,
        modelId: effectiveModelId,
      })
    : null;

  const userPrompt = buildEvaluationPrompt(
    trajectory,
    expectedOutcomes,
    expectedTrajectory,
    logs,
    agentSource,
  );

  debug('JudgeAPI', 'Prompt built, length:', userPrompt.length, 'characters');

  // Get inference config from evaluator with fallback defaults
  const temperature = effectiveEvaluator.inferenceConfig?.temperature ?? 0.1;
  const maxTokens = effectiveEvaluator.inferenceConfig?.maxTokens ?? 4096;

  debug('JudgeAPI', 'Inference config - temperature:', temperature, 'maxTokens:', maxTokens);

  // Create Bedrock command using evaluator's system prompt
  const command = new ConverseCommand({
    modelId: effectiveModelId,
    messages: [
      {
        role: 'user',
        content: [{ text: userPrompt }],
      },
    ],
    system: [{ text: effectiveEvaluator.systemPrompt + (agentSource ? AGENT_PATH_SYSTEM_ADDENDUM : '') }],
    inferenceConfig: {
      maxTokens,
      temperature,
    },
  });

  // Call Bedrock
  debug('JudgeAPI', 'Calling Bedrock API...');
  const startTime = Date.now();
  const response = await bedrockClient.send(command);
  const duration = Date.now() - startTime;

  debug('JudgeAPI', 'Response received in', duration, 'ms');

  // Extract response text
  let responseText = '';
  if (response.output?.message?.content) {
    for (const content of response.output.message.content) {
      if ('text' in content && content.text) {
        responseText += content.text;
      }
    }
  }

  debug('JudgeAPI', '--- Raw Bedrock Response ---');
  debug('JudgeAPI', responseText.substring(0, 500) + (responseText.length > 500 ? '...' : ''));

  debug('JudgeAPI', '========== BEDROCK JUDGE RESPONSE ==========');

  // Delegate JSON parsing + metric extraction to the shared parser. It
  // captures `rawResponse` and any extra fields the model emitted that
  // aren't declared in the evaluator's scoringConfig (so prompt iteration
  // works without a code change) — see judgeResponseParser.ts.
  const parsed = parseJudgeResponse(responseText, {
    evaluator: effectiveEvaluator,
    duration,
    source: 'JudgeAPI',
  });
  // Optionally capture the prompts so the run-detail UI's "Judge debug" tab
  // can confirm the saved evaluator prompt actually reached the model.
  const judgeDebug = buildJudgeDebug({
    provider: 'bedrock',
    modelId: effectiveModelId,
    evaluatorId: effectiveEvaluator.id,
    systemPrompt: effectiveEvaluator.systemPrompt,
    userPrompt,
  });
  if (judgeDebug) parsed.judgeDebug = judgeDebug;
  return parsed;
}

/**
 * Parse error messages from Bedrock API failures
 */
export function parseBedrockError(error: Error): string {
  const errorMessage = error.message;

  if (errorMessage.includes('ExpiredToken') || errorMessage.includes('CredentialsProviderError')) {
    return 'AWS credentials expired or invalid. Please refresh your AWS credentials.';
  } else if (errorMessage.includes('ThrottlingException')) {
    return 'Bedrock API rate limit exceeded. Please try again in a moment.';
  } else if (errorMessage.includes('ValidationException')) {
    return 'Invalid request to Bedrock. Please check your configuration.';
  } else if (errorMessage.includes('JSON')) {
    return 'Failed to parse LLM judge response. The model may have returned invalid JSON.';
  }

  return errorMessage || 'Unknown error occurred';
}
