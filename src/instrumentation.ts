import type { ServerEnv } from '@/lib/env.server';

/**
 * Next.js boot hook. Runs once, before the first request is served.
 *
 * Its only job is to force the server environment to be parsed *now*. The
 * schema is fail-fast by design, but `serverEnv()` is memoised and called
 * lazily, so without this the first thing to read config is a request — and a
 * bad variable becomes a 500 on some page rather than a refusal to start. On
 * a Node host or Vercel that reads as a deploy that succeeded and then serves
 * errors; under Docker the container goes unhealthy but `restart:
 * unless-stopped` does not restart it.
 *
 * Guarded on the runtime because this hook also runs in the Edge runtime,
 * where `server-only` modules and `process.env` are not the same thing.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { serverEnv } = (await import('@/lib/env.server')) as { serverEnv: () => ServerEnv };
  serverEnv();
}
