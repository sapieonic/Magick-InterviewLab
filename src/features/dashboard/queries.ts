import 'server-only';
import { prisma } from '@/lib/db/prisma';
import { ELIGIBLE_CODING_STAGE } from '@/features/review/queries';
import { can } from '@/features/auth/capabilities';
import { visibleApplicationsWhere } from '@/features/pipeline/access';
import {
  countScorecards,
  deriveCodingStageStatus,
  isExpectedToScore,
  isScorecardDue,
} from '@/features/pipeline/stage-status';
import type { SessionUser } from '@/features/auth/session';
import type { Prisma } from '@/generated/prisma/client';
import type { AssignmentStatus, StageStatus, StageType } from '@/generated/prisma/enums';
import { describeAction, isQuietAction, type ActivityIcon, type ActivityTone } from './activity';

/**
 * What this particular viewer needs to act on.
 *
 * The console serves four roles with genuinely different jobs, and a single
 * fixed tile row serves none of them well: an interviewer opens it to find out
 * what they owe, a recruiter to find what has stalled. So the tiles are
 * assembled per viewer rather than filtered in the page.
 *
 * **A tile counts exactly what its destination lists.** A number that cannot
 * be reconciled with the page behind it is worse than no number: it teaches
 * people the console is wrong, and there is nowhere to go to find out which
 * half lied. That is why nothing here counts `Stage.status` directly, and why
 * the two feedback tiles are built from the shared rules in
 * `@/features/pipeline/stage-status` rather than from an eighth opinion about
 * who owes what.
 */
export interface DashboardTile {
  key: string;
  label: string;
  value: number;
  hint?: string;
  href: string;
  /** Draws attention when non-zero — the things that block other people. */
  urgent?: boolean;
}

/**
 * What a round is actually up to, as opposed to what someone last typed.
 *
 * The overlay `effectiveStatus` applies in `features/pipeline/queries.ts`: a
 * coding round the candidate has already submitted is owed a review while
 * `Stage.status` still says `PENDING`, so a tile counting the stored value
 * leaves exactly that round out of both of the numbers below.
 */
function effectiveStageStatus(stage: {
  type: StageType;
  status: StageStatus;
  assignment: { status: AssignmentStatus } | null;
}): StageStatus {
  return stage.type === 'CODING_ASSESSMENT'
    ? deriveCodingStageStatus(stage.status, stage.assignment?.status ?? null)
    : stage.status;
}

/** Only open work is a task. A closed application's unwritten scorecard is
 *  history, and this is the restriction both feedback queues already apply.
 *
 *  It is also the exact complement of the review loop's `CLOSED` step, which is
 *  HIRED, REJECTED or WITHDRAWN — so the two tiles below can lean on it to mean
 *  "not closed" as well as "still work". */
const OPEN_APPLICATION: Prisma.ApplicationWhereInput = { status: { in: ['ACTIVE', 'ON_HOLD'] } };

/**
 * The finished coding round that makes an application reviewable at all.
 *
 * Mirrors `ELIGIBLE_CODING_STAGE` in `features/review/queries.ts`, which is
 * private to that module. Both tiles that link at the review queue have to
 * carry it: the queue is a list of people who have *sat an assessment*, so a
 * count taken over every application would promise rows the destination does
 * not hold, and the tile would be wrong in the one way this file refuses to be.
 * If that constant moves, move this with it.
 *
 * Two ways in, because a round can finish without the machinery noticing: the
 * assignment reports `COMPLETED`, or a person marked the round resolved. The
 * queue then narrows the second case once more in memory — a round somebody
 * marked complete with no submissions behind it has nothing to review — which
 * no `where` can express. That is the single direction these numbers can part,
 * and it can only ever make the queue shorter than the tile, never longer.
 */
const REVIEWABLE_CODING_STAGE = ELIGIBLE_CODING_STAGE;

/**
 * Rounds where *this viewer* still owes a scorecard.
 *
 * **Counterpart: `listMyFeedback` in `features/feedback/queries.ts`**, whose
 * rows `/admin/feedback` narrows to the same set before counting them in its
 * own header. This tile links there, so the two have to answer identically;
 * if one of the rules below moves, move it there too.
 *
 * Both parts of the rule come from `stage-status.ts` rather than being decided
 * again here. `isExpectedToScore`: a shadow is an observer, so telling one they
 * owe a scorecard sends them to a round they are not expected to score.
 * `isScorecardDue`: a round that has not happened yet is not late, it is not
 * due — which is also why this cannot be a `count()`, since due-ness depends on
 * the derived status and that needs the assignment alongside the stage.
 */
