'use client';

import { useActionState, useEffect, useRef } from 'react';
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
 */
export function ActionForm({
  action,
  children,
  className,
  success,
  onSuccess,
}: {
  action: SimpleAction;
  children: React.ReactNode;
  className?: string;
  success?: string;
  onSuccess?: () => void;
}) {
  const [state, formAction] = useActionState(action, null);
  // `useActionState` hands back a fresh object per dispatch, so identity is
  // enough to tell "new result" from "re-render".
  const reported = useRef<ActionResult<undefined> | null>(null);

  useEffect(() => {
    if (!state || state === reported.current) return;
    reported.current = state;
    if (state.ok) {
      if (success) toast.success(success);
      onSuccess?.();
    } else {
      toast.error(state.error);
    }
  }, [state, success, onSuccess]);

  return (
    <form action={formAction} className={className}>
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
