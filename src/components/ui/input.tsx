import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  function Input({ className, type, ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          'border-input bg-background placeholder:text-muted-foreground/70 flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs transition-colors',
          'focus-visible:outline-ring file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-2 focus-visible:outline-offset-[-1px]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-invalid:border-destructive aria-invalid:outline-destructive',
          className,
        )}
        {...props}
      />
    );
  },
);
