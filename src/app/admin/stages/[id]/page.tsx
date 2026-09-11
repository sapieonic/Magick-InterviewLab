import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ClipboardList, FileCode2, History } from 'lucide-react';
import { requireStaffPage } from '@/features/auth/guards';
import { can } from '@/features/auth/capabilities';
import { getStageForFeedback, type StageSubmissionView } from '@/features/feedback/queries';
import { PageHeader, Section } from '@/components/admin/page-header';
import {
  FeedbackStatusBadge,
  InterviewerRoleBadge,
  ScoreBadge,
  StageStatusBadge,
  StageTypeBadge,
} from '@/components/admin/badges';
import { CodeBlock } from '@/components/admin/code-block';
import { FeedbackForm, NotOnPanelNotice } from '@/components/admin/feedback-form';
import { BlindNotice, ScorecardCard } from '@/components/admin/scorecard';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';

// Static rather than derived from the stage: `generateMetadata` would have to
// load the whole round again — candidate code included — to put a name in the
// tab, and this page is already the heaviest read in the console.
export const metadata: Metadata = { title: 'Scorecard' };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function StagePage({ params }: PageProps) {
  const viewer = await requireStaffPage();
  const { id } = await params;
  const view = await getStageForFeedback(viewer, id);
  // `null` covers "no such stage" and "not yours" alike — see access.ts.
  if (!view) notFound();

  const { stage, application, rubric, own, others, hidden, panel, progress, submissions } = view;
  // Both of these links go somewhere the viewer may not be. The debrief is
  // gated on `VIEW_ALL_APPLICATIONS` and the candidate record on
  // `MANAGE_USERS`; offering either to someone who would be bounced straight
  // back to /admin is a dead end on an interviewer's ordinary path.
  const canOpenDebrief = can(viewer.role, 'VIEW_ALL_APPLICATIONS');
  const canOpenCandidate = can(viewer.role, 'MANAGE_USERS');

  return (
    <>
      <PageHeader
        title={stage.name}
        backHref={`/admin/applications/${application.id}`}
        backLabel="Application"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {canOpenCandidate ? (
              <Link
                href={`/admin/candidates/${application.candidateId}`}
                className="hover:text-primary font-medium transition-colors"
              >
                {application.candidateName}
              </Link>
            ) : (
              <span className="font-medium">{application.candidateName}</span>
            )}
            {application.jobRoleTitle ? <span>{application.jobRoleTitle}</span> : null}
            <StageTypeBadge type={stage.type} />
            <StageStatusBadge status={stage.status} />
            {stage.blindFeedback ? <Badge variant="outline">Blind</Badge> : null}
            {stage.completedAt ? <span>Completed {formatDate(stage.completedAt)}</span> : null}
          </span>
        }
        actions={
          canOpenDebrief ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/admin/applications/${application.id}/scorecard`}>Debrief</Link>
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-5">
          <Section
            title="Your scorecard"
            description={
              view.viewer.canWrite
                ? 'A draft is private to you. Submitting publishes it to the panel.'
                : 'Read-only.'
            }
            actions={own ? <FeedbackStatusBadge status={own.status} /> : undefined}
          >
            {view.viewer.canWrite ? (
              <FeedbackForm
                stageId={stage.id}
                criteria={rubric?.criteria ?? []}
                rubricName={rubric ? `${rubric.rubricName} v${rubric.version}` : null}
                initial={
                  own
                    ? {
                        recommendation: own.recommendation,
                        confidence: own.confidence,
                        summary: own.summary,
                        strengths: own.strengths,
                        concerns: own.concerns,
                        scores: own.scores,
                      }
                    : null
                }
                status={own?.status ?? null}
                revisionCount={own?.revisionCount ?? 0}
              />
            ) : (
              <NotOnPanelNotice />
            )}
          </Section>

          {stage.type === 'CODING_ASSESSMENT' ? (
            <Section
              title="Submitted code"
              description="The candidate's answers, so the rubric is filled in beside the thing it judges. Latest attempt per question; the earlier ones are kept, folded away."
            >
              {submissions.length === 0 ? (
                <p className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
                  <FileCode2 className="size-3.5" aria-hidden />
                  Nothing has been submitted for this assessment yet.
                </p>
              ) : (
                <ul className="space-y-5">
                  {groupByQuestion(submissions).map((group) => (
                    <li key={group.questionTitle} className="min-w-0 space-y-2">
                      <SubmissionHeading
                        submission={group.latest}
                        attempt={group.attempts}
                        attempts={group.attempts}
                      />
                      <CodeBlock code={group.latest.sourceCode} maxHeight="20rem" />
                      {group.latest.results.fatalError ? (
                        <Alert tone="error" title="The run failed before the tests completed">
                          <pre className="font-mono text-[12px] whitespace-pre-wrap">
                            {group.latest.results.fatalError}
                          </pre>
                        </Alert>
                      ) : null}

                      {group.earlier.length > 0 ? (
                        <details className="rounded-md border px-3 py-2">
                          <summary className="flex cursor-pointer flex-wrap items-center gap-1.5 text-[12px] font-medium">
                            <History className="size-3.5 shrink-0" aria-hidden />
                            {group.earlier.length} earlier{' '}
                            {group.earlier.length === 1 ? 'attempt' : 'attempts'}
                            <span className="text-muted-foreground font-normal">
                              · superseded by the code above
                            </span>
                          </summary>
                          <ol className="space-y-3 pt-2.5">
                            {group.earlier.map((submission, index) => (
                              <li key={submission.id} className="min-w-0 space-y-2">
                                <SubmissionHeading
                                  submission={submission}
                                  attempt={group.earlier.length - index}
                                  attempts={group.attempts}
                                />
                                <CodeBlock code={submission.sourceCode} maxHeight="14rem" />
                              </li>
                            ))}
                          </ol>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-5">
          <Section
            title="Panel"
            description={`${progress.submittedCount} of ${progress.panelSize} submitted`}
          >
            {panel.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                Nobody is on this panel yet, so nobody can score it.
              </p>
            ) : (
              <ul className="space-y-2">
                {panel.map((member) => (
                  <li key={member.userId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 flex-1 truncate text-[13px]">{member.name}</span>
                    <InterviewerRoleBadge role={member.role} />
                    <Badge variant={member.hasSubmitted ? 'success' : 'outline'}>
                      {member.hasSubmitted ? 'Submitted' : 'Outstanding'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="The rest of the panel"
            description={
              stage.blindFeedback
                ? 'Blind: nobody on the panel reads another scorecard before submitting their own.'
                : 'This round is not running blind.'
            }
          >
            {hidden.reason === 'OWN_FEEDBACK_PENDING' ? (
              <BlindNotice hiddenSubmitted={hidden.submitted} hiddenDrafts={hidden.drafts} />
            ) : others.length === 0 ? (
              <p className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
                <ClipboardList className="size-3.5" aria-hidden />
                No one else has submitted a scorecard for this round yet.
              </p>
            ) : (
              <div className="space-y-3">
                {others.map((feedback) => (
                  <ScorecardCard
                    key={feedback.id}
                    feedback={feedback}
                    criteria={rubric?.criteria ?? []}
                  />
                ))}
              </div>
            )}
          </Section>
        </aside>
      </div>
    </>
  );
}

/** One question's attempts, newest first. */
interface SubmissionGroup {
  questionTitle: string;
  latest: StageSubmissionView;
  /** Everything the latest one replaced, newest first. */
  earlier: StageSubmissionView[];
  attempts: number;
}

/**
 * Latest attempt per question, questions in the order the candidate first
 * reached them.
 *
 * The flat list this replaces rendered every run as a full code block, so a
 * candidate who resubmitted three times filled the page with two versions of
 * code nobody should be scored on — and the reviewer scrolling it had no way
 * of knowing which block was the answer without comparing timestamps. The
 * superseded runs are still here, because "they tried it this way first" is
 * sometimes the interesting part; they are just not in the way.
 *
 * Grouped by title rather than by question id: the stage read model carries
 * the title and not the id, and a checklist of attempts is not worth widening
 * that query for. Two distinct questions with the same title in one interview
 * would merge, which is a question-bank problem long before it is this page's.
 *
 * The interview's own question order is not in this read model either, so the
 * groups are ordered by their earliest submission — the order the candidate
 * worked in, which is the order a reviewer reading their session expects.
 */
function groupByQuestion(submissions: readonly StageSubmissionView[]): SubmissionGroup[] {
  const byQuestion = new Map<string, StageSubmissionView[]>();
  for (const submission of submissions) {
    const existing = byQuestion.get(submission.questionTitle);
    if (existing) existing.push(submission);
    else byQuestion.set(submission.questionTitle, [submission]);
  }

  const groups: SubmissionGroup[] = [];
  for (const [questionTitle, rows] of byQuestion) {
    // The read model orders newest first, but sorting here rather than
    // trusting that keeps "latest" true if the query's order ever changes.
    const ordered = [...rows].sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
    const [latest, ...earlier] = ordered;
    if (!latest) continue;
    groups.push({ questionTitle, latest, earlier, attempts: ordered.length });
  }

  return groups.sort((a, b) => firstAttemptAt(a) - firstAttemptAt(b));
}

function firstAttemptAt(group: SubmissionGroup): number {
  const oldest = group.earlier.at(-1) ?? group.latest;
  return oldest.submittedAt.getTime();
}

/**
 * The row above a block of code: which attempt it is, how it scored, when it
 * landed.
 *
 * The attempt number is shown only where there is more than one, so a single
 * submission is not dressed up as a sequence.
 *
 * What belongs here and is missing: `Submission.trigger`. An `AUTO_DEADLINE`
 * snapshot of half-finished code renders identically to a deliberate final
 * answer, so a reviewer reads "1/4 tests" as the candidate's judgement rather
 * than as the clock running out. The column exists and is in the generated
 * client, but `loadStageSubmissions` in `src/features/feedback/queries.ts`
 * does not select it and `StageSubmissionView` does not carry it — that file
 * is not this change's to edit, so the badge is deliberately not faked from
 * something else.
 */
function SubmissionHeading({
  submission,
  attempt,
  attempts,
}: {
  submission: StageSubmissionView;
  attempt: number;
  attempts: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link
        href={`/admin/submissions/${submission.id}`}
        className="hover:text-primary min-w-0 flex-1 truncate text-[13px] font-medium transition-colors"
      >
        {submission.questionTitle}
      </Link>
      {attempts > 1 ? (
        <Badge variant="outline">
          Attempt {attempt} of {attempts}
        </Badge>
      ) : null}
      <Badge variant="outline">
        {submission.passedCount}/{submission.totalCount} tests
      </Badge>
      <ScoreBadge score={submission.score} />
      {/* Sits next to the score on purpose: this is the one badge that changes
          what the score *means*. Half-finished work the timer snapshotted and
          a considered final answer are the same row without it, and the
          reviewer on this page is exactly the person who would read 1/4 tests
          as the candidate's judgement. */}
      {submission.trigger === 'AUTO_DEADLINE' ? (
        <Badge
          variant="outline"
          title="The workspace submitted whatever was in the editor when the timer reached zero. The candidate did not choose to stop here."
        >
          Auto-submitted at deadline
        </Badge>
      ) : null}
      <span className="text-muted-foreground text-[12px]">
        {formatDate(submission.submittedAt)}
      </span>
    </div>
  );
}
