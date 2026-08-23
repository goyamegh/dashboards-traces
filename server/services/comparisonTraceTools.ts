/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process trace tools for the comparison deep-dive agent.
 *
 * A two-run cousin of `traceJudgeTools.ts`: the same read-only `query_spans` /
 * `query_logs` over the server's /api/traces + /api/logs endpoints, but each
 * tool takes a `run: "A" | "B"` parameter so the agent can inspect EITHER of
 * the two runs being compared. Each run is scoped to its own runId (Strategy B)
 * and service.name + time-window hints (Strategy C) captured in closure — the
 * agent can only see these two runs, nothing else on the cluster.
 *
 * Span summaries include `spanId` / `traceId` / `runId` so the agent can emit
 * `[label](span:<runId>:<spanId>)` citations the UI deep-links into the trace
 * view. See comparisonDeepDiveService.ts.
 */

import type { PiExtensionAPI, PiExtensionFactory } from './piSdkTypes';
import type { ComparisonRunInput } from './comparisonDeepDiveService';
import { Type } from 'typebox';

function textResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }], details: obj };
}

export function createComparisonTraceExtension(
  runs: ComparisonRunInput[],
  serverUrl: string
): PiExtensionFactory {
  const byKey = new Map(runs.map((r) => [r.key.toUpperCase(), r]));
  const keys = runs.map((r) => `"${r.key.toUpperCase()}"`).join(' or ');

  const resolve = (run: unknown): ComparisonRunInput | undefined =>
    byKey.get(String(run ?? '').trim().toUpperCase());

  return (pi: PiExtensionAPI) => {
    pi.registerTool({
      name: 'query_spans',
      label: 'Query OTel spans for one of the two runs being compared',
      description:
        'Fetch the real OpenTelemetry spans a run emitted. Read-only and scoped to ' +
        `the two runs being compared (${keys}). Each returned span includes spanId, ` +
        'traceId, runId, name, timing, status and gen_ai.* attributes — use spanId + runId ' +
        'to cite a span as [label](span:<runId>:<spanId>). Prefer this over the trajectory text.',
      promptSnippet: 'Query the real OTel spans for run A or B',
      promptGuidelines: [
        'Always pass run: "A" or "B" to choose which run to inspect',
        'Call it for BOTH runs before drawing conclusions',
        'Pass nameFilter to narrow to spans whose name contains a substring',
        'Cite spans you actually saw as [label](span:<runId>:<spanId>) — never invent spanIds',
      ],
      parameters: Type.Object({
        run: Type.String({ description: `Which run to query: ${keys}` }),
        nameFilter: Type.Optional(
          Type.String({ description: 'Only return spans whose name contains this substring' })
        ),
      }),
      async execute(_toolCallId: string, params: { run?: string; nameFilter?: string }) {
        const r = resolve(params.run);
        if (!r) {
          return textResult({ error: `Unknown run '${params.run}'. Pass run: ${keys}.` });
        }
        try {
          const body: Record<string, unknown> = { size: 500 };
          if (r.runId) body.runIds = [r.runId];
          if (r.agents && r.agents.length > 0) body.agents = r.agents;
          if (!r.runId && !(r.agents && r.agents.length)) {
            return textResult({ run: r.key, error: 'No runId or window hints for this run — traces unavailable.' });
          }
          const res = await fetch(`${serverUrl}/api/traces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) return textResult({ run: r.key, error: `traces query failed: HTTP ${res.status}` });
          const data: any = await res.json();
          let spans: any[] = Array.isArray(data?.spans) ? data.spans : [];
          if (params.nameFilter) {
            const f = params.nameFilter.toLowerCase();
            spans = spans.filter((s) => String(s?.name ?? '').toLowerCase().includes(f));
          }
          const summary = spans.map((s) => ({
            spanId: s.spanId,
            traceId: s.traceId,
            name: s.name,
            startTime: s.startTime,
            endTime: s.endTime,
            status: s.status,
            attributes: s.attributes,
          }));
          return textResult({
            run: r.key,
            runId: r.runId,
            label: r.label,
            spanCount: summary.length,
            spans: summary,
            warning: data?.warning,
          });
        } catch (err: any) {
          return textResult({ run: r.key, error: `traces query error: ${err?.message ?? String(err)}` });
        }
      },
    });

    pi.registerTool({
      name: 'query_logs',
      label: 'Query logs for one of the two runs being compared',
      description:
        `Fetch application/OTel logs correlated to a run. Read-only, scoped to the two runs (${keys}). ` +
        'Use it to find evidence for/against a root-cause or thoroughness claim.',
      promptSnippet: 'Query the logs for run A or B',
      promptGuidelines: [
        'Always pass run: "A" or "B"',
        'Pass a query substring to filter the log lines',
      ],
      parameters: Type.Object({
        run: Type.String({ description: `Which run to query: ${keys}` }),
        query: Type.Optional(Type.String({ description: 'Optional substring/text filter for log lines' })),
      }),
      async execute(_toolCallId: string, params: { run?: string; query?: string }) {
        const r = resolve(params.run);
        if (!r) return textResult({ error: `Unknown run '${params.run}'. Pass run: ${keys}.` });
        if (!r.runId) return textResult({ run: r.key, error: 'No runId for this run — logs unavailable.' });
        try {
          const res = await fetch(`${serverUrl}/api/logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: r.runId, query: params.query, size: 200 }),
          });
          if (!res.ok) return textResult({ run: r.key, error: `logs query failed: HTTP ${res.status}` });
          const data: any = await res.json();
          return textResult({ run: r.key, runId: r.runId, ...data });
        } catch (err: any) {
          return textResult({ run: r.key, error: `logs query error: ${err?.message ?? String(err)}` });
        }
      },
    });
  };
}
