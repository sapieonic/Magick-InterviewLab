import { cn } from '@/lib/utils';

/**
 * Read-only source display with line numbers. Rendered as text nodes, never
 * as HTML — this is candidate-supplied code being shown to an admin, and the
 * one thing it must never do is execute in the reviewer's session.
 */
export function CodeBlock({
  code,
  className,
  maxHeight = '32rem',
}: {
  code: string;
  className?: string;
  maxHeight?: string;
}) {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');

  return (
    <div className={cn('bg-surface-code overflow-hidden rounded-md border', className)}>
      <div className="scrollbar-thin overflow-auto" style={{ maxHeight }}>
        <table className="w-full border-collapse font-mono text-[12.5px] leading-[1.65]">
          <tbody>
            {lines.map((line, index) => (
              <tr key={index} className="align-top">
                <td
                  aria-hidden
                  className="text-muted-foreground/50 border-border/60 w-10 min-w-10 border-r px-2 text-right tabular-nums select-none"
                >
                  {index + 1}
                </td>
                <td className="w-full px-3 whitespace-pre">{line || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Small fixed-width block for a test case's input / expected / actual. */
export function OutputBlock({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'expected' | 'actual';
}) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <pre
        className={cn(
          'bg-surface-code scrollbar-thin max-h-40 overflow-auto rounded border px-2.5 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap',
          tone === 'expected' && 'border-success/30',
          tone === 'actual' && 'border-destructive/30',
        )}
      >
        {value === '' ? '(empty)' : value}
      </pre>
    </div>
  );
}
