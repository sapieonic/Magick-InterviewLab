'use server';

import 'server-only';
import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db/prisma';
import { actionGuard, AppError, NotFoundError } from '@/lib/errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { requireCapability } from '@/features/auth/guards';
import { AUDIT, record } from '@/lib/audit';
import { cuidSchema, rubricInputSchema, rubricVersionInputSchema } from '@/lib/validation/schemas';

/**
 * Rubric authoring.
 *
 * One rule sits underneath every action in this file: **a published version is
 * immutable.** A `Feedback` row pins the `rubricVersionId` it was written
 * against, and a `FeedbackScore` points at a specific `RubricCriterion`. If
 * publishing did not freeze the criteria, renaming "Communication" to "Raises
 * concerns early" would retroactively change what a scorecard from six weeks
 * ago claims its author meant — and reweighting one would change the number a
 * debrief already argued over. So the criteria of a published version are not
 * editable by any path here; the affordance is a *new draft*, which starts as
 * a deep copy and gets its own ids.
 *
 * That is also why publishing is irreversible. "Unpublish" would have to mean
 * one of two things — reopen the frozen rows for editing (the thing the freeze
 * exists to forbid) or hide a version that stages are already pinned to — and
 * neither is a state this model can be in. Retiring a rubric is `archiveRubric`;
 * changing one is a new version.
 */

const updateRubricSchema = rubricInputSchema.extend({
  id: cuidSchema,
  isActive: z.boolean(),
});

/**
 * A unique-constraint violation, recognised without importing Prisma's error
 * class (which drags the client's runtime into a module that only needs a
 * string). `actionGuard` renders any P2002 it is handed as "That value is
 * already taken", which means nothing to someone who never typed a value —
 * so the one place here that can lose that race says what happened itself.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return (error as { code: unknown }).code === 'P2002';
}

function revalidateRubric(id?: string): void {
  revalidatePath('/admin');
  revalidatePath('/admin/rubrics');
  if (id) revalidatePath(`/admin/rubrics/${id}`);
  // Pipeline templates choose a rubric, and the stage editor offers published
  // versions: publishing or archiving here changes what those pickers may show.
  revalidatePath('/admin/pipeline');
}

export async function createRubricAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const actor = await requireCapability('MANAGE_CONTENT');
    const input = rubricInputSchema.parse({
      name: formData.get('name'),
      description: formData.get('description') ?? '',
    });

    // The rubric and its first draft are written together. A rubric with no
    // version has nothing to edit and nothing to publish, so leaving the second
    // insert to the editor page would let a failed navigation strand a row that
    // looks like a rubric and cannot be used as one.
    const rubric = await prisma.$transaction(async (tx) => {
      const created = await tx.rubric.create({ data: input, select: { id: true } });
      await tx.rubricVersion.create({
        data: { rubricId: created.id, version: 1, createdById: actor.id },
      });
      return created;
    });

    revalidateRubric(rubric.id);
    // Straight into the editor, as createInterviewAction does: an empty draft
    // is not yet a usable instrument, and the next step is always "add criteria".
    redirect(`/admin/rubrics/${rubric.id}`);
  });
}

export async function updateRubricAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const input = updateRubricSchema.parse({
      id: formData.get('id'),
      name: formData.get('name'),
      description: formData.get('description') ?? '',
      // An unchecked box submits nothing at all, which is the only way to tell
      // "off" from "untouched" in a plain form POST.
      isActive: formData.get('isActive') !== null,
    });

    const existing = await prisma.rubric.findUnique({
      where: { id: input.id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundError('Rubric');

    // Only the rubric's own profile. The name is a label on the instrument,
    // not part of the scale, so editing it does not disturb any frozen version.
    await prisma.rubric.update({
      where: { id: input.id },
      data: { name: input.name, description: input.description, isActive: input.isActive },
    });

    revalidateRubric(input.id);
    return ok();
  });
}

export interface SavedRubricVersion {
  /**
   * The persisted criterion ids, in saved order.
   *
   * Handed back so the still-mounted editor can adopt the ids it did not have
   * when it posted. Without it a second save from the same page sends the new
   * rows with no id again, and the server — correctly, from what it was told —
   * creates a fresh set and deletes the ones it made a moment ago, churning
   * the very ids `FeedbackScore` hangs off.
   */
  criterionIds: string[];
}

/**
 * Replace the criteria of a draft version.
 *
 * Takes a typed payload rather than FormData for the reason `saveQuestionAction`
 * gives: the editor holds a variable-length list of sub-rows, and flattening it
 * into form field names buys nothing and loses the schema.
 */
