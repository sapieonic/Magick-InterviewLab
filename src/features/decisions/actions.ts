'use server';

import 'server-only';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db/prisma';
import { actionGuard, NotFoundError } from '@/lib/errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { requireCapability } from '@/features/auth/guards';
import { assertCanViewApplication } from '@/features/pipeline/access';
import { AUDIT, record } from '@/lib/audit';
import { recordDecisionSchema } from '@/lib/validation/schemas';
import { getApplicationScorecard } from '@/features/scorecard/queries';
import type { SessionUser } from '@/features/auth/session';
import type { Prisma } from '@/generated/prisma/client';

/**
 * The hire / no-hire.
 *
 * A `Decision` is the one place in this product where a verdict exists, and it
 * exists because a person wrote it down with a reason. The rationale minimum
 * lives in the schema; the two rules that need the database are here.
 */

/**
 * This action does NOT change `Application.status`.
 *
 * It was tempting — HIRE could set HIRED, NO_HIRE could set REJECTED — and it
 * is wrong for three reasons. A decision and an application's status answer
 * different questions: "what did we conclude" versus "is this still open".
 * `HOLD` has no status to flip to at all, so a third of the outcomes would
 * behave differently from the other two. And closing an application is the
 * recruiter's accountability — `RECRUITER` deliberately holds
 * `MANAGE_PIPELINE` without `DECIDE`, precisely so that deciding and
 * processing stay separate — so a decider silently closing the requisition
 * would take a step out of the hands of the person answerable for it,
 * including the parts this product does not know about: the offer, the
 * rejection note, the candidate's own answer.
 *
 * So the status is left exactly as it was and the debrief page says plainly,
 * next to the recorded decision, that the application is still open and who
 * closes it.
 */
export async function recordDecisionAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('DECIDE');
    const input = recordDecisionSchema.parse({
      applicationId: formData.get('applicationId'),
      outcome: formData.get('outcome'),
      rationale: formData.get('rationale'),
    });
    await assertCanViewApplication(viewer, input.applicationId);

    const application = await prisma.application.findUnique({
      where: { id: input.applicationId },
      select: { id: true },
    });
    if (!application) throw new NotFoundError('Application');

    const existing = await prisma.decision.findUnique({
      where: { applicationId: input.applicationId },
      select: { id: true, outcome: true, rationale: true, decidedById: true, decidedAt: true },
    });

    // The signal as *this* decider saw it, read through the same
    // viewer-scoped model the debrief page rendered — blind rule included.
    // The point of the snapshot is to answer "what was in front of them",
    // which is not the same question as "what does the data say now".
    const snapshot = await buildSnapshot(viewer, input.applicationId);
    const changed = existing !== null;

    await prisma.$transaction(async (tx) => {
      const decision = await tx.decision.upsert({
        where: { applicationId: input.applicationId },
        create: {
          applicationId: input.applicationId,
          outcome: input.outcome,
          rationale: input.rationale,
          decidedById: viewer.id,
          decidedAt: new Date(),
          snapshot,
        },
        update: {
          outcome: input.outcome,
          rationale: input.rationale,
          decidedById: viewer.id,
          decidedAt: new Date(),
          snapshot,
        },
        select: { id: true },
      });

      // A reversal must never be invisible. The row holds only the current
      // outcome, so the previous one goes into the log or it is gone.
      await record(
        {
          actorId: viewer.id,
          action: changed ? AUDIT.DECISION_CHANGED : AUDIT.DECISION_RECORDED,
          entityType: 'Decision',
          entityId: decision.id,
          applicationId: input.applicationId,
          metadata: {
            outcome: input.outcome,
            ...(existing
              ? {
                  previousOutcome: existing.outcome,
                  previousRationale: existing.rationale,
                  previousDecidedById: existing.decidedById,
                  previousDecidedAt: existing.decidedAt.toISOString(),
                }
              : {}),
          },
        },
        tx,
      );
    });

    revalidatePath(`/admin/applications/${input.applicationId}`);
    revalidatePath(`/admin/applications/${input.applicationId}/scorecard`);
    revalidatePath('/admin/pipeline');

    return ok();
  });
}

/**
 * Freeze the aggregate signal into plain JSON.
 *
 * Only the numbers: distribution, disagreement, per-criterion averages and
 * outstanding counts. No prose is copied in — a scorecard is already stored,
 * versioned and append-only, and duplicating its text here would create a
 * second copy that a later revision could not reach.
 */
async function buildSnapshot(
  viewer: SessionUser,
  applicationId: string,
): Promise<Prisma.InputJsonValue> {
  // The real viewer, never a synthesised privileged one: if the blind rule
  // withheld a scorecard from the decider, the snapshot has to show that the
  // decision was taken without it.
  const scorecard = await getApplicationScorecard(viewer, applicationId);
  if (!scorecard) return {};
  return {
    capturedAt: new Date().toISOString(),
    signal: JSON.parse(JSON.stringify(scorecard.signal)) as Prisma.InputJsonValue,
  };
}
