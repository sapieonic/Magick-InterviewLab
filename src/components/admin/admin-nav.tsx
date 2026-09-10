'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

interface NavLink {
  href: string;
  label: string;
  /** `/admin` prefix-matches every other section, so it must match exactly. */
  exact: boolean;
}

const LINKS: readonly NavLink[] = [
  { href: '/admin', label: 'Dashboard', exact: true },
  { href: '/admin/candidates', label: 'Candidates', exact: false },
  { href: '/admin/interviews', label: 'Interviews', exact: false },
  { href: '/admin/questions', label: 'Questions', exact: false },
  { href: '/admin/submissions', label: 'Submissions', exact: false },
];

export function AdminNav({ className }: { className?: string }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className={cn('scrollbar-thin flex items-center gap-0.5 overflow-x-auto', className)}
    >
      {LINKS.map((link) => {
        const active = link.exact
          ? pathname === link.href
          : pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors',
              active
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/60',
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
