import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MockRedirectError } from '../../helpers/next-mocks';
import type { ActionResult } from '@/lib/action-result';
import type { SessionUser } from '@/features/auth/session';

type ActionFailure = Extract<ActionResult<never>, { ok: false }>;

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  const { mockRedirect } = await import('../../helpers/next-mocks');
  const { vi: vitest } = await import('vitest');
  return {
    db: createPrismaMock(),
    redirect: vitest.fn(mockRedirect),
    revalidatePath: vitest.fn(),
    getCurrentUser: vitest.fn(),
  };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
// Only the session lookup is faked. `requireCapability` is part of what these
// tests assert, so the real guard — and the real error `actionGuard` matches on
// by identity — stays in the path.
vi.mock('@/features/auth/session', () => ({ getCurrentUser: h.getCurrentUser }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import {
  archiveRubricAction,
  createRubricAction,
  createRubricVersionAction,
  publishRubricVersionAction,
  saveRubricVersionAction,
  unarchiveRubricAction,
  updateRubricAction,
} from '@/features/rubrics/actions';

function actor(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'admin-1',
    name: 'Root',
    email: 'root@example.com',
    role: 'ADMIN',
    isActive: true,
    mustChangePassword: false,
    ...overrides,
  };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

function failed(result: ActionResult<unknown>): ActionFailure {
  if (result.ok) throw new Error('expected the action to fail');
  return result;
}

/** `createRubricAction` finishes by redirecting, which surfaces as a throw. */
async function createExpectingRedirect(fields: Record<string, string>): Promise<string> {
  try {
    await createRubricAction(null, form(fields));
  } catch (error) {
    if (error instanceof MockRedirectError) return error.url;
    throw error;
  }
  throw new Error('expected createRubricAction to redirect');
}

/** A criterion as the editor posts one. */
function criterion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'Communicates trade-offs', description: '', weight: 1, maxScore: 4, ...overrides };
}

/** `{ id, position }` for every criterion update, in call order. */
function criterionUpdates(): Array<{ id: string; position: number; name: string }> {
  return h.db.rubricCriterion.update.mock.calls.map((call) => {
    const arg = call[0] as { where: { id: string }; data: { position: number; name: string } };
    return { id: arg.where.id, position: arg.data.position, name: arg.data.name };
  });
}

/** The `data` of every criterion create, in call order. */
function criterionCreates(): Array<Record<string, unknown>> {
  return h.db.rubricCriterion.create.mock.calls.map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  );
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.revalidatePath.mockReset();
  h.redirect.mockClear();
  h.getCurrentUser.mockReset();
  h.getCurrentUser.mockResolvedValue(actor());
});

