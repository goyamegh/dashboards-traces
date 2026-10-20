/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Harness for tests that exercise the REAL AWS credential provider chain
 * against a temp `~/.aws/credentials` that is rewritten mid-test (what
 * `aws configure` / credential helpers do when a profile is rotated).
 *
 * The chain (`@aws-sdk/credential-provider-node`) loads its members with
 * dynamic `import()`, which Jest's CJS VM cannot execute, so the code under
 * test runs in a child Node process via `tsx`. The child receives the temp
 * profile through the standard `AWS_SHARED_CREDENTIALS_FILE` /
 * `AWS_CONFIG_FILE` variables and prints ONE JSON line the test asserts on.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeStaticProfile } from '../fixtures/aws/rotationProfile';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export { ROTATION_PROFILE, STATIC_KEY, writeStaticProfile } from '../fixtures/aws/rotationProfile';
export type { StaticKeyName } from '../fixtures/aws/rotationProfile';

export interface AwsProfileDir {
  dir: string;
  credentialsFile: string;
  configFile: string;
  /** Env for a child process: only this profile dir is visible, no ambient AWS creds, no IMDS. */
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

const AMBIENT_AWS_ENV = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
];

export function createAwsProfileDir(): AwsProfileDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-aws-rotation-'));
  const credentialsFile = path.join(dir, 'credentials');
  const configFile = path.join(dir, 'config');
  fs.writeFileSync(configFile, '');
  writeStaticProfile(credentialsFile, 'A');
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of AMBIENT_AWS_ENV) delete env[k];
  env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile;
  env.AWS_CONFIG_FILE = configFile;
  env.AWS_EC2_METADATA_DISABLED = 'true';
  env.AWS_REGION = 'us-east-1';
  return {
    dir,
    credentialsFile,
    configFile,
    env,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Run a TypeScript probe script (repo-relative) in a fresh Node process and
 * return the JSON object printed on its last stdout line.
 */
export function runTsxProbe<T = unknown>(scriptRelPath: string, env: NodeJS.ProcessEnv, timeoutMs = 90_000): T {
  const proc = spawnSync(
    process.execPath,
    [require.resolve('tsx/cli'), '--tsconfig', path.join(REPO_ROOT, 'tsconfig.json'), path.join(REPO_ROOT, scriptRelPath)],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: timeoutMs, env }
  );
  if (proc.status !== 0) {
    throw new Error(`probe ${scriptRelPath} exited ${proc.status}:\n${proc.stderr}\n${proc.stdout}`);
  }
  const lastLine = proc.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(lastLine) as T;
}
