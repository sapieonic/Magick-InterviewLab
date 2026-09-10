import { AuthenticationError, AuthorizationError } from '@/features/auth/guards';
import { type ActionResult, fail } from './action-result';
import { z } from 'zod';

/** Thrown by services for expected, user-facing failures. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Resource') {
    super(`${what} not found.`);
    this.name = 'NotFoundError';
  }
}

const PRISMA_UNIQUE = 'P2002';
const PRISMA_MISSING = 'P2025';

function prismaCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/**
 * Wrap a Server Action body. Expected failures become `{ ok: false }`;
 * anything else is logged with its stack and reported as a generic message so
 * an internal detail never reaches the browser.
 */
export async function actionGuard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AuthenticationError) return fail(error.message);
    if (error instanceof AuthorizationError) return fail(error.message);
    if (error instanceof AppError) return fail(error.message, error.fieldErrors);
    if (error instanceof z.ZodError) {
      return fail('Please correct the highlighted fields.', flattenZod(error));
    }
    const code = prismaCode(error);
    if (code === PRISMA_UNIQUE) return fail('That value is already taken.');
    if (code === PRISMA_MISSING) return fail('That record no longer exists.');

    // `redirect()` and `notFound()` signal control flow by throwing; re-throw.
    if (isNextControlFlow(error)) throw error;

    console.error('[action] unexpected failure', error);
    return fail('Something went wrong. Please try again.');
  }
}

function isNextControlFlow(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest: unknown }).digest === 'string' &&
    /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK)/.test(
      (error as { digest: string }).digest,
    )
  );
}

export function flattenZod(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
