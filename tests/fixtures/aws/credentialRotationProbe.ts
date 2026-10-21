/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Child-process probe (run via tsx by tests/unit/lib/aws/refreshingCredentialProvider.realSdk.test.ts).
 *
 * Against the REAL AWS SDK and a temp credentials file from
 * `$AWS_SHARED_CREDENTIALS_FILE`, resolves credentials through four paths,
 * rotates the profile from key A to key B, advances the clock by the TTL and
 * resolves again:
 *   stockChain          — `fromNodeProviderChain({ profile, ignoreCache })` memoised (the shape awsSigV4.ts used)
 *   defaultChainClient  — `new BedrockRuntimeClient({ region })` on the default chain (bedrockService.ts shape)
 *   refreshingProvider  — createRefreshingCredentialProvider({ profile })
 *   refreshingClient    — `new BedrockRuntimeClient({ region, credentials: refreshing })`, read via client.config.credentials()
 * Prints one JSON line: { <path>: { before, inTtl, afterTtl } } of access key ids,
 * plus `newClientsAfterRotation`: clients CREATED after the rotation —
 *   defaultChain  — `new BedrockRuntimeClient({ region })`: still key A, because
 *                   @smithy/shared-ini-file-loader caches the ini file contents
 *                   process-wide (only `ignoreCache: true` bypasses it);
 *   refreshing    — `new BedrockRuntimeClient({ region, credentials: refreshing })`: key B.
 */

import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { ROTATION_PROFILE, writeStaticProfile } from './rotationProfile';
import {
  DEFAULT_CREDENTIAL_TTL_MS,
  createRefreshingCredentialProvider,
} from '@/lib/aws/refreshingCredentialProvider';

const credentialsFile = process.env.AWS_SHARED_CREDENTIALS_FILE!;

// Deterministic clock for everything that reads Date.now (our provider and the
// SDK's own memoisation); installed before any provider is created.
const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;

async function main(): Promise<void> {
  process.env.AWS_PROFILE = ROTATION_PROFILE;
  const stockChain = fromNodeProviderChain({ profile: ROTATION_PROFILE, ignoreCache: true });
  const defaultChainClient = new BedrockRuntimeClient({ region: 'us-east-1' });
  const refreshingProvider = createRefreshingCredentialProvider({ profile: ROTATION_PROFILE });
  const refreshingClient = new BedrockRuntimeClient({
    region: 'us-east-1',
    credentials: createRefreshingCredentialProvider({ profile: ROTATION_PROFILE }),
  });

  const paths = {
    stockChain: () => stockChain(),
    defaultChainClient: () => defaultChainClient.config.credentials(),
    refreshingProvider: () => refreshingProvider(),
    refreshingClient: () => refreshingClient.config.credentials(),
  };
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(Object.entries(paths).map(async ([name, get]) => [name, (await get()).accessKeyId]))
    );

  const before = await snapshot();
  writeStaticProfile(credentialsFile, 'B');
  offsetMs = DEFAULT_CREDENTIAL_TTL_MS / 2; // real ms also tick between snapshots
  const inTtl = await snapshot(); // no refresh happens here: nothing re-reads the file

  // A client CREATED after the rotation (the "per-call client" shape), read
  // BEFORE anything with `ignoreCache: true` has touched the file again: the
  // default chain serves the process-wide cached contents → still key A.
  // (`ignoreCache` re-reads AND overwrites that cache, so the order matters.)
  const newDefaultChainClient = new BedrockRuntimeClient({ region: 'us-east-1' });
  const newDefaultChainAfterRotation = (await newDefaultChainClient.config.credentials()).accessKeyId;

  offsetMs = DEFAULT_CREDENTIAL_TTL_MS;
  const afterTtl = await snapshot();

  const newRefreshingClient = new BedrockRuntimeClient({
    region: 'us-east-1',
    credentials: createRefreshingCredentialProvider({ profile: ROTATION_PROFILE }),
  });
  const newClientsAfterRotation = {
    defaultChain: newDefaultChainAfterRotation,
    refreshing: (await newRefreshingClient.config.credentials()).accessKeyId,
  };

  const out: Record<string, unknown> = { newClientsAfterRotation };
  for (const name of Object.keys(paths)) out[name] = { before: before[name], inTtl: inTtl[name], afterTtl: afterTtl[name] };
  for (const c of [defaultChainClient, refreshingClient, newDefaultChainClient, newRefreshingClient]) c.destroy();
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
