/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Benchmark doctor — detects and plans cleanup of duplicated / debris
 * benchmark entities that accumulated from the "same command → new benchmark
 * every time" era (timestamped quick-mode docs, test debris, content dupes).
 *
 * Pure planning module: given the full benchmark + evaluation-run lists it
 * returns a DoctorPlan describing exactly what would change. Applying the
 * plan is the CLI's job (dry-run by default, --apply to execute).
 *
 * Conservative by design:
 *   - runs and reports are NEVER deleted — only benchmark shells are merged
 *     or removed, and eval-runs are re-pointed to the canonical benchmark;
 *   - debris deletion requires a timestamped name pattern AND no embedded
 *     runs AND no eval-run references AND age > 24h;
 *   - sample data (demo-*) is never touched.
 */

import type { Benchmark, EvaluationRun } from '@/types';

/**
 * The storage operations the doctor's apply/migrate steps need. Structurally
 * satisfied by the CLI ApiClient — kept as an interface so this module stays
 * free of CLI dependencies (chalk/ora) and unit-testable with plain mocks.
 */
export interface DoctorStorageOps {
  getBenchmark(id: string): Promise<Benchmark | null>;
  updateBenchmark(id: string, input: { name?: string; description?: string; testCaseIds?: string[]; runs?: unknown[] }): Promise<Benchmark>;
  deleteBenchmark(id: string): Promise<boolean>;
  updateEvaluationRun(id: string, updates: Partial<EvaluationRun>): Promise<EvaluationRun | null>;
  listBenchmarks(): Promise<Benchmark[]>;
}

export interface DebrisDeletion {
  id: string;
  name: string;
  reason: string;
}

export interface ContentDupGroup {
  /** Sorted testCaseIds joined — the content key the group shares. */
  key: string;
  canonicalId: string;
  canonicalName: string;
  /** Duplicates to merge into the canonical then delete. */
  husks: Array<{ id: string; name: string; embeddedRunCount: number }>;
  /** Eval-runs pointing at husks, to re-point at the canonical. */
  runRepoints: Array<{ runId: string; fromBenchmarkId: string; toBenchmarkId: string }>;
}

export interface DoctorPlan {
  debrisDeletions: DebrisDeletion[];
  contentDupGroups: ContentDupGroup[];
  summary: {
    totalBenchmarks: number;
    debrisCount: number;
    dupGroupCount: number;
    husksToMerge: number;
    runsToRepoint: number;
  };
}

const QUICK_DEBRIS = /^quick-\d+$/;
const TS_SUFFIX_DEBRIS = /-\d{13}$/; // epoch-ms suffix, e.g. sdk-cli-coverage-1787518298767
const DEBRIS_MIN_AGE_MS = 24 * 60 * 60 * 1000;

function isSample(b: Benchmark): boolean {
  return b.id.startsWith('demo-');
}

function embeddedRunCount(b: Benchmark): number {
  return Array.isArray(b.runs) ? b.runs.length : 0;
}