export async function saveRubricVersionAction(
  payload: unknown,
): Promise<ActionResult<SavedRubricVersion>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const input = rubricVersionInputSchema.parse(payload);

    const version = await prisma.rubricVersion.findUnique({
      where: { id: input.versionId },
      select: {
        id: true,
        rubricId: true,
        version: true,
        isPublished: true,
        criteria: { select: { id: true } },
      },
    });
    if (!version) throw new NotFoundError('Rubric version');
    if (version.isPublished) {
      throw new AppError(
        `Version ${version.version} is published and cannot be edited. Create a new draft version instead.`,
      );
    }

    // The same id twice is the failure the length of the list cannot catch:
    // each occurrence would update the one row, the second overwriting the
    // first's position, and the save would silently collapse two criteria into
    // one. Reject rather than guess which one the author meant.
    const sent = new Set<string>();
    for (const criterion of input.criteria) {
      if (!criterion.id) continue;
      if (sent.has(criterion.id)) {
        throw new AppError('The criteria list changed while you were editing. Reload and retry.');
      }
      sent.add(criterion.id);
    }

    // An id this version does not own is treated as a new row — it could be
    // stale, forged, or copied from another rubric — so a save can never adopt
    // or resurrect a criterion belonging to someone else's version.
    const ownedIds = new Set(version.criteria.map((criterion) => criterion.id));

    const criterionIds = await prisma.$transaction(async (tx) => {
      // The check above is a read, and a read holds nothing still. Author B can
      // publish this version between A's read and this transaction, and A would
      // then rewrite and delete the criteria of a frozen version — silently
      // re-weighting every stage pinned to it, and taking with it every score
      // already entered, because `feedback_scores_criterionId_fkey` is ON
      // DELETE CASCADE. So the guard is folded into the first *write*: the
      // notes update this save owes anyway matches nothing if the version was
      // published meanwhile, which refuses the save atomically, and it takes
      // the row lock a concurrent publish then has to wait behind.
      const { count } = await tx.rubricVersion.updateMany({
        where: { id: version.id, isPublished: false },
        data: { notes: input.notes },
      });
      if (count === 0) {
        throw new AppError(
          `Version ${version.version} was published while you were editing, so it can no longer be changed. Open a new draft version to carry your changes forward.`,
        );
      }

      const keptIds = new Set<string>();
      const savedIds: string[] = [];

      // Diff in place rather than delete-and-recreate. A criterion's id is what
      // a `FeedbackScore` points at, so re-minting ids on every save would
      // orphan the scores anybody had already entered against this draft —
      // which is legal to do (the version is unpublished) and still loses work.
      // `position` is renumbered from the array index on every save, exactly as
      // reorderInterviewQuestionsAction does: a gap is harmless to the database
      // and wrong to a reader, who sees "criterion 3 of 5" built from it.
      for (const [position, criterion] of input.criteria.entries()) {
        const fields = {
          name: criterion.name,
          description: criterion.description,
          weight: criterion.weight,
          maxScore: criterion.maxScore,
          position,
        };

        if (criterion.id && ownedIds.has(criterion.id)) {
          await tx.rubricCriterion.update({ where: { id: criterion.id }, data: fields });
          keptIds.add(criterion.id);
          savedIds.push(criterion.id);
        } else {
          const created = await tx.rubricCriterion.create({
            data: { ...fields, rubricVersionId: version.id },
            select: { id: true },
          });
          savedIds.push(created.id);
        }
      }

      const removed = [...ownedIds].filter((id) => !keptIds.has(id));
      if (removed.length > 0) {
        await tx.rubricCriterion.deleteMany({ where: { id: { in: removed } } });
      }

      return savedIds;
    });

    revalidateRubric(version.rubricId);
    return ok({ criterionIds });
  });
}

/**
 * Freeze a draft. Irreversible — see the module comment.
 */
export async function publishRubricVersionAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const actor = await requireCapability('MANAGE_CONTENT');
    const versionId = cuidSchema.parse(formData.get('versionId'));

    const version = await prisma.rubricVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        rubricId: true,
        version: true,
        isPublished: true,
        _count: { select: { criteria: true } },
      },
    });
    if (!version) throw new NotFoundError('Rubric version');
    if (version.isPublished) throw new AppError('That version is already published.');
    if (version._count.criteria === 0) {
      throw new AppError(
        'Add at least one criterion before publishing — an empty rubric gives an interviewer nothing to score.',
      );
    }

    // Conditional write rather than a plain update: the check above and the
    // write below are two round trips, and publishing is irreversible, so the
    // `isPublished: false` in the filter is what makes a double submit land
    // once. A second attempt matches nothing and is reported, not re-stamped
    // with a new publishedAt.
    const { count } = await prisma.rubricVersion.updateMany({
      where: { id: versionId, isPublished: false },
      data: { isPublished: true, publishedAt: new Date() },
    });
    if (count === 0) throw new AppError('That version is already published.');

    await record({
      actorId: actor.id,
      action: AUDIT.RUBRIC_PUBLISHED,
      entityType: 'RubricVersion',
      entityId: versionId,
      metadata: {
        rubricId: version.rubricId,
        version: version.version,
        criteriaCount: version._count.criteria,
      },
    });

    revalidateRubric(version.rubricId);
    return ok();
  });
}

