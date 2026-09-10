'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Wordmark } from '@/components/brand';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The user gets a generic message; the detail belongs in the logs.
    console.error('[ui] unhandled error', error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6">
      <Wordmark />
      <Alert tone="error" title="Something went wrong" className="max-w-md">
        An unexpected error occurred. Try again — if it keeps happening, contact your
        administrator{error.digest ? ` and quote reference ${error.digest}` : ''}.
      </Alert>
      <Button size="sm" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
