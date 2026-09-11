'use server';

import 'server-only';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db/prisma';
import { actionGuard, AppError, NotFoundError } from '@/lib/errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { requireCapability, requireStaff } from '@/features/auth/guards';
import { assertPanelMember } from '@/features/pipeline/access';
import { AUDIT, record } from '@/lib/audit';
import {
  cuidSchema,
  saveFeedbackDraftSchema,
  submissionNoteSchema,
  submitFeedbackSchema,
} from '@/lib/validation/schemas';
import { resolveSubmissionScope } from './queries';
import type { Confidence, Recommendation } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';

/**
 * Writing scorecards and reviewer notes.
 *
 * Three rules are enforced here and nowhere else, because an action is a
 * public endpoint that no page ever has to be loaded to reach:
 *
 *  1. Writing a scorecard takes a *panel seat*, not a role — `assertPanelMember`.
 *  2. Scores are checked against the criterion's own `maxScore`, which the Zod
 *     schema cannot know, and a submit must cover every criterion of the
 *     pinned rubric version. A draft may be as incomplete as its author likes.
 *  3. A submitted scorecard is append-only: an edit snapshots the complete
 *     prior state into `FeedbackRevision` inside the same transaction as the
 *     update, so there is no window in which the old state is simply gone.
 */

interface ScoreInput {
  criterionId: string;
  score: number;
  note: string;
}

interface FeedbackBody {
  stageId: string;
  recommendation: Recommendation | null;
  confidence: Confidence | null;
  summary: string;
  strengths: string;
  concerns: string;
  scores: ScoreInput[];
}

/**
 * Per-criterion inputs are named `score:<criterionId>` / `note:<criterionId>`,
 * so one form carries a rubric of any shape without the client having to
 * serialise an array by index.
 *
 * A criterion with a note but no score is dropped: `FeedbackScore.score` is
 * not nullable, and a note hanging off a scale nobody placed a mark on is not
 * something a debrief can read.
 */
function readScores(
  formData: FormData,
): Array<{ criterionId: string; score: string; note: string }> {
  const out: Array<{ criterionId: string; score: string; note: string }> = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('score:')) continue;
    if (typeof value !== 'string' || value.trim() === '') continue;
    const criterionId = key.slice('score:'.length);
    const note = formData.get(`note:${criterionId}`);
    out.push({ criterionId, score: value, note: typeof note === 'string' ? note : '' });
  }
  return out;
}

function readBody(formData: FormData): Record<string, unknown> {
  return {
    stageId: formData.get('stageId'),
    recommendation: formData.get('recommendation') ?? '',
    confidence: formData.get('confidence') ?? '',
    summary: formData.get('summary') ?? '',
    strengths: formData.get('strengths') ?? '',
    concerns: formData.get('concerns') ?? '',
    scores: readScores(formData),
  };
}

/** `''` is how a native <select> says "not chosen"; the column says `null`. */
function optionalEnum<T extends string>(value: T | '' | undefined): T | null {
  return value === undefined || value === '' ? null : value;
}

interface PinnedCriterion {
  id: string;
  name: string;
  maxScore: number;
}

/**
 * Range and membership, against the criteria the scorecard is actually pinned
 * to. Errors are reported per field so the form can mark the offending row
 * rather than shouting one line at the top.
 */
