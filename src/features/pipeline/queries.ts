import 'server-only';
import { prisma } from '@/lib/db/prisma';
import type { SessionUser } from '@/features/auth/session';
import type {
  ApplicationStatus,
  AssignmentStatus,
  DecisionOutcome,
  FeedbackStatus,
  InterviewerRole,
  Role,
  StageOutcome,
  StageStatus,
  StageType,
} from '@/generated/prisma/enums';
import { canViewApplication, visibleApplicationsWhere } from './access';
import { deriveCodingStageStatus, isStageResolved } from './stage-status';

/**
 * Read models for the hiring pipeline.
 *
 * Two house rules carried over from `features/candidates/queries.ts`, plus one
 * of this feature's own:
 *
 *  - Every `select` is explicit. A `select`-free query on `User` hands the
 *    Argon2 hash to whatever renders the row.
 *  - Derived numbers are computed here, once, from rows already loaded, so the
 *    board and the detail page cannot disagree about how many scorecards are
 *    outstanding.
 *  - **Feedback is counted, never read.** These models return how many
 *    scorecards exist and how many are submitted and nothing else. The content
 *    is access-controlled per viewer by `features/feedback/visibility.ts` and
 *    is served by the stage screens; a read model that returned the prose
 *    would have leaked it however carefully a page hid it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// --- shared stage arithmetic ------------------------------------------------

/** The row shape both the list and the detail query load per stage. */
interface RawStage {
  id: string;
  name: string;
  type: StageType;
  position: number;
  status: StageStatus;
  outcome: StageOutcome | null;
  scheduledAt: Date | null;
  updatedAt: Date;
  assignment: { status: AssignmentStatus } | null;
  interviewers: Array<{ role: InterviewerRole }>;
  feedback: Array<{ status: FeedbackStatus }>;
}

export interface StageSummary {
  id: string;
  name: string;
  type: StageType;
  position: number;
  /** What the row says. Kept alongside the effective status so the detail page
   *  can explain a coding stage whose assignment has overtaken it. */
  storedStatus: StageStatus;
  /** What is actually true — see `deriveCodingStageStatus`. */
  status: StageStatus;
  outcome: StageOutcome | null;
  scheduledAt: Date | null;
  updatedAt: Date;
  /** Panellists who owe a scorecard. Shadows are excluded: a shadow is there
   *  to learn, and counting them would leave every stage looking overdue. */
  expectedScorecards: number;
  submittedScorecards: number;
  /** Only ever non-zero once the round has actually run. A scorecard for a
   *  stage that has not happened yet is not late, it is not due. */
  outstandingScorecards: number;
}

function effectiveStatus(stage: RawStage): StageStatus {
  if (stage.type !== 'CODING_ASSESSMENT') return stage.status;
  return deriveCodingStageStatus(stage.status, stage.assignment?.status ?? null);
}

function summariseStage(stage: RawStage): StageSummary {
  const status = effectiveStatus(stage);
  const expected = stage.interviewers.filter((i) => i.role !== 'SHADOW').length;
  const submitted = stage.feedback.filter((f) => f.status === 'SUBMITTED').length;
  const due = status === 'IN_PROGRESS' || status === 'AWAITING_FEEDBACK' || status === 'COMPLETE';
  return {
    id: stage.id,
    name: stage.name,
    type: stage.type,
    position: stage.position,
    storedStatus: stage.status,
    status,
    outcome: stage.outcome,
    scheduledAt: stage.scheduledAt,
    updatedAt: stage.updatedAt,
    expectedScorecards: expected,
    submittedScorecards: submitted,
    outstandingScorecards: due ? Math.max(0, expected - submitted) : 0,
  };
}

export interface PipelineProgress {
  stages: StageSummary[];
  /** The round the candidate is on: the first that is neither complete nor
   *  skipped. Null once every round is resolved — the application is then
   *  waiting on a decision, not on a stage. */
  currentStage: StageSummary | null;
  nextStage: StageSummary | null;
  stagesComplete: number;
  /** Skipped rounds are excluded: they are no longer work, so counting them
   *  would leave a pipeline permanently short of its own total. */
  stagesTotal: number;
  outstandingScorecards: number;
  /**
   * Days since the current stage last changed.
   *
   * `updatedAt` rather than a bespoke `enteredAt` column: every write to a
   * stage is a move of some kind, so "untouched for eleven days" is exactly
   * the stall a recruiter is scanning for. Null when nothing is in flight.
   */
  daysInStage: number | null;
}

