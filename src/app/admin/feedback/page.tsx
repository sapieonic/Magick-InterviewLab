import type { Metadata } from 'next';
import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';
import { requireStaffPage } from '@/features/auth/guards';
import { can } from '@/features/auth/capabilities';
import { listMyFeedback, listOutstandingFeedback } from '@/features/feedback/queries';
import { PageHeader, Section } from '@/components/admin/page-header';
import { FeedbackStatusBadge, StageTypeBadge } from '@/components/admin/badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/utils';

export const metadata: Metadata = { title: 'My feedback' };

/**
 * Age is the whole point of this page.
 *
 * A scorecard written a fortnight after the interview is written from memory,
 * and the only thing that reliably shortens that gap is showing someone how
 * long they have personally been the blocker. So the queue leads with days
 * outstanding, sorted oldest first, rather than with the candidate's name.
 */
function AgeBadge({ days, done }: { days: number; done: boolean }) {
  if (done) return <Badge variant="outline">Done</Badge>;
  const variant = days >= 7 ? 'destructive' : days >= 3 ? 'warning' : 'outline';
  return (
    <Badge variant={variant} className="tabular-nums">
      {days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'}`}
    </Badge>
  );
}

export default async function FeedbackQueuePage() {
  const viewer = await requireStaffPage();
  const seesEverything = can(viewer.role, 'VIEW_ALL_APPLICATIONS');

  const [mine, outstanding] = await Promise.all([
    listMyFeedback(viewer),
    seesEverything ? listOutstandingFeedback(viewer) : Promise.resolve([]),
  ]);

  const owed = mine.filter((row) => row.status !== 'SUBMITTED');

  return (
    <>
      <PageHeader
        title="My feedback"
        description={
          owed.length === 0
            ? 'Nothing outstanding.'
            : `${owed.length} ${owed.length === 1 ? 'scorecard' : 'scorecards'} to write.`
        }
      />

      <div className="space-y-5">
        <Section
          title="Your rounds"
          description="Oldest first. Submitting also unlocks the rest of the panel's scorecards."
        >
          {mine.length === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="You are not on any panels"
              description="Rounds you are added to as an interviewer appear here."
            />
          ) : (
            <ul className="divide-y">
              {mine.map((row) => (
                <li
                  key={row.stageId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 first:pt-0 last:pb-0"
                >
                  <AgeBadge days={row.ageDays} done={row.status === 'SUBMITTED'} />
                  <Link
                    href={`/admin/stages/${row.stageId}`}
                    className="hover:text-primary min-w-0 flex-1 truncate text-[13px] font-medium transition-colors"
                  >
                    {row.candidateName}
                    <span className="text-muted-foreground font-normal"> · {row.stageName}</span>
                  </Link>
                  <StageTypeBadge type={row.stageType} />
                  {row.status ? (
                    <FeedbackStatusBadge status={row.status} />
                  ) : (
                    <Badge variant="outline">Not started</Badge>
                  )}
                  <span className="text-muted-foreground hidden text-[12px] sm:inline">
                    {formatDate(row.waitingSince)}
                  </span>
                  <Button asChild size="xs" variant="outline">
                    <Link href={`/admin/stages/${row.stageId}`}>
                      {row.status === 'SUBMITTED' ? 'Open' : 'Write'}
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {seesEverything ? (
          <Section
            title="Outstanding across the pipeline"
            description="Who owes what. Only status is shown here — never anyone's draft."
          >
            {outstanding.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                Every panel on every open application has reported.
              </p>
            ) : (
              <ul className="divide-y">
                {outstanding.map((row) => (
                  <li key={row.stageId} className="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <AgeBadge days={row.ageDays} done={false} />
                      <Link
                        href={`/admin/applications/${row.applicationId}/scorecard`}
                        className="hover:text-primary min-w-0 flex-1 truncate text-[13px] font-medium transition-colors"
                      >
                        {row.candidateName}
                        <span className="text-muted-foreground font-normal">
                          {' '}
                          · {row.stageName}
                        </span>
                      </Link>
                      <span className="text-muted-foreground text-[12px] tabular-nums">
                        {row.submittedCount}/{row.panelSize} in
                      </span>
                    </div>
                    <p className="text-muted-foreground pl-1 text-[12px]">
                      Waiting on{' '}
                      {row.owed
                        .map(
                          (person) =>
                            `${person.name}${person.status === 'DRAFT' ? ' (draft started)' : ''}`,
                        )
                        .join(', ')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ) : null}
      </div>
    </>
  );
}
