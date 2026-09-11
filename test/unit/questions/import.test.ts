import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/lib/action-result';
import type { SessionUser } from '@/features/auth/session';

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
import { importQuestionsAction } from '@/features/questions/actions';

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

/** A minimal manifest question — everything but the title takes a schema default. */
function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: 'Echo', ...overrides };
}

function failed(result: ActionResult<unknown>): ActionFailure {
  if (result.ok) throw new Error('expected the action to fail');
  return result;
}

/** The `data` of every `question.create`, in call order. */
function createdQuestions(): Array<Record<string, unknown>> {
  return h.db.question.create.mock.calls.map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  );
}

/** The row arrays handed to each `testCase.createMany`, in call order. */
function testCaseBatches(): Array<Array<Record<string, unknown>>> {
  return h.db.testCase.createMany.mock.calls.map(
    (call) => (call[0] as { data: Array<Record<string, unknown>> }).data,
  );
}

let created = 0;

beforeEach(() => {
  resetPrismaMock(h.db);
  h.revalidatePath.mockReset();
  h.getCurrentUser.mockReset();
  h.getCurrentUser.mockResolvedValue(actor());
  created = 0;
  h.db.question.create.mockImplementation(() => Promise.resolve({ id: `q-${++created}` }));
  h.db.question.findMany.mockResolvedValue([]);
  h.db.testCase.createMany.mockResolvedValue({ count: 0 });
});

