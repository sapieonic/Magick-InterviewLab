import 'server-only';
import { prisma } from '@/lib/db/prisma';
import { can, isStaff } from '@/features/auth/capabilities';
import { canViewApplication, getPanelSeat } from '@/features/pipeline/access';
import {
  blindReason,
  visibleFeedback,
  type BlindReason,
  type FeedbackVisibilityContext,
} from '@/features/feedback/visibility';
import { parseStoredResults, type ParsedResults } from '@/features/submissions/stored-results';
import type { SessionUser } from '@/features/auth/session';
import type {
  Confidence,
  FeedbackStatus,
  InterviewerRole,
  Language,
  Recommendation,
  StageStatus,
  StageType,
} from '@/generated/prisma/enums';

/**
 * Read models for writing and reading scorecards.
 *
 * The blind rule lives here, not in a page. Every path that can load somebody
 * else's feedback runs the rows through `visibleFeedback` before returning, so
 * a page cannot leak what it was never handed — and the counts that replace
 * the withheld rows are counts, never a redacted copy of the content.
 *
 * Two gates apply to every exported function, in this order: is the viewer
 * staff at all (`isStaff`, which is false for a candidate), and may they see
 * *this* application (`access.ts`). A candidate reaching any of these gets an
 * empty result or `null`, never a partially-filled one.
 */

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

function ageInDays(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / MILLIS_PER_DAY));
}

/**
 * When the clock on a scorecard started.
 *
 * A stage that is finished but unscored is the thing being chased, so its
 * completion time is the honest start; a stage that has not completed falls
 * back to when it was meant to happen, and finally to when it was created, so
 * a round nobody ever scheduled still ages rather than sitting at zero days
 * forever.
 */
function waitingSince(stage: {
  completedAt: Date | null;
  scheduledAt: Date | null;
  createdAt: Date;
}): Date {
  return stage.completedAt ?? stage.scheduledAt ?? stage.createdAt;
}

export interface CriterionView {
  id: string;
  name: string;
  description: string;
  weight: number;
  maxScore: number;
  position: number;
}

export interface RubricView {
  versionId: string;
  rubricName: string;
  version: number;
  criteria: CriterionView[];
}

export interface FeedbackScoreView {
  criterionId: string;
  score: number;
  note: string;
}

export interface FeedbackView {
  id: string;
  authorId: string;
  authorName: string;
  status: FeedbackStatus;
  recommendation: Recommendation | null;
  confidence: Confidence | null;
  summary: string;
  strengths: string;
  concerns: string;
  rubricVersionId: string | null;
  submittedAt: Date | null;
  updatedAt: Date;
  revisionCount: number;
  scores: FeedbackScoreView[];
}

export interface PanelMemberView {
  userId: string;
  name: string;
  email: string;
  role: InterviewerRole;
  /** Status only. The blind rule withholds content, never the fact of a seat. */
  hasSubmitted: boolean;
}

export interface HiddenFeedbackSummary {
  /** Submitted scorecards the viewer may not read yet. */
  submitted: number;
  /** Other people's drafts. Always withheld, from everyone, forever. */
  drafts: number;
  reason: BlindReason | null;
}

export interface StageSubmissionView {
  id: string;
  questionTitle: string;
  language: Language;
  sourceCode: string;
  score: number;
  passedCount: number;
  totalCount: number;
  submittedAt: Date;
  results: ParsedResults;
}

export interface StageFeedbackView {
  stage: {
    id: string;
    name: string;
    type: StageType;
    status: StageStatus;
    blindFeedback: boolean;
    scheduledAt: Date | null;
    completedAt: Date | null;
  };
  application: {
    id: string;
    candidateId: string;
    candidateName: string;
    candidateEmail: string;
    jobRoleTitle: string | null;
  };
  rubric: RubricView | null;
  viewer: {
    isPanelist: boolean;
    /** On the panel *and* allowed to write scorecards at all. */
    canWrite: boolean;
    hasSubmitted: boolean;
  };
  own: FeedbackView | null;
  others: FeedbackView[];
  hidden: HiddenFeedbackSummary;
  panel: PanelMemberView[];
  progress: { panelSize: number; submittedCount: number; outstandingCount: number };
  /** Only populated for CODING_ASSESSMENT stages. */
  submissions: StageSubmissionView[];
}

/** The `select` used everywhere a full scorecard is loaded. */
export const FEEDBACK_SELECT = {
  id: true,
  authorId: true,
  status: true,
  recommendation: true,
  confidence: true,
  summary: true,
  strengths: true,
  concerns: true,
  rubricVersionId: true,
  submittedAt: true,
  updatedAt: true,
  author: { select: { name: true } },
  scores: { select: { criterionId: true, score: true, note: true } },
  _count: { select: { revisions: true } },
} as const;

