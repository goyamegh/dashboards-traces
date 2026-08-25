/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison Routes — agentic deep-dive over 2–4 runs.
 *
 * POST /api/comparison/deep-dive
 *   body: { reportIds: [reportIdA, reportIdB, ...],   // 2–4, one representative-case report per run
 *           cases?: [{ id, name, verdicts, durationsMs?, reportIds? }, ...],  // shared-case matrix
 *           modelId? }
 *   resp: { markdown, modelId, durationMs,
 *           runs: [{ key, reportId, runId, serviceName, startedAt, endedAt, testCaseId }] }
 *
 * Resolves each run's trace identity SERVER-SIDE (serviceName from the live
 * agent config, wall-clock window from the saved report) — the frontend
 * DEFAULT_CONFIG is static and wouldn't know dynamically-added agents — then
 * runs the in-process comparison agent (pi SDK + run-scoped trace tools).
 *
 * When the shared-case matrix is supplied, a DETERMINISTIC prompt prefix is
 * computed in code (agreement partition, per-category pass rates, split /
 * all-fail one-liners — comparisonContextBuilder.ts) and a handful of "focus"
 * cases (split first, then all-fail) get their per-run reports resolved so the
 * agent can drill into their spans via query_spans({ run, caseId }).
 *
 * The returned `runs[]` give the frontend exactly the window-agent hints it
 * needs to deep-link span citations into the Traces tab — one entry per
 * resolved report (representative + focus cases), each tagged with its
 * testCaseId.
 */

import { Router, Request, Response } from 'express';
import { loadConfigSync } from '@/lib/config/index';
import { getStorageModule } from '@/server/adapters';
import {
  generateComparisonDeepDive,
  MIN_COMPARED_RUNS,
  MAX_COMPARED_RUNS,
  type ComparisonRunInput,
  type ComparisonCaseScope,
} from '@/server/services/comparisonDeepDiveService';
import {
  buildComparisonContext,
  type CaseVerdict,
  type ComparisonCaseInput,
} from '@/server/services/comparisonContextBuilder';
import { debug } from '@/lib/debug';

const router = Router();

const PROTOCOL_TO_SERVICE: Record<string, string> = {
  'claude-code': 'claude-code-agent',
  kiro: 'kiro-agent',
  pi: 'pi-agent',
  'agui-streaming': 'observio-sample-agent',
};

const SLACK_MS = 60_000;
const FALLBACK_LOOKBACK_MS = 30 * 60_000;

/** Resolve the OTel service.name an agent emits spans under. */
function resolveServiceName(report: any): string | undefined {
  const agent = report?.agentKey
    ? loadConfigSync().agents.find((a) => a.key === report.agentKey)
    : undefined;
  return (
    agent?.traceServiceName ||
    agent?.connectorConfig?.env?.OTEL_SERVICE_NAME ||
    (report?.connectorProtocol && PROTOCOL_TO_SERVICE[report.connectorProtocol]) ||
    (report?.agentKey ? `${report.agentKey}-agent` : undefined)
  );
}

/** Derive the Strategy-C window + serviceName hint for a run (mirrors RunDetailsContent). */
function resolveWindow(report: any): {
  serviceName?: string;
  startedAt: number;
  endedAt: number;
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number }>;
} {
  const serviceName = resolveServiceName(report);
  // `report.timestamp` is NOT reliably the run END — trace-mode / subprocess
  // reports (Claude Code) are persisted at run START, so an end-anchored
  // backward window lands BEFORE the run and matches no spans (deep-dive then
  // reports "no traces"). Anchor SYMMETRICALLY around the timestamp by
  // ±(duration + slack) so the window covers the run whether the timestamp is
  // its start or end. Mirrors services/traces/judgeAgentsHints.ts.
  const ts = Date.parse(report?.timestamp || '') || Date.now();
  const durationMs = report?.performanceMetrics?.durationMs ?? 0;
  const span = durationMs > 0 ? durationMs + SLACK_MS : FALLBACK_LOOKBACK_MS;
  const startedAt = ts - span;
  const endedAt = ts + span;
  const agents = serviceName
    ? [{ serviceName, startedAt, endedAt }]
    : undefined;
  return { serviceName, startedAt, endedAt, agents };
}

function extractToolNames(report: any): string[] {
  const traj = Array.isArray(report?.trajectory) ? report.trajectory : [];
  return traj
    .filter((s: any) => s?.type === 'action' && s?.toolName)
    .map((s: any) => s.toolName as string);
}

function extractFinalOutput(report: any): string | undefined {
  if (typeof report?.finalOutput === 'string' && report.finalOutput.trim()) return report.finalOutput;
  if (typeof report?.output === 'string' && report.output.trim()) return report.output;
  const traj = Array.isArray(report?.trajectory) ? report.trajectory : [];
  for (let i = traj.length - 1; i >= 0; i--) {
    const s = traj[i];
    const text = s?.content ?? s?.text ?? s?.output;
    if (typeof text === 'string' && text.trim().length > 0) return text;
  }
  return undefined;
}

const VALID_VERDICTS = new Set<CaseVerdict>(['pass', 'fail', 'error', 'missing']);
const MAX_CASES = 1000;