describe('rubric actions — authorization', () => {
  beforeEach(() => {
    h.getCurrentUser.mockResolvedValue(actor({ id: 'cand-1', role: 'CANDIDATE' }));
  });

  it.each([
    ['createRubricAction', createRubricAction, { name: 'Behavioural' }],
    ['updateRubricAction', updateRubricAction, { id: 'r-1', name: 'Behavioural' }],
    ['publishRubricVersionAction', publishRubricVersionAction, { versionId: 'v-1' }],
    ['createRubricVersionAction', createRubricVersionAction, { rubricId: 'r-1' }],
    ['archiveRubricAction', archiveRubricAction, { id: 'r-1' }],
    ['unarchiveRubricAction', unarchiveRubricAction, { id: 'r-1' }],
  ])('refuses a candidate calling %s, and writes nothing', async (_label, action, fields) => {
    const result = failed(await action(null, form(fields)));

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.db.rubric.create).not.toHaveBeenCalled();
    expect(h.db.rubric.update).not.toHaveBeenCalled();
    expect(h.db.rubricVersion.create).not.toHaveBeenCalled();
    expect(h.db.rubricVersion.updateMany).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('refuses a candidate saving criteria, without even reading the version', async () => {
    const result = failed(
      await saveRubricVersionAction({ versionId: 'v-1', notes: '', criteria: [criterion()] }),
    );

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.rubricVersion.findUnique).not.toHaveBeenCalled();
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  // An interviewer may write scorecards but not author the instrument they are
  // scored on; MANAGE_CONTENT is the line, not "is staff".
  it('refuses an interviewer publishing a version', async () => {
    h.getCurrentUser.mockResolvedValue(actor({ id: 'int-1', role: 'INTERVIEWER' }));

    const result = failed(await publishRubricVersionAction(null, form({ versionId: 'v-1' })));

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.rubricVersion.updateMany).not.toHaveBeenCalled();
  });
});

describe('createRubricAction', () => {
  beforeEach(() => {
    h.db.rubric.create.mockResolvedValue({ id: 'r-9' });
    h.db.rubricVersion.create.mockResolvedValue({ id: 'v-9' });
  });

  /**
   * A rubric with no version has nothing to edit and nothing to publish, so
   * the two inserts have to land together or not at all.
   */
  it('creates the rubric and an unpublished version 1 in one transaction', async () => {
    await createExpectingRedirect({ name: 'Behavioural', description: 'For senior rounds.' });

    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(h.db.rubric.create).toHaveBeenCalledWith({
      data: { name: 'Behavioural', description: 'For senior rounds.' },
      select: { id: true },
    });

    const versionCall = h.db.rubricVersion.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(versionCall.data).toMatchObject({ rubricId: 'r-9', version: 1, createdById: 'admin-1' });
    // Never published on creation: publishing is a deliberate, irreversible act.
    expect(versionCall.data['isPublished']).toBeUndefined();
  });

  it('lands the author in the editor for the rubric it just created', async () => {
    await expect(createExpectingRedirect({ name: 'Behavioural' })).resolves.toBe(
      '/admin/rubrics/r-9',
    );
  });

  it('rejects a blank name rather than creating an unnameable rubric', async () => {
    const result = failed(await createRubricAction(null, form({ name: '   ' })));

    expect(result.fieldErrors?.['name']).toBeDefined();
    expect(h.db.rubric.create).not.toHaveBeenCalled();
  });
});

describe('updateRubricAction', () => {
  beforeEach(() => {
    h.db.rubric.findUnique.mockResolvedValue({ id: 'r-1' });
    h.db.rubric.update.mockResolvedValue({ id: 'r-1' });
  });

  /** An unchecked box submits nothing, so its absence is the only "off". */
  it('reads an absent isActive field as archived', async () => {
    const result = await updateRubricAction(null, form({ id: 'r-1', name: 'Behavioural' }));

    expect(result.ok).toBe(true);
    expect(h.db.rubric.update).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: { name: 'Behavioural', description: '', isActive: false },
    });
  });

  it('reads a present isActive field as available', async () => {
    await updateRubricAction(null, form({ id: 'r-1', name: 'Behavioural', isActive: 'on' }));

    const call = h.db.rubric.update.mock.calls[0]?.[0] as { data: { isActive: boolean } };
    expect(call.data.isActive).toBe(true);
  });

  it('reports a missing rubric rather than creating one', async () => {
    h.db.rubric.findUnique.mockResolvedValue(null);

    const result = failed(await updateRubricAction(null, form({ id: 'r-nope', name: 'X' })));

    expect(result.error).toBe('Rubric not found.');
    expect(h.db.rubric.update).not.toHaveBeenCalled();
  });
});

