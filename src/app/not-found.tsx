import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Wordmark, PoweredBy } from '@/components/brand';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <Wordmark />
      <div className="space-y-1">
        <p className="text-2xl font-semibold tracking-tight">Page not found</p>
        <p className="text-muted-foreground text-sm">
          The page you are looking for does not exist or you no longer have access to it.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/">Back to safety</Link>
      </Button>
      <PoweredBy className="mt-6" />
    </main>
  );
}
