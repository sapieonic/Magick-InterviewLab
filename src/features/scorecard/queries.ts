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
import { countScorecards, isExpectedToScore } from '@/features/pipeline/stage-status';
import {
  effectiveStageStatus,
  FEEDBACK_SELECT,
  toFeedbackView,
  type CriterionView,
  type FeedbackView,
  type RubricView,
} from '@/features/feedback/queries';
import {
  RECOMMENDATION_ORDER,
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
  Recommendation,
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
  /** Derived, never the stored row — see `effectiveStageStatus`. */
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

/**
 * The aggregate signal as it stood when the call was made.
 *
 * `Decision.snapshot` has been written since the feature shipped and read by
 * nothing, which made the column's own promise — "so a later reader sees what
 * the decider saw rather than what the data says today" — untrue. A scorecard
 * submitted or revised after the decision changes every number on this page;
 * this is the only record of the ones the decider was actually looking at.
 */
export interface DecisionSnapshotView {
  capturedAt: Date | null;
  panelSize: number;
  submittedCount: number;
  outstandingCount: number;
  distribution: {
    buckets: Array<{ recommendation: Recommendation; count: number }>;
    total: number;
  };
  /** True when the blind rule withheld part of the evidence from the decider. */
  partial: boolean;
}

export interface DecisionView {
  outcome: DecisionOutcome;
  rationale: string;
  decidedAt: Date;
  decidedByName: string | null;
  history: DecisionHistoryEntry[];
  /** Null for a decision recorded before snapshots, or one whose JSON will not
   *  parse — never silently replaced with today's numbers. */
  snapshot: DecisionSnapshotView | null;
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

/** Same treatment for `Decision.snapshot`, written by `buildSnapshot`. */
const decisionSnapshotSchema = z.object({
  capturedAt: z.string().nullish(),
  signal: z.object({
    panelSize: z.number(),
    submittedCount: z.number(),
    outstandingCount: z.number(),
    partial: z.boolean().nullish(),
    distribution: z.object({
      total: z.number(),
      buckets: z.array(
        z.object({ recommendation: z.enum(RECOMMENDATION_ORDER), count: z.number() }),
      ),
    }),
  }),
});

function toDecisionSnapshotView(snapshot: unknown): DecisionSnapshotView | null {
  const parsed = decisionSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) return null;
  const { capturedAt, signal } = parsed.data;
  const at = capturedAt ? new Date(capturedAt) : null;
  return {
    capturedAt: at !== null && !Number.isNaN(at.getTime()) ? at : null,
    panelSize: signal.panelSize,
    submittedCount: signal.submittedCount,
    outstandingCount: signal.outstandingCount,
    distribution: signal.distribution,
    partial: signal.partial ?? false,
  };
}

/**
 * The debrief is gated on `VIEW_ALL_APPLICATIONS`, not on a seat.
 *
 * `getPanelSeat` already 404s an interviewer on a round they did not sit, so
 * gating this page on `canViewApplication` — which one seat anywhere
 * satisfies — meant the two read paths over the same rows disagreed: a shadow
 * on a thirty-minute screen was refused round four's stage page and handed the
 * whole debrief, every other round's prose, the aggregate and the recorded
 * decision, from this one. The documented rule is that an interviewer sees the
 * candidates they sit on; reading the entire process is a different thing, and
 * it belongs to the roles that own the process.
 */
export async function getApplicationScorecard(
  viewer: SessionUser,
  applicationId: string,
): Promise<ApplicationScorecard | null> {
  if (!isStaff(viewer.role)) return null;
  if (!can(viewer.role, 'VIEW_ALL_APPLICATIONS')) return null;
  // Still asked, so a debrief for an application that does not exist is the
  // same `null` as one the viewer may not have.
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
          assignment: { select: { interviewId: true, candidateId: true, status: true } },
        },
      },
      decision: {
        select: {
          outcome: true,
          rationale: true,
          decidedAt: true,
          snapshot: true,
          decidedBy: { select: { name: true } },
        },
      },
    },
  });
  if (!application) return null;

  const stages: ScorecardStageView[] = [];
  const aggregateInput: AggregateStageInput[] = [];

  // One query for every coding round on the application rather than one per
  // round inside the loop below. The debrief is the heaviest read in the
  // console and each of those queries pulled every submission's full `results`
  // JSON; `pipeline/queries.ts` solves the same problem the same way.
  const automatedByAssignment = await loadAutomatedRuns(
    application.stages.flatMap((stage) =>
      stage.type === 'CODING_ASSESSMENT' && stage.assignment ? [stage.assignment] : [],
    ),
  );

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

    const status = effectiveStageStatus(stage);
    // The same denominator the board and the stage page use. A shadow is an
    // observer: their scorecard is not expected, and not counted if they write
    // one — otherwise a round with two panellists and a keen shadow renders
    // "3 of 2 scorecards in".
    const counts = countScorecards(stage.interviewers, stage.feedback, status);
    const expectedAuthors = new Set(
      stage.interviewers.filter((seat) => isExpectedToScore(seat.role)).map((seat) => seat.userId),
    );

    const criteria: CriterionView[] = stage.rubricVersion?.criteria ?? [];
    const automated =
      stage.type === 'CODING_ASSESSMENT' && stage.assignment
        ? (automatedByAssignment.get(assignmentKey(stage.assignment)) ?? [])
        : [];

    const scorecards = readableSubmitted
      .map((row) => toFeedbackView(row, stage.feedback))
      .sort((a, b) => (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0));

    stages.push({
      id: stage.id,
      name: stage.name,
      type: stage.type,
      status,
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
        // Counted from the withheld rows themselves rather than subtracted
        // from a total, so it cannot go negative when the two counts are on
        // different bases — a shadow's readable scorecard is one such row.
        submitted: stage.feedback.filter(
          (row) => row.status === 'SUBMITTED' && !readable.some((r) => r.id === row.id),
        ).length,
        reason: blindReason(context),
      },
      automated,
    });

    aggregateInput.push({
      stageId: stage.id,
      stageName: stage.name,
      stageType: stage.type,
      criteria,
      // The *panel's* verdict, so the same seats the denominator counts. A
      // shadow's scorecard is still shown above — they sat in the room and
      // wrote something — but it is not folded into the distribution any more
      // than it is folded into the fraction.
      scorecards: scorecards
        .filter((card) => expectedAuthors.has(card.authorId))
        .map((card) => ({
          authorId: card.authorId,
          authorName: card.authorName,
          recommendation: card.recommendation,
          scores: card.scores,
        })),
      panelSize: counts.expected,
      submittedCount: counts.submitted,
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
          snapshot: toDecisionSnapshotView(application.decision.snapshot),
        }
      : null,
    viewer: { canDecide: can(viewer.role, 'DECIDE') },
  };
}

