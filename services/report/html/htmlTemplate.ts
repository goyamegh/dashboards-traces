/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReportData, ReportRunData, FormatterOptions } from '@/services/report/types';
import type { TestCaseComparisonRow, TrajectoryStep, EvaluationReport, ImprovementStrategy } from '@/types';

// ============ Utility Functions ============

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a date string for display
 */
function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format a percentage value
 */
function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

// ============ CSS Styles ============

const CSS_STYLES = `
  :root {
    --bg: #0f1419;
    --bg-card: #1a1f2e;
    --bg-table-header: #252b3b;
    --text: #e0e6ed;
    --text-muted: #8899a6;
    --border: #2f3b4e;
    --accent: #0088cc;
    --green: #22c55e;
    --red: #ef4444;
    --yellow: #eab308;
    --purple: #a855f7;
    --blue: #3b82f6;
    --gray: #6b7280;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 2rem;
  }

  .container { max-width: 1200px; margin: 0 auto; }

  h1 { font-size: 1.75rem; font-weight: 600; margin-bottom: 0.25rem; }
  h2 { font-size: 1.25rem; font-weight: 600; margin: 2rem 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
  h3 { font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem; }

  .header-meta { color: var(--text-muted); font-size: 0.85rem; }

  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
  th { background: var(--bg-table-header); text-align: left; padding: 0.625rem 0.75rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); border-bottom: 1px solid var(--border); }
  td { padding: 0.625rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.875rem; }
  tr:hover { background: rgba(255,255,255,0.02); }

  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1.25rem; margin-bottom: 1.5rem; }

  .badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
  .badge-passed { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-failed { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge-label { background: rgba(59,130,246,0.15); color: var(--blue); margin-right: 0.25rem; }

  .step { margin-bottom: 0.75rem; padding: 0.75rem; border-radius: 0.375rem; border-left: 3px solid; }
  .step-thinking { border-color: var(--gray); background: rgba(107,114,128,0.1); }
  .step-action { border-color: var(--blue); background: rgba(59,130,246,0.1); }
  .step-tool_result { border-color: var(--green); background: rgba(34,197,94,0.1); }
  .step-tool_result.failed { border-color: var(--red); background: rgba(239,68,68,0.1); }
  .step-response { border-color: var(--purple); background: rgba(168,85,247,0.1); }
  .step-assistant { border-color: var(--accent); background: rgba(0,136,204,0.1); }
  .step-type { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 0.25rem; }
  .step-content { font-size: 0.8125rem; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }

  details { margin-bottom: 0.75rem; }
  summary { cursor: pointer; padding: 0.625rem; background: var(--bg-table-header); border-radius: 0.375rem; font-weight: 500; font-size: 0.875rem; }
  summary:hover { background: rgba(37,43,59,0.8); }
  details[open] summary { border-radius: 0.375rem 0.375rem 0 0; }
  details > .details-content { padding: 1rem; border: 1px solid var(--border); border-top: none; border-radius: 0 0 0.375rem 0.375rem; }

  .strategy { margin-bottom: 0.5rem; padding: 0.5rem 0.75rem; border-radius: 0.375rem; font-size: 0.8125rem; }
  .strategy-high { background: rgba(239,68,68,0.1); border-left: 3px solid var(--red); }
  .strategy-medium { background: rgba(234,179,8,0.1); border-left: 3px solid var(--yellow); }
  .strategy-low { background: rgba(107,114,128,0.1); border-left: 3px solid var(--gray); }
  .strategy-label { font-weight: 600; font-size: 0.7rem; text-transform: uppercase; }

  .truncation-notice { color: var(--text-muted); font-style: italic; font-size: 0.8rem; padding: 0.5rem; }

  .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.75rem; text-align: center; }

  @media print {
    body { background: #fff; color: #000; }
    .card { border-color: #ddd; }
    th { background: #f3f4f6; color: #374151; border-color: #ddd; }
    td { border-color: #ddd; }
    details[open] summary ~ * { display: block !important; }
    details > summary::marker { display: none; }
    details { break-inside: avoid; }
  }
`;

