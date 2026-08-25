/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process trace tools for the comparison deep-dive agent.
 *
 * An N-run cousin of `traceJudgeTools.ts`: the same read-only `query_spans` /
 * `query_logs` over the server's /api/traces + /api/logs endpoints, but each
 * tool takes a `run` parameter ("A"–"D") so the agent can inspect ANY of the
 * runs being compared, plus an optional `caseId` to drill into one of the
 * nominated focus cases (split / all-fail) of that run. Each scope is bound to
 * its own runId (Strategy B) and service.name + time-window hints (Strategy C)
 * captured in closure — the agent can only see these runs, nothing else on the
 * cluster.
 *
 * Span summaries include `spanId` / `traceId` / `runId` so the agent can emit
 * `[label](span:<runId>:<spanId>)` citations the UI deep-links into the trace
 * view. See comparisonDeepDiveService.ts.
 */

import type { PiExtensionAPI, PiExtensionFactory } from './piSdkTypes';
import type { ComparisonRunInput, ComparisonCaseScope } from './comparisonDeepDiveService';
import { Type } from 'typebox';

/** Hard cap on spans returned per tool call (budget guardrail). */
export const MAX_SPANS_PER_CALL = 300;

function textResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }], details: obj };
}

/** The trace scope (runId + window hints) for a run, or one of its focus cases. */
function resolveScope(
  r: ComparisonRunInput,
  caseId: string | undefined
): { scope: Pick<ComparisonCaseScope, 'runId' | 'agents'>; caseId?: string; error?: string } {
  if (!caseId) return { scope: r };
  const c = (r.cases || []).find((x) => x.caseId === caseId);
  if (!c) {
    const known = (r.cases || []).map((x) => x.caseId);
    return {
      scope: r,
      error:
        `Unknown caseId '${caseId}' for run ${r.key}. ` +
        (known.length ? `Known focus cases: ${known.join(', ')}.` : 'This run has no focus cases; omit caseId.'),
    };
  }
  return { scope: c, caseId };
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
      label: 'Query OTel spans for one of the runs being compared',
      description:
        'Fetch the real OpenTelemetry spans a run emitted. Read-only and scoped to ' +
        `the runs being compared (${keys}). Optionally pass caseId (from the focus-case ` +
        'lists in the prompt) to inspect that run\'s execution of one specific test case. ' +
        'Each returned span includes spanId, traceId, runId, name, timing, status and ' +
        'gen_ai.* attributes — use spanId + runId to cite a span as ' +
        '[label](span:<runId>:<spanId>). Prefer this over the trajectory text.',
      promptSnippet: `Query the real OTel spans for one run (${keys})`,
      promptGuidelines: [
        `Always pass run: ${keys} to choose which run to inspect`,
        'Call it for EVERY run before drawing conclusions',
        'Pass caseId (from the focus-case lists) to drill into one test case of that run',
        'Pass nameFilter to narrow to spans whose name contains a substring',
        'Cite spans you actually saw as [label](span:<runId>:<spanId>) — never invent spanIds',
      ],
      parameters: Type.Object({
        run: Type.String({ description: `Which run to query: ${keys}` }),
        caseId: Type.Optional(
          Type.String({
            description:
              'Focus-case id (shown as [caseId] in the prompt) to inspect that run\'s execution of one test case. Omit for the representative case.',
          })
        ),
        nameFilter: Type.Optional(
          Type.String({ description: 'Only return spans whose name contains this substring' })
        ),
      }),
      async execute(_toolCallId: string, params: { run?: string; caseId?: string; nameFilter?: string }) {
        const r = resolve(params.run);
        if (!r) {
          return textResult({ error: `Unknown run '${params.run}'. Pass run: ${keys}.` });
        }
        const { scope, caseId, error: scopeError } = resolveScope(r, params.caseId);
        if (scopeError) return textResult({ run: r.key, error: scopeError });
        try {
          const body: Record<string, unknown> = { size: 500 };
          if (scope.runId) body.runIds = [scope.runId];
          if (scope.agents && scope.agents.length > 0) body.agents = scope.agents;
          if (!scope.runId && !(scope.agents && scope.agents.length)) {
            return textResult({ run: r.key, caseId, error: 'No runId or window hints for this scope — traces unavailable.' });
          }
          const res = await fetch(`${serverUrl}/api/traces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) return textResult({ run: r.key, caseId, error: `traces query failed: HTTP ${res.status}` });
          const data: any = await res.json();
          let spans: any[] = Array.isArray(data?.spans) ? data.spans : [];
          if (params.nameFilter) {
            const f = params.nameFilter.toLowerCase();
            spans = spans.filter((s) => String(s?.name ?? '').toLowerCase().includes(f));
          }
          const totalMatched = spans.length;
          spans = spans.slice(0, MAX_SPANS_PER_CALL);
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
            caseId,
            runId: scope.runId,
            label: r.label,
            spanCount: summary.length,
            ...(totalMatched > summary.length
              ? { truncated: `showing ${summary.length} of ${totalMatched} spans — narrow with nameFilter` }
              : {}),
            spans: summary,
            warning: data?.warning,
          });
        } catch (err: any) {
          return textResult({ run: r.key, caseId, error: `traces query error: ${err?.message ?? String(err)}` });
        }
      },
    });

    pi.registerTool({
      name: 'query_logs',
      label: 'Query logs for one of the runs being compared',
      description:
        `Fetch application/OTel logs correlated to a run. Read-only, scoped to the compared runs (${keys}). ` +
        'Optionally pass caseId (from the focus-case lists) to scope to one test case. ' +
        'Use it to find evidence for/against a root-cause or thoroughness claim.',
      promptSnippet: `Query the logs for one run (${keys})`,
      promptGuidelines: [
        `Always pass run: ${keys}`,
        'Pass caseId (from the focus-case lists) to scope to one test case of that run',
        'Pass a query substring to filter the log lines',
      ],
      parameters: Type.Object({
        run: Type.String({ description: `Which run to query: ${keys}` }),
        caseId: Type.Optional(
          Type.String({ description: 'Focus-case id to scope the logs to one test case. Omit for the representative case.' })
        ),
        query: Type.Optional(Type.String({ description: 'Optional substring/text filter for log lines' })),
      }),
      async execute(_toolCallId: string, params: { run?: string; caseId?: string; query?: string }) {
        const r = resolve(params.run);
        if (!r) return textResult({ error: `Unknown run '${params.run}'. Pass run: ${keys}.` });
        const { scope, caseId, error: scopeError } = resolveScope(r, params.caseId);
        if (scopeError) return textResult({ run: r.key, error: scopeError });
        if (!scope.runId) return textResult({ run: r.key, caseId, error: 'No runId for this scope — logs unavailable.' });
        try {
          const res = await fetch(`${serverUrl}/api/logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: scope.runId, query: params.query, size: 200 }),
          });
          if (!res.ok) return textResult({ run: r.key, caseId, error: `logs query failed: HTTP ${res.status}` });
          const data: any = await res.json();
          return textResult({ run: r.key, caseId, runId: scope.runId, ...data });
        } catch (err: any) {
          return textResult({ run: r.key, caseId, error: `logs query error: ${err?.message ?? String(err)}` });
        }
      },
    });
  };
}
