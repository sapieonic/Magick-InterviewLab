'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { DoorClosed } from 'lucide-react';
import type { ApplicationStatus, DecisionOutcome } from '@/generated/prisma/enums';
import { setApplicationStatusAction } from '@/features/pipeline/actions';
import { Button } from '@/components/ui/button';
import type { ActionResult } from '@/lib/action-result';

/**
 * The hand-off from deciding to closing.
 *
 * `recordDecisionAction` deliberately leaves `Application.status` alone — see
 * the long note on it — and the debrief has said so in a sentence since the
 * feature shipped. A sentence is not a hand-off: the decision was recorded,
 * the application stayed open, and nothing anywhere told the person who owns
 * the pipeline that there was now something for them to do. Applications sat
 * `ACTIVE` behind a no-hire for weeks.
 *
 * So the separation stays and gets a second click instead. This panel offers
 * the obvious status for the outcome and makes a human confirm it, which is a
 * different thing from the action doing it itself: the confirming click is
 * made by someone holding `MANAGE_PIPELINE`, at the moment they know the
 * rejection or the offer has actually gone out, and it lands in the audit log
 * as its own event rather than folded invisibly into the decision.
 *
 * Nothing here re-derives the outcome or argues for one. It reads the decision
 * a person already wrote and suggests the matching status.
 */

/**
 * The suggestion, and only ever a suggestion.
 *
 * `HOLD` maps to `ON_HOLD` rather than to a close, which is the honest mapping
 * — "not now" is not an ending — and is why this panel can be a suggestion at
 * all: a third of the outcomes do not close anything.
 */
const SUGGESTION = {
  HIRE: { status: 'HIRED', outcome: 'Hire', label: 'Close as hired', done: 'Closed as hired' },
  NO_HIRE: {
    status: 'REJECTED',
    outcome: 'No hire',
    label: 'Close as rejected',
    done: 'Closed as rejected',
  },
  // `done` is worded separately for this one rather than slotted into a
  // "closed as {x}" template: moving to on hold closes nothing, and a toast
  // that said otherwise would be the product lying about what it just did.
  HOLD: { status: 'ON_HOLD', outcome: 'Hold', label: 'Move to on hold', done: 'Moved to on hold' },
} as const satisfies Record<
  DecisionOutcome,
  { status: ApplicationStatus; outcome: string; label: string; done: string }
>;

export function CloseOutPanel({
  applicationId,
  applicationStatus,
  outcome,
  canManagePipeline,
}: {
  applicationId: string;
  applicationStatus: ApplicationStatus;
  /** Null until a decision exists — there is nothing to close out before it. */
  outcome: DecisionOutcome | null;
  canManagePipeline: boolean;
}) {
  // Client-side only, and deliberately not persisted. "I have seen this and I
  // am leaving it open" is a real answer, but there is no column for it, and
  // inventing one would make a dismissal look like a decision in the audit
  // log. It quietens the panel for this reader, on this page, until the next
  // load — that is all it claims to do.
  const [dismissed, setDismissed] = useState(false);
  const [settled, setSettled] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const stillOpen = applicationStatus === 'ACTIVE' || applicationStatus === 'ON_HOLD';
  if (!outcome || !canManagePipeline || !stillOpen) return null;

  const suggestion = SUGGESTION[outcome];

  if (settled) {
    // The action revalidates this path, so the status prop catches up and this
    // component stops rendering a moment later. Until it does, say what
    // happened rather than leaving the button sitting there inviting a second
    // click at a status that is already set.
    return (
      <p className="text-muted-foreground text-[12px]">{settled}, and logged against your name.</p>
    );
  }

  // Recording `HOLD` against an application that is already on hold leaves
  // nothing to confirm — the action itself would no-op — so the panel says so
  // instead of offering a button that does nothing.
  if (suggestion.status === applicationStatus) {
    return (
      <p className="text-muted-foreground text-[12px]">
        The decision is {suggestion.outcome} and this application is already on hold, so there is
        nothing to change. Closing it for good is still a separate, deliberate step.
      </p>
    );
  }

  if (dismissed) {
    return (
      <p className="text-muted-foreground text-[12px]">
        Left open. Close it here, or from the status control on the application, once the outcome
        has gone out.
      </p>
    );
  }

  function close(): void {
    const data = new FormData();
    data.set('id', applicationId);
    data.set('status', suggestion.status);
    startTransition(async () => {
      const result: ActionResult<undefined> = await setApplicationStatusAction(null, data);
      if (result.ok) {
        setSettled(suggestion.done);
        toast.success(`${suggestion.done}.`);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-2 rounded-md border px-3 py-3">
      <p className="text-[13px] font-medium">
        {suggestion.outcome} is recorded. The application is still{' '}
        {applicationStatus === 'ACTIVE' ? 'active' : 'on hold'}.
      </p>
      <p className="text-muted-foreground text-[13px]">
        Deciding and closing are separate on purpose: the offer or the rejection should reach the
        candidate before the file shuts, and the close is logged as its own event with your name on
        it. This is a suggestion from the decision, not a consequence of it — nothing changes until
        you press the button.
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <Button type="button" size="sm" loading={pending} onClick={close}>
          <DoorClosed className="size-3.5" aria-hidden />
          {suggestion.label}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setDismissed(true)}
        >
          Keep open
        </Button>
      </div>
    </div>
  );
}
