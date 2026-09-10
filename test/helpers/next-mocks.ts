/**
 * Minimal stand-ins for the `next/headers` request-scoped stores.
 *
 * The real ones only exist inside a request, so anything that calls
 * `cookies()` or `headers()` is untestable without them. These implement just
 * the surface the app uses, and additionally *record* what was written so a
 * test can assert on cookie attributes (httpOnly, sameSite, secure) rather
 * than only on the value.
 */

export interface CookieSetOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none' | boolean;
  path?: string;
  domain?: string;
  expires?: Date;
  maxAge?: number;
}

export interface RecordedCookie {
  name: string;
  value: string;
  options: CookieSetOptions;
}

export interface FakeCookieStore {
  get(name: string): { name: string; value: string } | undefined;
  set(name: string, value: string, options?: CookieSetOptions): void;
  delete(name: string): void;
  has(name: string): boolean;
  /** Every `set` in order — the last one wins for `get`. */
  readonly sets: RecordedCookie[];
  /** Names passed to `delete`, in order. */
  readonly deletes: string[];
  /** Seed a cookie as if the browser had sent it, without recording a `set`. */
  seed(name: string, value: string): void;
  reset(): void;
}

export function createCookieStore(initial: Record<string, string> = {}): FakeCookieStore {
  let jar = new Map<string, string>(Object.entries(initial));
  const sets: RecordedCookie[] = [];
  const deletes: string[] = [];

  return {
    sets,
    deletes,
    get(name) {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set(name, value, options = {}) {
      jar.set(name, value);
      sets.push({ name, value, options });
    },
    delete(name) {
      jar.delete(name);
      deletes.push(name);
    },
    has(name) {
      return jar.has(name);
    },
    seed(name, value) {
      jar.set(name, value);
    },
    reset() {
      jar = new Map();
      sets.length = 0;
      deletes.length = 0;
    },
  };
}

export interface FakeHeaderStore {
  get(name: string): string | null;
  set(name: string, value: string): void;
  reset(): void;
}

/** Header lookups in Next are case-insensitive; mirror that. */
export function createHeaderStore(initial: Record<string, string> = {}): FakeHeaderStore {
  let map = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get(name) {
      return map.get(name.toLowerCase()) ?? null;
    },
    set(name, value) {
      map.set(name.toLowerCase(), value);
    },
    reset() {
      map = new Map();
    },
  };
}

/**
 * `redirect()` signals control flow by throwing an error carrying a
 * `NEXT_REDIRECT` digest, and `src/lib/errors.ts` re-throws anything shaped
 * like that instead of converting it to a failed ActionResult. A mock that
 * throws a plain Error would be swallowed as an unexpected failure, so the
 * digest has to be present for the test to exercise the real path.
 */
export class MockRedirectError extends Error {
  readonly digest: string;

  constructor(readonly url: string) {
    super(`NEXT_REDIRECT: ${url}`);
    this.name = 'MockRedirectError';
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

export function mockRedirect(url: string): never {
  throw new MockRedirectError(url);
}

/** Pull the destination out of a thrown redirect, or fail loudly. */
export function redirectTarget(error: unknown): string {
  if (error instanceof MockRedirectError) return error.url;
  throw error;
}
