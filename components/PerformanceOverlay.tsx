/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Performance Overlay - Visual performance metrics display
 *
 * Displays real-time performance metrics in a draggable overlay.
 * Enable by setting localStorage.DEBUG_PERFORMANCE = 'true' in browser console.
 */

import React, { useState, useEffect } from 'react';
import { X, Minimize2, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getMetrics, getAverageDuration, clearMetrics } from '@/lib/performance';

export const PerformanceOverlay: React.FC = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [metrics, setMetrics] = useState<ReturnType<typeof getMetrics>>([]);

  // Check if performance monitoring is enabled
  useEffect(() => {
    const checkEnabled = () => {
      const enabled = localStorage.getItem('DEBUG_PERFORMANCE') === 'true';
      setIsVisible(enabled);
    };

    checkEnabled();

    // Poll for changes
    const interval = setInterval(checkEnabled, 1000);
    return () => clearInterval(interval);
  }, []);

  // Update metrics every 500ms
  useEffect(() => {
    if (!isVisible) return;

    const updateMetrics = () => {
      setMetrics(getMetrics());
    };

    updateMetrics();
    const interval = setInterval(updateMetrics, 500);
    return () => clearInterval(interval);
  }, [isVisible]);

  if (!isVisible) return null;

  // Group metrics by name and calculate stats
  const grouped = new Map<string, { avg: number; min: number; max: number; count: number }>();
  const metricsByName = new Map<string, number[]>();

  metrics.forEach(m => {
    if (!metricsByName.has(m.name)) {
      metricsByName.set(m.name, []);
    }
    metricsByName.get(m.name)!.push(m.duration);
  });

  metricsByName.forEach((durations, name) => {
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    grouped.set(name, { avg, min, max, count: durations.length });
  });

  const getColor = (duration: number) => {
    if (duration < 50) return 'text-green-400';
    if (duration < 200) return 'text-yellow-400';
    return 'text-red-400';
  };

  const getIcon = (duration: number) => {
    if (duration < 50) return '🟢';
    if (duration < 200) return '🟡';
    return '🔴';
  };

  return (
    <Card
      className="fixed bottom-4 right-4 z-50 w-96 shadow-2xl border-2 border-slate-700 bg-slate-900/95 backdrop-blur"
      style={{ maxHeight: '80vh', overflow: 'auto' }}
    >
      <CardHeader className="py-2 px-3 flex flex-row items-center justify-between border-b border-slate-700">
        <CardTitle className="text-sm font-mono">⚡ Performance Monitor</CardTitle>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsMinimized(!isMinimized)}
            className="h-6 w-6 p-0"
          >
            {isMinimized ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              localStorage.removeItem('DEBUG_PERFORMANCE');
              setIsVisible(false);
            }}
            className="h-6 w-6 p-0"
          >
            <X size={12} />
          </Button>
        </div>
      </CardHeader>

      {!isMinimized && (
        <CardContent className="p-3 space-y-2">
          {grouped.size === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No metrics recorded yet.
              <br />
              Navigate to the Traces page to see metrics.
            </p>
          ) : (
            <>
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs text-muted-foreground">
                  {metrics.length} total measurements
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearMetrics}
                  className="h-6 text-xs"
                >
                  Clear
                </Button>
              </div>

              <div className="space-y-1 max-h-96 overflow-auto">
                {Array.from(grouped.entries())
                  .sort((a, b) => b[1].avg - a[1].avg) // Sort by average duration
                  .map(([name, stats]) => (
                    <div
                      key={name}
                      className="p-2 rounded bg-slate-800/50 border border-slate-700"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-mono truncate" title={name}>
                            {getIcon(stats.avg)} {name.split('.').pop()}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {name.split('.').slice(0, -1).join('.')}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className={`text-sm font-bold font-mono ${getColor(stats.avg)}`}>
                            {stats.avg.toFixed(1)}ms
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {stats.min.toFixed(0)}-{stats.max.toFixed(0)}ms
                          </div>
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {stats.count} calls
                      </div>
                    </div>
                  ))}
              </div>

              <div className="mt-3 pt-3 border-t border-slate-700 text-xs text-muted-foreground">
                💡 Tip: Measurements {'<'} 50ms are fast (🟢), {'<'} 200ms are ok (🟡), &gt; 200ms
                are slow (🔴)
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
};

export default PerformanceOverlay;
