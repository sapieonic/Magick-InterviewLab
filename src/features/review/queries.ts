import 'server-only';
import { prisma } from '@/lib/db/prisma';
import { can, isStaff } from '@/features/auth/capabilities';
import { visibleApplicationsWhere } from '@/features/pipeline/access';
import { summariseStages, type PipelineProgress } from '@/features/pipeline/queries';
import { isStageResolved } from '@/features/pipeline/stage-status';
import { visibleFeedback, type FeedbackVisibilityContext } from '@/features/feedback/visibility';
import { detectDisagreement } from '@/features/scorecard/aggregate';
import { scoreLabel } from '@/features/submissions/score';
import {
  countLate,
  daysSince,
  deriveLoopStep,
  elapsedMs,
  rollUpSubmissions,
  type ReviewLoopStep,
  type ReviewMetric,
  type RollUpSubmission,
  type SubmissionRollUp,
} from './loop';
import type { SessionUser } from '@/features/auth/session';
import type { Prisma } from '@/generated/prisma/client';
import type {
  ApplicationStatus,
  AssignmentStatus,
  DecisionOutcome,
  FeedbackStatus,
  InterviewerRole,
  Language,
  Recommendation,
} from '@/generated/prisma/enums';

/**
 * The review queue.
 *
 * The console had a screen for every *artefact* — a submission, a round, an
 * application — and none for the question a hiring manager actually arrives
 * with: which of the people who finished an assessment is waiting on me, and
 * what for. The dashboard counted that queue and then linked at the pipeline
 * board because no filter for it existed; this is the filter.
 *
 * Three rules carried over from `pipeline/queries.ts`, and one of this
 * module's own:
 *
 *  - Every `select` is explicit.
 *  - Derived numbers are computed once, here, from rows already loaded.
 *  - **Feedback is counted, never read** — with one deliberate, narrow
 *    exception. A split panel is the single most decision-relevant fact a
 *    queue can surface, so this module reads `recommendation` (an enum, never
 *    the prose) to compute it, and puts that read through the same blind
 *    filter the debrief uses. Where anything was withheld the flag comes back
 *    `null` rather than computed over a subset: a partial disagreement signal
 *    is worse than none, because it looks like agreement.
 *  - **Nothing here ranks.** There is no composite, no percentile and no
 *    ordering the system picks on the viewer's behalf; the default sort is
 *    how long someone has been waiting. See the README on why a computed
 *    ordering over candidates is a verdict wearing a different name.
 */

// --- inputs -----------------------------------------------------------------

export type PanelFacet = 'AGREE' | 'SPLIT' | 'INCOMPLETE' | 'NONE';
export type ScoreBand = 'strong' | 'partial' | 'weak';

export type ReviewSortKey =
  'waiting' | 'completed' | 'candidate' | 'tests' | 'attempts' | 'elapsed' | 'panel';

export const REVIEW_SORT_KEYS: readonly ReviewSortKey[] = [
  'waiting',
  'completed',
  'candidate',
  'tests',
  'attempts',
  'elapsed',
  'panel',
];

export const REVIEW_SORT_LABELS = {
  waiting: 'Waiting longest',
  completed: 'Assessment completed',
  candidate: 'Candidate A–Z',
  tests: 'Tests passed',
  attempts: 'Attempts',
  elapsed: 'Elapsed',
  panel: 'Panel coverage',
} as const satisfies Record<ReviewSortKey, string>;

export interface ReviewFilter {
  loop?: ReviewLoopStep | undefined;
  jobRoleId?: string | undefined;
  interviewId?: string | undefined;
  ownerId?: string | undefined;
  band?: ScoreBand | undefined;
  panel?: PanelFacet | undefined;
  language?: Language | undefined;
  /** Completed within this many days. */
  withinDays?: number | undefined;
  /** Closed applications are archive, not work, so they are out by default. */
  includeClosed?: boolean | undefined;
  metric?: ReviewMetric | undefined;
  sort?: ReviewSortKey | undefined;
}

