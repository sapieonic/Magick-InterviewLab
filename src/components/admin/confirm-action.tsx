'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { SubmitButton } from '@/components/admin/form';
import { HiddenFields, type SimpleAction } from '@/components/admin/action-form';
import type { ActionResult } from '@/lib/action-result';

/**
 * Destructive mutations behind a confirmation. The dialog owns the form so
 * the pending spinner lands on the confirm button, and it only closes once
 * the action has actually reported success — closing on click would hide a
 * failure the admin needs to see.
 */
export function ConfirmAction({
  action,
  fields,
  title,
  description,
  confirmLabel,
  triggerLabel,
  triggerIcon,
  triggerVariant = 'outline',
  triggerSize = 'sm',
  confirmVariant = 'destructive',
  success,
  disabled,
  className,
}: {
  action: SimpleAction;
  fields: Record<string, string>;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  triggerLabel: string;
  triggerIcon?: React.ReactNode;
  triggerVariant?: ButtonProps['variant'];
  triggerSize?: ButtonProps['size'];
  confirmVariant?: ButtonProps['variant'];
  success?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, null);
  const reported = useRef<ActionResult<undefined> | null>(null);

  useEffect(() => {
    if (!state || state === reported.current) return;
    reported.current = state;
    if (state.ok) {
      setOpen(false);
      if (success) toast.success(success);
    } else {
      toast.error(state.error);
    }
  }, [state, success]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          disabled={disabled}
          className={className}
        >
          {triggerIcon}
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">{description}</div>
          </DialogDescription>
        </DialogHeader>
        <form action={formAction}>
          <HiddenFields fields={fields} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton variant={confirmVariant} size="sm">
              {confirmLabel}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
