'use server';

import 'server-only';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db/prisma';
import { actionGuard, AppError, NotFoundError } from '@/lib/errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { requireCapability } from '@/features/auth/guards';
import { can, isStaff } from '@/features/auth/capabilities';
import { AUDIT, record } from '@/lib/audit';
import { getPublishedVersionForRubric } from '@/features/rubrics/queries';
import {
  addPanelistSchema,
  applicationCommentSchema,
  createApplicationSchema,
  createStageSchema,
  recordStageOutcomeSchema,
  removePanelistSchema,
  setApplicationStatusSchema,
  setStageStatusSchema,
  stageIdSchema,
  updateApplicationSchema,
  updateStageSchema,
} from '@/lib/validation/schemas';
import { applyTemplateSchema, linkStageAssignmentSchema, reorderStagesSchema } from './schemas';
import { assertCanViewApplication } from './access';
import {
  canSetCodingStageStatusByHand,
  canTransitionStageStatus,
  deriveCodingStageStatus,
  stageTransitionError,
} from './stage-status';
import type {
  ApplicationStatus,
  AssignmentStatus,
  StageStatus,
  StageType,
} from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';

/**
 * The application lifecycle: everything that moves one candidate through one
 * hiring process.
 *
 * Three rules run through the whole file and are worth stating once:
 *
 *  1. **Nothing here decides anything.** A stage outcome is a round's verdict,
 *     not the hire; only `setApplicationStatusAction` changes an application's
 *     status, and only because a person explicitly asked it to. See
 *     `recordStageOutcomeAction`, where the temptation is strongest.
 *  2. **Every transition is recorded**, with `applicationId` set, so the
 *     timeline on the detail page is one indexed read rather than an inference
 *     from whatever the rows happen to say today.
 *  3. **`Stage.position` is contiguous from zero.** Inserts append, deletes
 *     renumber, reorders rewrite the whole list. A gap is harmless until
 *     something counts, and the stage list counts. Every write that touches a
 *     position does so inside a transaction, behind the application's row lock
 *     — see `lockApplicationForPositions`, and note that "count the rounds,
 *     then write that number" is only true of the count if nothing else can
 *     insert in between.
 */

const ACTIVE_CLASH =
  'That candidate already has an active application for this role. Close it before starting another.';

/** The client half of an interactive transaction. */
type Tx = Prisma.TransactionClient;

/**
 * Take the application's row lock before assigning `Stage.position`.
 *
 * Position is read-then-written — "the next free slot is however many rounds
 * there are" — and two recruiters clicking "Add round" at the same moment both
 * read 3 and both write 3. Locking the parent row serialises them: the second
 * transaction blocks here until the first commits, then counts 4. A create
 * racing a delete is the same story from the other side, and the delete
 * renumbers under the same lock.
 *
 * `SELECT … FOR UPDATE` on the application rather than a unique index on
 * `(applicationId, position)` because the index alone would only turn the race
 * into a P2002 the recruiter has to read and retry — and because renumbering
 * after a delete transiently duplicates positions, which a deferrable
 * constraint tolerates only inside a transaction. Which is where every write
 * that touches `position` now happens.
 */
