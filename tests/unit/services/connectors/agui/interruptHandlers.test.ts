/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  defaultDetectInterrupt,
  defaultBuildApprovalResponse,
  resolveMultiTurnOptions,
  DEFAULT_MULTI_TURN_OPTIONS,
} from '@/services/connectors/agui/interruptHandlers';
import type { InterruptInfo, InterruptPolicy, MultiTurnOptions } from '@/services/connectors/agui/interruptHandlers';

describe('interruptHandlers', () => {
  describe('defaultDetectInterrupt', () => {
    describe('returns null for non-interrupt inputs', () => {
      it('should return null for null input', () => {
        expect(defaultDetectInterrupt(null)).toBeNull();
      });

      it('should return null for undefined input', () => {
        expect(defaultDetectInterrupt(undefined)).toBeNull();
      });

      it('should return null for a string input', () => {
        expect(defaultDetectInterrupt('some string')).toBeNull();
      });

      it('should return null for a number input', () => {
        expect(defaultDetectInterrupt(42)).toBeNull();
      });

      it('should return null for a boolean input', () => {
        expect(defaultDetectInterrupt(true)).toBeNull();
      });

      it('should return null for an empty object', () => {
        expect(defaultDetectInterrupt({})).toBeNull();
      });

      it('should return null for a normal result without interrupt markers', () => {
        expect(defaultDetectInterrupt({ outcome: 'success', data: 'some data' })).toBeNull();
      });

      it('should return null for a result with unrelated type field', () => {
        expect(defaultDetectInterrupt({ type: 'response', content: 'hello' })).toBeNull();
      });

      it('should return null when requiresApproval is false', () => {
        expect(defaultDetectInterrupt({ requiresApproval: false, reason: 'nope' })).toBeNull();
      });

      it('should return null when requiresApproval is a truthy non-boolean value', () => {
        expect(defaultDetectInterrupt({ requiresApproval: 'yes' })).toBeNull();
      });
    });

    describe('Pulsar-style interrupt (outcome: "interrupt")', () => {
      it('should detect interrupt with reason and toolCalls', () => {
        const result = {
          outcome: 'interrupt',
          reason: 'Tool needs approval',
          toolCalls: [{ id: 'tc-1', name: 'search_logs', args: { query: 'error' } }],
        };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.reason).toBe('Tool needs approval');
        expect(info!.toolCalls).toEqual([{ id: 'tc-1', name: 'search_logs', args: { query: 'error' } }]);
        expect(info!.rawResult).toBe(result);
      });

      it('should use default reason when reason is not provided', () => {
        const result = { outcome: 'interrupt' };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.reason).toBe('Tool approval required');
      });

      it('should set toolCalls to undefined when toolCalls is not an array', () => {
        const result = { outcome: 'interrupt', reason: 'test', toolCalls: 'not-an-array' };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.toolCalls).toBeUndefined();
      });

      it('should handle empty toolCalls array', () => {
        const result = { outcome: 'interrupt', reason: 'test', toolCalls: [] };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.toolCalls).toEqual([]);
      });
    });

    describe('generic interrupt (type: "tool_approval")', () => {
      it('should detect tool_approval interrupt with message', () => {
        const result = {
          type: 'tool_approval',
          message: 'Please approve tool execution',
          toolCalls: [{ id: 'tc-2', name: 'run_query' }],
        };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.reason).toBe('Please approve tool execution');
        expect(info!.toolCalls).toEqual([{ id: 'tc-2', name: 'run_query' }]);
        expect(info!.rawResult).toBe(result);
      });

      it('should fall back to reason when message is not provided', () => {
        const result = { type: 'tool_approval', reason: 'Needs human review' };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.reason).toBe('Needs human review');
      });

      it('should fall back to type name when neither message nor reason is provided', () => {
        const result = { type: 'tool_approval' };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.reason).toBe('tool_approval');
      });
    });

    describe('generic interrupt (type: "human_input_required")', () => {
      it('should detect human_input_required interrupt', () => {
        const result = {
          type: 'human_input_required',
          message: 'User confirmation needed',
        };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.reason).toBe('User confirmation needed');
        expect(info!.rawResult).toBe(result);
      });

      it('should fall back to type name when no message or reason', () => {
        const result = { type: 'human_input_required' };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.reason).toBe('human_input_required');
      });

      it('should set toolCalls to undefined when not present', () => {
        const result = { type: 'human_input_required', message: 'confirm' };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.toolCalls).toBeUndefined();
      });
    });

    describe('explicit interrupt (requiresApproval: true)', () => {
      it('should detect when requiresApproval is true', () => {
        const result = {
          requiresApproval: true,
          reason: 'Dangerous operation',
          toolCalls: [{ id: 'tc-3', name: 'delete_index', args: { index: 'test' } }],
        };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.reason).toBe('Dangerous operation');
        expect(info!.toolCalls).toEqual([{ id: 'tc-3', name: 'delete_index', args: { index: 'test' } }]);
        expect(info!.rawResult).toBe(result);
      });

      it('should use default reason when reason is not provided', () => {
        const result = { requiresApproval: true };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.reason).toBe('Approval required');
      });

      it('should set toolCalls to undefined when toolCalls is not an array', () => {
        const result = { requiresApproval: true, toolCalls: { id: 'tc-1' } };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        expect(info!.toolCalls).toBeUndefined();
      });
    });

    describe('priority order', () => {
      it('should match outcome=interrupt before type checks', () => {
        const result = {
          outcome: 'interrupt',
          type: 'tool_approval',
          reason: 'from outcome',
          message: 'from type',
        };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        // outcome branch uses result.reason, not result.message
        expect(info!.reason).toBe('from outcome');
      });

      it('should match type before requiresApproval', () => {
        const result = {
          type: 'tool_approval',
          requiresApproval: true,
          message: 'from type',
          reason: 'from requiresApproval',
        };

        const info = defaultDetectInterrupt(result);

        expect(info).not.toBeNull();
        // type branch uses message first
        expect(info!.reason).toBe('from type');
      });
    });
  });

  describe('defaultBuildApprovalResponse', () => {
    const sampleInterrupt: InterruptInfo = {
      reason: 'Tool approval required',
      toolCalls: [{ id: 'tc-1', name: 'search_logs' }],
      rawResult: { outcome: 'interrupt' },
    };

    it('should return null when policy is "skip"', () => {
      const response = defaultBuildApprovalResponse(sampleInterrupt, 'skip');
      expect(response).toBeNull();
    });

    describe('auto-approve policy', () => {
      it('should return approval message with role "user"', () => {
        const response = defaultBuildApprovalResponse(sampleInterrupt, 'auto-approve');

        expect(response).not.toBeNull();
        expect(response!.role).toBe('user');
        expect(response!.content).toBe('Approved. Please proceed with the tool calls.');
      });

      it('should generate a unique id starting with "interrupt-resp-"', () => {
        const response = defaultBuildApprovalResponse(sampleInterrupt, 'auto-approve');

        expect(response).not.toBeNull();
        expect(response!.id).toMatch(/^interrupt-resp-\d+-[a-z0-9]+$/);
      });

      it('should generate different ids on successive calls', () => {
        const response1 = defaultBuildApprovalResponse(sampleInterrupt, 'auto-approve');
        const response2 = defaultBuildApprovalResponse(sampleInterrupt, 'auto-approve');

        expect(response1).not.toBeNull();
        expect(response2).not.toBeNull();
        // IDs include Date.now() and random component, so they should differ
        // (in rare cases Date.now() could be the same, but the random part should differ)
        expect(response1!.id).not.toBe(response2!.id);
      });
    });

    describe('auto-reject policy', () => {
      it('should return rejection message with role "user"', () => {
        const response = defaultBuildApprovalResponse(sampleInterrupt, 'auto-reject');

        expect(response).not.toBeNull();
        expect(response!.role).toBe('user');
        expect(response!.content).toBe('Rejected. Do not execute the proposed tool calls.');
      });

      it('should generate a unique id starting with "interrupt-resp-"', () => {
        const response = defaultBuildApprovalResponse(sampleInterrupt, 'auto-reject');

        expect(response).not.toBeNull();
        expect(response!.id).toMatch(/^interrupt-resp-\d+-[a-z0-9]+$/);
      });
    });
  });

  describe('resolveMultiTurnOptions', () => {
    it('should return a copy of defaults when called with no arguments', () => {
      const resolved = resolveMultiTurnOptions();

      expect(resolved).toEqual(DEFAULT_MULTI_TURN_OPTIONS);
      // Ensure it is a copy, not the same reference
      expect(resolved).not.toBe(DEFAULT_MULTI_TURN_OPTIONS);
    });

    it('should return a copy of defaults when called with undefined', () => {
      const resolved = resolveMultiTurnOptions(undefined);

      expect(resolved).toEqual(DEFAULT_MULTI_TURN_OPTIONS);
      expect(resolved).not.toBe(DEFAULT_MULTI_TURN_OPTIONS);
    });

    it('should merge partial options over defaults', () => {
      const resolved = resolveMultiTurnOptions({ enabled: true, maxTurns: 5 });

      expect(resolved.enabled).toBe(true);
      expect(resolved.maxTurns).toBe(5);
      expect(resolved.interruptPolicy).toBe('auto-approve'); // from defaults
    });

    it('should allow overriding interruptPolicy', () => {
      const resolved = resolveMultiTurnOptions({ interruptPolicy: 'auto-reject' });

      expect(resolved.interruptPolicy).toBe('auto-reject');
      expect(resolved.enabled).toBe(false); // from defaults
      expect(resolved.maxTurns).toBe(10); // from defaults
    });

    it('should allow providing custom detectInterrupt function', () => {
      const customDetect = jest.fn().mockReturnValue(null);
      const resolved = resolveMultiTurnOptions({ detectInterrupt: customDetect });

      expect(resolved.detectInterrupt).toBe(customDetect);
      expect(resolved.enabled).toBe(false); // from defaults
    });

    it('should allow providing custom buildResponse function', () => {
      const customBuild = jest.fn().mockReturnValue(null);
      const resolved = resolveMultiTurnOptions({ buildResponse: customBuild });

      expect(resolved.buildResponse).toBe(customBuild);
    });

    it('should allow overriding all fields at once', () => {
      const customDetect = jest.fn();
      const customBuild = jest.fn();

      const resolved = resolveMultiTurnOptions({
        enabled: true,
        maxTurns: 3,
        interruptPolicy: 'skip',
        detectInterrupt: customDetect,
        buildResponse: customBuild,
      });

      expect(resolved).toEqual({
        enabled: true,
        maxTurns: 3,
        interruptPolicy: 'skip',
        detectInterrupt: customDetect,
        buildResponse: customBuild,
      });
    });

    it('should not include detectInterrupt or buildResponse by default', () => {
      const resolved = resolveMultiTurnOptions();

      expect(resolved.detectInterrupt).toBeUndefined();
      expect(resolved.buildResponse).toBeUndefined();
    });
  });

  describe('DEFAULT_MULTI_TURN_OPTIONS', () => {
    it('should have enabled set to false', () => {
      expect(DEFAULT_MULTI_TURN_OPTIONS.enabled).toBe(false);
    });

    it('should have maxTurns set to 10', () => {
      expect(DEFAULT_MULTI_TURN_OPTIONS.maxTurns).toBe(10);
    });

    it('should have interruptPolicy set to auto-approve', () => {
      expect(DEFAULT_MULTI_TURN_OPTIONS.interruptPolicy).toBe('auto-approve');
    });
  });
});
