'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Columns3, Download, Eye, EyeOff, GitCompare, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ScoreBadge, ApplicationStatusBadge, DecisionBadge } from '@/components/admin/badges';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn, formatDuration } from '@/lib/utils';
import type { ReviewRow } from '@/features/review/queries';
import type { ReviewMetric } from '@/features/review/loop';

/**
 * The queue itself.
 *
 * A client component only because three things here need state the URL should
 * not carry: which rows are ticked for a comparison, where the keyboard is,
 * and a CSV the browser builds from rows it already has. Every *filter* stays
 * in the URL, where it can be bookmarked and linked — see the page.
 *
 * What this component must never grow: a computed ranking. Columns sort
 * because a person clicked one, and the default is how long someone has been
 * waiting. There is no composite score, no percentile and no highlight on the
 * higher number. The README explains why that is a legal position and not a
 * stylistic one.
 */

const MAX_COMPARE = 4;

export function ReviewTable({
  rows,
  metric,
  canDecide,
}: {
  rows: readonly ReviewRow[];
  metric: ReviewMetric;
  canDecide: boolean;
}) {
  const router = useRouter();
  const [picked, setPicked] = React.useState<readonly string[]>([]);
  const [cursor, setCursor] = React.useState(0);
  const rowRefs = React.useRef<Array<HTMLTableRowElement | null>>([]);

  const visibleIds = React.useMemo(() => new Set(rows.map((r) => r.applicationId)), [rows]);

  // A filter change re-renders with different rows, and a tick pointing at a
  // row that is no longer listed would silently compare something the person
  // can no longer see. Pruned during render rather than synced back into state
  // by an effect: an effect would render one frame with the stale selection
  // before correcting it, and that frame is the one with the wrong Compare
  // link in it.
  const selected = React.useMemo(
    () => picked.filter((id) => visibleIds.has(id)),
    [picked, visibleIds],
  );

  const toggle = React.useCallback(
    (id: string) => {
      setPicked((current) => {
        const live = current.filter((x) => visibleIds.has(x));
        if (live.includes(id)) return live.filter((x) => x !== id);
        return live.length >= MAX_COMPARE ? live : [...live, id];
      });
    },
    [visibleIds],
  );

  const move = React.useCallback(
    (delta: number) => {
      setCursor((current) => {
        const next = Math.min(Math.max(current + delta, 0), Math.max(rows.length - 1, 0));
        rowRefs.current[next]?.focus();
        return next;
      });
    },
    [rows.length],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLTableSectionElement>): void => {
    // Never steal a key from someone typing in the filter bar, and never from
    // a browser shortcut.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const row = rows[cursor];
    switch (event.key) {
      case 'j':
        event.preventDefault();
        move(1);
        break;
      case 'k':
        event.preventDefault();
        move(-1);
        break;
      case 'c':
        if (row) {
          event.preventDefault();
          toggle(row.applicationId);
        }
        break;
      case 'Enter':
        if (row) {
          event.preventDefault();
          router.push(`/admin/applications/${row.applicationId}/scorecard`);
        }
        break;
      case 'Escape':
        event.preventDefault();
        setPicked([]);
        break;
      default:
        break;
    }
  };

  // Selection order is preserved deliberately: the compare view lays the
  // candidates out in the order they were picked, never sorted by score.
  const compareHref =
    selected.length >= 2 ? `/admin/review/compare?ids=${selected.join(',')}` : null;

  const sameAssessment =
    selected.length < 2 ||
    new Set(
      selected.map((id) => rows.find((r) => r.applicationId === id)?.assessment.interviewId ?? id),
    ).size === 1;

  return (
    <div className="space-y-3">
      <div className="bg-card overflow-x-auto rounded-lg border shadow-xs">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <span className="sr-only">Select</span>
              </TableHead>
              <TableHead>Candidate</TableHead>
              <TableHead>Assessment</TableHead>
              <TableHead>Tests ({metric})</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Elapsed</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Panel</TableHead>
              <TableHead>Rounds</TableHead>
              <TableHead>Waiting</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Decision</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody onKeyDown={onKeyDown}>
            {rows.map((row, index) => (
              <Row
                key={row.applicationId}
                ref={(el) => {
                  rowRefs.current[index] = el;
                }}
                row={row}
                focused={index === cursor}
                selected={selected.includes(row.applicationId)}
                selectionFull={selected.length >= MAX_COMPARE}
                canDecide={canDecide}
                onFocus={() => setCursor(index)}
                onToggle={() => toggle(row.applicationId)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-[12px]">
        {selected.length > 0 ? (
          <>
            <span className="text-foreground font-medium">
              {selected.length} selected
              {selected.length >= MAX_COMPARE ? ` (max ${MAX_COMPARE})` : ''}
            </span>
            {compareHref && sameAssessment ? (
              <Button asChild size="xs" variant="outline">
                <Link href={compareHref}>
                  <GitCompare className="size-3.5" aria-hidden />
                  Compare
                </Link>
              </Button>
            ) : null}
            {compareHref && !sameAssessment ? (
              <span className="text-warning">
                Pick candidates who sat the same assessment to compare them.
              </span>
            ) : null}
            {selected.length === 1 ? <span>Pick one more to compare.</span> : null}
            <Button size="xs" variant="ghost" onClick={() => setPicked([])}>
              Clear
            </Button>
          </>
        ) : (
          <span>
            <kbd className="bg-muted rounded px-1">j</kbd>/
            <kbd className="bg-muted rounded px-1">k</kbd> move ·{' '}
            <kbd className="bg-muted rounded px-1">c</kbd> pick for compare ·{' '}
            <kbd className="bg-muted rounded px-1">Enter</kbd> open debrief
          </span>
        )}
        <span className="ml-auto">
          <ExportButton rows={rows} metric={metric} />
        </span>
      </div>
    </div>
  );
}

interface RowProps {
  row: ReviewRow;
  focused: boolean;
  selected: boolean;
  selectionFull: boolean;
  canDecide: boolean;
  onFocus: () => void;
  onToggle: () => void;
}

const Row = React.forwardRef<HTMLTableRowElement, RowProps>(function Row(
  { row, focused, selected, selectionFull, canDecide, onFocus, onToggle },
  ref,
) {
  const { assessment, panel } = row;
  const answered = assessment.rollUp.questionsAnswered;

  return (
    <TableRow
      ref={ref}
      tabIndex={0}
      onFocus={onFocus}
      data-selected={selected || undefined}
      className={cn(
        'focus-visible:outline-primary focus-visible:outline-2 focus-visible:-outline-offset-2',
        focused && 'bg-accent/40',
      )}
    >
      <TableCell>
        <Checkbox
          checked={selected}
          disabled={!selected && selectionFull}
          onChange={onToggle}
          aria-label={`Select ${row.candidate.name} for comparison`}
        />
      </TableCell>

      <TableCell>
        <Link
          href={`/admin/applications/${row.applicationId}`}
          className="hover:text-primary font-medium transition-colors"
        >
          {row.candidate.name}
        </Link>
        <p className="text-muted-foreground text-[12px]">
          {row.jobRole
            ? row.jobRole.level
              ? `${row.jobRole.title} · ${row.jobRole.level}`
              : row.jobRole.title
            : 'No role'}
          {!row.candidate.isActive ? ' · Inactive' : ''}
        </p>
      </TableCell>

      <TableCell className="text-[13px]">
        <span className="flex flex-wrap items-center gap-1.5">
          {assessment.interviewTitle}
          {assessment.interviewArchived ? <Badge variant="outline">Archived</Badge> : null}
          {assessment.otherCodingStages > 0 ? (
            <Badge variant="outline">+{assessment.otherCodingStages}</Badge>
          ) : null}
        </span>
        <span className="text-muted-foreground text-[12px]">
          {answered}/{assessment.questionsTotal} answered
        </span>
      </TableCell>

      <TableCell>
        {assessment.rollUp.score === null ? (
          <span className="text-muted-foreground text-[13px]">—</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="text-[13px] tabular-nums">
              {assessment.rollUp.passedCount}/{assessment.rollUp.totalCount}
            </span>
            <ScoreBadge score={assessment.rollUp.score} />
          </span>
        )}
      </TableCell>

      <TableCell className="text-[13px] whitespace-nowrap tabular-nums">
        {assessment.rollUp.attempts === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            {assessment.rollUp.attempts} · {answered}q
          </>
        )}
      </TableCell>

      {/* Elapsed is a fact, never a judgement: no colour, no threshold, no
          comparison to anyone else. See the tooltip and the README. */}
      <TableCell className="text-[13px] whitespace-nowrap tabular-nums">
        <span title="Wall clock between the candidate first opening the assessment and answering the last question. Includes breaks.">
          {assessment.elapsedMs === null
            ? assessment.startedAt
              ? 'in progress'
              : 'not started'
            : formatDuration(assessment.elapsedMs)}
        </span>
        {assessment.lateCount > 0 || assessment.rollUp.autoSubmitted > 0 ? (
          <span
            className="text-warning ml-1.5 inline-flex items-center gap-0.5"
            title={lateTitle(row)}
          >
            <Timer className="size-3" aria-hidden />
            <span className="sr-only">{lateTitle(row)}</span>
          </span>
        ) : null}
      </TableCell>

      <TableCell>
        {row.codeRead ? (
          <span
            className="text-success inline-flex items-center gap-1 text-[12px]"
            title="A person has written a note or a scorecard on this code."
          >
            <Eye className="size-3.5" aria-hidden />
            read
          </span>
        ) : (
          <span
            className="text-warning inline-flex items-center gap-1 text-[12px]"
            title="No person has read this code yet. A machine score is not a review."
          >
            <EyeOff className="size-3.5" aria-hidden />
            unread
          </span>
        )}
      </TableCell>

      <TableCell className="whitespace-nowrap">
        {panel.expected === 0 ? (
          <span
            className="text-warning text-[12px]"
            title="Nobody is on a panel for this application."
          >
            No panel
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="text-[13px] tabular-nums">
              {panel.submitted}/{panel.expected}
            </span>
            {panel.disagrees === true ? (
              <span
                className="text-warning inline-flex items-center gap-0.5 text-[12px]"
                title="The panel does not agree. Read the scorecards before deciding."
              >
                <AlertTriangle className="size-3" aria-hidden />
                split
              </span>
            ) : null}
            {panel.disagrees === null ? (
              <span
                className="text-muted-foreground text-[12px]"
                title="Hidden until you submit your own scorecard on this round."
              >
                hidden
              </span>
            ) : null}
          </span>
        )}
      </TableCell>

      <TableCell className="text-[13px] tabular-nums">
        {row.stagesComplete}/{row.stagesTotal}
      </TableCell>

      <TableCell className="text-[13px] whitespace-nowrap tabular-nums">
        {row.waitingDays === null ? '—' : `${row.waitingDays}d`}
      </TableCell>

      <TableCell className="text-muted-foreground text-[12px]">
        {row.owner?.name ?? 'Unowned'}
      </TableCell>

      <TableCell>
        <span className="flex flex-wrap items-center gap-1">
          {row.decision ? <DecisionBadge outcome={row.decision.outcome} /> : null}
          <ApplicationStatusBadge status={row.status} />
        </span>
      </TableCell>

      <TableCell className="text-right whitespace-nowrap">
        <Button asChild size="xs" variant={canDecide ? 'default' : 'outline'}>
          <Link href={`/admin/applications/${row.applicationId}/scorecard`}>
            {canDecide && !row.decision ? 'Decide' : 'Debrief'}
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  );
});

function lateTitle(row: ReviewRow): string {
  const parts: string[] = [];
  if (row.assessment.lateCount > 0) {
    parts.push(
      `${row.assessment.lateCount} ${row.assessment.lateCount === 1 ? 'answer' : 'answers'} landed after the deadline`,
    );
  }
  if (row.assessment.rollUp.autoSubmitted > 0) {
    parts.push(`${row.assessment.rollUp.autoSubmitted} auto-submitted when the timer ran out`);
  }
  return parts.join('; ');
}

/**
 * The visible rows as CSV, built in the browser from data it already has.
 *
 * No "rank" and no "overall" column, here or anywhere: a spreadsheet is
 * exactly where a composite would get invented, and this is the export people
 * would paste into one. A unit test pins the header row for that reason.
 */
export const REVIEW_CSV_HEADER = [
  'candidate',
  'email',
  'role',
  'level',
  'assessment',
  'questions_answered',
  'questions_total',
  'tests_passed',
  'tests_total',
  'mean_question_score',
  'attempts',
  'elapsed_minutes',
  'late_answers',
  'auto_submitted',
  'code_read',
  'scorecards_in',
  'scorecards_expected',
  'panel_split',
  'rounds_complete',
  'rounds_total',
  'waiting_days',
  'owner',
  'decision',
  'application_status',
  'loop_step',
] as const;

export function toReviewCsv(rows: readonly ReviewRow[], metric: ReviewMetric): string {
  const lines = [
    `# metric: ${metric} submission per question`,
    REVIEW_CSV_HEADER.join(','),
    ...rows.map((row) =>
      [
        row.candidate.name,
        row.candidate.email,
        row.jobRole?.title ?? '',
        row.jobRole?.level ?? '',
        row.assessment.interviewTitle,
        row.assessment.rollUp.questionsAnswered,
        row.assessment.questionsTotal,
        row.assessment.rollUp.passedCount,
        row.assessment.rollUp.totalCount,
        row.assessment.rollUp.score ?? '',
        row.assessment.rollUp.attempts,
        row.assessment.elapsedMs === null ? '' : Math.round(row.assessment.elapsedMs / 60000),
        row.assessment.lateCount,
        row.assessment.rollUp.autoSubmitted,
        row.codeRead ? 'yes' : 'no',
        row.panel.submitted,
        row.panel.expected,
        // Three states, not two: "hidden" is not "no".
        row.panel.disagrees === null ? 'hidden' : row.panel.disagrees ? 'yes' : 'no',
        row.stagesComplete,
        row.stagesTotal,
        row.waitingDays ?? '',
        row.owner?.name ?? '',
        row.decision?.outcome ?? '',
        row.status,
        row.loop,
      ]
        .map(csvCell)
        .join(','),
    ),
  ];
  return lines.join('\n');
}

/**
 * RFC 4180 quoting, and a leading apostrophe on anything a spreadsheet would
 * execute — a candidate named `=cmd()` is a formula-injection payload.
 *
 * The whitespace in the pattern is load-bearing: several spreadsheets trim a
 * cell before deciding whether it is a formula, so `" =cmd()"` executes just as
 * readily as `"=cmd()"` and a guard anchored hard at `=` would wave it through.
 * The apostrophe goes on before the quoting below, never after, or the escape
 * would sit outside the quotes and do nothing.
 */
function csvCell(value: string | number): string {
  const text = String(value);
  const executable = /^[\s\u00a0]*[=+\-@]/.test(text) || /^[\t\r]/.test(text);
  const safe = executable ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function ExportButton({ rows, metric }: { rows: readonly ReviewRow[]; metric: ReviewMetric }) {
  const download = (): void => {
    const blob = new Blob([toReviewCsv(rows, metric)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `review-queue-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Button size="xs" variant="ghost" onClick={download} disabled={rows.length === 0}>
      <Download className="size-3.5" aria-hidden />
      Export CSV
    </Button>
  );
}

/**
 * The latest/best toggle, as links so the choice stays in the URL.
 *
 * Takes two ready-made hrefs rather than a function that builds them. This
 * module is `'use client'` and the page rendering it is a server component, so
 * a function prop across that boundary is not serialisable — it throws at
 * render time, which no amount of typechecking would have caught.
 */
export function MetricToggle({
  metric,
  latestHref,
  bestHref,
}: {
  metric: ReviewMetric;
  latestHref: string;
  bestHref: string;
}) {
  const options: ReadonlyArray<{ value: ReviewMetric; href: string }> = [
    { value: 'latest', href: latestHref },
    { value: 'best', href: bestHref },
  ];

  return (
    <span className="flex items-center gap-1">
      <Columns3 className="text-muted-foreground size-3.5" aria-hidden />
      {options.map((option) => (
        <Button
          key={option.value}
          asChild
          size="xs"
          variant={metric === option.value ? 'secondary' : 'ghost'}
        >
          <Link href={option.href}>{option.value}</Link>
        </Button>
      ))}
    </span>
  );
}
