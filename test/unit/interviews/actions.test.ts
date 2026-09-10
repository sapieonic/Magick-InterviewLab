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
vi.mock('@/features/auth/session', () => ({ getCurrentUser: h.getCurrentUser }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import {
  addInterviewQuestionAction,
  archiveInterviewAction,
  assignInterviewAction,
  createInterviewAction,
  removeInterviewQuestionAction,
  reorderInterviewQuestionsAction,
  unassignInterviewAction,
  updateInterviewAction,
} from '@/features/interviews/actions';

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

/** `createInterviewAction` finishes by redirecting, which surfaces as a throw. */
async function createExpectingRedirect(fields: Record<string, string>): Promise<string> {
  try {
    await createInterviewAction(null, form(fields));
  } catch (error) {
    if (error instanceof MockRedirectError) return error.url;
    throw error;
  }
  throw new Error('expected createInterviewAction to redirect');
}

/** The `data` of the single create/update, whichever the action used. */
function writtenInterviewData(): Record<string, unknown> {
  const call = (h.db.interview.create.mock.calls[0]?.[0] ??
    h.db.interview.update.mock.calls[0]?.[0]) as { data: Record<string, unknown> } | undefined;
  if (!call) throw new Error('expected an interview write');
  return call.data;
}

/** `{ where: { id }, data: { position } }` for every link update, in call order. */
function positionWrites(): Array<{ id: string; position: number }> {
  return h.db.interviewQuestion.update.mock.calls.map((call) => {
    const arg = call[0] as { where: { id: string }; data: { position: number } };
    return { id: arg.where.id, position: arg.data.position };
  });
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.revalidatePath.mockReset();
  h.redirect.mockClear();
  h.getCurrentUser.mockReset();
  h.getCurrentUser.mockResolvedValue(actor());
});

describe('interview actions — authorization', () => {
  beforeEach(() => {
    h.getCurrentUser.mockResolvedValue(actor({ id: 'cand-1', role: 'CANDIDATE' }));
  });

  it('refuses a candidate creating an interview, and writes nothing', async () => {
    const result = failed(await createInterviewAction(null, form({ title: 'Backend' })));

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.interview.create).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('refuses a candidate updating an interview, and writes nothing', async () => {
    const result = failed(await updateInterviewAction(null, form({ id: 'int-1', title: 'X' })));

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.interview.update).not.toHaveBeenCalled();
    expect(h.db.interview.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['archiveInterviewAction', archiveInterviewAction, { id: 'int-1' }],
    [
      'addInterviewQuestionAction',
      addInterviewQuestionAction,
      { interviewId: 'int-1', questionId: 'q-1' },
    ],
    [
      'removeInterviewQuestionAction',
      removeInterviewQuestionAction,
      { interviewId: 'int-1', questionId: 'q-1' },
    ],
    ['assignInterviewAction', assignInterviewAction, { interviewId: 'int-1', candidateId: 'c-1' }],
    [
      'unassignInterviewAction',
      unassignInterviewAction,
      { interviewId: 'int-1', candidateId: 'c-1' },
    ],
  ])('refuses a candidate calling %s', async (_label, action, fields) => {
    const result = failed(await action(null, form(fields)));

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.db.interviewQuestion.create).not.toHaveBeenCalled();
    expect(h.db.interviewAssignment.create).not.toHaveBeenCalled();
    expect(h.db.interviewAssignment.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a candidate reordering questions, leaving every position untouched', async () => {
    const result = failed(
      await reorderInterviewQuestionsAction({ interviewId: 'int-1', questionIds: ['q-2', 'q-1'] }),
    );

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.interviewQuestion.findMany).not.toHaveBeenCalled();
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

/**
 * A blank duration field is "untimed", not "zero minutes". The form posts an
 * empty string either way, so the distinction has to be made here — a coerce
 * straight to number would silently give every untimed interview a 0-minute
 * timer.
 */
describe('interview form parsing — durationMinutes', () => {
  beforeEach(() => {
    h.db.interview.create.mockResolvedValue({ id: 'int-1' });
    h.db.interview.findUnique.mockResolvedValue({ id: 'int-1' });
    h.db.interview.update.mockResolvedValue({ id: 'int-1' });
  });

  it('persists an empty duration as null', async () => {
    await createExpectingRedirect({ title: 'Backend', durationMinutes: '' });

    expect(writtenInterviewData().durationMinutes).toBeNull();
  });

  it('persists a numeric duration as a number', async () => {
    await createExpectingRedirect({ title: 'Backend', durationMinutes: '45' });

    expect(writtenInterviewData().durationMinutes).toBe(45);
  });

  it('persists an omitted duration field as null', async () => {
    await createExpectingRedirect({ title: 'Backend' });

    expect(writtenInterviewData().durationMinutes).toBeNull();
  });

  it('applies the same rule on update', async () => {
    const result = await updateInterviewAction(
      null,
      form({ id: 'int-1', title: 'Backend', durationMinutes: '' }),
    );

    expect(result.ok).toBe(true);
    expect(writtenInterviewData().durationMinutes).toBeNull();
  });

  it('rejects a duration outside the allowed range instead of clamping it', async () => {
    const result = failed(
      await updateInterviewAction(
        null,
        form({ id: 'int-1', title: 'Backend', durationMinutes: '0' }),
      ),
    );

    expect(result.fieldErrors?.durationMinutes).toBeDefined();
    expect(h.db.interview.update).not.toHaveBeenCalled();
  });
});

/**
 * An unchecked checkbox submits nothing at all, so its absence is the only
 * available signal for "off" in a plain form POST.
 */
describe('interview form parsing — allowMultipleSubmissions', () => {
  beforeEach(() => {
    h.db.interview.create.mockResolvedValue({ id: 'int-1' });
  });

  it('reads a present field as enabled', async () => {
    await createExpectingRedirect({ title: 'Backend', allowMultipleSubmissions: 'on' });

    expect(writtenInterviewData().allowMultipleSubmissions).toBe(true);
  });

  it('reads an absent field as disabled', async () => {
    await createExpectingRedirect({ title: 'Backend' });

    expect(writtenInterviewData().allowMultipleSubmissions).toBe(false);
  });
});

describe('createInterviewAction', () => {
  it('lands the admin in the editor for the interview it just created', async () => {
    h.db.interview.create.mockResolvedValue({ id: 'int-9' });

    await expect(createExpectingRedirect({ title: 'Backend' })).resolves.toBe(
      '/admin/interviews/int-9',
    );
  });
});

describe('archiveInterviewAction', () => {
  // Submissions reference the interview: an interview that has been sat is a
  // record, so the action must archive rather than delete.
  it('flips the status to ARCHIVED rather than removing the row', async () => {
    h.db.interview.findUnique.mockResolvedValue({ id: 'int-1' });
    h.db.interview.update.mockResolvedValue({ id: 'int-1' });

    const result = await archiveInterviewAction(null, form({ id: 'int-1' }));

    expect(result.ok).toBe(true);
    expect(h.db.interview.update).toHaveBeenCalledWith({
      where: { id: 'int-1' },
      data: { status: 'ARCHIVED' },
    });
    expect(h.db.interview.delete).not.toHaveBeenCalled();
  });
});

describe('addInterviewQuestionAction', () => {
  beforeEach(() => {
    h.db.interview.findUnique.mockResolvedValue({ id: 'int-1' });
    h.db.question.findUnique.mockResolvedValue({ id: 'q-1' });
    h.db.interviewQuestion.findUnique.mockResolvedValue(null);
    h.db.interviewQuestion.create.mockResolvedValue({ id: 'link-1' });
  });

  it('appends after the current last position', async () => {
    h.db.interviewQuestion.findFirst.mockResolvedValue({ position: 4 });

    const result = await addInterviewQuestionAction(
      null,
      form({ interviewId: 'int-1', questionId: 'q-1' }),
    );

    expect(result.ok).toBe(true);
    expect(h.db.interviewQuestion.create).toHaveBeenCalledWith({
      data: { interviewId: 'int-1', questionId: 'q-1', position: 5 },
    });
  });

  it('starts an empty interview at position 0', async () => {
    h.db.interviewQuestion.findFirst.mockResolvedValue(null);

    await addInterviewQuestionAction(null, form({ interviewId: 'int-1', questionId: 'q-1' }));

    const call = h.db.interviewQuestion.create.mock.calls[0]?.[0] as {
      data: { position: number };
    };
    expect(call.data.position).toBe(0);
  });

  it('refuses a question already on the interview rather than duplicating the link', async () => {
    h.db.interviewQuestion.findUnique.mockResolvedValue({ id: 'link-1' });

    const result = failed(
      await addInterviewQuestionAction(null, form({ interviewId: 'int-1', questionId: 'q-1' })),
    );

    expect(result.error).toBe('That question is already in this interview.');
    expect(h.db.interviewQuestion.create).not.toHaveBeenCalled();
  });
});

describe('removeInterviewQuestionAction', () => {
  /**
   * A gap in `position` is harmless to the database and wrong to a candidate:
   * the workspace renders "question 3 of 5" from these numbers. Delete and
   * renumber therefore have to land together or not at all.
   */
  it('deletes and renumbers the survivors contiguously in one transaction', async () => {
    h.db.interviewQuestion.findUnique.mockResolvedValue({ id: 'link-2' });
    h.db.interviewQuestion.findMany.mockResolvedValue([
      { id: 'link-1' },
      { id: 'link-3' },
      { id: 'link-4' },
    ]);

    const result = await removeInterviewQuestionAction(
      null,
      form({ interviewId: 'int-1', questionId: 'q-2' }),
    );

    expect(result.ok).toBe(true);
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    const batch = h.db.$transaction.mock.calls[0]?.[0] as unknown[];
    // one delete plus one update per survivor
    expect(batch).toHaveLength(4);
    expect(h.db.interviewQuestion.delete).toHaveBeenCalledWith({ where: { id: 'link-2' } });
    expect(positionWrites()).toEqual([
      { id: 'link-1', position: 0 },
      { id: 'link-3', position: 1 },
      { id: 'link-4', position: 2 },
    ]);
  });

  it('refuses a question that is not on the interview, and opens no transaction', async () => {
    h.db.interviewQuestion.findUnique.mockResolvedValue(null);

    const result = failed(
      await removeInterviewQuestionAction(null, form({ interviewId: 'int-1', questionId: 'q-9' })),
    );

    expect(result.error).toBe('Question not found.');
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('reorderInterviewQuestionsAction', () => {
  /**
   * The client sends the whole intended order rather than a swap delta, so a
   * partial apply is the failure to guard against: every position must be
   * written in one transaction, and the result must be contiguous 0..n-1 in
   * exactly the requested sequence.
   */
  it('writes contiguous positions in the requested order, in a single transaction', async () => {
    h.db.interviewQuestion.findMany.mockResolvedValue([
      { id: 'link-a', questionId: 'q-a' },
      { id: 'link-b', questionId: 'q-b' },
      { id: 'link-c', questionId: 'q-c' },
    ]);

    const result = await reorderInterviewQuestionsAction({
      interviewId: 'int-1',
      questionIds: ['q-c', 'q-a', 'q-b'],
    });

    expect(result.ok).toBe(true);
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(h.db.$transaction.mock.calls[0]?.[0]).toHaveLength(3);
    expect(positionWrites()).toEqual([
      { id: 'link-c', position: 0 },
      { id: 'link-a', position: 1 },
      { id: 'link-b', position: 2 },
    ]);
  });

  it('refuses a list whose length no longer matches the interview, writing nothing', async () => {
    h.db.interviewQuestion.findMany.mockResolvedValue([
      { id: 'link-a', questionId: 'q-a' },
      { id: 'link-b', questionId: 'q-b' },
    ]);

    const result = failed(
      await reorderInterviewQuestionsAction({ interviewId: 'int-1', questionIds: ['q-a'] }),
    );

    expect(result.error).toBe(
      'The question list changed while you were editing. Reload and retry.',
    );
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  /**
   * The length check alone does not catch this. `['q-a', 'q-a']` against
   * links `[a, b]` is the right length, and the action resolves ids through
   * a Map — so it would write `link-a` at positions 0 and 1, never touch
   * `link-b`, and leave exactly the duplicated/gapped ordering the
   * contiguous renumber exists to prevent.
   */
  it('refuses a list containing the same question twice, and opens no transaction', async () => {
    h.db.interviewQuestion.findMany.mockResolvedValue([
      { id: 'link-a', questionId: 'q-a' },
      { id: 'link-b', questionId: 'q-b' },
    ]);

    const result = failed(
      await reorderInterviewQuestionsAction({
        interviewId: 'int-1',
        questionIds: ['q-a', 'q-a'],
      }),
    );

    expect(result.error).toBeTruthy();
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.db.interviewQuestion.update).not.toHaveBeenCalled();
  });

  // Same length but a question that is no longer linked: a stale tab could
  // otherwise renumber the rows it does know about and drop one to a
  // duplicate position.
  it('refuses a list naming a question that is no longer linked, and opens no transaction', async () => {
    h.db.interviewQuestion.findMany.mockResolvedValue([
      { id: 'link-a', questionId: 'q-a' },
      { id: 'link-b', questionId: 'q-b' },
    ]);

    const result = failed(
      await reorderInterviewQuestionsAction({
        interviewId: 'int-1',
        questionIds: ['q-a', 'q-gone'],
      }),
    );

    expect(result.error).toBe(
      'The question list changed while you were editing. Reload and retry.',
    );
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

/**
 * An assignment shows up on the interview page *and* on the candidate page.
 * Revalidating only the side the admin happened to be looking at leaves the
 * other stale until something else happens to bust it.
 */
describe('assignment revalidation touches both sides', () => {
  it('assign revalidates the interview and the candidate', async () => {
    h.db.user.findFirst.mockResolvedValue({ id: 'c-1' });
    h.db.interview.findUnique.mockResolvedValue({ id: 'int-1' });
    h.db.interviewAssignment.findUnique.mockResolvedValue(null);
    h.db.interviewAssignment.create.mockResolvedValue({ id: 'a-1' });

    const result = await assignInterviewAction(
      null,
      form({ candidateId: 'c-1', interviewId: 'int-1' }),
    );

    expect(result.ok).toBe(true);
    const paths = h.revalidatePath.mock.calls.map((call) => call[0]);
    expect(paths).toContain('/admin/interviews/int-1');
    expect(paths).toContain('/admin/candidates/c-1');
    expect(paths).toContain('/admin/candidates');
  });

  it('unassign revalidates the interview and the candidate', async () => {
    h.db.interviewAssignment.deleteMany.mockResolvedValue({ count: 1 });

    const result = await unassignInterviewAction(
      null,
      form({ candidateId: 'c-1', interviewId: 'int-1' }),
    );

    expect(result.ok).toBe(true);
    const paths = h.revalidatePath.mock.calls.map((call) => call[0]);
    expect(paths).toContain('/admin/interviews/int-1');
    expect(paths).toContain('/admin/candidates/c-1');
  });

  it('refuses to assign the same candidate twice', async () => {
    h.db.user.findFirst.mockResolvedValue({ id: 'c-1' });
    h.db.interview.findUnique.mockResolvedValue({ id: 'int-1' });
    h.db.interviewAssignment.findUnique.mockResolvedValue({ id: 'a-1' });

    const result = failed(
      await assignInterviewAction(null, form({ candidateId: 'c-1', interviewId: 'int-1' })),
    );

    expect(result.error).toBe('That candidate is already assigned to this interview.');
    expect(h.db.interviewAssignment.create).not.toHaveBeenCalled();
  });

  // Scoped to CANDIDATE rows, so an admin id cannot be handed an assignment.
  it('refuses to assign an interview to a non-candidate row', async () => {
    h.db.user.findFirst.mockResolvedValue(null);
    h.db.interview.findUnique.mockResolvedValue({ id: 'int-1' });

    const result = failed(
      await assignInterviewAction(null, form({ candidateId: 'admin-2', interviewId: 'int-1' })),
    );

    expect(result.error).toBe('Candidate not found.');
    expect(h.db.interviewAssignment.create).not.toHaveBeenCalled();
    expect(h.db.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'admin-2', role: 'CANDIDATE' },
      select: { id: true },
    });
  });

  it('reports a missing assignment rather than a silent no-op on unassign', async () => {
    h.db.interviewAssignment.deleteMany.mockResolvedValue({ count: 0 });

    const result = failed(
      await unassignInterviewAction(null, form({ candidateId: 'c-1', interviewId: 'int-1' })),
    );

    expect(result.error).toBe('Assignment not found.');
  });
});
