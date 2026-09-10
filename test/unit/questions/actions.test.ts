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
import { deleteQuestionAction, saveQuestionAction } from '@/features/questions/actions';

interface TestCasePayload {
  input?: string;
  expectedOutput?: string;
  description?: string;
  weight?: number;
}

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

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Two Sum',
    description: 'Find the pair.',
    difficulty: 'EASY',
    supportedLanguages: ['JAVASCRIPT', 'PYTHON'],
    starterCode: {},
    timeLimitMs: 5000,
    memoryLimitMb: 128,
    testCases: [],
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

/** The rows handed to the single `testCase.createMany`. */
function createdTestCases(): Array<Record<string, unknown>> {
  const call = h.db.testCase.createMany.mock.calls[0]?.[0] as
    { data: Array<Record<string, unknown>> } | undefined;
  if (!call) throw new Error('expected testCase.createMany to have been called');
  return call.data;
}

/** The `data` of the question create/update, whichever the action used. */
function writtenQuestionData(): Record<string, unknown> {
  const call = (h.db.question.create.mock.calls[0]?.[0] ??
    h.db.question.update.mock.calls[0]?.[0]) as { data: Record<string, unknown> } | undefined;
  if (!call) throw new Error('expected a question write');
  return call.data;
}

function testCase(overrides: TestCasePayload = {}): TestCasePayload {
  return { input: '1', expectedOutput: '1', description: '', weight: 1, ...overrides };
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.revalidatePath.mockReset();
  h.redirect.mockClear();
  h.getCurrentUser.mockReset();
  h.getCurrentUser.mockResolvedValue(actor());
  h.db.question.create.mockResolvedValue({ id: 'q-new' });
  h.db.question.update.mockResolvedValue({ id: 'q-1' });
  h.db.question.findUnique.mockResolvedValue({ id: 'q-1' });
  h.db.testCase.deleteMany.mockResolvedValue({ count: 0 });
  h.db.testCase.createMany.mockResolvedValue({ count: 0 });
});