/** Lenient parse of the optional shared-case matrix; drops malformed rows. */
function parseCases(raw: unknown, runCount: number): ComparisonCaseInput[] {
  if (!Array.isArray(raw)) return [];
  const cases: ComparisonCaseInput[] = [];
  for (const c of raw.slice(0, MAX_CASES)) {
    if (!c || typeof c !== 'object') continue;
    const { id, name, verdicts, durationsMs, reportIds } = c as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    if (!Array.isArray(verdicts) || verdicts.length !== runCount) continue;
    if (!verdicts.every((v) => VALID_VERDICTS.has(v as CaseVerdict))) continue;
    cases.push({
      id,
      name,
      verdicts: verdicts as CaseVerdict[],
      durationsMs: Array.isArray(durationsMs)
        ? durationsMs.map((d) => (typeof d === 'number' ? d : null)).slice(0, runCount)
        : undefined,
      reportIds: Array.isArray(reportIds)
        ? reportIds.map((r) => (typeof r === 'string' ? r : null)).slice(0, runCount)
        : undefined,
    });
  }
  return cases;
}

router.post('/api/comparison/deep-dive', async (req: Request, res: Response) => {
  const { reportIds, modelId, cases: rawCases } = (req.body || {}) as {
    reportIds?: unknown;
    modelId?: string;
    cases?: unknown;
  };
  if (
    !Array.isArray(reportIds) ||
    reportIds.length < MIN_COMPARED_RUNS ||
    reportIds.length > MAX_COMPARED_RUNS ||
    !reportIds.every((x) => typeof x === 'string')
  ) {
    return res.status(400).json({
      error: `reportIds must be an array of ${MIN_COMPARED_RUNS}-${MAX_COMPARED_RUNS} report id strings`,
    });
  }

  try {
    const storage = getStorageModule();
    const reports = await Promise.all((reportIds as string[]).map((id) => storage.runs.getById(id)));
    const missing = reportIds.filter((_, i) => !reports[i]);
    if (missing.length) {
      return res.status(404).json({ error: `report(s) not found: ${missing.join(', ')}` });
    }

    const keys = ['A', 'B', 'C', 'D'].slice(0, reportIds.length);
    const runInputs: ComparisonRunInput[] = [];
    const runMeta: Array<{
      key: string;
      reportId: string;
      runId?: string;
      serviceName?: string;
      startedAt: number;
      endedAt: number;
      testCaseId?: string;
    }> = [];

    reports.forEach((report: any, i) => {
      const win = resolveWindow(report);
      runInputs.push({
        key: keys[i],
        label: report.agentName || report.agentKey || `Run ${keys[i]}`,
        runId: report.runId,
        agents: win.agents,
        passFailStatus: report.passFailStatus,
        accuracy: report?.metrics?.accuracy,
        toolNames: extractToolNames(report),
        durationMs: report?.performanceMetrics?.durationMs,
        finalOutput: extractFinalOutput(report),
      });
      runMeta.push({
        key: keys[i],
        reportId: reportIds[i] as string,
        runId: report.runId,
        serviceName: win.serviceName,
        startedAt: win.startedAt,
        endedAt: win.endedAt,
        testCaseId: report.testCaseId,
      });
    });

    // Deterministic context prefix + focus-case nomination (code, not LLM).
    const cases = parseCases(rawCases, reportIds.length);
    const context = buildComparisonContext(
      runInputs.map((r) => ({ key: r.key, label: r.label })),
      cases
    );

    // Resolve the focus cases' per-run reports so the agent can drill into
    // their spans via query_spans({ run, caseId }). Bounded: ≤ maxFocusCases
    // × runCount report fetches.
    const focusCases = cases.filter((c) => context.focusCaseIds.includes(c.id));
    await Promise.all(
      focusCases.map(async (c) => {
        await Promise.all(
          runInputs.map(async (input, i) => {
            const focusReportId = c.reportIds?.[i];
            if (!focusReportId) return;
            try {
              const focusReport: any = await storage.runs.getById(focusReportId);
              if (!focusReport) return;
              const win = resolveWindow(focusReport);
              const scope: ComparisonCaseScope = {
                caseId: c.id,
                name: c.name,
                runId: focusReport.runId,
                agents: win.agents,
              };
              input.cases = [...(input.cases || []), scope];
              runMeta.push({
                key: input.key,
                reportId: focusReportId,
                runId: focusReport.runId,
                serviceName: win.serviceName,
                startedAt: win.startedAt,
                endedAt: win.endedAt,
                testCaseId: focusReport.testCaseId ?? c.id,
              });
            } catch (err) {
              debug('CompareDeepDiveAPI', 'focus-case report fetch failed:', focusReportId, err);
            }
          })
        );
      })
    );

    debug(
      'CompareDeepDiveAPI',
      'reports:', reportIds.join(','),
      'services:', runMeta.map((m) => m.serviceName).join(','),
      'cases:', cases.length,
      'focus:', context.focusCaseIds.join(',')
    );

    const result = await generateComparisonDeepDive({
      runs: runInputs,
      modelId,
      contextPrefix: context.prefixText,
    });
    return res.json({ ...result, runs: runMeta });
  } catch (err: any) {
    console.error('[CompareDeepDiveAPI] error:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

export default router;
