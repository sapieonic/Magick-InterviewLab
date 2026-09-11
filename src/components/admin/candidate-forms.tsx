'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, KeyRound, RefreshCw } from 'lucide-react';
import type { InterviewStatus } from '@/generated/prisma/enums';
import {
  createCandidateAction,
  resetCandidatePasswordAction,
  setCandidateActiveAction,
  updateCandidateAction,
  type CreatedCandidate,
} from '@/features/candidates/actions';
import { MIN_PASSWORD_LENGTH } from '@/features/auth/password-policy';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Field, FormAlert, SubmitButton } from '@/components/admin/form';
import { ActionForm, HiddenFields } from '@/components/admin/action-form';
import { ConfirmAction } from '@/components/admin/confirm-action';
import type { ActionResult } from '@/lib/action-result';

// Ambiguous glyphs removed: this string gets read aloud and typed by hand.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';

function pick(source: string, value: number): string {
  return source[value % source.length] ?? source[0] ?? 'x';
}

function generatePassword(): string {
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes.slice(0, 12), (b) => pick(ALPHABET, b)).join('');
  // The policy needs a letter and a digit; guaranteeing them beats retrying.
  return `${body}${pick(DIGITS, bytes[12] ?? 0)}${pick(DIGITS, bytes[13] ?? 0)}`;
}

async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success('Copied to clipboard');
  } catch {
    toast.error('Could not copy — select the text and copy manually.');
  }
}

/**
 * The one and only render of a plaintext password.
 *
 * It never comes back from the server: this is the string the browser itself
 * just submitted, held in component state and dropped on navigation. Nothing
 * persists it, and reloading the page loses it for good — which is the point.
 */
function RevealedPassword({ password, children }: { password: string; children: React.ReactNode }) {
  return (
    <Alert tone="success" title="Share this password now — it will not be shown again">
      <div className="mt-1.5 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="bg-background rounded border px-2 py-1 font-mono text-[13px] break-all">
            {password}
          </code>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void copyToClipboard(password)}
          >
            <Copy className="size-3.5" aria-hidden />
            Copy
          </Button>
        </div>
        <div className="text-[12px]">{children}</div>
      </div>
    </Alert>
  );
}

function TemporaryPasswordField({
  value,
  onChange,
  errors,
  id = 'temporaryPassword',
}: {
  value: string;
  onChange: (value: string) => void;
  errors?: string[];
  id?: string;
}) {
  return (
    <Field
      id={id}
      label="Temporary password"
      errors={errors}
      hint={`At least ${MIN_PASSWORD_LENGTH} characters with a letter and a digit. The candidate must change it at first sign-in.`}
    >
      <div className="flex gap-2">
        <Input
          id={id}
          name="temporaryPassword"
          type="text"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          required
          value={value}
          aria-invalid={!!errors?.length}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          onClick={() => onChange(generatePassword())}
        >
          <RefreshCw className="size-3.5" aria-hidden />
          Generate
        </Button>
      </div>
    </Field>
  );
}

/**
 * What the admin is told about the invitation.
 *
 * `failed` is not an error banner: the candidate exists and the password is
 * on screen, so the outcome is "you are handing this over yourself", which is
 * a warning about the next step rather than a report that something broke.
 *
 * The status type is read off the action's result rather than imported from
 * the (server-only) email module — nothing here needs that module, and a
 * type-only import is an easy thing for a later edit to turn into a value one.
 */
function WelcomeEmailNote({
  status,
  email,
}: {
  status: CreatedCandidate['emailStatus'];
  email: string;
}) {
  switch (status) {
    case 'sent':
      return (
        <Alert tone="success">
          The sign-in details were emailed to <strong>{email}</strong>.
        </Alert>
      );
    case 'sandboxed':
      return (
        <Alert tone="info">
          Mailjet accepted the email in sandbox mode, so nothing was delivered to{' '}
          <strong>{email}</strong>. Share the password yourself, or unset{' '}
          <code>MAILJET_SANDBOX</code> to send for real.
        </Alert>
      );
    case 'failed':
      return (
        <Alert tone="warning" title="The invitation email could not be sent">
          The account was created — only the email failed. Share the password below yourself; the
          server log has the reason.
        </Alert>
      );
    case 'not_requested':
    case 'not_configured':
      return null;
  }
}

