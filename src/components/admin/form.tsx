'use client';

import { useFormStatus } from 'react-dom';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import type { ActionResult } from '@/lib/action-result';
import { cn } from '@/lib/utils';

/** Pending state comes from the enclosing <form>, so this must be its own
 *  component — `useFormStatus` reads the parent form, not the caller's. */
export function SubmitButton({ children, ...props }: ButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} {...props}>
      {children}
    </Button>
  );
}

export function FieldErrors({ errors, id }: { errors?: string[]; id?: string }) {
  if (!errors?.length) return null;
  return (
    <div id={id} className="space-y-0.5">
      {errors.map((e) => (
        <p key={e} className="text-destructive text-[12px]">
          {e}
        </p>
      ))}
    </div>
  );
}

/**
 * Top-of-form banner. Field-level messages render next to their input, so a
 * result that carries only field errors must not also shout a generic line.
 */
export function FormAlert<T>({ state, success }: { state: ActionResult<T> | null; success?: string }) {
  if (!state) return null;
  if (state.ok) return success ? <Alert tone="success">{success}</Alert> : null;
  if (state.fieldErrors && Object.keys(state.fieldErrors).length > 0) return null;
  return <Alert tone="error">{state.error}</Alert>;
}

export function Field({
  id,
  label,
  hint,
  errors,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  errors?: string[];
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-[12px]">{hint}</p> : null}
      <FieldErrors errors={errors} id={`${id}-error`} />
    </div>
  );
}
