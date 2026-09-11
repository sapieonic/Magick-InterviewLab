import 'server-only';
import { prisma } from '@/lib/db/prisma';
import type { Prisma } from '@/generated/prisma/client';

/**
 * The append-only history of everything that moves a candidate or records an
 * opinion about one.
 *
 * Two reasons this exists rather than being inferred from the rows themselves:
 * a `Decision` row holds only the *current* outcome, so a reversal would
 * otherwise vanish; and "who looked at what, when" is the first question asked
 * when a hiring decision is challenged.
 *
 * Writing an event must never be able to fail the thing it is recording — a
 * dropped audit line is bad, a rolled-back stage transition because the audit
 * line failed is worse. So `record` swallows and logs. Pass a transaction
 * client when the event genuinely must live or die with the write.
 */

/** Every action string in one place; a typo is then a type error. */
export const AUDIT = {
  APPLICATION_CREATED: 'application.created',
  APPLICATION_STATUS_CHANGED: 'application.status_changed',
  APPLICATION_OWNER_CHANGED: 'application.owner_changed',
  STAGE_CREATED: 'stage.created',
  STAGE_UPDATED: 'stage.updated',
  STAGE_STATUS_CHANGED: 'stage.status_changed',
  STAGE_OUTCOME_RECORDED: 'stage.outcome_recorded',
  STAGE_DELETED: 'stage.deleted',
  PANEL_ADDED: 'panel.added',
  PANEL_REMOVED: 'panel.removed',
  FEEDBACK_SAVED: 'feedback.saved',
  FEEDBACK_SUBMITTED: 'feedback.submitted',
  FEEDBACK_REVISED: 'feedback.revised',
  DECISION_RECORDED: 'decision.recorded',
  DECISION_CHANGED: 'decision.changed',
  NOTE_ADDED: 'note.added',
  NOTE_DELETED: 'note.deleted',
  COMMENT_ADDED: 'comment.added',
  RUBRIC_PUBLISHED: 'rubric.published',
} as const;

export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

export interface AuditInput {
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  /** Set whenever the event belongs to a candidate's pipeline, so the
   *  application timeline can be read with one indexed query. */
  applicationId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

type Client = Pick<typeof prisma, 'auditEvent'>;

/**
 * Record an event. Never throws.
 *
 * @param client pass a transaction client to make the event atomic with the
 *   change it describes; omit it for the common best-effort case.
 */
export async function record(input: AuditInput, client: Client = prisma): Promise<void> {
  try {
    await client.auditEvent.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        applicationId: input.applicationId ?? null,
        metadata: input.metadata ?? {},
      },
    });
  } catch (error) {
    // Deliberately not rethrown — see the module comment.
    console.error('[audit] failed to record', input.action, error);
  }
}
