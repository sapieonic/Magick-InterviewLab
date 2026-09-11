'use server';

import 'server-only';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db/prisma';
import { actionGuard, AppError, NotFoundError } from '@/lib/errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { requireCapability } from '@/features/auth/guards';
import {
  cuidSchema,
  jobRoleInputSchema,
  pipelineStageTemplateInputSchema,
  pipelineTemplateInputSchema,
} from '@/lib/validation/schemas';
import type { StageType } from '@/generated/prisma/enums';

/**
 * Job roles and pipeline templates: the *shapes* a hiring process comes in,
 * kept away from `actions.ts`, which is about one candidate's run through one.
 * Editing a template must never look like it could move a live application,
 * and the clearest way to say so is that the two never share a file.
 *
 * Nothing here writes an audit event, and that is deliberate rather than an
 * omission: `AuditEvent` is scoped to an application (`applicationId` is what
 * makes the timeline one indexed read), and a template is authored long before
 * any candidate exists. The events that matter — which template was applied to
 * whom, and which rubric version each stage was pinned to — are recorded at
 * the moment of application, in `applyTemplateAction`.
 *
 * The reads live in this file rather than in `queries.ts` for the reason given
 * above, which means they sit under a `'use server'` directive and are
 * therefore reachable as endpoints. Each one guards for itself accordingly;
 * none of them is a bare `findMany` behind a capability the caller was trusted
 * to have checked.
 *
 * And each guards on the capability its *caller* gates on, not merely on being
 * staff. `requireStaff` is `ACCESS_CONSOLE`, which every interviewer holds, so
 * a bare `requireStaff` on these left the whole requisition list — every open
 * role, its application count, every pipeline and its rounds — one fetch away
 * for anyone with a console account, while the only UI that renders it is
 * admin-only. An endpoint is as public as its weakest guard.
 */

function revalidateTemplates(): void {
  revalidatePath('/admin/settings');
  revalidatePath('/admin/pipeline');
}

// --- reads ------------------------------------------------------------------

export interface JobRoleRow {
  id: string;
  title: string;
  level: string;
  description: string;
  isActive: boolean;
  pipelineTemplate: { id: string; name: string } | null;
  applicationCount: number;
}

export async function listJobRoles(): Promise<JobRoleRow[]> {
  await requireCapability('MANAGE_CONTENT');
  const rows = await prisma.jobRole.findMany({
    orderBy: [{ isActive: 'desc' }, { title: 'asc' }, { level: 'asc' }],
    select: {
      id: true,
      title: true,
      level: true,
      description: true,
      isActive: true,
      pipelineTemplate: { select: { id: true, name: true } },
      _count: { select: { applications: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    level: row.level,
    description: row.description,
    isActive: row.isActive,
    pipelineTemplate: row.pipelineTemplate,
    applicationCount: row._count.applications,
  }));
}

export interface StageTemplateRow {
  id: string;
  name: string;
  type: StageType;
  position: number;
  isRequired: boolean;
  rubric: { id: string; name: string } | null;
}

export interface PipelineTemplateRow {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  stages: StageTemplateRow[];
}

export async function listPipelineTemplates(): Promise<PipelineTemplateRow[]> {
  await requireCapability('MANAGE_CONTENT');
  return prisma.pipelineTemplate.findMany({
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      description: true,
      isActive: true,
      stages: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          name: true,
          type: true,
          position: true,
          isRequired: true,
          rubric: { select: { id: true, name: true } },
        },
      },
    },
  });
}

/** Just enough to fill a picker on the "start an application" form — so it
 *  guards on what starting one takes, which is what every caller gates on. */
export async function listActiveTemplateOptions(): Promise<
  Array<{ id: string; name: string; stageCount: number }>
> {
  await requireCapability('MANAGE_PIPELINE');
  const rows = await prisma.pipelineTemplate.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, _count: { select: { stages: true } } },
  });
  return rows.map((row) => ({ id: row.id, name: row.name, stageCount: row._count.stages }));
}

export async function listActiveJobRoleOptions(): Promise<
  Array<{ id: string; title: string; level: string; pipelineTemplateId: string | null }>
> {
  await requireCapability('MANAGE_PIPELINE');
  return prisma.jobRole.findMany({
    where: { isActive: true },
    orderBy: [{ title: 'asc' }, { level: 'asc' }],
    select: { id: true, title: true, level: true, pipelineTemplateId: true },
  });
}

// --- job roles --------------------------------------------------------------

function readJobRoleForm(formData: FormData) {
  return jobRoleInputSchema.parse({
    title: formData.get('title'),
    level: formData.get('level') ?? '',
    description: formData.get('description') ?? '',
    pipelineTemplateId: formData.get('pipelineTemplateId'),
    // An unchecked box submits nothing at all, which is the only way to tell
    // "off" from "untouched" in a plain form POST.
    isActive: formData.get('isActive') !== null,
  });
}

