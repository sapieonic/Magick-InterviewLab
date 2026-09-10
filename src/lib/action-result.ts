/**
 * Uniform Server Action return shape.
 *
 * Actions never throw across the RSC boundary for *expected* failures — a
 * thrown error in production is redacted to "An error occurred in the Server
 * Components render", which is useless to a user. So expected failures come
 * back as data and unexpected ones are logged server-side and reported
 * generically.
 */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export function ok(): ActionResult<undefined>;
export function ok<T>(data: T): ActionResult<T>;
export function ok<T>(data?: T): ActionResult<T | undefined> {
  return { ok: true, data };
}

export function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

export const IDLE: ActionResult<never> | null = null;
