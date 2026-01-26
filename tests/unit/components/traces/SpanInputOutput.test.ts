/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for SpanInputOutput component - input/output extraction from OTEL span attributes
 */

import { Span } from '@/types';

// Replicate the extraction logic from SpanInputOutput component for testing
interface SpanIOData {
  span: Span;
  category: 'agent' | 'llm' | 'tool' | 'other';
  input: string | null;
  output: string | null;
  toolName?: string;
  modelId?: string;
}

function extractSpanIO(span: Span): SpanIOData {
  const attrs = span.attributes || {};
  const name = span.name.toLowerCase();

  // Determine category
  let category: SpanIOData['category'] = 'other';
  if (name.includes('agent') || attrs['gen_ai.agent.name']) {
    category = 'agent';
  } else if (name.includes('llm') || name.includes('bedrock') || name.includes('converse') || attrs['gen_ai.system']) {
    category = 'llm';
  } else if (name.includes('tool') || attrs['gen_ai.tool.name']) {
    category = 'tool';
  }

  // Extract input based on category and OTEL conventions
  let input: string | null = null;
  let output: string | null = null;

  // LLM spans
  if (category === 'llm') {
    input = attrs['gen_ai.prompt'] ||
            attrs['gen_ai.prompt.0.content'] ||
            attrs['llm.prompts'] ||
            attrs['llm.input_messages'] ||
            attrs['input.value'] ||
            null;

    output = attrs['gen_ai.completion'] ||
             attrs['gen_ai.completion.0.content'] ||
             attrs['llm.completions'] ||
             attrs['llm.output_messages'] ||
             attrs['output.value'] ||
             null;
  }

  // Tool spans
  if (category === 'tool') {
    input = attrs['gen_ai.tool.input'] ||
            attrs['tool.input'] ||
            attrs['input.value'] ||
            attrs['tool.parameters'] ||
            null;

    output = attrs['gen_ai.tool.output'] ||
             attrs['tool.output'] ||
             attrs['output.value'] ||
             attrs['tool.result'] ||
             null;
  }

  // Agent spans
  if (category === 'agent') {
    input = attrs['gen_ai.agent.input'] ||
            attrs['agent.input'] ||
            attrs['input.value'] ||
            attrs['user.message'] ||
            null;

    output = attrs['gen_ai.agent.output'] ||
             attrs['agent.output'] ||
             attrs['output.value'] ||
             attrs['assistant.message'] ||
             null;
  }

  // Generic fallback
  if (!input) {
    input = attrs['input'] || attrs['request'] || attrs['message'] || null;
  }
  if (!output) {
    output = attrs['output'] || attrs['response'] || attrs['result'] || null;
  }

  // Convert objects to JSON string
  if (input && typeof input === 'object') {
    input = JSON.stringify(input, null, 2);
  }
  if (output && typeof output === 'object') {
    output = JSON.stringify(output, null, 2);
  }

  return {
    span,
    category,
    input: input as string | null,
    output: output as string | null,
    toolName: attrs['gen_ai.tool.name'] || attrs['tool.name'],
    modelId: attrs['gen_ai.request.model'] || attrs['llm.model_name'] || attrs['gen_ai.system'],
  };
}

// Helper to create test spans
function createSpan(overrides: Partial<Span> = {}): Span {
  return {
    spanId: 'test-span-id',
    traceId: 'test-trace-id',
    name: overrides.name || 'test-span',
    startTime: '2024-01-01T00:00:00Z',
    endTime: '2024-01-01T00:00:01Z',
    status: 'OK',
    attributes: overrides.attributes || {},
    ...overrides,
  };
}

