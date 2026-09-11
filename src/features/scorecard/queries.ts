import 'server-only';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { can, isStaff } from '@/features/auth/capabilities';
import { canViewApplication } from '@/features/pipeline/access';
import { AUDIT } from '@/lib/audit';
import {
  blindReason,
  visibleFeedback,
  type BlindReason,
  type FeedbackVisibilityContext,
} from '@/features/feedback/visibility';
import {
  FEEDBACK_SELECT,
  toFeedbackView,
  type CriterionView,
  type FeedbackView,
  type RubricView,
} from '@/features/feedback/queries';
import {
  summariseApplication,
  type AggregateStageInput,
  type ApplicationSignal,
} from './aggregate';
import { parseStoredResults } from '@/features/submissions/stored-results';
import type { SessionUser } from '@/features/auth/session';
import type { PanelMemberView } from '@/features/feedback/queries';
import type {
  ApplicationStatus,
  DecisionOutcome,
  Language,
  StageOutcome,
  StageStatus,
  StageType,
} from '@/generated/prisma/enums';

/**
 * The debrief read model.
 *
 * One query path assembles every stage, the scorecards the viewer is entitled
 * to read, and the aggregate signal. The signal is computed *from the readable
 * scorecards only* — a blinded panellist who is handed the panel's average is
 * anchored exactly as effectively as one who is handed the prose, so the
 * numbers are derived from the same filtered set and every stage carries a
 * `partial` flag when something was withheld.
 */

export interface ScorecardAutomatedRun {
  submissionId: string;
  questionTitle: string;
  language: Language;
  score: number;
  passedCount: number;
  totalCount: number;
  submittedAt: Date;
  unreadable: boolean;
}

export interface ScorecardStageView {
  id: string;
  name: string;
  type: StageType;
  status: StageStatus;
  outcome: StageOutcome | null;
  position: number;
  blindFeedback: boolean;
  scheduledAt: Date | null;
  completedAt: Date | null;
  rubric: RubricView | null;
  panel: PanelMemberView[];
  /** Submitted scorecards this viewer may read, oldest submission first. */
  scorecards: FeedbackView[];
  /** The viewer's own unsubmitted draft, if they have one on this round. */
  viewerHasDraft: boolean;
  hidden: { submitted: number; reason: BlindReason | null };
  automated: ScorecardAutomatedRun[];
}

export interface DecisionHistoryEntry {
  at: Date;
  actorName: string | null;
  outcome: DecisionOutcome | null;
  /** Present on a change, which is the whole reason the log is read. */
  previousOutcome: DecisionOutcome | null;
}

export interface DecisionView {
  outcome: DecisionOutcome;
  rationale: string;
  decidedAt: Date;
  decidedByName: string | null;
  history: DecisionHistoryEntry[];
}

export interface ApplicationScorecard {
  application: {
    id: string;
    status: ApplicationStatus;
    candidateId: string;
    candidateName: string;
    candidateEmail: string;
    jobRoleTitle: string | null;
    ownerName: string | null;
  };
  stages: ScorecardStageView[];
  signal: ApplicationSignal;
  decision: DecisionView | null;
  viewer: { canDecide: boolean };
}

/** Audit metadata is a free-form Json column; read it defensively. */
const decisionMetadataSchema = z.object({
  outcome: z.enum(['HIRE', 'NO_HIRE', 'HOLD']).nullish(),
  previousOutcome: z.enum(['HIRE', 'NO_HIRE', 'HOLD']).nullish(),
});

