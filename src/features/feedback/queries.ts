import 'server-only';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { can, isStaff } from '@/features/auth/capabilities';
import { canViewApplication, getPanelSeat } from '@/features/pipeline/access';
import {
  countScorecards,
  deriveCodingStageStatus,
  isExpectedToScore,
  isScorecardDue,
} from '@/features/pipeline/stage-status';
import {
  blindReason,
  visibleFeedback,
  type BlindReason,
  type FeedbackVisibilityContext,
} from '@/features/feedback/visibility';
import { parseStoredResults, type ParsedResults } from '@/features/submissions/stored-results';
import type { SessionUser } from '@/features/auth/session';
import type {
  AssignmentStatus,
  Confidence,
  FeedbackStatus,
  InterviewerRole,
  Language,
  Recommendation,
  StageStatus,
  StageType,
  SubmissionTrigger,
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
 * Every step of this is an estimate of one thing — when the round actually
 * happened — taken most-specific-evidence-first. `completedAt` is written only
 * when a stage is marked `COMPLETE`, which covers the two populations that
 * carry one: a round that is complete and still missing a scorecard, and a
 * round reopened from `COMPLETE` back to `AWAITING_FEEDBACK`. A round that
 * reached `AWAITING_FEEDBACK` without ever being marked complete has no
 * completion stamp at all, so it ages from the slot it was booked into, and a
 * round nobody ever scheduled from when its row was created — otherwise it
 * would sit at zero days forever.
 *
 * The previous comment claimed `completedAt` was the start for any
 * finished-but-unscored round, which is not what the column means; the two
 * populations are not on different clocks, they are on the best clock each one
 * has.
 *
 * What this is emphatically *not* is a claim that anything is owed. A round
 * two weeks out has a `createdAt`, and ageing from it is how this page came to
 * chase panellists for interviews that have not happened. `isScorecardDue` is
 * what decides that, and both callers report an age only when it says so.
 */
function waitingSince(stage: {
  completedAt: Date | null;
  scheduledAt: Date | null;
  createdAt: Date;
}): Date {
  return stage.completedAt ?? stage.scheduledAt ?? stage.createdAt;
}

/**
 * The status a reader is shown.
 *
 * For a coding round that is the assignment's business, not the stage row's —
 * see the long note in `stage-status.ts`. This module used to return the
 * stored value while the board and the application page returned the overlay,
 * so one round at one moment read "Awaiting feedback" in two places and
 * "Pending" in a third. The overlay is never written back.
 */
export function effectiveStageStatus(stage: {
  type: StageType;
  status: StageStatus;
  assignment: { status: AssignmentStatus } | null;
}): StageStatus {
  if (stage.type !== 'CODING_ASSESSMENT') return stage.status;
  return deriveCodingStageStatus(stage.status, stage.assignment?.status ?? null);
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

/** One earlier version of a scorecard, read back out of the append-only trail. */
export interface FeedbackRevisionView {
  id: string;
  /** When this version was superseded — i.e. when the edit happened. */
  at: Date;
  editedByName: string | null;
  reason: string;
  recommendation: Recommendation | null;
  confidence: Confidence | null;
  summary: string;
  strengths: string;
  concerns: string;
  scores: FeedbackScoreView[];
  /**
   * The snapshot is a free-form Json column. True when it could not be read
   * back in the shape it was written — the row is still evidence that an edit
   * happened, and saying so is better than rendering an empty version.
   */
  unreadable: boolean;
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
  /**
   * When the scorecard was last rewritten, from the trail itself. Not
   * `updatedAt`, which also moves when the scores are re-written on a save.
   */
  lastRevisedAt: Date | null;
  /**
   * True when at least one other panellist's scorecard was already submitted
   * at the moment of the last revision — i.e. the author could read the panel
   * before rewriting.
   *
   * The bypass this exists to make legible: submit a one-character summary
   * purely to unlock the panel, read everyone else, then revise with the real
   * content. `submittedAt` is deliberately preserved on a revision, so the
   * rewrite otherwise looks contemporaneous. Raising the minimum summary
   * length would punish honest short feedback and stop nobody; showing the
   * reader when the edit happened, and that there was something to read when
   * it did, costs the honest reviser nothing.
   */
  revisedAfterReadingPanel: boolean;
  /** Newest first, bounded — see `FEEDBACK_SELECT`. */
  revisions: FeedbackRevisionView[];
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
  /** Whether the candidate submitted this or the deadline did. Without it, a
   *  snapshot of half-finished work is indistinguishable from a considered
   *  final answer, and the reviewer on this page is exactly the person who
   *  would misread it. */
  trigger: SubmissionTrigger;
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
  /** Every seat, shadows included — the blind rule withholds content, and this
   *  is who is in the room. The counts below are a different question. */
  panel: PanelMemberView[];
  /**
   * The fraction a reader is shown. `panelSize` is the seats that *owe* a
   * scorecard and `submittedCount` the ones that have written one, both from
   * `countScorecards`, so "3 of 2 submitted" is not expressible.
   */
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
  // The trail, actually read. It was written by `submitFeedbackAction` from
  // the first commit and read by nothing but a `_count`, which left the
  // product promising "the earlier versions are kept" with no way to see one.
  // Newest first and bounded: a scorecard rewritten more than ten times is a
  // conversation to have, not a page to render, and `_count` still reports the
  // true total.
  revisions: {
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      createdAt: true,
      reason: true,
      snapshot: true,
      editedBy: { select: { name: true } },
    },
  },
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
  revisions: Array<{
    id: string;
    createdAt: Date;
    reason: string;
    snapshot: unknown;
    editedBy: { name: string } | null;
  }>;
};

const RECOMMENDATIONS = [
  'STRONG_HIRE',
  'HIRE',
  'LEAN_HIRE',
  'LEAN_NO',
  'NO',
  'STRONG_NO',
] as const satisfies readonly Recommendation[];

/**
 * `FeedbackRevision.snapshot` is Json, so it is whatever was written whenever
 * it was written. Read it defensively and report a version that will not parse
 * rather than dropping the row: an audit trail with a silent hole in it is
 * worse than one that says "this entry is unreadable".
 */
const revisionSnapshotSchema = z.object({
  recommendation: z.enum(RECOMMENDATIONS).nullish(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']).nullish(),
  summary: z.string().nullish(),
  strengths: z.string().nullish(),
  concerns: z.string().nullish(),
  scores: z
    .array(
      z.object({
        criterionId: z.string(),
        score: z.number(),
        note: z.string().nullish(),
      }),
    )
    .nullish(),
});

function toRevisionView(row: FeedbackRow['revisions'][number]): FeedbackRevisionView {
  const parsed = revisionSnapshotSchema.safeParse(row.snapshot);
  const data = parsed.success ? parsed.data : null;
  return {
    id: row.id,
    at: row.createdAt,
    editedByName: row.editedBy?.name ?? null,
    reason: row.reason,
    recommendation: data?.recommendation ?? null,
    confidence: data?.confidence ?? null,
    summary: data?.summary ?? '',
    strengths: data?.strengths ?? '',
    concerns: data?.concerns ?? '',
    scores: (data?.scores ?? []).map((score) => ({
      criterionId: score.criterionId,
      score: score.score,
      note: score.note ?? '',
    })),
    unreadable: !parsed.success,
  };
}

/**
 * `panel` is the rest of the stage's feedback rows, and only their *status* is
 * read — who had submitted, and when. That is the same counting this module
 * already does beside the blind rule; no prose crosses from one row to
 * another. Callers that have no stage context pass nothing and get `false`.
 */
export function toFeedbackView(row: FeedbackRow, panel: readonly FeedbackRow[] = []): FeedbackView {
  const revisions = row.revisions.map(toRevisionView);
  const lastRevisedAt = revisions[0]?.at ?? null;
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
    lastRevisedAt,
    revisedAfterReadingPanel:
      lastRevisedAt !== null &&
      panel.some(
        (other) =>
          other.authorId !== row.authorId &&
          other.status === 'SUBMITTED' &&
          other.submittedAt !== null &&
          other.submittedAt.getTime() <= lastRevisedAt.getTime(),
      ),
    revisions,
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
      assignment: { select: { interviewId: true, candidateId: true, status: true } },
    },
  });
  if (!stage) return null;

  const status = effectiveStageStatus(stage);

  const ownRow = stage.feedback.find((row) => row.authorId === viewer.id) ?? null;

  const context: FeedbackVisibilityContext = {
    viewerId: viewer.id,
    stageIsBlind: stage.blindFeedback,
    viewerIsPanelist: seat.isPanelist,
    viewerHasSubmitted: ownRow?.status === 'SUBMITTED',
  };

  // The single gate. Everything about *other people's* scorecards is read off
  // `readable` rather than `stage.feedback`, so there is exactly one place to
  // get this wrong. The two things taken from the unfiltered rows are the
  // viewer's own row — which the rule always permits its author — and counts
  // of who has submitted, which is status rather than content.
  const readable = visibleFeedback(stage.feedback, context);
  const readableIds = new Set(readable.map((row) => row.id));
  const withheld = stage.feedback.filter((row) => !readableIds.has(row.id));

  // One rule for both halves of the fraction, shared with the board so the two
  // can never render different denominators for the same round. A shadow is an
  // observer: not expected, and not counted if they submit anyway.
  const counts = countScorecards(stage.interviewers, stage.feedback, status);

  const submissions =
    stage.type === 'CODING_ASSESSMENT' && stage.assignment
      ? await loadStageSubmissions(stage.assignment)
      : [];

  return {
    stage: {
      id: stage.id,
      name: stage.name,
      type: stage.type,
      status,
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
    own: ownRow ? toFeedbackView(ownRow, stage.feedback) : null,
    others: readable
      .filter((row) => row.authorId !== viewer.id)
      .map((row) => toFeedbackView(row, stage.feedback))
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
      panelSize: counts.expected,
      submittedCount: counts.submitted,
      outstandingCount: counts.outstanding,
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
      trigger: true,
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
    trigger: row.trigger,
    submittedAt: row.submittedAt,
    results: parseStoredResults(row.results),
  }));
}