describe('saveRubricVersionAction — a published version is immutable', () => {
  /**
   * The central rule. A `Feedback` row pins the version it was written against
   * and a `FeedbackScore` points at a specific criterion, so editing published
   * criteria would retroactively change what an existing scorecard claims its
   * author meant.
   */
  it('refuses to touch a published version, and opens no transaction', async () => {
    h.db.rubricVersion.findUnique.mockResolvedValue({
      id: 'v-1',
      rubricId: 'r-1',
      version: 2,
      isPublished: true,
      criteria: [{ id: 'c-a' }],
    });

    const result = failed(
      await saveRubricVersionAction({
        versionId: 'v-1',
        notes: '',
        criteria: [criterion({ id: 'c-a', name: 'Renamed' })],
      }),
    );

    expect(result.error).toBe(
      'Version 2 is published and cannot be edited. Create a new draft version instead.',
    );
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.db.rubricCriterion.update).not.toHaveBeenCalled();
    expect(h.db.rubricCriterion.create).not.toHaveBeenCalled();
    expect(h.db.rubricCriterion.deleteMany).not.toHaveBeenCalled();
  });

  it('reports a version that does not exist', async () => {
    h.db.rubricVersion.findUnique.mockResolvedValue(null);

    const result = failed(
      await saveRubricVersionAction({ versionId: 'v-nope', notes: '', criteria: [criterion()] }),
    );

    expect(result.error).toBe('Rubric version not found.');
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  /**
   * The read above cannot hold anything still. Author B publishes version 3
   * between A's read and A's transaction; without an in-transaction guard A
   * goes on to rewrite and delete the criteria of a frozen version, silently
   * re-weighting every stage pinned to it — and because
   * `feedback_scores_criterionId_fkey` is ON DELETE CASCADE, a criterion A
   * dropped takes every score already entered against it.
   */
  describe('when the version is published mid-save', () => {
    beforeEach(() => {
      h.db.rubricVersion.findUnique.mockResolvedValue({
        id: 'v-1',
        rubricId: 'r-1',
        version: 3,
        // Still a draft when read: the publish lands after this.
        isPublished: false,
        criteria: [{ id: 'c-a' }, { id: 'c-b' }],
      });
      // The conditional write inside the transaction matches nothing, which is
      // how the database reports that the row is no longer a draft.
      h.db.rubricVersion.updateMany.mockResolvedValue({ count: 0 });
    });

    it('refuses the save rather than editing a now-frozen version', async () => {
      const result = failed(
        await saveRubricVersionAction({
          versionId: 'v-1',
          notes: 'late edit',
          criteria: [criterion({ id: 'c-a', name: 'Renamed after the freeze' })],
        }),
      );

      expect(result.error).toBe(
        'Version 3 was published while you were editing, so it can no longer be changed. Open a new draft version to carry your changes forward.',
      );
    });

    it('drops no criterion, so no scores are cascaded away', async () => {
      await saveRubricVersionAction({
        versionId: 'v-1',
        notes: '',
        // `c-b` is dropped from the list: the delete this would have issued is
        // the one that takes `FeedbackScore` rows with it.
        criteria: [criterion({ id: 'c-a' })],
      });

      expect(h.db.rubricCriterion.deleteMany).not.toHaveBeenCalled();
      expect(h.db.rubricCriterion.update).not.toHaveBeenCalled();
      expect(h.db.rubricCriterion.create).not.toHaveBeenCalled();
    });

    /** The guard is only a guard if it runs before the destructive work. */
    it('asserts the draft state as the first write in the transaction', async () => {
      await saveRubricVersionAction({
        versionId: 'v-1',
        notes: '',
        criteria: [criterion({ id: 'c-a' })],
      });

      expect(h.db.rubricVersion.updateMany).toHaveBeenCalledWith({
        where: { id: 'v-1', isPublished: false },
        data: { notes: '' },
      });
    });
  });
});

describe('saveRubricVersionAction — writing a draft', () => {
  beforeEach(() => {
    h.db.rubricVersion.findUnique.mockResolvedValue({
      id: 'v-1',
      rubricId: 'r-1',
      version: 1,
      isPublished: false,
      criteria: [{ id: 'c-a' }, { id: 'c-b' }, { id: 'c-c' }],
    });
    h.db.rubricCriterion.update.mockResolvedValue({ id: 'updated' });
    h.db.rubricCriterion.create.mockResolvedValue({ id: 'c-new' });
    h.db.rubricCriterion.deleteMany.mockResolvedValue({ count: 1 });
    // The in-transaction guard: one row matched means the version was still a
    // draft when the write landed.
    h.db.rubricVersion.updateMany.mockResolvedValue({ count: 1 });
  });

  /**
   * Positions come from the array index, never from the client, and they have
   * to come out contiguous 0..n-1 in exactly the order sent: the editor renders
   * "Criterion 3" from them, and a scorecard lists the criteria in this order.
   */
  it('renumbers positions contiguously from 0 in the order sent', async () => {
    const result = await saveRubricVersionAction({
      versionId: 'v-1',
      notes: '',
      criteria: [
        criterion({ id: 'c-c', name: 'Third, now first' }),
        criterion({ name: 'Brand new' }),
        criterion({ id: 'c-a', name: 'First, now last' }),
      ],
    });

    expect(result.ok).toBe(true);
    expect(criterionUpdates()).toEqual([
      { id: 'c-c', position: 0, name: 'Third, now first' },
      { id: 'c-a', position: 2, name: 'First, now last' },
    ]);
    expect(criterionCreates()).toEqual([
      {
        rubricVersionId: 'v-1',
        name: 'Brand new',
        description: '',
        weight: 1,
        maxScore: 4,
        position: 1,
      },
    ]);
  });

  /**
   * Reuse by id, not delete-and-recreate: a `FeedbackScore` hangs off the
   * criterion id, so re-minting ids on a draft edit would discard scores
   * already entered against it.
   */
  it('updates rows the client still lists and deletes only the ones it dropped', async () => {
    await saveRubricVersionAction({
      versionId: 'v-1',
      notes: '',
      criteria: [criterion({ id: 'c-a' }), criterion({ id: 'c-c' })],
    });

    expect(criterionUpdates().map((row) => row.id)).toEqual(['c-a', 'c-c']);
    expect(h.db.rubricCriterion.create).not.toHaveBeenCalled();
    expect(h.db.rubricCriterion.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['c-b'] } },
    });
  });

  /**
   * An id this version does not own could be stale, forged, or copied from
   * another rubric. Treating it as a new row is what stops a save adopting or
   * resurrecting somebody else's criterion.
   */
  it('treats a foreign criterion id as a new row rather than adopting it', async () => {
    await saveRubricVersionAction({
      versionId: 'v-1',
      notes: '',
      criteria: [
        criterion({ id: 'c-a' }),
        criterion({ id: 'c-b' }),
        criterion({ id: 'c-c' }),
        criterion({ id: 'c-from-another-rubric', name: 'Smuggled' }),
      ],
    });

    expect(criterionUpdates().map((row) => row.id)).toEqual(['c-a', 'c-b', 'c-c']);
    const created = criterionCreates();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: 'Smuggled', rubricVersionId: 'v-1', position: 3 });
    expect(created[0]?.['id']).toBeUndefined();
  });

  /**
   * The length of the list cannot catch this: each occurrence would update the
   * same row, the second overwriting the first's position, silently collapsing
   * two criteria into one.
   */
  it('refuses a list naming the same criterion twice, and writes nothing', async () => {
    const result = failed(
      await saveRubricVersionAction({
        versionId: 'v-1',
        notes: '',
        criteria: [criterion({ id: 'c-a' }), criterion({ id: 'c-a', name: 'Same row again' })],
      }),
    );

    expect(result.error).toBe(
      'The criteria list changed while you were editing. Reload and retry.',
    );
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.db.rubricCriterion.update).not.toHaveBeenCalled();
  });

  /**
   * The editor stays mounted across a save, so it needs the ids back; without
   * them a second save would describe the new rows as new again and the server
   * would delete and recreate what it had just written.
   */
  it('returns the persisted criterion ids in saved order', async () => {
    const result = await saveRubricVersionAction({
      versionId: 'v-1',
      notes: '',
      criteria: [criterion({ id: 'c-a' }), criterion({ name: 'Brand new' })],
    });

    expect(result.ok && result.data.criterionIds).toEqual(['c-a', 'c-new']);
  });

  it('persists the version notes alongside the criteria', async () => {
    await saveRubricVersionAction({
      versionId: 'v-1',
      notes: 'Split communication out of collaboration.',
      criteria: [criterion({ id: 'c-a' })],
    });

    expect(h.db.rubricVersion.updateMany).toHaveBeenCalledWith({
      where: { id: 'v-1', isPublished: false },
      data: { notes: 'Split communication out of collaboration.' },
    });
    // Never an unconditional update: that is the write the race would ride in on.
    expect(h.db.rubricVersion.update).not.toHaveBeenCalled();
  });

  it('rejects a weight outside the allowed range instead of clamping it', async () => {
    const result = failed(
      await saveRubricVersionAction({
        versionId: 'v-1',
        notes: '',
        criteria: [criterion({ weight: 0 })],
      }),
    );

    expect(result.fieldErrors?.['criteria.0.weight']).toBeDefined();
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  // 1 is always the bottom of the scale, so a one-point scale is not a scale.
  it('rejects a scale with fewer than two points', async () => {
    const result = failed(
      await saveRubricVersionAction({
        versionId: 'v-1',
        notes: '',
        criteria: [criterion({ maxScore: 1 })],
      }),
    );

    expect(result.fieldErrors?.['criteria.0.maxScore']).toBeDefined();
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('publishRubricVersionAction', () => {
  /**
   * Publishing is what makes a version pinnable, and it cannot be undone. A
   * version with no criteria gives an interviewer nothing to score, so it must
   * never become the frozen thing a stage points at.
   */
  it('refuses to publish a version with no criteria', async () => {
    h.db.rubricVersion.findUnique.mockResolvedValue({
      id: 'v-1',
      rubricId: 'r-1',
      version: 1,
      isPublished: false,
      _count: { criteria: 0 },
    });

    const result = failed(await publishRubricVersionAction(null, form({ versionId: 'v-1' })));

    expect(result.error).toBe(
      'Add at least one criterion before publishing — an empty rubric gives an interviewer nothing to score.',
    );
    expect(h.db.rubricVersion.updateMany).not.toHaveBeenCalled();
    expect(h.db.auditEvent.create).not.toHaveBeenCalled();
  });

  it('refuses a version that is already published', async () => {
    h.db.rubricVersion.findUnique.mockResolvedValue({
      id: 'v-1',
      rubricId: 'r-1',
      version: 1,
      isPublished: true,
      _count: { criteria: 3 },
    });

    const result = failed(await publishRubricVersionAction(null, form({ versionId: 'v-1' })));

    expect(result.error).toBe('That version is already published.');
    expect(h.db.rubricVersion.updateMany).not.toHaveBeenCalled();
  });

  it('reports a version that does not exist', async () => {
    h.db.rubricVersion.findUnique.mockResolvedValue(null);

    const result = failed(await publishRubricVersionAction(null, form({ versionId: 'v-nope' })));

    expect(result.error).toBe('Rubric version not found.');
    expect(h.db.rubricVersion.updateMany).not.toHaveBeenCalled();
  });

  describe('with a publishable draft', () => {
    beforeEach(() => {
      h.db.rubricVersion.findUnique.mockResolvedValue({
        id: 'v-1',
        rubricId: 'r-1',
        version: 2,
        isPublished: false,
        _count: { criteria: 3 },
      });
      h.db.rubricVersion.updateMany.mockResolvedValue({ count: 1 });
      h.db.auditEvent.create.mockResolvedValue({ id: 'a-1' });
    });

    it('freezes the version and stamps publishedAt', async () => {
      const result = await publishRubricVersionAction(null, form({ versionId: 'v-1' }));

      expect(result.ok).toBe(true);
      const call = h.db.rubricVersion.updateMany.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
        data: { isPublished: boolean; publishedAt: Date };
      };
      expect(call.data.isPublished).toBe(true);
      expect(call.data.publishedAt).toBeInstanceOf(Date);
    });

    /**
     * The read and the write are two round trips and publishing is
     * irreversible, so the filter — not the earlier check — is what makes a
     * double submit land exactly once.
     */
    it('writes conditionally on the version still being unpublished', async () => {
      await publishRubricVersionAction(null, form({ versionId: 'v-1' }));

      const call = h.db.rubricVersion.updateMany.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({ id: 'v-1', isPublished: false });
    });

    it('reports a lost race rather than re-stamping publishedAt', async () => {
      h.db.rubricVersion.updateMany.mockResolvedValue({ count: 0 });

      const result = failed(await publishRubricVersionAction(null, form({ versionId: 'v-1' })));

      expect(result.error).toBe('That version is already published.');
      expect(h.db.auditEvent.create).not.toHaveBeenCalled();
    });

    it('records the publication in the audit log', async () => {
      await publishRubricVersionAction(null, form({ versionId: 'v-1' }));

      const call = h.db.auditEvent.create.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(call.data).toMatchObject({
        actorId: 'admin-1',
        action: 'rubric.published',
        entityType: 'RubricVersion',
        entityId: 'v-1',
      });
      expect(call.data['metadata']).toMatchObject({
        rubricId: 'r-1',
        version: 2,
        criteriaCount: 3,
      });
    });
  });
});

describe('createRubricVersionAction', () => {
  /**
   * Two open drafts would both claim to be "the next version", and whichever
   * was published second would silently become the rubric everyone gets, with
   * the other author's edits nowhere in it.
   */
  it('refuses to open a second draft while one is still unpublished', async () => {
    h.db.rubric.findUnique.mockResolvedValue({
      id: 'r-1',
      versions: [
        { id: 'v-2', version: 2, isPublished: false, criteria: [] },
        { id: 'v-1', version: 1, isPublished: true, criteria: [{ name: 'Depth' }] },
      ],
    });

    const result = failed(await createRubricVersionAction(null, form({ rubricId: 'r-1' })));

    expect(result.error).toBe(
      'Version 2 is still a draft. Publish or finish that one before starting another.',
    );
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.db.rubricVersion.create).not.toHaveBeenCalled();
  });

  it('reports a rubric that does not exist', async () => {
    h.db.rubric.findUnique.mockResolvedValue(null);

    const result = failed(await createRubricVersionAction(null, form({ rubricId: 'r-nope' })));

    expect(result.error).toBe('Rubric not found.');
    expect(h.db.rubricVersion.create).not.toHaveBeenCalled();
  });

  describe('deep copy from the latest version', () => {
    beforeEach(() => {
      h.db.rubric.findUnique.mockResolvedValue({
        id: 'r-1',
        versions: [
          {
            id: 'v-2',
            version: 2,
            isPublished: true,
            criteria: [
              { name: 'Depth', description: 'Goes past the first answer.', weight: 3, maxScore: 5 },
              { name: 'Communication', description: '', weight: 1, maxScore: 4 },
            ],
          },
          { id: 'v-1', version: 1, isPublished: true, criteria: [] },
        ],
      });
      h.db.rubricVersion.create.mockResolvedValue({ id: 'v-3' });
      h.db.rubricCriterion.createMany.mockResolvedValue({ count: 2 });
    });

    it('numbers the new draft one past the highest existing version', async () => {
      const result = await createRubricVersionAction(null, form({ rubricId: 'r-1' }));

      expect(result.ok).toBe(true);
      const call = h.db.rubricVersion.create.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(call.data).toMatchObject({ rubricId: 'r-1', version: 3, createdById: 'admin-1' });
      expect(call.data['isPublished']).toBeUndefined();
    });

    /**
     * New rows, not a re-parent. The published criteria keep their ids so the
     * scorecards pointing at them keep meaning what they said; the draft gets
     * its own copies to edit.
     */
    it('copies the latest criteria into fresh rows on the new version', async () => {
      await createRubricVersionAction(null, form({ rubricId: 'r-1' }));

      const call = h.db.rubricCriterion.createMany.mock.calls[0]?.[0] as {
        data: Array<Record<string, unknown>>;
      };
      expect(call.data).toEqual([
        {
          rubricVersionId: 'v-3',
          name: 'Depth',
          description: 'Goes past the first answer.',
          weight: 3,
          maxScore: 5,
          position: 0,
        },
        {
          rubricVersionId: 'v-3',
          name: 'Communication',
          description: '',
          weight: 1,
          maxScore: 4,
          position: 1,
        },
      ]);
    });
  });

  /**
   * `nextVersion` is computed from a read, so two authors opening a draft at
   * the same moment both pick the same number and the loser violates
   * `rubric_versions_rubricId_version_key`. Left alone that surfaces as
   * `actionGuard`'s generic "That value is already taken", which names no value
   * the author ever typed.
   */
  it('explains a lost race on the version number instead of leaking P2002', async () => {
    h.db.rubric.findUnique.mockResolvedValue({
      id: 'r-1',
      versions: [{ id: 'v-2', version: 2, isPublished: true, criteria: [] }],
    });
    h.db.rubricVersion.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['rubricId', 'version'] },
      }),
    );

    const result = failed(await createRubricVersionAction(null, form({ rubricId: 'r-1' })));

    expect(result.error).toBe(
      'Someone else opened version 3 while you were starting it. Reload to pick up their draft.',
    );
  });

  /**
   * Deliberately not retried at N+2: the winner's row *is* the one open draft
   * this rubric is allowed, so a retry would create exactly the second draft
   * the "one draft at a time" guard exists to refuse.
   */
  it('does not retry with a higher number, which would open a second draft', async () => {
    h.db.rubric.findUnique.mockResolvedValue({
      id: 'r-1',
      versions: [{ id: 'v-2', version: 2, isPublished: true, criteria: [] }],
    });
    h.db.rubricVersion.create.mockRejectedValue(
      Object.assign(new Error('conflict'), { code: 'P2002' }),
    );

    failed(await createRubricVersionAction(null, form({ rubricId: 'r-1' })));

    expect(h.db.rubricVersion.create).toHaveBeenCalledTimes(1);
  });

  it('starts at version 1 for a rubric that somehow has none', async () => {
    h.db.rubric.findUnique.mockResolvedValue({ id: 'r-1', versions: [] });
    h.db.rubricVersion.create.mockResolvedValue({ id: 'v-1' });

    const result = await createRubricVersionAction(null, form({ rubricId: 'r-1' }));

    expect(result.ok).toBe(true);
    const call = h.db.rubricVersion.create.mock.calls[0]?.[0] as { data: { version: number } };
    expect(call.data.version).toBe(1);
    expect(h.db.rubricCriterion.createMany).not.toHaveBeenCalled();
  });
});

