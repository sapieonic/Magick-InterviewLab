import type { ErrorKind, TestStatus } from '@/features/execution/types';

/**
 * The vocabulary a candidate reads. `error` on its own is useless — "your
 * code has an error" is what they already know — so the error *kind* is
 * folded in here and nowhere else, which keeps the wording identical between
 * the results list, the run summary and the submit dialog.
 */
export function testStatusLabel(status: TestStatus, errorKind?: ErrorKind): string {
  switch (status) {
    case 'passed':
      return 'Passed';
    case 'failed':
      return 'Failed';
    case 'timeout':
      return 'Timeout';
    case 'error':
      switch (errorKind) {
        case 'syntax':
          return 'Syntax Error';
        case 'timeout':
          return 'Timeout';
        case 'internal':
          return 'Internal Error';
        default:
          return 'Runtime Error';
      }
  }
}

export type StatusTone = 'success' | 'destructive' | 'warning';

export function testStatusTone(status: TestStatus): StatusTone {
  if (status === 'passed') return 'success';
  if (status === 'timeout') return 'warning';
  return 'destructive';
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** mm:ss, and hh:mm:ss once an interview runs past the hour. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
