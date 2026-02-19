/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ESM-compatible require function.
 *
 * The server is bundled as ESM (esbuild --format=esm) where bare require() is unavailable.
 * This module uses createRequire(import.meta.url) to provide a working require function.
 *
 * Note: This file cannot be imported in Jest (CJS) because import.meta is unsupported.
 * PdfFormatter conditionally imports this only at runtime in ESM environments.
 */

import { createRequire } from 'module';

export const esmRequire = createRequire(import.meta.url);