interface AssignmentKey {
  interviewId: string;
  candidateId: string;
}

/** A submission belongs to an (interview, candidate) pair, so both halves are
 *  the key — an application whose candidate changed would otherwise collide. */
function assignmentKey(assignment: AssignmentKey): string {
  return `${assignment.interviewId}:${assignment.candidateId}`;
}

/**
 * Every coding round's automated results, in one query.
 *
 * Previously one `findMany` per coding stage, run inside the stage loop and
 * each pulling the full `results` JSON of every submission — the classic N+1,
 * on the page that already loads the most. Batched with an `IN`, exactly as
 * `summariseSubmissions` in `pipeline/queries.ts` does.
 */
async function loadAutomatedRuns(
  assignments: readonly AssignmentKey[],
): Promise<Map<string, ScorecardAutomatedRun[]>> {
  const out = new Map<string, ScorecardAutomatedRun[]>();
  if (assignments.length === 0) return out;

  const rows = await prisma.submission.findMany({
    where: {
      interviewId: { in: [...new Set(assignments.map((a) => a.interviewId))] },
      candidateId: { in: [...new Set(assignments.map((a) => a.candidateId))] },
    },
    orderBy: { submittedAt: 'desc' },
    select: {
      id: true,
      interviewId: true,
      candidateId: true,
      language: true,
      score: true,
      passedCount: true,
      totalCount: true,
      submittedAt: true,
      results: true,
      question: { select: { title: true } },
    },
  });

  // The `IN` pair is a cross product, so a row for an (interview, candidate)
  // combination nobody asked for is possible; key the buckets and drop it.
  const wanted = new Set(assignments.map(assignmentKey));
  for (const row of rows) {
    const key = assignmentKey(row);
    if (!wanted.has(key)) continue;
    const bucket = out.get(key) ?? [];
    bucket.push({
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
    });
    out.set(key, bucket);
  }
  return out;
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
