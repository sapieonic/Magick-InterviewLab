import * as React from 'react';
import { cn } from '@/lib/utils';

export const Checkbox = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  function Checkbox({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          'border-input accent-primary size-4 shrink-0 cursor-pointer rounded border',
          className,
        )}
        {...props}
      />
    );
  },
);