export type FeedbackRow = {
  id: string;
  authorId: string;
  status: FeedbackStatus;
  recommendation: Recommendation | null;
  confidence: Confidence | null;
  summary: string;
  strengths: string;
  concerns: string;
  rubricVersionId: string | null;
  submittedAt: Date | null;
  updatedAt: Date;
  author: { name: string };
  scores: Array<{ criterionId: string; score: number; note: string }>;
  _count: { revisions: number };
};

export function toFeedbackView(row: FeedbackRow): FeedbackView {
  return {
    id: row.id,
    authorId: row.authorId,
    authorName: row.author.name,
    status: row.status,
    recommendation: row.recommendation,
    confidence: row.confidence,
    summary: row.summary,
    strengths: row.strengths,
    concerns: row.concerns,
    rubricVersionId: row.rubricVersionId,
    submittedAt: row.submittedAt,
    updatedAt: row.updatedAt,
    revisionCount: row._count.revisions,
    scores: row.scores,
  };
}

/**
 * Everything the scorecard surface needs for one stage.
 *
 * Returns `null` when the stage does not exist *or* the viewer may not reach
 * it, so the page can `notFound()` on both without leaking which it was.
 */
export async function getStageForFeedback(
  viewer: SessionUser,
  stageId: string,
): Promise<StageFeedbackView | null> {
  // `getPanelSeat` already refuses a candidate and anyone who is neither on
  // the panel nor entitled to read every application.
  const seat = await getPanelSeat(viewer, stageId);
  if (!seat) return null;

  const stage = await prisma.stage.findUnique({
    where: { id: stageId },
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      blindFeedback: true,
      scheduledAt: true,
      completedAt: true,
      application: {
        select: {
          id: true,
          candidate: { select: { id: true, name: true, email: true } },
          jobRole: { select: { title: true } },
        },
      },
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
        select: {
          userId: true,
          role: true,
          user: { select: { name: true, email: true } },
        },
      },
      feedback: { select: FEEDBACK_SELECT },
      assignment: { select: { interviewId: true, candidateId: true } },
    },
  });
  if (!stage) return null;

  const ownRow = stage.feedback.find((row) => row.authorId === viewer.id) ?? null;

  const context: FeedbackVisibilityContext = {
    viewerId: viewer.id,
    stageIsBlind: stage.blindFeedback,
    viewerIsPanelist: seat.isPanelist,
    viewerHasSubmitted: ownRow?.status === 'SUBMITTED',
  };

  // The single gate. Everything downstream reads `readable`, never
  // `stage.feedback`, so there is exactly one place to get this wrong.
  const readable = visibleFeedback(stage.feedback, context);
  const readableIds = new Set(readable.map((row) => row.id));
  const withheld = stage.feedback.filter((row) => !readableIds.has(row.id));

  const submittedCount = stage.feedback.filter((row) => row.status === 'SUBMITTED').length;

  const submissions =
    stage.type === 'CODING_ASSESSMENT' && stage.assignment
      ? await loadStageSubmissions(stage.assignment)
      : [];

  return {
    stage: {
      id: stage.id,
      name: stage.name,
      type: stage.type,
      status: stage.status,
      blindFeedback: stage.blindFeedback,
      scheduledAt: stage.scheduledAt,
      completedAt: stage.completedAt,
    },
    application: {
      id: stage.application.id,
      candidateId: stage.application.candidate.id,
      candidateName: stage.application.candidate.name,
      candidateEmail: stage.application.candidate.email,
      jobRoleTitle: stage.application.jobRole?.title ?? null,
    },
    rubric: stage.rubricVersion
      ? {
          versionId: stage.rubricVersion.id,
          rubricName: stage.rubricVersion.rubric.name,
          version: stage.rubricVersion.version,
          criteria: stage.rubricVersion.criteria,
        }
      : null,
    viewer: {
      isPanelist: seat.isPanelist,
      canWrite: seat.isPanelist && can(viewer.role, 'GIVE_FEEDBACK'),
      hasSubmitted: context.viewerHasSubmitted,
    },
    own: ownRow ? toFeedbackView(ownRow) : null,
    others: readable
      .filter((row) => row.authorId !== viewer.id)
      .map(toFeedbackView)
      .sort((a, b) => (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0)),
    hidden: {
      submitted: withheld.filter((row) => row.status === 'SUBMITTED').length,
      drafts: withheld.filter((row) => row.status === 'DRAFT').length,
      reason: blindReason(context),
    },
    panel: stage.interviewers.map((seatRow) => ({
      userId: seatRow.userId,
      name: seatRow.user.name,
      email: seatRow.user.email,
      role: seatRow.role,
      hasSubmitted: stage.feedback.some(
        (row) => row.authorId === seatRow.userId && row.status === 'SUBMITTED',
      ),
    })),
    progress: {
      panelSize: stage.interviewers.length,
      submittedCount,
      outstandingCount: Math.max(0, stage.interviewers.length - submittedCount),
    },
    submissions,
  };
}