// --- outputs ----------------------------------------------------------------

export interface ReviewAssessmentView {
  stageId: string;
  interviewId: string;
  interviewTitle: string;
  interviewArchived: boolean;
  assignmentStatus: AssignmentStatus | null;
  startedAt: Date | null;
  completedAt: Date | null;
  elapsedMs: number | null;
  questionsTotal: number;
  /** How many other coding rounds this application has. */
  otherCodingStages: number;
  lateCount: number;
  rollUp: SubmissionRollUp;
}

export interface ReviewPanelView {
  expected: number;
  submitted: number;
  outstanding: number;
  /**
   * Whether the panel disagrees, or `null` when the blind rule withheld a
   * scorecard from this viewer and the answer would therefore be computed over
   * a subset. Null means "cannot say", never "no".
   */
  disagrees: boolean | null;
}

export interface ReviewRow {
  applicationId: string;
  status: ApplicationStatus;
  candidate: { id: string; name: string; email: string; isActive: boolean };
  jobRole: { title: string; level: string } | null;
  owner: { id: string; name: string } | null;
  assessment: ReviewAssessmentView;
  /** Has a person written a note on the code or a scorecard on the round. */
  codeRead: boolean;
  panel: ReviewPanelView;
  stagesComplete: number;
  stagesTotal: number;
  /** Days since the assessment finished. The service-level number. */
  waitingDays: number | null;
  decision: { outcome: DecisionOutcome; decidedAt: Date } | null;
  loop: ReviewLoopStep;
}

export interface ReviewQueue {
  rows: ReviewRow[];
  /** Counts per loop step across everything visible, before the loop filter —
   *  so the chips can show what is behind each of them. */
  loopCounts: Record<ReviewLoopStep, number>;
  metric: ReviewMetric;
  sort: ReviewSortKey;
}

// --- the queue ---------------------------------------------------------------

/**
 * Applications whose coding assessment has actually happened.
 *
 * Two ways in, because a round can finish without the machinery noticing: the
 * assignment reports `COMPLETED`, or a person marked the round resolved. The
 * second case is filtered again in memory — a stage someone marked complete
 * with no submissions behind it has nothing to review, so it is not a row.
 *
 * Exported because the dashboard tiles count this same population, and two
 * copies of an eligibility rule is how a tile ends up linking at a queue that
 * disagrees with it. The in-memory narrowing above is the one difference that
 * survives, because it correlates a submission's interview with the
 * assignment's and no `where` can say that; it can only ever make the queue
 * shorter than the tile, never longer.
 */
export const ELIGIBLE_CODING_STAGE: Prisma.StageWhereInput = {
  type: 'CODING_ASSESSMENT',
  // Must actually be wired to an assessment. Without this a round somebody
  // hand-marked complete but never attached an interview to satisfied the
  // filter and was then dropped in memory, so the dashboard tile counted a row
  // its own destination would not list.
  assignment: { isNot: null },
  OR: [{ assignment: { status: 'COMPLETED' } }, { status: { in: ['COMPLETE', 'SKIPPED'] } }],
};

const REVIEW_STAGE_SELECT = {
  id: true,
  name: true,
  type: true,
  position: true,
  status: true,
  outcome: true,
  scheduledAt: true,
  updatedAt: true,
  blindFeedback: true,
  assignment: {
    select: {
      status: true,
      startedAt: true,
      completedAt: true,
      interview: {
        select: {
          id: true,
          title: true,
          status: true,
          durationMinutes: true,
          _count: { select: { questions: true } },
        },
      },
    },
  },
  interviewers: { select: { userId: true, role: true } },
  // `recommendation` is the narrow exception documented at the top of this
  // module; it is filtered through `visibleFeedback` before it is read.
  feedback: { select: { id: true, authorId: true, status: true, recommendation: true } },
} as const;

