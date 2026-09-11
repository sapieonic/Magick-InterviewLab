import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ClipboardList, FileCode2 } from 'lucide-react';
import { requireStaffPage } from '@/features/auth/guards';
import { getStageForFeedback } from '@/features/feedback/queries';
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

  return (
    <>
      <PageHeader
        title={stage.name}
        backHref={`/admin/applications/${application.id}`}
        backLabel="Application"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link
              href={`/admin/candidates/${application.candidateId}`}
              className="hover:text-primary font-medium transition-colors"
            >
              {application.candidateName}
            </Link>
            {application.jobRoleTitle ? <span>{application.jobRoleTitle}</span> : null}
            <StageTypeBadge type={stage.type} />
            <StageStatusBadge status={stage.status} />
            {stage.blindFeedback ? <Badge variant="outline">Blind</Badge> : null}
            {stage.completedAt ? <span>Completed {formatDate(stage.completedAt)}</span> : null}
          </span>
        }
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/applications/${application.id}/scorecard`}>Debrief</Link>
          </Button>
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
              description="The candidate's answers, so the rubric is filled in beside the thing it judges."
            >
              {submissions.length === 0 ? (
                <p className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
                  <FileCode2 className="size-3.5" aria-hidden />
                  Nothing has been submitted for this assessment yet.
                </p>
              ) : (
                <ul className="space-y-4">
                  {submissions.map((submission) => (
                    <li key={submission.id} className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/admin/submissions/${submission.id}`}
                          className="hover:text-primary min-w-0 flex-1 truncate text-[13px] font-medium transition-colors"
                        >
                          {submission.questionTitle}
                        </Link>
                        <Badge variant="outline">
                          {submission.passedCount}/{submission.totalCount} tests
                        </Badge>
                        <ScoreBadge score={submission.score} />
                        <span className="text-muted-foreground text-[12px]">
                          {formatDate(submission.submittedAt)}
                        </span>
                      </div>
                      <CodeBlock code={submission.sourceCode} maxHeight="20rem" />
                      {submission.results.fatalError ? (
                        <Alert tone="error" title="The run failed before the tests completed">
                          <pre className="font-mono text-[12px] whitespace-pre-wrap">
                            {submission.results.fatalError}
                          </pre>
                        </Alert>
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