async function countOwedScorecards(viewer: SessionUser): Promise<number> {
  const seats = await prisma.stageInterviewer.findMany({
    where: {
      userId: viewer.id,
      stage: { status: { not: 'SKIPPED' }, application: OPEN_APPLICATION },
    },
    select: {
      role: true,
      stage: {
        select: {
          type: true,
          status: true,
          assignment: { select: { status: true } },
          // Scoped to the viewer, and to status rather than content: this is
          // only ever "have I finished", never anyone's prose.
          feedback: {
            where: { authorId: viewer.id, status: 'SUBMITTED' },
            select: { id: true },
          },
        },
      },
    },
  });

  return seats.filter(
    (seat) =>
      isExpectedToScore(seat.role) &&
      isScorecardDue(effectiveStageStatus(seat.stage)) &&
      seat.stage.feedback.length === 0,
  ).length;
}

/**
 * Rounds where *anyone* on the panel still owes a scorecard.
 *
 * **Counterpart: `listOutstandingFeedback` in `features/feedback/queries.ts`**,
 * which is the chase list this tile links to. Same three restrictions —
 * un-skipped round, open application, a panel to chase — and the same
 * `countScorecards` verdict on whether a round is still owed anything, so the
 * headline number and the list under it cannot disagree.
 */
async function countRoundsAwaitingFeedback(): Promise<number> {
  const stages = await prisma.stage.findMany({
    where: {
      status: { not: 'SKIPPED' },
      application: OPEN_APPLICATION,
      interviewers: { some: {} },
    },
    select: {
      type: true,
      status: true,
      assignment: { select: { status: true } },
      interviewers: { select: { userId: true, role: true } },
      // Status only. Counting is allowed here, reading is not.
      feedback: { select: { authorId: true, status: true } },
    },
  });

  return stages.filter(
    (stage) =>
      countScorecards(stage.interviewers, stage.feedback, effectiveStageStatus(stage)).outstanding >
      0,
  ).length;
}

export async function getDashboardTiles(viewer: SessionUser): Promise<DashboardTile[]> {
  const tiles: DashboardTile[] = [];

  // Everyone who can be on a panel gets their own queue first: the scorecard
  // you owe is the one thing nobody else can clear for you.
  if (can(viewer.role, 'GIVE_FEEDBACK')) {
    const owed = await countOwedScorecards(viewer);
    tiles.push({
      key: 'my-feedback',
      label: 'Scorecards you owe',
      value: owed,
      hint: owed === 0 ? 'Nothing outstanding' : 'Others are waiting on these',
      href: '/admin/feedback',
      urgent: owed > 0,
    });
  }

  if (can(viewer.role, 'VIEW_ALL_APPLICATIONS')) {
    const [active, awaitingFeedback, awaitingDecision, awaitingCloseout] = await Promise.all([
      prisma.application.count({ where: { status: 'ACTIVE' } }),
      countRoundsAwaitingFeedback(),
      // `READY` from `features/review/loop.ts`, expressed as a `where`: open,
      // no decision, every round settled — and a finished assessment, because
      // that is the set the queue lists from.
      //
      // Open rather than ACTIVE alone, which is where this number used to be
      // narrower than its own destination: `CLOSED` outranks `READY` only for
      // HIRED, REJECTED and WITHDRAWN, so an application parked ON_HOLD with
      // every round settled is a `READY` row in the queue and belongs here too.
      //
      // Counting the *stored* stage status is safe even though the queue works
      // off the derived one: `deriveCodingStageStatus` returns COMPLETE or
      // SKIPPED only when the stored value already said so, so "every round
      // resolved" cannot differ between the two.
      prisma.application.count({
        where: {
          ...OPEN_APPLICATION,
          decision: null,
          stages: {
            some: REVIEWABLE_CODING_STAGE,
            every: { status: { in: ['COMPLETE', 'SKIPPED'] } },
          },
        },
      }),
      // `CLOSEOUT`: a decision exists and the application is still open.
      //
      // Recording a decision deliberately does not move `Application.status` —
      // see the module comment on `features/decisions/actions.ts`, where
      // closing the application is kept as the recruiter's separate
      // accountability. The cost of that split was that a decided application
      // appeared in no list at all: off the "ready to decide" queue the moment
      // the call was made, and off nobody's desk until someone remembered it.
      // This is the number that remembers.
      //
      // No condition on the rounds, because `CLOSEOUT` outranks `READY`: a
      // decision made before the last round finished still needs closing out.
      prisma.application.count({
        where: {
          ...OPEN_APPLICATION,
          decision: { isNot: null },
          stages: { some: REVIEWABLE_CODING_STAGE },
        },
      }),
    ]);

    tiles.push(
      {
        key: 'active',
        label: 'Active applications',
        value: active,
        href: '/admin/pipeline?status=ACTIVE',
      },
      {
        key: 'awaiting-feedback',
        label: 'Rounds awaiting feedback',
        value: awaitingFeedback,
        hint: awaitingFeedback === 0 ? 'The panel is up to date' : 'Chase these',
        // The chase list, not the board: the board shows applications, and the
        // work this number describes is per round and per person.
        href: '/admin/feedback',
        urgent: awaitingFeedback > 0,
      },
      {
        key: 'awaiting-decision',
        label: 'Ready to decide',
        value: awaitingDecision,
        hint: 'Every round settled, no decision recorded',
        // The queue is a screen now. This lands on the exact bucket the number
        // counts rather than the nearest filter the board happened to support,
        // so the rows are the rows.
        href: '/admin/review?loop=READY',
        urgent: awaitingDecision > 0,
      },
      {
        key: 'awaiting-closeout',
        label: 'Decided — to close out',
        value: awaitingCloseout,
        hint: 'A decision is recorded and the application is still open',
        href: '/admin/review?loop=CLOSEOUT',
        urgent: awaitingCloseout > 0,
      },
    );
  }

  if (can(viewer.role, 'MANAGE_USERS')) {
    const [totalCandidates, activeCandidates] = await Promise.all([
      prisma.user.count({ where: { role: 'CANDIDATE' } }),
      prisma.user.count({ where: { role: 'CANDIDATE', isActive: true } }),
    ]);
    tiles.push({
      key: 'candidates',
      label: 'Candidates',
      value: totalCandidates,
      hint: `${totalCandidates - activeCandidates} deactivated`,
      href: '/admin/candidates',
    });
  }

  if (can(viewer.role, 'MANAGE_CONTENT')) {
    const [questions, publishedInterviews] = await Promise.all([
      prisma.question.count(),
      prisma.interview.count({ where: { status: 'PUBLISHED' } }),
    ]);
    tiles.push(
      { key: 'questions', label: 'Questions', value: questions, href: '/admin/questions' },
      {
        key: 'interviews',
        label: 'Published interviews',
        value: publishedInterviews,
        href: '/admin/interviews',
      },
    );
  }

  return tiles;
}

