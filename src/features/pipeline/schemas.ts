import { z } from 'zod';
import { cuidSchema } from '@/lib/validation/schemas';

/**
 * Pipeline input shapes that `src/lib/validation/schemas.ts` does not already
 * carry. Everything the shared file defines is imported from there — this
 * exists only for the two payloads that arrive as JSON rather than as a form
 * POST, and so had no home in a file organised around forms.
 */

/**
 * Whole-list reorder, exactly like `reorderQuestionsSchema`.
 *
 * The uniqueness refinement is load-bearing and copied deliberately: the
 * action checks the payload length against the number of existing stages and
 * then resolves each id through a Map, so `[a, a]` against stages `[a, b]`
 * passes the length check, writes `a` at both positions and never touches
 * `b` — reintroducing exactly the duplicated `position` that the contiguous
 * renumber exists to prevent. That bug is documented on the interview version;
 * it is the same bug here.
 */
export const reorderStagesSchema = z.object({
  applicationId: cuidSchema,
  stageIds: z
    .array(cuidSchema)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Stage order contains duplicates.'),
});

/** Applying a template materialises its stage templates onto an application. */
export const applyTemplateSchema = z.object({
  applicationId: cuidSchema,
  templateId: cuidSchema,
});

/**
 * Wiring an existing coding round up to an assessment.
 *
 * `createStageSchema` carries an `interviewId` for the create-it-all-at-once
 * path; this is the other one, because a stage materialised from a template
 * knows it is a coding round but not *which* assessment — that is a decision
 * per candidate, not per template.
 */
export const linkStageAssignmentSchema = z.object({
  stageId: cuidSchema,
  interviewId: cuidSchema,
});

export type ReorderStagesInput = z.infer<typeof reorderStagesSchema>;