export function CandidateCreateForm({
  interviews,
  emailEnabled,
}: {
  interviews: Array<{ id: string; title: string; status: InterviewStatus }>;
  /** False when the deployment has no Mailjet credentials: offering a
   *  checkbox that cannot send anything is worse than not offering one. */
  emailEnabled: boolean;
}) {
  const [state, setState] = useState<ActionResult<CreatedCandidate> | null>(null);
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);

  async function submit(formData: FormData): Promise<void> {
    const result = await createCandidateAction(null, formData);
    setState(result);
    if (result.ok) {
      setRevealed(password);
      setPassword('');
    }
  }

  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;
  const created = state?.ok ? state.data : null;

  if (created && revealed) {
    return (
      <div className="space-y-4">
        <WelcomeEmailNote status={created.emailStatus} email={created.email} />
        <RevealedPassword password={revealed}>
          <p>
            {created.name} ({created.email}) can sign in now and will be asked to choose their own
            password immediately.
          </p>
        </RevealedPassword>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href={`/admin/candidates/${created.id}`}>Open candidate</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/candidates">Back to candidates</Link>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setState(null);
              setRevealed(null);
            }}
          >
            Add another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form action={submit} className="space-y-4" noValidate>
      <FormAlert state={state} />

      <Field id="name" label="Name" errors={fieldErrors?.name}>
        <Input
          id="name"
          name="name"
          autoComplete="off"
          required
          autoFocus
          aria-invalid={!!fieldErrors?.name?.length}
        />
      </Field>

      <Field id="email" label="Email" errors={fieldErrors?.email}>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="off"
          required
          aria-invalid={!!fieldErrors?.email?.length}
        />
      </Field>

      <TemporaryPasswordField
        value={password}
        onChange={setPassword}
        errors={fieldErrors?.temporaryPassword}
      />

      <Field
        id="interviewId"
        label="Assign interview (optional)"
        errors={fieldErrors?.interviewId}
        hint="You can assign more interviews later from the candidate's page."
      >
        <Select id="interviewId" name="interviewId" defaultValue="">
          <option value="">No interview yet</option>
          {interviews.map((interview) => (
            <option key={interview.id} value={interview.id}>
              {interview.title}
              {interview.status === 'DRAFT' ? ' (draft)' : ''}
            </option>
          ))}
        </Select>
      </Field>

      {emailEnabled ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            {/* An unchecked box submits no field at all, which the server
                reads as false — so the value only ever travels when ticked. */}
            <Checkbox id="sendWelcomeEmail" name="sendWelcomeEmail" value="true" defaultChecked />
            <Label htmlFor="sendWelcomeEmail" className="cursor-pointer font-normal">
              Email the sign-in details to the candidate
            </Label>
          </div>
          <p className="text-muted-foreground text-[12px]">
            Sends the temporary password to their inbox. They must still replace it at first
            sign-in, and it is shown here either way.
          </p>
        </div>
      ) : null}

      <div className="flex gap-2 pt-1">
        <SubmitButton>Create candidate</SubmitButton>
        <Button asChild variant="ghost">
          <Link href="/admin/candidates">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

export function CandidateProfileForm({
  candidate,
}: {
  candidate: { id: string; name: string; email: string };
}) {
  const [state, setState] = useState<ActionResult<undefined> | null>(null);

  async function submit(formData: FormData): Promise<void> {
    setState(await updateCandidateAction(null, formData));
  }

  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={submit} className="space-y-4" noValidate>
      <input type="hidden" name="id" value={candidate.id} />
      <FormAlert state={state} success="Profile updated." />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="candidate-name" label="Name" errors={fieldErrors?.name}>
          <Input
            id="candidate-name"
            name="name"
            defaultValue={candidate.name}
            required
            aria-invalid={!!fieldErrors?.name?.length}
          />
        </Field>
        <Field id="candidate-email" label="Email" errors={fieldErrors?.email}>
          <Input
            id="candidate-email"
            name="email"
            type="email"
            defaultValue={candidate.email}
            required
            aria-invalid={!!fieldErrors?.email?.length}
          />
        </Field>
      </div>

      <SubmitButton size="sm">Save changes</SubmitButton>
    </form>
  );
}

export function CandidatePasswordResetForm({ candidateId }: { candidateId: string }) {
  const [state, setState] = useState<ActionResult<undefined> | null>(null);
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);

  async function submit(formData: FormData): Promise<void> {
    const result = await resetCandidatePasswordAction(null, formData);
    setState(result);
    if (result.ok) {
      setRevealed(password);
      setPassword('');
    }
  }

  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={submit} className="space-y-4" noValidate>
      <input type="hidden" name="id" value={candidateId} />

      {revealed ? (
        <RevealedPassword password={revealed}>
          <p>
            Every existing session for this candidate has been signed out. They will be asked to
            choose a new password at their next sign-in.
          </p>
        </RevealedPassword>
      ) : (
        <FormAlert state={state} />
      )}

      <TemporaryPasswordField
        id="reset-password"
        value={password}
        onChange={setPassword}
        errors={fieldErrors?.temporaryPassword}
      />

      <SubmitButton size="sm" variant="outline">
        <KeyRound className="size-3.5" aria-hidden />
        Reset password
      </SubmitButton>
    </form>
  );
}

export function CandidateStatusForm({
  candidateId,
  isActive,
}: {
  candidateId: string;
  isActive: boolean;
}) {
  if (!isActive) {
    return (
      <ActionForm action={setCandidateActiveAction} success="Candidate reactivated.">
        <HiddenFields fields={{ id: candidateId, isActive: 'true' }} />
        <SubmitButton size="sm" variant="outline">
          Reactivate candidate
        </SubmitButton>
      </ActionForm>
    );
  }

  return (
    <ConfirmAction
      action={setCandidateActiveAction}
      fields={{ id: candidateId, isActive: 'false' }}
      title="Deactivate this candidate?"
      description={
        <>
          <p>
            They will be signed out immediately and will not be able to sign in again until you
            reactivate them.
          </p>
          <p>Their submissions and assignments are kept.</p>
        </>
      }
      confirmLabel="Deactivate"
      triggerLabel="Deactivate candidate"
      success="Candidate deactivated and signed out."
    />
  );
}
