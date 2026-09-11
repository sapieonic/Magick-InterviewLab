'use client';

import Link from 'next/link';
import { useOptimistic, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, FileCode2, Plus, Trash2, X } from 'lucide-react';
import type {
  InterviewerRole,
  StageOutcome,
  StageStatus,
  StageType,
} from '@/generated/prisma/enums';
import {
  addPanelistAction,
  createStageAction,
  deleteStageAction,
  linkStageAssignmentAction,
  removePanelistAction,
  reorderStagesAction,
  recordStageOutcomeAction,
  setStageStatusAction,
  updateStageAction,
} from '@/features/pipeline/actions';
import {
  canTransitionStageStatus,
  isManualStatusAllowedOnCodingStage,
  STAGE_STATUS_LABELS,
} from '@/features/pipeline/stage-status';
import {
  InterviewerRoleBadge,
  StageOutcomeBadge,
  StageStatusBadge,
  StageTypeBadge,
  STAGE_TYPE_LABELS,
} from '@/components/admin/badges';
import { ActionForm, HiddenFields } from '@/components/admin/action-form';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { Field, FormAlert, SubmitButton } from '@/components/admin/form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import type { ActionResult } from '@/lib/action-result';
import { cn, formatDate } from '@/lib/utils';

/**
 * The rounds on an application: order, schedule, status, outcome and panel.
 *
 * The status control is built from the same transition table the Server Action
 * enforces (`features/pipeline/stage-status.ts` is pure and imports nothing
 * server-side, which is what makes that possible). Offering only the legal
 * moves is a courtesy; the action still refuses the illegal ones, because a
 * dropdown is not a control.
 */

export interface PanelMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: InterviewerRole;
}

export interface StageAssignmentInfo {
  id: string;
  interview: { id: string; title: string };
  submissionCount: number;
  bestScore: number | null;
  lastSubmittedAt: Date | null;
}

export interface StageListItem {
  id: string;
  name: string;
  type: StageType;
  position: number;
  status: StageStatus;
  storedStatus: StageStatus;
  outcome: StageOutcome | null;
  scheduledAt: Date | null;
  blindFeedback: boolean;
  expectedScorecards: number;
  submittedScorecards: number;
  outstandingScorecards: number;
  panel: PanelMember[];
  assignment: StageAssignmentInfo | null;
}

export interface StaffOption {
  id: string;
  name: string;
  email: string;
}

export interface InterviewOption {
  id: string;
  title: string;
}

export interface RubricOption {
  id: string;
  name: string;
  latestPublishedVersion: number;
}

const STAGE_TYPES = Object.keys(STAGE_TYPE_LABELS) as StageType[];

const OUTCOMES: ReadonlyArray<{ value: StageOutcome; label: string }> = [
  { value: 'ADVANCE', label: 'Advance' },
  { value: 'HOLD', label: 'Hold' },
  { value: 'REJECT', label: 'Reject' },
];

const INTERVIEWER_ROLES: ReadonlyArray<{ value: InterviewerRole; label: string }> = [
  { value: 'LEAD', label: 'Lead' },
  { value: 'PANELIST', label: 'Panellist' },
  { value: 'SHADOW', label: 'Shadow' },
];

/** `<input type="datetime-local">` wants a local `YYYY-MM-DDTHH:mm`, and
 *  `toISOString` would silently shift the time by the viewer's offset. */
