# Plan: Code-Based Test Case SDK — Field Redesign (v2)

## Status (as of 2026-05-16)

### Completed (in working tree, not yet committed)
- [x] `lib/testCases/types.ts` — Rewritten with `TestOptions` (prompt required), `CodeTestCase`, `EvalResult`
- [x] `lib/testCases/define.ts` — Rewritten with `test()` API, file-scoped registries, `defineTestCases()` compat wrapper
- [x] `lib/testCases/judge.ts` — Rewritten with runtime `wasJudgeCalled()`/`resetJudgeFlag()` flags
- [x] `lib/testCases/loader.ts` — Rewritten with per-test-case `computeTestCaseHash()`, file-scoped loading via registry
- [x] `lib/testCases/index.ts` — Updated barrel exports for new API
- [x] `lib/index.ts` — Added SDK exports (`test`, `defineTestCases`, `judge`, `expect`)
- [x] `services/sourceResolver.ts` — Added `EvaluateFn` type, `evaluateFnMap` to `ResolvedSources`, `code-import` case in switch (partial — needs unification to `import` type)

### Not Started
- [ ] Unified `import` source type (replace `file-import` + `code-import` + `directory-import`)
- [ ] `services/evaluationRunner.ts` — Deterministic eval path with `resetJudgeFlag`/`wasJudgeCalled` inference
- [ ] `types/index.ts` — `sourceFile` replaces `sourceUri`, `evaluationType` on TestCaseVersion, unified source type
- [ ] `server/constants/indexMappings.ts` — `sourceFile` field
- [ ] `server/adapters/file/StorageModule.ts` — `bulkUpsert` match on `sourceFile`
- [ ] `server/adapters/opensearch/StorageModule.ts` — same
- [ ] `cli/commands/benchmark.ts` — `-f` accepts dirs, exit codes, `--reporter`
- [ ] `cli/reporters/` — `summary.ts`, `junit.ts`, `json.ts`
- [ ] `components/RunDetailsContent.tsx` — Read evaluationType from version
- [ ] `components/evals3/TestCasesPage.tsx` — Badge on `sourceFile`
- [ ] All test updates (see step 11)

### Key Context for Handoff
- Branch: `feat/test-case-sdk` (local only, working tree has uncommitted changes)
- The v1 implementation (committed on remote `feat/test-case-sdk`) uses `sourceUri`, `defineTestCases()`, per-file hash, and `evaluationType` on TestCaseRun. All of that is being replaced.
- `evaluationRunner.ts` already has `runWithConcurrencyLimit()` — no need for `p-limit` dep.
- The plan file was pushed to `fork/docs/sdk-field-redesign-plan` branch.
- Existing tests reference old field names (`sourceUri`, old `defineTestCases` API) and will need updating.

---

## Context

The initial SDK implementation (steps 1-11) is complete and passing. This redesign incorporates principal engineer review feedback to make the SDK actually production-ready — not just a working API, but something teams adopt over alternatives (Promptfoo, Braintrust, Langsmith).

**Core insight:** The previous plan focused on internal field placement. This revision prioritizes the **customer-facing contract** — the API signature, CI exit codes, parallelism, and cost visibility — and defers internal storage plumbing where it doesn't block adoption.

**Key changes from v1:**
1. **Kill `agentic: boolean`** — infer evaluation type at runtime from whether `judge()` was called. No customer-facing field.
2. **Add explicit `prompt` field** — test name is a description, prompt is what gets sent to the agent.
3. **Add `--concurrency N`** — parallel test execution with semaphore.
4. **Define CI contract** — exit codes, `--reporter junit|json`, pass/fail gate.
5. **File-scoped isolation** — each file gets its own registry (no global mutable state).
6. **Unify source types** — merge `file-import`, `code-import`, `directory-import` into a single `import` type that auto-detects by extension. `-f` accepts files and dirs.

---

## Implementation Steps

### 1. Redesign SDK API: `test()` with explicit prompt

**Files:** `lib/testCases/types.ts`, `lib/testCases/define.ts`

```typescript
// lib/testCases/types.ts
export interface TestOptions {
  prompt: string;              // REQUIRED — what gets sent to the agent
  category: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  description?: string;
  context?: { description: string; value: string }[];
  labels?: string[];
  timeout?: number;            // ms, default 120000 (2 min)
}

export interface CodeTestCase {
  name: string;
  options: TestOptions;
  evaluate: (result: EvalResult) => Promise<void> | void;
}

export interface EvalResult {
  trajectory: TrajectoryStep[];
  agentOutput: string;
  rawEvents: any[];
  runId?: string;
  durationMs: number;
  tokenUsage?: { prompt: number; completion: number; total: number };
}
```

