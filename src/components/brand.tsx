import { cn } from '@/lib/utils';
import { publicEnv } from '@/lib/env';

/**
 * The MagicVoice mark. Inline SVG rather than <img> so it inherits colour
 * transitions and never flashes on navigation.
 */
export function MagicVoiceLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('h-6 w-6 shrink-0', className)}
      role="img"
      aria-label="MagicVoice"
      fill="none"
    >
      <rect width="32" height="32" rx="8" fill="url(#mv-grad)" />
      <g stroke="#fff" strokeWidth="2.1" strokeLinecap="round">
        <path d="M9 13v6" />
        <path d="M13 9.5v13" />
        <path d="M17 12v8" />
        <path d="M21 14.5v3" />
      </g>
      <circle cx="24.2" cy="8.6" r="1.7" fill="#fff" fillOpacity="0.92" />
      <defs>
        <linearGradient id="mv-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#6D28D9" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Wordmark({
  className,
  subtitle = 'InterviewLab',
}: {
  className?: string;
  subtitle?: string | null;
}) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <MagicVoiceLogo />
      <span className="flex items-baseline gap-1.5 leading-none">
        <span className="text-[15px] font-semibold tracking-tight">{publicEnv.appName}</span>
        {subtitle ? (
          <span className="text-muted-foreground text-[13px] font-medium tracking-tight">
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}

export function PoweredBy({ className }: { className?: string }) {
  return (
    <p className={cn('text-muted-foreground/70 text-[11px] tracking-wide', className)}>
      Powered by <span className="font-medium">{publicEnv.appName}</span>
    </p>
  );
}