describe('archiveRubricAction', () => {
  /**
   * A delete would cascade through the versions and their criteria to every
   * `FeedbackScore` entered against them, leaving the scorecards as prose with
   * their numbers gone. So the rubric is deactivated, never removed.
   */
  it('flips isActive to false rather than removing the row', async () => {
    h.db.rubric.findUnique.mockResolvedValue({ id: 'r-1' });
    h.db.rubric.update.mockResolvedValue({ id: 'r-1' });

    const result = await archiveRubricAction(null, form({ id: 'r-1' }));

    expect(result.ok).toBe(true);
    expect(h.db.rubric.update).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: { isActive: false },
    });
    expect(h.db.rubric.delete).not.toHaveBeenCalled();
    expect(h.db.rubricVersion.deleteMany).not.toHaveBeenCalled();
  });

  it('reports a rubric that does not exist', async () => {
    h.db.rubric.findUnique.mockResolvedValue(null);

    const result = failed(await archiveRubricAction(null, form({ id: 'r-nope' })));

    expect(result.error).toBe('Rubric not found.');
    expect(h.db.rubric.update).not.toHaveBeenCalled();
  });
});

/**
 * Archiving is a filing decision, not a destructive one, so it has to be
 * undoable by whoever has just realised they archived the wrong rubric.
 */
