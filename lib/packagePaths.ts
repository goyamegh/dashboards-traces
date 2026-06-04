/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Package asset path resolution.
 *
 * Resolves the location of files that ship inside the agent-health package
 * (skill markdown files, the bundled pi-package, etc.) regardless of the
 * caller's working directory. This unblocks running agent-health from a
 * directory other than the repo root (e.g., from inside the user's own
 * agent project).
 *
 * Anchors on `import.meta.url` of THIS module, then walks upwards looking
 * for the agent-health package's own `package.json`. The pure walking
 * logic lives in `findPackageRoot.ts` so it can be unit-tested under
 * Jest's CommonJS loader (which doesn't support `import.meta.url`).
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { findPackageRootFrom } from './findPackageRoot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedRoot: string | null = null;

/**
 * Absolute path to the agent-health package root, computed once per process.
 *
 * Works in three runtime contexts:
 *  - Production (`node_modules/@opensearch-project/agent-health/...`)
 *  - Local dev from a checkout (`<repo>/...`)
 *  - Bundled output from esbuild (`<root>/server/dist/...`)
 *
 * @throws if the package root cannot be located.
 */
export function getPackageRoot(): string {
  if (cachedRoot) return cachedRoot;
  cachedRoot = findPackageRootFrom(__dirname);
  return cachedRoot;
}

/**
 * Resolve a path inside `<package_root>/docs/skills/`.
 *
 * @param fileName  Defaults to `AGENT_HEALTH.md` for the top-level skill.
 */
export function getSkillPath(fileName: string = 'AGENT_HEALTH.md'): string {
  return join(getPackageRoot(), 'docs', 'skills', fileName);
}

/**
 * Resolve the bundled pi-package directory shipped alongside the
 * Observio sample agent. Used by the Pi judge service.
 */
export function getPiPackagePath(): string {
  return join(getPackageRoot(), 'observio-sample-agent', 'pi-package');
}

/**
 * TEST-ONLY: reset the cached root. Exported so unit tests for the
 * resolver itself (or downstream services) can re-evaluate without
 * spawning a fresh process.
 */
export function _resetPackageRootCacheForTests(): void {
  cachedRoot = null;
}
