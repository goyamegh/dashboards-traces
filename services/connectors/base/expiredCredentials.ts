/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Classifier for "AWS rejected the signature because the credentials behind
 * it are expired, rotated out or unknown" (#569). Decided from the HTTP
 * RESPONSE itself — its own status plus the AWS error signal in the
 * `x-amzn-errortype` header or the body — never from an error message, so a
 * nested `"upstreamStatus": 403` inside some other failure cannot pass.
 */

/** Error codes / messages AWS-fronted endpoints return for stale or unknown credentials. */
const AWS_CREDENTIAL_SIGNAL =
  /ExpiredToken(Exception)?\b|InvalidClientTokenId|UnrecognizedClientException|security token included in the request is (expired|invalid)/i;

/** The subset of `Response` the classifier reads (lets tests pass plain objects). */
export interface RejectionProbe {
  status: number;
  headers: { get(name: string): string | null | undefined };
  clone?: () => { text(): Promise<string> };
}

/**
 * True when `response` is a 401/403 that carries an AWS credential signal.
 * The body is read from a clone so the caller can still consume it. An AWS
 * front door (API Gateway, Lambda URL, ALB+IAM, Bedrock) rejects such a request
 * before the agent runs, so replaying it is safe.
 */
export async function isAwsCredentialRejection(response: RejectionProbe): Promise<boolean> {
  if (response.status !== 401 && response.status !== 403) return false;
  if (AWS_CREDENTIAL_SIGNAL.test(response.headers.get('x-amzn-errortype') ?? '')) return true;
  if (typeof response.clone !== 'function') return false;
  try {
    return AWS_CREDENTIAL_SIGNAL.test(await response.clone().text());
  } catch {
    return false;
  }
}
