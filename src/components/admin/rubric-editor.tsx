'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useId, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react';
import {
  createRubricAction,
  saveRubricVersionAction,
  updateRubricAction,
} from '@/features/rubrics/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/admin/page-header';
import { Field, FieldErrors, FormAlert, SubmitButton } from '@/components/admin/form';

/**
 * The client half of rubric authoring.
 *
 * Three components share this file because they share one vocabulary — a
 * criterion, a weight, a scale — and because the two profile forms are a
 * handful of fields each; splitting them out would buy a file per form and no
 * clarity. The criteria editor is the substantial one.
 *
 * Note the split in idiom, which is not accidental. The profile forms post
 * plain fields and use `useActionState` with `FormAlert`, like `InterviewForm`.
 * The criteria editor holds a variable-length list of sub-rows and posts a
 * typed object, so it drives the action through a transition and renders
 * per-row errors itself, like `QuestionEditor` — `useActionState` wants a
 * FormData-shaped action, and flattening the rows into field names would lose
 * the schema on the way through.
 */

/** Smallest legal scale; the schema refuses anything narrower. */
const MIN_MAX_SCORE = 2;
const MAX_MAX_SCORE = 10;

const SCALE_OPTIONS = Array.from(
  { length: MAX_MAX_SCORE - MIN_MAX_SCORE + 1 },
  (_, index) => index + MIN_MAX_SCORE,
);

/**
 * What an interviewer will actually be handed. 1 is always the bottom of the
 * scale, so a criterion is fully described by its top.
 */
export function ScalePreview({ maxScore, label }: { maxScore: number; label: string }) {
  const points = Array.from({ length: Math.max(0, maxScore) }, (_, index) => index + 1);
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label={label}>
      {points.map((point) => (
        <li
          key={point}
          className="border-input text-muted-foreground flex size-6 items-center justify-center rounded border text-[11px] tabular-nums"
        >
          {point}
        </li>
      ))}
    </ol>
  );
}

/**
 * The share of the final average this criterion carries.
 *
 * Deliberately not exported: everything in this module is a client reference,
 * so a Server Component that imported this would get a proxy and fail at the
 * call. The detail page computes the same figure inline for published versions.
 */
function weightShare(weight: number, totalWeight: number): string {
  if (!Number.isFinite(weight) || totalWeight <= 0) return '—';
  return `${Math.round((weight / totalWeight) * 100)}%`;
}

// --- rubric profile --------------------------------------------------------

export function NewRubricForm() {
  const [state, formAction] = useActionState(createRubricAction, null);
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormAlert state={state} />

      <Field id="new-rubric-name" label="Name" errors={fieldErrors?.name}>
        <Input
          id="new-rubric-name"
          name="name"
          placeholder="e.g. Behavioural — Senior Engineer"
          required
          aria-invalid={!!fieldErrors?.name?.length}
        />
      </Field>

      <Field
        id="new-rubric-description"
        label="Description"
        errors={fieldErrors?.description}
        hint="What this instrument is for, and which rounds should use it."
      >
        <Textarea
          id="new-rubric-description"
          name="description"
          rows={3}
          aria-invalid={!!fieldErrors?.description?.length}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <SubmitButton>Create rubric</SubmitButton>
        <span className="text-muted-foreground text-[12px]">
          Creates version 1 as a draft and opens it for editing.
        </span>
      </div>
    </form>
  );
}

export interface RubricProfileValues {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
}

export function RubricProfileForm({ rubric }: { rubric: RubricProfileValues }) {
  const [state, formAction] = useActionState(updateRubricAction, null);
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="id" value={rubric.id} />
      <FormAlert state={state} success="Rubric saved." />

      <Field id="rubric-name" label="Name" errors={fieldErrors?.name}>
        <Input
          id="rubric-name"
          name="name"
          defaultValue={rubric.name}
          required
          aria-invalid={!!fieldErrors?.name?.length}
        />
      </Field>

      <Field id="rubric-description" label="Description" errors={fieldErrors?.description}>
        <Textarea
          id="rubric-description"
          name="description"
          rows={3}
          defaultValue={rubric.description}
          aria-invalid={!!fieldErrors?.description?.length}
        />
      </Field>

      <div className="flex items-start gap-2.5">
        <Checkbox
          id="rubric-active"
          name="isActive"
          defaultChecked={rubric.isActive}
          className="mt-0.5"
        />
        <div className="space-y-0.5">
          <Label htmlFor="rubric-active">Available for new stages</Label>
          <p className="text-muted-foreground text-[12px]">
            Turning this off hides the rubric from the pickers. Stages already pinned to one of its
            versions keep it.
          </p>
        </div>
      </div>

      <div className="pt-1">
        <SubmitButton size="sm">Save changes</SubmitButton>
      </div>
    </form>
  );
}