```typescript
// lib/testCases/define.ts
export interface FileRegistry {
  tests: CodeTestCase[];
  filePath?: string;
}

// Per-file registries (keyed by absolute file path)
const registries = new Map<string, FileRegistry>();
let activeFile: string | null = null;

export function setActiveFile(filePath: string): void {
  activeFile = filePath;
  if (!registries.has(filePath)) {
    registries.set(filePath, { tests: [], filePath });
  }
}

export function test(
  name: string,
  options: TestOptions,
  evaluate: (result: EvalResult) => Promise<void> | void
): void {
  if (!name || typeof name !== 'string') throw new Error('test() requires a name');
  if (!options.prompt) throw new Error('test() requires options.prompt');
  if (!options.category) throw new Error('test() requires options.category');
  if (!options.difficulty) throw new Error('test() requires options.difficulty');
  if (typeof evaluate !== 'function') throw new Error('test() requires an evaluate function');

  const registry = activeFile ? registries.get(activeFile)! : getDefaultRegistry();
  registry.tests.push({ name, options, evaluate });
}

export function getRegisteredTests(filePath?: string): CodeTestCase[] {
  if (filePath) return [...(registries.get(filePath)?.tests ?? [])];
  // Return all tests across all files
  return [...registries.values()].flatMap(r => [...r.tests]);
}

export function clearRegistry(filePath?: string): void {
  if (filePath) registries.delete(filePath);
  else registries.clear();
}
```

**Customer usage:**
```typescript
// evals/cybergym.eval.ts
import { test, expect } from '@opensearch-project/agent-health';

test('CyberGym Task 42', {
  prompt: 'Analyze the vulnerability in the authentication module and provide a proof of concept exploit',
  category: 'Security',
  difficulty: 'Hard',
}, async (result) => {
  const poc = extractPoc(result.agentOutput);
  const res = await submitToCyberGym(poc, 'task-42');
  expect(res.exit_code).to.not.equal(0);
});

test('RCA Log Analysis', {
  prompt: 'Investigate the spike in 5xx errors starting at 14:30 UTC. Identify the root cause.',
  category: 'RCA',
  difficulty: 'Medium',
}, async (result) => {
  // Use LLM judge for semantic evaluation
  await judge(result.trajectory, ['Identifies root cause', 'Suggests remediation']);
  // Can also add deterministic checks
  expect(result.durationMs).to.be.lessThan(60000);
});
```

### 2. Infer `evaluationType` at runtime (kill `agentic` field)

**No customer-facing field.** Instead, detect at runtime:

**File:** `lib/testCases/judge.ts`

```typescript
// Thread-local flag set when judge() is called during evaluate()
let judgeCalledInCurrentEval = false;

export function wasJudgeCalled(): boolean {
  return judgeCalledInCurrentEval;
}

export function resetJudgeFlag(): void {
  judgeCalledInCurrentEval = false;
}

export async function judge(trajectory: TrajectoryStep[], criteria: string[]): Promise<JudgeVerdict> {
  judgeCalledInCurrentEval = true;
  // Call LLM judge, return verdict
  // ...
}
```

**File:** `services/evaluationRunner.ts` — after calling evaluate():

```typescript
resetJudgeFlag();
try {
  await evalFn({ trajectory, agentOutput, rawEvents, durationMs });
  const usedJudge = wasJudgeCalled();
  report.passFailStatus = 'passed';
  // evaluationType is inferred, stored on version after first run
} catch (evalError: any) {
  const usedJudge = wasJudgeCalled();
  report.passFailStatus = 'failed';
  report.assertionError = evalError.message;
}
```

**On TestCaseVersion:** `evaluationType` is set after the first execution:
- If `judge()` was called → `'agentic'`
- If only assertions → `'deterministic'`
- If both → `'hybrid'` (new value)

This means version gets its `evaluationType` lazily on first run, not at import time.

### 3. Replace `sourceUri` with `sourceFile` + per-test-case hash

**File:** `types/index.ts` — on TestCase:
```typescript
sourceFile?: string;   // Relative path: "evals/cybergym.eval.ts"
sourceHash?: string;   // SHA-256 of per-test-case content (not the whole file)
```

**Per-test-case hash** (`lib/testCases/loader.ts`):
```typescript
export function computeTestCaseHash(tc: CodeTestCase): string {
  const content = JSON.stringify({
    name: tc.name,
    prompt: tc.options.prompt,
    category: tc.options.category,
    difficulty: tc.options.difficulty,
    context: tc.options.context,
    labels: tc.options.labels,
    description: tc.options.description,
  });
  return crypto.createHash('sha256').update(content).digest('hex');
}
```

**Match key for upsert:** `name + sourceFile`

### 4. Add `--concurrency N` to benchmark runner

