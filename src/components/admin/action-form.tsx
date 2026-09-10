'use client';

import { toast } from 'sonner';
import type { ActionResult } from '@/lib/action-result';

export type SimpleAction = (
  prev: ActionResult<undefined> | null,
  formData: FormData,
) => Promise<ActionResult<undefined>>;

/**
 * A form for a single-button mutation (assign, remove, archive).
 *
 * These sit inside table rows, where an inline error banner would shove the
 * layout around, so the outcome is reported by toast instead. Forms that a
 * user actually fills in report errors next to the field, not here.
 *
 * The action is a plain async function rather than `useActionState`: React
 * runs it inside a transition, so `useFormStatus` still reports pending and
 * the result can be handled where it arrives instead of in an effect.
 */
export function ActionForm({
  action,
  children,
  className,
  success,
}: {
  action: SimpleAction;
  children: React.ReactNode;
  className?: string;
  success?: string;
}) {
  async function submit(formData: FormData): Promise<void> {
    const result = await action(null, formData);
    if (result.ok) {
      if (success) toast.success(success);
    } else {
      toast.error(result.error);
    }
  }

  return (
    <form action={submit} className={className}>
      {children}
    </form>
  );
}

/** Hidden inputs from a plain object — keeps call sites free of boilerplate. */
export function HiddenFields({ fields }: { fields: Record<string, string> }) {
  return (
    <>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}