function toDateTimeLocal(value: Date | null): string {
  if (!value) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(
    value.getHours(),
  )}:${pad(value.getMinutes())}`;
}

function allowedStatuses(stage: StageListItem): StageStatus[] {
  const all = Object.keys(STAGE_STATUS_LABELS) as StageStatus[];
  return all.filter((status) => {
    if (status === stage.status) return true;
    if (!canTransitionStageStatus(stage.status, status)) return false;
    // A coding round's progress belongs to the assessment; only the two
    // judgements the assessment cannot make are offered by hand.
    if (stage.type === 'CODING_ASSESSMENT') return isManualStatusAllowedOnCodingStage(status);
    return true;
  });
}

export function StageList({
  applicationId,
  stages,
  staff,
  interviews,
  editable,
}: {
  applicationId: string;
  stages: StageListItem[];
  staff: StaffOption[];
  interviews: InterviewOption[];
  /** False for a viewer without `MANAGE_PIPELINE` — an interviewer reads the
   *  rounds they sit on, and the controls simply are not rendered. The actions
   *  guard the same capability regardless. */
  editable: boolean;
}) {
  const [ordered, setOptimisticOrder] = useOptimistic(stages);
  const [pending, startTransition] = useTransition();

  function move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;

    const next = [...ordered];
    const moved = next[index];
    const displaced = next[target];
    if (moved === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = moved;

    startTransition(async () => {
      setOptimisticOrder(next);
      const result = await reorderStagesAction({
        applicationId,
        stageIds: next.map((s) => s.id),
      });
      if (!result.ok) toast.error(result.error);
    });
  }

  if (ordered.length === 0) {
    return (
      <p className="text-muted-foreground py-2 text-[13px]">
        No rounds yet. Apply a pipeline template above, or add one below — an application with no
        rounds has nowhere for feedback to go.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {ordered.map((stage, index) => (
        <li key={stage.id} className="rounded-md border">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <span className="text-muted-foreground w-5 shrink-0 text-[12px] tabular-nums">
              {index + 1}.
            </span>
            <Link
              href={`/admin/stages/${stage.id}`}
              className="hover:text-primary min-w-0 flex-1 truncate text-[13px] font-medium transition-colors"
            >
              {stage.name}
            </Link>
            <StageTypeBadge type={stage.type} />
            <StageStatusBadge status={stage.status} />
            {stage.outcome ? <StageOutcomeBadge outcome={stage.outcome} /> : null}

            {editable ? (
              <span className="flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === 0 || pending}
                  onClick={() => move(index, -1)}
                  aria-label={`Move ${stage.name} up`}
                  title="Move up"
                >
                  <ArrowUp className="size-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === ordered.length - 1 || pending}
                  onClick={() => move(index, 1)}
                  aria-label={`Move ${stage.name} down`}
                  title="Move down"
                >
                  <ArrowDown className="size-3.5" aria-hidden />
                </Button>
                <ConfirmAction
                  action={deleteStageAction}
                  fields={{ id: stage.id }}
                  title={`Remove "${stage.name}"?`}
                  description={
                    <>
                      <p>The round and its panel are deleted and the rest are renumbered.</p>
                      <p>
                        A round with submitted feedback cannot be removed — skip it instead, so the
                        scorecards keep the round they were written about.
                      </p>
                    </>
                  }
                  confirmLabel="Remove round"
                  triggerLabel=""
                  triggerIcon={<Trash2 className="size-3.5" aria-hidden />}
                  triggerVariant="ghost"
                  triggerSize="icon-sm"
                  success="Round removed."
                />
              </span>
            ) : null}
          </div>

          <div className="space-y-3 px-3 py-2.5">
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
              <span>Scheduled {formatDate(stage.scheduledAt)}</span>
              <span
                className={cn('tabular-nums', stage.outstandingScorecards > 0 && 'text-warning')}
              >
                {stage.submittedScorecards}/{stage.expectedScorecards} scorecards in
              </span>
              {stage.blindFeedback ? <Badge variant="outline">Blind</Badge> : null}
            </div>

            {stage.assignment ? (
              <div className="bg-muted/40 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2.5 py-1.5 text-[12px]">
                <FileCode2 className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate font-medium">
                  {stage.assignment.interview.title}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {stage.assignment.submissionCount}{' '}
                  {stage.assignment.submissionCount === 1 ? 'submission' : 'submissions'}
                  {stage.assignment.bestScore === null
                    ? ''
                    : ` · best ${stage.assignment.bestScore}%`}
                </span>
                <Link
                  href={`/admin/submissions?interviewId=${stage.assignment.interview.id}`}
                  className="hover:text-primary ml-auto transition-colors"
                >
                  Review submissions
                </Link>
              </div>
            ) : stage.type === 'CODING_ASSESSMENT' && editable ? (
              <LinkAssessmentForm stageId={stage.id} interviews={interviews} />
            ) : null}

            {editable ? (
              <div className="grid gap-3 lg:grid-cols-2">
                <StageStatusForm stage={stage} />
                <StageOutcomeForm stage={stage} />
              </div>
            ) : null}

            <PanelManager stage={stage} staff={staff} editable={editable} />

            {editable ? <StageEditForm stage={stage} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StageStatusForm({ stage }: { stage: StageListItem }) {
  const options = allowedStatuses(stage);
  const locked = options.length <= 1;

  return (
    <ActionForm
      action={setStageStatusAction}
      success="Round status updated."
      className="flex flex-wrap items-end gap-2"
    >
      <input type="hidden" name="id" value={stage.id} />
      <div className="min-w-36 flex-1 space-y-1">
        <Label htmlFor={`status-${stage.id}`} className="text-[12px]">
          Status
        </Label>
        <Select
          id={`status-${stage.id}`}
          name="status"
          defaultValue={stage.status}
          disabled={locked}
          className="h-8 text-[13px]"
        >
          {options.map((status) => (
            <option key={status} value={status}>
              {STAGE_STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
      </div>
      <SubmitButton size="sm" variant="outline" disabled={locked}>
        Set
      </SubmitButton>
      {stage.type === 'CODING_ASSESSMENT' ? (
        <p className="text-muted-foreground w-full text-[11px]">
          This round follows the assessment itself — only &ldquo;complete&rdquo; and
          &ldquo;skipped&rdquo; are set by hand.
        </p>
      ) : null}
    </ActionForm>
  );
}

function StageOutcomeForm({ stage }: { stage: StageListItem }) {
  return (
    <ActionForm
      action={recordStageOutcomeAction}
      success="Outcome recorded."
      className="flex flex-wrap items-end gap-2"
    >
      <input type="hidden" name="id" value={stage.id} />
      <div className="min-w-36 flex-1 space-y-1">
        <Label htmlFor={`outcome-${stage.id}`} className="text-[12px]">
          Outcome of this round
        </Label>
        <Select
          id={`outcome-${stage.id}`}
          name="outcome"
          defaultValue={stage.outcome ?? ''}
          className="h-8 text-[13px]"
          required
        >
          <option value="" disabled>
            Not recorded
          </option>
          {OUTCOMES.map((outcome) => (
            <option key={outcome.value} value={outcome.value}>
              {outcome.label}
            </option>
          ))}
        </Select>
      </div>
      <SubmitButton size="sm" variant="outline">
        Record
      </SubmitButton>
      <p className="text-muted-foreground w-full text-[11px]">
        A round&rsquo;s verdict, not the hire — this never changes the application&rsquo;s status.
      </p>
    </ActionForm>
  );
}

function StageEditForm({ stage }: { stage: StageListItem }) {
  const [state, setState] = useState<ActionResult<undefined> | null>(null);
  const [open, setOpen] = useState(false);

  async function submit(formData: FormData): Promise<void> {
    const result = await updateStageAction(null, formData);
    setState(result);
    if (result.ok) toast.success('Round updated.');
  }

  if (!open) {
    return (
      <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Edit round
      </Button>
    );
  }

  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={submit} className="space-y-3 rounded-md border border-dashed p-3" noValidate>
      <input type="hidden" name="id" value={stage.id} />
      <FormAlert state={state} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`name-${stage.id}`} label="Name" errors={fieldErrors?.name}>
          <Input id={`name-${stage.id}`} name="name" defaultValue={stage.name} required />
        </Field>
        <Field id={`scheduled-${stage.id}`} label="Scheduled for" errors={fieldErrors?.scheduledAt}>
          <Input
            id={`scheduled-${stage.id}`}
            name="scheduledAt"
            type="datetime-local"
            defaultValue={toDateTimeLocal(stage.scheduledAt)}
          />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id={`blind-${stage.id}`}
          name="blindFeedback"
          value="true"
          defaultChecked={stage.blindFeedback}
        />
        <Label htmlFor={`blind-${stage.id}`} className="cursor-pointer font-normal">
          Blind feedback — panellists cannot read each other until their own is in
        </Label>
      </div>

      <div className="flex gap-2">
        <SubmitButton size="sm">Save round</SubmitButton>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function LinkAssessmentForm({
  stageId,
  interviews,
}: {
  stageId: string;
  interviews: InterviewOption[];
}) {
  if (interviews.length === 0) {
    return (
      <p className="text-muted-foreground text-[12px]">
        No assessments available — publish one under Interviews to back this round.
      </p>
    );
  }

  return (
    <ActionForm
      action={linkStageAssignmentAction}
      success="Assessment attached."
      className="flex flex-wrap items-end gap-2"
    >
      <input type="hidden" name="stageId" value={stageId} />
      <div className="min-w-44 flex-1 space-y-1">
        <Label htmlFor={`interview-${stageId}`} className="text-[12px]">
          Assessment
        </Label>
        <Select
          id={`interview-${stageId}`}
          name="interviewId"
          required
          defaultValue=""
          className="h-8 text-[13px]"
        >
          <option value="" disabled>
            Choose an assessment…
          </option>
          {interviews.map((interview) => (
            <option key={interview.id} value={interview.id}>
              {interview.title}
            </option>
          ))}
        </Select>
      </div>
      <SubmitButton size="sm" variant="outline">
        Attach
      </SubmitButton>
    </ActionForm>
  );
}

function PanelManager({
  stage,
  staff,
  editable,
}: {
  stage: StageListItem;
  staff: StaffOption[];
  editable: boolean;
}) {
  const seated = new Set(stage.panel.map((member) => member.userId));
  const available = staff.filter((person) => !seated.has(person.id));

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-[12px] font-medium">Panel</p>

      {stage.panel.length === 0 ? (
        <p className="text-muted-foreground text-[12px]">
          Nobody on the panel yet — without a seat, nobody may write a scorecard for this round.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {stage.panel.map((member) => (
            <li
              key={member.id}
              className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px]"
            >
              <span className="max-w-40 truncate">{member.name}</span>
              <InterviewerRoleBadge role={member.role} />
              {editable ? (
                <ActionForm action={removePanelistAction} success="Removed from the panel.">
                  <HiddenFields fields={{ stageId: stage.id, userId: member.userId }} />
                  <SubmitButton
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${member.name} from the panel`}
                    title="Remove"
                  >
                    <X className="size-3" aria-hidden />
                  </SubmitButton>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editable && available.length > 0 ? (
        <ActionForm
          action={addPanelistAction}
          success="Added to the panel."
          className="flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="stageId" value={stage.id} />
          <Select
            name="userId"
            aria-label={`Add a panellist to ${stage.name}`}
            required
            defaultValue=""
            className="h-8 w-48 text-[13px]"
          >
            <option value="" disabled>
              Add a panellist…
            </option>
            {available.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
          <Select
            name="role"
            aria-label="Panel role"
            defaultValue="PANELIST"
            className="h-8 w-32 text-[13px]"
          >
            {INTERVIEWER_ROLES.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label}
              </option>
            ))}
          </Select>
          <SubmitButton size="sm" variant="outline">
            <Plus className="size-3.5" aria-hidden />
            Add
          </SubmitButton>
        </ActionForm>
      ) : null}
    </div>
  );
}

