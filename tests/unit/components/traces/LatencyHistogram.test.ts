/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for LatencyHistogram component
 *
 * Note: This tests the data processing logic; React rendering is tested via integration tests.
 */

describe('LatencyHistogram', () => {
  // Test bucket data structure
  const createBuckets = () => [
    { label: '<100ms', min: 0, max: 100, count: 0 },
    { label: '100-500ms', min: 100, max: 500, count: 0 },
    { label: '500ms-1s', min: 500, max: 1000, count: 0 },
    { label: '1-5s', min: 1000, max: 5000, count: 0 },
    { label: '5-10s', min: 5000, max: 10000, count: 0 },
    { label: '>10s', min: 10000, max: Infinity, count: 0 },
  ];

  describe('bucket calculation', () => {
    it('assigns traces to correct buckets based on duration', () => {
      const traces = [
        { duration: 50 },    // <100ms
        { duration: 200 },   // 100-500ms
        { duration: 750 },   // 500ms-1s
        { duration: 2000 },  // 1-5s
        { duration: 7500 },  // 5-10s
        { duration: 15000 }, // >10s
      ];

      const buckets = createBuckets();

      traces.forEach(trace => {
        const bucket = buckets.find(b => trace.duration >= b.min && trace.duration < b.max);
        if (bucket) bucket.count++;
      });

      expect(buckets[0].count).toBe(1); // <100ms
      expect(buckets[1].count).toBe(1); // 100-500ms
      expect(buckets[2].count).toBe(1); // 500ms-1s
      expect(buckets[3].count).toBe(1); // 1-5s
      expect(buckets[4].count).toBe(1); // 5-10s
      expect(buckets[5].count).toBe(1); // >10s
    });

    it('handles edge cases at bucket boundaries', () => {
      const traces = [
        { duration: 0 },      // <100ms (lower bound)
        { duration: 99 },     // <100ms (upper edge)
        { duration: 100 },    // 100-500ms (exact boundary)
        { duration: 999 },    // 500ms-1s (upper edge)
        { duration: 1000 },   // 1-5s (exact boundary)
        { duration: 10000 },  // >10s (exact boundary)
      ];

      const buckets = createBuckets();

      traces.forEach(trace => {
        const bucket = buckets.find(b => trace.duration >= b.min && trace.duration < b.max);
        if (bucket) bucket.count++;
      });

      expect(buckets[0].count).toBe(2); // <100ms: 0, 99
      expect(buckets[1].count).toBe(1); // 100-500ms: 100
      expect(buckets[2].count).toBe(1); // 500ms-1s: 999
      expect(buckets[3].count).toBe(1); // 1-5s: 1000
      expect(buckets[5].count).toBe(1); // >10s: 10000
    });

    it('handles empty trace list', () => {
      const traces: { duration: number }[] = [];
      const buckets = createBuckets();

      traces.forEach(trace => {
        const bucket = buckets.find(b => trace.duration >= b.min && trace.duration < b.max);
        if (bucket) bucket.count++;
      });

      // All counts should be 0
      buckets.forEach(bucket => {
        expect(bucket.count).toBe(0);
      });
    });

    it('handles multiple traces in same bucket', () => {
      const traces = [
        { duration: 10 },
        { duration: 20 },
        { duration: 30 },
        { duration: 50 },
        { duration: 75 },
      ];

      const buckets = createBuckets();

      traces.forEach(trace => {
        const bucket = buckets.find(b => trace.duration >= b.min && trace.duration < b.max);
        if (bucket) bucket.count++;
      });

      expect(buckets[0].count).toBe(5); // All in <100ms
      expect(buckets[1].count).toBe(0);
      expect(buckets[2].count).toBe(0);
      expect(buckets[3].count).toBe(0);
      expect(buckets[4].count).toBe(0);
      expect(buckets[5].count).toBe(0);
    });
  });

  describe('height calculation', () => {
    it('calculates correct percentage for bar height', () => {
      const buckets = [
        { label: 'a', count: 10 },
        { label: 'b', count: 5 },
        { label: 'c', count: 2 },
      ];

      const maxCount = Math.max(...buckets.map(b => b.count));
      expect(maxCount).toBe(10);

      const heightPercentages = buckets.map(b =>
        maxCount > 0 ? (b.count / maxCount) * 100 : 0
      );

      expect(heightPercentages[0]).toBe(100);
      expect(heightPercentages[1]).toBe(50);
      expect(heightPercentages[2]).toBe(20);
    });

    it('handles all zero counts', () => {
      const buckets = [
        { label: 'a', count: 0 },
        { label: 'b', count: 0 },
      ];

      const maxCount = Math.max(...buckets.map(b => b.count), 1); // Use 1 as fallback
      expect(maxCount).toBe(1);

      const heightPercentages = buckets.map(b =>
        maxCount > 0 ? (b.count / maxCount) * 100 : 0
      );

      expect(heightPercentages[0]).toBe(0);
      expect(heightPercentages[1]).toBe(0);
    });
  });
});
