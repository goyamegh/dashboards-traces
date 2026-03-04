/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge API Route - Evaluate agent trajectories
 */

import { Request, Response, Router } from 'express';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { evaluateTrajectory, parseBedrockError } from '../services/bedrockService';
import { evaluateWithLiteLLM, parseLiteLLMError } from '../services/litellmJudgeService';
import { loadConfigSync } from '../../lib/config/index';
import serverConfig from '../config';
import { debug } from '@/lib/debug';
import { buildMultiTurnJudgeSystemPrompt, computeWeightedScore } from '../prompts/multiTurnJudgePrompt';
import type { MultiTurnJudgeOutput } from '../prompts/multiTurnJudgePrompt';

const router = Router();

/**
 * Generate mock evaluation result for demo mode
 */
function generateMockEvaluation(trajectory: any[], expectedOutcomes: string[]): any {
  // Simulate realistic evaluation based on trajectory content
  const hasToolCalls = trajectory.some((step: any) => step.type === 'action' || step.toolName);
  const hasConclusion = trajectory.some((step: any) =>
    step.type === 'response' || (step.content && step.content.toLowerCase().includes('root cause'))
  );

  // Base accuracy on trajectory quality
  let accuracy = 0.7;
  if (hasToolCalls) accuracy += 0.1;
  if (hasConclusion) accuracy += 0.1;
  accuracy = Math.min(accuracy + (Math.random() * 0.1), 1.0);

  const passFailStatus = accuracy >= 0.7 ? 'passed' : 'failed';

  const accuracyPct = Math.round(accuracy * 100);
  return {
    passFailStatus,
    metrics: {
      accuracy: accuracyPct,
      faithfulness: Math.round((accuracy - 0.05 + Math.random() * 0.1) * 100),
      latency_score: Math.round((0.8 + Math.random() * 0.2) * 100),
      trajectory_alignment_score: Math.round((accuracy - 0.1 + Math.random() * 0.2) * 100),
    },
    llmJudgeReasoning: `**Mock Evaluation Result**

The agent demonstrated ${passFailStatus === 'passed' ? 'appropriate' : 'incomplete'} RCA methodology:

${hasToolCalls ? '✅ Used diagnostic tools to gather system information' : '❌ Did not use diagnostic tools'}
${hasConclusion ? '✅ Provided a clear root cause identification' : '❌ Missing clear root cause conclusion'}

**Expected Outcomes Coverage:**
${expectedOutcomes?.map((outcome, i) => `${i + 1}. "${outcome.substring(0, 50)}..." - ${Math.random() > 0.3 ? '✅ Addressed' : '⚠️ Partially addressed'}`).join('\n') || 'No expected outcomes provided'}

*Note: This is a simulated evaluation for demo purposes.*`,
    improvementStrategies: passFailStatus === 'failed' ? [
      {
        category: 'Tool Usage',
        issue: 'Insufficient diagnostic tool usage',
        recommendation: 'Consider using more diagnostic tools before drawing conclusions',
        priority: 'high'
      },
      {
        category: 'Analysis Depth',
        issue: 'Reasoning could be more detailed',
        recommendation: 'Provide more detailed reasoning connecting observations to root cause',
        priority: 'medium'
      }
    ] : []
  };
}

/**
 * GET /api/judge/litellm-models
 * Discover available models from the configured LiteLLM / OpenAI-compatible endpoint.
 * Returns { models: string[], endpoint: string, configured: boolean }
 */
router.get('/api/judge/litellm-models', async (_req: Request, res: Response) => {
  const endpoint = serverConfig.LITELLM_ENDPOINT;
  // Derive the /models URL from the chat completions endpoint
  const modelsUrl = endpoint.replace(/\/chat\/completions$/, '/models');

  debug('JudgeAPI', 'Fetching LiteLLM models from:', modelsUrl);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (serverConfig.LITELLM_API_KEY) {
    headers['Authorization'] = `Bearer ${serverConfig.LITELLM_API_KEY}`;
  }

  try {
    const response = await fetch(modelsUrl, { headers });
    if (!response.ok) {
      const body = await response.text();
      return res.status(response.status).json({
        error: `LiteLLM /models returned ${response.status}`,
        details: body,
        endpoint: modelsUrl,
        configured: !!serverConfig.LITELLM_API_KEY,
      });
    }
    const data = await response.json();
    // OpenAI /models returns { object: "list", data: [{ id, ... }] }
    const models: string[] = (data.data || data.models || []).map((m: any) => m.id || m).filter(Boolean);
    debug('JudgeAPI', 'Discovered', models.length, 'LiteLLM models');
    return res.json({
      models,
      endpoint: modelsUrl,
      configured: !!serverConfig.LITELLM_API_KEY,
    });
  } catch (err: any) {
    return res.status(503).json({
      error: `Cannot reach LiteLLM endpoint: ${err.message}`,
      endpoint: modelsUrl,
      configured: !!serverConfig.LITELLM_API_KEY,
    });
  }
});

/**
 * POST /api/judge - Evaluate agent trajectory
 */
