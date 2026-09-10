import * as React from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'info' | 'error' | 'success';

const tones: Record<Tone, { cls: string; Icon: typeof Info }> = {
  info: { cls: 'border-border bg-muted/50 text-foreground', Icon: Info },
  error: { cls: 'border-destructive/30 bg-destructive/8 text-destructive', Icon: AlertCircle },
  success: { cls: 'border-success/30 bg-success/8 text-success', Icon: CheckCircle2 },
};

export function Alert({
  tone = 'info',
  title,
  children,
  className,
  ...props
}: React.ComponentProps<'div'> & { tone?: Tone; title?: string }) {
  const { cls, Icon } = tones[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex gap-2.5 rounded-md border px-3 py-2.5 text-[13px]', cls, className)}
      {...props}
    >
      <Icon className="mt-px size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="opacity-90">{children}</div> : null}
      </div>
    </div>
  );
}