/**
 * Open the next draft, seeded with a copy of the latest version's criteria.
 *
 * The copy is what makes "edit a published rubric" a safe request to make: the
 * author gets the wording they expected to edit, in rows that belong to a new
 * version, while the published rows keep their ids and every scorecard pinned
 * to them keeps meaning what it said.
 */
export async function createRubricVersionAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const actor = await requireCapability('MANAGE_CONTENT');
    const rubricId = cuidSchema.parse(formData.get('rubricId'));

    const rubric = await prisma.rubric.findUnique({
      where: { id: rubricId },
      select: {
        id: true,
        versions: {
          orderBy: { version: 'desc' },
          select: {
            id: true,
            version: true,
            isPublished: true,
            criteria: {
              orderBy: { position: 'asc' },
              select: { name: true, description: true, weight: true, maxScore: true },
            },
          },
        },
      },
    });
    if (!rubric) throw new NotFoundError('Rubric');

    // One draft at a time. Two open drafts would both claim to be "the next
    // version", and whichever was published second would silently become the
    // rubric everyone gets — with the other author's edits nowhere in it.
    const openDraft = rubric.versions.find((version) => !version.isPublished);
    if (openDraft) {
      throw new AppError(
        `Version ${openDraft.version} is still a draft. Publish or finish that one before starting another.`,
      );
    }

    const latest = rubric.versions[0];
    const nextVersion = (latest?.version ?? 0) + 1;

    try {
      await prisma.$transaction(async (tx) => {
        const created = await tx.rubricVersion.create({
          data: { rubricId, version: nextVersion, createdById: actor.id },
          select: { id: true },
        });

        if (latest && latest.criteria.length > 0) {
          // New rows, not a re-parent: these are a starting point for the draft,
          // and the originals stay attached to the version that was published.
          await tx.rubricCriterion.createMany({
            data: latest.criteria.map((criterion, position) => ({
              rubricVersionId: created.id,
              name: criterion.name,
              description: criterion.description,
              weight: criterion.weight,
              maxScore: criterion.maxScore,
              position,
            })),
          });
        }
      });
    } catch (error) {
      // `nextVersion` came from a read, so two authors opening a draft at the
      // same moment both compute the same number and the loser violates
      // `rubric_versions_rubricId_version_key` — the only unique index this
      // transaction can reach. Deliberately not retried at N+2: the winner's
      // row *is* the one open draft this rubric is allowed, so a retry would
      // create exactly the second draft the guard above exists to refuse.
      if (isUniqueViolation(error)) {
        throw new AppError(
          `Someone else opened version ${nextVersion} while you were starting it. Reload to pick up their draft.`,
        );
      }
      throw error;
    }

    revalidateRubric(rubricId);
    return ok();
  });
}

export async function archiveRubricAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const id = cuidSchema.parse(formData.get('id'));

    const existing = await prisma.rubric.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundError('Rubric');

    // Deactivated, never deleted — the codebase's standing rule for anything
    // with history behind it, and here the cascade makes the cost literal: a
    // rubric delete takes its versions, their criteria, and through
    // `FeedbackScore.criterion` every score ever entered against them. The
    // scorecards would survive as prose with their numbers gone.
    await prisma.rubric.update({ where: { id }, data: { isActive: false } });

    revalidateRubric(id);
    return ok();
  });
}

/**
 * Put an archived rubric back in the pickers.
 *
 * Archiving is a filing decision, not a destructive one — no version, criterion
 * or score changes either way — so it has to be undoable from the same place it
 * was made, by whoever has just realised they archived the wrong row. The
 * `isActive` checkbox on the profile form can technically do this, but it is in
 * the sidebar under two other fields, which is not where anybody looks after
 * pressing "Archive".
 *
 * Nothing is republished by this: a version that was a draft before archiving
 * is still a draft, and one that was frozen is still frozen.
 */
export async function unarchiveRubricAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const id = cuidSchema.parse(formData.get('id'));

    const existing = await prisma.rubric.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundError('Rubric');

    await prisma.rubric.update({ where: { id }, data: { isActive: true } });

    revalidateRubric(id);
    return ok();
  });
}