export interface PipelineActivityItem {
  id: string;
  at: Date;
  verb: string;
  tone: ActivityTone;
  icon: ActivityIcon;
  actorName: string;
  applicationId: string | null;
  candidateName: string | null;
}

/**
 * The activity feed, read from the audit log rather than inferred.
 *
 * The previous version merged recent logins and submissions in memory, which
 * could only ever describe what the machine observed. A round moving, a
 * scorecard landing and a decision being reversed are the events a hiring
 * process is actually made of, and none of them are derivable from those two
 * tables.
 *
 * Scoped with `visibleApplicationsWhere` so an interviewer's feed covers the
 * candidates they sit on and nobody else's.
 */
export async function getPipelineActivity(
  viewer: SessionUser,
  limit = 12,
): Promise<PipelineActivityItem[]> {
  const rows = await prisma.auditEvent.findMany({
    where: activityWhere(viewer),
    orderBy: { createdAt: 'desc' },
    // Over-read so that filtering the quiet actions out in memory cannot
    // return a short page; the index makes this cheap.
    take: limit * 3,
    select: {
      id: true,
      action: true,
      createdAt: true,
      applicationId: true,
      actor: { select: { name: true } },
      application: { select: { candidate: { select: { name: true } } } },
    },
  });

  return rows
    .filter((row) => !isQuietAction(row.action))
    .slice(0, limit)
    .map((row) => {
      const phrase = describeAction(row.action);
      return {
        id: row.id,
        at: row.createdAt,
        verb: phrase.verb,
        tone: phrase.tone,
        icon: phrase.icon,
        // A removed account leaves its events behind on purpose — the trail
        // outlives the actor.
        actorName: row.actor?.name ?? 'A removed account',
        applicationId: row.applicationId,
        candidateName: row.application?.candidate.name ?? null,
      };
    });
}

/**
 * Which audit rows this viewer's feed may contain.
 *
 * The subtlety that made `rubric.published` unreachable: on a *nullable*
 * to-one relation, `{ application: <fragment> }` requires the relation to be
 * present, so an event recorded without an `applicationId` matched nothing —
 * for an admin too, whose fragment is the empty `{}`. The phrase written for
 * it was dead code.
 *
 * An application-less event is not about any one candidate, so it cannot be
 * scoped per application at all; it is offered only to a viewer already
 * entitled to read every application. An interviewer therefore still sees
 * exactly the candidates they hold a seat on and nothing else, which is what
 * the per-application scoping is for — and a candidate, whose fragment is
 * unsatisfiable, still matches nothing either way.
 */
function activityWhere(viewer: SessionUser): Prisma.AuditEventWhereInput {
  const scoped: Prisma.AuditEventWhereInput = { application: visibleApplicationsWhere(viewer) };
  if (!can(viewer.role, 'VIEW_ALL_APPLICATIONS')) return scoped;
  return { OR: [scoped, { applicationId: null }] };
}
