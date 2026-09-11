import * as React from 'react';
import { cn } from '@/lib/utils';

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      />
    </div>
  );
}
export function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead className={cn('[&_tr]:border-b', className)} {...props} />;
}
export function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}
/** Forwards its ref: the review queue moves keyboard focus row to row. */
export const TableRow = React.forwardRef<HTMLTableRowElement, React.ComponentProps<'tr'>>(
  function TableRow({ className, ...props }, ref) {
    return (
      <tr
        ref={ref}
        className={cn('hover:bg-muted/40 border-b transition-colors', className)}
        {...props}
      />
    );
  },
);
export function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'text-muted-foreground h-9 px-3 text-left text-[12px] font-medium tracking-wide whitespace-nowrap uppercase',
        className,
      )}
      {...props}
    />
  );
}
export function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />;
}
