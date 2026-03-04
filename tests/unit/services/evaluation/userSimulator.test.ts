/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MultiTurnScenario } from '@/types';
import type { AgentMessage } from '@/services/agent/payloadBuilder';

// Mock @/lib/config with simulatorApiUrl
jest.mock('@/lib/config', () => ({
  ENV_CONFIG: {
    simulatorApiUrl: 'http://localhost:4001/api/simulate-followup',
  },
}));

// Mock @/lib/debug
jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

import {
  buildSimulatorPrompt,
  parseSimulatorResponse,
  generateFollowUp,
  SimulatorResponse,
} from '@/services/evaluation/userSimulator';

// ---- helpers ----

function makeScenario(overrides?: Partial<MultiTurnScenario>): MultiTurnScenario {
  return {
    userMotivation: 'Investigate the root cause of the 5xx spike on the checkout service.',
    acceptanceCriteria: [
      'Identify the root cause',
      'Provide a remediation step',
    ],
    idealAnswer: 'The root cause is a memory leak in the checkout service.',
    referenceTurns: [
      {
        turn: 1,
        user: 'Can you check the error logs for the checkout service?',
        expectedTopics: ['error logs', 'checkout service'],
        groundTruth: 'Logs show OOM errors.',
      },
      {
        turn: 2,
        user: 'What is the memory trend over the past hour?',
        expectedTopics: ['memory', 'trend'],
        groundTruth: 'Memory is increasing linearly.',
      },
    ],
    ...overrides,
  };
}

function makeHistory(pairs: Array<[string, string]>): AgentMessage[] {
  const messages: AgentMessage[] = [];
  pairs.forEach(([userMsg, assistantMsg], i) => {
    messages.push({ id: `u${i}`, role: 'user', content: userMsg });
    messages.push({ id: `a${i}`, role: 'assistant', content: assistantMsg });
  });
  return messages;
}

// ---- global fetch mock ----

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

afterAll(() => {
  global.fetch = originalFetch;
});

// ================================================================
// buildSimulatorPrompt
// ================================================================

describe('buildSimulatorPrompt', () => {
  it('should include userMotivation in the prompt', () => {
    const scenario = makeScenario();
    const prompt = buildSimulatorPrompt(scenario, [], 0);

    expect(prompt).toContain(scenario.userMotivation);
  });

  it('should include all acceptance criteria numbered', () => {
    const scenario = makeScenario();
    const prompt = buildSimulatorPrompt(scenario, [], 0);

    expect(prompt).toContain('1. Identify the root cause');
    expect(prompt).toContain('2. Provide a remediation step');
  });

  it('should include conversation history with role labels', () => {
    const scenario = makeScenario();
    const history = makeHistory([
      ['What happened?', 'There was a 5xx spike.'],
    ]);

    const prompt = buildSimulatorPrompt(scenario, history, 1);

    expect(prompt).toContain('User: What happened?');
    expect(prompt).toContain('Agent: There was a 5xx spike.');
  });

  it('should include the reference turn when available', () => {
    const scenario = makeScenario();
    const prompt = buildSimulatorPrompt(scenario, [], 0);

    expect(prompt).toContain('Suggested Next Question');
    expect(prompt).toContain('Can you check the error logs for the checkout service?');
    expect(prompt).toContain('error logs, checkout service');
  });

  it('should include reference turn for turn index 1', () => {
    const scenario = makeScenario();
    const prompt = buildSimulatorPrompt(scenario, [], 1);

    expect(prompt).toContain('What is the memory trend over the past hour?');
    expect(prompt).toContain('memory, trend');
  });

  it('should handle missing reference turns gracefully', () => {
    const scenario = makeScenario();
    // Turn index 5 is beyond the reference turns array
    const prompt = buildSimulatorPrompt(scenario, [], 5);

    expect(prompt).toContain('No reference question available for this turn');
    expect(prompt).toContain("investigation's natural progression");
  });

  it('should handle scenario with no referenceTurns at all', () => {
    const scenario = makeScenario({ referenceTurns: undefined });
    const prompt = buildSimulatorPrompt(scenario, [], 0);

    expect(prompt).toContain('No reference question available for this turn');
  });

  it('should include JSON response instruction', () => {
    const scenario = makeScenario();
    const prompt = buildSimulatorPrompt(scenario, [], 0);

    expect(prompt).toContain('Respond as JSON');
    expect(prompt).toContain('"done"');
    expect(prompt).toContain('"message"');
  });
});

// ================================================================
// parseSimulatorResponse
// ================================================================

