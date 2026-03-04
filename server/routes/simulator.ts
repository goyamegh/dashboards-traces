/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * User Simulator Route
 * Generates follow-up questions for multi-turn evaluation using an LLM
 */

import { Request, Response, Router } from 'express';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import config from '../config';
import { loadConfigSync } from '../../lib/config/index';
import { buildSimulatorPrompt, parseSimulatorResponse } from '@/services/evaluation/userSimulator';
import { debug } from '@/lib/debug';

const router = Router();

const bedrockClient = new BedrockRuntimeClient({
  region: config.AWS_REGION,
});

/**
 * POST /api/simulate-followup
 * Generate the next user follow-up question for multi-turn evaluation
 */
router.post('/api/simulate-followup', async (req: Request, res: Response) => {
  try {
    const { scenario, conversationHistory, currentTurnIndex, modelId } = req.body;

    // Validate required fields
    if (!scenario) {
      return res.status(400).json({ error: 'Missing required field: scenario' });
    }
    if (!conversationHistory) {
      return res.status(400).json({ error: 'Missing required field: conversationHistory' });
    }
    if (currentTurnIndex === undefined || currentTurnIndex === null) {
      return res.status(400).json({ error: 'Missing required field: currentTurnIndex' });
    }

    // Resolve model ID
    const resolvedConfig = loadConfigSync();
    let resolvedModelId = modelId;
    if (modelId) {
      const modelConfig = resolvedConfig.models[modelId] ||
        Object.values(resolvedConfig.models).find(m => m.model_id === modelId);
      resolvedModelId = modelConfig?.model_id || modelId;
    } else {
      resolvedModelId = config.BEDROCK_MODEL_ID;
    }

    debug('Simulator', 'Generating follow-up for turn', currentTurnIndex + 1, 'with model', resolvedModelId);

    // Build simulator prompt
    const prompt = buildSimulatorPrompt(scenario, conversationHistory, currentTurnIndex);

    // Call Bedrock
    const command = new ConverseCommand({
      modelId: resolvedModelId,
      messages: [
        {
          role: 'user',
          content: [{ text: prompt }],
        },
      ],
      system: [{ text: 'You are a user simulator for agent evaluation. Always respond with valid JSON.' }],
      inferenceConfig: {
        maxTokens: 1024,
        temperature: 0.3,
      },
    });

    const response = await bedrockClient.send(command);

    // Extract response text
    let responseText = '';
    if (response.output?.message?.content) {
      for (const content of response.output.message.content) {
        if ('text' in content && content.text) {
          responseText += content.text;
        }
      }
    }

    debug('Simulator', 'Raw response:', responseText.substring(0, 300));

    // Parse response
    const result = parseSimulatorResponse(responseText);

    debug('Simulator', 'Parsed result: done=', result.done, 'message=', result.message.substring(0, 100));

    return res.json(result);
  } catch (error: any) {
    console.error('[Simulator] Error generating follow-up:', error);
    return res.status(500).json({
      error: `Simulator failed: ${error.message || 'Unknown error'}`,
    });
  }
});

export default router;
