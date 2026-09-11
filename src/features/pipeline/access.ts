import 'server-only';
import { prisma } from '@/lib/db/prisma';
import { AuthorizationError } from '@/features/auth/guards';
import { can, isStaff } from '@/features/auth/capabilities';
import type { SessionUser } from '@/features/auth/session';
import type { Prisma } from '@/generated/prisma/client';

/**
 * Object-level access to a candidate's pipeline.
 *
 * The capability table says whether a role may read applications *at all*.
 * This module answers the narrower question — may this person read *this*
 * one — and it exists because the honest answer for an interviewer is "only
 * the candidates you are actually on".
 *
 * Everything here treats a missing row and a forbidden row identically, the
 * same call the rest of the app already makes for a candidate's workspace:
 * existence does not leak. A caller that wants a 404 gets `null`; a caller
 * that wants a thrown error asks for one.
 */

/**
 * The `where` fragment that scopes a list query to what the viewer may see.
 *
 * An empty object for the privileged case is intentional — merged into a
 * Prisma `where` it adds no constraint, so list queries need no branch.
 */
export function visibleApplicationsWhere(viewer: SessionUser): Prisma.ApplicationWhereInput {
  if (!isStaff(viewer.role)) {
    // Unsatisfiable rather than "everything". A candidate must never reach a
    // list of applications, and a bug that routes them here should return
    // nothing rather than the pipeline.
    return { id: { in: [] } };
  }
  if (can(viewer.role, 'VIEW_ALL_APPLICATIONS')) return {};
  // An interviewer sees an application only through a panel seat on it.
  return { stages: { some: { interviewers: { some: { userId: viewer.id } } } } };
}

/** True when the viewer may open this application at all. */
export async function canViewApplication(
  viewer: SessionUser,
  applicationId: string,
): Promise<boolean> {
  if (!isStaff(viewer.role)) return false;
  if (can(viewer.role, 'VIEW_ALL_APPLICATIONS')) {
    const exists = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { id: true },
    });
    return exists !== null;
  }
  const seat = await prisma.stageInterviewer.findFirst({
    where: { userId: viewer.id, stage: { applicationId } },
    select: { id: true },
  });
  return seat !== null;
}

/** Throws `AuthorizationError` unless the viewer may open this application. */
export async function assertCanViewApplication(
  viewer: SessionUser,
  applicationId: string,
): Promise<void> {
  if (!(await canViewApplication(viewer, applicationId))) throw new AuthorizationError();
}

export interface PanelSeat {
  stageId: string;
  applicationId: string;
  isPanelist: boolean;
  stageIsBlind: boolean;
}

/**
 * Resolve the viewer's standing on a stage in one query.
 *
 * Returns `null` when the stage does not exist *or* the viewer may not see the
 * application it belongs to, so a caller can `notFound()` on both without
 * distinguishing them.
 */
export async function getPanelSeat(
  viewer: SessionUser,
  stageId: string,
): Promise<PanelSeat | null> {
  if (!isStaff(viewer.role)) return null;

  const stage = await prisma.stage.findUnique({
    where: { id: stageId },
    select: {
      id: true,
      applicationId: true,
      blindFeedback: true,
      interviewers: { where: { userId: viewer.id }, select: { id: true } },
    },
  });
  if (!stage) return null;

  const isPanelist = stage.interviewers.length > 0;
  if (!isPanelist && !can(viewer.role, 'VIEW_ALL_APPLICATIONS')) return null;

  return {
    stageId: stage.id,
    applicationId: stage.applicationId,
    isPanelist,
    stageIsBlind: stage.blindFeedback,
  };
}

/**
 * Writing a scorecard takes a panel seat, not a role.
 *
 * This is the object-level half of `GIVE_FEEDBACK`: an admin has the
 * capability and still may not score a round they were not on, because a
 * scorecard from someone who did not sit in the interview is not evidence.
 */
export async function assertPanelMember(viewer: SessionUser, stageId: string): Promise<PanelSeat> {
  const seat = await getPanelSeat(viewer, stageId);
  if (!seat || !seat.isPanelist) throw new AuthorizationError();
  return seat;
}
