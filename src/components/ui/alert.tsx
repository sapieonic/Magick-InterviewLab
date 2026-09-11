import * as React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'info' | 'error' | 'success' | 'warning';

const tones: Record<Tone, { cls: string; iconCls?: string; Icon: typeof Info }> = {
  info: { cls: 'border-border bg-muted/50 text-foreground', Icon: Info },
  error: { cls: 'border-destructive/30 bg-destructive/8 text-destructive', Icon: AlertCircle },
  success: { cls: 'border-success/30 bg-success/8 text-success', Icon: CheckCircle2 },
  // For an outcome that is not what was asked for but is not a failure of
  // the operation either — the caller still has something to do.
  //
  // The amber is carried by the border and the icon, NOT the body text:
  // `--warning` on its own tint computes to about 2.4:1, and `Alert` then
  // applies `opacity-90` on top — well under the 4.5:1 AA needs at 13px, on
  // the one tone reserved for messages the reader must not skim past.
  warning: {
    cls: 'border-warning/30 bg-warning/8 text-foreground',
    iconCls: 'text-warning',
    Icon: AlertTriangle,
  },
};

export function Alert({
  tone = 'info',
  title,
  children,
  className,
  ...props
}: React.ComponentProps<'div'> & { tone?: Tone; title?: string }) {
  const { cls, iconCls, Icon } = tones[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex gap-2.5 rounded-md border px-3 py-2.5 text-[13px]', cls, className)}
      {...props}
    >
      <Icon className={cn('mt-px size-4 shrink-0', iconCls)} aria-hidden />
      <div className="min-w-0 space-y-0.5">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="opacity-90">{children}</div> : null}
      </div>
    </div>
  );
}
