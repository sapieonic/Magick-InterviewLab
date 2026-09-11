'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import type { Capability } from '@/features/auth/capabilities';

interface NavLink {
  href: string;
  label: string;
  /** `/admin` prefix-matches every other section, so it must match exactly. */
  exact: boolean;
  /** Omitted means every staff member sees it. Hiding a link is presentation
   *  only — the page behind it guards the same capability server-side. */
  capability?: Capability;
}

const LINKS: readonly NavLink[] = [
  { href: '/admin', label: 'Dashboard', exact: true },
  { href: '/admin/pipeline', label: 'Pipeline', exact: false },
  // Between the board and the panel's own queue, because that is where it sits
  // in the day: the board is what is running, Review is what has finished and
  // is waiting on a person.
  {
    href: '/admin/review',
    label: 'Review',
    exact: false,
    capability: 'VIEW_ALL_APPLICATIONS',
  },
  { href: '/admin/feedback', label: 'My feedback', exact: false, capability: 'GIVE_FEEDBACK' },
  { href: '/admin/candidates', label: 'Candidates', exact: false, capability: 'MANAGE_USERS' },
  { href: '/admin/interviews', label: 'Interviews', exact: false, capability: 'MANAGE_CONTENT' },
  { href: '/admin/questions', label: 'Questions', exact: false, capability: 'MANAGE_CONTENT' },
  { href: '/admin/rubrics', label: 'Rubrics', exact: false, capability: 'MANAGE_CONTENT' },
  {
    href: '/admin/submissions',
    label: 'Submissions',
    exact: false,
    capability: 'VIEW_ALL_APPLICATIONS',
  },
  // Job roles, pipeline templates and staff accounts. The page itself gates
  // each section separately, so the link only needs the weaker of the two
  // capabilities that unlock anything there.
  { href: '/admin/settings', label: 'Settings', exact: false, capability: 'MANAGE_CONTENT' },
];

export function AdminNav({
  className,
  capabilities,
}: {
  className?: string;
  capabilities: readonly Capability[];
}) {
  const pathname = usePathname();
  const visible = LINKS.filter((l) => !l.capability || capabilities.includes(l.capability));

  return (
    <nav
      aria-label="Primary"
      className={cn('flex scrollbar-thin items-center gap-0.5 overflow-x-auto', className)}
    >
      {visible.map((link) => {
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
