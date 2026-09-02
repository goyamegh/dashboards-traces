/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolve the name this package was published under.
 *
 * Generated artifacts (the `init` config template, the `setup` slash
 * command) must self-reference the package by the name in OUR OWN
 * package.json, so a forked/renamed publish (e.g. `@myorg/agent-health`)
 * keeps producing artifacts that resolve — instead of hardcoding the
 * upstream name and emitting imports the fork install can't satisfy.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getPackageRoot } from './packagePaths.js';

export const DEFAULT_PACKAGE_NAME = '@opensearch-project/agent-health';

/**
 * The `name` field of this package's own package.json, falling back to the
 * upstream name if the package root or manifest cannot be read.
 */
export function getOwnPackageName(): string {
  try {
    const pkgPath = join(getPackageRoot(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return (pkg && typeof pkg.name === 'string' && pkg.name) || DEFAULT_PACKAGE_NAME;
  } catch {
    return DEFAULT_PACKAGE_NAME;
  }
}
