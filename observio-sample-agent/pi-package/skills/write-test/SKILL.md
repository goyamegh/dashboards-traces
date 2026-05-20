---
name: write-test
description: >
  Write tests for Agent Health following project conventions. Use when adding tests
  for new features, bug fixes, or improving coverage. Covers Jest setup, mocking
  patterns, path aliases, and coverage thresholds.
---

# Write Tests for Agent Health

You are helping the user write tests following Agent Health's conventions.

## Test Structure

- Tests live in `tests/` mirroring the source directory structure
- Jest config: `jest.config.cjs`
- **Always use `@/` path alias** — never relative imports

```typescript
// ✅ Correct
import { myFunction } from '@/services/myService';

// ❌ Wrong
import { myFunction } from '../../services/myService';
```

## Test File Template

```typescript
/* Copyright OpenSearch Contributors
 SPDX-License-Identifier: Apache-2.0 */

import { functionUnderTest } from '@/path/to/module';

describe('functionUnderTest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle the happy path', () => {
    const result = functionUnderTest(validInput);
    expect(result).toEqual(expectedOutput);
  });

  it('should handle edge case', () => {
    // ...
  });
});
```

## Mocking Patterns

### Mock External Services (OpenSearch, Bedrock)

```typescript
jest.mock('@/server/adapters/opensearch/StorageModule', () => ({
  getStorageModule: () => ({
    testCases: {
      create: jest.fn().mockResolvedValue({ id: 'test-1', name: 'Test' }),
      get: jest.fn().mockResolvedValue(null),
    },
  }),
}));
```

### Mock Fetch/HTTP

```typescript
const mockFetch = jest.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: 'result' }),
});
global.fetch = mockFetch;
```

### Don't Mock Internal Modules

Test through the public API. Only mock at system boundaries.

## Integration Tests

If the test creates data in OpenSearch or starts a server:

```typescript
afterEach(async () => {
  // Clean up created resources
  await storage.delete(createdId);
});

afterAll(async () => {
  // Close connections
  await server.close();
});
```

## Coverage Thresholds

| Metric | Minimum |
|--------|---------|
| Lines | 90% |
| Statements | 90% |
| Functions | 80% |
| Branches | 80% |

Run coverage: `npm test -- --coverage`

## Running Tests

```bash
npm test                           # All tests
npm run test:unit                  # Unit only
npm run test:integration           # Integration only
npm test -- path/to/file.test.ts   # Single file
npm test -- --watch                # Watch mode
```