**File:** `cli/commands/benchmark.ts` — add option:
```typescript
.option('-c, --concurrency <number>', 'Number of parallel test executions', '3')
```

**File:** `services/evaluationRunner.ts` — parallel execution with semaphore:

```typescript
import pLimit from 'p-limit';

export async function executeEvaluationRun(run, testCases, options) {
  const concurrency = options.concurrency ?? 3;
  const limit = pLimit(concurrency);

  const tasks = testCases.map(tc =>
    limit(() => executeSingleTestCase(run, tc, options))
  );

  await Promise.allSettled(tasks);
}
```

**New dependency:** `p-limit` (tiny, zero-dep semaphore).

### 5. Define CI contract: exit codes + reporters

**File:** `cli/commands/benchmark.ts`:

```typescript
.option('--reporter <type>', 'Output format: summary (default), junit, json, tap', 'summary')
.option('--fail-fast', 'Stop on first failure')
```

**Exit codes:**
- `0` — all tests passed
- `1` — one or more tests failed
- `2` — configuration error (bad file, missing agent, etc.)

**File:** `cli/reporters/` (new directory):

| File | Purpose |
|------|---------|
| `summary.ts` | Default terminal output (pass/fail counts, duration, cost) |
| `junit.ts` | JUnit XML for CI integration (GitHub Actions, Jenkins) |
| `json.ts` | Machine-readable JSON (for programmatic consumption) |

**JUnit output** enables:
```yaml
# .github/workflows/eval.yml
- run: npx agent-health benchmark -f evals/ -a my-agent --reporter junit > results.xml
- uses: dorny/test-reporter@v1
  with:
    reporter: java-junit
    path: results.xml
```

### 6. Add timeout + cost visibility

**Timeout per test case** (from `TestOptions.timeout`, default 120s):
```typescript
const result = await Promise.race([
  runAgentAndEvaluate(tc),
  timeout(tc.options.timeout ?? 120000),
]);
```

**Cost summary** in reporter output:
```
Results: 48 passed, 2 failed (50 total)
Duration: 4m 32s
Tokens: 1.2M prompt / 340K completion
Est. cost: $4.82 (agent) + $1.20 (judge) = $6.02
```

**File:** `cli/reporters/summary.ts` — aggregate token usage from all runs and compute cost based on model pricing from config.

### 7. Move `evaluationType` to TestCaseVersion

**File:** `types/index.ts`

```typescript
export interface TestCaseVersion {
  // ... existing fields ...
  evaluationType?: 'agentic' | 'deterministic' | 'hybrid';
}
```

Remove from `TestCaseRun`. Keep `assertionError` on run (execution-time data).

**Lazy population:** On first execution of a code-imported test case, update the version's `evaluationType` based on runtime inference (step 2). Subsequent runs don't change it (immutable once set).

### 8. Update storage: `sourceFile` + match logic

**File:** `server/constants/indexMappings.ts`:
```diff
- sourceUri: { type: 'keyword' },
+ sourceFile: { type: 'keyword' },
  sourceHash: { type: 'keyword' },
```

**File:** `server/adapters/file/StorageModule.ts` + `opensearch/StorageModule.ts`:
- `bulkUpsert` matches on `name + sourceFile`
- On hash change → new version (with `evaluationType` if known)

### 9. Unified `import` source type in source resolver

**File:** `services/sourceResolver.ts`

Replace the three separate source types (`file-import`, `code-import`, `directory-import`) with a single `import` type:

```typescript
case 'import': {
  const { testCases, fnMap } = await resolveImport(source.paths, storage);
  // ...
}
```

**`resolveImport(paths, storage)`** handles the unified logic:
1. For each path, check if it's a file or directory
2. If directory → scan for `*.eval.ts`, `*.eval.js`, `*.json` recursively
3. For each file, route by extension:
   - `.json` → existing JSON import path (parse + `bulkCreate`)
   - `.ts` / `.js` / `.mjs` → code import path (load module + `bulkUpsert`)
4. Code files produce `evaluateFnMap` entries; JSON files don't
5. Return combined test cases + fnMap

**CLI `-f` flag** accepts both files and directories:
```bash
npx agent-health benchmark -f evals/              # scans dir
npx agent-health benchmark -f evals/rca.eval.ts   # single code file  
npx agent-health benchmark -f test-cases.json     # single JSON file
npx agent-health benchmark -f evals/ -f extra.json # mixed
```

**`TestCaseSource` type** simplification:
```typescript
// Before: 3 source types
| { type: 'file-import'; filenames: string[]; testCaseIds: string[] }
| { type: 'code-import'; filenames: string[]; testCaseIds: string[] }
| { type: 'directory-import'; dirPaths: string[]; testCaseIds: string[] }

// After: 1 unified type
| { type: 'import'; paths: string[]; testCaseIds: string[] }
```