describe('parseSimulatorResponse', () => {
  it('should parse clean JSON with done=false', () => {
    const input = '{"done": false, "message": "What are the recent logs?"}';
    const result = parseSimulatorResponse(input);

    expect(result).toEqual({
      done: false,
      message: 'What are the recent logs?',
    });
  });

  it('should parse clean JSON with done=true', () => {
    const input = '{"done": true, "message": "All criteria met. Investigation complete."}';
    const result = parseSimulatorResponse(input);

    expect(result).toEqual({
      done: true,
      message: 'All criteria met. Investigation complete.',
    });
  });

  it('should coerce done to boolean', () => {
    const input = '{"done": 0, "message": "hello"}';
    const result = parseSimulatorResponse(input);
    expect(result.done).toBe(false);

    const input2 = '{"done": 1, "message": "world"}';
    const result2 = parseSimulatorResponse(input2);
    expect(result2.done).toBe(true);
  });

  it('should handle missing message as empty string', () => {
    const input = '{"done": false}';
    const result = parseSimulatorResponse(input);
    expect(result.message).toBe('');
  });

  it('should parse JSON inside a markdown code block', () => {
    const input = '```json\n{"done": false, "message": "Check the traces."}\n```';
    const result = parseSimulatorResponse(input);

    expect(result).toEqual({
      done: false,
      message: 'Check the traces.',
    });
  });

  it('should parse JSON inside a code block without json tag', () => {
    const input = '```\n{"done": true, "message": "Done."}\n```';
    const result = parseSimulatorResponse(input);

    expect(result).toEqual({
      done: true,
      message: 'Done.',
    });
  });

  it('should parse JSON embedded in surrounding text', () => {
    const input = 'Here is my response: {"done": false, "message": "What about memory?"} Hope that helps.';
    const result = parseSimulatorResponse(input);

    expect(result).toEqual({
      done: false,
      message: 'What about memory?',
    });
  });

  it('should return entire text as message when JSON is invalid', () => {
    const input = 'I think you should check the CPU metrics next.';
    const result = parseSimulatorResponse(input);

    expect(result).toEqual({
      done: false,
      message: 'I think you should check the CPU metrics next.',
    });
  });

  it('should trim whitespace from input', () => {
    const input = '   {"done": false, "message": "trimmed"}   ';
    const result = parseSimulatorResponse(input);

    expect(result).toEqual({
      done: false,
      message: 'trimmed',
    });
  });

  it('should handle non-JSON text with braces that do not form valid JSON', () => {
    const input = 'function foo() { return bar; }';
    const result = parseSimulatorResponse(input);

    expect(result).toEqual({
      done: false,
      message: 'function foo() { return bar; }',
    });
  });
});

// ================================================================
// generateFollowUp
// ================================================================

describe('generateFollowUp', () => {
  const scenario = makeScenario();
  const history = makeHistory([
    ['What happened?', 'There was a 5xx spike on checkout.'],
  ]);

  it('should call the simulator API and return the result on success', async () => {
    const mockResponse: SimulatorResponse = {
      done: false,
      message: 'Can you check the error logs?',
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(mockResponse),
    });

    const result = await generateFollowUp(scenario, history, 1);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:4001/api/simulate-followup',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    // Verify the body contains the right fields
    const callArgs = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.scenario).toEqual(scenario);
    expect(body.conversationHistory).toEqual(history);
    expect(body.currentTurnIndex).toBe(1);

    expect(result).toEqual(mockResponse);
  });

  it('should pass modelId in the request body when provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ done: false, message: 'test' }),
    });

    await generateFollowUp(scenario, history, 0, 'claude-sonnet-4');

    const callArgs = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.modelId).toBe('claude-sonnet-4');
  });

  it('should fall back to reference turn verbatim when API returns non-ok response', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: jest.fn().mockResolvedValue({ error: 'Internal server error' }),
    });

    const result = await generateFollowUp(scenario, history, 0);

    expect(result).toEqual({
      done: false,
      message: 'Can you check the error logs for the checkout service?',
    });

    consoleSpy.mockRestore();
  });

  it('should fall back to reference turn verbatim when fetch throws', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

    const result = await generateFollowUp(scenario, history, 1);

    expect(result).toEqual({
      done: false,
      message: 'What is the memory trend over the past hour?',
    });

    consoleSpy.mockRestore();
  });

  it('should return done:true when API fails and no reference turn is available', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

    // Turn index 5 has no reference turn
    const result = await generateFollowUp(scenario, history, 5);

    expect(result).toEqual({
      done: true,
      message: 'Unable to generate follow-up question.',
    });

    consoleSpy.mockRestore();
  });

  it('should return done:true when API fails and scenario has no referenceTurns', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const noRefScenario = makeScenario({ referenceTurns: undefined });

    (global.fetch as jest.Mock).mockRejectedValue(new Error('Timeout'));

    const result = await generateFollowUp(noRefScenario, history, 0);

    expect(result).toEqual({
      done: true,
      message: 'Unable to generate follow-up question.',
    });

    consoleSpy.mockRestore();
  });

  it('should handle non-ok response where json() parsing fails', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 502,
      json: jest.fn().mockRejectedValue(new Error('invalid json')),
    });

    // Turn 0 has a reference turn, so it falls back
    const result = await generateFollowUp(scenario, history, 0);

    expect(result).toEqual({
      done: false,
      message: 'Can you check the error logs for the checkout service?',
    });

    consoleSpy.mockRestore();
  });
});
