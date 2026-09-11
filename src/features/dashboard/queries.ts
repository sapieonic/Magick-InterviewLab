import 'server-only';
import { prisma } from '@/lib/db/prisma';
import { can } from '@/features/auth/capabilities';
import { visibleApplicationsWhere } from '@/features/pipeline/access';
import type { SessionUser } from '@/features/auth/session';
import { describeAction, isQuietAction, type ActivityIcon, type ActivityTone } from './activity';

/**
 * What this particular viewer needs to act on.
 *
 * The console serves four roles with genuinely different jobs, and a single
 * fixed tile row serves none of them well: an interviewer opens it to find out
 * what they owe, a recruiter to find what has stalled. So the tiles are
 * assembled per viewer rather than filtered in the page.
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

export async function getDashboardTiles(viewer: SessionUser): Promise<DashboardTile[]> {
  const tiles: DashboardTile[] = [];

  // Everyone who can be on a panel gets their own queue first: the scorecard
  // you owe is the one thing nobody else can clear for you.
  if (can(viewer.role, 'GIVE_FEEDBACK')) {
    const owed = await prisma.stage.count({
      where: {
        interviewers: { some: { userId: viewer.id } },
        status: { in: ['AWAITING_FEEDBACK', 'COMPLETE'] },
        feedback: { none: { authorId: viewer.id, status: 'SUBMITTED' } },
      },
    });
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
    const [active, awaitingFeedback, awaitingDecision] = await Promise.all([
      prisma.application.count({ where: { status: 'ACTIVE' } }),
      prisma.stage.count({ where: { status: 'AWAITING_FEEDBACK' } }),
      // Every stage settled, nothing skipped mid-flight, and still no call
      // made. This is the queue a debrief exists to drain, and it is invisible
      // anywhere else in the product.
      prisma.application.count({
        where: {
          status: 'ACTIVE',
          decision: null,
          stages: { some: {}, every: { status: { in: ['COMPLETE', 'SKIPPED'] } } },
        },
      }),
    ]);

    tiles.push(
      {
        key: 'active',
        label: 'Active applications',
        value: active,
        href: '/admin/pipeline',
      },
      {
        key: 'awaiting-feedback',
        label: 'Rounds awaiting feedback',
        value: awaitingFeedback,
        hint: awaitingFeedback === 0 ? 'The panel is up to date' : 'Chase these',
        href: '/admin/pipeline',
        urgent: awaitingFeedback > 0,
      },
      {
        key: 'awaiting-decision',
        label: 'Ready to decide',
        value: awaitingDecision,
        hint: 'Every round settled, no decision recorded',
        href: '/admin/pipeline',
        urgent: awaitingDecision > 0,
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
 * could only ever describe what the machine observed. A stage moving, a
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
    where: { application: visibleApplicationsWhere(viewer) },
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