/**
 * Everything the board and the header derive from a stage list. Pure, and
 * fed from rows the caller has already loaded, so a second round trip can
 * never make the two views disagree.
 */
export function summariseStages(
  raw: readonly RawStage[],
  now: Date = new Date(),
): PipelineProgress {
  const stages = [...raw].sort((a, b) => a.position - b.position).map(summariseStage);
  const currentIndex = stages.findIndex((s) => !isStageResolved(s.status));
  const currentStage = currentIndex === -1 ? null : (stages[currentIndex] ?? null);
  const nextStage = currentIndex === -1 ? null : (stages[currentIndex + 1] ?? null);

  return {
    stages,
    currentStage,
    nextStage,
    stagesComplete: stages.filter((s) => s.status === 'COMPLETE').length,
    stagesTotal: stages.filter((s) => s.status !== 'SKIPPED').length,
    outstandingScorecards: stages.reduce((sum, s) => sum + s.outstandingScorecards, 0),
    daysInStage: currentStage
      ? Math.max(0, Math.floor((now.getTime() - currentStage.updatedAt.getTime()) / DAY_MS))
      : null,
  };
}

const RAW_STAGE_SELECT = {
  id: true,
  name: true,
  type: true,
  position: true,
  status: true,
  outcome: true,
  scheduledAt: true,
  updatedAt: true,
  assignment: { select: { status: true } },
  interviewers: { select: { role: true } },
  // Status only. See the module comment: counting is allowed, reading is not.
  feedback: { select: { status: true } },
} as const;

// --- the board --------------------------------------------------------------

export interface ApplicationListRow {
  id: string;
  status: ApplicationStatus;
  source: string;
  createdAt: Date;
  closedAt: Date | null;
  candidate: { id: string; name: string; email: string };
  jobRole: { id: string; title: string; level: string } | null;
  owner: { id: string; name: string; email: string } | null;
  currentStage: StageSummary | null;
  nextStage: StageSummary | null;
  stagesComplete: number;
  stagesTotal: number;
  outstandingScorecards: number;
  daysInStage: number | null;
}

export interface ApplicationFilter {
  status?: ApplicationStatus | undefined;
  jobRoleId?: string | undefined;
  ownerId?: string | undefined;
}

/**
 * The board.
 *
 * Scoped by `visibleApplicationsWhere`, which for an interviewer is "the
 * candidates you actually sit on" — so this is safe to call for any staff role
 * without a branch at the call site.
 */
export async function listApplications(
  viewer: SessionUser,
  filter: ApplicationFilter = {},
): Promise<ApplicationListRow[]> {
  const rows = await prisma.application.findMany({
    where: {
      AND: [
        visibleApplicationsWhere(viewer),
        ...(filter.status ? [{ status: filter.status }] : []),
        ...(filter.jobRoleId ? [{ jobRoleId: filter.jobRoleId }] : []),
        ...(filter.ownerId ? [{ ownerId: filter.ownerId }] : []),
      ],
    },
    orderBy: [{ updatedAt: 'desc' }],
    select: {
      id: true,
      status: true,
      source: true,
      createdAt: true,
      closedAt: true,
      candidate: { select: { id: true, name: true, email: true } },
      jobRole: { select: { id: true, title: true, level: true } },
      owner: { select: { id: true, name: true, email: true } },
      stages: { orderBy: { position: 'asc' }, select: RAW_STAGE_SELECT },
    },
  });

  // One `now` for the whole board so two cards a millisecond apart cannot
  // report different day counts for the same elapsed time.
  const now = new Date();

  return rows.map((row) => {
    const progress = summariseStages(row.stages, now);
    return {
      id: row.id,
      status: row.status,
      source: row.source,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      candidate: row.candidate,
      jobRole: row.jobRole,
      owner: row.owner,
      currentStage: progress.currentStage,
      nextStage: progress.nextStage,
      stagesComplete: progress.stagesComplete,
      stagesTotal: progress.stagesTotal,
      outstandingScorecards: progress.outstandingScorecards,
      daysInStage: progress.daysInStage,
    };
  });
}

// --- the application detail -------------------------------------------------

export interface PanelSeatView {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: InterviewerRole;
  accountRole: Role;
}

export interface StageAssignmentView {
  id: string;
  status: AssignmentStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  interview: { id: string; title: string };
  /** Summary only — the code itself lives behind `/admin/submissions`. */
  submissionCount: number;
  bestScore: number | null;
  lastSubmittedAt: Date | null;
}

