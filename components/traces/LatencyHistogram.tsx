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

export const LatencyHistogram: React.FC<LatencyHistogramProps> = ({ data }) => {
  const maxCount = Math.max(...data.map(b => b.count), 1);

  // Color gradient from green to red based on latency
  const getBarColor = (index: number): string => {
    const colors = [
      'bg-green-500',    // <100ms
      'bg-green-400',    // 100-500ms
      'bg-yellow-400',   // 500ms-1s
      'bg-amber-400',    // 1-5s
      'bg-orange-500',   // 5-10s
      'bg-red-500',      // >10s
    ];
    return colors[index] || 'bg-gray-400';
  };

  return (
    <div className="flex items-end gap-2 h-24">
      {data.map((bucket, index) => {
        const heightPercent = maxCount > 0 ? (bucket.count / maxCount) * 100 : 0;

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
                className={`w-full ${getBarColor(index)} rounded-t transition-all`}
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
