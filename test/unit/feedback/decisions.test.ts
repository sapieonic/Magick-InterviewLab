import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/lib/action-result';
import type { SessionUser } from '@/features/auth/session';
import type { Role } from '@/generated/prisma/enums';

type ActionFailure = Extract<ActionResult<never>, { ok: false }>;

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  const { vi: vitest } = await import('vitest');
  return {
    db: createPrismaMock(),
    revalidatePath: vitest.fn(),
    getCurrentUser: vitest.fn(),
  };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/features/auth/session', () => ({ getCurrentUser: h.getCurrentUser }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import { recordDecisionAction } from '@/features/decisions/actions';

const RATIONALE =
  'Strong on system design across two rounds; the one reservation was scope, which the panel discussed and settled.';

function user(role: Role, id = 'hm'): SessionUser {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    role,
    isActive: true,
    mustChangePassword: false,
  };
}

function failed(result: ActionResult<unknown>): ActionFailure {
  if (result.ok) throw new Error('expected the action to fail');
  return result;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

/**
 * Two different `application.findUnique` calls run here: the access checks,
 * which select only the id, and the debrief read that builds the snapshot.
 */
function mockApplication() {
  h.db.application.findUnique.mockImplementation((args: { select: Record<string, unknown> }) => {
    if (args.select['stages'] === undefined) return Promise.resolve({ id: 'app1' });
    return Promise.resolve({
      id: 'app1',
      status: 'ACTIVE',
      candidate: { id: 'cand1', name: 'Ada', email: 'ada@example.com' },
      jobRole: { title: 'Backend L4' },
      owner: { name: 'Rita' },
      stages: [
        {
          id: 'stage1',
          name: 'System design',
          type: 'SYSTEM_DESIGN',
          status: 'COMPLETE',
          outcome: null,
          position: 0,
          blindFeedback: true,
          scheduledAt: null,
          completedAt: new Date('2026-01-01T00:00:00Z'),
          rubricVersion: {
            id: 'rv1',
            version: 1,
            rubric: { name: 'Engineering' },
            criteria: [
              { id: 'c1', name: 'Design', description: '', weight: 2, maxScore: 4, position: 0 },
            ],
          },
          interviewers: [
            { userId: 'other', role: 'PANELIST', user: { name: 'Other', email: 'o@x.com' } },
          ],
          feedback: [
            {
              id: 'fb1',
              authorId: 'other',
              status: 'SUBMITTED',
              recommendation: 'HIRE',
              confidence: 'HIGH',
              summary: 'Good.',
              strengths: '',
              concerns: '',
              rubricVersionId: 'rv1',
              submittedAt: new Date('2026-01-02T00:00:00Z'),
              updatedAt: new Date('2026-01-02T00:00:00Z'),
              author: { name: 'Other' },
              scores: [{ criterionId: 'c1', score: 4, note: '' }],
              _count: { revisions: 0 },
              revisions: [],
            },
          ],
          assignment: null,
        },
      ],
      decision: null,
    });
  });
}

function auditCall(): { action: string; metadata: Record<string, unknown> } {
  const call = h.db.auditEvent.create.mock.calls[0]?.[0] as
    { data: { action: string; metadata: Record<string, unknown> } } | undefined;
  if (!call) throw new Error('expected an audit event to have been recorded');
  return call.data;
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.revalidatePath.mockReset();
  h.getCurrentUser.mockReset();
  h.getCurrentUser.mockResolvedValue(user('HIRING_MANAGER'));
  mockApplication();
  h.db.decision.findUnique.mockResolvedValue(null);
  h.db.decision.upsert.mockResolvedValue({ id: 'dec1' });
  h.db.auditEvent.create.mockResolvedValue({ id: 'audit1' });
  h.db.auditEvent.findMany.mockResolvedValue([]);
});