export interface ApplicationStageView extends StageSummary {
  completedAt: Date | null;
  blindFeedback: boolean;
  rubricVersionId: string | null;
  panel: PanelSeatView[];
  assignment: StageAssignmentView | null;
}

export interface ApplicationCommentView {
  id: string;
  body: string;
  createdAt: Date;
  author: { id: string; name: string; email: string; role: Role };
}

export interface ApplicationDetail {
  id: string;
  status: ApplicationStatus;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  candidate: { id: string; name: string; email: string; isActive: boolean };
  jobRole: { id: string; title: string; level: string } | null;
  owner: { id: string; name: string; email: string } | null;
  pipelineTemplate: { id: string; name: string } | null;
  stages: ApplicationStageView[];
  currentStage: StageSummary | null;
  nextStage: StageSummary | null;
  stagesComplete: number;
  stagesTotal: number;
  outstandingScorecards: number;
  daysInStage: number | null;
  comments: ApplicationCommentView[];
  decision: {
    outcome: DecisionOutcome;
    rationale: string;
    decidedAt: Date;
    decidedBy: { id: string; name: string } | null;
  } | null;
}

/**
 * The working surface.
 *
 * Returns `null` both when the application does not exist and when the viewer
 * may not open it, so the page can `notFound()` on either without the 404
 * telling an interviewer that a candidate they cannot see is real.
 */
export async function getApplication(
  viewer: SessionUser,
  id: string,
): Promise<ApplicationDetail | null> {
  if (!(await canViewApplication(viewer, id))) return null;

  const row = await prisma.application.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      source: true,
      createdAt: true,
      updatedAt: true,
      closedAt: true,
      candidate: { select: { id: true, name: true, email: true, isActive: true } },
      jobRole: { select: { id: true, title: true, level: true } },
      owner: { select: { id: true, name: true, email: true } },
      pipelineTemplate: { select: { id: true, name: true } },
      stages: {
        orderBy: { position: 'asc' },
        select: {
          ...RAW_STAGE_SELECT,
          completedAt: true,
          blindFeedback: true,
          rubricVersionId: true,
          interviewers: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              userId: true,
              role: true,
              user: { select: { name: true, email: true, role: true } },
            },
          },
          assignment: {
            select: {
              id: true,
              status: true,
              startedAt: true,
              completedAt: true,
              interview: { select: { id: true, title: true } },
            },
          },
        },
      },
      comments: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          body: true,
          createdAt: true,
          author: { select: { id: true, name: true, email: true, role: true } },
        },
      },
      decision: {
        select: {
          outcome: true,
          rationale: true,
          decidedAt: true,
          decidedBy: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!row) return null;

  // The shared arithmetic wants only `{ role }` per seat, and the detail query
  // loaded the whole seat; narrow rather than run the query twice.
  const progress = summariseStages(
    row.stages.map((stage) => ({
      ...stage,
      interviewers: stage.interviewers.map((seat) => ({ role: seat.role })),
    })),
  );
  const rawById = new Map(row.stages.map((stage) => [stage.id, stage]));

  const assignmentIds = row.stages.flatMap((s) => (s.assignment ? [s.assignment] : []));
  const submissionsByInterview = await summariseSubmissions(
    row.candidate.id,
    assignmentIds.map((a) => a.interview.id),
  );

  // Walk the summaries rather than the raw rows: `summariseStages` already
  // put them in position order, and pairing this way means neither side needs
  // a "this cannot happen" fallback to satisfy the compiler.
  const stages: ApplicationStageView[] = progress.stages.flatMap((summary) => {
    const stage = rawById.get(summary.id);
    if (!stage) return [];
    const assignmentSummary = stage.assignment
      ? (submissionsByInterview.get(stage.assignment.interview.id) ?? EMPTY_SUBMISSIONS)
      : null;
    return {
      ...summary,
      completedAt: stage.completedAt,
      blindFeedback: stage.blindFeedback,
      rubricVersionId: stage.rubricVersionId,
      panel: stage.interviewers.map((seat) => ({
        id: seat.id,
        userId: seat.userId,
        name: seat.user.name,
        email: seat.user.email,
        role: seat.role,
        accountRole: seat.user.role,
      })),
      assignment:
        stage.assignment && assignmentSummary
          ? {
              id: stage.assignment.id,
              status: stage.assignment.status,
              startedAt: stage.assignment.startedAt,
              completedAt: stage.assignment.completedAt,
              interview: stage.assignment.interview,
              ...assignmentSummary,
            }
          : null,
    };
  });

  return {
    id: row.id,
    status: row.status,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
    candidate: row.candidate,
    jobRole: row.jobRole,
    owner: row.owner,
    pipelineTemplate: row.pipelineTemplate,
    stages,
    currentStage: progress.currentStage,
    nextStage: progress.nextStage,
    stagesComplete: progress.stagesComplete,
    stagesTotal: progress.stagesTotal,
    outstandingScorecards: progress.outstandingScorecards,
    daysInStage: progress.daysInStage,
    comments: row.comments,
    decision: row.decision,
  };
}

