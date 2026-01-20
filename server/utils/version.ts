/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';

let cachedVersion: string | null = null;

export function getVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion;
  }

  try {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    cachedVersion = packageJson.version || 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }

  return cachedVersion;
}