// --- criteria editor -------------------------------------------------------

export interface RubricCriterionValues {
  /**
   * The persisted id, absent for a row the author just added. Round-tripping it
   * is what lets the server update a criterion in place instead of deleting and
   * recreating it — a `FeedbackScore` points at this id, so re-minting it would
   * discard any scores already entered against this draft.
   */
  id?: string;
  name: string;
  description: string;
  weight: number;
  maxScore: number;
}

export interface RubricDraftValues {
  versionId: string;
  version: number;
  notes: string;
  criteria: RubricCriterionValues[];
}

interface CriterionRow extends RubricCriterionValues {
  /** Stable across reorders so React keeps focus in the right input. */
  key: string;
}

let rowCounter = 0;
function newKey(): string {
  rowCounter += 1;
  return `criterion-${rowCounter}`;
}

function emptyRow(): CriterionRow {
  return { key: newKey(), name: '', description: '', weight: 1, maxScore: 4 };
}

const CRITERION_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'name',
  description: 'description',
  weight: 'weight',
  maxScore: 'scale',
};

/** `criteria.2.weight` reads as "Criterion 3 — weight". */
function describeErrorPath(path: string): string {
  // The list as a whole, e.g. "A rubric needs at least one criterion." — it
  // arrives keyed on the bare array, which the per-row pattern below misses.
  if (path === 'criteria') return 'Criteria';

  const match = /^criteria\.(\d+)(?:\.(\w+))?$/.exec(path);
  if (!match) return path;
  const position = Number(match[1]) + 1;
  const field = match[2];
  return field
    ? `Criterion ${position} — ${CRITERION_FIELD_LABELS[field] ?? field}`
    : `Criterion ${position}`;
}

