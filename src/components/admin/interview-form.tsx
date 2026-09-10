'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type { InterviewStatus } from '@/generated/prisma/enums';
import { createInterviewAction, updateInterviewAction } from '@/features/interviews/actions';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Field, FormAlert, SubmitButton } from '@/components/admin/form';

export interface InterviewFormValues {
  id: string;
  title: string;
  description: string;
  status: InterviewStatus;
  durationMinutes: number | null;
  allowMultipleSubmissions: boolean;
}

const STATUSES: Array<{ value: InterviewStatus; label: string; hint: string }> = [
  { value: 'DRAFT', label: 'Draft', hint: 'Not visible to candidates.' },
  { value: 'PUBLISHED', label: 'Published', hint: 'Assigned candidates can sit it.' },
  { value: 'ARCHIVED', label: 'Archived', hint: 'Read-only history.' },
];

export function InterviewForm({ interview }: { interview?: InterviewFormValues }) {
  // Both actions share a signature, so the only difference between create
  // and edit is the hidden id and where we land afterwards.
  const [state, formAction] = useActionState(
    interview ? updateInterviewAction : createInterviewAction,
    null,
  );
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {interview ? <input type="hidden" name="id" value={interview.id} /> : null}
      <FormAlert state={state} success="Interview saved." />

      <Field id="title" label="Title" errors={fieldErrors?.title}>
        <Input
          id="title"
          name="title"
          defaultValue={interview?.title ?? ''}
          required
          autoFocus={!interview}
          aria-invalid={!!fieldErrors?.title?.length}
        />
      </Field>

      <Field
        id="description"
        label="Description"
        errors={fieldErrors?.description}
        hint="Shown to the candidate before they start."
      >
        <Textarea
          id="description"
          name="description"
          rows={4}
          defaultValue={interview?.description ?? ''}
          aria-invalid={!!fieldErrors?.description?.length}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="status" label="Status" errors={fieldErrors?.status}>
          <Select id="status" name="status" defaultValue={interview?.status ?? 'DRAFT'}>
            {STATUSES.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label} — {status.hint}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="durationMinutes"
          label="Duration (minutes)"
          errors={fieldErrors?.durationMinutes}
          hint="Leave blank for an untimed interview."
        >
          <Input
            id="durationMinutes"
            name="durationMinutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={1440}
            placeholder="Untimed"
            defaultValue={interview?.durationMinutes ?? ''}
            aria-invalid={!!fieldErrors?.durationMinutes?.length}
          />
        </Field>
      </div>

      <div className="flex items-start gap-2.5">
        <Checkbox
          id="allowMultipleSubmissions"
          name="allowMultipleSubmissions"
          defaultChecked={interview?.allowMultipleSubmissions ?? true}
          className="mt-0.5"
        />
        <div className="space-y-0.5">
          <Label htmlFor="allowMultipleSubmissions">Allow multiple submissions per question</Label>
          <p className="text-muted-foreground text-[12px]">
            When off, a candidate gets one attempt at each question.
          </p>
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <SubmitButton size={interview ? 'sm' : 'default'}>
          {interview ? 'Save changes' : 'Create interview'}
        </SubmitButton>
        {interview ? null : (
          <Button asChild variant="ghost">
            <Link href="/admin/interviews">Cancel</Link>
          </Button>
        )}
      </div>
    </form>
  );
}