async function lockApplicationForPositions(tx: Tx, applicationId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM applications WHERE id = ${applicationId} FOR UPDATE`;
}

function revalidateApplication(id?: string): void {
  revalidatePath('/admin');
  revalidatePath('/admin/pipeline');
  if (id) {
    revalidatePath(`/admin/applications/${id}`);
    revalidatePath(`/admin/applications/${id}/scorecard`);
  }
}

/**
 * The constraint the database cannot express.
 *
 * A partial unique index on `(candidateId, jobRoleId) WHERE status = 'ACTIVE'`
 * would say this in Postgres, but it cannot be written in the Prisma schema —
 * and `jobRoleId` is nullable, where SQL uniqueness would let nulls collide
 * freely anyway. So it is checked here, on every path that can produce an
 * `ACTIVE` row: creation, reopening, and moving an application to a different
 * requisition.
 *
 * A null `jobRoleId` is treated as a value rather than as "no constraint": two
 * live runs with no requisition at all are the same ambiguity as two on the
 * same one, and "which of these is the real one" is precisely the question the
 * rule exists to prevent anybody having to ask.
 */
async function assertNoCompetingActiveApplication(
  candidateId: string,
  jobRoleId: string | null,
  exceptApplicationId?: string,
): Promise<void> {
  const clash = await prisma.application.findFirst({
    where: {
      candidateId,
      jobRoleId,
      status: 'ACTIVE',
      ...(exceptApplicationId ? { NOT: { id: exceptApplicationId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new AppError(ACTIVE_CLASH, { candidateId: [ACTIVE_CLASH] });
}

/** A closed application is a record. Rounds are added to live ones. */
function assertOpen(status: ApplicationStatus): void {
  if (status === 'ACTIVE' || status === 'ON_HOLD') return;
  throw new AppError('This application is closed. Reopen it before changing its rounds.');
}

/**
 * The version a stage is pinned to.
 *
 * Pinning happens once, here, at the moment the stage is created — the
 * template tracks a rubric, an instance freezes a version. A rubric with
 * nothing published yet is refused rather than silently pinned to null,
 * because a stage with no criteria produces a scorecard with nothing to score.
 */
async function resolveRubricVersionId(rubricId: string | null): Promise<string | null> {
  if (!rubricId) return null;
  const version = await getPublishedVersionForRubric(rubricId);
  if (!version) {
    throw new AppError(
      'That rubric has no published version yet. Publish one before pinning it to a round.',
      { rubricId: ['Publish a version of this rubric first.'] },
    );
  }
  return version.id;
}

interface StageRecord {
  id: string;
  applicationId: string;
  name: string;
  type: StageType;
  position: number;
  status: StageStatus;
  blindFeedback: boolean;
  assignmentStatus: AssignmentStatus | null;
  candidateId: string;
}

async function loadStage(id: string): Promise<StageRecord> {
  const stage = await prisma.stage.findUnique({
    where: { id },
    select: {
      id: true,
      applicationId: true,
      name: true,
      type: true,
      position: true,
      status: true,
      blindFeedback: true,
      assignment: { select: { status: true } },
      application: { select: { candidateId: true } },
    },
  });
  if (!stage) throw new NotFoundError('Stage');
  return {
    id: stage.id,
    applicationId: stage.applicationId,
    name: stage.name,
    type: stage.type,
    position: stage.position,
    status: stage.status,
    blindFeedback: stage.blindFeedback,
    assignmentStatus: stage.assignment?.status ?? null,
    candidateId: stage.application.candidateId,
  };
}

/** What the stage's status *is*, which for a coding round is the assignment's
 *  business. See the long note in `stage-status.ts`. */
function currentStageStatus(stage: StageRecord): StageStatus {
  return stage.type === 'CODING_ASSESSMENT'
    ? deriveCodingStageStatus(stage.status, stage.assignmentStatus)
    : stage.status;
}

/**
 * Attach a coding round to the automated assessment that runs it.
 *
 * Create-or-reuse: a candidate already assigned this interview keeps the
 * assignment they have, submissions and all. `Stage.assignmentId` is unique,
 * so an assignment already backing another round is a real conflict — caught
 * here with a sentence a recruiter can act on rather than left to surface as a
 * P2002 that `actionGuard` renders as "That value is already taken."
 */
async function linkAssignmentToStage(
  candidateId: string,
  interviewId: string,
  forStageId: string | null,
): Promise<string> {
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    select: { id: true, status: true },
  });
  if (!interview) throw new AppError('That assessment no longer exists.');

  const existing = await prisma.interviewAssignment.findUnique({
    where: { interviewId_candidateId: { interviewId, candidateId } },
    select: { id: true, stage: { select: { id: true, name: true } } },
  });

  if (existing) {
    if (existing.stage && existing.stage.id !== forStageId) {
      throw new AppError(
        `That assessment is already attached to the round "${existing.stage.name}". One assignment backs one round — detach it there, or pick another assessment.`,
        { interviewId: ['Already used by another round.'] },
      );
    }
    return existing.id;
  }

  const created = await prisma.interviewAssignment.create({
    data: { interviewId, candidateId },
    select: { id: true },
  });
  return created.id;
}

// --- applications -----------------------------------------------------------

export async function createApplicationAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = createApplicationSchema.parse({
      candidateId: formData.get('candidateId'),
      jobRoleId: formData.get('jobRoleId'),
      pipelineTemplateId: formData.get('pipelineTemplateId'),
      ownerId: formData.get('ownerId'),
      source: formData.get('source') ?? '',
    });

    const candidate = await prisma.user.findFirst({
      where: { id: input.candidateId, role: 'CANDIDATE' },
      select: { id: true },
    });
    if (!candidate) throw new NotFoundError('Candidate');

    if (input.jobRoleId) {
      const jobRole = await prisma.jobRole.findUnique({
        where: { id: input.jobRoleId },
        select: { id: true },
      });
      if (!jobRole) throw new AppError('That job role no longer exists.');
    }
    if (input.ownerId) await assertStaffUser(input.ownerId, 'owner');

    await assertNoCompetingActiveApplication(input.candidateId, input.jobRoleId);

    // The application and its rounds are written together, as `createRubricAction`
    // writes a rubric with its first draft. `materialiseTemplate` throws on an
    // empty template or an unpublished rubric, and outside a transaction that
    // left a committed `Application` the recruiter never saw: no redirect, no
    // detail page, and — once they had fixed the rubric and retried — a
    // one-active-application clash against a row they had no way to find.
    const application = await prisma.$transaction(async (tx) => {
      const created = await tx.application.create({
        data: {
          candidateId: input.candidateId,
          jobRoleId: input.jobRoleId,
          ownerId: input.ownerId,
          source: input.source,
          // Recorded on the application even before the stages exist: it is what
          // the process was *meant* to be, and a later template change must not
          // rewrite what this candidate actually sat.
          pipelineTemplateId: input.pipelineTemplateId,
        },
        select: { id: true },
      });

      await record(
        {
          actorId: viewer.id,
          action: AUDIT.APPLICATION_CREATED,
          entityType: 'Application',
          entityId: created.id,
          applicationId: created.id,
          metadata: { jobRoleId: input.jobRoleId, source: input.source },
        },
        tx,
      );

      if (input.pipelineTemplateId) {
        await materialiseTemplate(tx, created.id, input.pipelineTemplateId, viewer.id);
      }

      return created;
    });

    revalidateApplication(application.id);
    revalidatePath(`/admin/candidates/${input.candidateId}`);
    // Straight into the working surface: an application with no rounds is not
    // yet a usable thing, and the next step is always "add the rounds".
    redirect(`/admin/applications/${application.id}`);
  });
}

async function assertStaffUser(id: string, what: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id }, select: { role: true } });
  if (!user) throw new AppError(`That ${what} no longer exists.`);
  if (!isStaff(user.role)) throw new AppError(`A candidate cannot be the ${what}.`);
}

export async function updateApplicationAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = updateApplicationSchema.parse({
      id: formData.get('id'),
      jobRoleId: formData.get('jobRoleId'),
      ownerId: formData.get('ownerId'),
      source: formData.get('source') ?? '',
    });

    const existing = await prisma.application.findUnique({
      where: { id: input.id },
      select: { id: true, candidateId: true, jobRoleId: true, ownerId: true, status: true },
    });
    if (!existing) throw new NotFoundError('Application');

    if (input.ownerId) await assertStaffUser(input.ownerId, 'owner');

    // Moving a live application onto a different requisition can create the
    // very clash creation refuses, so the same check runs here.
    if (existing.status === 'ACTIVE' && input.jobRoleId !== existing.jobRoleId) {
      await assertNoCompetingActiveApplication(existing.candidateId, input.jobRoleId, existing.id);
    }

    await prisma.application.update({
      where: { id: input.id },
      data: { jobRoleId: input.jobRoleId, ownerId: input.ownerId, source: input.source },
    });

    if (input.ownerId !== existing.ownerId) {
      await record({
        actorId: viewer.id,
        action: AUDIT.APPLICATION_OWNER_CHANGED,
        entityType: 'Application',
        entityId: input.id,
        applicationId: input.id,
        metadata: { from: existing.ownerId, to: input.ownerId },
      });
    }

    revalidateApplication(input.id);
    return ok();
  });
}

/** The statuses that mean the process is over and `closedAt` should be set. */
const CLOSED_STATUSES: readonly ApplicationStatus[] = ['HIRED', 'REJECTED', 'WITHDRAWN'];

export async function setApplicationStatusAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = setApplicationStatusSchema.parse({
      id: formData.get('id'),
      status: formData.get('status'),
    });

    const existing = await prisma.application.findUnique({
      where: { id: input.id },
      select: { id: true, candidateId: true, jobRoleId: true, status: true },
    });
    if (!existing) throw new NotFoundError('Application');
    if (existing.status === input.status) return ok();

    // Reopening is the other door into `ACTIVE`, so it gets the same check as
    // creation — otherwise the one-live-run-per-role rule is one click wide.
    if (input.status === 'ACTIVE') {
      await assertNoCompetingActiveApplication(
        existing.candidateId,
        existing.jobRoleId,
        existing.id,
      );
    }

    const closing = CLOSED_STATUSES.includes(input.status);
    await prisma.application.update({
      where: { id: input.id },
      data: {
        status: input.status,
        // Closing stamps the date; reopening clears it, so "closed on" never
        // survives as a fossil of a decision that was undone.
        closedAt: closing ? new Date() : null,
      },
    });

    await record({
      actorId: viewer.id,
      action: AUDIT.APPLICATION_STATUS_CHANGED,
      entityType: 'Application',
      entityId: input.id,
      applicationId: input.id,
      metadata: { from: existing.status, to: input.status },
    });

    revalidateApplication(input.id);
    revalidatePath(`/admin/candidates/${existing.candidateId}`);
    return ok();
  });
}

export async function addApplicationCommentAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    // Deliberately not `MANAGE_PIPELINE`: an interviewer who sat the round is
    // exactly the person who knows the candidate has a holiday booked, and
    // coordination chatter is not a pipeline mutation. The object-level check
    // still applies — they may comment only where they may read.
    const viewer = await requireCapability('ACCESS_CONSOLE');
    const input = applicationCommentSchema.parse({
      applicationId: formData.get('applicationId'),
      body: formData.get('body'),
    });

    await assertCanViewApplication(viewer, input.applicationId);

    const comment = await prisma.applicationComment.create({
      data: { applicationId: input.applicationId, authorId: viewer.id, body: input.body },
      select: { id: true },
    });

    await record({
      actorId: viewer.id,
      action: AUDIT.COMMENT_ADDED,
      entityType: 'ApplicationComment',
      entityId: comment.id,
      applicationId: input.applicationId,
    });

    revalidateApplication(input.applicationId);
    return ok();
  });
}

// --- templates applied to an application ------------------------------------

/**
 * Turn a template's stage templates into real rounds, in order.
 *
 * Each stage's rubric version is pinned to whatever is published *now*: the
 * template names a rubric, the instance freezes the version, and a rubric
 * republished tomorrow does not retroactively re-interpret a scorecard someone
 * already wrote.
 */
async function materialiseTemplate(
  tx: Tx,
  applicationId: string,
  templateId: string,
  actorId: string,
): Promise<number> {
  const template = await tx.pipelineTemplate.findUnique({
    where: { id: templateId },
    select: {
      id: true,
      name: true,
      stages: {
        orderBy: { position: 'asc' },
        select: { id: true, name: true, type: true, rubricId: true },
      },
    },
  });
  if (!template) throw new AppError('That pipeline template no longer exists.');
  if (template.stages.length === 0) {
    throw new AppError(`The template "${template.name}" has no stages to apply.`);
  }

  // Resolved before the write so a rubric with nothing published fails the
  // whole application rather than leaving half a pipeline behind.
  const pinned = await Promise.all(
    template.stages.map(async (stage) => ({
      stage,
      rubricVersionId: await resolveRubricVersionId(stage.rubricId),
    })),
  );

  // Sequential rather than `$transaction([...])`: the caller already holds the
  // transaction (and the application's row lock), and positions 0..n-1 are only
  // contiguous because nothing else can insert a round underneath us.
  for (const [index, { stage, rubricVersionId }] of pinned.entries()) {
    await tx.stage.create({
      data: {
        applicationId,
        name: stage.name,
        type: stage.type,
        position: index,
        rubricVersionId,
      },
    });
  }

  await record(
    {
      actorId,
      action: AUDIT.STAGE_CREATED,
      entityType: 'Application',
      entityId: applicationId,
      applicationId,
      metadata: {
        via: 'template',
        templateId: template.id,
        templateName: template.name,
        stageCount: pinned.length,
        // Which version each round was pinned to, kept where a later reader can
        // see it even if the rubric has moved on since.
        rubricVersionIds: pinned.map((p) => p.rubricVersionId),
      },
    },
    tx,
  );

  return pinned.length;
}

export async function applyTemplateAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = applyTemplateSchema.parse({
      applicationId: formData.get('applicationId'),
      templateId: formData.get('templateId'),
    });

    const application = await prisma.application.findUnique({
      where: { id: input.applicationId },
      select: { id: true, status: true },
    });
    if (!application) throw new NotFoundError('Application');
    assertOpen(application.status);

    await prisma.$transaction(async (tx) => {
      await lockApplicationForPositions(tx, input.applicationId);

      // Counted under the lock, which is the only place the answer is still
      // true when it is used: a round added a millisecond ago would otherwise
      // be overwritten at position 0 by the template's first stage. Appending
      // instead would silently double a pipeline that was applied twice, and
      // there is no honest way to guess which of the two the candidate is
      // actually on.
      const existing = await tx.stage.count({ where: { applicationId: input.applicationId } });
      if (existing > 0) {
        throw new AppError(
          'This application already has rounds. Remove them before applying a template.',
        );
      }

      await materialiseTemplate(tx, input.applicationId, input.templateId, viewer.id);
      await tx.application.update({
        where: { id: input.applicationId },
        data: { pipelineTemplateId: input.templateId },
      });
    });

    revalidateApplication(input.applicationId);
    return ok();
  });
}

// --- stages -----------------------------------------------------------------

export async function createStageAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = createStageSchema.parse({
      applicationId: formData.get('applicationId'),
      name: formData.get('name'),
      type: formData.get('type'),
      rubricId: formData.get('rubricId'),
      scheduledAt: formData.get('scheduledAt'),
      interviewId: formData.get('interviewId'),
      blindFeedback: formData.get('blindFeedback') !== null,
    });

    const application = await prisma.application.findUnique({
      where: { id: input.applicationId },
      select: { id: true, candidateId: true, status: true },
    });
    if (!application) throw new NotFoundError('Application');
    assertOpen(application.status);

    // An interview id on anything but a coding round is a category error, not
    // a field to ignore: every other stage type is a conversation this
    // platform only holds the scorecard for, and silently dropping the id
    // would leave the author believing an assessment had been sent.
    if (input.interviewId && input.type !== 'CODING_ASSESSMENT') {
      throw new AppError('Only a coding assessment round can be backed by an assessment.', {
        interviewId: ['Not available for this round type.'],
      });
    }

    const rubricVersionId = await resolveRubricVersionId(input.rubricId);
    const assignmentId = input.interviewId
      ? await linkAssignmentToStage(application.candidateId, input.interviewId, null)
      : null;

    await prisma.$transaction(async (tx) => {
      await lockApplicationForPositions(tx, input.applicationId);

      // Counted inside the transaction, after the lock. Read before it — as a
      // `_count` on the application loaded above — two "Add round" clicks a
      // moment apart both see 3 and both write position 3.
      const position = await tx.stage.count({ where: { applicationId: input.applicationId } });

      const stage = await tx.stage.create({
        data: {
          applicationId: input.applicationId,
          name: input.name,
          type: input.type,
          // Append. Positions are contiguous from zero, so the count of
          // existing rounds *is* the next free position.
          position,
          scheduledAt: input.scheduledAt,
          status: input.scheduledAt ? 'SCHEDULED' : 'PENDING',
          blindFeedback: input.blindFeedback,
          rubricVersionId,
          assignmentId,
        },
        select: { id: true },
      });

      await record(
        {
          actorId: viewer.id,
          action: AUDIT.STAGE_CREATED,
          entityType: 'Stage',
          entityId: stage.id,
          applicationId: input.applicationId,
          metadata: { name: input.name, type: input.type, rubricVersionId, assignmentId },
        },
        tx,
      );
    });

    revalidateApplication(input.applicationId);
    return ok();
  });
}

export async function updateStageAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = updateStageSchema.parse({
      id: formData.get('id'),
      name: formData.get('name'),
      scheduledAt: formData.get('scheduledAt'),
      blindFeedback: formData.get('blindFeedback') !== null,
    });

    const stage = await loadStage(input.id);

    // `blindFeedback` is the switch that makes the blind rule mean anything, so
    // it is the one field on this form that the people it constrains must not
    // be able to move. Two guards, both about the *unblinding* direction only —
    // turning blind on is always safe and never restricted.
    if (stage.blindFeedback && !input.blindFeedback) {
      // Someone who owes a scorecard here would be unblinding themselves. Rank
      // is no defence: an admin on the panel anchors exactly like anyone else,
      // which is the whole premise of the rule.
      const seat = await prisma.stageInterviewer.findUnique({
        where: { stageId_userId: { stageId: stage.id, userId: viewer.id } },
        select: { id: true },
      });
      if (seat) {
        throw new AppError(
          'You are on this panel, so you cannot turn blind feedback off for this round. Ask someone who is not on it.',
        );
      }

      // And once anyone has written anything, unblinding retroactively exposes
      // scorecards that were given under a promise of independence. The round
      // has to be set up blind or not; it cannot be changed underneath people.
      const written = await prisma.feedback.count({ where: { stageId: stage.id } });
      if (written > 0) {
        throw new AppError(
          'Scorecards have already been started for this round, so blind feedback can no longer be switched off.',
        );
      }
    }

    await prisma.stage.update({
      where: { id: input.id },
      data: {
        name: input.name,
        scheduledAt: input.scheduledAt,
        blindFeedback: input.blindFeedback,
      },
    });

    await record({
      actorId: viewer.id,
      action: AUDIT.STAGE_UPDATED,
      entityType: 'Stage',
      entityId: stage.id,
      applicationId: stage.applicationId,
      metadata: {
        name: input.name,
        scheduledAt: input.scheduledAt?.toISOString() ?? null,
        // Recorded unconditionally: a reader reconstructing why one panellist
        // saw another's scorecard needs the flag's history, not just its
        // current value.
        blindFeedback: input.blindFeedback,
        blindFeedbackChanged: stage.blindFeedback !== input.blindFeedback,
      },
    });

    revalidateApplication(stage.applicationId);
    return ok();
  });
}

/**
 * Attach an assessment to a coding round that has not got one.
 *
 * A template carries a stage *type*, never a particular interview — which
 * assessment a candidate sits is a per-application choice — so a coding round
 * materialised from a template arrives empty and is wired up here.
 */
export async function linkStageAssignmentAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = linkStageAssignmentSchema.parse({
      stageId: formData.get('stageId'),
      interviewId: formData.get('interviewId'),
    });

    const stage = await loadStage(input.stageId);
    if (stage.type !== 'CODING_ASSESSMENT') {
      throw new AppError('Only a coding assessment round can be backed by an assessment.');
    }

    const assignmentId = await linkAssignmentToStage(
      stage.candidateId,
      input.interviewId,
      stage.id,
    );
    await prisma.stage.update({ where: { id: stage.id }, data: { assignmentId } });

    await record({
      actorId: viewer.id,
      action: AUDIT.STAGE_UPDATED,
      entityType: 'Stage',
      entityId: stage.id,
      applicationId: stage.applicationId,
      metadata: { assignmentId, interviewId: input.interviewId },
    });

    revalidateApplication(stage.applicationId);
    revalidatePath(`/admin/candidates/${stage.candidateId}`);
    return ok();
  });
}

/**
 * Takes the whole ordered list rather than a "move up" delta: the client
 * already knows the order it wants, and writing it wholesale means a stale tab
 * cannot interleave two half-applied swaps. The duplicate-id refinement on the
 * schema is what stops `[a, a]` passing the length check and writing `a` at
 * two positions — see the note there.
 */
export async function reorderStagesAction(payload: unknown): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = reorderStagesSchema.parse(payload);

    const existing = await prisma.stage.findMany({
      where: { applicationId: input.applicationId },
      select: { id: true },
    });

    const known = new Set(existing.map((row) => row.id));
    const stale = 'The rounds changed while you were editing. Reload and retry.';
    if (input.stageIds.length !== existing.length) throw new AppError(stale);

    const updates = input.stageIds.map((stageId, index) => {
      if (!known.has(stageId)) throw new AppError(stale);
      return prisma.stage.update({ where: { id: stageId }, data: { position: index } });
    });

    await prisma.$transaction(updates);

    await record({
      actorId: viewer.id,
      action: AUDIT.STAGE_UPDATED,
      entityType: 'Application',
      entityId: input.applicationId,
      applicationId: input.applicationId,
      metadata: { reordered: input.stageIds },
    });

    revalidateApplication(input.applicationId);
    return ok();
  });
}

export async function setStageStatusAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = setStageStatusSchema.parse({
      id: formData.get('id'),
      status: formData.get('status'),
    });

    const stage = await loadStage(input.id);
    const from = currentStageStatus(stage);

    if (from === input.status) return ok();
    // The lifecycle first, then the coding-round restriction — and the two
    // composed rather than applied one after the other. Asking the coding guard
    // about the *target* alone refused `AWAITING_FEEDBACK` and `PENDING`, which
    // are the only exits the transition table gives `COMPLETE` and `SKIPPED`:
    // between them the two tables made a completed coding round permanent. See
    // `canSetCodingStageStatusByHand`.
    if (!canTransitionStageStatus(from, input.status)) {
      throw new AppError(stageTransitionError(from, input.status));
    }
    if (stage.type === 'CODING_ASSESSMENT' && !canSetCodingStageStatusByHand(from, input.status)) {
      // A coding round's progress belongs to the assignment. Letting someone
      // hand-set "in progress" on an assessment the candidate has not opened
      // produces a board that lies, and the lie outlives the correction.
      throw new AppError(
        'A coding assessment round follows the assessment itself. Only "complete" and "skipped" can be set by hand here, and only reopening or un-skipping takes it back.',
      );
    }

    await prisma.stage.update({
      where: { id: input.id },
      data: {
        status: input.status,
        // Reopening a completed round clears the completion date rather than
        // leaving it pointing at a moment that has been undone.
        completedAt:
          input.status === 'COMPLETE' ? new Date() : from === 'COMPLETE' ? null : undefined,
      },
    });

    await record({
      actorId: viewer.id,
      action: AUDIT.STAGE_STATUS_CHANGED,
      entityType: 'Stage',
      entityId: stage.id,
      applicationId: stage.applicationId,
      metadata: { from, to: input.status },
    });

    revalidateApplication(stage.applicationId);
    return ok();
  });
}

export async function recordStageOutcomeAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = recordStageOutcomeSchema.parse({
      id: formData.get('id'),
      outcome: formData.get('outcome'),
    });

    const stage = await loadStage(input.id);

    await prisma.stage.update({ where: { id: input.id }, data: { outcome: input.outcome } });

    // Deliberately the whole of it. A `REJECT` here does **not** set
    // `Application.status = REJECTED`, and an `ADVANCE` does not open the next
    // round. That convenience is one line long and it is how a hiring system
    // starts making hiring decisions: a panel's view of one round becomes a
    // rejection nobody typed, with no rationale, recorded against a candidate
    // who was never discussed. A person closes an application, through
    // `setApplicationStatusAction`, and a `Decision` needs a written reason
    // before it exists at all.
    await record({
      actorId: viewer.id,
      action: AUDIT.STAGE_OUTCOME_RECORDED,
      entityType: 'Stage',
      entityId: stage.id,
      applicationId: stage.applicationId,
      metadata: { outcome: input.outcome, stageName: stage.name },
    });

    revalidateApplication(stage.applicationId);
    return ok();
  });
}

export async function deleteStageAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = stageIdSchema.parse({ id: formData.get('id') });

    const stage = await prisma.stage.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        name: true,
        applicationId: true,
        // Every row, drafts included — see below.
        feedback: { select: { id: true, status: true } },
      },
    });
    if (!stage) throw new NotFoundError('Stage');

    // Feedback is evidence, and `Feedback` cascades from `Stage`: deleting the
    // round destroys it. Submitted scorecards are somebody's account of a real
    // conversation — but a *draft* is worse to lose, not better. It is the one
    // thing this product promises belongs to its author alone, nobody else can
    // even read it, and its author finds out it is gone by opening the round
    // and finding no round. A recruiter tidying up must not be able to do that
    // to a colleague who is half way through writing.
    if (stage.feedback.length > 0) {
      const submitted = stage.feedback.filter((row) => row.status === 'SUBMITTED').length;
      const drafts = stage.feedback.length - submitted;
      const detail = [
        submitted > 0 ? `${submitted} submitted` : null,
        drafts > 0 ? `${drafts} still in draft` : null,
      ]
        .filter((part) => part !== null)
        .join(', ');
      throw new AppError(
        `"${stage.name}" has ${stage.feedback.length} ${
          stage.feedback.length === 1 ? 'scorecard' : 'scorecards'
        } against it (${detail}) and cannot be removed. Skip it instead, so the scorecards keep the round they were written about.`,
      );
    }

    const remaining = await prisma.stage.findMany({
      where: { applicationId: stage.applicationId, NOT: { id: stage.id } },
      orderBy: { position: 'asc' },
      select: { id: true },
    });

    // Delete, renumber and record in one transaction. A gap in `position` is
    // harmless until something counts, and "round 3 of 5" counts; an audit line
    // written afterwards on the best-effort path is the only evidence a round
    // was removed, and a transient failure there loses it silently.
    await prisma.$transaction(async (tx) => {
      await lockApplicationForPositions(tx, stage.applicationId);
      await tx.stage.delete({ where: { id: stage.id } });
      for (const [index, row] of remaining.entries()) {
        await tx.stage.update({ where: { id: row.id }, data: { position: index } });
      }

      await record(
        {
          actorId: viewer.id,
          action: AUDIT.STAGE_DELETED,
          entityType: 'Stage',
          entityId: stage.id,
          applicationId: stage.applicationId,
          metadata: { name: stage.name },
        },
        tx,
      );
    });

    revalidateApplication(stage.applicationId);
    return ok();
  });
}

// --- the panel --------------------------------------------------------------

export async function addPanelistAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = addPanelistSchema.parse({
      stageId: formData.get('stageId'),
      userId: formData.get('userId'),
      role: formData.get('role') ?? 'PANELIST',
    });

    const stage = await loadStage(input.stageId);

    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, name: true, role: true, isActive: true },
    });
    if (!user) throw new NotFoundError('User');
    // A seat is what authorises writing a scorecard, so a seat for someone who
    // could never write one is a promise the system cannot keep.
    if (!isStaff(user.role) || !can(user.role, 'GIVE_FEEDBACK')) {
      throw new AppError('Only staff who may write feedback can sit on a panel.');
    }
    if (!user.isActive) throw new AppError('That account is deactivated.');

    const already = await prisma.stageInterviewer.findUnique({
      where: { stageId_userId: { stageId: input.stageId, userId: input.userId } },
      select: { id: true },
    });
    if (already) throw new AppError(`${user.name} is already on this panel.`);

    // Seat and audit line together. A seat is the grant of authority to write a
    // scorecard about a person's career; "who was put on this panel, by whom,
    // and when" is the record that has to survive a transient database error,
    // not a best-effort line that can go missing while the grant stands.
    await prisma.$transaction(async (tx) => {
      await tx.stageInterviewer.create({
        data: { stageId: input.stageId, userId: input.userId, role: input.role },
      });

      await record(
        {
          actorId: viewer.id,
          action: AUDIT.PANEL_ADDED,
          entityType: 'Stage',
          entityId: stage.id,
          applicationId: stage.applicationId,
          metadata: { userId: input.userId, role: input.role, stageName: stage.name },
        },
        tx,
      );
    });

    revalidateApplication(stage.applicationId);
    revalidatePath(`/admin/stages/${stage.id}`);
    return ok();
  });
}

export async function removePanelistAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_PIPELINE');
    const input = removePanelistSchema.parse({
      stageId: formData.get('stageId'),
      userId: formData.get('userId'),
    });

    // Nobody vacates their own seat.
    //
    // The guard below only refuses to remove someone who has already
    // *submitted* — and a blinded panellist by definition has not, so it never
    // fires against the person with a reason to abuse this. A hiring manager
    // seated on a blind round removes themselves, is no longer a panellist,
    // reads every scorecard already submitted (they hold
    // `VIEW_ALL_APPLICATIONS`), re-seats themselves and writes an anchored
    // scorecard. Blind feedback is worth exactly as much as the difficulty of
    // getting out from under it, so getting out takes another person.
    if (input.userId === viewer.id) {
      throw new AppError(
        'You cannot take yourself off a panel. Ask someone else to remove you — leaving and rejoining a blind round is how a scorecard stops being independent.',
      );
    }

    const stage = await loadStage(input.stageId);

    const seat = await prisma.stageInterviewer.findUnique({
      where: { stageId_userId: { stageId: input.stageId, userId: input.userId } },
      select: { id: true, user: { select: { name: true } } },
    });
    if (!seat) throw new NotFoundError('Panel member');

    const submitted = await prisma.feedback.findFirst({
      where: { stageId: input.stageId, authorId: input.userId, status: 'SUBMITTED' },
      select: { id: true },
    });
    // Their scorecard is evidence about a conversation that happened. Removing
    // the seat leaves it authored by someone the round says was never there,
    // which reads worse in a debrief than an extra name on the panel.
    if (submitted) {
      throw new AppError(
        `${seat.user.name} has already submitted feedback for this round. Their scorecard is part of the record, so they stay on the panel.`,
      );
    }

    // Atomic with the audit line, for the reason given in `addPanelistAction`:
    // revoking the authority to write a scorecard is exactly as much a matter
    // of record as granting it.
    await prisma.$transaction(async (tx) => {
      await tx.stageInterviewer.delete({ where: { id: seat.id } });

      await record(
        {
          actorId: viewer.id,
          action: AUDIT.PANEL_REMOVED,
          entityType: 'Stage',
          entityId: stage.id,
          applicationId: stage.applicationId,
          metadata: { userId: input.userId, stageName: stage.name },
        },
        tx,
      );
    });

    revalidateApplication(stage.applicationId);
    revalidatePath(`/admin/stages/${stage.id}`);
    return ok();
  });
}
