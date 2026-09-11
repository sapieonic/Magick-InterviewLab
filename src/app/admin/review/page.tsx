import type { Metadata } from 'next';
import Link from 'next/link';
import { Filter, Inbox } from 'lucide-react';
import { requireCapabilityPage } from '@/features/auth/guards';
import { can } from '@/features/auth/capabilities';
import {
  listReviewFilterOptions,
  listReviewQueue,
  REVIEW_SORT_KEYS,
  REVIEW_SORT_LABELS,
  type PanelFacet,
  type ReviewFilter,
  type ReviewSortKey,
  type ScoreBand,
} from '@/features/review/queries';
import {
  isReviewMetric,
  LOOP_STEP_HINTS,
  LOOP_STEP_LABELS,
  LOOP_STEP_ORDER,
  REVIEW_LOOP_STEPS,
  type ReviewLoopStep,
  type ReviewMetric,
} from '@/features/review/loop';
import { PageHeader } from '@/components/admin/page-header';
import { MetricToggle, ReviewTable } from '@/components/admin/review-table';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import type { Language } from '@/generated/prisma/enums';

export const metadata: Metadata = { title: 'Review' };

/**
 * The review queue.
 *
 * The screen the console was missing: everyone whose coding assessment has
 * finished, in one list, filterable by *what the application is waiting on*
 * and one click from the debrief. The dashboard has counted this queue since
 * the pipeline shipped and had nowhere to send anyone.
 *
 * Gated on `VIEW_ALL_APPLICATIONS`, matching `/admin/submissions` and the
 * debrief. An interviewer is deliberately not here: they have their own
 * feedback queue, and a cross-candidate table in a panellist's hands is both a
 * gossip surface and an anchoring one.
 *
 * Every filter lives in the URL — bookmarkable, linkable, and survives a
 * reload — which is also why the loop chips are links rather than state.
 */

type Params = Record<string, string | string[] | undefined>;

