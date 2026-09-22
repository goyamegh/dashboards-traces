/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useResizableColumn — drag-to-resize width for the span label column shared
 * by the trace tree table and the timeline chart. Pointer-only; the width is
 * clamped to [min, max] and reset to the default on double-click of the handle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Span } from '@/types';

export interface NameColumnEstimate {
  /** Horizontal indent per tree depth. */
  indentPx: number;
  /** Fixed per-row chrome next to the name (caret / icon / time cell / padding). */
  fixedPx: number;
  /** Average glyph width at the row's font size. */
  charPx: number;
  min: number;
  max: number;
}

/**
 * Initial name-column width sized from the longest span name at its depth so
 * typical `execute_tool <name>` rows are not ellipsized out of the box, while
 * the cap keeps the timeline bars visible at laptop widths. Dragging the
 * handle overrides it.
 */
export function estimateNameColumnWidth(spanTree: Span[], opts: NameColumnEstimate): number {
  let widest = 0;
  const walk = (spans: Span[], depth: number) => {
    for (const s of spans) {
      widest = Math.max(widest, depth * opts.indentPx + (s.name?.length || 0) * opts.charPx);
      if (s.children?.length) walk(s.children, depth + 1);
    }
  };
  walk(spanTree, 0);
  return Math.round(Math.max(opts.min, Math.min(opts.max, widest + opts.fixedPx)));
}

export interface ResizableColumn {
  width: number;
  isResizing: boolean;
  /** Spread onto the drag handle element. */
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
    onDoubleClick: () => void;
    role: 'separator';
    'aria-orientation': 'vertical';
    'aria-label': string;
    title: string;
  };
}

export function useResizableColumn(defaultWidth: number, min: number, max: number, label = 'Resize name column'): ResizableColumn {
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const userResized = useRef(false);

  // A new default (e.g. a different trace with longer names) applies until
  // the user has dragged the handle; their choice then sticks.
  useEffect(() => {
    if (!userResized.current) setWidth(defaultWidth);
  }, [defaultWidth]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // the timeline chart pans on mousedown — don't start a pan
    drag.current = { startX: e.clientX, startWidth: width };
    userResized.current = true;
    setIsResizing(true);
  }, [width]);

  const onDoubleClick = useCallback(() => {
    userResized.current = false;
    setWidth(defaultWidth);
  }, [defaultWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      const next = drag.current.startWidth + (e.clientX - drag.current.startX);
      setWidth(Math.max(min, Math.min(max, next)));
    };
    const up = () => {
      drag.current = null;
      setIsResizing(false);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, min, max]);

  return {
    width,
    isResizing,
    handleProps: {
      onMouseDown,
      onDoubleClick,
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': label,
      title: 'Drag to resize · double-click to reset',
    },
  };
}