export async function listReviewQueue(
  viewer: SessionUser,
  filter: ReviewFilter = {},
): Promise<ReviewQueue> {
  const metric: ReviewMetric = filter.metric ?? 'latest';
  const sort: ReviewSortKey = filter.sort ?? 'waiting';

  if (!isStaff(viewer.role) || !can(viewer.role, 'VIEW_ALL_APPLICATIONS')) {
    return { rows: [], loopCounts: emptyLoopCounts(), metric, sort };
  }

  const rows = await prisma.application.findMany({
    where: {
      AND: [
        visibleApplicationsWhere(viewer),
        { stages: { some: ELIGIBLE_CODING_STAGE } },
        ...(filter.jobRoleId ? [{ jobRoleId: filter.jobRoleId }] : []),
        ...(filter.ownerId ? [{ ownerId: filter.ownerId }] : []),
      ],
    },
    select: {
      id: true,
      status: true,
      candidate: { select: { id: true, name: true, email: true, isActive: true } },
      jobRole: { select: { title: true, level: true } },
      owner: { select: { id: true, name: true } },
      decision: { select: { outcome: true, decidedAt: true } },
      stages: { orderBy: { position: 'asc' }, select: REVIEW_STAGE_SELECT },
    },
  });

  // One `now` for the whole queue, so two rows a millisecond apart cannot
  // report different day counts for the same elapsed time.
  const now = new Date();

  // Every coding round's submissions in one query rather than one per row —
  // the same batching `summariseSubmissions` and `loadAutomatedRuns` use.
  const assessments = rows.flatMap((row) => {
    const stage = pickAssessmentStage(row.stages);
    return stage?.assignment ? [{ candidateId: row.candidate.id, stage }] : [];
  });
  const [submissionsByKey, readByKey] = await Promise.all([
    loadSubmissions(assessments),
    loadCodeRead(assessments),
  ]);

  const built = rows.flatMap((row) => {
    const stage = pickAssessmentStage(row.stages);
    if (!stage?.assignment) return [];

    const key = submissionKey(row.candidate.id, stage.assignment.interview.id);
    const submissions = submissionsByKey.get(key) ?? [];
    const rollUp = rollUpSubmissions(submissions, metric);

    // The in-memory half of eligibility: a round a person marked complete with
    // nothing behind it is not something anyone can review.
    const machineFinished = stage.assignment.status === 'COMPLETED';
    if (!machineFinished && rollUp.attempts === 0) return [];

    const progress = summariseStages(row.stages, now);
    const panel = summarisePanel(viewer, row.stages, progress);
    const codeRead =
      (readByKey.get(key) ?? false) || stage.feedback.some((entry) => entry.status === 'SUBMITTED');

    const completedAt = stage.assignment.completedAt;
    const loop = deriveLoopStep({
      applicationClosed: isClosed(row.status),
      hasDecision: row.decision !== null,
      allStagesResolved:
        row.stages.length > 0 && progress.stages.every((s) => isStageResolved(s.status)),
      codeRead,
      outstandingScorecards: progress.outstandingScorecards,
    });

    const review: ReviewRow = {
      applicationId: row.id,
      status: row.status,
      candidate: row.candidate,
      jobRole: row.jobRole,
      owner: row.owner,
      assessment: {
        stageId: stage.id,
        interviewId: stage.assignment.interview.id,
        interviewTitle: stage.assignment.interview.title,
        interviewArchived: stage.assignment.interview.status === 'ARCHIVED',
        assignmentStatus: stage.assignment.status,
        startedAt: stage.assignment.startedAt,
        completedAt,
        elapsedMs: elapsedMs(stage.assignment.startedAt, completedAt),
        questionsTotal: stage.assignment.interview._count.questions,
        otherCodingStages: row.stages.filter((s) => s.type === 'CODING_ASSESSMENT').length - 1,
        lateCount: countLate(
          submissions,
          stage.assignment.startedAt,
          stage.assignment.interview.durationMinutes,
        ),
        rollUp,
      },
      codeRead,
      panel,
      stagesComplete: progress.stagesComplete,
      stagesTotal: progress.stagesTotal,
      // Falls back to the stage's own clock when the assignment never stamped
      // a completion — a hand-resolved round still has an age.
      waitingDays: daysSince(completedAt ?? stage.updatedAt, now),
      decision: row.decision,
      loop,
    };
    return [review];
  });

  const loopCounts = countLoops(built);
  const filtered = built.filter((row) => matches(row, filter));
  return { rows: sortRows(filtered, sort), loopCounts, metric, sort };
}

