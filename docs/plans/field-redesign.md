# Plan: Code-Based Test Case SDK — Field Redesign

## Context

The initial implementation (steps 1-11) is complete and all tests pass. This redesign corrects the field architecture based on these insights:

1. **Code test cases can use BOTH deterministic AND LLM judge** — a customer can call `judge()` inside `evaluate()`. They're not mutually exclusive.
2. **`evaluationType` belongs on TestCaseVersion, not TestCaseRun** — it's a property of how the test is defined (immutable per version), not an execution artifact.
3. **Per-test-case content hashing** — changing one test in a 50-test file shouldn't version all 50.
4. **SDK API: Playwright-style `test('name', opts?, fn)`** — not `defineTestCases([...])`.
5. **`sourceFile` (relative path)** replaces `sourceUri` (no `file://` scheme).
6. **`agentic: boolean` (required)** — customer-declared, maps to `evaluationType` on version.

**Key decisions:**
- SDK API: `test('name', { agentic: false, ... }, evaluateFn)` — Playwright-style
- `agentic: boolean` required on test definition → stored as `evaluationType: 'agentic' | 'deterministic'` on **TestCaseVersion**
- `sourceFile` (relative path) + `sourceHash` (per-test-case content hash) on **TestCase**
- **Drop `evaluationType` from TestCaseRun entirely**
- Keep `assertionError` on TestCaseRun (execution-time data)
- Match key for upsert: `name + sourceFile`

---

## Implementation Steps

### 1. Redesign SDK API: `test()` registration pattern

**Files:** `lib/testCases/types.ts`, `lib/testCases/define.ts`, `lib/testCases/index.ts`

Replace `defineTestCases([...])` with Playwright-style `test()`:

```typescript
// lib/testCases/types.ts
export interface TestOptions {
  agentic: boolean;         // REQUIRED — declares if judge() will be called
  category: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  description?: string;
  context?: { description: string; value: string }[];
  labels?: string[];
}

export interface CodeTestCase {
  name: string;
  options: TestOptions;
  initialPrompt: string;    // The first argument after name becomes the prompt
  evaluate: (result: EvalResult) => Promise<void> | void;
}

export interface EvalResult {
  trajectory: TrajectoryStep[];
  agentOutput: string;
  rawEvents: any[];
  runId?: string;
  durationMs: number;
}
```

```typescript
// lib/testCases/define.ts — REPLACE defineTestCases() with test()
const registry: CodeTestCase[] = [];

export function test(
  name: string,
  options: TestOptions,
  evaluate: (result: EvalResult) => Promise<void> | void
): void {
  // Validate required fields
  if (!name || typeof name !== 'string') throw new Error('test() requires a name');
  if (options.agentic === undefined) throw new Error('test() requires options.agentic (boolean)');
  if (!options.category) throw new Error('test() requires options.category');
  if (!options.difficulty) throw new Error('test() requires options.difficulty');
  if (typeof evaluate !== 'function') throw new Error('test() requires an evaluate function');

  registry.push({ name, options, initialPrompt: name, evaluate });
}

export function getRegisteredTests(): CodeTestCase[] {
  return [...registry];
}

export function clearRegistry(): void {
  registry.length = 0;
}
```

**Customer usage:**
```typescript
// evals/cybergym.eval.ts
import { test, expect } from '@opensearch-project/agent-health';

test('cybergym-task-42', {
  agentic: false,
  category: 'Security',
  difficulty: 'Hard',
}, async (result) => {
  const poc = extractPoc(result.agentOutput);
  const res = await submitToCyberGym(poc, 'task-42');
  expect(res.exit_code).to.not.equal(0);
});

test('rca-log-analysis', {
  agentic: true,  // Will call judge() inside
  category: 'RCA',
  difficulty: 'Medium',
}, async (result) => {
  const verdict = await judge(result.trajectory, ['Identifies root cause']);
  // judge() populates report fields automatically
});
```

**Keep `defineTestCases()` as backward-compatible alias** — wraps array items into `test()` calls internally. Mark as deprecated.

### 2. Move `evaluationType` from TestCaseRun to TestCaseVersion

**File:** `types/index.ts`

**Add to `TestCaseVersion`** (line ~354):
```typescript
export interface TestCaseVersion {
  // ... existing fields ...
  evaluationType?: 'agentic' | 'deterministic';  // NEW — set from `agentic` boolean at import
}
```

**Remove from `TestCaseRun`** (line ~316):
```diff
- evaluationType?: 'llm' | 'deterministic';
```

Keep `assertionError` on TestCaseRun — that's execution-time data.