export function AddStageForm({
  applicationId,
  rubrics,
  interviews,
}: {
  applicationId: string;
  rubrics: RubricOption[];
  interviews: InterviewOption[];
}) {
  const [state, setState] = useState<ActionResult<undefined> | null>(null);
  const [type, setType] = useState<StageType>('LIVE_CODING');

  async function submit(formData: FormData): Promise<void> {
    const result = await createStageAction(null, formData);
    setState(result);
    if (result.ok) toast.success('Round added.');
  }

  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={submit} className="space-y-3" noValidate>
      <input type="hidden" name="applicationId" value={applicationId} />
      <FormAlert state={state} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="stage-name" label="Round name" errors={fieldErrors?.name}>
          <Input id="stage-name" name="name" placeholder="Technical screen" required />
        </Field>

        <Field id="stage-type" label="Type" errors={fieldErrors?.type}>
          <Select
            id="stage-type"
            name="type"
            value={type}
            onChange={(e) => setType(e.target.value as StageType)}
          >
            {STAGE_TYPES.map((value) => (
              <option key={value} value={value}>
                {STAGE_TYPE_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="stage-rubric"
          label="Rubric"
          errors={fieldErrors?.rubricId}
          hint="Pinned to the version published today, so a later edit cannot re-interpret a scorecard."
        >
          <Select id="stage-rubric" name="rubricId" defaultValue="">
            <option value="">No rubric</option>
            {rubrics.map((rubric) => (
              <option key={rubric.id} value={rubric.id}>
                {rubric.name} (v{rubric.latestPublishedVersion})
              </option>
            ))}
          </Select>
        </Field>

        <Field id="stage-scheduled" label="Scheduled for" errors={fieldErrors?.scheduledAt}>
          <Input id="stage-scheduled" name="scheduledAt" type="datetime-local" />
        </Field>
      </div>

      {/* Only a coding round can be backed by an assessment; the action
          refuses the field on anything else rather than ignoring it, so the
          form must not offer it where it would be refused. */}
      {type === 'CODING_ASSESSMENT' ? (
        <Field
          id="stage-interview"
          label="Assessment"
          errors={fieldErrors?.interviewId}
          hint="The candidate is assigned this interview, reusing an existing assignment if they already have one."
        >
          <Select id="stage-interview" name="interviewId" defaultValue="">
            <option value="">Attach one later</option>
            {interviews.map((interview) => (
              <option key={interview.id} value={interview.id}>
                {interview.title}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <div className="flex items-center gap-2">
        <Checkbox id="stage-blind" name="blindFeedback" value="true" defaultChecked />
        <Label htmlFor="stage-blind" className="cursor-pointer font-normal">
          Blind feedback
        </Label>
      </div>

      <SubmitButton size="sm">
        <Plus className="size-3.5" aria-hidden />
        Add round
      </SubmitButton>
    </form>
  );
}
