'use client';

import { useState } from 'react';
import type { ApplicationStatus } from '@/generated/prisma/enums';
import {
  addApplicationCommentAction,
  applyTemplateAction,
  createApplicationAction,
  setApplicationStatusAction,
  updateApplicationAction,
} from '@/features/pipeline/actions';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Field, FormAlert, SubmitButton } from '@/components/admin/form';
import { ActionForm, HiddenFields } from '@/components/admin/action-form';
import type { ActionResult } from '@/lib/action-result';

/**
 * Forms for the application itself — who it is for, who owns it, and whether
 * it is still running. The rounds are in `stage-forms.tsx`.
 *
 * Prop shapes are declared here rather than imported from the read models: a
 * form needs an id and a label, and spelling that out keeps a later widening
 * of a query from quietly enlarging what crosses to the browser.
 */

export interface OptionRow {
  id: string;
  name: string;
  email?: string;
}

export interface JobRoleOption {
  id: string;
  title: string;
  level: string;
  pipelineTemplateId?: string | null;
}

export interface TemplateOption {
  id: string;
  name: string;
  stageCount: number;
}

function jobRoleLabel(role: JobRoleOption): string {
  return role.level ? `${role.title} · ${role.level}` : role.title;
}

export function ApplicationCreateForm({
  candidates,
  jobRoles,
  templates,
  owners,
}: {
  candidates: OptionRow[];
  jobRoles: JobRoleOption[];
  templates: TemplateOption[];
  owners: OptionRow[];
}) {
  const [state, setState] = useState<ActionResult<undefined> | null>(null);

  async function submit(formData: FormData): Promise<void> {
    // On success the action redirects, so this only ever runs on failure.
    setState(await createApplicationAction(null, formData));
  }

  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  if (candidates.length === 0) {
    return (
      <p className="text-muted-foreground text-[13px]">
        Every candidate already has an application in flight. Close one, or add a candidate first.
      </p>
    );
  }

  return (
    <form action={submit} className="space-y-4" noValidate>
      <FormAlert state={state} />

      <Field
        id="candidateId"
        label="Candidate"
        errors={fieldErrors?.candidateId}
        hint="Only candidates with no active application are listed."
      >
        <Select id="candidateId" name="candidateId" required defaultValue="">
          <option value="" disabled>
            Choose a candidate…
          </option>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
              {candidate.email ? ` · ${candidate.email}` : ''}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="jobRoleId" label="Job role" errors={fieldErrors?.jobRoleId}>
          <Select id="jobRoleId" name="jobRoleId" defaultValue="">
            <option value="">No role — one-off assessment</option>
            {jobRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {jobRoleLabel(role)}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="pipelineTemplateId"
          label="Pipeline"
          errors={fieldErrors?.pipelineTemplateId}
          hint="Applied straight away. The rounds can still be edited afterwards."
        >
          <Select id="pipelineTemplateId" name="pipelineTemplateId" defaultValue="">
            <option value="">Start with no rounds</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} ({template.stageCount}{' '}
                {template.stageCount === 1 ? 'round' : 'rounds'})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="ownerId"
          label="Owner"
          errors={fieldErrors?.ownerId}
          hint="The recruiter accountable for moving this along."
        >
          <Select id="ownerId" name="ownerId" defaultValue="">
            <option value="">Unowned for now</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field id="source" label="Source" errors={fieldErrors?.source} hint="Referral, inbound, …">
          <Input id="source" name="source" autoComplete="off" />
        </Field>
      </div>

      <SubmitButton>Start application</SubmitButton>
    </form>
  );
}