// --- filtering and sorting ---------------------------------------------------

function isClosed(status: ApplicationStatus): boolean {
  return status === 'HIRED' || status === 'REJECTED' || status === 'WITHDRAWN';
}

function matches(row: ReviewRow, filter: ReviewFilter): boolean {
  if (filter.loop && row.loop !== filter.loop) return false;
  // Asking for the closed bucket is itself the opt-in; the checkbox only has
  // to speak for the unfiltered view.
  if (!filter.includeClosed && filter.loop !== 'CLOSED' && row.loop === 'CLOSED') return false;
  if (filter.interviewId && row.assessment.interviewId !== filter.interviewId) return false;

  if (filter.band) {
    const score = row.assessment.rollUp.score;
    if (score === null || scoreLabel(score) !== filter.band) return false;
  }

  if (filter.panel && !matchesPanel(row.panel, filter.panel)) return false;

  if (filter.language && !row.assessment.rollUp.languages.includes(filter.language)) return false;

  if (filter.withinDays !== undefined) {
    const days = row.waitingDays;
    if (days === null || days > filter.withinDays) return false;
  }

  return true;
}

function matchesPanel(panel: ReviewPanelView, facet: PanelFacet): boolean {
  switch (facet) {
    case 'NONE':
      return panel.expected === 0;
    case 'INCOMPLETE':
      return panel.outstanding > 0;
    case 'SPLIT':
      return panel.disagrees === true;
    case 'AGREE':
      // A withheld signal is not agreement. `null` fails this deliberately.
      return panel.disagrees === false && panel.submitted > 0;
  }
}

/**
 * Sorting.
 *
 * Every key is a lens a *person* picked, and the tie-break is always the same
 * — waiting longest, then name — so the order is stable across reloads rather
 * than whatever the database felt like returning.
 */
function sortRows(rows: readonly ReviewRow[], sort: ReviewSortKey): ReviewRow[] {
  const byWaiting = (a: ReviewRow, b: ReviewRow): number =>
    (b.waitingDays ?? -1) - (a.waitingDays ?? -1) ||
    a.candidate.name.localeCompare(b.candidate.name);

  const comparators: Record<ReviewSortKey, (a: ReviewRow, b: ReviewRow) => number> = {
    waiting: byWaiting,
    completed: (a, b) =>
      (b.assessment.completedAt?.getTime() ?? 0) - (a.assessment.completedAt?.getTime() ?? 0) ||
      byWaiting(a, b),
    candidate: (a, b) => a.candidate.name.localeCompare(b.candidate.name),
    tests: (a, b) =>
      (b.assessment.rollUp.score ?? -1) - (a.assessment.rollUp.score ?? -1) || byWaiting(a, b),
    attempts: (a, b) =>
      b.assessment.rollUp.attempts - a.assessment.rollUp.attempts || byWaiting(a, b),
    // Nulls last under either direction: "not started" is not a short sitting.
    elapsed: (a, b) =>
      (b.assessment.elapsedMs ?? -1) - (a.assessment.elapsedMs ?? -1) || byWaiting(a, b),
    panel: (a, b) => b.panel.outstanding - a.panel.outstanding || byWaiting(a, b),
  };

  return [...rows].sort(comparators[sort]);
}

function emptyLoopCounts(): Record<ReviewLoopStep, number> {
  return { CLOSED: 0, CLOSEOUT: 0, READY: 0, UNREAD: 0, PANEL: 0, IN_FLIGHT: 0 };
}

