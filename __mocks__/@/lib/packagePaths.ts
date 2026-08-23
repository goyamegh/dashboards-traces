/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jest mock for `@/lib/packagePaths`.
 *
 * The real module uses `import.meta.url`, which ts-jest's CommonJS loader
 * cannot evaluate. This mock returns paths anchored at the repo root
 * (i.e., the current Jest `rootDir`), which is the right answer when tests
 * are run from a checkout — and matches what the real resolver would
 * compute in that environment.
 */

import { resolve, join } from 'path';

// __dirname here is `<repo>/__mocks__/@/lib/`. Up three levels = repo root.
const PACKAGE_ROOT = resolve(__dirname, '..', '..', '..');

export function getPackageRoot(): string {
  return PACKAGE_ROOT;
}

export function getSkillPath(fileName: string = 'AGENT_HEALTH.md'): string {
  return join(PACKAGE_ROOT, 'docs', 'skills', fileName);
}

export function getPiPackagePath(): string {
  return join(PACKAGE_ROOT, 'observio-sample-agent', 'pi-package');
}

export function _resetPackageRootCacheForTests(): void {
  /* no-op in mock */
}