Keep old types as aliases for backward compat (existing benchmarks may have these in storage).

### 10. Update UI

**File:** `components/evals3/TestCasesPage.tsx`:
- "Code" badge on `testCase.sourceFile` (not `sourceUri`)
- Disable edit for code-sourced test cases

**File:** `components/RunDetailsContent.tsx`:
- Read `evaluationType` from test case version (not report)
- Show "Hybrid" badge when both judge and assertions were used
- Show assertion error for deterministic/hybrid failures

### 11. Update existing tests

| Test File | Change |
|-----------|--------|
| `tests/unit/lib/testCases/define.test.ts` | Rewrite for `test()` API with `prompt` field, file-scoped registry |
| `tests/unit/services/evaluationRunner.deterministic.test.ts` | Remove `evaluationType` from report assertions |
| `tests/unit/services/sourceResolver.codeImport.test.ts` | `sourceFile` instead of `sourceUri`, prompt field |
| `tests/unit/server/adapters/bulkUpsert.test.ts` | Match on `sourceFile` |
| `tests/integration/services/sourceResolver.codeImport.integration.test.ts` | Update for new API |
| `tests/integration/services/codeSdkObservio.integration.test.ts` | Update field references |
| `tests/unit/cli/reporters/` (new) | Test junit, json, summary output |

### 12. Package exports

**File:** `lib/testCases/index.ts`:
```typescript
export { test, getRegisteredTests, clearRegistry } from './define.js';
export { judge } from './judge.js';
export { defineTestCases } from './compat.js';  // Deprecated
export type { TestOptions, CodeTestCase, EvalResult } from './types.js';
```

**File:** `lib/index.ts`:
```typescript
export { test, defineTestCases, judge } from './testCases/index.js';
export { expect } from 'chai';
```

**New dependency:** `p-limit` (production — for concurrency control).

---

## Critical Files to Modify

| File | Change |
|------|--------|
| `lib/testCases/types.ts` | `TestOptions` with `prompt` (required), `timeout`; drop `agentic` |
| `lib/testCases/define.ts` | File-scoped registries, `test()` with prompt validation |
| `lib/testCases/loader.ts` | Per-test-case hash, file-scoped loading |
| `lib/testCases/judge.ts` | Runtime flag for `judge()` calls |
| `services/evaluationRunner.ts` | Parallel execution (`p-limit`), timeout, infer evaluationType |
| `services/sourceResolver.ts` | Unified `import` source type, `sourceFile` (relative), per-test-case hash |
| `types/index.ts` | Replace 3 source types with unified `import` type |
| `cli/commands/benchmark.ts` | `-f` accepts files+dirs, `--reporter`, `--fail-fast`, exit codes |
| `cli/reporters/` (new) | `summary.ts`, `junit.ts`, `json.ts` |
| `types/index.ts` | `evaluationType` on TestCaseVersion (lazy), `sourceFile` on TestCase |
| `server/constants/indexMappings.ts` | `sourceFile` replaces `sourceUri` |
| `server/adapters/file/StorageModule.ts` | Match on `sourceFile` in bulkUpsert |
| `components/RunDetailsContent.tsx` | Read evaluationType from version |
| `components/evals3/TestCasesPage.tsx` | Badge on `sourceFile` |

---

## Implementation Order (prioritized by customer impact)

1. **SDK API** (steps 1-2) — `test()` with prompt, file-scoped registry, runtime inference
2. **CI contract** (step 5) — exit codes, reporters
3. **Parallelism + timeout** (steps 4, 6) — `--concurrency`, per-test timeout
4. **Storage redesign** (steps 3, 7, 8, 9) — sourceFile, per-test hash, version-level evaluationType
5. **UI** (step 10) — badges, version-aware rendering
6. **Tests** (step 11) — update all affected tests
7. **Exports** (step 12) — package API surface

---

## Verification Plan

1. **Build:** `npm run build:all` passes
2. **Unit tests:** `npm run test:unit` — all pass
3. **CI contract test:** `npx agent-health benchmark -f tests/fixtures/sample.eval.ts -a observio --reporter json` returns exit 0/1 correctly
4. **Parallel test:** 10 test cases with `--concurrency 5` complete in ~2x single-case time (not 10x)
5. **JUnit output:** Valid XML parseable by `dorny/test-reporter`
6. **Cost summary:** Token counts + estimated cost displayed in summary reporter
7. **Per-test hash:** Modify one test in a multi-test file → only that test gets new version
8. **Runtime inference:** Test with `judge()` → version gets `evaluationType: 'agentic'`; test without → `'deterministic'`; test with both → `'hybrid'`
9. **Timeout:** Test case exceeding timeout fails with clear error message
10. **Backward compat:** `defineTestCases([...])` still works, old test cases render correctly
