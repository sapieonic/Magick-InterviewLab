import 'server-only';
import { redirect } from 'next/navigation';
import { getCurrentUser, type SessionUser } from './session';

/**
 * Authorization is enforced here, on the server, for every protected page and
 * every mutation. Hiding a nav link is presentation, never a control.
 */

export class AuthorizationError extends Error {
  constructor(message = 'You do not have permission to perform this action.') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class AuthenticationError extends Error {
  constructor(message = 'Your session has expired. Please sign in again.') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class PasswordChangeRequiredError extends Error {
  constructor(message = 'You must change your password before continuing.') {
    super(message);
    this.name = 'PasswordChangeRequiredError';
  }
}

/**
 * For Server Actions / route handlers: throws rather than redirecting.
 *
 * Deliberately does NOT enforce `mustChangePassword` — `changePasswordAction`
 * and `logoutAction` are exactly the two actions a user with a temporary
 * password must still be able to reach, and both go through here.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthenticationError();
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== 'ADMIN') throw new AuthorizationError();
  // A temporary password must be rotated before any admin mutation: the
  // page-level guard sends admins to /change-password, but a Server Action is
  // a public endpoint reachable without ever loading a page.
  if (user.mustChangePassword) throw new PasswordChangeRequiredError();
  return user;
}

export async function requireCandidate(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== 'CANDIDATE') throw new AuthorizationError();
  // Same reasoning as requireAdmin: block draft-save / submit until the
  // admin-chosen temporary password has been changed.
  if (user.mustChangePassword) throw new PasswordChangeRequiredError();
  return user;
}

/** For pages: redirects to the right place instead of throwing. */
export async function requireAdminPage(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/admin');
  if (user.role !== 'ADMIN') redirect('/interview');
  // A seeded admin is created with a temporary password; force the rotation
  // before the console is usable, exactly as requireCandidatePage does.
  if (user.mustChangePassword) redirect('/change-password');
  return user;
}

export async function requireCandidatePage(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/interview');
  if (user.role !== 'CANDIDATE') redirect('/admin');
  if (user.mustChangePassword) redirect('/change-password');
  return user;
}

export function homePathFor(user: Pick<SessionUser, 'role' | 'mustChangePassword'>): string {
  if (user.mustChangePassword) return '/change-password';
  return user.role === 'ADMIN' ? '/admin' : '/interview';
}
