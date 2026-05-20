/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TestCaseSource, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';
import { getCategoryFromLabels, getDifficultyFromLabels } from '@/lib/testCaseLabels';
import { debug } from '@/lib/debug';
import type { EvalResult } from '@/lib/testCases/types';

/**
 * The signature of a test body. Accepts both legacy `(result)` form and
 * the new Playwright-style fixtures object. Internally the runner passes
 * a single argument that satisfies both shapes (an EvalResult merged with
 * the fixtures), so callers downcast as needed.
 */
export type EvaluateFn = (resultOrFixtures: any) => Promise<void> | void;

export interface ResolvedSources {
  testCases: TestCase[];
  sources: TestCaseSource[];
  deduplicatedCount: number;
  evaluateFnMap: Map<string, EvaluateFn>;
}

export async function resolveTestCaseSources(
  sources: TestCaseSource[],
  storage: IStorageModule
): Promise<ResolvedSources> {
  const allTestCases: TestCase[] = [];
  const updatedSources: TestCaseSource[] = [];
  const evaluateFnMap = new Map<string, EvaluateFn>();

  for (const source of sources) {
    switch (source.type) {
      case 'benchmark': {
        const benchmark = await storage.benchmarks.getById(source.benchmarkId);
        if (!benchmark) {
          throw new Error(`Benchmark not found: ${source.benchmarkId}`);
        }
        const testCases = await fetchTestCasesByIds(benchmark.testCaseIds, storage);
        allTestCases.push(...testCases);
        updatedSources.push(source);
        debug('SourceResolver', `Resolved ${testCases.length} test cases from benchmark ${source.benchmarkId}`);
        break;
      }

      case 'test-case-ids': {
        const testCases = await fetchTestCasesByIds(source.ids, storage);
        allTestCases.push(...testCases);
        updatedSources.push(source);
        debug('SourceResolver', `Resolved ${testCases.length} test cases from explicit IDs`);
        break;
      }

      case 'file-import': {
        const testCases = await resolveFileImport(source.filenames, storage);
        const testCaseIds = testCases.map((tc) => tc.id);
        allTestCases.push(...testCases);
        updatedSources.push({ ...source, testCaseIds });
        debug('SourceResolver', `Imported ${testCases.length} test cases from ${source.filenames.length} file(s)`);
        break;
      }

      case 'code-import': {
        const { testCases, fnMap } = await resolveCodeImport(source.filenames, storage);
        const testCaseIds = testCases.map((tc) => tc.id);
        allTestCases.push(...testCases);
        for (const [id, fn] of fnMap) {
          evaluateFnMap.set(id, fn);
        }
        updatedSources.push({ ...source, testCaseIds });
        debug('SourceResolver', `Code-imported ${testCases.length} test cases from ${source.filenames.length} file(s)`);
        break;
      }

      case 'directory-import': {
        const testCases = await resolveDirectoryImport(source.dirPaths, storage);
        const testCaseIds = testCases.map((tc) => tc.id);
        allTestCases.push(...testCases);
        updatedSources.push({ ...source, testCaseIds });
        debug('SourceResolver', `Imported ${testCases.length} test cases from ${source.dirPaths.length} directory(ies)`);
        break;
      }

      case 'label-filter': {
        const result = await storage.testCases.search({ labels: source.labels });
        allTestCases.push(...result.items);
        updatedSources.push(source);
        debug('SourceResolver', `Found ${result.items.length} test cases matching labels: ${source.labels.join(', ')}`);
        break;
      }
    }
  }

  // Deduplicate by test case ID (first occurrence wins)
  const seen = new Map<string, TestCase>();
  for (const tc of allTestCases) {
    if (!seen.has(tc.id)) {
      seen.set(tc.id, tc);
    }
  }

  const deduplicatedCount = allTestCases.length - seen.size;
  debug('SourceResolver', `Deduplicated ${deduplicatedCount} test cases, ${seen.size} unique remaining`);

  return {
    testCases: Array.from(seen.values()),
    sources: updatedSources,
    deduplicatedCount,
    evaluateFnMap,
  };
}

async function fetchTestCasesByIds(ids: string[], storage: IStorageModule): Promise<TestCase[]> {
  return Promise.all(
    ids.map(async (id) => {
      const tc = await storage.testCases.getById(id);
      if (!tc) throw new Error(`Test case not found: ${id}`);
      return tc;
    })
  );
}

async function resolveFileImport(filenames: string[], storage: IStorageModule): Promise<TestCase[]> {
  const allCreated: TestCase[] = [];

  for (const filename of filenames) {
    if (!fs.existsSync(filename)) {
      throw new Error(`File not found: ${filename}`);
    }

    const content = fs.readFileSync(filename, 'utf-8');
    const parsed = JSON.parse(content);
    const validation = validateTestCasesArrayJson(parsed);

    if (!validation.valid) {
      const errorMessages = validation.errors.map((e) => e.message).join('; ');
      throw new Error(`Validation failed for ${filename}: ${errorMessages}`);
    }

    const result = await storage.testCases.bulkCreate(validation.data!);
    allCreated.push(...result.testCases);
  }

  return allCreated;
}

async function resolveCodeImport(
  filenames: string[],
  storage: IStorageModule
): Promise<{ testCases: TestCase[]; fnMap: Map<string, EvaluateFn> }> {
  const { loadTestCasesFromModule } = await import('@/lib/testCases/loader');
  const allTestCases: TestCase[] = [];
  const fnMap = new Map<string, EvaluateFn>();

  for (const filename of filenames) {
    if (!fs.existsSync(filename)) {
      throw new Error(`Code file not found: ${filename}`);
    }

    const loaded = await loadTestCasesFromModule(filename);
    const sourceFile = path.relative(process.cwd(), loaded.filePath);

    const upsertInput = loaded.testCases.map(tc => {
      // Labels are the source of truth in the new SDK. Derive the legacy
      // top-level fields for back-compat with existing storage / UI that
      // still reads them. Cold-start migration folds these the other way
      // for documents created before labels existed.
      const labels = tc.options.labels;
      const category = getCategoryFromLabels(labels);
      const difficulty = getDifficultyFromLabels(labels);
      return {
        name: tc.name,
        // Derived from labels for back-compat. Optional now — the storage
        // layer accepts undefined and the UI falls back to label lookups.
        ...(category ? { category } : {}),
        ...(difficulty ? { difficulty } : {}),
        initialPrompt: tc.options.prompt,
        context: tc.options.context,
        labels,
        sourceFile,
        sourceHash: tc.hash,
      };
    });

    const result = await storage.testCases.bulkUpsert(upsertInput as Parameters<typeof storage.testCases.bulkUpsert>[0]);
    allTestCases.push(...result.testCases);

    result.testCases.forEach((stored, i) => {
      const loadedTc = loaded.testCases[i];
      if (loadedTc?.evaluate) {
        fnMap.set(stored.id, loadedTc.evaluate);
      }
    });
  }

  return { testCases: allTestCases, fnMap };
}

async function resolveDirectoryImport(dirPaths: string[], storage: IStorageModule): Promise<TestCase[]> {
  const allCreated: TestCase[] = [];

  for (const dirPath of dirPaths) {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const entries = fs.readdirSync(dirPath);
    const jsonFiles = entries.filter((entry) => entry.endsWith('.json'));

    if (jsonFiles.length === 0) {
      throw new Error(`No JSON files found in directory: ${dirPath}`);
    }

    const filePaths = jsonFiles.map((file) => path.join(dirPath, file));
    const testCases = await resolveFileImport(filePaths, storage);
    allCreated.push(...testCases);
  }

  return allCreated;
}
