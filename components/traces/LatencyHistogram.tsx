/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LatencyHistogram - Visual histogram for trace latency distribution
 */

import React from 'react';

interface HistogramBucket {
  label: string;
  count: number;
  min: number;
  max: number;
}

interface LatencyHistogramProps {
  data: HistogramBucket[];
}

// Tailwind classes per latency bucket. Dark variants stay near-fully saturated
// (`dark:bg-{c}-400/80`) so bars remain visible against `bg-card`, instead of the
// previous 0.3-alpha overlay that disappeared into dark backgrounds. Driving this
// from the cascade also means the bars react to theme toggles without re-render.
const BAR_CLASSES = [
  'bg-emerald-300 border border-emerald-500 dark:bg-emerald-400/80 dark:border-emerald-300/70',
  'bg-lime-300 border border-lime-500 dark:bg-lime-400/80 dark:border-lime-300/70',
  'bg-yellow-300 border border-yellow-500 dark:bg-yellow-400/80 dark:border-yellow-300/70',
  'bg-amber-400 border border-amber-500 dark:bg-amber-400/80 dark:border-amber-300/70',
  'bg-orange-400 border border-orange-500 dark:bg-orange-400/80 dark:border-orange-300/70',
  'bg-red-400 border border-red-500 dark:bg-red-400/80 dark:border-red-300/70',
];
const FALLBACK_BAR_CLASSES = 'bg-gray-300 border border-gray-400 dark:bg-gray-400/70 dark:border-gray-300/60';

export const LatencyHistogram: React.FC<LatencyHistogramProps> = ({ data }) => {
  const maxCount = Math.max(...data.map(b => b.count), 1);

  return (
    <div className="flex items-end gap-2 h-24">
      {data.map((bucket, index) => {
        const heightPercent = maxCount > 0 ? (bucket.count / maxCount) * 100 : 0;
        const barClass = BAR_CLASSES[index] || FALLBACK_BAR_CLASSES;

        return (
          <div
            key={bucket.label}
            className="flex-1 flex flex-col items-center gap-1"
          >
            {/* Bar */}
            <div className="w-full flex flex-col items-center justify-end h-16">
              {bucket.count > 0 && (
                <span className="text-xs text-muted-foreground mb-1">
                  {bucket.count}
                </span>
              )}
              <div
                className={`w-full rounded-t transition-all ${barClass}`}
                style={{ height: `${Math.max(heightPercent, bucket.count > 0 ? 4 : 0)}%` }}
                title={`${bucket.label}: ${bucket.count} traces`}
              />
            </div>
            {/* Label */}
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {bucket.label}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default LatencyHistogram;
