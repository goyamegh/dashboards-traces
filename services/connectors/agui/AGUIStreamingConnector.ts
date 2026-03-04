/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AG-UI Streaming Connector
 * Handles communication with agents using the AG-UI protocol over SSE
 */

import type { TrajectoryStep } from '@/types';
import type { AGUIEvent } from '@/types/agui';
import { BaseConnector } from '@/services/connectors/base/BaseConnector';
import type {
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
} from '@/services/connectors/types';
import { consumeSSEStream } from '@/services/agent/sseStream';
import { buildAgentPayload, buildMultiTurnPayload, AgentRequestPayload, AgentMessage } from '@/services/agent/payloadBuilder';
import { AGUIToTrajectoryConverter, computeTrajectoryFromRawEvents } from '@/services/agent/aguiConverter';
import {
  resolveMultiTurnOptions,
  defaultDetectInterrupt,
  defaultBuildApprovalResponse,
} from './interruptHandlers';
import type { MultiTurnOptions, InterruptInfo } from './interruptHandlers';

/**
 * AG-UI Streaming Connector
 * Uses Server-Sent Events (SSE) to stream agent responses in AG-UI format
 */
export class AGUIStreamingConnector extends BaseConnector {
  readonly type = 'agui-streaming' as const;
  readonly name = 'AG-UI Streaming';
  readonly supportsStreaming = true;

  /**
   * Build AG-UI payload from standard request
   */
  buildPayload(request: ConnectorRequest): AgentRequestPayload {
    return buildAgentPayload(
      request.testCase,
      request.modelId,
      request.threadId,
      request.runId
    );
  }

  /**
   * Execute the request using SSE streaming.
   * When multiTurnOptions.enabled is true, handles tool approval interrupts
   * by auto-responding and re-streaming within the same turn.
   */
  async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    const multiTurnOpts = resolveMultiTurnOptions(request.multiTurnOptions);

    // Use pre-built payload from hook if available, otherwise build fresh
    const payload = request.payload || this.buildPayload(request);
    const headers = this.buildAuthHeaders(auth);
    const trajectory: TrajectoryStep[] = [];
    const rawEvents: AGUIEvent[] = [];

    this.debug('Executing AG-UI streaming request');

    // If multi-turn interrupt handling is not enabled, single-pass execution
    if (!multiTurnOpts.enabled) {
      return this.executeSinglePass(endpoint, payload, headers, trajectory, rawEvents, onProgress, onRawEvent);
    }

    // Multi-turn interrupt handling loop
    return this.executeWithInterruptHandling(
      endpoint, payload, headers, trajectory, rawEvents,
      multiTurnOpts, request, onProgress, onRawEvent
    );
  }

  /**
   * Single-pass execution (original behavior, no interrupt handling)
   */
  private async executeSinglePass(
    endpoint: string,
    payload: any,
    headers: Record<string, string>,
    trajectory: TrajectoryStep[],
    rawEvents: AGUIEvent[],
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    const converter = new AGUIToTrajectoryConverter();

    await consumeSSEStream(
      endpoint,
      payload,
      (event: AGUIEvent) => {
        rawEvents.push(event);
        onRawEvent?.(event);
        const steps = converter.processEvent(event);
        steps.forEach(step => {
          trajectory.push(step);
          onProgress?.(step);
        });
      },
      headers
    );

    const runId = converter.getRunId();
    this.debug('Stream completed. RunId:', runId, 'Steps:', trajectory.length);

    return {
      trajectory,
      runId,
      rawEvents,
      metadata: {
        threadId: converter.getThreadId(),
      },
    };
  }

  /**
   * Execute with an inner loop that handles tool approval interrupts.
   * After each SSE stream completes, checks RunFinishedEvent.result for interrupts.
   * If detected, auto-responds and re-streams until no more interrupts or maxTurns reached.
   */
  private async executeWithInterruptHandling(
    endpoint: string,
    initialPayload: any,
    headers: Record<string, string>,
    trajectory: TrajectoryStep[],
    rawEvents: AGUIEvent[],
    opts: MultiTurnOptions,
    request: ConnectorRequest,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    const detectInterrupt = opts.detectInterrupt || defaultDetectInterrupt;
    const buildResponse = opts.buildResponse || defaultBuildApprovalResponse;

    let currentPayload = initialPayload;
    let threadId: string | null = initialPayload.threadId || null;
    let latestRunId: string | null = null;
    let interruptCount = 0;
    const messages: AgentMessage[] = [...(initialPayload.messages || [])];

    for (let subTurn = 0; subTurn < opts.maxTurns; subTurn++) {
      const converter = new AGUIToTrajectoryConverter();

      await consumeSSEStream(
        endpoint,
        currentPayload,
        (event: AGUIEvent) => {
          rawEvents.push(event);
          onRawEvent?.(event);
          const steps = converter.processEvent(event);
          steps.forEach(step => {
            trajectory.push(step);
            onProgress?.(step);
          });
        },
        headers
      );

      latestRunId = converter.getRunId();
      threadId = converter.getThreadId() || threadId;

      // Check for interrupt in RunFinishedEvent.result
      const result = converter.getRunFinishedResult();
      const interrupt: InterruptInfo | null = detectInterrupt(result);

      if (!interrupt) {
        // No interrupt - normal completion
        this.debug('Stream completed (no interrupt). RunId:', latestRunId, 'Steps:', trajectory.length);
        break;
      }

      // Interrupt detected - build response
      interruptCount++;
      this.debug('Interrupt detected:', interrupt.reason, `(count: ${interruptCount})`);

      const responseMsg = buildResponse(interrupt, opts.interruptPolicy);
      if (!responseMsg) {
        // Policy is 'skip' - stop the loop
        this.debug('Interrupt policy is skip, stopping');
        break;
      }

      // Accumulate messages for the multi-turn payload
      // Add assistant response placeholder (extracted from last response step)
      const lastResponseStep = [...trajectory].reverse().find(s => s.type === 'response' || s.type === 'assistant');
      if (lastResponseStep) {
        messages.push({
          id: `assistant-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          role: 'assistant',
          content: lastResponseStep.content,
        });
      }
      messages.push(responseMsg);

      // Build next payload preserving threadId
      currentPayload = buildMultiTurnPayload(
        messages,
        threadId || undefined,
        undefined, // new runId per sub-turn
        request.testCase.context || [],
        request.testCase.tools
      );
    }

    return {
      trajectory,
      runId: latestRunId,
      rawEvents,
      metadata: {
        threadId,
        interruptCount,
      },
    };
  }

  /**
   * Parse raw AG-UI events into trajectory steps
   * Used for re-processing stored raw events
   */
  parseResponse(rawEvents: AGUIEvent[]): TrajectoryStep[] {
    return computeTrajectoryFromRawEvents(rawEvents);
  }

  /**
   * Health check for AG-UI endpoint
   * Tries to connect without sending a full request
   */
  async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    try {
      const headers = this.buildAuthHeaders(auth);
      // For AG-UI endpoints, we can't really do a health check without
      // making a full request, so just check if the endpoint is reachable
      const response = await fetch(endpoint, {
        method: 'OPTIONS',
        headers,
      });
      // Accept any response that isn't a network error
      return true;
    } catch (error) {
      this.error('Health check failed:', error);
      return false;
    }
  }
}

/**
 * Default instance for convenience
 */
export const aguiStreamingConnector = new AGUIStreamingConnector();
