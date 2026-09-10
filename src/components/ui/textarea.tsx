import * as React from 'react';
import { cn } from '@/lib/utils';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'border-input bg-background placeholder:text-muted-foreground/70 flex min-h-20 w-full rounded-md border px-3 py-2 text-sm shadow-xs transition-colors',
          'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-[-1px]',
          'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
          className,
        )}
        {...props}
      />
    );
  },
);