export function RubricCriteriaEditor({ draft }: { draft: RubricDraftValues }) {
  const router = useRouter();
  const uid = useId();
  const [pending, startTransition] = useTransition();

  const [notes, setNotes] = useState(draft.notes);
  const [rows, setRows] = useState<CriterionRow[]>(
    draft.criteria.map((criterion) => ({ ...criterion, key: newKey() })),
  );

  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const totalWeight = rows.reduce(
    (sum, row) => sum + (Number.isFinite(row.weight) ? row.weight : 0),
    0,
  );

  function patchRow(index: number, patch: Partial<RubricCriterionValues>): void {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function moveRow(index: number, delta: number): void {
    const target = index + delta;
    setRows((current) => {
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const moved = next[index];
      const displaced = next[target];
      if (moved === undefined || displaced === undefined) return current;
      next[index] = displaced;
      next[target] = moved;
      return next;
    });
  }

  function save(): void {
    setError(null);
    setFieldErrors({});

    const payload = {
      versionId: draft.versionId,
      notes,
      criteria: rows.map((row) => ({
        ...(row.id ? { id: row.id } : {}),
        name: row.name,
        description: row.description,
        weight: row.weight,
        maxScore: row.maxScore,
      })),
    };

    startTransition(async () => {
      const result = await saveRubricVersionAction(payload);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }
      toast.success('Draft saved.');

      // Adopt the ids the server just minted. `router.refresh()` re-renders the
      // page but does not remount this component, so its state — and therefore
      // the next payload — would otherwise still describe every new row as new,
      // and the second save would delete and recreate what the first one wrote.
      const { criterionIds } = result.data;
      setRows((current) =>
        current.map((row, index) => {
          const id = criterionIds[index];
          return id ? { ...row, id } : row;
        }),
      );

      // The version history beside this editor is rendered from the same read,
      // so it has to be re-fetched for the criteria count to stay honest.
      router.refresh();
    });
  }

  // Anything not rendered next to a field — most usefully the per-criterion
  // messages, whose Zod paths look like `criteria.2.weight` and mean nothing
  // to the person reading them.
  const unmappedErrors = Object.entries(fieldErrors)
    .filter(([key]) => key !== 'notes')
    .map(([key, messages]) => [describeErrorPath(key), messages] as const);

  return (
    <div className="space-y-4">
      {error ? (
        <Alert tone="error" title={error}>
          {unmappedErrors.length > 0 ? (
            <ul className="mt-1 list-disc pl-4">
              {unmappedErrors.map(([label, messages]) => (
                <li key={label}>
                  <span className="font-medium">{label}</span>: {messages.join(' ')}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-[12px] tabular-nums">
          {rows.length} {rows.length === 1 ? 'criterion' : 'criteria'} · total weight {totalWeight}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setRows((current) => [...current, emptyRow()])}
        >
          <Plus className="size-3.5" aria-hidden />
          Add criterion
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">
          No criteria yet. A version with none cannot be published &mdash; there would be nothing
          for an interviewer to score.
        </p>
      ) : (
        <ol className="space-y-3">
          {rows.map((row, index) => (
            <li key={row.key} className="rounded-md border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">Criterion {index + 1}</span>
                  <Badge variant="outline" className="tabular-nums">
                    {weightShare(row.weight, totalWeight)} of the score
                  </Badge>
                </span>
                <span className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={index === 0}
                    onClick={() => moveRow(index, -1)}
                    aria-label={`Move criterion ${index + 1} up`}
                    title="Move up"
                  >
                    <ArrowUp className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={index === rows.length - 1}
                    onClick={() => moveRow(index, 1)}
                    aria-label={`Move criterion ${index + 1} down`}
                    title="Move down"
                  >
                    <ArrowDown className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    aria-label={`Remove criterion ${index + 1}`}
                    title="Remove criterion"
                  >
                    <Trash2 className="text-destructive size-3.5" aria-hidden />
                  </Button>
                </span>
              </div>

              <div className="space-y-3 px-3 py-3">
                <Field id={`${uid}-name-${row.key}`} label="Name">
                  <Input
                    id={`${uid}-name-${row.key}`}
                    value={row.name}
                    onChange={(e) => patchRow(index, { name: e.target.value })}
                    placeholder="e.g. Communicates trade-offs"
                  />
                </Field>

                <Field
                  id={`${uid}-desc-${row.key}`}
                  label="Description"
                  hint="What a high score looks like. The interviewer reads this while scoring."
                >
                  <Textarea
                    id={`${uid}-desc-${row.key}`}
                    value={row.description}
                    onChange={(e) => patchRow(index, { description: e.target.value })}
                    rows={3}
                  />
                </Field>

                <div className="grid gap-3 sm:grid-cols-[8rem_10rem_minmax(0,1fr)]">
                  <Field id={`${uid}-weight-${row.key}`} label="Weight">
                    <Input
                      id={`${uid}-weight-${row.key}`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={100}
                      value={String(row.weight)}
                      onChange={(e) =>
                        patchRow(index, { weight: Number.parseInt(e.target.value, 10) || 0 })
                      }
                    />
                  </Field>

                  <Field id={`${uid}-scale-${row.key}`} label="Scale">
                    <Select
                      id={`${uid}-scale-${row.key}`}
                      value={String(row.maxScore)}
                      onChange={(e) =>
                        patchRow(index, { maxScore: Number.parseInt(e.target.value, 10) || 0 })
                      }
                    >
                      {SCALE_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          1 &ndash; {value}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <div className="space-y-1.5">
                    <span className="text-[13px] font-medium">Interviewer sees</span>
                    <ScalePreview
                      maxScore={row.maxScore}
                      label={`Scale for criterion ${index + 1}: 1 to ${row.maxScore}`}
                    />
                    <p className="text-muted-foreground text-[12px]">
                      1 is always the bottom of the scale.
                    </p>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <Field
        id={`${uid}-notes`}
        label="Version notes"
        hint="What changed and why. Whoever picks this version later reads this, not the diff."
      >
        <Textarea
          id={`${uid}-notes`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          aria-invalid={!!fieldErrors['notes']?.length}
        />
        <FieldErrors errors={fieldErrors['notes']} />
      </Field>

      {rows.length > 0 ? (
        <Section
          title="Scorecard preview"
          description="How this draft reads to an interviewer, and how much each line moves the average."
        >
          <ul className="divide-border -my-2 divide-y">
            {rows.map((row, index) => (
              <li key={row.key} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-[13px] font-medium">
                    {row.name.trim() || (
                      <span className="text-muted-foreground italic">Untitled criterion</span>
                    )}
                  </p>
                  {row.description.trim() ? (
                    <p className="text-muted-foreground text-[12px]">{row.description}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <ScalePreview
                    maxScore={row.maxScore}
                    label={`Preview scale for criterion ${index + 1}`}
                  />
                  <span className="text-muted-foreground w-12 text-right text-[12px] tabular-nums">
                    {weightShare(row.weight, totalWeight)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <div className="bg-background/90 sticky bottom-0 flex flex-wrap items-center gap-2 border-t py-3 backdrop-blur">
        <Button type="button" onClick={save} loading={pending}>
          <Save className="size-3.5" aria-hidden />
          Save draft
        </Button>
        <Button asChild variant="ghost">
          <Link href="/admin/rubrics">Back to rubrics</Link>
        </Button>
        <span className="text-muted-foreground ml-auto text-[12px]">
          Saving replaces version {draft.version}&rsquo;s criteria with exactly what is listed
          above.
        </span>
      </div>
    </div>
  );
}