export async function getApplicationScorecard(
  viewer: SessionUser,
  applicationId: string,
): Promise<ApplicationScorecard | null> {
  if (!isStaff(viewer.role)) return null;
  if (!(await canViewApplication(viewer, applicationId))) return null;

  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      status: true,
      candidate: { select: { id: true, name: true, email: true } },
      jobRole: { select: { title: true } },
      owner: { select: { name: true } },
      stages: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          outcome: true,
          position: true,
          blindFeedback: true,
          scheduledAt: true,
          completedAt: true,
          rubricVersion: {
            select: {
              id: true,
              version: true,
              rubric: { select: { name: true } },
              criteria: {
                orderBy: { position: 'asc' },
                select: {
                  id: true,
                  name: true,
                  description: true,
                  weight: true,
                  maxScore: true,
                  position: true,
                },
              },
            },
          },
          interviewers: {
            orderBy: { createdAt: 'asc' },
            select: { userId: true, role: true, user: { select: { name: true, email: true } } },
          },
          feedback: { select: FEEDBACK_SELECT },
          assignment: { select: { interviewId: true, candidateId: true } },
        },
      },
      decision: {
        select: {
          outcome: true,
          rationale: true,
          decidedAt: true,
          decidedBy: { select: { name: true } },
        },
      },
    },
  });
  if (!application) return null;

  const stages: ScorecardStageView[] = [];
  const aggregateInput: AggregateStageInput[] = [];

  for (const stage of application.stages) {
    const own = stage.feedback.find((row) => row.authorId === viewer.id) ?? null;
    const context: FeedbackVisibilityContext = {
      viewerId: viewer.id,
      stageIsBlind: stage.blindFeedback,
      viewerIsPanelist: stage.interviewers.some((seat) => seat.userId === viewer.id),
      viewerHasSubmitted: own?.status === 'SUBMITTED',
    };

    // Filter first, then keep only what a debrief reads. A draft — including
    // the viewer's own — is not evidence, so it is counted, never rendered.
    const readable = visibleFeedback(stage.feedback, context);
    const readableSubmitted = readable.filter((row) => row.status === 'SUBMITTED');
    const submittedCount = stage.feedback.filter((row) => row.status === 'SUBMITTED').length;

    const criteria: CriterionView[] = stage.rubricVersion?.criteria ?? [];
    const automated =
      stage.type === 'CODING_ASSESSMENT' && stage.assignment
        ? await loadAutomatedRuns(stage.assignment)
        : [];

    const scorecards = readableSubmitted
      .map(toFeedbackView)
      .sort((a, b) => (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0));

    stages.push({
      id: stage.id,
      name: stage.name,
      type: stage.type,
      status: stage.status,
      outcome: stage.outcome,
      position: stage.position,
      blindFeedback: stage.blindFeedback,
      scheduledAt: stage.scheduledAt,
      completedAt: stage.completedAt,
      rubric: stage.rubricVersion
        ? {
            versionId: stage.rubricVersion.id,
            rubricName: stage.rubricVersion.rubric.name,
            version: stage.rubricVersion.version,
            criteria,
          }
        : null,
      panel: stage.interviewers.map((seat) => ({
        userId: seat.userId,
        name: seat.user.name,
        email: seat.user.email,
        role: seat.role,
        hasSubmitted: stage.feedback.some(
          (row) => row.authorId === seat.userId && row.status === 'SUBMITTED',
        ),
      })),
      scorecards,
      viewerHasDraft: own?.status === 'DRAFT',
      hidden: {
        submitted: submittedCount - readableSubmitted.length,
        reason: blindReason(context),
      },
      automated,
    });

    aggregateInput.push({
      stageId: stage.id,
      stageName: stage.name,
      stageType: stage.type,
      criteria,
      scorecards: scorecards.map((card) => ({
        authorId: card.authorId,
        authorName: card.authorName,
        recommendation: card.recommendation,
        scores: card.scores,
      })),
      panelSize: stage.interviewers.length,
      submittedCount,
      automated: automated.map((run) => ({
        submissionId: run.submissionId,
        questionTitle: run.questionTitle,
        score: run.score,
        passedCount: run.passedCount,
        totalCount: run.totalCount,
      })),
    });
  }

  return {
    application: {
      id: application.id,
      status: application.status,
      candidateId: application.candidate.id,
      candidateName: application.candidate.name,
      candidateEmail: application.candidate.email,
      jobRoleTitle: application.jobRole?.title ?? null,
      ownerName: application.owner?.name ?? null,
    },
    stages,
    signal: summariseApplication(aggregateInput),
    decision: application.decision
      ? {
          outcome: application.decision.outcome,
          rationale: application.decision.rationale,
          decidedAt: application.decision.decidedAt,
          decidedByName: application.decision.decidedBy?.name ?? null,
          history: await loadDecisionHistory(applicationId),
        }
      : null,
    viewer: { canDecide: can(viewer.role, 'DECIDE') },
  };
}

async function loadAutomatedRuns(assignment: {
  interviewId: string;
  candidateId: string;
}): Promise<ScorecardAutomatedRun[]> {
  const rows = await prisma.submission.findMany({
    where: { interviewId: assignment.interviewId, candidateId: assignment.candidateId },
    orderBy: { submittedAt: 'desc' },
    select: {
      id: true,
      language: true,
      score: true,
      passedCount: true,
      totalCount: true,
      submittedAt: true,
      results: true,
      question: { select: { title: true } },
    },
  });

  return rows.map((row) => ({
    submissionId: row.id,
    questionTitle: row.question.title,
    language: row.language,
    score: row.score,
    passedCount: row.passedCount,
    totalCount: row.totalCount,
    submittedAt: row.submittedAt,
    // The counts above come from the authoritative columns; this only says
    // whether the per-test detail behind them can still be read.
    unreadable: parseStoredResults(row.results).unreadable,
  }));
}

/**
 * A decision row holds only the current outcome, so a reversal is invisible in
 * it by construction. The history comes from the audit log instead.
 */
async function loadDecisionHistory(applicationId: string): Promise<DecisionHistoryEntry[]> {
  const events = await prisma.auditEvent.findMany({
    where: {
      applicationId,
      action: { in: [AUDIT.DECISION_RECORDED, AUDIT.DECISION_CHANGED] },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      metadata: true,
      actor: { select: { name: true } },
    },
  });

  return events.map((event) => {
    const parsed = decisionMetadataSchema.safeParse(event.metadata);
    return {
      at: event.createdAt,
      actorName: event.actor?.name ?? null,
      outcome: parsed.success ? (parsed.data.outcome ?? null) : null,
      previousOutcome: parsed.success ? (parsed.data.previousOutcome ?? null) : null,
    };
  });
}
