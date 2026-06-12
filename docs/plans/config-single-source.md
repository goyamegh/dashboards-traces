# Plan: single-source config (`.ts` authored, `.agent-health/` runtime state)

Status: proposed · Follow-up to #261 · Owner: goyamegh

## Goal

Make `agent-health.config.ts` the **one file a human authors**, and turn today's
`agent-health.config.json` into **runtime state the app owns** — renamed to
`.agent-health/state.json`, gitignored, undocumented as "config", and **ignored
entirely when an authored config file is present**.

Add **user + project scoping** to `.agent-health/` (like git/npm config), so a
developer with many worktrees can set clusters once at `~/.agent-health/`.

## Non-goals

- No new runtime TypeScript dependency. UI-first users never need `.ts`, so we do
  not have to ship `tsx` at runtime.
- No change to how the Claude Code subprocess emits traces (`connectorConfig.env`).
- Moving the file-storage data dir (`agent-health-data/`) is **out of scope**
  (noted as optional future consolidation under `.agent-health/data/`).

## The model: two modes, picked by presence of an authored config file

| Mode | Trigger | Source of truth | State file |
|---|---|---|---|
| **Code-first** | `agent-health.config.{ts,js,mjs}` exists (project **or** user scope) | `.ts` + `.env` | **ignored** |
| **UI-first** | no authored config file anywhere | `.agent-health/state.json` (+ `.env`) | **read/written** |

Single rule (replaces the `JSON > TS > env` precedence shipped in #261):
**authored config present ⇒ state file ignored.** No merge, no drift, no shadowing.

## File layout & scoping

```
~/.agent-health/                 # USER scope
  agent-health.config.ts         #   optional user-global authored config
  state.json                     #   user-global runtime state (UI-written)

<cwd>/.agent-health/             # PROJECT scope
  state.json                     #   project runtime state (UI-written)
<cwd>/agent-health.config.ts     # project authored config
```

Resolution (each tier overrides the one below):

- **Code-first:** project `.ts` → user `~/.agent-health/*.ts` (existing `extends`
  semantics) → `.env`.
- **UI-first:** project `.agent-health/state.json` → user `~/.agent-health/state.json`
  → `OPENSEARCH_*` env → file-storage fallback.

State keys are merged **per top-level key** (`storage`, `observability`,
`customAgents`, `debug`, `remoteServers`), project overriding user.

UI/CLI writes target **project** scope by default; a `--global` flag (CLI) /
toggle (UI, deferred) writes user scope.

---

## Phase 1 — core (no UI changes required)

### 1.1 New module: `lib/config/statePaths.ts`

Single source for paths + mode. Lives in `lib/` so both server services and
`lib/debug.ts` import it.

```ts
export const STATE_DIRNAME = '.agent-health';
export const STATE_FILENAME = 'state.json';
export const AUTHORED_CONFIG_NAMES = ['agent-health.config.ts', 'agent-health.config.js', 'agent-health.config.mjs'];

export function projectStateDir(cwd = process.cwd()): string;   // <cwd>/.agent-health
export function userStateDir(): string;                          // ~/.agent-health
export function projectStatePath(cwd?): string;                  // <cwd>/.agent-health/state.json
export function userStatePath(): string;                         // ~/.agent-health/state.json

// presence checks (project OR user)
export function hasAuthoredConfig(cwd?): boolean;                // any AUTHORED_CONFIG_NAMES in project or user dir
export function isCodeFirstMode(cwd?): boolean;                  // = hasAuthoredConfig()

// layered read/write
export function readLayeredState(cwd?): Record<string, unknown>; // {} in code-first mode; else project-over-user shallow merge
export function writeState(partial, scope: 'project'|'user', cwd?): void; // creates dir, preserves sibling keys, refuses in code-first mode
```

`readLayeredState()` returns `{}` when `isCodeFirstMode()` is true → every state
getter naturally yields "not configured."

### 1.2 Rewire the 5 readers/writers to use `statePaths`

Replace the hard-coded `path.join(process.cwd(), 'agent-health.config.json')` and
the per-file `CONFIG_FILENAME` constants. Today's JSON holds **5 top-level keys**:

| Key | Owner module | Change |
|---|---|---|
| `storage`, `observability` | `server/services/configService.ts` | read via `readLayeredState()`; `save*`/`clear*` call `writeState(scope='project')` and **throw in code-first mode**. `getConfigStatus()` reports `source: 'typescript' \| 'state' \| 'environment' \| 'none'` (rename `'file'`→`'state'`). |
| `customAgents` | `server/services/customAgentStore.ts` | hydrate from `readLayeredState()`; `addCustomAgent`/`removeCustomAgent` → `writeState`; **no-op + warn in code-first mode** (agents come from `.ts`). |
| `debug` | `lib/debug.ts` | read from `readLayeredState()`; persist via `writeState`; in code-first mode keep **in-memory only** (no file write), still honoring `DEBUG` env. |
| `remoteServers` | `server/routes/config.ts`, `server/services/codingAgents/remoteConfig.ts`, `server/services/codingAgents/createRegistry.ts` | read via `readLayeredState()`; add/delete → `writeState`; **refuse in code-first mode**. |

### 1.3 Mode gate on write endpoints

In code-first mode, the data-source/remote/agent **write** endpoints return `409`
with `{ error: 'managed by agent-health.config.ts' }`:

- `POST/DELETE /api/storage/config/storage`, `.../observability` (`server/routes/storage/admin.ts`)
- `POST/DELETE /api/remote-servers...` (`server/routes/config.ts`)
- custom-agent add/remove route (wherever `addCustomAgent` is mounted)

Reads/test-connection stay available in both modes.

### 1.4 Loader presence-probe + startup log (`lib/config/loader.ts`)

- Replace `SERVER_JSON_CONFIG_FILENAME`/`hasServerJsonConfig` with a
  `.agent-health/state.json` (project+user) probe.
- Startup log states the active mode: `"[Config] code-first (agent-health.config.ts) — state file ignored"` or `"[Config] ui-first — state: <path>"`.

### 1.5 Revisit #261 precedence

The #261 branch shipped `JSON > TS > env` (via `getStorageConfigFromTs` +
`resolveStorageConfig`). This plan replaces that with the mode gate. Decision
needed (see Open questions): fold the mode gate into #261 before PR, **or** land
#261 as-is and revise here.

