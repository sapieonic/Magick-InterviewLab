'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Gavel, History } from 'lucide-react';
import type { ApplicationStatus, DecisionOutcome } from '@/generated/prisma/enums';
import { recordDecisionAction } from '@/features/decisions/actions';
import { DecisionBadge } from '@/components/admin/badges';
import { FieldErrors } from '@/components/admin/form';
import { Markdown } from '@/components/markdown';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { DecisionView } from '@/features/scorecard/queries';
import type { ActionResult } from '@/lib/action-result';
import { formatDate } from '@/lib/utils';

/**
 * Recording the hire / no-hire.
 *
 * The rationale is a first-class field, not a footnote: it is what makes the
 * decision reviewable six months later, and the server refuses anything under
 * a sentence. Changing an existing decision is allowed and is loudly labelled,
 * because a reversal that looks like an edit is how a record stops being one.
 */

const OUTCOMES: ReadonlyArray<{ value: DecisionOutcome; label: string; hint: string }> = [
  { value: 'HIRE', label: 'Hire', hint: 'Make an offer.' },
  { value: 'NO_HIRE', label: 'No hire', hint: 'Do not proceed with this application.' },
  { value: 'HOLD', label: 'Hold', hint: 'Not now — keep the application open.' },
];

const MIN_RATIONALE = 20;

export function DecisionForm({
  applicationId,
  applicationStatus,
  decision,
}: {
  applicationId: string;
  applicationStatus: ApplicationStatus;
  decision: DecisionView | null;
}) {
  const [outcome, setOutcome] = useState<DecisionOutcome | ''>(decision?.outcome ?? '');
  const [rationale, setRationale] = useState(decision?.rationale ?? '');
  const [result, setResult] = useState<ActionResult<undefined> | null>(null);
  const [pending, startTransition] = useTransition();

  const fieldErrors = result && !result.ok ? (result.fieldErrors ?? {}) : {};
  const generalError =
    result && !result.ok && Object.keys(fieldErrors).length === 0 ? result.error : null;
  const stillOpen = applicationStatus === 'ACTIVE' || applicationStatus === 'ON_HOLD';

  function submit(): void {
    const data = new FormData();
    data.set('applicationId', applicationId);
    data.set('outcome', outcome);
    data.set('rationale', rationale);
    startTransition(async () => {
      const outcomeResult = await recordDecisionAction(null, data);
      setResult(outcomeResult);
      if (outcomeResult.ok) {
        toast.success(decision ? 'Decision changed and logged.' : 'Decision recorded.');
      } else {
        toast.error(outcomeResult.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      {decision ? (
        <div className="space-y-2 rounded-md border px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <DecisionBadge outcome={decision.outcome} />
            <span className="text-muted-foreground text-[12px]">
              {decision.decidedByName ?? 'Someone no longer on the system'} ·{' '}
              {formatDate(decision.decidedAt)}
            </span>
          </div>
          <Markdown content={decision.rationale} className="text-[13px]" />
        </div>
      ) : null}

      {decision && decision.history.length > 1 ? (
        <div className="space-y-1.5">
          <p className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
            <History className="size-3.5" aria-hidden />
            History
          </p>
          <ul className="space-y-1 text-[12px]">
            {decision.history.map((entry, index) => (
              <li key={`${entry.at.toISOString()}-${index}`} className="text-muted-foreground">
                {formatDate(entry.at)} — {entry.actorName ?? 'Unknown'}{' '}
                {entry.previousOutcome
                  ? `changed ${label(entry.previousOutcome)} to ${label(entry.outcome)}`
                  : `recorded ${label(entry.outcome)}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {generalError ? <Alert tone="error">{generalError}</Alert> : null}

      <div className="space-y-1.5">
        <Label htmlFor="outcome">{decision ? 'Change the outcome' : 'Outcome'}</Label>
        <Select
          id="outcome"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as DecisionOutcome | '')}
        >
          <option value="">Choose an outcome</option>
          {OUTCOMES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} — {option.hint}
            </option>
          ))}
        </Select>
        <FieldErrors errors={fieldErrors['outcome']} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rationale">Rationale</Label>
        <Textarea
          id="rationale"
          value={rationale}
          rows={5}
          onChange={(e) => setRationale(e.target.value)}
          aria-invalid={!!fieldErrors['rationale']?.length}
          placeholder="What the evidence showed, and what tipped it."
        />
        <p className="text-muted-foreground text-[12px]">
          At least {MIN_RATIONALE} characters. This is the record someone else reads when the
          decision is questioned. Markdown is supported.
        </p>
        <FieldErrors errors={fieldErrors['rationale']} />
      </div>

      {decision ? (
        <Alert tone="warning" title="This replaces the current decision">
          The previous outcome is written to the audit log with your name against it, so the
          reversal stays visible.
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" loading={pending} onClick={submit}>
          <Gavel className="size-3.5" aria-hidden />
          {decision ? 'Change decision' : 'Record decision'}
        </Button>
      </div>

      {stillOpen ? (
        // Deciding and processing stay separate — see the note on
        // `recordDecisionAction` — but the sentence this replaces sent the
        // reader off to the pipeline to finish a job that is now offered
        // directly below, by `CloseOutPanel`, to whoever holds
        // `MANAGE_PIPELINE`. Pointing at a panel on the same page is not a
        // softening of the separation: it is still a second, deliberate click,
        // made by the person answerable for it, logged as its own event.
        <p className="text-muted-foreground text-[12px]">
          Recording a decision does not close the application — it is still{' '}
          {applicationStatus === 'ACTIVE' ? 'active' : 'on hold'}. Deciding and processing are
          separate jobs, so closing it is a second, deliberate step, taken by whoever runs the
          pipeline once the offer or the rejection has actually gone out. If that is you, the
          close-out sits just below.
        </p>
      ) : null}
    </div>
  );
}

function label(outcome: DecisionOutcome | null): string {
  if (!outcome) return 'a decision';
  return OUTCOMES.find((o) => o.value === outcome)?.label ?? outcome;
}