export interface MyFeedbackRow {
  stageId: string;
  stageName: string;
  stageType: StageType;
  /** Derived, never the stored row — see `effectiveStageStatus`. */
  stageStatus: StageStatus;
  applicationId: string;
  candidateName: string;
  jobRoleTitle: string | null;
  status: FeedbackStatus | null;
  submittedAt: Date | null;
  waitingSince: Date;
  /** True once the round has actually run. A seat on next month's interview is
   *  not work yet, however long ago the panel was set. */
  due: boolean;
  /** Null when the round is not due: there is no elapsed time to report, and
   *  showing one is how this page came to chase people for rounds that have
   *  not happened. */
  ageDays: number | null;
}

/**
 * How many of the viewer's seats are read at once.
 *
 * A queue is a working list, not an archive. The order is oldest round first,
 * so what a bound drops is the most recently created seat — the least likely
 * to be the thing anyone is being chased for.
 */
const MY_FEEDBACK_LIMIT = 200;

/**
 * The viewer's own queue.
 *
 * Age is the product, not a decoration: feedback that arrives a fortnight
 * later is written from memory, and the only thing that reliably shortens the
 * gap is showing someone how long they have been the blocker. Rounds that are
 * due and unwritten sort first and oldest to newest, then rounds still to
 * come, then submitted ones — which stay listed so the page is also the way
 * back to a scorecard you want to revise.
 *
 * `now` is a parameter so the ageing can be pinned by a test.
 */