interface SubmissionSummary {
  submissionCount: number;
  bestScore: number | null;
  lastSubmittedAt: Date | null;
}

const EMPTY_SUBMISSIONS: SubmissionSummary = {
  submissionCount: 0,
  bestScore: null,
  lastSubmittedAt: null,
};

/**
 * How the candidate did on each coding assessment, as a headline.
 *
 * One query for every coding stage rather than one per stage, and only the
 * three numbers the stage card shows — the submissions themselves are a
 * separate, already-built screen.
 */
async function summariseSubmissions(
  candidateId: string,
  interviewIds: readonly string[],
): Promise<Map<string, SubmissionSummary>> {
  const out = new Map<string, SubmissionSummary>();
  if (interviewIds.length === 0) return out;

  const rows = await prisma.submission.findMany({
    where: { candidateId, interviewId: { in: [...interviewIds] } },
    orderBy: { submittedAt: 'desc' },
    select: { interviewId: true, score: true, submittedAt: true },
  });

  for (const row of rows) {
    const current = out.get(row.interviewId);
    if (!current) {
      out.set(row.interviewId, {
        submissionCount: 1,
        bestScore: row.score,
        // Rows arrive newest first, so the first one seen is the latest.
        lastSubmittedAt: row.submittedAt,
      });
      continue;
    }
    current.submissionCount += 1;
    if (current.bestScore === null || row.score > current.bestScore) current.bestScore = row.score;
  }
  return out;
}

// --- the activity timeline --------------------------------------------------

export interface TimelineEvent {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
  actor: { id: string; name: string } | null;
}

/**
 * The application's history, newest first.
 *
 * Takes an id rather than a viewer: it is read straight after `getApplication`
 * has already established that this person may see the application, and every
 * event here is scoped to that one row by `AuditEvent.applicationId`. Do not
 * call it before that check.
 */
export async function getApplicationTimeline(
  applicationId: string,
  limit = 100,
): Promise<TimelineEvent[]> {
  return prisma.auditEvent.findMany({
    where: { applicationId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      metadata: true,
      createdAt: true,
      actor: { select: { id: true, name: true } },
    },
  });
}

// --- pickers and filters ----------------------------------------------------

export interface PipelineFilterOptions {
  jobRoles: Array<{ id: string; title: string; level: string }>;
  owners: Array<{ id: string; name: string; email: string }>;
  statuses: ApplicationStatus[];
}

/**
 * Filter options, scoped the same way the board is: an interviewer's filter
 * must not enumerate the recruiters and requisitions behind applications they
 * cannot open.
 */
export async function listPipelineFilterOptions(
  viewer: SessionUser,
): Promise<PipelineFilterOptions> {
  const visible = visibleApplicationsWhere(viewer);

  const [jobRoles, owners, statusRows] = await Promise.all([
    prisma.jobRole.findMany({
      where: { applications: { some: visible } },
      orderBy: [{ title: 'asc' }, { level: 'asc' }],
      select: { id: true, title: true, level: true },
    }),
    prisma.user.findMany({
      where: { ownedApplications: { some: visible } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true },
    }),
    prisma.application.findMany({
      where: visible,
      distinct: ['status'],
      select: { status: true },
    }),
  ]);

  return { jobRoles, owners, statuses: statusRows.map((row) => row.status) };
}

/**
 * Who may be started on an application.
 *
 * "No active application" rather than "no application": a candidate who was
 * rejected last spring is a perfectly good person to approach about a
 * different role, and the pipeline is built to hold that second run. What it
 * refuses is two live runs at once — see `createApplicationAction`.
 */
export async function listAssignableCandidates(): Promise<
  Array<{ id: string; name: string; email: string }>
> {
  return prisma.user.findMany({
    where: {
      role: 'CANDIDATE',
      isActive: true,
      NOT: { applications: { some: { status: 'ACTIVE' } } },
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, email: true },
  });
}
