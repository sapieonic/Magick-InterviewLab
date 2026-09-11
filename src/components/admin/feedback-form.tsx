'use client';

import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Eye, Save, Send } from 'lucide-react';
import type { Confidence, FeedbackStatus, Recommendation } from '@/generated/prisma/enums';
import { saveFeedbackDraftAction, submitFeedbackAction } from '@/features/feedback/actions';
import { CONFIDENCE_LABELS, RECOMMENDATION_LABELS } from '@/components/admin/badges';
import { RECOMMENDATION_ORDER } from '@/features/scorecard/aggregate';
import { FieldErrors } from '@/components/admin/form';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ActionResult } from '@/lib/action-result';
import { cn } from '@/lib/utils';

/**
 * The scorecard itself.
 *
 * Save and Submit are deliberately different buttons rather than one button
 * with a status dropdown: a draft is private to its author forever, submitting
 * publishes it to the panel and starts the append-only trail, and those are
 * not two settings of the same thing. Submit therefore goes through a
 * confirmation that says exactly what changes.
 *
 * Every field is controlled and the payload is built from state rather than
 * read off the DOM, because the confirm dialog is portalled out of the form
 * and would otherwise not be able to see any of it.
 */

export interface FeedbackFormCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  maxScore: number;
}

export interface FeedbackFormInitial {
  recommendation: Recommendation | null;
  confidence: Confidence | null;
  summary: string;
  strengths: string;
  concerns: string;
  scores: Array<{ criterionId: string; score: number; note: string }>;
}

/**
 * The scale, best first — which is the *opposite* of `RECOMMENDATION_ORDER`.
 *
 * That constant is ordinal: it runs worst to best because the distribution
 * buckets, the mean position and the min/max of a disagreement all depend on
 * the scale ascending. A dropdown is not a scale, it is a list someone reads
 * top-down, and the first thing a reviewer should see is the strongest
 * endorsement rather than the strongest rejection.
 *
 * So the display order is derived from the one definition rather than typed
 * out again. There used to be a second array of the same name and type, in
 * this file, pointing the other way; nothing imported the wrong one, which is
 * exactly the kind of trap that holds until somebody does.
 */
const RECOMMENDATION_DISPLAY_ORDER: readonly Recommendation[] = [...RECOMMENDATION_ORDER].reverse();

const CONFIDENCE_ORDER: readonly Confidence[] = ['HIGH', 'MEDIUM', 'LOW'];

interface ScoreState {
  score: number | null;
  note: string;
}