// ============ Template Sections ============

function renderHeader(data: ReportData, title?: string): string {
  return `
    <div class="card">
      <h1>${escapeHtml(title || `Benchmark Report: ${data.benchmark.name}`)}</h1>
      <div class="header-meta">
        ${data.benchmark.description ? `<p>${escapeHtml(data.benchmark.description)}</p>` : ''}
        <p>Generated: ${formatDate(data.generatedAt)} | Runs: ${data.runs.length} | Test Cases: ${data.benchmark.testCaseCount}</p>
      </div>
    </div>
  `;
}

function renderRunSummaryTable(runs: ReportRunData[]): string {
  const rows = runs.map((run) => `
    <tr>
      <td>${escapeHtml(run.name)}</td>
      <td>${escapeHtml(run.agentKey)}</td>
      <td>${escapeHtml(run.modelId)}</td>
      <td>${formatDate(run.createdAt)}</td>
      <td>${formatPercent(run.aggregates.passRatePercent)}</td>
      <td>${formatPercent(run.aggregates.avgAccuracy)}</td>
      <td><span class="badge badge-passed">${run.aggregates.passedCount}</span> / <span class="badge badge-failed">${run.aggregates.failedCount}</span></td>
    </tr>
  `).join('');

  return `
    <h2>Run Summary</h2>
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Agent</th>
          <th>Model</th>
          <th>Date</th>
          <th>Pass Rate</th>
          <th>Accuracy</th>
          <th>Passed / Failed</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderComparisonTable(rows: TestCaseComparisonRow[], runs: ReportRunData[]): string {
  const headerCells = runs.map((r) => `<th colspan="2">${escapeHtml(r.name)}</th>`).join('');

  const bodyRows = rows.map((row) => {
    const labels = row.labels.map((l) => `<span class="badge badge-label">${escapeHtml(l)}</span>`).join(' ');

    const runCells = runs.map((run) => {
      const result = row.results[run.id];
      if (!result || result.status === 'missing') {
        return '<td colspan="2" style="color: var(--text-muted)">-</td>';
      }
      const statusBadge = result.passFailStatus === 'passed'
        ? '<span class="badge badge-passed">PASS</span>'
        : '<span class="badge badge-failed">FAIL</span>';
      const accuracy = result.accuracy !== undefined ? formatPercent(result.accuracy) : '-';
      return `<td>${statusBadge}</td><td>${accuracy}</td>`;
    }).join('');

    return `
      <tr>
        <td>${escapeHtml(row.testCaseName)}</td>
        <td>${labels || '-'}</td>
        ${runCells}
      </tr>
    `;
  }).join('');

  return `
    <h2>Per Test Case Comparison</h2>
    <table>
      <thead>
        <tr>
          <th>Test Case</th>
          <th>Labels</th>
          ${headerCells}
        </tr>
        <tr>
          <th></th>
          <th></th>
          ${runs.map(() => '<th>Status</th><th>Accuracy</th>').join('')}
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

function renderTrajectoryStep(step: TrajectoryStep): string {
  const typeClass = `step-${step.type}`;
  const failedClass = step.type === 'tool_result' && step.status === 'FAILURE' ? ' failed' : '';
  const toolInfo = step.toolName ? ` - ${escapeHtml(step.toolName)}` : '';

  return `
    <div class="step ${typeClass}${failedClass}">
      <div class="step-type">${escapeHtml(step.type)}${toolInfo}</div>
      <div class="step-content">${escapeHtml(step.content || '')}</div>
    </div>
  `;
}

function renderImprovementStrategies(strategies: ImprovementStrategy[]): string {
  if (!strategies || strategies.length === 0) return '';

  const grouped: Record<string, ImprovementStrategy[]> = { high: [], medium: [], low: [] };
  for (const s of strategies) {
    const priority = s.priority || 'medium';
    if (!grouped[priority]) grouped[priority] = [];
    grouped[priority].push(s);
  }

  const renderGroup = (items: ImprovementStrategy[], priority: string): string => {
    if (items.length === 0) return '';
    return items.map((s) => `
      <div class="strategy strategy-${priority}">
        <div class="strategy-label">${escapeHtml(priority)} priority</div>
        <strong>${escapeHtml(s.category)}: </strong>${escapeHtml(s.issue)}
        <br><em>Recommendation: ${escapeHtml(s.recommendation)}</em>
      </div>
    `).join('');
  };

  return `
    <h3>Improvement Strategies</h3>
    ${renderGroup(grouped.high, 'high')}
    ${renderGroup(grouped.medium, 'medium')}
    ${renderGroup(grouped.low, 'low')}
  `;
}

function renderTestCaseDetails(
  rows: TestCaseComparisonRow[],
  runs: ReportRunData[],
  reports: Record<string, EvaluationReport>,
  options?: FormatterOptions
): string {
  const maxSteps = options?.maxTrajectorySteps ?? 50;
  const includeTrajectories = options?.includeTrajectories !== false;

  const details = rows.map((row) => {
    const runDetails = runs.map((run) => {
      const result = row.results[run.id];
      if (!result || result.status === 'missing' || !result.reportId) return '';

      const report = reports[result.reportId];
      if (!report) return '';

      let trajectoryHtml = '';
      if (includeTrajectories && report.trajectory?.length > 0) {
        const steps = report.trajectory.slice(0, maxSteps);
        const truncated = report.trajectory.length - steps.length;
        trajectoryHtml = `
          <h3>Trajectory (${report.trajectory.length} steps)</h3>
          ${steps.map(renderTrajectoryStep).join('')}
          ${truncated > 0 ? `<div class="truncation-notice">${truncated} more steps not shown</div>` : ''}
        `;
      }

      const reasoning = report.llmJudgeReasoning
        ? `<h3>LLM Judge Reasoning</h3><div class="step step-thinking"><div class="step-content">${escapeHtml(report.llmJudgeReasoning)}</div></div>`
        : '';

      const strategies = renderImprovementStrategies(report.improvementStrategies || []);

      const statusBadge = report.passFailStatus === 'passed'
        ? '<span class="badge badge-passed">PASSED</span>'
        : '<span class="badge badge-failed">FAILED</span>';

      return `
        <div class="card">
          <h3>${escapeHtml(run.name)} ${statusBadge} (Accuracy: ${formatPercent(report.metrics?.accuracy ?? 0)})</h3>
          ${reasoning}
          ${strategies}
          ${trajectoryHtml}
        </div>
      `;
    }).join('');

    if (!runDetails.trim()) return '';

    const labels = row.labels.map((l) => `<span class="badge badge-label">${escapeHtml(l)}</span>`).join(' ');

    return `
      <details>
        <summary>${escapeHtml(row.testCaseName)} ${labels}</summary>
        <div class="details-content">
          ${runDetails}
        </div>
      </details>
    `;
  }).join('');

  if (!details.trim()) return '';

  return `
    <h2>Test Case Details</h2>
    ${details}
  `;
}

// ============ Main Template ============

/**
 * Generate a complete self-contained HTML report
 */
export function generateHtmlReport(data: ReportData, options?: FormatterOptions): string {
  const title = options?.title || `Benchmark Report: ${data.benchmark.name}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>${CSS_STYLES}</style>
</head>
<body>
  <div class="container">
    ${renderHeader(data, options?.title)}
    ${renderRunSummaryTable(data.runs)}
    ${renderComparisonTable(data.comparisonRows, data.runs)}
    ${renderTestCaseDetails(data.comparisonRows, data.runs, data.reports, options)}
    <div class="footer">
      Generated by Agent Health Evaluation Framework | ${formatDate(data.generatedAt)}
    </div>
  </div>
</body>
</html>`;
}
