import { LogOut } from 'lucide-react';
import { requireCandidatePage } from '@/features/auth/guards';
import { logoutAction } from '@/features/auth/actions';
import { Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

/**
 * The candidate shell. The guard runs here as well as in each page — a layout
 * is not a security boundary on its own (Next may reuse it across a client
 * navigation), but doing it here keeps the header from rendering for someone
 * who is about to be redirected anyway.
 *
 * `h-dvh` + `overflow-hidden` rather than `min-h-dvh`: the workspace is a
 * fixed-height, internally-scrolling app view, and it needs a parent with a
 * real height to size its panes against.
 */
export default async function InterviewLayout({ children }: { children: React.ReactNode }) {
  const user = await requireCandidatePage();

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <Wordmark />
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground hidden max-w-48 truncate text-[13px] sm:inline">
            {user.name}
          </span>
          <ThemeToggle />
          <form action={logoutAction}>
            <Button type="submit" variant="ghost" size="sm" title="Sign out">
              <LogOut className="size-4" aria-hidden />
              <span className="sr-only sm:not-sr-only">Sign out</span>
            </Button>
          </form>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
