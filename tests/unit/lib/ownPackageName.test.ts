/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A forked/renamed publish (e.g. `@myorg/agent-health`) must self-reference
 * by its OWN package name in generated artifacts (init config template,
 * setup slash-command invoke), not the hardcoded upstream name — otherwise
 * `init` emits an import that cannot resolve under the fork install (#370
 * adversarial-review follow-up).
 */

import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockGetPackageRoot = jest.fn();

jest.mock('@/lib/packagePaths', () => ({
  getPackageRoot: () => mockGetPackageRoot(),
}));

import { getOwnPackageName, DEFAULT_PACKAGE_NAME } from '@/lib/ownPackageName';

describe('getOwnPackageName', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the name from the package root package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-pkgname-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@myorg/agent-health' }));
    mockGetPackageRoot.mockReturnValue(dir);
    expect(getOwnPackageName()).toBe('@myorg/agent-health');
  });

  it('returns the upstream default when package.json has no name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-pkgname-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    mockGetPackageRoot.mockReturnValue(dir);
    expect(getOwnPackageName()).toBe(DEFAULT_PACKAGE_NAME);
  });

  it('returns the upstream default when package.json is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-pkgname-'));
    writeFileSync(join(dir, 'package.json'), '{not json');
    mockGetPackageRoot.mockReturnValue(dir);
    expect(getOwnPackageName()).toBe(DEFAULT_PACKAGE_NAME);
  });

  it('returns the upstream default when the package root is unreadable', () => {
    mockGetPackageRoot.mockReturnValue('/nonexistent/path/for/sure');
    expect(getOwnPackageName()).toBe(DEFAULT_PACKAGE_NAME);
  });

  it('returns the upstream default when getPackageRoot throws', () => {
    mockGetPackageRoot.mockImplementation(() => { throw new Error('no root'); });
    expect(getOwnPackageName()).toBe(DEFAULT_PACKAGE_NAME);
  });

  it('the default is the upstream package name', () => {
    expect(DEFAULT_PACKAGE_NAME).toBe('@opensearch-project/agent-health');
  });
});
