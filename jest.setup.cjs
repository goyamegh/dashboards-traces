/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jest setup file — polyfills for jsdom test environment.
 *
 * jsdom does not provide TextEncoder/TextDecoder, but libraries like
 * react-router-dom v7 require them. Node.js has them globally, so we
 * only need to polyfill when they're missing (i.e., in jsdom).
 */

const { TextEncoder, TextDecoder } = require('util');

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = TextDecoder;
}