/**
 * The candidate's code for a coding round, so the rubric can be filled in
 * beside the thing it is judging rather than from memory of another tab.
 */
async function loadStageSubmissions(assignment: {
  interviewId: string;
  candidateId: string;
}): Promise<StageSubmissionView[]> {
  const rows = await prisma.submission.findMany({
    where: { interviewId: assignment.interviewId, candidateId: assignment.candidateId },
    orderBy: { submittedAt: 'desc' },
    select: {
      id: true,
      language: true,
      sourceCode: true,
      score: true,
      passedCount: true,
      totalCount: true,
      submittedAt: true,
      results: true,
      question: { select: { title: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    questionTitle: row.question.title,
    language: row.language,
    sourceCode: row.sourceCode,
    score: row.score,
    passedCount: row.passedCount,
    totalCount: row.totalCount,
    submittedAt: row.submittedAt,
    results: parseStoredResults(row.results),
  }));
}

export interface MyFeedbackRow {
  stageId: string;
  stageName: string;
  stageType: StageType;
  stageStatus: StageStatus;
  applicationId: string;
  candidateName: string;
  jobRoleTitle: string | null;
  status: FeedbackStatus | null;
  submittedAt: Date | null;
  waitingSince: Date;
  ageDays: number;
}

/**
 * The viewer's own queue.
 *
 * Age is the product, not a decoration: feedback that arrives a fortnight
 * later is written from memory, and the only thing that reliably shortens the
 * gap is showing someone how long they have been the blocker. Outstanding
 * rounds sort first and oldest to newest; submitted ones stay listed so the
 * page is also the way back to a scorecard you want to revise.
 *
 * `now` is a parameter so the ageing can be pinned by a test.
 */
export async function listMyFeedback(
  viewer: SessionUser,
  now: Date = new Date(),
): Promise<MyFeedbackRow[]> {
  if (!isStaff(viewer.role)) return [];

  const seats = await prisma.stageInterviewer.findMany({
    where: {
      userId: viewer.id,
      // A skipped round is not work, and a closed application's outstanding
      // scorecard is history rather than a task.
      stage: {
        status: { not: 'SKIPPED' },
        application: { status: { in: ['ACTIVE', 'ON_HOLD'] } },
      },
    },
    select: {
      stage: {
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          scheduledAt: true,
          completedAt: true,
          createdAt: true,
          application: {
            select: {
              id: true,
              candidate: { select: { name: true } },
              jobRole: { select: { title: true } },
            },
          },
          // Scoped to the viewer: this is their own scorecard, which
          // `visibility.ts` always lets an author read.
          feedback: {
            where: { authorId: viewer.id },
            select: { status: true, submittedAt: true },
          },
        },
      },
    },
  });

  const rows = seats.map(({ stage }) => {
    const own = stage.feedback[0] ?? null;
    const since = waitingSince(stage);
    return {
      stageId: stage.id,
      stageName: stage.name,
      stageType: stage.type,
      stageStatus: stage.status,
      applicationId: stage.application.id,
      candidateName: stage.application.candidate.name,
      jobRoleTitle: stage.application.jobRole?.title ?? null,
      status: own?.status ?? null,
      submittedAt: own?.submittedAt ?? null,
      waitingSince: since,
      ageDays: ageInDays(since, now),
    };
  });

  return rows.sort((a, b) => {
    const aDone = a.status === 'SUBMITTED';
    const bDone = b.status === 'SUBMITTED';
    if (aDone !== bDone) return aDone ? 1 : -1;
    return a.waitingSince.getTime() - b.waitingSince.getTime();
  });
}

export interface OutstandingOwner {
  userId: string;
  name: string;
  email: string;
  /** `DRAFT` means started and not submitted — still owed. */
  status: 'NONE' | 'DRAFT';
}

export interface OutstandingFeedbackRow {
  stageId: string;
  stageName: string;
  stageType: StageType;
  stageStatus: StageStatus;
  applicationId: string;
  candidateName: string;
  jobRoleTitle: string | null;
  panelSize: number;
  submittedCount: number;
  waitingSince: Date;
  ageDays: number;
  owed: OutstandingOwner[];
}

/**
 * Who owes what, across the pipeline — the recruiter's and hiring manager's
 * chase list.
 *
 * Only *status* crosses this boundary. Knowing that a colleague has a draft
 * open is what makes the chase possible; reading it is what the blind rule
 * exists to prevent, and no prose or score is selected here at all.
 */
export async function listOutstandingFeedback(
  viewer: SessionUser,
  now: Date = new Date(),
): Promise<OutstandingFeedbackRow[]> {
  if (!isStaff(viewer.role) || !can(viewer.role, 'VIEW_ALL_APPLICATIONS')) return [];

  const stages = await prisma.stage.findMany({
    where: {
      status: { not: 'SKIPPED' },
      application: { status: { in: ['ACTIVE', 'ON_HOLD'] } },
      interviewers: { some: {} },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      scheduledAt: true,
      completedAt: true,
      createdAt: true,
      application: {
        select: {
          id: true,
          candidate: { select: { name: true } },
          jobRole: { select: { title: true } },
        },
      },
      interviewers: {
        select: { userId: true, user: { select: { name: true, email: true } } },
      },
      feedback: { select: { authorId: true, status: true } },
    },
  });

  return stages
    .map((stage) => {
      const byAuthor = new Map(stage.feedback.map((row) => [row.authorId, row.status]));
      const owed: OutstandingOwner[] = stage.interviewers
        .filter((seat) => byAuthor.get(seat.userId) !== 'SUBMITTED')
        .map((seat) => ({
          userId: seat.userId,
          name: seat.user.name,
          email: seat.user.email,
          status: byAuthor.get(seat.userId) === 'DRAFT' ? ('DRAFT' as const) : ('NONE' as const),
        }));

      const since = waitingSince(stage);
      return {
        stageId: stage.id,
        stageName: stage.name,
        stageType: stage.type,
        stageStatus: stage.status,
        applicationId: stage.application.id,
        candidateName: stage.application.candidate.name,
        jobRoleTitle: stage.application.jobRole?.title ?? null,
        panelSize: stage.interviewers.length,
        submittedCount: stage.feedback.filter((row) => row.status === 'SUBMITTED').length,
        waitingSince: since,
        ageDays: ageInDays(since, now),
        owed,
      };
    })
    .filter((row) => row.owed.length > 0)
    .sort((a, b) => a.waitingSince.getTime() - b.waitingSince.getTime());
}

export interface SubmissionScope {
  submissionId: string;
  /** Null when this assessment is not (yet) a round of any application. */
  applicationId: string | null;
}

/**
 * May this viewer read and annotate this submission, and which application
 * does it belong to?
 *
 * A submission predates the pipeline: it belongs to a candidate and an
 * interview, and only becomes part of an application when a stage is created
 * around the assignment. So access is decided by the owning application where
 * there is one, and falls back to `VIEW_ALL_APPLICATIONS` where there is not —
 * an interviewer with no seat on anything must not be able to walk the
 * submission table by id.
 *
 * Returns `null` for "no" and for "does not exist" alike.
 */
export async function resolveSubmissionScope(
  viewer: SessionUser,
  submissionId: string,
): Promise<SubmissionScope | null> {
  if (!isStaff(viewer.role)) return null;

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: { id: true, candidateId: true, interviewId: true },
  });
  if (!submission) return null;

  const stage = await prisma.stage.findFirst({
    where: {
      assignment: {
        interviewId: submission.interviewId,
        candidateId: submission.candidateId,
      },
    },
    select: { applicationId: true },
  });

  if (!stage) {
    return can(viewer.role, 'VIEW_ALL_APPLICATIONS')
      ? { submissionId: submission.id, applicationId: null }
      : null;
  }

  if (!(await canViewApplication(viewer, stage.applicationId))) return null;
  return { submissionId: submission.id, applicationId: stage.applicationId };
}

export interface SubmissionNoteView {
  id: string;
  body: string;
  lineStart: number | null;
  lineEnd: number | null;
  createdAt: Date;
  authorId: string;
  authorName: string;
  /** Only the author may delete their own note — see the action. */
  canDelete: boolean;
}

/**
 * The reviewer thread on one submission.
 *
 * Unlike a scorecard these are not blind: a note is "line 42 reimplements
 * `groupBy`", which is the kind of thing a second reviewer should see rather
 * than rediscover. They are still staff-only and still access-checked against
 * the owning application.
 */
export async function getSubmissionNotes(
  viewer: SessionUser,
  submissionId: string,
): Promise<SubmissionNoteView[]> {
  const scope = await resolveSubmissionScope(viewer, submissionId);
  if (!scope) return [];

  const rows = await prisma.submissionNote.findMany({
    where: { submissionId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      body: true,
      lineStart: true,
      lineEnd: true,
      createdAt: true,
      authorId: true,
      author: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    createdAt: row.createdAt,
    authorId: row.authorId,
    authorName: row.author.name,
    canDelete: row.authorId === viewer.id,
  }));
}