describe('SpanInputOutput - extractSpanIO', () => {
  describe('category detection', () => {
    it('detects agent category from span name', () => {
      const span = createSpan({ name: 'agent.run' });
      const result = extractSpanIO(span);
      expect(result.category).toBe('agent');
    });

    it('detects agent category from attribute', () => {
      const span = createSpan({
        name: 'some-span',
        attributes: { 'gen_ai.agent.name': 'my-agent' },
      });
      const result = extractSpanIO(span);
      expect(result.category).toBe('agent');
    });

    it('detects llm category from span name', () => {
      const spans = [
        createSpan({ name: 'llm.call' }),
        createSpan({ name: 'bedrock.invoke' }),
        createSpan({ name: 'converse.api' }),
      ];

      spans.forEach(span => {
        const result = extractSpanIO(span);
        expect(result.category).toBe('llm');
      });
    });

    it('detects llm category from gen_ai.system attribute', () => {
      const span = createSpan({
        name: 'some-span',
        attributes: { 'gen_ai.system': 'openai' },
      });
      const result = extractSpanIO(span);
      expect(result.category).toBe('llm');
    });

    it('detects tool category from span name', () => {
      const span = createSpan({ name: 'tool.execute' });
      const result = extractSpanIO(span);
      expect(result.category).toBe('tool');
    });

    it('detects tool category from gen_ai.tool.name attribute', () => {
      const span = createSpan({
        name: 'some-span',
        attributes: { 'gen_ai.tool.name': 'search_tool' },
      });
      const result = extractSpanIO(span);
      expect(result.category).toBe('tool');
    });

    it('defaults to other category', () => {
      const span = createSpan({ name: 'random-span' });
      const result = extractSpanIO(span);
      expect(result.category).toBe('other');
    });
  });

  describe('LLM input/output extraction', () => {
    it('extracts gen_ai.prompt and gen_ai.completion', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.prompt': 'Hello, how are you?',
          'gen_ai.completion': 'I am doing well, thank you!',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('Hello, how are you?');
      expect(result.output).toBe('I am doing well, thank you!');
    });

    it('extracts llm.prompts and llm.completions', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'llm.prompts': 'User prompt',
          'llm.completions': 'Assistant response',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('User prompt');
      expect(result.output).toBe('Assistant response');
    });

    it('extracts input.value and output.value', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'input.value': 'Input text',
          'output.value': 'Output text',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('Input text');
      expect(result.output).toBe('Output text');
    });

    it('extracts model ID', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.request.model': 'claude-3-sonnet',
        },
      });

      const result = extractSpanIO(span);
      expect(result.modelId).toBe('claude-3-sonnet');
    });
  });

  describe('Tool input/output extraction', () => {
    it('extracts gen_ai.tool.input and gen_ai.tool.output', () => {
      const span = createSpan({
        name: 'tool.execute',
        attributes: {
          'gen_ai.tool.name': 'search',
          'gen_ai.tool.input': '{"query": "test"}',
          'gen_ai.tool.output': '{"results": []}',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('{"query": "test"}');
      expect(result.output).toBe('{"results": []}');
      expect(result.toolName).toBe('search');
    });

    it('extracts tool.input and tool.output', () => {
      const span = createSpan({
        name: 'tool.execute',
        attributes: {
          'tool.input': 'input data',
          'tool.output': 'output data',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('input data');
      expect(result.output).toBe('output data');
    });

    it('extracts tool.parameters and tool.result', () => {
      const span = createSpan({
        name: 'tool.execute',
        attributes: {
          'tool.parameters': 'params',
          'tool.result': 'result',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('params');
      expect(result.output).toBe('result');
    });
  });

  describe('Agent input/output extraction', () => {
    it('extracts gen_ai.agent.input and gen_ai.agent.output', () => {
      const span = createSpan({
        name: 'agent.run',
        attributes: {
          'gen_ai.agent.input': 'User message',
          'gen_ai.agent.output': 'Agent response',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('User message');
      expect(result.output).toBe('Agent response');
    });

    it('extracts user.message and assistant.message', () => {
      const span = createSpan({
        name: 'agent.run',
        attributes: {
          'user.message': 'Hello',
          'assistant.message': 'Hi there!',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('Hello');
      expect(result.output).toBe('Hi there!');
    });
  });

  describe('fallback extraction', () => {
    it('falls back to generic input/output attributes', () => {
      const span = createSpan({
        name: 'random-span',
        attributes: {
          'input': 'generic input',
          'output': 'generic output',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('generic input');
      expect(result.output).toBe('generic output');
    });

    it('falls back to request/response attributes', () => {
      const span = createSpan({
        name: 'random-span',
        attributes: {
          'request': 'request data',
          'response': 'response data',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('request data');
      expect(result.output).toBe('response data');
    });
  });

  describe('object to JSON conversion', () => {
    it('converts object input to JSON string', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.prompt': { role: 'user', content: 'Hello' },
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe(JSON.stringify({ role: 'user', content: 'Hello' }, null, 2));
    });

    it('converts object output to JSON string', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.completion': { role: 'assistant', content: 'Hi' },
        },
      });

      const result = extractSpanIO(span);
      expect(result.output).toBe(JSON.stringify({ role: 'assistant', content: 'Hi' }, null, 2));
    });
  });

  describe('null handling', () => {
    it('returns null for missing input', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.completion': 'output only',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBeNull();
      expect(result.output).toBe('output only');
    });

    it('returns null for missing output', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.prompt': 'input only',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('input only');
      expect(result.output).toBeNull();
    });

    it('returns null for both when no attributes', () => {
      const span = createSpan({ name: 'llm.call' });

      const result = extractSpanIO(span);
      expect(result.input).toBeNull();
      expect(result.output).toBeNull();
    });
  });
});

describe('SpanInputOutput - filtering', () => {
  it('filters spans with input or output', () => {
    const spans = [
      createSpan({
        spanId: '1',
        name: 'llm.call',
        attributes: { 'gen_ai.prompt': 'input' },
      }),
      createSpan({
        spanId: '2',
        name: 'random',
        attributes: {},
      }),
      createSpan({
        spanId: '3',
        name: 'tool.exec',
        attributes: { 'gen_ai.tool.output': 'output' },
      }),
    ];

    const spanIOData = spans
      .map(extractSpanIO)
      .filter(data => data.input || data.output);

    expect(spanIOData).toHaveLength(2);
    expect(spanIOData[0].span.spanId).toBe('1');
    expect(spanIOData[1].span.spanId).toBe('3');
  });

  it('sorts by start time', () => {
    const spans = [
      createSpan({
        spanId: '3',
        name: 'llm.call',
        startTime: '2024-01-01T00:00:03Z',
        attributes: { 'gen_ai.prompt': 'c' },
      }),
      createSpan({
        spanId: '1',
        name: 'llm.call',
        startTime: '2024-01-01T00:00:01Z',
        attributes: { 'gen_ai.prompt': 'a' },
      }),
      createSpan({
        spanId: '2',
        name: 'llm.call',
        startTime: '2024-01-01T00:00:02Z',
        attributes: { 'gen_ai.prompt': 'b' },
      }),
    ];

    const spanIOData = spans
      .map(extractSpanIO)
      .filter(data => data.input || data.output)
      .sort((a, b) =>
        new Date(a.span.startTime).getTime() - new Date(b.span.startTime).getTime()
      );

    expect(spanIOData[0].span.spanId).toBe('1');
    expect(spanIOData[1].span.spanId).toBe('2');
    expect(spanIOData[2].span.spanId).toBe('3');
  });
});

describe('SpanInputOutput - category counts', () => {
  it('counts spans by category', () => {
    const spans = [
      createSpan({ name: 'agent.run', attributes: { 'gen_ai.agent.input': 'a' } }),
      createSpan({ name: 'llm.call', attributes: { 'gen_ai.prompt': 'b' } }),
      createSpan({ name: 'llm.call', attributes: { 'gen_ai.prompt': 'c' } }),
      createSpan({ name: 'tool.exec', attributes: { 'gen_ai.tool.name': 't1', 'gen_ai.tool.input': 'd' } }),
      createSpan({ name: 'tool.exec', attributes: { 'gen_ai.tool.name': 't2', 'gen_ai.tool.input': 'e' } }),
      createSpan({ name: 'tool.exec', attributes: { 'gen_ai.tool.name': 't3', 'gen_ai.tool.input': 'f' } }),
    ];

    const spanIOData = spans.map(extractSpanIO);
    const categoryCounts = spanIOData.reduce(
      (acc, data) => {
        acc[data.category]++;
        return acc;
      },
      { agent: 0, llm: 0, tool: 0, other: 0 } as Record<string, number>
    );

    expect(categoryCounts.agent).toBe(1);
    expect(categoryCounts.llm).toBe(2);
    expect(categoryCounts.tool).toBe(3);
    expect(categoryCounts.other).toBe(0);
  });
});
