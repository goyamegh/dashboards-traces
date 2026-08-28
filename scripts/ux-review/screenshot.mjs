#!/usr/bin/env node
/* Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0 */

// Captures before/after screenshots for the top-5 UX paper-cut fixes.
// Usage: node scripts/ux-review/screenshot.mjs <stage> [--only=<id>]
//   stage = "before" | "after"

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';

const stage = argv[2];
if (!['before', 'after'].includes(stage)) {
  console.error('Usage: node screenshot.mjs <before|after> [--only=id]');
  process.exit(1);
}
const only = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

const BASE = process.env.BASE_URL || 'http://localhost:4001';
// Per-feature layout: ~/ux-review-shots/<feature>/{before,after}-{light,dark}.png
const ROOT = process.env.SHOT_ROOT || `${process.env.HOME}/ux-review-shots`;
mkdirSync(ROOT, { recursive: true });

// Known-good IDs in this project's OpenSearch — override via env vars for your own cluster.
const RUN_ID = process.env.UX_REVIEW_RUN_ID || 'run-1779332071373-z6mfu2tdn';
// Benchmark with 40 runs, suitable for the time-series chart
const COMPARE_BENCHMARK_ID = process.env.UX_REVIEW_COMPARE_BENCHMARK_ID || 'exp-1765401828206-yq9ychdhu';

if (!process.env.UX_REVIEW_RUN_ID || !process.env.UX_REVIEW_COMPARE_BENCHMARK_ID) {
  console.warn(
    '[ux-review] Using default RUN_ID / COMPARE_BENCHMARK_ID — set UX_REVIEW_RUN_ID and UX_REVIEW_COMPARE_BENCHMARK_ID env vars for your own cluster.',
  );
}

const SHOTS = [
  // 1. RawEventsPanel: open run detail by reportId, switch trajectory toggle to "Raw Events"
  {
    id: '01-raw-events-panel',
    label: 'RawEventsPanel — broken-in-light hardcoded grays',
    url: `${BASE}/runs/${RUN_ID}`,
    setup: async (page) => {
      await page.waitForTimeout(1500);
      // Click "Conversation History" tab first
      const convTab = page.getByRole('tab', { name: /conversation history/i }).first();
      if (await convTab.count()) await convTab.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(800);
      // Click "Raw Events" toggle inside the tab
      const rawBtn = page.getByRole('button', { name: /^raw events$/i }).first();
      if (await rawBtn.count()) await rawBtn.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1000);
      // Scroll to the panel
      const panel = page.locator('text=/Raw AG UI Events/i').first();
      if (await panel.count()) {
        await panel.scrollIntoViewIfNeeded().catch(() => {});
      }
      await page.waitForTimeout(500);
    },
    elementSelector: 'main',
  },
  // 2. LatencyHistogram: agent-traces page — expand Metrics card to show the distribution histogram
  {
    id: '02-latency-histogram',
    label: 'LatencyHistogram — dark bars near-invisible at 0.3 alpha',
    url: `${BASE}/agent-traces`,
    setup: async (page) => {
      await page.waitForTimeout(3000);
      // Click the "Metrics" card header to expand the latency distribution section
      const metricsHeader = page.locator('text=/^Metrics$/').first();
      if (await metricsHeader.count()) {
        await metricsHeader.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(800);
      }
      // Wait for the distribution bars to render
      await page.locator('text=/Latency Distribution/i').first().waitFor({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
    },
    elementSelector: 'main',
  },
  // 3. MetricsTimeSeriesChart: comparison page for benchmark
  {
    id: '03-metrics-timeseries-chart',
    label: 'MetricsTimeSeriesChart — Recharts axes hardcoded hex',
    url: `${BASE}/compare/${COMPARE_BENCHMARK_ID}`,
    setup: async (page) => {
      await page.waitForTimeout(3500);
      // Open the "Compare Summary" collapsible (collapsed by default)
      const summaryToggle = page.getByRole('button', { name: /compare summary/i }).first();
      if (await summaryToggle.count()) {
        await summaryToggle.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(800);
      }
      // Scroll the chart into view
      const chart = page.locator('text=/Metrics Over Time/i').first();
      if (await chart.count()) {
        await chart.scrollIntoViewIfNeeded().catch(() => {});
      }
      await page.waitForTimeout(1000);
    },
    elementSelector: 'main',
  },
  // 4. Slate !important overrides: agent-traces — open a trace, switch to Agent Map tab
  {
    id: '04-slate-overrides',
    label: 'Slate !important overrides — minimap/background invisible in light mode',
    url: `${BASE}/agent-traces`,
    setup: async (page) => {
      await page.waitForTimeout(3500);
      // Click first trace row in the table
      const sessionRow = page.locator('table tbody tr').first();
      if (await sessionRow.count()) {
        await sessionRow.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
      // Click "Agent map" button in the view toggle
      const mapBtn = page.getByRole('button', { name: /agent map/i }).first();
      if (await mapBtn.count()) {
        await mapBtn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    },
    elementSelector: 'main',
  },
  // 5. Tooltip flip: hover the per-row Distribution bar to surface the Time Distribution tooltip
  {
    id: '05-tooltip-flip',
    label: 'Tooltip — dark variant lighter than light variant',
    url: `${BASE}/agent-traces`,
    setup: async (page) => {
      await page.waitForTimeout(3500);
      // Find a Distribution cell in the table — the colored width bar inside the first data row
      const distroCell = page.locator('table tbody tr').first().locator('div.h-3\\.5').first();
      if (await distroCell.count()) {
        await distroCell.hover().catch(() => {});
        await page.waitForTimeout(800);
      }
    },
    elementSelector: 'main',
  },
];

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    localStorage.setItem('agent-health-theme', t);
    if (t === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, theme);
}

async function snap(page, shot, theme) {
  // Navigate first to establish a clean execution context
  try {
    await page.goto(shot.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    console.warn(`goto err ${shot.id} ${theme}:`, e.message);
  }
  // Apply theme after the SPA's bundle has loaded
  await page.waitForTimeout(500);
  try {
    await setTheme(page, theme);
  } catch (e) {
    console.warn(`setTheme err ${shot.id} ${theme}:`, e.message);
  }
  await page.waitForTimeout(1500);

  if (shot.setup) {
    await shot.setup(page).catch((e) => console.warn(`setup err for ${shot.id}:`, e.message));
  }

  await page.waitForTimeout(500);
  const featureDir = join(ROOT, shot.id);
  mkdirSync(featureDir, { recursive: true });
  const fname = `${stage}-${theme}.png`;
  const outPath = join(featureDir, fname);
  try {
    if (shot.elementSelector) {
      const el = page.locator(shot.elementSelector).first();
      if (await el.count()) {
        await el.screenshot({ path: outPath });
      } else {
        await page.screenshot({ path: outPath, fullPage: false });
      }
    } else {
      await page.screenshot({ path: outPath, fullPage: false });
    }
    console.log(`✓ ${shot.id}/${fname}`);
  } catch (e) {
    console.warn(`screenshot err ${shot.id} ${theme}:`, e.message);
  }
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  // Single context+page for the whole run — much lighter than per-shot contexts.
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  // Bootstrap once
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

  for (const shot of SHOTS) {
    if (only && shot.id !== only) continue;
    for (const theme of ['light', 'dark']) {
      await snap(page, shot, theme);
    }
  }
  await ctx.close();
} finally {
  await browser.close();
}
