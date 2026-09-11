import type { Metadata } from 'next';
import Link from 'next/link';
import { GitCompare } from 'lucide-react';
import { requireCapabilityPage } from '@/features/auth/guards';
import { getComparison, MAX_COMPARE, type CompareCandidate } from '@/features/review/compare';
import { isReviewMetric, type ReviewMetric } from '@/features/review/loop';
import { COHORT_MIN } from '@/features/review/cohort';
import { PageHeader, Section } from '@/components/admin/page-header';
import { DecisionBadge, LanguageBadge, ScoreBadge } from '@/components/admin/badges';
import { DistributionBar } from '@/components/admin/scorecard';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate, formatDuration } from '@/lib/utils';

export const metadata: Metadata = { title: 'Compare' };

/**
 * Two to four candidates on one assessment.
 *
 * The page a hiring manager with finalists actually wants, and the one most
 * likely to grow a feature that decides for them. So, explicitly, what is not
 * here: no totals row across rounds, no highlight on the higher number, no
 * winner, no rank, and no ordering the system chose — columns appear in the
 * order the rows were ticked.
 *
 * The cohort column is *context*, not position: a median and a shape, withheld
 * entirely below `COHORT_MIN` completed candidates because a middle drawn from
 * three people reads as authoritative and is not. Elapsed is shown per
 * candidate and deliberately never in that column — see `compare.ts`.
 */
