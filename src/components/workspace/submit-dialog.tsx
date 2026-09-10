'use client';

import type { ExecutionResult, Language } from '@/features/execution/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { LANGUAGE_LABEL } from '@/features/submissions/language';
import { passedCount } from './run-state';

/**
 * Submitting is the one irreversible thing on this screen when the interview
 * is single-submission, so it gets a confirmation that states exactly what is
 * about to be recorded — including the fact that the tests will be re-run if
 * the code changed since the last run.
 */
export function SubmitDialog({
  open,
  onOpenChange,
  questionTitle,
  language,
  sourceCode,
  lastRun,
  submitting,
  error,
  allowMultipleSubmissions,
  previousSubmissionCount,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questionTitle: string;
  language: Language;
  sourceCode: string;
  /** The last run *for this exact buffer*, or null when a fresh run is needed. */
  lastRun: ExecutionResult | null;
  submitting: boolean;
  error: string | null;
  allowMultipleSubmissions: boolean;
  previousSubmissionCount: number;
  onConfirm: () => void;
}) {
  const lines = sourceCode === '' ? 0 : sourceCode.split('\n').length;
  const total = lastRun?.tests.length ?? 0;
  const passed = lastRun ? passedCount(lastRun.tests) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit “{questionTitle}”?</DialogTitle>
          <DialogDescription>
            {allowMultipleSubmissions
              ? 'You can submit this question again later; every attempt is recorded.'
              : 'This interview allows one submission per question. This cannot be undone.'}
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">Language</dt>
          <dd className="font-medium">{LANGUAGE_LABEL[language]}</dd>

          <dt className="text-muted-foreground">Code</dt>
          <dd className="tnum">
            {lines} {lines === 1 ? 'line' : 'lines'}
          </dd>

          <dt className="text-muted-foreground">Tests</dt>
          <dd>
            {lastRun ? (
              <span className="tnum">
                {passed} of {total} passing from your last run
              </span>
            ) : (
              <span className="text-muted-foreground">
                Will run now — your code changed since the last run
              </span>
            )}
          </dd>

          {previousSubmissionCount > 0 ? (
            <>
              <dt className="text-muted-foreground">Previous</dt>
              <dd className="tnum">
                {previousSubmissionCount}{' '}
                {previousSubmissionCount === 1 ? 'submission' : 'submissions'}
              </dd>
            </>
          ) : null}
        </dl>

        <p className="text-muted-foreground text-[12px]">
          The score is calculated on the server from the question&rsquo;s own test weights.
        </p>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} loading={submitting}>
            {lastRun ? 'Confirm submission' : 'Run tests and confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