router.post('/api/judge', async (req: Request, res: Response) => {
  try {
    const { trajectory, expectedOutcomes, expectedTrajectory, logs, modelId } = req.body;

    // Validate required fields
    if (!trajectory) {
      return res.status(400).json({
        error: 'Missing required field: trajectory'
      });
    }

    if (!expectedOutcomes?.length && !expectedTrajectory?.length) {
      return res.status(400).json({
        error: 'Missing required field: expectedOutcomes or expectedTrajectory'
      });
    }

    // Determine provider from model config
    // Look up by model key first, then by model_id for full Bedrock model IDs
    const config = loadConfigSync();
    let modelConfig = config.models[modelId];
    if (!modelConfig) {
      // Try to find by model_id (in case full Bedrock ID was passed)
      modelConfig = Object.values(config.models).find(m => m.model_id === modelId);
    }
    const provider = modelConfig?.provider || 'bedrock';

    // Use the resolved model_id from config, not the key
    const resolvedModelId = modelConfig?.model_id || modelId;
    debug('JudgeAPI', 'Using provider:', provider, 'model:', resolvedModelId);

    // Route to appropriate provider
    if (provider === 'demo') {
      debug('JudgeAPI', 'Demo provider - returning mock evaluation');
      const mockResult = generateMockEvaluation(trajectory, expectedOutcomes);
      return res.json(mockResult);
    }

    if (provider === 'litellm') {
      debug('JudgeAPI', 'LiteLLM provider - calling OpenAI-compatible endpoint');
      const result = await evaluateWithLiteLLM(
        { trajectory, expectedOutcomes, expectedTrajectory, logs },
        resolvedModelId
      );
      return res.json(result);
    }

    // Default: bedrock
    const result = await evaluateTrajectory({
      trajectory,
      expectedOutcomes,
      expectedTrajectory,
      logs
    }, resolvedModelId);

    res.json(result);

  } catch (error: any) {
    console.error('[JudgeAPI] Error during evaluation:', error);

    const provider = (() => {
      try {
        const config = loadConfigSync();
        const { modelId } = req.body;
        const modelConfig = config.models[modelId] ||
          Object.values(config.models).find(m => m.model_id === modelId);
        return modelConfig?.provider || 'bedrock';
      } catch {
        return 'bedrock';
      }
    })();

    const errorMessage = provider === 'litellm'
      ? parseLiteLLMError(error)
      : parseBedrockError(error);

    res.status(500).json({
      error: `Judge evaluation failed: ${errorMessage}`,
      details: error.message
    });
  }
});

/**
 * POST /api/judge/multi-turn - Evaluate multi-turn agent conversation holistically
 */
router.post('/api/judge/multi-turn', async (req: Request, res: Response) => {
  try {
    const { multiTurnConversation, modelId } = req.body;

    if (!multiTurnConversation) {
      return res.status(400).json({ error: 'Missing required field: multiTurnConversation' });
    }

    const { turns, idealAnswer, criticalComponents, scoringWeights } = multiTurnConversation;

    if (!turns?.length) {
      return res.status(400).json({ error: 'Missing required field: multiTurnConversation.turns' });
    }
    if (!idealAnswer) {
      return res.status(400).json({ error: 'Missing required field: multiTurnConversation.idealAnswer' });
    }

    // Resolve model
    const resolvedConfig = loadConfigSync();
    let modelConfig = resolvedConfig.models[modelId];
    if (!modelConfig) {
      modelConfig = Object.values(resolvedConfig.models).find(m => m.model_id === modelId);
    }
    const resolvedModelId = modelConfig?.model_id || modelId || serverConfig.BEDROCK_MODEL_ID;

    debug('JudgeAPI', 'Multi-turn evaluation with model:', resolvedModelId, 'turns:', turns.length);

    // Build holistic prompt
    const systemPrompt = buildMultiTurnJudgeSystemPrompt({
      turns,
      idealAnswer,
      criticalComponents,
      scoringWeights,
    });

    // Call Bedrock
    const bedrockClient = new BedrockRuntimeClient({ region: serverConfig.AWS_REGION });
    const command = new ConverseCommand({
      modelId: resolvedModelId,
      messages: [
        {
          role: 'user',
          content: [{ text: 'Please evaluate the multi-turn conversation described in the system prompt.' }],
        },
      ],
      system: [{ text: systemPrompt }],
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0.1,
      },
    });

    const startTime = Date.now();
    const response = await bedrockClient.send(command);
    const duration = Date.now() - startTime;

    // Extract response text
    let responseText = '';
    if (response.output?.message?.content) {
      for (const content of response.output.message.content) {
        if ('text' in content && content.text) {
          responseText += content.text;
        }
      }
    }

    debug('JudgeAPI', 'Multi-turn judge response in', duration, 'ms');

    // Parse JSON from response
    let jsonText = responseText.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonText = jsonMatch[1];
    } else {
      const startIdx = jsonText.indexOf('{');
      const endIdx = jsonText.lastIndexOf('}');
      if (startIdx !== -1 && endIdx !== -1) {
        jsonText = jsonText.slice(startIdx, endIdx + 1);
      }
    }

    const result: MultiTurnJudgeOutput = JSON.parse(jsonText);

    // Compute weighted score
    const weightedScore = computeWeightedScore(
      {
        rootCauseScore: result.root_cause_score,
        remediationScore: result.remediation_score,
        contextRetentionScore: result.context_retention_score,
        concisenessScore: result.conciseness_score,
      },
      scoringWeights
    );

    return res.json({
      rootCauseScore: result.root_cause_score,
      remediationScore: result.remediation_score,
      contextRetentionScore: result.context_retention_score,
      concisenessScore: result.conciseness_score,
      weightedScore: Math.round(weightedScore),
      passFailStatus: result.pass_fail_status || (weightedScore >= 70 ? 'passed' : 'failed'),
      reasoning: result.reasoning,
      improvementStrategies: result.improvement_strategies || [],
      duration,
    });
  } catch (error: any) {
    console.error('[JudgeAPI] Multi-turn evaluation error:', error);
    const errorMessage = parseBedrockError(error);
    return res.status(500).json({
      error: `Multi-turn judge evaluation failed: ${errorMessage}`,
      details: error.message,
    });
  }
});

export default router;