export function buildDoctorPlan(
  benchmarks: Benchmark[],
  evalRuns: EvaluationRun[],
  opts: { now?: Date } = {}
): DoctorPlan {
  const now = opts.now ?? new Date();
  const real = benchmarks.filter((b) => !isSample(b));

  // eval-run references per benchmark id
  const refsByBenchmark = new Map<string, EvaluationRun[]>();
  for (const run of evalRuns) {
    if (!run.benchmarkId) continue;
    const list = refsByBenchmark.get(run.benchmarkId) ?? [];
    list.push(run);
    refsByBenchmark.set(run.benchmarkId, list);
  }
  const refCount = (id: string) => refsByBenchmark.get(id)?.length ?? 0;

  // ---- Debris: timestamped names, no runs anywhere, older than 24h --------
  const debrisDeletions: DebrisDeletion[] = [];
  const debrisIds = new Set<string>();
  for (const b of real) {
    const isDebrisName = QUICK_DEBRIS.test(b.name) || TS_SUFFIX_DEBRIS.test(b.name);
    if (!isDebrisName) continue;
    if (embeddedRunCount(b) > 0 || refCount(b.id) > 0) continue;
    const ageMs = now.getTime() - new Date(b.createdAt || 0).getTime();
    if (ageMs < DEBRIS_MIN_AGE_MS) continue;
    debrisDeletions.push({
      id: b.id,
      name: b.name,
      reason: QUICK_DEBRIS.test(b.name)
        ? 'quick-mode debris (timestamped, no runs, unreferenced)'
        : 'timestamped debris (no runs, unreferenced)',
    });
    debrisIds.add(b.id);
  }

  // ---- Content-duplicate groups: same testCaseIds set ---------------------
  const groupsByKey = new Map<string, Benchmark[]>();
  for (const b of real) {
    if (debrisIds.has(b.id)) continue; // already being deleted
    const ids = b.testCaseIds ?? [];
    if (ids.length === 0) continue; // empty sets are not "same content"
    const key = [...ids].sort().join('|');
    const list = groupsByKey.get(key) ?? [];
    list.push(b);
    groupsByKey.set(key, list);
  }

  const contentDupGroups: ContentDupGroup[] = [];
  for (const [key, group] of groupsByKey) {
    if (group.length < 2) continue;
    // Canonical: most embedded runs, then most eval-run refs, then oldest.
    const sorted = [...group].sort((a, b) => {
      const runDiff = embeddedRunCount(b) - embeddedRunCount(a);
      if (runDiff !== 0) return runDiff;
      const refDiff = refCount(b.id) - refCount(a.id);
      if (refDiff !== 0) return refDiff;
      return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
    });
    const canonical = sorted[0];
    const husks = sorted.slice(1);

    const runRepoints: ContentDupGroup['runRepoints'] = [];
    for (const husk of husks) {
      for (const run of refsByBenchmark.get(husk.id) ?? []) {
        runRepoints.push({
          runId: run.id,
          fromBenchmarkId: husk.id,
          toBenchmarkId: canonical.id,
        });
      }
    }

    contentDupGroups.push({
      key,
      canonicalId: canonical.id,
      canonicalName: canonical.name,
      husks: husks.map((h) => ({
        id: h.id,
        name: h.name,
        embeddedRunCount: embeddedRunCount(h),
      })),
      runRepoints,
    });
  }

  return {
    debrisDeletions,
    contentDupGroups,
    summary: {
      totalBenchmarks: real.length,
      debrisCount: debrisDeletions.length,
      dupGroupCount: contentDupGroups.length,
      husksToMerge: contentDupGroups.reduce((n, g) => n + g.husks.length, 0),
      runsToRepoint: contentDupGroups.reduce((n, g) => n + g.runRepoints.length, 0),
    },
  };
}

export interface ApplyResult {
  husksDeleted: number;
  debrisDeleted: number;
  runsRepointed: number;
  embeddedRunsMerged: number;
  errors: string[];
}

/**
 * Execute a DoctorPlan against the storage API. Never deletes runs or
 * reports — only benchmark shells. Order per group: merge embedded runs →
 * re-point eval-runs → delete husks (so a failure mid-way never strands data).
 */