export function ApplicationDetailsForm({
  application,
  jobRoles,
  owners,
}: {
  application: {
    id: string;
    jobRoleId: string | null;
    ownerId: string | null;
    source: string;
  };
  jobRoles: JobRoleOption[];
  owners: OptionRow[];
}) {
  const [state, setState] = useState<ActionResult<undefined> | null>(null);

  async function submit(formData: FormData): Promise<void> {
    setState(await updateApplicationAction(null, formData));
  }

  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={submit} className="space-y-4" noValidate>
      <input type="hidden" name="id" value={application.id} />
      <FormAlert state={state} success="Application updated." />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="detail-jobRoleId" label="Job role" errors={fieldErrors?.jobRoleId}>
          <Select id="detail-jobRoleId" name="jobRoleId" defaultValue={application.jobRoleId ?? ''}>
            <option value="">No role</option>
            {jobRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {jobRoleLabel(role)}
              </option>
            ))}
          </Select>
        </Field>

        <Field id="detail-ownerId" label="Owner" errors={fieldErrors?.ownerId}>
          <Select id="detail-ownerId" name="ownerId" defaultValue={application.ownerId ?? ''}>
            <option value="">Unowned</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field id="detail-source" label="Source" errors={fieldErrors?.source}>
        <Input id="detail-source" name="source" defaultValue={application.source} />
      </Field>

      <SubmitButton size="sm">Save changes</SubmitButton>
    </form>
  );
}

const STATUS_OPTIONS: ReadonlyArray<{ value: ApplicationStatus; label: string }> = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_HOLD', label: 'On hold' },
  { value: 'HIRED', label: 'Hired' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'WITHDRAWN', label: 'Withdrawn' },
];

/**
 * The only control that closes an application.
 *
 * Worth stating on the screen as well as in the code: recording an outcome on
 * a round does not do this. Somebody chooses it, here, on purpose.
 */
export function ApplicationStatusForm({
  applicationId,
  status,
}: {
  applicationId: string;
  status: ApplicationStatus;
}) {
  return (
    <ActionForm
      action={setApplicationStatusAction}
      success="Application status updated."
      className="space-y-2"
    >
      <input type="hidden" name="id" value={applicationId} />
      <Label htmlFor="application-status">Status</Label>
      <Select id="application-status" name="status" defaultValue={status}>
        {STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      <p className="text-muted-foreground text-[12px]">
        Closing stamps the closing date; reopening clears it. A round&rsquo;s outcome never changes
        this on its own.
      </p>
      <SubmitButton size="sm" variant="outline">
        Update status
      </SubmitButton>
    </ActionForm>
  );
}

export function ApplyTemplateForm({
  applicationId,
  templates,
}: {
  applicationId: string;
  templates: TemplateOption[];
}) {
  if (templates.length === 0) {
    return (
      <p className="text-muted-foreground text-[13px]">
        No pipeline templates yet — add one under Settings, or build the rounds by hand below.
      </p>
    );
  }

  return (
    <ActionForm
      action={applyTemplateAction}
      success="Pipeline applied."
      className="flex flex-wrap items-end gap-2"
    >
      <input type="hidden" name="applicationId" value={applicationId} />
      <div className="min-w-48 flex-1 space-y-1.5">
        <Label htmlFor="templateId">Pipeline template</Label>
        <Select id="templateId" name="templateId" required defaultValue="">
          <option value="" disabled>
            Choose a template…
          </option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} ({template.stageCount}{' '}
              {template.stageCount === 1 ? 'round' : 'rounds'})
            </option>
          ))}
        </Select>
      </div>
      <SubmitButton size="sm" variant="outline">
        Apply pipeline
      </SubmitButton>
    </ActionForm>
  );
}

export function ApplicationCommentForm({ applicationId }: { applicationId: string }) {
  const [state, setState] = useState<ActionResult<undefined> | null>(null);
  const [body, setBody] = useState('');

  async function submit(formData: FormData): Promise<void> {
    const result = await addApplicationCommentAction(null, formData);
    setState(result);
    if (result.ok) setBody('');
  }

  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={submit} className="space-y-2" noValidate>
      <HiddenFields fields={{ applicationId }} />
      <FormAlert state={state} />
      <Field id="comment-body" label="Add a note" errors={fieldErrors?.body}>
        <Textarea
          id="comment-body"
          name="body"
          rows={3}
          required
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Scheduling, availability, context the next person needs…"
        />
      </Field>
      <SubmitButton size="sm" variant="outline">
        Post note
      </SubmitButton>
    </form>
  );
}