describe('unarchiveRubricAction', () => {
  it('puts the rubric back in the pickers', async () => {
    h.db.rubric.findUnique.mockResolvedValue({ id: 'r-1' });
    h.db.rubric.update.mockResolvedValue({ id: 'r-1' });

    const result = await unarchiveRubricAction(null, form({ id: 'r-1' }));

    expect(result.ok).toBe(true);
    expect(h.db.rubric.update).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: { isActive: true },
    });
  });

  /** Restoring a rubric says nothing about its versions: a draft stays a
   *  draft, and publishing remains the only thing that freezes one. */
  it('republishes nothing on the way back', async () => {
    h.db.rubric.findUnique.mockResolvedValue({ id: 'r-1' });
    h.db.rubric.update.mockResolvedValue({ id: 'r-1' });

    await unarchiveRubricAction(null, form({ id: 'r-1' }));

    expect(h.db.rubricVersion.update).not.toHaveBeenCalled();
    expect(h.db.rubricVersion.updateMany).not.toHaveBeenCalled();
  });

  it('reports a rubric that does not exist', async () => {
    h.db.rubric.findUnique.mockResolvedValue(null);

    const result = failed(await unarchiveRubricAction(null, form({ id: 'r-nope' })));

    expect(result.error).toBe('Rubric not found.');
    expect(h.db.rubric.update).not.toHaveBeenCalled();
  });

  it('busts the pickers that were hiding it', async () => {
    h.db.rubric.findUnique.mockResolvedValue({ id: 'r-1' });
    h.db.rubric.update.mockResolvedValue({ id: 'r-1' });

    await unarchiveRubricAction(null, form({ id: 'r-1' }));

    const paths = h.revalidatePath.mock.calls.map((call) => call[0]);
    expect(paths).toContain('/admin/rubrics/r-1');
    expect(paths).toContain('/admin/pipeline');
  });
});

/**
 * A published version changes what the pipeline may pin, so the pages that
 * offer that choice have to be busted too — not only the rubric's own screens.
 */
describe('revalidation', () => {
  it('publishing revalidates the rubric, the list and the pipeline', async () => {
    h.db.rubricVersion.findUnique.mockResolvedValue({
      id: 'v-1',
      rubricId: 'r-1',
      version: 1,
      isPublished: false,
      _count: { criteria: 2 },
    });
    h.db.rubricVersion.updateMany.mockResolvedValue({ count: 1 });

    await publishRubricVersionAction(null, form({ versionId: 'v-1' }));

    const paths = h.revalidatePath.mock.calls.map((call) => call[0]);
    expect(paths).toContain('/admin/rubrics');
    expect(paths).toContain('/admin/rubrics/r-1');
    expect(paths).toContain('/admin/pipeline');
  });
});