describe('importQuestionsAction — authorization', () => {
  // The importer is a client component, but the action is a public endpoint:
  // a candidate can POST a manifest directly.
  it('refuses a candidate, and opens no transaction', async () => {
    h.getCurrentUser.mockResolvedValue(actor({ id: 'cand-1', role: 'CANDIDATE' }));

    const result = failed(await importQuestionsAction({ questions: [question()] }));

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.db.question.create).not.toHaveBeenCalled();
  });

  it('refuses an anonymous caller', async () => {
    h.getCurrentUser.mockResolvedValue(null);

    const result = failed(await importQuestionsAction({ questions: [question()] }));

    expect(result.error).toBe('Your session has expired. Please sign in again.');
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('importQuestionsAction — writing the set', () => {
  it('creates every question and reports the count', async () => {
    const result = await importQuestionsAction({
      questions: [question({ title: 'Alpha' }), question({ title: 'Beta' })],
    });

    expect(result).toEqual({
      ok: true,
      data: { imported: 2, skipped: 0, skippedTitles: [], importedIds: ['q-1', 'q-2'] },
    });
    expect(createdQuestions().map((q) => q.title)).toEqual(['Alpha', 'Beta']);
    // The whole batch is one transaction.
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(typeof h.db.$transaction.mock.calls[0]?.[0]).toBe('function');
  });

  it('accepts a bare array manifest, not only the { questions } object form', async () => {
    const result = await importQuestionsAction([question({ title: 'Only' })]);

    expect(result.ok).toBe(true);
    expect(createdQuestions().map((q) => q.title)).toEqual(['Only']);
  });

  it('positions test cases by array order and links each to its own question', async () => {
    await importQuestionsAction({
      questions: [
        question({
          title: 'Sums',
          testCases: [
            { input: 'a', expectedOutput: 'A', weight: 2 },
            { input: 'b', expectedOutput: 'B' },
          ],
        }),
      ],
    });

    const [batch] = testCaseBatches();
    expect(
      batch?.map((t) => [t.input, t.expectedOutput, t.weight, t.position, t.questionId]),
    ).toEqual([
      ['a', 'A', 2, 0, 'q-1'],
      ['b', 'B', 1, 1, 'q-1'],
    ]);
  });

  it('applies schema defaults so a title-only entry is fully formed', async () => {
    await importQuestionsAction({ questions: [{ title: 'Bare' }] });

    const [data] = createdQuestions();
    expect(data).toMatchObject({
      title: 'Bare',
      description: '',
      difficulty: 'EASY',
      supportedLanguages: ['JAVASCRIPT', 'PYTHON'],
      timeLimitMs: 5000,
      memoryLimitMb: 128,
    });
    // No test cases → no createMany for that question.
    expect(h.db.testCase.createMany).not.toHaveBeenCalled();
  });

  // Same rule as the manual create path: starter code for an unsupported
  // language is dropped so it can never resurface on a later edit.
  it('keeps only starter code for languages the question supports', async () => {
    await importQuestionsAction({
      questions: [
        question({
          title: 'Py only',
          supportedLanguages: ['PYTHON'],
          starterCode: { python: 'p', javascript: 'j', ruby: 'r' },
        }),
      ],
    });

    expect(createdQuestions()[0]?.starterCode).toEqual({ python: 'p' });
  });
});

describe('importQuestionsAction — de-duplication', () => {
  it('skips a title that already exists rather than creating a second copy', async () => {
    h.db.question.findMany.mockResolvedValue([{ title: 'Beta' }]);

    const result = await importQuestionsAction({
      questions: [question({ title: 'Alpha' }), question({ title: 'Beta' })],
    });

    expect(result).toEqual({
      ok: true,
      data: { imported: 1, skipped: 1, skippedTitles: ['Beta'], importedIds: ['q-1'] },
    });
    expect(createdQuestions().map((q) => q.title)).toEqual(['Alpha']);
  });

  it('imports nothing and opens no transaction when every title already exists', async () => {
    h.db.question.findMany.mockResolvedValue([{ title: 'Alpha' }]);

    const result = await importQuestionsAction({ questions: [question({ title: 'Alpha' })] });

    expect(result).toEqual({
      ok: true,
      data: { imported: 0, skipped: 1, skippedTitles: ['Alpha'], importedIds: [] },
    });
    expect(h.db.$transaction).not.toHaveBeenCalled();
    // Nothing changed, so no page is revalidated.
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  // Titles are trimmed by the schema before both the dup check and the DB
  // lookup, and the DB stores trimmed titles, so surrounding whitespace must
  // not defeat the skip.
  it('matches an existing title after trimming surrounding whitespace', async () => {
    h.db.question.findMany.mockResolvedValue([{ title: 'Echo' }]);

    const result = await importQuestionsAction({ questions: [question({ title: '  Echo  ' })] });

    expect(result).toEqual({
      ok: true,
      data: { imported: 0, skipped: 1, skippedTitles: ['Echo'], importedIds: [] },
    });
    // The DB was queried for the trimmed form, not the padded one.
    const where = h.db.question.findMany.mock.calls[0]?.[0]?.where as { title: { in: string[] } };
    expect(where.title.in).toEqual(['Echo']);
  });

  // A manifest that repeats a title within itself is almost certainly a
  // mistake; importing one copy and dropping the rest would hide it.
  it('rejects a manifest that lists the same title twice, before any write', async () => {
    const result = failed(
      await importQuestionsAction({
        questions: [question({ title: 'Dup' }), question({ title: 'Dup' })],
      }),
    );

    expect(result.error).toContain('Dup');
    expect(h.db.question.findMany).not.toHaveBeenCalled();
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('importQuestionsAction — validation', () => {
  it('rejects an empty manifest', async () => {
    const result = failed(await importQuestionsAction({ questions: [] }));

    expect(result.fieldErrors?.questions).toEqual(['The manifest contains no questions.']);
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  // A bad field names the offending entry so the admin can find it in a large
  // manifest, rather than a bare "title is required".
  it('surfaces a per-entry field error keyed by manifest position', async () => {
    const result = failed(
      await importQuestionsAction({
        questions: [question({ title: 'Fine' }), question({ title: '   ' })],
      }),
    );

    expect(result.fieldErrors?.['questions.1.title']).toEqual(['Title is required.']);
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a test-case weight below 1, naming the entry and test', async () => {
    const result = failed(
      await importQuestionsAction({
        questions: [
          question({ title: 'W', testCases: [{ input: '1', expectedOutput: '1', weight: 0 }] }),
        ],
      }),
    );

    expect(result.fieldErrors?.['questions.0.testCases.0.weight']).toEqual([
      'Weight must be at least 1.',
    ]);
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a non-object payload rather than crashing', async () => {
    const result = failed(await importQuestionsAction(42));

    expect(result.error).toBeTruthy();
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('importQuestionsAction — strict entries, lenient envelope', () => {
  // A typo in a hand-written manifest must not be silently stripped and
  // defaulted — an unknown key on an entry is a hard error.
  it('rejects an entry with an unknown field, naming the entry', async () => {
    const result = failed(
      await importQuestionsAction({ questions: [{ title: 'Typo', timeLimtMs: 999 }] }),
    );

    expect(result.fieldErrors).toBeDefined();
    expect(Object.keys(result.fieldErrors ?? {}).some((key) => key.startsWith('questions.0'))).toBe(
      true,
    );
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown field on a nested test case', async () => {
    const result = failed(
      await importQuestionsAction({
        questions: [
          question({ title: 'T', testCases: [{ input: '1', expectedOutput: '1', hiden: true }] }),
        ],
      }),
    );

    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(result.error).toBeTruthy();
  });

  // The envelope stays forward-compatible: any version number and any extra
  // top-level key are accepted and ignored.
  it('accepts an unknown version and ignores extra envelope keys', async () => {
    const result = await importQuestionsAction({
      version: 2,
      exportedBy: 'some future tool',
      questions: [question({ title: 'V2' })],
    });

    expect(result.ok).toBe(true);
    expect(createdQuestions().map((q) => q.title)).toEqual(['V2']);
  });
});