export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireCapabilityPage('VIEW_ALL_APPLICATIONS');
  const params = await searchParams;

  const raw = typeof params['ids'] === 'string' ? params['ids'] : '';
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const metricParam = typeof params['metric'] === 'string' ? params['metric'] : '';
  const metric: ReviewMetric = isReviewMetric(metricParam) ? metricParam : 'latest';

  const result = await getComparison(viewer, ids, metric);

  if (!result.ok) {
    return (
      <>
        <Header />
        {result.reason === 'MISMATCH' ? (
          <Alert tone="warning" title="Pick candidates who sat the same assessment">
            <p className="mb-2">
              Question rows only line up when everyone answered the same questions. Lining up two
              different question sets produces a grid that looks comparable and is not.
            </p>
            <ul className="space-y-0.5">
              {result.mismatch.assessments.map((entry) => (
                <li key={entry.candidateName} className="text-[13px]">
                  <span className="font-medium">{entry.candidateName}</span> —{' '}
                  {entry.interviewTitle ?? 'no coding assessment'}
                </li>
              ))}
            </ul>
          </Alert>
        ) : (
          <EmptyState
            icon={GitCompare}
            title={
              result.reason === 'NOT_ENOUGH'
                ? 'Pick at least two candidates'
                : result.reason === 'TOO_MANY'
                  ? `Pick at most ${MAX_COMPARE} candidates`
                  : 'Nothing to compare'
            }
            description={
              result.reason === 'NOT_FOUND'
                ? 'One of these applications does not exist, or is not yours to read.'
                : 'Tick rows on the review queue and choose Compare.'
            }
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/review">Back to review</Link>
              </Button>
            }
          />
        )}
      </>
    );
  }

  const { view } = result;
  const { cohort } = view;
  const columns = view.candidates.length;

  return (
    <>
      <Header
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{view.interviewTitle}</span>
            <span>
              {columns} candidates · {metric} submission per question
            </span>
          </span>
        }
      />

      <div className="space-y-5">
        <Section
          title="Automated results"
          description="Machine-graded test outcomes. One input among several, and not a measure of code quality."
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b">
                  <th className="w-56 py-2 pr-3 text-left font-medium">Question</th>
                  {view.candidates.map((candidate) => (
                    <th key={candidate.applicationId} className="px-3 py-2 text-left font-medium">
                      <Link
                        href={`/admin/applications/${candidate.applicationId}`}
                        className="hover:text-primary transition-colors"
                      >
                        {candidate.candidateName}
                      </Link>
                      <p className="text-muted-foreground text-[12px] font-normal">
                        {candidate.jobRoleTitle ?? 'No role'}
                      </p>
                    </th>
                  ))}
                  {cohort.shown ? (
                    <th className="text-muted-foreground px-3 py-2 text-left font-medium">
                      Cohort
                      <p className="text-[12px] font-normal">n={cohort.size} completed</p>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {view.questions.map((question, index) => (
                  <tr key={question.questionId} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <span className="text-muted-foreground tabular-nums">Q{index + 1}</span>{' '}
                      {question.title}
                    </td>
                    {view.candidates.map((candidate) => {
                      const cell = candidate.perQuestion[index];
                      return (
                        <td key={candidate.applicationId} className="px-3 py-2">
                          {!cell || cell.score === null ? (
                            <span className="text-muted-foreground">not answered</span>
                          ) : (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="tabular-nums">
                                {cell.passedCount}/{cell.totalCount}
                              </span>
                              <span className="text-muted-foreground text-[12px]">
                                {cell.attempts} {cell.attempts === 1 ? 'attempt' : 'attempts'}
                              </span>
                              {cell.autoSubmitted ? (
                                <Badge
                                  variant="outline"
                                  title="Submitted by the timer, not the candidate."
                                >
                                  auto
                                </Badge>
                              ) : null}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    {cohort.shown ? (
                      <td className="text-muted-foreground px-3 py-2 tabular-nums">
                        {cohort.questions[index]?.medianPassed === null ||
                        cohort.questions[index] === undefined ? (
                          '—'
                        ) : (
                          <>
                            median {cohort.questions[index]?.medianPassed}/
                            {cohort.questions[index]?.totalCount}
                          </>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}

                <tr className="border-t-2">
                  <td className="py-2 pr-3 font-medium">Total ({metric})</td>
                  {view.candidates.map((candidate) => (
                    <td key={candidate.applicationId} className="px-3 py-2">
                      {candidate.score === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <span className="tabular-nums">
                            {candidate.passedCount}/{candidate.totalCount}
                          </span>
                          <ScoreBadge score={candidate.score} />
                        </span>
                      )}
                    </td>
                  ))}
                  {cohort.shown ? (
                    <td className="text-muted-foreground px-3 py-2 tabular-nums">
                      {cohort.medianScore === null
                        ? '—'
                        : `median ${Math.round(cohort.medianScore)}%`}
                    </td>
                  ) : null}
                </tr>

                {/* Elapsed sits in the candidate columns and stops there. A
                    cohort median for it would turn wall clock into a
                    comparator, which is the one number here that is an
                    accommodation risk rather than a merely weak signal. */}
                <tr className="border-t">
                  <td className="py-2 pr-3 font-medium">Elapsed</td>
                  {view.candidates.map((candidate) => (
                    <td
                      key={candidate.applicationId}
                      className="px-3 py-2 tabular-nums"
                      title="Wall clock between opening the assessment and answering the last question. Includes breaks."
                    >
                      {formatDuration(candidate.elapsedMs)}
                      {candidate.lateCount > 0 ? (
                        <span className="text-warning ml-1.5 text-[12px]">
                          {candidate.lateCount} after deadline
                        </span>
                      ) : null}
                    </td>
                  ))}
                  {cohort.shown ? (
                    <td className="text-muted-foreground px-3 py-2 text-[12px]">not compared</td>
                  ) : null}
                </tr>

                <tr className="border-t">
                  <td className="py-2 pr-3 font-medium">Languages</td>
                  {view.candidates.map((candidate) => (
                    <td key={candidate.applicationId} className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {candidate.languages.length === 0
                          ? '—'
                          : candidate.languages.map((language) => (
                              <LanguageBadge key={language} language={language} />
                            ))}
                      </span>
                    </td>
                  ))}
                  {cohort.shown ? <td /> : null}
                </tr>
              </tbody>
            </table>
          </div>

          {cohort.shown ? (
            <div className="mt-4 space-y-2 border-t pt-4">
              <p className="text-muted-foreground text-[12px]">
                Where these sit among the {cohort.size} people who have completed this assessment.
                Test pass-rate is not code quality, and this is a distribution, not a ranking.
              </p>
              <div className="flex items-end gap-1">
                {cohort.distribution.map((bucket) => {
                  const tallest = Math.max(...cohort.distribution.map((b) => b.count), 1);
                  return (
                    <div key={bucket.from} className="flex flex-1 flex-col items-center gap-1">
                      <span className="text-muted-foreground text-[11px] tabular-nums">
                        {bucket.count}
                      </span>
                      <div
                        className="bg-primary/30 w-full rounded-sm"
                        style={{ height: `${Math.max(4, (bucket.count / tallest) * 44)}px` }}
                        aria-hidden
                      />
                      <span className="text-muted-foreground text-[11px] tabular-nums">
                        {bucket.from}–{bucket.to}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground mt-4 border-t pt-4 text-[12px]">
              {cohort.size} {cohort.size === 1 ? 'person has' : 'people have'} completed this
              assessment. No cohort context is shown below {COHORT_MIN}: a median drawn from a
              handful of people reads as an authoritative middle without being one, and with two it
              simply is the ranking.
            </p>
          )}
        </Section>

        <Section
          title="Human rounds"
          description="What the panels wrote, counted. Subject to the blind rule — a round you owe a scorecard on stays hidden here too."
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[13px]">
              <tbody>
                <tr className="border-b">
                  <td className="w-56 py-2 pr-3 font-medium">Scorecards in</td>
                  {view.candidates.map((candidate) => (
                    <td key={candidate.applicationId} className="px-3 py-2 tabular-nums">
                      {candidate.signal.submittedCount}/{candidate.signal.panelSize}
                      {candidate.signal.partial ? (
                        <span className="text-muted-foreground ml-1.5 text-[12px]">
                          (some hidden from you)
                        </span>
                      ) : null}
                    </td>
                  ))}
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-3 font-medium">Recommendations</td>
                  {view.candidates.map((candidate) => (
                    <td key={candidate.applicationId} className="px-3 py-2">
                      {candidate.signal.distribution.total === 0 ? (
                        <span className="text-muted-foreground">nothing readable yet</span>
                      ) : (
                        <div className="space-y-1">
                          <DistributionBar
                            buckets={candidate.signal.distribution.buckets}
                            total={candidate.signal.distribution.total}
                          />
                          {candidate.signal.disagreement.disagrees ? (
                            <span className="text-warning text-[12px]">
                              panel splits — read the scorecards
                            </span>
                          ) : null}
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-3 font-medium">Completed</td>
                  {view.candidates.map((candidate) => (
                    <td key={candidate.applicationId} className="text-muted-foreground px-3 py-2">
                      {formatDate(candidate.completedAt)}
                    </td>
                  ))}
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-3 font-medium">Decision</td>
                  {view.candidates.map((candidate) => (
                    <td key={candidate.applicationId} className="px-3 py-2">
                      {candidate.decision ? (
                        <DecisionBadge
                          outcome={
                            candidate.decision.outcome as React.ComponentProps<
                              typeof DecisionBadge
                            >['outcome']
                          }
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2 pr-3" />
                  {view.candidates.map((candidate) => (
                    <td key={candidate.applicationId} className="px-3 py-2">
                      <Button asChild size="xs" variant="outline">
                        <Link href={`/admin/applications/${candidate.applicationId}/scorecard`}>
                          Open debrief
                        </Link>
                      </Button>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <p className="text-muted-foreground mt-5 max-w-3xl text-[12px]">
        Columns are in the order you picked them and are never reordered by result. Nothing on this
        page combines these numbers, ranks these people, or recommends an outcome — the decision is
        written by a person, with a reason, on each candidate&apos;s debrief.
      </p>
    </>
  );
}

function Header({ description }: { description?: React.ReactNode }) {
  return (
    <PageHeader
      title="Compare candidates"
      backHref="/admin/review"
      backLabel="Review"
      description={description}
    />
  );
}

export type { CompareCandidate };
