'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { changePasswordAction } from '@/features/auth/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { MIN_PASSWORD_LENGTH } from '@/features/auth/password-policy';

function Field({
  id,
  label,
  errors,
  ...props
}: React.ComponentProps<typeof Input> & { id: string; label: string; errors?: string[] }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} type="password" aria-invalid={!!errors?.length} {...props} />
      {errors?.map((e) => (
        <p key={e} className="text-destructive text-[12px]">
          {e}
        </p>
      ))}
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" loading={pending}>
      Update password
    </Button>
  );
}

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const [state, formAction] = useActionState(changePasswordAction, null);
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <Card>
      <CardContent className="pt-5">
        <form action={formAction} className="space-y-4" noValidate>
          {state && !state.ok && !state.fieldErrors ? (
            <Alert tone="error">{state.error}</Alert>
          ) : null}

          <Field
            id="currentPassword"
            label="Current password"
            autoComplete="current-password"
            required
            autoFocus
            errors={fieldErrors?.currentPassword}
          />
          <Field
            id="newPassword"
            label="New password"
            autoComplete="new-password"
            required
            errors={fieldErrors?.newPassword}
          />
          <Field
            id="confirmPassword"
            label="Confirm new password"
            autoComplete="new-password"
            required
            errors={fieldErrors?.confirmPassword}
          />

          <p className="text-muted-foreground text-[12px]">
            At least {MIN_PASSWORD_LENGTH} characters, including a letter and a digit.
          </p>

          <SubmitButton />

          {!forced ? (
            <Button asChild variant="ghost" size="sm" className="w-full">
              <Link href="/">Cancel</Link>
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
