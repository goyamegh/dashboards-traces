/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helper to locate the agent-health package root from any starting
 * directory.
 *
 * Kept in its own file (no `import.meta.url`) so it can be unit-tested with
 * ts-jest's CommonJS loader without needing module mocks.
 *
 * The walk preferentially anchors on the agent-health package.json (matched
 * by `name`) so we don't stop at a parent monorepo root or a wrapper
 * package.json. If no matching package.json is found within `maxLevels`
 * (e.g., the user has forked and renamed the package), we fall back to the
 * nearest package.json on the path — best-effort.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const PACKAGE_NAME = '@opensearch-project/agent-health';
const DEFAULT_MAX_LEVELS = 6;

/**
 * Walk up from `startDir` looking for the agent-health package root.
 *
 * @throws if no package.json is found within `maxLevels` parents.
 */
export function findPackageRootFrom(
  startDir: string,
  maxLevels: number = DEFAULT_MAX_LEVELS,
): string {
  // First pass: prefer a package.json with the canonical agent-health name.
  let dir = resolve(startDir);
  let firstPkgRoot: string | null = null;

  for (let i = 0; i <= maxLevels; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      if (firstPkgRoot === null) firstPkgRoot = dir;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg && pkg.name === PACKAGE_NAME) return dir;
      } catch {
        /* unreadable / unparseable package.json — keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: nearest package.json regardless of name. Covers forks that
  // rename the package and unusual local layouts.
  if (firstPkgRoot !== null) return firstPkgRoot;

  throw new Error(
    `Could not locate package root for ${PACKAGE_NAME} from ${startDir} ` +
    `within ${maxLevels} parent directories`,
  );
}
