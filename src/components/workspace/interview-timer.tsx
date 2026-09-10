'use client';

import * as React from 'react';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatClock } from './test-status';

/**
 * A countdown over `assignment.startedAt`, which the server stamped once.
 *
 * This is a *display*, not an enforcement mechanism. Nothing here stops a
 * submission after the clock hits zero — the browser clock is the
 * candidate's to set, and the run happens in their tab anyway. Enforcement
 * would have to live in `createSubmissionAction` against `startedAt` plus a
 * grace window, and that is a deliberate non-goal for the MVP because a
 * candidate whose laptop slept mid-question should not lose their work to a
 * hard cutoff. Treat an expired timer as a signal to the reviewer, who can
 * see `submittedAt` on the submission.
 */

export interface Countdown {
  remainingMs: number;
  expired: boolean;
  totalMs: number;
}

export function useCountdown(startedAt: number | null, durationMinutes: number | null): Countdown | null {
  const [now, setNow] = React.useState<number | null>(null);

  // Starts null so the server render and the first client render agree; the
  // real clock arrives one tick later.
  React.useEffect(() => {
    if (startedAt === null || durationMinutes === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt, durationMinutes]);

  if (startedAt === null || durationMinutes === null || now === null) return null;
  const totalMs = durationMinutes * 60_000;
  const remainingMs = startedAt + totalMs - now;
  return { remainingMs, expired: remainingMs <= 0, totalMs };
}

export function TimerChip({ countdown }: { countdown: Countdown | null }) {
  if (!countdown) {
    return null;
  }
  const { remainingMs, expired } = countdown;
  const lowOnTime = !expired && remainingMs <= 5 * 60_000;

  return (
    <span
      className={cn(
        'tnum inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[13px] font-medium',
        expired && 'border-destructive/30 bg-destructive/10 text-destructive',
        lowOnTime && 'border-warning/30 bg-warning/10 text-warning',
        !expired && !lowOnTime && 'text-muted-foreground',
      )}
      title={expired ? 'Time is up' : 'Time remaining'}
      aria-live="off"
    >
      <Clock className="size-3.5" aria-hidden />
      <span className="sr-only">{expired ? 'Time is up. ' : 'Time remaining '}</span>
      {expired ? 'Time up' : formatClock(remainingMs)}
    </span>
  );
}