---

## Phase 2 — migration & housekeeping

### 2.1 Extend `server/services/configMigration.ts`

Runs once at startup (already wired in `server/app.ts`):

1. `agent-health.yaml` → `.agent-health/state.json` (existing yaml path, new target).
2. `agent-health.config.json` (legacy) → `.agent-health/state.json` (move the 5
   keys, create dir, then delete or rename legacy to `agent-health.config.json.bak`).
3. **Both legacy JSON and a `.ts` present** (e.g. current pr-206 worktree): still
   migrate to `state.json`, but log a clear warning that the migrated `storage`/
   `observability` are now **ignored** (code-first), and print the exact `.ts`
   snippet to paste (since #261 makes those fields work).

### 2.2 `.gitignore`

Add `.agent-health/` (and keep ignoring `agent-health-data/`).

---

## Phase 3 — UI (DEFERRED / optional; core works without it)

> The user is undecided on UI changes. Phase 1+2 are fully functional without
> touching the UI. **Without** Phase 3, in code-first mode the existing Settings
> "Save" buttons hit the `409` and surface an error toast — acceptable interim;
> the source badge added in #261 already shows `agent-health.config.ts`.

If/when we do it:
- Data-source panels render **read-only** in code-first mode with
  *"Managed by `agent-health.config.ts` — edit the file and restart"* + a
  "copy snippet" button; writable in UI-first.
- Source badge gains the renamed `'state'` value and a user-vs-project indicator.
- (`components/SettingsPage.tsx`, `lib/dataSourceConfig.ts` `ConfigStatus` type.)

---

## Docs changes

- `docs/CONFIGURATION.md`: replace the "Two config files, and why" section with
  the **two-mode** model + the `~/.agent-health` / `.agent-health` layout. Stop
  documenting the state file as authored config.
- `agent-health.config.example.ts` + `examples/config/agent-health.config.example.ts`:
  keep the `storage`/`observability` examples (still valid); add a one-line note
  that having this file switches you to code-first mode (UI data-source editing
  becomes read-only).
- `CHANGELOG.md`: `### Changed` (rename + mode gate + scoping) and `### Added`
  (`~/.agent-health` user scope), referencing this plan's issue.

## Tests

- `tests/unit/lib/config/statePaths.test.ts` (new): project/user path resolution,
  `isCodeFirstMode`, `readLayeredState` project-over-user merge, code-first ⇒ `{}`.
- `configServiceImpl.test.ts`: code-first ⇒ getters null + `save*` throws;
  UI-first ⇒ project+user layering; `getConfigStatus` source values.
- `tests/unit/server/middleware/dataSourceConfig.test.ts`: update precedence to
  the mode gate.
- `customAgentStore.test.ts`: hydrate from layered state; code-first ⇒ add is no-op.
- migration tests: yaml→state, legacy-json→state, both-present warning.
- route tests: `409` from write endpoints in code-first mode.

## Sequencing (small, reviewable PRs)

1. **#261 (open branch)** — make `.ts` storage/observability work. *(done; pending precedence decision below.)*
2. **config-v2 core** — Phase 1 + 2 (statePaths module, rewire 5 owners, mode gate, migration, gitignore, docs, tests). No UI.
3. **config-v2 UI** — Phase 3 (optional, separate PR).

## Open questions

1. **Strict vs scoped ignore:** literal rule is "`.ts` present ⇒ state ignored
   *entirely*" (a `.ts` with only `agents` makes storage fall to env/fallback, not
   state). Confirm strict, or "ignore state only for keys the `.ts` defines."
2. **#261 precedence:** fold the mode gate into #261 before PR, or land #261 with
   `JSON>TS>env` and supersede here?
3. **Default write scope:** UI/CLI writes to **project** `.agent-health/state.json`
   by default — confirm (vs. prompt for project-vs-user).
4. **customAgents/debug in code-first mode:** confirm code-first users manage
   agents in `.ts` and accept debug as in-memory/`DEBUG`-env only.
