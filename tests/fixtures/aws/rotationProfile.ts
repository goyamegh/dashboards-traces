/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared by the Jest side and the child-process probes of the credential
 * rotation tests (see tests/helpers/awsCredentialRotation.ts). Pure fs — no
 * Node CJS globals, so it loads under both Jest (CJS) and tsx (ESM).
 */

import * as fs from 'fs';

/** Profile name used by every rotation probe; generic on purpose. */
export const ROTATION_PROFILE = 'rotation-test';

/** Synthetic static keys (no expiration — the credential shape that triggers the bug). */
export const STATIC_KEY = {
  A: { accessKeyId: 'AKIDROTATIONAAAAAAAA', secretAccessKey: 'rotation-secret-A', sessionToken: 'rotation-token-A' },
  B: { accessKeyId: 'AKIDROTATIONBBBBBBBB', secretAccessKey: 'rotation-secret-B', sessionToken: 'rotation-token-B' },
} as const;

export type StaticKeyName = keyof typeof STATIC_KEY;

/** Rewrite the credentials file with `[rotation-test]` holding the given key — what a credential helper does on rotation. */
export function writeStaticProfile(credentialsFile: string, key: StaticKeyName): void {
  const k = STATIC_KEY[key];
  fs.writeFileSync(
    credentialsFile,
    [
      `[${ROTATION_PROFILE}]`,
      `aws_access_key_id = ${k.accessKeyId}`,
      `aws_secret_access_key = ${k.secretAccessKey}`,
      `aws_session_token = ${k.sessionToken}`,
      '',
    ].join('\n')
  );
}