function validateScores(
  scores: readonly ScoreInput[],
  criteria: readonly PinnedCriterion[],
  options: { requireComplete: boolean },
): void {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const fieldErrors: Record<string, string[]> = {};
  const seen = new Set<string>();

  for (const score of scores) {
    const criterion = byId.get(score.criterionId);
    if (!criterion) {
      // The rubric version is pinned, so an unknown id means a stale form or
      // a hand-rolled POST; neither should be written.
      throw new AppError(
        'This scorecard refers to a criterion the rubric does not have. Reload the page and try again.',
      );
    }
    if (seen.has(score.criterionId)) {
      throw new AppError('That scorecard scored the same criterion twice.');
    }
    seen.add(score.criterionId);

    if (score.score < 1 || score.score > criterion.maxScore) {
      (fieldErrors[`score:${criterion.id}`] ??= []).push(
        `Score “${criterion.name}” between 1 and ${criterion.maxScore}.`,
      );
    }
  }

  if (options.requireComplete) {
    for (const criterion of criteria) {
      if (seen.has(criterion.id)) continue;
      (fieldErrors[`score:${criterion.id}`] ??= []).push('Give this criterion a score.');
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new AppError('Please correct the highlighted scores.', fieldErrors);
  }
}

const EXISTING_SELECT = {
  id: true,
  status: true,
  recommendation: true,
  confidence: true,
  summary: true,
  strengths: true,
  concerns: true,
  rubricVersionId: true,
  submittedAt: true,
  updatedAt: true,
  scores: { select: { criterionId: true, score: true, note: true } },
} as const;

/** The transaction handle both writes run against. */
type Tx = Prisma.TransactionClient;

/**
 * Load the stage, the viewer's existing scorecard and the criteria the
 * scorecard is measured against — all inside the caller's transaction.
 *
 * The rubric version is pinned on the `Feedback` row and, once set, is never
 * re-read from the stage: a scorecard has to keep reporting the criteria it
 * was actually written against even if the stage is later re-pointed. It *is*
 * taken from the stage while still null, so a stage that gained its rubric
 * after someone opened a blank draft is not a dead end.
 *
 * `tx` rather than `prisma` is the whole point. Read outside the transaction,
 * `existing` is a snapshot of a row two requests are about to fight over: two
 * concurrent edits both see the same prior state, both write a
 * `FeedbackRevision` holding it, and one edit's content never reaches the
 * trail at all — which is precisely the append-only guarantee the trail is
 * for.
 */
async function loadWriteContext(tx: Tx, stageId: string, authorId: string) {
  const stage = await tx.stage.findUnique({
    where: { id: stageId },
    select: { id: true, applicationId: true, rubricVersionId: true },
  });
  if (!stage) throw new NotFoundError('Stage');

  const existing = await tx.feedback.findUnique({
    where: { stageId_authorId: { stageId, authorId } },
    select: EXISTING_SELECT,
  });

  const pinnedVersionId = existing?.rubricVersionId ?? stage.rubricVersionId;
  const criteria: PinnedCriterion[] = pinnedVersionId
    ? await tx.rubricCriterion.findMany({
        where: { rubricVersionId: pinnedVersionId },
        orderBy: { position: 'asc' },
        select: { id: true, name: true, maxScore: true },
      })
    : [];

  return { stage, existing, pinnedVersionId, criteria };
}

/** P2002 — here, always `feedback_stageId_authorId_key`. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

/**
 * Run a scorecard write, and run it again if the create lost a race.
 *
 * The shape being avoided is the one `linkAssignmentToStage` calls out in the
 * pipeline module: read, branch on what you read, write. Double-click Submit
 * and two requests both find no scorecard, both `create`, and the second
 * violates the unique index — which `actionGuard` renders as "That value is
 * already taken.", a sentence that means nothing next to a scorecard form.
 *
 * A P2002 here means somebody else's create landed between our read and our
 * write, so re-running the whole callback re-reads, finds the row, and takes
 * the update path — which is what the second submit meant in the first place.
 * Once only: a second conflict is not a race a retry loop can resolve.
 */
async function writeFeedback<T>(write: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(write);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return prisma.$transaction(write);
  }
}

function revalidateFeedback(stageId: string, applicationId: string): void {
  revalidatePath('/admin/feedback');
  revalidatePath(`/admin/stages/${stageId}`);
  revalidatePath(`/admin/applications/${applicationId}`);
  revalidatePath(`/admin/applications/${applicationId}/scorecard`);
}

export async function saveFeedbackDraftAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('GIVE_FEEDBACK');
    const parsed = saveFeedbackDraftSchema.parse(readBody(formData));
    // The capability says the role may write scorecards; this says they sat
    // in this interview. An admin who was not on the panel gets nothing.
    await assertPanelMember(viewer, parsed.stageId);

    const body: FeedbackBody = {
      stageId: parsed.stageId,
      recommendation: optionalEnum(parsed.recommendation),
      confidence: optionalEnum(parsed.confidence),
      summary: parsed.summary,
      strengths: parsed.strengths,
      concerns: parsed.concerns,
      scores: parsed.scores,
    };

    const applicationId = await writeFeedback(async (tx) => {
      const { stage, existing, pinnedVersionId, criteria } = await loadWriteContext(
        tx,
        parsed.stageId,
        viewer.id,
      );

      // Saving over a submitted scorecard would quietly demote evidence back to
      // a draft and lose the revision trail. Editing is allowed — through
      // `submitFeedbackAction`, which writes the snapshot first.
      if (existing?.status === 'SUBMITTED') {
        throw new AppError(
          'This scorecard has already been submitted. Edit and submit it again — the change is recorded as a revision.',
        );
      }

      validateScores(body.scores, criteria, { requireComplete: false });

      const saved = existing
        ? await tx.feedback.update({
            where: { id: existing.id },
            data: {
              recommendation: body.recommendation,
              confidence: body.confidence,
              summary: body.summary,
              strengths: body.strengths,
              concerns: body.concerns,
              ...(existing.rubricVersionId === null && pinnedVersionId
                ? { rubricVersionId: pinnedVersionId }
                : {}),
            },
            select: { id: true },
          })
        : await tx.feedback.create({
            data: {
              stageId: parsed.stageId,
              authorId: viewer.id,
              status: 'DRAFT',
              recommendation: body.recommendation,
              confidence: body.confidence,
              summary: body.summary,
              strengths: body.strengths,
              concerns: body.concerns,
              rubricVersionId: pinnedVersionId,
            },
            select: { id: true },
          });

      // Replace wholesale rather than diff: the form always posts the full
      // rubric, and an upsert-per-criterion would leave a score behind when
      // the author clears one.
      await tx.feedbackScore.deleteMany({ where: { feedbackId: saved.id } });
      if (body.scores.length > 0) {
        await tx.feedbackScore.createMany({
          data: body.scores.map((score) => ({
            feedbackId: saved.id,
            criterionId: score.criterionId,
            score: score.score,
            note: score.note,
          })),
        });
      }

      await record(
        {
          actorId: viewer.id,
          action: AUDIT.FEEDBACK_SAVED,
          entityType: 'Feedback',
          entityId: saved.id,
          applicationId: stage.applicationId,
          metadata: { stageId: parsed.stageId },
        },
        tx,
      );

      return stage.applicationId;
    });

    revalidateFeedback(parsed.stageId, applicationId);
    return ok();
  });
}

