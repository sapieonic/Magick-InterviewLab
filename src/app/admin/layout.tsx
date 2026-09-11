import Link from 'next/link';
import { LogOut } from 'lucide-react';
import { requireStaffPage } from '@/features/auth/guards';
import { logoutAction } from '@/features/auth/actions';
import { PoweredBy, Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';
import { AdminNav } from '@/components/admin/admin-nav';
import { capabilitiesOf, roleLabel } from '@/features/auth/capabilities';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireStaffPage();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-background/85 sticky top-0 z-30 border-b backdrop-blur">
        {/* One flex row that wraps: below ~md the nav takes a full-width
            second line instead of being squeezed against the user block. */}
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
          <Link
            href="/admin"
            className="order-1 rounded focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            <Wordmark subtitle="InterviewLab" />
          </Link>

          <AdminNav
            className="order-3 -mx-1 w-full pb-1 md:order-2 md:mx-0 md:w-auto md:pb-0"
            capabilities={capabilitiesOf(viewer.role)}
          />

          <div className="order-2 ml-auto flex items-center gap-2 md:order-3">
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-[13px] font-medium">{viewer.name}</p>
              <p className="text-muted-foreground text-[11px]">{roleLabel(viewer.role)}</p>
            </div>
            <ThemeToggle />
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" size="sm" className="gap-1.5">
                <LogOut className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">Sign out</span>
                <span className="sr-only sm:hidden">Sign out</span>
              </Button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>

      <footer className="mx-auto w-full max-w-[1440px] px-4 pb-6 sm:px-6">
        <PoweredBy />
      </footer>
    </div>
  );
}