export async function listMyFeedback(
  viewer: SessionUser,
  now: Date = new Date(),
  limit: number = MY_FEEDBACK_LIMIT,
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
    orderBy: { stage: { createdAt: 'asc' } },
    take: limit,
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
          // Status only, and only to overlay a coding round's stored status
          // with what the candidate actually did — never the submissions.
          assignment: { select: { status: true } },
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
    const stageStatus = effectiveStageStatus(stage);
    const due = isScorecardDue(stageStatus);
    return {
      stageId: stage.id,
      stageName: stage.name,
      stageType: stage.type,
      stageStatus,
      applicationId: stage.application.id,
      candidateName: stage.application.candidate.name,
      jobRoleTitle: stage.application.jobRole?.title ?? null,
      status: own?.status ?? null,
      submittedAt: own?.submittedAt ?? null,
      waitingSince: since,
      due,
      ageDays: due ? ageInDays(since, now) : null,
    };
  });

  // Owed and late, then owed and not yet due, then done. Within each band the
  // oldest round leads, which is the order the page is read in.
  const band = (row: MyFeedbackRow): number => (row.status === 'SUBMITTED' ? 2 : row.due ? 0 : 1);

  return rows.sort((a, b) => {
    if (band(a) !== band(b)) return band(a) - band(b);
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
  /** Derived, never the stored row — see `effectiveStageStatus`. */
  stageStatus: StageStatus;
  applicationId: string;
  candidateName: string;
  jobRoleTitle: string | null;
  /** Seats that owe a scorecard, and submissions from those same seats. One
   *  rule, shared with the board — see `countScorecards`. */
  panelSize: number;
  submittedCount: number;
  waitingSince: Date;
  ageDays: number;
  owed: OutstandingOwner[];
}

/**
 * How many stages the chase list reads.
 *
 * This query cannot express "has somebody outstanding" in SQL — that is a
 * comparison between two counts on different relations — so it reads rounds
 * and filters. Oldest first, so the bound drops the newest rounds, which are
 * the least likely to be late.
 */
const OUTSTANDING_LIMIT = 300;

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
  limit: number = OUTSTANDING_LIMIT,
): Promise<OutstandingFeedbackRow[]> {
  if (!isStaff(viewer.role) || !can(viewer.role, 'VIEW_ALL_APPLICATIONS')) return [];

  const stages = await prisma.stage.findMany({
    where: {
      // Stored status, deliberately: a coding round stored `PENDING` whose
      // assignment is finished derives to `AWAITING_FEEDBACK` and *is* owed,
      // so the only status this may filter on in SQL is the one the overlay
      // never changes — `SKIPPED` in, `SKIPPED` out. The due rule is applied
      // below, on the derived value.
      status: { not: 'SKIPPED' },
      application: { status: { in: ['ACTIVE', 'ON_HOLD'] } },
      // A round whose only seats are shadows owes nothing, so it is not a row
      // this page should read at all.
      interviewers: { some: { role: { not: 'SHADOW' } } },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      scheduledAt: true,
      completedAt: true,
      createdAt: true,
      assignment: { select: { status: true } },
      application: {
        select: {
          id: true,
          candidate: { select: { name: true } },
          jobRole: { select: { title: true } },
        },
      },
      interviewers: {
        select: { userId: true, role: true, user: { select: { name: true, email: true } } },
      },
      feedback: { select: { authorId: true, status: true } },
    },
  });

  return stages
    .flatMap((stage) => {
      const stageStatus = effectiveStageStatus(stage);
      // Nobody is late for an interview that has not happened. The board says
      // zero outstanding for these; this page used to list them with an age.
      if (!isScorecardDue(stageStatus)) return [];

      const byAuthor = new Map(stage.feedback.map((row) => [row.authorId, row.status]));
      const owed: OutstandingOwner[] = stage.interviewers
        .filter((seat) => isExpectedToScore(seat.role))
        .filter((seat) => byAuthor.get(seat.userId) !== 'SUBMITTED')
        .map((seat) => ({
          userId: seat.userId,
          name: seat.user.name,
          email: seat.user.email,
          status: byAuthor.get(seat.userId) === 'DRAFT' ? ('DRAFT' as const) : ('NONE' as const),
        }));
      if (owed.length === 0) return [];

      const counts = countScorecards(stage.interviewers, stage.feedback, stageStatus);
      const since = waitingSince(stage);
      return [
        {
          stageId: stage.id,
          stageName: stage.name,
          stageType: stage.type,
          stageStatus,
          applicationId: stage.application.id,
          candidateName: stage.application.candidate.name,
          jobRoleTitle: stage.application.jobRole?.title ?? null,
          panelSize: counts.expected,
          submittedCount: counts.submitted,
          waitingSince: since,
          ageDays: ageInDays(since, now),
          owed,
        },
      ];
    })
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