/**
 * First submit and every later edit.
 *
 * Both go through one action because they are the same write with one extra
 * step: an edit to something already submitted appends a `FeedbackRevision`
 * holding the complete prior state — recommendation, confidence, all three
 * prose fields and every score — before the update touches anything.
 */
export async function submitFeedbackAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('GIVE_FEEDBACK');
    const parsed = submitFeedbackSchema.parse({
      ...readBody(formData),
      revisionReason: formData.get('revisionReason') ?? '',
    });
    await assertPanelMember(viewer, parsed.stageId);

    const now = new Date();

    const applicationId = await writeFeedback(async (tx) => {
      const { stage, existing, pinnedVersionId, criteria } = await loadWriteContext(
        tx,
        parsed.stageId,
        viewer.id,
      );

      // A partial scorecard is not evidence: a debrief that reads "3 of 5
      // criteria" cannot tell a gap from a reservation.
      validateScores(parsed.scores, criteria, { requireComplete: true });

      const isRevision = existing?.status === 'SUBMITTED';

      if (isRevision && existing) {
        await tx.feedbackRevision.create({
          data: {
            feedbackId: existing.id,
            editedById: viewer.id,
            reason: parsed.revisionReason,
            snapshot: snapshotOf(existing),
          },
        });
      }

      const saved = existing
        ? await tx.feedback.update({
            where: { id: existing.id },
            data: {
              status: 'SUBMITTED',
              recommendation: parsed.recommendation,
              confidence: parsed.confidence,
              summary: parsed.summary,
              strengths: parsed.strengths,
              concerns: parsed.concerns,
              // The original stands: `submittedAt` is when this became
              // evidence the panel could read, and a revision does not reset
              // that. The edit itself is dated by the revision row.
              submittedAt: existing.submittedAt ?? now,
              ...(existing.rubricVersionId === null && pinnedVersionId
                ? { rubricVersionId: pinnedVersionId }
                : {}),
            },
            select: { id: true },
          })
        : await tx.feedback.create({
            data: {
              stageId: parsed.stageId,
              authorId: viewer.id,
              status: 'SUBMITTED',
              recommendation: parsed.recommendation,
              confidence: parsed.confidence,
              summary: parsed.summary,
              strengths: parsed.strengths,
              concerns: parsed.concerns,
              rubricVersionId: pinnedVersionId,
              submittedAt: now,
            },
            select: { id: true },
          });

      await tx.feedbackScore.deleteMany({ where: { feedbackId: saved.id } });
      if (parsed.scores.length > 0) {
        await tx.feedbackScore.createMany({
          data: parsed.scores.map((score) => ({
            feedbackId: saved.id,
            criterionId: score.criterionId,
            score: score.score,
            note: score.note,
          })),
        });
      }

      await record(
        {
          actorId: viewer.id,
          action: isRevision ? AUDIT.FEEDBACK_REVISED : AUDIT.FEEDBACK_SUBMITTED,
          entityType: 'Feedback',
          entityId: saved.id,
          applicationId: stage.applicationId,
          metadata: {
            stageId: parsed.stageId,
            recommendation: parsed.recommendation,
            ...(isRevision
              ? {
                  reason: parsed.revisionReason,
                  previousRecommendation: existing?.recommendation ?? null,
                }
              : {}),
          },
        },
        tx,
      );

      return stage.applicationId;
    });

    // Deliberately does not move the stage on. Whether a round is complete is
    // the pipeline's call, made once every panellist has reported, and a
    // scorecard action that silently advanced a candidate would be a
    // side effect nobody asked for.
    revalidateFeedback(parsed.stageId, applicationId);
    return ok();
  });
}

