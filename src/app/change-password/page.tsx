import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/features/auth/session';
import { MagicVoiceLogo, PoweredBy } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';
import { ChangePasswordForm } from './change-password-form';

export const metadata: Metadata = { title: 'Change password' };
export const dynamic = 'force-dynamic';

export default async function ChangePasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/change-password');

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-5 py-12">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[24rem]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <MagicVoiceLogo className="h-8 w-8" />
          <div className="space-y-1">
            <h1 className="text-lg font-semibold tracking-tight">
              {user.mustChangePassword ? 'Set a new password' : 'Change your password'}
            </h1>
            <p className="text-muted-foreground text-[13px]">
              {user.mustChangePassword
                ? 'Your account uses a temporary password. Choose your own to continue.'
                : 'Signed in as ' + user.email}
            </p>
          </div>
        </div>

        <ChangePasswordForm forced={user.mustChangePassword} />
        <PoweredBy className="mt-8 text-center" />
      </div>
    </main>
  );
}
