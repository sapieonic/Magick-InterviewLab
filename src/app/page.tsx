import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/features/auth/session';
import { homePathFor } from '@/features/auth/guards';

export const dynamic = 'force-dynamic';

/** The root is a router, not a page: everyone belongs somewhere specific. */
export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? homePathFor(user) : '/login');
}