export async function applyDoctorPlan(api: DoctorStorageOps, plan: DoctorPlan): Promise<ApplyResult> {
  const result: ApplyResult = {
    husksDeleted: 0,
    debrisDeleted: 0,
    runsRepointed: 0,
    embeddedRunsMerged: 0,
    errors: [],
  };

  // 1. Merge content-duplicate groups
  for (const group of plan.contentDupGroups) {
    try {
      const canonical = await api.getBenchmark(group.canonicalId);
      if (!canonical) {
        result.errors.push(`canonical not found: ${group.canonicalId}`);
        continue;
      }

      // Merge embedded runs from husks into the canonical (preserve history)
      const mergedRuns = [...(canonical.runs || [])];
      const huskDocs: Benchmark[] = [];
      for (const husk of group.husks) {
        const doc = await api.getBenchmark(husk.id);
        if (!doc) continue; // already gone — fine
        huskDocs.push(doc);
        for (const run of doc.runs || []) {
          if (!mergedRuns.some((r) => r.id === run.id)) {
            mergedRuns.push(run);
            result.embeddedRunsMerged++;
          }
        }
      }
      if (mergedRuns.length > (canonical.runs || []).length) {
        await api.updateBenchmark(group.canonicalId, { runs: mergedRuns });
      }

      // Re-point eval-runs at the canonical
      const failedRepointSources = new Set<string>();
      for (const repoint of group.runRepoints) {
        const updated = await api.updateEvaluationRun(repoint.runId, {
          benchmarkId: repoint.toBenchmarkId,
        });
        if (updated) {
          result.runsRepointed++;
        } else {
          result.errors.push(`failed to re-point run ${repoint.runId}`);
          failedRepointSources.add(repoint.fromBenchmarkId);
        }
      }

      // Delete husks (only after merge + re-point succeeded). A husk with a
      // failed re-point is skipped — deleting it would strand the still-
      // pointing eval-run on a dangling benchmarkId.
      for (const husk of huskDocs) {
        if (failedRepointSources.has(husk.id)) {
          result.errors.push(`skipped deleting husk ${husk.id}: a run re-point to it failed`);
          continue;
        }
        const ok = await api.deleteBenchmark(husk.id);
        if (ok) result.husksDeleted++;
        else result.errors.push(`failed to delete husk ${husk.id}`);
      }
    } catch (e: any) {
      result.errors.push(`group ${group.canonicalName}: ${e?.message ?? e}`);
    }
  }

  // 2. Delete debris
  for (const debris of plan.debrisDeletions) {
    try {
      const ok = await api.deleteBenchmark(debris.id);
      if (ok) result.debrisDeleted++;
      else result.errors.push(`failed to delete debris ${debris.id}`);
    } catch (e: any) {
      result.errors.push(`debris ${debris.name}: ${e?.message ?? e}`);
    }
  }

  return result;
}

export interface MigrateImagesResult {
  migrated: Array<{ benchmarkId: string; name: string; digest: string; missingTestCaseIds?: string[] }>;
  skipped: Array<{ benchmarkId: string; name: string; reason: string }>;
  errors: string[];
}

/**
 * Convert real benchmarks (non-sample, non-empty) into content-addressed
 * images tagged with the benchmark name (phase 4 of the dedup plan).
 * Idempotent: identical content converges on the same digest; tags union.
 * Benchmarks are NOT deleted (back-compat); new runs converge on images by
 * digest.
 */
export async function migrateBenchmarksToImages(
  api: DoctorStorageOps,
  baseUrl: string,
  opts: { benchmarkIds?: string[] } = {}
): Promise<MigrateImagesResult> {
  const result: MigrateImagesResult = { migrated: [], skipped: [], errors: [] };
  let benchmarks = await api.listBenchmarks();
  if (opts.benchmarkIds) {
    const allow = new Set(opts.benchmarkIds);
    benchmarks = benchmarks.filter((b) => allow.has(b.id));
  }
  for (const b of benchmarks) {
    if (b.id.startsWith('demo-')) {
      result.skipped.push({ benchmarkId: b.id, name: b.name, reason: 'sample data' });
      continue;
    }
    if (!b.testCaseIds || b.testCaseIds.length === 0) {
      result.skipped.push({ benchmarkId: b.id, name: b.name, reason: 'no test cases' });
      continue;
    }
    try {
      const res = await fetch(`${baseUrl}/api/storage/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: b.testCaseIds, tags: [b.name] }),
      });
      if (!res.ok) {
        result.errors.push(`${b.name}: ${await res.text()}`);
        continue;
      }
      const body = await res.json();
      const missingTestCaseIds: string[] | undefined = body.missingTestCaseIds;
      result.migrated.push({
        benchmarkId: b.id,
        name: b.name,
        digest: body.image.digest,
        ...(missingTestCaseIds && missingTestCaseIds.length > 0 ? { missingTestCaseIds } : {}),
      });
      // A partial migration (some testCaseIds no longer resolve to a stored
      // test case) still produces a valid image from the survivors, but the
      // resulting digest covers LESS content than the source benchmark —
      // surface that loudly rather than silently blessing it as a clean
      // migration.
      if (missingTestCaseIds && missingTestCaseIds.length > 0) {
        result.errors.push(
          `${b.name}: migrated from a PARTIAL test-case set — missing ${missingTestCaseIds.length} id(s): ${missingTestCaseIds.join(', ')}`
        );
      }
    } catch (e: any) {
      result.errors.push(`${b.name}: ${e?.message ?? e}`);
    }
  }
  return result;
}
