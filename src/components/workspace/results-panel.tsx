'use client';

import * as React from 'react';
import { AlertTriangle, Check, ChevronRight, Loader2, Terminal, X } from 'lucide-react';
import type { TestResult } from '@/features/execution/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDuration, testStatusLabel, testStatusTone } from './test-status';
import { passedCount, type RunState } from './run-state';

/**
 * The results surface. Everything a candidate needs to debug is here, but
 * only failing rows start expanded — a wall of passing input/output blocks
 * buries the one line that matters.
 */

export interface ResultsPanelProps {
  state: RunState;
  onCancel: () => void;
  /** Non-null when the browser cannot run code at all. */
  blockedReason: string | null;
}

function StatusPill({ test }: { test: TestResult }) {
  const tone = testStatusTone(test.status);
  return (
    <Badge variant={tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : 'destructive'}>
      {testStatusLabel(test.status, test.errorKind)}
    </Badge>
  );
}

function OutputBlock({ label, value, tone }: { label: string; value: string; tone?: 'error' }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <pre
        className={cn(
          'bg-surface-code max-h-40 overflow-auto rounded border px-2.5 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap',
          tone === 'error' && 'border-destructive/30 text-destructive',
        )}
      >
        {value === '' ? <span className="text-muted-foreground italic">(empty)</span> : value}
      </pre>
    </div>
  );
}

function TestRow({ test, index }: { test: TestResult; index: number }) {
  // Failures open by default: that is the row the candidate came here for.
  const [open, setOpen] = React.useState(test.status !== 'passed');
  const passed = test.status === 'passed';
  const detailsId = `test-detail-${test.testCaseId}`;

  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={detailsId}
        className="hover:bg-muted/40 flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors"
      >
        <ChevronRight
          className={cn(
            'text-muted-foreground size-3.5 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
        {passed ? (
          <Check className="text-success size-4 shrink-0" aria-hidden />
        ) : (
          <X className="text-destructive size-4 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="text-[13px] font-medium">Test {index + 1}</span>
          {test.description ? (
            <span className="text-muted-foreground ml-2 truncate text-[13px]">
              {test.description}
            </span>
          ) : null}
        </span>
        <span className="text-muted-foreground tnum hidden text-[11px] sm:inline">
          {formatDuration(test.durationMs)}
        </span>
        <StatusPill test={test} />
      </button>

      {open ? (
        <div id={detailsId} className="grid gap-3 px-3 pt-1 pb-3 sm:grid-cols-3">
          <OutputBlock label="Input" value={test.input} />
          <OutputBlock label="Expected" value={test.expectedOutput} />
          <OutputBlock
            label="Actual"
            value={test.actualOutput}
            tone={passed ? undefined : 'error'}
          />
          {test.errorMessage ? (
            <div className="sm:col-span-3">
              <OutputBlock label="Error" value={test.errorMessage} tone="error" />
            </div>
          ) : null}
          {test.stderr && test.stderr !== test.errorMessage ? (
            <div className="sm:col-span-3">
              <OutputBlock label="stderr" value={test.stderr} tone="error" />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function RunSummary({ state }: { state: RunState }) {
  const result = state.result;
  if (!result) return null;
  const passed = passedCount(result.tests);
  const total = result.tests.length;
  const allPassed = total > 0 && passed === total;

  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className={cn('font-medium', allPassed ? 'text-success' : 'text-foreground')}>
        {passed} of {total} {total === 1 ? 'test' : 'tests'} passed
      </span>
      {typeof result.executionTimeMs === 'number' ? (
        <span className="text-muted-foreground tnum">
          · {formatDuration(result.executionTimeMs)}
        </span>
      ) : null}
    </div>
  );
}

export function ResultsPanel({ state, onCancel, blockedReason }: ResultsPanelProps) {
  const { phase, result, progress } = state;

  const liveMessage =
    phase === 'running'
      ? progress.total > 0
        ? `Running test ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}…`
        : 'Starting the runtime…'
      : phase === 'complete' && result
        ? `Run finished. ${passedCount(result.tests)} of ${result.tests.length} tests passed.`
        : phase === 'cancelled'
          ? 'Run cancelled.'
          : phase === 'error'
            ? `Run failed. ${state.message ?? ''}`
            : '';

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Test results">
      <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          <h2 className="text-[13px] font-semibold tracking-tight">Test results</h2>
        </div>
        {phase === 'running' ? (
          <Button variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </header>

      {/* One live region for the whole run: assistive tech gets progress and
          the verdict without the per-row detail being announced twice. */}
      <p aria-live="polite" className="sr-only">
        {liveMessage}
      </p>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {blockedReason ? (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <AlertTriangle className="text-warning mt-px size-4 shrink-0" aria-hidden />
            <p className="text-[13px]">{blockedReason}</p>
          </div>
        ) : phase === 'running' ? (
          <div className="flex items-center gap-2.5 px-3 py-4">
            <Loader2 className="text-muted-foreground size-4 animate-spin" aria-hidden />
            <p className="text-[13px]">
              {progress.total > 0
                ? `Running test ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}…`
                : 'Starting the runtime…'}
            </p>
          </div>
        ) : phase === 'idle' ? (
          <p className="text-muted-foreground px-3 py-4 text-[13px]">
            No run yet. Press{' '}
            <kbd className="bg-muted rounded border px-1 py-0.5 font-mono text-[11px]">
              Ctrl/Cmd + Enter
            </kbd>{' '}
            or use Run tests.
          </p>
        ) : phase === 'cancelled' ? (
          <p className="text-muted-foreground px-3 py-4 text-[13px]">
            Run cancelled. Nothing was recorded.
          </p>
        ) : phase === 'error' ? (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <AlertTriangle className="text-destructive mt-px size-4 shrink-0" aria-hidden />
            <div className="min-w-0 space-y-1">
              <p className="text-destructive text-[13px] font-medium">The run could not finish</p>
              <p className="text-muted-foreground text-[13px]">
                {state.message ?? 'An unexpected error stopped the run.'}
              </p>
            </div>
          </div>
        ) : result ? (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
              <RunSummary state={state} />
            </div>

            {result.fatalError ? (
              <div className="border-destructive/25 bg-destructive/5 flex items-start gap-2.5 border-b px-3 py-2.5">
                <AlertTriangle className="text-destructive mt-px size-4 shrink-0" aria-hidden />
                <div className="min-w-0 space-y-1">
                  <p className="text-destructive text-[13px] font-medium">
                    {result.status === 'timeout' ? 'Execution timed out' : 'Execution failed'}
                  </p>
                  <pre className="text-destructive/90 overflow-x-auto font-mono text-[12px] whitespace-pre-wrap">
                    {result.fatalError}
                  </pre>
                </div>
              </div>
            ) : null}

            {result.tests.length === 0 ? (
              <p className="text-muted-foreground px-3 py-4 text-[13px]">
                This question has no test cases yet, so there is nothing to check against.
              </p>
            ) : (
              <ul>
                {result.tests.map((test, index) => (
                  <TestRow key={test.testCaseId} test={test} index={index} />
                ))}
              </ul>
            )}

            {result.stdout || result.stderr ? (
              <div className="grid gap-3 px-3 py-3 sm:grid-cols-2">
                {result.stdout ? <OutputBlock label="stdout" value={result.stdout} /> : null}
                {result.stderr ? (
                  <OutputBlock label="stderr" value={result.stderr} tone="error" />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
