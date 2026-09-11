'use client';

import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';

/**
 * Shown when a candidate presses Submit on a question they have already
 * submitted, in an interview that allows one attempt.
 *
 * It exists because the previous answer to that press was *nothing*: the
 * button was simply disabled, so a candidate who had forgotten they had
 * already submitted — or who was checking whether it went through — clicked a
 * dead control and learned nothing. A disabled button is only self-explanatory
 * to someone who already knows why it is disabled.
 *
 * So the press is deliberately left live and answered here, with the thing the
 * candidate actually wants to know: that it is recorded, what it scored, and
 * when. The dialog is also the place to point them forward, since "can I still
 * do something about this?" is the next question after "did it save?".
 */
export function AlreadySubmittedDialog({
  open,
  onOpenChange,
  questionTitle,
  submission,
  nextQuestionHref,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questionTitle: string;
  /** The recorded attempt. Null only if the row vanished under us. */
  submission: { score: number; passed: number; total: number; submittedAt: number | null } | null;
  /** Where "Next question" goes, when this is not the last one. */
  nextQuestionHref?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-start gap-2.5">
            <span
              className="bg-success/10 text-success mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full"
              aria-hidden
            >
              <CheckCircle2 className="size-4.5" />
            </span>
            <div className="min-w-0">
              <DialogTitle>This has already been submitted</DialogTitle>
              <DialogDescription>
                Your answer to &ldquo;{questionTitle}&rdquo; is recorded. This interview allows one
                submission per question, so it cannot be replaced.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {submission ? (
          <dl className="bg-muted/40 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md px-3 py-2.5 text-[13px]">
            <dt className="text-muted-foreground">Score</dt>
            <dd className="tnum font-medium">{submission.score}%</dd>

            <dt className="text-muted-foreground">Tests</dt>
            <dd className="tnum">
              {submission.passed} of {submission.total} passing
            </dd>

            {submission.submittedAt !== null ? (
              <>
                <dt className="text-muted-foreground">Submitted</dt>
                <dd>{formatDate(new Date(submission.submittedAt))}</dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {/* Deliberately no "they can reopen it for you": there is no
            per-candidate reopen. The only lever an admin has is the
            interview-wide `allowMultipleSubmissions` toggle, which would
            change the rule for every question and every candidate on it. */}
        <p className="text-muted-foreground text-[12px]">
          Your reviewer sees this answer and the time it was recorded. If you think you submitted by
          mistake, tell whoever set up this interview.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {nextQuestionHref ? (
            <Button asChild>
              <Link href={nextQuestionHref}>Next question</Link>
            </Button>
          ) : (
            <Button asChild>
              <Link href="/interview">Back to your interviews</Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