function countLoops(rows: readonly ReviewRow[]): Record<ReviewLoopStep, number> {
  const counts = emptyLoopCounts();
  for (const row of rows) counts[row.loop] += 1;
  return counts;
}

// --- the assessment stage ----------------------------------------------------

type ReviewStage = {
  id: string;
  type: string;
  position: number;
  status: string;
  updatedAt: Date;
  assignment: {
    status: AssignmentStatus;
    startedAt: Date | null;
    completedAt: Date | null;
    interview: {
      id: string;
      title: string;
      status: string;
      durationMinutes: number | null;
      _count: { questions: number };
    };
  } | null;
  feedback: Array<{ status: string }>;
};

/**
 * Which coding round the row is about when there is more than one.
 *
 * The last one in pipeline order, because that is the round the candidate has
 * most recently reached — and the earlier ones stay reachable from the
 * application. The row says how many others there are rather than pretending
 * this is the only one.
 */
function pickAssessmentStage<T extends ReviewStage>(stages: readonly T[]): T | null {
  const coding = stages.filter((stage) => stage.type === 'CODING_ASSESSMENT' && stage.assignment);
  return coding.length === 0 ? null : (coding[coding.length - 1] ?? null);
}

// --- the panel ---------------------------------------------------------------

interface PanelStage {
  blindFeedback: boolean;
  interviewers: Array<{ userId: string; role: InterviewerRole }>;
  feedback: Array<{
    id: string;
    authorId: string;
    status: FeedbackStatus;
    recommendation: Recommendation | null;
  }>;
}

/**
 * The application's panel coverage, and whether it splits.
 *
 * The counts use `countScorecards`, which is the single definition of the
 * denominator the board and the debrief already share — so a shadow is neither
 * expected nor counted here either.
 *
 * The disagreement flag is the part that needs care. It is computed only from
 * scorecards this viewer may read, and returns `null` the moment anything was
 * withheld, because a split computed over half a panel reads as agreement. An
 * admin who happens to sit on a blind panel gets `null` on that application
 * exactly like any other panellist: rank does not make anchoring less likely.
 */
function summarisePanel(
  viewer: SessionUser,
  stages: readonly PanelStage[],
  progress: PipelineProgress,
): ReviewPanelView {
  // The counts come from the shared summary rather than a second pass over the
  // same rows: `summariseStages` has already overlaid a coding round's real
  // status onto the one a human last typed, and counting against the stored
  // status here would call a submitted assessment's scorecards "not yet due".
  const expected = progress.stages.reduce((sum, stage) => sum + stage.expectedScorecards, 0);
  const submitted = progress.stages.reduce((sum, stage) => sum + stage.submittedScorecards, 0);
  const outstanding = progress.outstandingScorecards;

  let withheld = false;
  const readable: Array<Recommendation | null> = [];

  for (const stage of stages) {
    const own = stage.feedback.find((row) => row.authorId === viewer.id) ?? null;
    const context: FeedbackVisibilityContext = {
      viewerId: viewer.id,
      stageIsBlind: stage.blindFeedback,
      viewerIsPanelist: stage.interviewers.some((seat) => seat.userId === viewer.id),
      viewerHasSubmitted: own?.status === 'SUBMITTED',
    };

    const submittedRows = stage.feedback.filter((row) => row.status === 'SUBMITTED');
    const visible = visibleFeedback(submittedRows, context);
    if (visible.length < submittedRows.length) withheld = true;
    for (const row of visible) readable.push(row.recommendation);
  }

  return {
    expected,
    submitted,
    outstanding,
    disagrees: withheld ? null : detectDisagreement(readable).disagrees,
  };
}

// --- submissions --------------------------------------------------------------

interface AssessmentRef {
  candidateId: string;
  stage: ReviewStage;
}

function submissionKey(candidateId: string, interviewId: string): string {
  return `${candidateId}:${interviewId}`;
}

/**
 * Every row's submissions in one query.
 *
 * The `IN` pair is a cross product, so a row for a (candidate, interview)
 * combination nobody asked for can come back; the wanted-key check drops it.
 * `loadAutomatedRuns` in the scorecard read model solves the same problem the
 * same way.
 */