**Rename values:** `'llm'` → `'agentic'`, `'deterministic'` stays. The value `'agentic'` better represents "will use LLM judge" and is forward-compatible.

**Mapping:** `agentic: true` → `evaluationType: 'agentic'` on version. `agentic: false` → `evaluationType: 'deterministic'`.

### 3. Replace `sourceUri` with `sourceFile` + per-test-case hash

**File:** `types/index.ts` — on TestCase:
```diff
- sourceUri?: string;    // "file:///path/to/evals.eval.ts"
- sourceHash?: string;   // SHA-256 of file content
+ sourceFile?: string;   // Relative path: "evals/cybergym.eval.ts"
+ sourceHash?: string;   // SHA-256 of THIS test case's serialized content (not the file)
```

**File:** `server/constants/indexMappings.ts`:
```diff
- sourceUri: { type: 'keyword' },
+ sourceFile: { type: 'keyword' },
  sourceHash: { type: 'keyword' },
```

**Per-test-case hash computation** (`lib/testCases/loader.ts`):
```typescript
function computeTestCaseHash(tc: CodeTestCase): string {
  // Hash the immutable content fields only (not the function)
  const content = JSON.stringify({
    name: tc.name,
    agentic: tc.options.agentic,
    category: tc.options.category,
    difficulty: tc.options.difficulty,
    initialPrompt: tc.initialPrompt,
    context: tc.options.context,
    labels: tc.options.labels,
    description: tc.options.description,
  });
  return crypto.createHash('sha256').update(content).digest('hex');
}
```

This means: modifying one test case in a 50-test file only versions that one test case.

### 4. Update `bulkUpsert` match logic

**Files:** `server/adapters/file/StorageModule.ts`, `server/adapters/opensearch/StorageModule.ts`

**Match key change:** `name + sourceUri` → `name + sourceFile`

```typescript
const existing = all.find(
  e => e.name === tc.name && (tc.sourceFile ? e.sourceFile === tc.sourceFile : true)
);
```

**On update (hash differs):** Create new version with:
- Updated content fields (initialPrompt, context, etc.)
- `evaluationType` set from `agentic` boolean
- New `sourceHash`

**On create:** First version gets `evaluationType` from `agentic` boolean.

### 5. Update loader to return per-test-case hashes

**File:** `lib/testCases/loader.ts`

Change `LoadResult`:
```typescript
export interface LoadResult {
  testCases: Array<CodeTestCase & { hash: string }>;  // Each test case has its own hash
  filePath: string;
  // Remove top-level `hash` — no longer per-file
}
```

The loader:
1. Imports the module (clears and re-reads registry)
2. Gets registered test cases from registry
3. Computes per-test-case hash for each
4. Returns the enriched array

### 6. Update source resolver

**File:** `services/sourceResolver.ts`

In `resolveCodeImport()`:
1. Load module → get test cases with per-test-case hashes
2. Compute `sourceFile` as relative path from CWD (not absolute URI)
3. For each test case, prepare upsert input:
   ```typescript
   {
     name: tc.name,
     category: tc.options.category,
     difficulty: tc.options.difficulty,
     initialPrompt: tc.initialPrompt,
     context: tc.options.context,
     labels: tc.options.labels,
     sourceFile: relativePath,        // "evals/cybergym.eval.ts"
     sourceHash: tc.hash,             // Per-test-case hash
     evaluationType: tc.options.agentic ? 'agentic' : 'deterministic',
   }
   ```
4. Call `bulkUpsert()` — pass `evaluationType` so it's stored on the version
5. Map returned test case IDs to evaluate functions in `evaluateFnMap`

### 7. Update evaluation runner

**File:** `services/evaluationRunner.ts`

