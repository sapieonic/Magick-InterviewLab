import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Check, Minus } from 'lucide-react';
import { requireStaffPage } from '@/features/auth/guards';
import { can } from '@/features/auth/capabilities';
import {
  getApplicationScorecard,
  type ApplicationScorecard,
  type ScorecardStageView,
} from '@/features/scorecard/queries';
import { PageHeader, Section } from '@/components/admin/page-header';
import {
  ApplicationStatusBadge,
  DecisionBadge,
  StageOutcomeBadge,
  StageStatusBadge,
  StageTypeBadge,
} from '@/components/admin/badges';
import {
  AutomatedPanel,
  BlindNotice,
  DecisionSnapshotPanel,
  EvidenceNotice,
  ScorecardCard,
  SignalPanel,
} from '@/components/admin/scorecard';
import { DecisionForm } from '@/components/admin/decision-form';
import { CloseOutPanel } from '@/components/admin/close-out';
import { Markdown } from '@/components/markdown';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn, formatDate } from '@/lib/utils';

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
          // The candidate record needs `MANAGE_USERS`, so for anyone else this
          // button was a redirect back to /admin dressed as a link.
          can(viewer.role, 'MANAGE_USERS') ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/admin/candidates/${application.candidateId}`}>Candidate</Link>
            </Button>
          ) : undefined
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
          {/* The checklist lives here, beside the box, rather than at the top
              of the page. It is the last look before the click — "is this
              everything there is to know" — and a reader who met it above the
              evidence would read it as a list of conditions to satisfy rather
              than a description of what they have.

              Sticky is bought cheaply: the grid is this section's own, so the
              rest of the page is still the single column it was, and the long
              left-hand side (rationale, history, snapshot, close-out) scrolls
              past a checklist that stays put. `top-20` clears the sticky admin
              header. */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <EvidenceChecklist
              stages={stages}
              signal={signal}
              className="lg:sticky lg:top-20 lg:col-start-2 lg:row-start-1 lg:self-start"
            />

            <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-1">
              {view.viewer.canDecide ? (
                <DecisionForm
                  applicationId={application.id}
                  applicationStatus={application.status}
                  decision={decision}
                />
              ) : decision ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* The outcome itself. This branch used to render the decider,
                        the date and the reasoning but never whether the answer was
                        hire or no hire — so a recruiter could read the argument
                        for a decision and not the decision. */}
                    <DecisionBadge outcome={decision.outcome} />
                    <span className="text-muted-foreground text-[12px]">
                      Recorded by {decision.decidedByName ?? 'someone no longer on the system'} on{' '}
                      {formatDate(decision.decidedAt)}
                    </span>
                  </div>
                  {/* Markdown, as `DecisionForm` renders it and as the textarea's
                      own hint promises. Whether a rationale renders should not
                      depend on the reader's role. */}
                  <Markdown content={decision.rationale} className="text-[13px]" />
                </div>
              ) : (
                <p className="text-muted-foreground text-[13px]">
                  No decision has been recorded. The hiring manager or an admin records it here.
                </p>
              )}

              {/* Shown to whoever holds `MANAGE_PIPELINE`, which is not
                  necessarily the decider — a recruiter reading this page is
                  exactly the person the hand-off is addressed to. It renders
                  itself away when there is no decision, no capability, or
                  nothing left open. */}
              <CloseOutPanel
                applicationId={application.id}
                applicationStatus={application.status}
                outcome={decision?.outcome ?? null}
                canManagePipeline={can(viewer.role, 'MANAGE_PIPELINE')}
              />

              {decision?.snapshot ? <DecisionSnapshotPanel snapshot={decision.snapshot} /> : null}
            </div>
          </div>
        </Section>
      </div>
    </>
  );
}

/**
 * One line of the evidence checklist.
 *
 * Three states, not two. "The question does not arise" — no coding round on
 * this process, one scorecard so nothing to disagree with — is a different
 * fact from "no", and collapsing the two would put a cross against a round
 * that was never run.
 */
interface ChecklistRow {
  label: string;
  state: 'yes' | 'no' | 'na';
  detail: string;
}

/**
 * What the decider can see, stated as facts.
 *
 * Every row is a description of the evidence, never a condition on the
 * decision: nothing here computes a suggested outcome, and — the part worth
 * being explicit about — nothing here disables the button. A half-ticked list
 * is a legitimate place to decide from. A panel may deliberately stop after
 * two rounds; a candidate may withdraw; a manager may have to call it before
 * the last scorecard lands. What matters is not that the gaps are closed but
 * that the person who decided could see them, and that is already recorded:
 * `Decision.snapshot` captures the signal as this decider read it, blind rule
 * included, so "what did they know" is answerable six months later from the
 * record rather than from this page's current numbers. A gate here would only
 * teach people to chase ticks.
 *
 * Built entirely from what `getApplicationScorecard` already returned. No row
 * is worth a second query on the heaviest read in the console.
 */
function buildChecklist(
  stages: readonly ScorecardStageView[],
  signal: ApplicationScorecard['signal'],
): ChecklistRow[] {
  const unresolved = stages.filter(
    (stage) => stage.status !== 'COMPLETE' && stage.status !== 'SKIPPED',
  );
  const coding = stages.filter((stage) => stage.type === 'CODING_ASSESSMENT');
  // A submitted scorecard on the coding round is the evidence this read model
  // carries that a human opened the code. Reviewer notes on the submission
  // itself would be the stronger signal — they are written against the code
  // rather than against the round — but they are not in the debrief's read
  // model, and a checklist row is not worth widening it for. `hidden.submitted`
  // counts scorecards the blind rule withholds from *this* reader: still a
  // person who read the code, which is what the row asks.
  const codeRead = coding.some(
    (stage) => stage.scorecards.length > 0 || stage.hidden.submitted > 0,
  );
  const comparable = signal.distribution.total;

  return [
    {
      label: 'All human rounds complete',
      state: stages.length === 0 ? 'na' : unresolved.length === 0 ? 'yes' : 'no',
      detail:
        stages.length === 0
          ? 'There are no rounds on this application.'
          : unresolved.length === 0
            ? `All ${stages.length} ${stages.length === 1 ? 'round is' : 'rounds are'} complete or skipped.`
            : `${unresolved.length} of ${stages.length} still running: ${unresolved
                .map((stage) => stage.name)
                .join(', ')}.`,
    },
    {
      label: 'All scorecards in',
      state: signal.outstandingCount === 0 ? 'yes' : 'no',
      detail:
        signal.outstandingCount === 0
          ? `${signal.submittedCount} of ${signal.panelSize} panel seats have written one.`
          : `${signal.outstandingCount} ${signal.outstandingCount === 1 ? 'seat has' : 'seats have'} not written one yet.`,
    },
    {
      label: 'Code read by a person',
      state: coding.length === 0 ? 'na' : codeRead ? 'yes' : 'no',
      detail:
        coding.length === 0
          ? 'No coding round on this process.'
          : codeRead
            ? 'Someone scored the coding round, so the code was not left to the test runner.'
            : 'Only the automated results exist for the coding round. Nobody has scored it.',
    },
    {
      label: 'Panel agreement',
      state: comparable < 2 ? 'na' : signal.disagreement.disagrees ? 'no' : 'yes',
      detail:
        comparable < 2
          ? 'Fewer than two readable scorecards, so there is nothing to compare.'
          : signal.disagreement.disagrees
            ? 'The panel disagrees — say in the rationale how you weighed it.'
            : 'Nobody is pulling against the rest.',
    },
    {
      label: 'Nothing hidden from you',
      state: signal.partial ? 'no' : 'yes',
      detail: signal.partial
        ? 'The blind rule is withholding scorecards from you, so the numbers above are over a subset.'
        : 'Everything the panel has submitted is readable on this page.',
    },
  ];
}

/**
 * The checklist itself.
 *
 * Tick, dash, and nothing else — no cross, no count of "4/5", no progress
 * bar. A score out of five is a verdict on the evidence, and this product does
 * not hand out verdicts on anything, least of all on itself. The amber is
 * carried by the icon rather than the body text, as `Alert` does and for the
 * same contrast reason.
 */
function EvidenceChecklist({
  stages,
  signal,
  className,
}: {
  stages: readonly ScorecardStageView[];
  signal: ApplicationScorecard['signal'];
  className?: string;
}) {
  const rows = buildChecklist(stages, signal);

  return (
    <div className={cn('bg-muted/30 min-w-0 space-y-3 rounded-md border px-3 py-3', className)}>
      <div className="space-y-0.5">
        <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          What you can see
        </p>
        <p className="text-muted-foreground text-[12px]">
          Facts about the evidence, not conditions on the decision.
        </p>
      </div>

      <ul className="space-y-2.5">
        {rows.map((row) => (
          <li key={row.label} className="flex items-start gap-2">
            {row.state === 'yes' ? (
              <Check className="text-success mt-px size-3.5 shrink-0" aria-hidden />
            ) : (
              <Minus
                className={cn(
                  'mt-px size-3.5 shrink-0',
                  row.state === 'no' ? 'text-warning' : 'text-muted-foreground',
                )}
                aria-hidden
              />
            )}
            <span className="min-w-0 space-y-0.5">
              <span className="block text-[13px] font-medium">{row.label}</span>
              <span className="text-muted-foreground block text-[12px]">{row.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground border-t pt-2.5 text-[12px]">
        A dash does not stop you deciding. It is recorded with the decision, so a later reader sees
        what you were looking at.
      </p>
    </div>
  );
}