describe('question actions — authorization', () => {
  beforeEach(() => {
    h.getCurrentUser.mockResolvedValue(actor({ id: 'cand-1', role: 'CANDIDATE' }));
  });

  // The editor is a client component, but the action behind it is a public
  // endpoint: a candidate can POST this payload directly.
  it('refuses a candidate saving a question, and opens no transaction', async () => {
    const result = failed(await saveQuestionAction(payload()));

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.db.question.create).not.toHaveBeenCalled();
  });

  it('refuses a candidate deleting a question, and removes nothing', async () => {
    const result = failed(await deleteQuestionAction(null, form({ id: 'q-1' })));

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.question.delete).not.toHaveBeenCalled();
  });

  it('refuses an anonymous caller', async () => {
    h.getCurrentUser.mockResolvedValue(null);

    const result = failed(await saveQuestionAction(payload()));

    expect(result.error).toBe('Your session has expired. Please sign in again.');
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

/**
 * The editor sends the intended final list of test cases, so saving has to
 * *replace* what is stored rather than merge with it. Doing the delete and
 * the insert in one transaction is what stops a half-applied save leaving a
 * question scored against rows the admin thought they had removed — and what
 * stops orphaned rows surviving a failure between the two statements.
 */
describe('saveQuestionAction — test cases are replaced transactionally', () => {
  it('deletes the existing rows and re-inserts the submitted ones inside one transaction', async () => {
    const result = await saveQuestionAction(
      payload({
        id: 'q-1',
        testCases: [
          testCase({ input: 'a', expectedOutput: 'A' }),
          testCase({ input: 'b', expectedOutput: 'B' }),
        ],
      }),
    );

    expect(result).toEqual({ ok: true, data: { id: 'q-1', created: false } });
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(typeof h.db.$transaction.mock.calls[0]?.[0]).toBe('function');
    expect(h.db.testCase.deleteMany).toHaveBeenCalledWith({ where: { questionId: 'q-1' } });
    // Ordering matters: an insert before the delete would wipe the new rows.
    const deletedAt = h.db.testCase.deleteMany.mock.invocationCallOrder[0] ?? 0;
    const createdAt = h.db.testCase.createMany.mock.invocationCallOrder[0] ?? 0;
    expect(deletedAt).toBeLessThan(createdAt);
  });

  it('numbers the inserted rows 0..n-1 in the order they were submitted', async () => {
    await saveQuestionAction(
      payload({
        id: 'q-1',
        testCases: [
          testCase({ input: 'first' }),
          testCase({ input: 'second' }),
          testCase({ input: 'third' }),
        ],
      }),
    );

    expect(createdTestCases().map((row) => [row.input, row.position])).toEqual([
      ['first', 0],
      ['second', 1],
      ['third', 2],
    ]);
    expect(createdTestCases().every((row) => row.questionId === 'q-1')).toBe(true);
  });

  it('still clears the old rows when the admin removes every test case', async () => {
    await saveQuestionAction(payload({ id: 'q-1', testCases: [] }));

    expect(h.db.testCase.deleteMany).toHaveBeenCalledWith({ where: { questionId: 'q-1' } });
    expect(h.db.testCase.createMany).not.toHaveBeenCalled();
  });

  it('creates the question first on the new-question path, and deletes nothing', async () => {
    const result = await saveQuestionAction(payload({ testCases: [testCase()] }));

    expect(result).toEqual({ ok: true, data: { id: 'q-new', created: true } });
    expect(h.db.testCase.deleteMany).not.toHaveBeenCalled();
    expect(createdTestCases()[0]?.questionId).toBe('q-new');
  });

  it('refuses to save against a question id that no longer exists', async () => {
    h.db.question.findUnique.mockResolvedValue(null);

    const result = failed(await saveQuestionAction(payload({ id: 'gone' })));

    expect(result.error).toBe('Question not found.');
    expect(h.db.question.update).not.toHaveBeenCalled();
    expect(h.db.testCase.deleteMany).not.toHaveBeenCalled();
  });
});

describe('saveQuestionAction — input validation', () => {
  it('rejects a question with no supported language rather than storing an unanswerable one', async () => {
    const result = failed(await saveQuestionAction(payload({ supportedLanguages: [] })));

    expect(result.fieldErrors?.supportedLanguages).toEqual(['Select at least one language.']);
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  /**
   * A weight of 0 would let a test be silently excluded from the score while
   * still appearing in the editor, so it is rejected — and the field error
   * has to name the offending row, since the editor renders one input per
   * test case and a bare "weight is invalid" points at nothing.
   */
  it('rejects a test-case weight below 1 with an error naming the offending row', async () => {
    const result = failed(
      await saveQuestionAction(
        payload({
          id: 'q-1',
          testCases: [testCase({ weight: 3 }), testCase({ weight: 0 }), testCase({ weight: 2 })],
        }),
      ),
    );

    expect(result.fieldErrors?.['testCases.1.weight']).toEqual(['Weight must be at least 1.']);
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a blank title', async () => {
    const result = failed(await saveQuestionAction(payload({ title: '   ' })));

    expect(result.fieldErrors?.title).toEqual(['Title is required.']);
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

/**
 * Starter code is a Json column keyed by runtime language id. Dropping the
 * keys for unsupported languages on the way in is what stops a language the
 * admin removed coming back to life the next time someone edits the question
 * — the editor would happily round-trip whatever the column still held.
 */
describe('saveQuestionAction — starter code follows the supported languages', () => {
  it('keeps only the entries for languages the question still supports', async () => {
    await saveQuestionAction(
      payload({
        id: 'q-1',
        supportedLanguages: ['PYTHON'],
        starterCode: {
          python: 'def solve(): ...',
          javascript: 'function solve() {}',
          ruby: 'def solve; end',
        },
      }),
    );

    expect(writtenQuestionData().starterCode).toEqual({ python: 'def solve(): ...' });
  });

  it('keeps both entries when both languages are supported', async () => {
    await saveQuestionAction(
      payload({
        id: 'q-1',
        supportedLanguages: ['JAVASCRIPT', 'PYTHON'],
        starterCode: { python: 'p', javascript: 'j' },
      }),
    );

    expect(writtenQuestionData().starterCode).toEqual({ python: 'p', javascript: 'j' });
  });
});

describe('deleteQuestionAction', () => {
  it('deletes the question and returns the admin to the list', async () => {
    h.db.question.findUnique.mockResolvedValue({ id: 'q-1' });
    h.db.question.delete.mockResolvedValue({ id: 'q-1' });

    let destination: string | null = null;
    try {
      await deleteQuestionAction(null, form({ id: 'q-1' }));
    } catch (error) {
      if (!(error instanceof MockRedirectError)) throw error;
      destination = error.url;
    }

    expect(h.db.question.delete).toHaveBeenCalledWith({ where: { id: 'q-1' } });
    expect(destination).toBe('/admin/questions');
  });

  it('reports a question that is already gone rather than issuing the delete', async () => {
    h.db.question.findUnique.mockResolvedValue(null);

    const result = failed(await deleteQuestionAction(null, form({ id: 'gone' })));

    expect(result.error).toBe('Question not found.');
    expect(h.db.question.delete).not.toHaveBeenCalled();
  });
});
