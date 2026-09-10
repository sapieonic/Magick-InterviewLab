'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A two-pane splitter built on pointer events — no dependency, and no
 * `mousemove` on window either: pointer capture keeps the drag attached to
 * the handle even when the cursor outruns it or leaves the window, which is
 * the bug every hand-rolled splitter ships with.
 *
 * The size is stored as a fraction of the container, so it survives a window
 * resize; the pixel minimums stop either pane from collapsing to nothing.
 */

export interface SplitPaneProps {
  orientation?: 'vertical' | 'horizontal';
  first: React.ReactNode;
  second: React.ReactNode;
  defaultFraction?: number;
  minFraction?: number;
  maxFraction?: number;
  /** Persisted per candidate browser; omit to keep the split ephemeral. */
  storageKey?: string;
  label: string;
  className?: string;
}

const STEP = 0.02;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function SplitPane({
  orientation = 'vertical',
  first,
  second,
  defaultFraction = 0.5,
  minFraction = 0.15,
  maxFraction = 0.85,
  storageKey,
  label,
  className,
}: SplitPaneProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [fraction, setFraction] = React.useState(defaultFraction);
  const [dragging, setDragging] = React.useState(false);
  const isVertical = orientation === 'vertical';

  // Read after mount, never during render: localStorage does not exist on the
  // server and a differing first paint is a hydration error.
  React.useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = window.localStorage.getItem(storageKey);
      const parsed = stored === null ? Number.NaN : Number.parseFloat(stored);
      if (Number.isFinite(parsed)) setFraction(clamp(parsed, minFraction, maxFraction));
    } catch {
      // Private mode / disabled storage: the default split is fine.
    }
  }, [storageKey, minFraction, maxFraction]);

  const persist = React.useCallback(
    (next: number) => {
      if (!storageKey) return;
      try {
        window.localStorage.setItem(storageKey, next.toFixed(4));
      } catch {
        // Not worth surfacing — the layout still works.
      }
    },
    [storageKey],
  );

  const updateFromPointer = React.useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const raw = isVertical
        ? (clientY - rect.top) / Math.max(rect.height, 1)
        : (clientX - rect.left) / Math.max(rect.width, 1);
      setFraction(clamp(raw, minFraction, maxFraction));
    },
    [isVertical, minFraction, maxFraction],
  );

  const nudge = (delta: number) => {
    setFraction((current) => {
      const next = clamp(current + delta, minFraction, maxFraction);
      persist(next);
      return next;
    });
  };

  return (
    <div
      ref={containerRef}
      className={cn('flex min-h-0 min-w-0', isVertical ? 'flex-col' : 'flex-row', className)}
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={isVertical ? { height: `${fraction * 100}%` } : { width: `${fraction * 100}%` }}
      >
        {first}
      </div>

      <div
        role="separator"
        tabIndex={0}
        aria-label={label}
        aria-orientation={isVertical ? 'horizontal' : 'vertical'}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={Math.round(minFraction * 100)}
        aria-valuemax={Math.round(maxFraction * 100)}
        className={cn(
          'bg-border hover:bg-primary/40 focus-visible:bg-primary/60 relative shrink-0 touch-none transition-colors',
          isVertical ? 'h-px w-full cursor-row-resize' : 'h-full w-px cursor-col-resize',
          dragging && 'bg-primary/60',
        )}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          updateFromPointer(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          setDragging(false);
          persist(fraction);
        }}
        onKeyDown={(event) => {
          const decrease = isVertical ? 'ArrowUp' : 'ArrowLeft';
          const increase = isVertical ? 'ArrowDown' : 'ArrowRight';
          if (event.key === decrease) {
            event.preventDefault();
            nudge(-STEP);
          } else if (event.key === increase) {
            event.preventDefault();
            nudge(STEP);
          }
        }}
      >
        {/* The visible divider is a hairline; this widens the grab target to
            something a hand can actually hit without thickening the seam. */}
        <span
          aria-hidden
          className={cn(
            'absolute',
            isVertical ? '-top-1.5 -bottom-1.5 left-0 w-full' : '-left-1.5 -right-1.5 top-0 h-full',
          )}
        />
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{second}</div>
    </div>
  );
}