function readParam(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readLoop(value: string | undefined): ReviewLoopStep | undefined {
  return value && (REVIEW_LOOP_STEPS as readonly string[]).includes(value)
    ? (value as ReviewLoopStep)
    : undefined;
}

function readSort(value: string | undefined): ReviewSortKey | undefined {
  return value && (REVIEW_SORT_KEYS as readonly string[]).includes(value)
    ? (value as ReviewSortKey)
    : undefined;
}

function readBand(value: string | undefined): ScoreBand | undefined {
  return value === 'strong' || value === 'partial' || value === 'weak' ? value : undefined;
}

function readPanel(value: string | undefined): PanelFacet | undefined {
  return value === 'AGREE' || value === 'SPLIT' || value === 'INCOMPLETE' || value === 'NONE'
    ? value
    : undefined;
}

function readLanguage(value: string | undefined): Language | undefined {
  return value === 'JAVASCRIPT' || value === 'PYTHON' ? value : undefined;
}

function readWithin(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const days = Number.parseInt(value, 10);
  return Number.isFinite(days) && days > 0 ? days : undefined;
}

/** A link that keeps every other filter and changes one. */
function hrefWith(params: Params, changes: Record<string, string | undefined>): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value !== '') next.set(key, value);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return query ? `/admin/review?${query}` : '/admin/review';
}

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Params> }) {
  const viewer = await requireCapabilityPage('VIEW_ALL_APPLICATIONS');
  const params = await searchParams;

  const metricParam = readParam(params['metric']);
  const metric: ReviewMetric = metricParam && isReviewMetric(metricParam) ? metricParam : 'latest';

  const filter: ReviewFilter = {
    loop: readLoop(readParam(params['loop'])),
    jobRoleId: readParam(params['jobRoleId']),
    interviewId: readParam(params['interviewId']),
    ownerId: readParam(params['ownerId']),
    band: readBand(readParam(params['band'])),
    panel: readPanel(readParam(params['panel'])),
    language: readLanguage(readParam(params['language'])),
    withinDays: readWithin(readParam(params['within'])),
    includeClosed: readParam(params['closed']) === '1',
    metric,
    sort: readSort(readParam(params['sort'])),
  };

  const [queue, options] = await Promise.all([
    listReviewQueue(viewer, filter),
    listReviewFilterOptions(viewer),
  ]);

  const filtered = Object.entries(filter).some(
    ([key, value]) =>
      value !== undefined &&
      value !== false &&
      key !== 'metric' &&
      key !== 'sort' &&
      key !== 'includeClosed',
  );

  const unread = queue.loopCounts.UNREAD;
  const ready = queue.loopCounts.READY;

  return (
    <>
      <PageHeader
        title="Review"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {queue.rows.length} {queue.rows.length === 1 ? 'application' : 'applications'}
            </span>
            {ready > 0 ? (
              <span className="text-warning font-medium">{ready} ready to decide</span>
            ) : null}
            {unread > 0 ? (
              <span className="text-warning font-medium">{unread} with unread code</span>
            ) : null}
          </span>
        }
        actions={
          <MetricToggle
            metric={metric}
            latestHref={hrefWith(params, { metric: undefined })}
            bestHref={hrefWith(params, { metric: 'best' })}
          />
        }
      />

      {/* The loop, as a filter. These are the five-and-one states an
          application can be in after its assessment finishes.

          The counts are computed before the loop step and the in-memory facets
          are applied, so picking a chip never changes the number on any other
          chip. They do move with job role and owner, which are applied in the
          query itself — that is the point of those two, and a count that
          ignored them would describe a list nobody is looking at. */}
      <nav aria-label="Loop step" className="mb-4 flex flex-wrap gap-1.5">
        <LoopChip
          href={hrefWith(params, { loop: undefined })}
          label="Everything"
          // Matches what "everything" would actually list, which means it has
          // to follow the include-closed tick rather than always subtracting
          // the closed ones.
          count={
            Object.values(queue.loopCounts).reduce((sum, n) => sum + n, 0) -
            (filter.includeClosed ? 0 : queue.loopCounts.CLOSED)
          }
          active={filter.loop === undefined}
          hint={
            filter.includeClosed
              ? 'Every application whose coding assessment has finished.'
              : 'Every application whose coding assessment has finished, closed ones aside.'
          }
        />
        {LOOP_STEP_ORDER.map((step) => (
          <LoopChip
            key={step}
            href={hrefWith(params, { loop: step })}
            label={LOOP_STEP_LABELS[step]}
            count={queue.loopCounts[step]}
            active={filter.loop === step}
            hint={LOOP_STEP_HINTS[step]}
          />
        ))}
      </nav>

      <form
        method="get"
        className="bg-card mb-5 flex flex-wrap items-end gap-3 rounded-lg border px-4 py-3 shadow-xs"
      >
        {/* The chips and the metric toggle live in the URL too, so the form
            has to carry them or applying a filter would silently reset them. */}
        {filter.loop ? <input type="hidden" name="loop" value={filter.loop} /> : null}
        {metric !== 'latest' ? <input type="hidden" name="metric" value={metric} /> : null}

        <Field id="jobRoleId" label="Job role">
          <Select id="jobRoleId" name="jobRoleId" defaultValue={filter.jobRoleId ?? ''}>
            <option value="">All roles</option>
            {options.jobRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.level ? `${role.title} · ${role.level}` : role.title}
              </option>
            ))}
          </Select>
        </Field>

        <Field id="interviewId" label="Assessment">
          <Select id="interviewId" name="interviewId" defaultValue={filter.interviewId ?? ''}>
            <option value="">All assessments</option>
            {options.interviews.map((interview) => (
              <option key={interview.id} value={interview.id}>
                {interview.title}
              </option>
            ))}
          </Select>
        </Field>

        <Field id="ownerId" label="Owner">
          <Select id="ownerId" name="ownerId" defaultValue={filter.ownerId ?? ''}>
            <option value="">All owners</option>
            {options.owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field id="band" label="Tests">
          <Select id="band" name="band" defaultValue={filter.band ?? ''}>
            <option value="">Any result</option>
            <option value="strong">Strong (80%+)</option>
            <option value="partial">Partial (40–79%)</option>
            <option value="weak">Weak (under 40%)</option>
          </Select>
        </Field>

        <Field id="panel" label="Panel">
          <Select id="panel" name="panel" defaultValue={filter.panel ?? ''}>
            <option value="">Any panel</option>
            <option value="AGREE">Agrees</option>
            <option value="SPLIT">Splits</option>
            <option value="INCOMPLETE">Scorecards outstanding</option>
            <option value="NONE">No panel</option>
          </Select>
        </Field>

        <Field id="language" label="Language">
          <Select id="language" name="language" defaultValue={filter.language ?? ''}>
            <option value="">Any language</option>
            <option value="JAVASCRIPT">JavaScript</option>
            <option value="PYTHON">Python</option>
          </Select>
        </Field>

        <Field id="within" label="Finished">
          <Select id="within" name="within" defaultValue={String(filter.withinDays ?? '')}>
            <option value="">Any time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </Select>
        </Field>

        <Field id="sort" label="Sort by">
          <Select id="sort" name="sort" defaultValue={queue.sort}>
            {REVIEW_SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {REVIEW_SORT_LABELS[key]}
              </option>
            ))}
          </Select>
        </Field>

        <label className="flex items-center gap-2 pb-2 text-[13px]">
          <input
            type="checkbox"
            name="closed"
            value="1"
            defaultChecked={filter.includeClosed === true}
            className="border-input accent-primary size-4 rounded border"
          />
          Include closed
        </label>

        <div className="flex gap-2 pb-1">
          <Button type="submit" size="sm" variant="outline">
            <Filter className="size-3.5" aria-hidden />
            Apply
          </Button>
          {filtered ? (
            <Button asChild size="sm" variant="ghost">
              <Link href="/admin/review">Clear</Link>
            </Button>
          ) : null}
        </div>
      </form>

      {queue.rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={filtered ? 'Nothing matches that filter' : 'No finished assessments yet'}
          description={
            filtered
              ? 'Try clearing the filter, or pick a different step of the loop.'
              : 'A row appears here the moment a candidate answers every question on a coding round.'
          }
          action={
            filtered ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/review">Clear filter</Link>
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/pipeline">Open pipeline</Link>
              </Button>
            )
          }
        />
      ) : (
        <ReviewTable
          rows={queue.rows}
          metric={queue.metric}
          canDecide={can(viewer.role, 'DECIDE')}
        />
      )}

      <p className="text-muted-foreground mt-5 max-w-3xl text-[12px]">
        Test pass-rate is one input among several, and elapsed time is wall clock that includes
        breaks — neither is a measure of code quality, and nothing on this page ranks candidates or
        recommends an outcome. The decision is written by a person, with a reason, on the debrief.
      </p>
    </>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-36 flex-1 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function LoopChip({
  href,
  label,
  count,
  active,
  hint,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
  hint: string;
}) {
  return (
    <Link
      href={href}
      title={hint}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-card text-muted-foreground hover:text-foreground hover:border-primary/40',
      )}
    >
      {label}
      <span className={cn('tabular-nums', active ? 'opacity-80' : 'opacity-60')}>{count}</span>
    </Link>
  );
}
