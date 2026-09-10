import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/features/auth/session';
import { homePathFor } from '@/features/auth/guards';
import { PoweredBy, MagicVoiceLogo } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';
import { publicEnv } from '@/lib/env';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect(homePathFor(user));
  const { next } = await searchParams;

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-5 py-12">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-[22rem]">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <MagicVoiceLogo className="h-9 w-9" />
          <div className="space-y-1">
            <h1 className="text-lg font-semibold tracking-tight">
              {publicEnv.appName}{' '}
              <span className="text-muted-foreground font-medium">InterviewLab</span>
            </h1>
            <p className="text-muted-foreground text-[13px]">
              Sign in to continue to your workspace.
            </p>
          </div>
        </div>

        <LoginForm next={next} />

        <PoweredBy className="mt-8 text-center" />
      </div>
    </main>
  );
}