describe('recording a decision', () => {
  it('refuses a recruiter, who moves candidates along but does not decide', async () => {
    h.getCurrentUser.mockResolvedValue(user('RECRUITER'));

    const result = failed(
      await recordDecisionAction(
        null,
        form({ applicationId: 'app1', outcome: 'HIRE', rationale: RATIONALE }),
      ),
    );

    expect(result.error).toMatch(/permission/i);
    expect(h.db.decision.upsert).not.toHaveBeenCalled();
  });

  it('refuses a candidate', async () => {
    h.getCurrentUser.mockResolvedValue(user('CANDIDATE', 'cand1'));

    failed(
      await recordDecisionAction(
        null,
        form({ applicationId: 'app1', outcome: 'HIRE', rationale: RATIONALE }),
      ),
    );

    expect(h.db.decision.upsert).not.toHaveBeenCalled();
  });

  it('refuses a decider who may not see this application', async () => {
    h.getCurrentUser.mockResolvedValue(user('ADMIN'));
    h.db.application.findUnique.mockResolvedValue(null);

    failed(
      await recordDecisionAction(
        null,
        form({ applicationId: 'app1', outcome: 'HIRE', rationale: RATIONALE }),
      ),
    );

    expect(h.db.decision.upsert).not.toHaveBeenCalled();
  });

  /** A decision nobody wrote a reason for is not reviewable. */
  it('refuses a decision without a written rationale', async () => {
    const result = failed(
      await recordDecisionAction(
        null,
        form({ applicationId: 'app1', outcome: 'NO_HIRE', rationale: 'no' }),
      ),
    );

    expect(result.fieldErrors?.['rationale']?.[0]).toMatch(/at least a sentence/i);
    expect(h.db.decision.upsert).not.toHaveBeenCalled();
  });

  it('refuses an outcome that is not one of the three', async () => {
    failed(
      await recordDecisionAction(
        null,
        form({ applicationId: 'app1', outcome: 'MAYBE', rationale: RATIONALE }),
      ),
    );

    expect(h.db.decision.upsert).not.toHaveBeenCalled();
  });

  it('records a first decision and freezes the signal the decider saw', async () => {
    const result = await recordDecisionAction(
      null,
      form({ applicationId: 'app1', outcome: 'HIRE', rationale: RATIONALE }),
    );

    expect(result.ok).toBe(true);
    const upsert = h.db.decision.upsert.mock.calls[0]?.[0] as {
      create: { snapshot: { signal: { distribution: { total: number } } } };
    };
    expect(upsert.create.snapshot.signal.distribution.total).toBe(1);
    expect(auditCall().action).toBe('decision.recorded');
  });

  it('never emits a verdict into the snapshot, only counts', async () => {
    await recordDecisionAction(
      null,
      form({ applicationId: 'app1', outcome: 'HIRE', rationale: RATIONALE }),
    );

    const upsert = h.db.decision.upsert.mock.calls[0]?.[0] as { create: { snapshot: unknown } };
    const serialised = JSON.stringify(upsert.create.snapshot);
    expect(serialised).not.toMatch(/verdict|hireProbability|recommendedOutcome/);
  });

  /** A reversal must never be invisible. */
  it('audits a change with the outcome it replaced', async () => {
    h.db.decision.findUnique.mockResolvedValue({
      id: 'dec1',
      outcome: 'HIRE',
      rationale: 'The earlier reasoning, at length, as originally recorded.',
      decidedById: 'someone',
      decidedAt: new Date('2026-01-05T00:00:00Z'),
    });

    const result = await recordDecisionAction(
      null,
      form({ applicationId: 'app1', outcome: 'NO_HIRE', rationale: RATIONALE }),
    );

    expect(result.ok).toBe(true);
    const audit = auditCall();
    expect(audit.action).toBe('decision.changed');
    expect(audit.metadata['previousOutcome']).toBe('HIRE');
    expect(audit.metadata['outcome']).toBe('NO_HIRE');
    expect(audit.metadata['previousDecidedAt']).toBe('2026-01-05T00:00:00.000Z');
  });

  /**
   * Deciding and processing are separate accountabilities — see the comment on
   * the action. The recruiter closes the application, not the decider.
   */
  it('does not touch the application status', async () => {
    await recordDecisionAction(
      null,
      form({ applicationId: 'app1', outcome: 'NO_HIRE', rationale: RATIONALE }),
    );

    expect(h.db.application.update).not.toHaveBeenCalled();
    expect(h.db.application.updateMany).not.toHaveBeenCalled();
  });
});