/** The complete prior content, as plain JSON the column can hold. */
function snapshotOf(existing: {
  status: string;
  recommendation: Recommendation | null;
  confidence: Confidence | null;
  summary: string;
  strengths: string;
  concerns: string;
  rubricVersionId: string | null;
  submittedAt: Date | null;
  updatedAt: Date;
  scores: Array<{ criterionId: string; score: number; note: string }>;
}): Prisma.InputJsonValue {
  return {
    status: existing.status,
    recommendation: existing.recommendation,
    confidence: existing.confidence,
    summary: existing.summary,
    strengths: existing.strengths,
    concerns: existing.concerns,
    rubricVersionId: existing.rubricVersionId,
    // ISO strings, not Date objects: this round-trips through a Json column,
    // and a Date would come back as a string anyway — better to be explicit
    // than to have the shape change on the way out.
    submittedAt: existing.submittedAt?.toISOString() ?? null,
    updatedAt: existing.updatedAt.toISOString(),
    scores: existing.scores.map((score) => ({
      criterionId: score.criterionId,
      score: score.score,
      note: score.note,
    })),
  };
}

/**
 * A reviewer note on a submission.
 *
 * Guarded by `requireStaff` plus the object-level check rather than a named
 * capability: the right to annotate code follows the right to read it, and
 * `resolveSubmissionScope` is what decides that — via the owning application
 * where the submission is a round of one, and `VIEW_ALL_APPLICATIONS` where
 * it is a bare assessment that no pipeline has picked up yet.
 */
export async function addSubmissionNoteAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireStaff();
    const input = submissionNoteSchema.parse({
      submissionId: formData.get('submissionId'),
      body: formData.get('body'),
      lineStart: formData.get('lineStart') ?? '',
      lineEnd: formData.get('lineEnd') ?? '',
    });

    const scope = await resolveSubmissionScope(viewer, input.submissionId);
    if (!scope) throw new NotFoundError('Submission');

    const note = await prisma.submissionNote.create({
      data: {
        submissionId: input.submissionId,
        authorId: viewer.id,
        body: input.body,
        lineStart: input.lineStart,
        lineEnd: input.lineEnd,
      },
      select: { id: true },
    });

    await record({
      actorId: viewer.id,
      action: AUDIT.NOTE_ADDED,
      entityType: 'SubmissionNote',
      entityId: note.id,
      applicationId: scope.applicationId,
      metadata: { submissionId: input.submissionId },
    });

    revalidatePath(`/admin/submissions/${input.submissionId}`);
    return ok();
  });
}

/**
 * Author only — an admin may not tidy away somebody else's note.
 *
 * A review thread that a third party can edit is one people stop writing
 * candidly in, which costs more than the occasional stale note.
 *
 * "Not yours" and "no such note" are deliberately the same answer. Two
 * distinguishable outcomes turn this action into an existence oracle: post ids
 * until one stops saying "not found" and you have enumerated other people's
 * notes without ever being allowed to read one. This codebase's rule is 404
 * rather than 403 everywhere else — see `access.ts` — and authorship is not
 * the exception.
 */
export async function deleteSubmissionNoteAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireStaff();
    const id = cuidSchema.parse(formData.get('id'));

    const note = await prisma.submissionNote.findUnique({
      where: { id },
      select: { id: true, authorId: true, submissionId: true },
    });
    if (!note || note.authorId !== viewer.id) throw new NotFoundError('Note');
    // Still object-level checked: authorship is not access, and a reviewer
    // who has since lost their seat should not be able to reach back in.
    const scope = await resolveSubmissionScope(viewer, note.submissionId);
    if (!scope) throw new NotFoundError('Submission');

    await prisma.submissionNote.delete({ where: { id } });

    // A deleted note is still a thing a reviewer did. Recording the removal
    // costs nothing and keeps the trail honest — an audit log with a hole in
    // it where someone retracted an opinion is worse than no log at all.
    await record({
      actorId: viewer.id,
      action: AUDIT.NOTE_DELETED,
      entityType: 'SubmissionNote',
      entityId: id,
      applicationId: scope.applicationId,
      metadata: { submissionId: note.submissionId },
    });

    revalidatePath(`/admin/submissions/${note.submissionId}`);
    return ok();
  });
}