async function loadSubmissions(
  assessments: readonly AssessmentRef[],
): Promise<Map<string, RollUpSubmission[]>> {
  const out = new Map<string, RollUpSubmission[]>();
  if (assessments.length === 0) return out;

  const wanted = new Set(
    assessments.map((a) => submissionKey(a.candidateId, a.stage.assignment!.interview.id)),
  );

  const rows = await prisma.submission.findMany({
    where: {
      candidateId: { in: [...new Set(assessments.map((a) => a.candidateId))] },
      interviewId: {
        in: [...new Set(assessments.map((a) => a.stage.assignment!.interview.id))],
      },
    },
    orderBy: { submittedAt: 'asc' },
    // Never `sourceCode` and never `results`: this is a list of a hundred
    // rows, and the code behind them is a screen of its own.
    select: {
      candidateId: true,
      interviewId: true,
      questionId: true,
      score: true,
      passedCount: true,
      totalCount: true,
      submittedAt: true,
      trigger: true,
      language: true,
    },
  });

  for (const row of rows) {
    const key = submissionKey(row.candidateId, row.interviewId);
    if (!wanted.has(key)) continue;
    const bucket = out.get(key) ?? [];
    bucket.push(row);
    out.set(key, bucket);
  }
  return out;
}

/**
 * Has a person read the code.
 *
 * A `SubmissionNote` is the only durable proof that someone opened a
 * submission and had a thought about it. This is the signal that keeps a
 * decision from resting on a machine score alone — the README's hard line —
 * so it is a column on the queue rather than a detail on a page nobody
 * reaches.
 */
async function loadCodeRead(assessments: readonly AssessmentRef[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (assessments.length === 0) return out;

  const wanted = new Set(
    assessments.map((a) => submissionKey(a.candidateId, a.stage.assignment!.interview.id)),
  );

  const rows = await prisma.submissionNote.findMany({
    where: {
      submission: {
        candidateId: { in: [...new Set(assessments.map((a) => a.candidateId))] },
        interviewId: {
          in: [...new Set(assessments.map((a) => a.stage.assignment!.interview.id))],
        },
      },
    },
    // The note's own text is somebody's review of a candidate; the queue only
    // needs to know one exists.
    select: { submission: { select: { candidateId: true, interviewId: true } } },
  });

  for (const row of rows) {
    const key = submissionKey(row.submission.candidateId, row.submission.interviewId);
    if (wanted.has(key)) out.set(key, true);
  }
  return out;
}

// --- filter options -----------------------------------------------------------

export interface ReviewFilterOptions {
  jobRoles: Array<{ id: string; title: string; level: string }>;
  interviews: Array<{ id: string; title: string }>;
  owners: Array<{ id: string; name: string }>;
}

/**
 * Only the values that actually appear on a reviewable application, so the
 * filter bar cannot offer a choice that returns nothing.
 */
export async function listReviewFilterOptions(viewer: SessionUser): Promise<ReviewFilterOptions> {
  if (!isStaff(viewer.role) || !can(viewer.role, 'VIEW_ALL_APPLICATIONS')) {
    return { jobRoles: [], interviews: [], owners: [] };
  }

  const scope = {
    AND: [visibleApplicationsWhere(viewer), { stages: { some: ELIGIBLE_CODING_STAGE } }],
  };

  const [jobRoles, interviews, owners] = await Promise.all([
    prisma.jobRole.findMany({
      where: { applications: { some: scope } },
      orderBy: [{ title: 'asc' }, { level: 'asc' }],
      select: { id: true, title: true, level: true },
    }),
    prisma.interview.findMany({
      where: { assignments: { some: { stage: { application: scope } } } },
      orderBy: { title: 'asc' },
      select: { id: true, title: true },
    }),
    prisma.user.findMany({
      where: { ownedApplications: { some: scope } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);

  return { jobRoles, interviews, owners };
}