export async function createJobRoleAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const input = readJobRoleForm(formData);
    await prisma.jobRole.create({ data: input });
    revalidateTemplates();
    return ok();
  });
}

export async function updateJobRoleAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const id = cuidSchema.parse(formData.get('id'));
    const input = readJobRoleForm(formData);

    const existing = await prisma.jobRole.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundError('Job role');

    await prisma.jobRole.update({ where: { id }, data: input });
    revalidateTemplates();
    return ok();
  });
}

// --- pipeline templates -----------------------------------------------------

export async function createPipelineTemplateAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const input = pipelineTemplateInputSchema.parse({
      name: formData.get('name'),
      description: formData.get('description') ?? '',
      isActive: formData.get('isActive') !== null,
    });
    await prisma.pipelineTemplate.create({ data: input });
    revalidateTemplates();
    return ok();
  });
}

export async function updatePipelineTemplateAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const id = cuidSchema.parse(formData.get('id'));
    const input = pipelineTemplateInputSchema.parse({
      name: formData.get('name'),
      description: formData.get('description') ?? '',
      isActive: formData.get('isActive') !== null,
    });

    const existing = await prisma.pipelineTemplate.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundError('Pipeline template');

    await prisma.pipelineTemplate.update({ where: { id }, data: input });
    revalidateTemplates();
    return ok();
  });
}

// --- stage templates --------------------------------------------------------

export async function addStageTemplateAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const input = pipelineStageTemplateInputSchema.parse({
      templateId: formData.get('templateId'),
      name: formData.get('name'),
      type: formData.get('type'),
      rubricId: formData.get('rubricId'),
      isRequired: formData.get('isRequired') !== null,
    });

    const template = await prisma.pipelineTemplate.findUnique({
      where: { id: input.templateId },
      select: { id: true },
    });
    if (!template) throw new NotFoundError('Pipeline template');

    if (input.rubricId) {
      const rubric = await prisma.rubric.findUnique({
        where: { id: input.rubricId },
        select: { id: true },
      });
      if (!rubric) throw new AppError('That rubric no longer exists.');
    }

    const last = await prisma.pipelineStageTemplate.findFirst({
      where: { templateId: input.templateId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    await prisma.pipelineStageTemplate.create({
      data: { ...input, position: (last?.position ?? -1) + 1 },
    });

    revalidateTemplates();
    return ok();
  });
}

export async function removeStageTemplateAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const id = cuidSchema.parse(formData.get('id'));

    const row = await prisma.pipelineStageTemplate.findUnique({
      where: { id },
      select: { id: true, templateId: true },
    });
    if (!row) throw new NotFoundError('Stage');

    const remaining = await prisma.pipelineStageTemplate.findMany({
      where: { templateId: row.templateId, NOT: { id: row.id } },
      orderBy: { position: 'asc' },
      select: { id: true },
    });

    // Delete and renumber together, exactly as `removeInterviewQuestionAction`
    // does: a template with a gap in `position` materialises stages with the
    // gap baked in, and the stage list then counts "3 of 5" wrong forever.
    await prisma.$transaction([
      prisma.pipelineStageTemplate.delete({ where: { id: row.id } }),
      ...remaining.map((stage, index) =>
        prisma.pipelineStageTemplate.update({ where: { id: stage.id }, data: { position: index } }),
      ),
    ]);

    revalidateTemplates();
    return ok();
  });
}

/**
 * Move one stage template one place up or down.
 *
 * A single swap rather than a whole-list payload, because this is a plain form
 * POST from a server-rendered settings page with no client state to send. The
 * two rows are swapped inside one transaction, and both ends are re-read here
 * rather than trusted from the form, so a stale page can move a row that no
 * longer exists but can never write a position it invented.
 */
export async function moveStageTemplateAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const id = cuidSchema.parse(formData.get('id'));
    const direction = formData.get('direction') === 'up' ? 'up' : 'down';

    const row = await prisma.pipelineStageTemplate.findUnique({
      where: { id },
      select: { id: true, templateId: true, position: true },
    });
    if (!row) throw new NotFoundError('Stage');

    const neighbour = await prisma.pipelineStageTemplate.findFirst({
      where: {
        templateId: row.templateId,
        position: direction === 'up' ? { lt: row.position } : { gt: row.position },
      },
      orderBy: { position: direction === 'up' ? 'desc' : 'asc' },
      select: { id: true, position: true },
    });
    // Already at the end. Not an error: the button is disabled there anyway,
    // and a double-click racing itself should be a no-op.
    if (!neighbour) return ok();

    await prisma.$transaction([
      prisma.pipelineStageTemplate.update({
        where: { id: row.id },
        data: { position: neighbour.position },
      }),
      prisma.pipelineStageTemplate.update({
        where: { id: neighbour.id },
        data: { position: row.position },
      }),
    ]);

    revalidateTemplates();
    return ok();
  });
}
