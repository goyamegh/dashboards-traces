/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jest mock for `chai`.
 *
 * Production code imports chai@5 (ESM, module-scoped types — keeps the
 * compile clean and doesn't pollute the global namespace with a
 * `Chai` declaration). Jest can't load chai@5 directly because it ships
 * pure ESM and Jest's CJS loader chokes on the top-level `export`.
 *
 * For tests we route 'chai' through this shim, which loads the
 * `chai4` npm alias (chai@4, CJS) and re-exports the same surface. The
 * runtime API is identical for everything our tests touch
 * (`expect(...).to.X(...)` chains, `Assertion.addMethod(...)`,
 * `util.flag(...)`).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const chai = require('chai4');

module.exports = chai;
module.exports.default = chai;
module.exports.expect = chai.expect;
module.exports.Assertion = chai.Assertion;
module.exports.util = chai.util;
module.exports.use = chai.use;