The runner logic stays mostly the same, except:
- Remove setting `evaluationType` on the report (it's on the version now)
- Keep `assertionError` on report (execution-time data)
- Keep `passFailStatus` on report

```typescript
if (isDeterministic) {
  try {
    await evalFn({ trajectory, agentOutput, rawEvents, durationMs });
    report.passFailStatus = 'passed';
    report.metrics = { accuracy: 100, ... };
  } catch (evalError: any) {
    report.passFailStatus = 'failed';
    report.assertionError = evalError.message;
    report.metrics = { accuracy: 0, ... };
  }
}
```

### 8. Update UI to read evaluationType from TestCase version

**File:** `components/RunDetailsContent.tsx`

Instead of reading `report.evaluationType`, look up the test case version:
```typescript
const evaluationType = testCase?.versions?.[testCase.currentVersion - 1]?.evaluationType;
```

- `evaluationType === 'deterministic'` → show deterministic UI (assertion result, hide judge reasoning)
- `evaluationType === 'agentic'` or undefined → show LLM judge UI (existing behavior)

**File:** `components/evals3/TestCasesPage.tsx`

- "Code" badge triggers on `testCase.sourceFile` (not `sourceUri`)
- Disable edit for code-sourced test cases

### 9. Update existing tests

All existing tests that reference the old field names/locations need updating:

| Test File | Change |
|-----------|--------|
| `tests/unit/services/evaluationRunner.deterministic.test.ts` | Remove `evaluationType` assertions from report, keep `assertionError` |
| `tests/unit/services/sourceResolver.codeImport.test.ts` | Use `sourceFile` instead of `sourceUri`, per-test-case hash |
| `tests/unit/server/adapters/bulkUpsert.test.ts` | Match on `sourceFile` instead of `sourceUri` |
| `tests/integration/services/sourceResolver.codeImport.integration.test.ts` | Update assertions for `sourceFile` |
| `tests/integration/services/codeSdkObservio.integration.test.ts` | Update field references |

### 10. Update index mappings + storage adapters

**File:** `server/constants/indexMappings.ts`
- Rename `sourceUri` → `sourceFile` in testCases mapping
- Add `evaluationType: { type: 'keyword' }` to testCases mapping (version-level)
- Remove `evaluationType` from runs mapping

**File:** `server/adapters/types.ts`
- `bulkUpsert` input type now includes `evaluationType` field (passed through to version)

### 11. Package exports update

**File:** `lib/testCases/index.ts` — export `test` as the primary API:
```typescript
export { test, getRegisteredTests, clearRegistry } from './define.js';
export { defineTestCases } from './compat.js';  // Deprecated wrapper
export { judge } from './judge.js';
export type { TestOptions, CodeTestCase, EvalResult } from './types.js';
```

**File:** `lib/index.ts`:
```typescript
export { test, defineTestCases, judge } from './testCases/index.js';
export { expect } from 'chai';
```

---

## Critical Files to Modify

| File | Change |
|------|--------|
| `types/index.ts` | Add `evaluationType` to TestCaseVersion, rename `sourceUri` → `sourceFile`, remove `evaluationType` from TestCaseRun |
| `lib/testCases/types.ts` | Add `TestOptions` with `agentic: boolean`, update `CodeTestCase` |
| `lib/testCases/define.ts` | Replace `defineTestCases()` with `test()` registration + validation |
| `lib/testCases/loader.ts` | Per-test-case hash, use registry pattern, drop per-file hash |
| `lib/testCases/index.ts` | Update barrel exports for new API |
| `server/constants/indexMappings.ts` | `sourceFile` + `evaluationType` on testCases, remove from runs |
| `server/adapters/file/StorageModule.ts` | Match on `sourceFile`, pass `evaluationType` to version |
| `server/adapters/opensearch/StorageModule.ts` | Same changes as file adapter |
| `services/sourceResolver.ts` | Use `sourceFile` (relative), per-test-case hash, pass `evaluationType` |
| `services/evaluationRunner.ts` | Remove `evaluationType` from report, keep `assertionError` |
| `components/RunDetailsContent.tsx` | Read `evaluationType` from test case version, not report |
| `components/evals3/TestCasesPage.tsx` | Badge on `sourceFile` not `sourceUri` |

---

## Reuse from Existing Code

- **Versioning:** `server/adapters/file/StorageModule.ts` → `update()` already increments version. Just need to pass `evaluationType` as part of the update payload.
- **Source resolver:** `services/sourceResolver.ts` → existing `resolveCodeImport()` is the base.
- **Config loader:** `lib/config/loader.ts` uses same `pathToFileURL` + dynamic import.
- **Hash:** `crypto.createHash('sha256')` already used in loader.
- **Debug logging:** `lib/debug.ts` → `debug('SDK', ...)`.

---

## Verification Plan

1. **Build:** `npm run build:all` passes
2. **Unit tests:** `npm run test:unit` — all pass (new + updated)
3. **Integration test:** Run with `.eval.ts` fixture using `test()` API:
   - `evaluationType: 'deterministic'` appears on the TestCaseVersion (not run)
   - `sourceFile` stores relative path
   - Per-test-case hash: changing one test only versions that test
   - `agentic: true` test → `evaluationType: 'agentic'` on version
4. **UI:** Version details show evaluation type badge; deterministic hides judge reasoning
5. **E2E:** Existing e2e tests pass, new Observio e2e tests exercise both paths
6. **Backward compat:** Old test cases without `evaluationType` on version render as LLM-judged (default)
7. **`defineTestCases()` compat:** Old-style array usage still works via deprecated wrapper
