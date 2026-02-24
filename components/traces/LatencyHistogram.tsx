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

  // Aggro-style-edit: Softer color gradient using border-like colors (theme-aware)
  const getBarStyle = (index: number): React.CSSProperties => {
    const isDarkMode = document.documentElement.classList.contains('dark');
    
    // Softer colors that work in both light and dark modes
    const lightColors = [
      { backgroundColor: 'rgb(134, 239, 172)', border: '1px solid rgb(74, 222, 128)' },    // <100ms - soft green
      { backgroundColor: 'rgb(163, 230, 53)', border: '1px solid rgb(132, 204, 22)' },     // 100-500ms - lime
      { backgroundColor: 'rgb(253, 224, 71)', border: '1px solid rgb(234, 179, 8)' },      // 500ms-1s - yellow
      { backgroundColor: 'rgb(251, 191, 36)', border: '1px solid rgb(245, 158, 11)' },     // 1-5s - amber
      { backgroundColor: 'rgb(251, 146, 60)', border: '1px solid rgb(249, 115, 22)' },     // 5-10s - orange
      { backgroundColor: 'rgb(248, 113, 113)', border: '1px solid rgb(239, 68, 68)' },     // >10s - red
    ];
    
    const darkColors = [
      { backgroundColor: 'rgba(134, 239, 172, 0.3)', border: '1px solid rgba(134, 239, 172, 0.5)' },  // <100ms
      { backgroundColor: 'rgba(163, 230, 53, 0.3)', border: '1px solid rgba(163, 230, 53, 0.5)' },    // 100-500ms
      { backgroundColor: 'rgba(253, 224, 71, 0.3)', border: '1px solid rgba(253, 224, 71, 0.5)' },    // 500ms-1s
      { backgroundColor: 'rgba(251, 191, 36, 0.3)', border: '1px solid rgba(251, 191, 36, 0.5)' },    // 1-5s
      { backgroundColor: 'rgba(251, 146, 60, 0.3)', border: '1px solid rgba(251, 146, 60, 0.5)' },    // 5-10s
      { backgroundColor: 'rgba(248, 113, 113, 0.3)', border: '1px solid rgba(248, 113, 113, 0.5)' },  // >10s
    ];
    
    const colors = isDarkMode ? darkColors : lightColors;
    return colors[index] || (isDarkMode 
      ? { backgroundColor: 'rgba(156, 163, 175, 0.3)', border: '1px solid rgba(156, 163, 175, 0.5)' }
      : { backgroundColor: 'rgb(209, 213, 219)', border: '1px solid rgb(156, 163, 175)' }
    );
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
                className="w-full rounded-t transition-all"
                style={{
                  height: `${Math.max(heightPercent, bucket.count > 0 ? 4 : 0)}%`,
                  ...getBarStyle(index)
                }}
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