export function FeedbackForm({
  stageId,
  criteria,
  initial,
  status,
  revisionCount,
  rubricName,
}: {
  stageId: string;
  criteria: readonly FeedbackFormCriterion[];
  initial: FeedbackFormInitial | null;
  status: FeedbackStatus | null;
  revisionCount: number;
  rubricName: string | null;
}) {
  const submitted = status === 'SUBMITTED';

  const [recommendation, setRecommendation] = useState<Recommendation | ''>(
    initial?.recommendation ?? '',
  );
  const [confidence, setConfidence] = useState<Confidence | ''>(initial?.confidence ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [strengths, setStrengths] = useState(initial?.strengths ?? '');
  const [concerns, setConcerns] = useState(initial?.concerns ?? '');
  const [revisionReason, setRevisionReason] = useState('');
  const [scores, setScores] = useState<Record<string, ScoreState>>(() => {
    const seed: Record<string, ScoreState> = {};
    for (const criterion of criteria) {
      const existing = initial?.scores.find((s) => s.criterionId === criterion.id);
      seed[criterion.id] = { score: existing?.score ?? null, note: existing?.note ?? '' };
    }
    return seed;
  });

  const [result, setResult] = useState<ActionResult<undefined> | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const fieldErrors = result && !result.ok ? (result.fieldErrors ?? {}) : {};
  const generalError =
    result && !result.ok && Object.keys(fieldErrors).length === 0 ? result.error : null;

  const missing = useMemo(
    () => criteria.filter((c) => scores[c.id]?.score == null).length,
    [criteria, scores],
  );

  function buildFormData(): FormData {
    const data = new FormData();
    data.set('stageId', stageId);
    data.set('recommendation', recommendation);
    data.set('confidence', confidence);
    data.set('summary', summary);
    data.set('strengths', strengths);
    data.set('concerns', concerns);
    data.set('revisionReason', revisionReason);
    for (const criterion of criteria) {
      const state = scores[criterion.id];
      if (!state || state.score === null) continue;
      data.set(`score:${criterion.id}`, String(state.score));
      data.set(`note:${criterion.id}`, state.note);
    }
    return data;
  }

  function run(
    action: (
      prev: ActionResult<undefined> | null,
      formData: FormData,
    ) => Promise<ActionResult<undefined>>,
    success: string,
    onDone?: () => void,
  ): void {
    const data = buildFormData();
    startTransition(async () => {
      const outcome = await action(null, data);
      setResult(outcome);
      if (outcome.ok) {
        toast.success(success);
        onDone?.();
      } else {
        toast.error(outcome.error);
      }
    });
  }

  return (
    <div className="space-y-5">
      {generalError ? <Alert tone="error">{generalError}</Alert> : null}

      {submitted ? (
        <Alert tone="info" title="This scorecard has been submitted">
          The panel can read it. Editing it now records a revision keeping the previous version
          {revisionCount > 0
            ? ` — there ${revisionCount === 1 ? 'is' : 'are'} already ${revisionCount}.`
            : '.'}
        </Alert>
      ) : null}

      {criteria.length > 0 ? (
        <section className="space-y-4">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold tracking-tight">Rubric</h3>
            <p className="text-muted-foreground text-[12px]">
              {rubricName ? `${rubricName}. ` : ''}
              Pinned to this round, so a later edit to the rubric cannot change what you scored
              against.
            </p>
          </div>

          {criteria.map((criterion) => (
            <CriterionField
              key={criterion.id}
              criterion={criterion}
              state={scores[criterion.id] ?? { score: null, note: '' }}
              errors={fieldErrors[`score:${criterion.id}`]}
              onChange={(next) => setScores((prev) => ({ ...prev, [criterion.id]: next }))}
            />
          ))}
        </section>
      ) : (
        <Alert tone="warning" title="No rubric is pinned to this round">
          You can still record a recommendation and written feedback. Scores need a published rubric
          on the stage.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="recommendation">Recommendation</Label>
          <Select
            id="recommendation"
            value={recommendation}
            onChange={(e) => setRecommendation(e.target.value as Recommendation | '')}
          >
            <option value="">Not yet decided</option>
            {RECOMMENDATION_DISPLAY_ORDER.map((value) => (
              <option key={value} value={value}>
                {RECOMMENDATION_LABELS[value]}
              </option>
            ))}
          </Select>
          <p className="text-muted-foreground text-[12px]">
            Six points and no middle — the scale exists to make you take a side.
          </p>
          <FieldErrors errors={fieldErrors['recommendation']} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confidence">Confidence</Label>
          <Select
            id="confidence"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value as Confidence | '')}
          >
            <option value="">Not yet decided</option>
            {CONFIDENCE_ORDER.map((value) => (
              <option key={value} value={value}>
                {CONFIDENCE_LABELS[value]}
              </option>
            ))}
          </Select>
          <p className="text-muted-foreground text-[12px]">
            How sure you are, separately from which way you lean.
          </p>
          <FieldErrors errors={fieldErrors['confidence']} />
        </div>
      </div>

      <ProseField
        id="summary"
        label="Summary"
        hint="What happened and what you concluded. Required before submitting."
        value={summary}
        onChange={setSummary}
        errors={fieldErrors['summary']}
        rows={6}
      />
      <ProseField
        id="strengths"
        label="Strengths"
        hint="Evidence, not adjectives — what they did that showed it."
        value={strengths}
        onChange={setStrengths}
        errors={fieldErrors['strengths']}
      />
      <ProseField
        id="concerns"
        label="Concerns"
        hint="The reservations a debrief needs to hear, including the ones you are unsure about."
        value={concerns}
        onChange={setConcerns}
        errors={fieldErrors['concerns']}
      />

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        {submitted ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={pending}
            onClick={() => run(saveFeedbackDraftAction, 'Draft saved. Only you can see it.')}
          >
            <Save className="size-3.5" aria-hidden />
            Save draft
          </Button>
        )}
        <Button type="button" size="sm" loading={pending} onClick={() => setConfirmOpen(true)}>
          <Send className="size-3.5" aria-hidden />
          {submitted ? 'Submit revision' : 'Submit scorecard'}
        </Button>
        {criteria.length > 0 && missing > 0 ? (
          <span className="text-muted-foreground text-[12px]">
            {missing} of {criteria.length} criteria still unscored.
          </span>
        ) : null}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{submitted ? 'Submit a revision?' : 'Submit this scorecard?'}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                {submitted ? (
                  <p>
                    The current version is kept as a revision, with your reason, and stays readable
                    to anyone reviewing this round. Nothing is overwritten silently.
                  </p>
                ) : (
                  <>
                    <p>
                      Submitting makes this scorecard visible to the rest of the panel, and lets you
                      read theirs.
                    </p>
                    <p>
                      You can still edit it afterwards — every later change is recorded as a
                      revision that keeps the previous version.
                    </p>
                  </>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>

          {submitted ? (
            <div className="space-y-1.5">
              <Label htmlFor="revisionReason">Why are you changing it?</Label>
              <Textarea
                id="revisionReason"
                value={revisionReason}
                onChange={(e) => setRevisionReason(e.target.value)}
                rows={3}
                placeholder="e.g. Corrected the system design score — I had mis-read the transcript."
              />
              <p className="text-muted-foreground text-[12px]">
                Stored on the revision. Optional, and worth writing anyway.
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              size="sm"
              loading={pending}
              onClick={() =>
                run(
                  submitFeedbackAction,
                  submitted ? 'Revision recorded.' : 'Scorecard submitted.',
                  () => setConfirmOpen(false),
                )
              }
            >
              {submitted ? 'Record revision' : 'Submit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProseField({
  id,
  label,
  hint,
  value,
  onChange,
  errors,
  rows = 4,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  errors?: string[];
  rows?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!errors?.length}
      />
      <p className="text-muted-foreground text-[12px]">{hint} Markdown is supported.</p>
      <FieldErrors errors={errors} />
    </div>
  );
}

/**
 * One criterion: the scale, the description that says what the scale means,
 * and a note.
 *
 * Radio buttons rather than a select. The whole scale is visible at once, so
 * the reviewer sees that a 3 on a four-point criterion is not a 3 on a
 * ten-point one, and the ends are labelled because "4" on its own tells a
 * first-time interviewer nothing.
 */
function CriterionField({
  criterion,
  state,
  errors,
  onChange,
}: {
  criterion: FeedbackFormCriterion;
  state: ScoreState;
  errors?: string[];
  onChange: (next: ScoreState) => void;
}) {
  const points = Array.from({ length: criterion.maxScore }, (_, i) => i + 1);
  const groupId = `score:${criterion.id}`;

  return (
    <fieldset className="space-y-2.5 rounded-md border px-3 py-3">
      <legend className="sr-only">{criterion.name}</legend>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[13px] font-medium">{criterion.name}</p>
        <p className="text-muted-foreground text-[12px]">
          1–{criterion.maxScore} · weight {criterion.weight}
        </p>
      </div>
      {criterion.description ? (
        <p className="text-muted-foreground text-[12px]">{criterion.description}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {points.map((point) => {
          const active = state.score === point;
          return (
            <label
              key={point}
              className={cn(
                'flex h-8 min-w-8 cursor-pointer items-center justify-center rounded-md border px-2 text-[13px] tabular-nums transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-primary font-medium'
                  : 'hover:bg-accent/60',
              )}
            >
              <input
                type="radio"
                name={groupId}
                value={point}
                checked={active}
                onChange={() => onChange({ ...state, score: point })}
                className="sr-only"
              />
              {point}
            </label>
          );
        })}
        <span className="text-muted-foreground ml-1 text-[11px]">
          1 = well below the bar · {criterion.maxScore} = well above it
        </span>
        {state.score === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onChange({ ...state, score: null })}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`note-${criterion.id}`} className="text-muted-foreground text-[12px]">
          Note (optional)
        </Label>
        <Textarea
          id={`note-${criterion.id}`}
          value={state.note}
          rows={2}
          onChange={(e) => onChange({ ...state, note: e.target.value })}
          placeholder="What you saw that led to this score."
          className="min-h-14"
        />
      </div>

      <FieldErrors errors={errors} />
    </fieldset>
  );
}

/** Shown in place of the form when the viewer is not on the panel. */
export function NotOnPanelNotice() {
  return (
    <Alert tone="info" title="You are not on this panel">
      <span className="flex items-center gap-1.5">
        <Eye className="size-3.5 shrink-0" aria-hidden />
        You can read this round, but a scorecard from someone who was not in the interview is not
        evidence, so there is nothing here to write.
      </span>
    </Alert>
  );
}
