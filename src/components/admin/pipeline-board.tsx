import Link from 'next/link';
import { AlarmClock, ClipboardCheck, UserRound } from 'lucide-react';
import type { ApplicationStatus } from '@/generated/prisma/enums';
import type { ApplicationListRow } from '@/features/pipeline/queries';
import {
  ApplicationStatusBadge,
  StageStatusBadge,
  StageTypeBadge,
} from '@/components/admin/badges';
import { cn } from '@/lib/utils';

/**
 * The board.
 *
 * **Grouped by `ApplicationStatus`, not by stage.** Grouping by the current
 * round reads better on paper and falls apart in practice here: stage names
 * come from whichever template the application was built from, so a board
 * keyed on them grows a column per distinct name and no two requisitions ever
 * line up — "Technical screen" and "Tech screen" sit side by side as if they
 * were different things. Status is the one axis every application shares
 * whatever process it is running, so it is the one that groups.
 *
 * What the stage would have given us — where each candidate actually is — is
 * on the card instead, next to the two numbers a recruiter is scanning for:
 * scorecards nobody has written, and candidates who have not moved.
 *
 * Rows rather than kanban columns: a five-column board is unreadable on a
 * laptop and impossible at 375px, and the console must not break below 768px.
 */

/** A stage nobody has touched for this long is the thing to chase. Seven days
 *  because a week is the unit a hiring pipeline is actually discussed in. */
const STALL_DAYS = 7;

/** Live work first, then the archive. Within a group the query has already
 *  ordered by most-recently-touched. */
const GROUP_ORDER: readonly ApplicationStatus[] = [
  'ACTIVE',
  'ON_HOLD',
  'HIRED',
  'REJECTED',
  'WITHDRAWN',
];

/**
 * The status in words, shared with the filter on `/admin/pipeline`.
 *
 * Exported because there were two copies: the filter had a label map and the
 * board fell back to the raw enum, so a screen-reader user heard "ON_HOLD"
 * announced as the heading of a group the sighted filter above calls "On hold".
 * (`badges.tsx` keeps its own map private, and it pairs each label with a badge
 * variant — this is the plain text half.)
 */
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  HIRED: 'Hired',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

const GROUP_BLURB: Record<ApplicationStatus, string> = {
  ACTIVE: 'Moving through the process.',
  ON_HOLD: 'Paused — waiting on the candidate, the requisition or a slot.',
  HIRED: 'Closed with an offer.',
  REJECTED: 'Closed without one.',
  WITHDRAWN: 'The candidate stepped away.',
};

export function PipelineBoard({ applications }: { applications: readonly ApplicationListRow[] }) {
  const groups = GROUP_ORDER.map((status) => ({
    status,
    rows: applications.filter((a) => a.status === status),
  })).filter((group) => group.rows.length > 0);

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.status} aria-labelledby={`group-${group.status}`}>
          <div className="mb-2.5 flex flex-wrap items-center gap-2">
            <h2 id={`group-${group.status}`} className="sr-only">
              {APPLICATION_STATUS_LABELS[group.status]}
            </h2>
            <ApplicationStatusBadge status={group.status} />
            <span className="text-muted-foreground text-[12px] tabular-nums">
              {group.rows.length}
            </span>
            <span className="text-muted-foreground hidden text-[12px] sm:inline">
              {GROUP_BLURB[group.status]}
            </span>
          </div>

          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {group.rows.map((row) => (
              <li key={row.id}>
                <ApplicationCard row={row} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ApplicationCard({ row }: { row: ApplicationListRow }) {
  const stalled =
    row.status === 'ACTIVE' && row.daysInStage !== null && row.daysInStage >= STALL_DAYS;
  const waiting = row.outstandingScorecards > 0;

  return (
    <Link
      href={`/admin/applications/${row.id}`}
      className={cn(
        'bg-card hover:border-primary/50 block h-full rounded-lg border px-3 py-2.5 shadow-xs transition-colors',
        // One accent, not two: a stalled application that is also waiting on
        // feedback is one problem with one cause, and two coloured borders
        // would just make the board louder.
        waiting ? 'border-warning/50' : stalled ? 'border-destructive/40' : null,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-[13px] font-medium">{row.candidate.name}</p>
        <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
          {row.stagesComplete}/{row.stagesTotal}
        </span>
      </div>

      <p className="text-muted-foreground mt-0.5 truncate text-[12px]">
        {row.jobRole
          ? `${row.jobRole.title}${row.jobRole.level ? ` · ${row.jobRole.level}` : ''}`
          : 'No job role'}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {row.currentStage ? (
          <>
            <StageTypeBadge type={row.currentStage.type} />
            <span className="min-w-0 truncate text-[12px]">{row.currentStage.name}</span>
            <StageStatusBadge status={row.currentStage.status} />
          </>
        ) : (
          <span className="text-muted-foreground text-[12px]">
            {row.stagesTotal === 0 ? 'No rounds yet' : 'All rounds done'}
          </span>
        )}
      </div>

      {row.nextStage ? (
        <p className="text-muted-foreground mt-1 truncate text-[11px]">
          Next: {row.nextStage.name}
        </p>
      ) : null}

      <div className="text-muted-foreground mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-[11px]">
        <span
          className={cn('inline-flex items-center gap-1', waiting && 'text-warning font-medium')}
        >
          <ClipboardCheck className="size-3" aria-hidden />
          {waiting
            ? `${row.outstandingScorecards} scorecard${row.outstandingScorecards === 1 ? '' : 's'} outstanding`
            : 'Feedback up to date'}
        </span>

        {row.daysInStage !== null ? (
          <span
            className={cn(
              'inline-flex items-center gap-1',
              stalled && 'text-destructive font-medium',
            )}
          >
            <AlarmClock className="size-3" aria-hidden />
            <span className="tabular-nums">
              {row.daysInStage === 0 ? 'Moved today' : `${row.daysInStage}d in stage`}
            </span>
          </span>
        ) : null}

        <span className="inline-flex min-w-0 items-center gap-1">
          <UserRound className="size-3" aria-hidden />
          <span className="truncate">{row.owner ? row.owner.name : 'Unowned'}</span>
        </span>
      </div>
    </Link>
  );
}
