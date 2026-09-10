import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  backHref,
  backLabel,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn('mb-6 space-y-2', className)}>
      {backHref ? (
        <Link
          href={backHref}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[13px] transition-colors"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          {backLabel ?? 'Back'}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <div className="text-muted-foreground text-[13px]">{description}</div>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** A titled block inside a detail page. Lighter than a Card, same rhythm. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('bg-card rounded-lg border shadow-xs', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description ? (
            <p className="text-muted-foreground text-[12px]">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}
