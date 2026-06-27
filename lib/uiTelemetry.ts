/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fire-and-forget UI usage telemetry. Lets us understand load/usage patterns
 * (e.g. which comparison search scope is used, how often, result counts)
 * without a heavyweight analytics dependency. Never blocks the UI or throws.
 */
export function recordUiEvent(event: string, props?: Record<string, unknown>): void {
  try {
    void fetch('/api/telemetry/ui-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, props }),
      keepalive: true,
    }).catch(() => {
      /* telemetry is best-effort */
    });
  } catch {
    /* never let telemetry break the UI */
  }
}
