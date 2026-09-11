import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireStaffPage } from '@/features/auth/guards';
import { getApplicationScorecard } from '@/features/scorecard/queries';
import { PageHeader, Section } from '@/components/admin/page-header';
import {
  ApplicationStatusBadge,
  StageOutcomeBadge,
  StageStatusBadge,
  StageTypeBadge,
} from '@/components/admin/badges';
import {
  AutomatedPanel,
  BlindNotice,
  EvidenceNotice,
  ScorecardCard,
  SignalPanel,
} from '@/components/admin/scorecard';
import { DecisionForm } from '@/components/admin/decision-form';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';

export const metadata: Metadata = { title: 'Debrief' };

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * The debrief.
 *
 * Everything a decision should be argued from, on one page and in one order:
 * what the panel wrote, what the numbers say about it, where the panel splits,
 * and only then the box the decision goes in. The signal sits under a heading
 * that says it is evidence, because a page that opens with a number invites
 * the reader to treat the number as the answer.
 */
export default async function ApplicationScorecardPage({ params }: PageProps) {
  const viewer = await requireStaffPage();
  const { id } = await params;
  const view = await getApplicationScorecard(viewer, id);
  if (!view) notFound();

  const { application, stages, signal, decision } = view;

  return (
    <>
      <PageHeader
        title={`${application.candidateName} — debrief`}
        backHref={`/admin/applications/${application.id}`}
        backLabel="Application"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {application.jobRoleTitle ? <span>{application.jobRoleTitle}</span> : null}
            <ApplicationStatusBadge status={application.status} />
            {application.ownerName ? <span>Owner: {application.ownerName}</span> : null}
            <span>{application.candidateEmail}</span>
          </span>
        }
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/candidates/${application.candidateId}`}>Candidate</Link>
          </Button>
        }
      />

      <div className="space-y-5">
        <Section
          title="Signal across the process"
          description="Counted from the scorecards you can read, over every round."
        >
          <div className="space-y-4">
            <EvidenceNotice />
            <SignalPanel signal={signal} />
          </div>
        </Section>

        {stages.length === 0 ? (
          <Section title="Rounds">
            <p className="text-muted-foreground text-[13px]">
              This application has no stages yet, so there is nothing to debrief.
            </p>
          </Section>
        ) : null}

        {stages.map((stage) => {
          const stageSignal = signal.stages.find((s) => s.stageId === stage.id);
          return (
            <Section
              key={stage.id}
              title={stage.name}
              description={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StageTypeBadge type={stage.type} />
                  <StageStatusBadge status={stage.status} />
                  {stage.outcome ? <StageOutcomeBadge outcome={stage.outcome} /> : null}
                  {stage.blindFeedback ? <Badge variant="outline">Blind</Badge> : null}
                  {stage.completedAt ? <span>{formatDate(stage.completedAt)}</span> : null}
                </span>
              }
              actions={
                <Button asChild size="xs" variant="outline">
                  <Link href={`/admin/stages/${stage.id}`}>Open round</Link>
                </Button>
              }
            >
              <div className="space-y-4">
                {stageSignal ? <SignalPanel signal={stageSignal} /> : null}

                {stage.viewerHasDraft ? (
                  <Alert tone="warning" title="You have an unsubmitted draft on this round">
                    A draft is not evidence and is not counted here. Submit it so the panel — and
                    this debrief — can read it.
                  </Alert>
                ) : null}

                {stage.hidden.reason === 'OWN_FEEDBACK_PENDING' ? (
                  <BlindNotice hiddenSubmitted={stage.hidden.submitted} />
                ) : null}

                {stage.scorecards.length === 0 ? (
                  <p className="text-muted-foreground text-[13px]">
                    {stage.hidden.submitted > 0
                      ? 'Nothing you can read yet on this round.'
                      : `No scorecards have been submitted for this round. ${stage.panel.length} ${stage.panel.length === 1 ? 'person is' : 'people are'} on the panel.`}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {stage.scorecards.map((feedback) => (
                      <ScorecardCard
                        key={feedback.id}
                        feedback={feedback}
                        criteria={stage.rubric?.criteria ?? []}
                      />
                    ))}
                  </div>
                )}

                {stage.type === 'CODING_ASSESSMENT' ? (
                  <div className="space-y-2 border-t pt-4">
                    <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                      Automated results — one input among several
                    </p>
                    <AutomatedPanel runs={stage.automated} />
                  </div>
                ) : null}
              </div>
            </Section>
          );
        })}

        <Section
          title="Decision"
          description="Written by a person, with a reason. Nothing on this page decides it."
        >
          {view.viewer.canDecide ? (
            <DecisionForm
              applicationId={application.id}
              applicationStatus={application.status}
              decision={decision}
            />
          ) : decision ? (
            <div className="space-y-2">
              <p className="text-[13px]">
                Recorded by {decision.decidedByName ?? 'someone no longer on the system'} on{' '}
                {formatDate(decision.decidedAt)}.
              </p>
              <p className="text-muted-foreground text-[13px] whitespace-pre-wrap">
                {decision.rationale}
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground text-[13px]">
              No decision has been recorded. The hiring manager or an admin records it here.
            </p>
          )}
        </Section>
      </div>
    </>
  );
}
