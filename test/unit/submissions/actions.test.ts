import { beforeEach, describe, expect, it, vi } from 'vitest';

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
// The real `requireCandidate` stays in the path — it is one of the controls
// under test — so only the session lookup behind it is faked.
vi.mock('@/features/auth/session', () => ({ getCurrentUser: h.getCurrentUser }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import { createSubmissionAction, saveDraftAction } from '@/features/submissions/actions';
import { parseStoredResults } from '@/features/submissions/stored-results';

interface ReportedResult {
  testCaseId: string;
  status: 'passed' | 'failed' | 'error' | 'timeout';
  input: string;
  expectedOutput: string;
  actualOutput: string;
  weight: number;
  durationMs: number;
  description?: string;
  stderr?: string;
  errorMessage?: string;
  errorKind?: 'syntax' | 'runtime' | 'timeout' | 'internal';
}

function actor(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'cand-1',
    name: 'Ada',
    email: 'ada@example.com',
    role: 'CANDIDATE',
    isActive: true,
    mustChangePassword: false,
    ...overrides,
  };
}

function reported(overrides: Partial<ReportedResult> = {}): ReportedResult {
  return {
    testCaseId: 'tc-1',
    status: 'passed',
    input: '1',
    expectedOutput: '1',
    actualOutput: '1',
    weight: 1,
    durationMs: 3,
    ...overrides,
  };
}

function submissionInput(overrides: Record<string, unknown> = {}): {
  interviewId: string;
  questionId: string;
  language: string;
  sourceCode: string;
  results: unknown[];
} {
  return {
    interviewId: 'int-1',
    questionId: 'q-1',
    language: 'JAVASCRIPT',
    sourceCode: 'const f = () => 1;',
    results: [reported()],
    ...overrides,
  };
}

function failed(result: ActionResult<unknown>): ActionFailure {
  if (result.ok) throw new Error('expected the action to fail');
  return result;
}

function succeeded<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`expected the action to succeed, got: ${result.error}`);
  return result.data;
}

/** The `data` of the single `prisma.submission.create`. */
function persistedSubmission(): Record<string, unknown> {
  const call = h.db.submission.create.mock.calls[0]?.[0] as
    { data: Record<string, unknown> } | undefined;
  if (!call) throw new Error('expected prisma.submission.create to have been called');
  return call.data;
}

/** Wire up the happy path: assigned, linked, multiple submissions allowed. */
function allowSubmission(
  options: {
    allowMultipleSubmissions?: boolean;
    supportedLanguages?: string[];
    status?: string;
  } = {},
): void {
  h.db.interviewAssignment.findFirst.mockResolvedValue({ id: 'assign-1', status: 'IN_PROGRESS' });
  h.db.interviewQuestion.findFirst.mockResolvedValue({
    id: 'link-1',
    question: { supportedLanguages: options.supportedLanguages ?? ['JAVASCRIPT', 'PYTHON'] },
  });
  h.db.interview.findUnique.mockResolvedValue({
    allowMultipleSubmissions: options.allowMultipleSubmissions ?? true,
    status: options.status ?? 'PUBLISHED',
  });
  h.db.testCase.findMany.mockResolvedValue([{ id: 'tc-1', weight: 1 }]);
  h.db.submission.create.mockResolvedValue({ id: 'sub-1' });
  h.db.interviewQuestion.findMany.mockResolvedValue([{ questionId: 'q-1' }]);
  h.db.submission.findMany.mockResolvedValue([]);
  h.db.interviewAssignment.updateMany.mockResolvedValue({ count: 1 });
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.revalidatePath.mockReset();
  h.getCurrentUser.mockReset();
  h.getCurrentUser.mockResolvedValue(actor());
});

describe('submission actions — authorization', () => {
  it('refuses an admin submitting on a candidate’s behalf, and writes nothing', async () => {
    h.getCurrentUser.mockResolvedValue(actor({ id: 'admin-1', role: 'ADMIN' }));

    const result = failed(await createSubmissionAction(submissionInput()));

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.submission.create).not.toHaveBeenCalled();
    expect(h.db.interviewAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('refuses an anonymous caller', async () => {
    h.getCurrentUser.mockResolvedValue(null);

    const result = failed(await createSubmissionAction(submissionInput()));

    expect(result.error).toBe('Your session has expired. Please sign in again.');
    expect(h.db.submission.create).not.toHaveBeenCalled();
  });

  it('refuses an admin saving a draft', async () => {
    h.getCurrentUser.mockResolvedValue(actor({ id: 'admin-1', role: 'ADMIN' }));

    const result = failed(
      await saveDraftAction({ questionId: 'q-1', language: 'JAVASCRIPT', sourceCode: 'x' }),
    );

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.codeDraft.upsert).not.toHaveBeenCalled();
  });
});

/**
 * A Server Action is a public endpoint. The workspace page authorised this
 * candidate when it rendered, but the action can be POSTed directly with any
 * ids at all, so ownership is re-derived from the database on every call —
 * "the page checked" is not a control on a request that never went through
 * the page.
 */
describe('createSubmissionAction — ownership is re-verified server-side', () => {
  it('refuses an interview the candidate is not assigned to, and writes nothing', async () => {
    h.db.interviewAssignment.findFirst.mockResolvedValue(null);

    const result = failed(
      await createSubmissionAction(submissionInput({ interviewId: 'someone-elses' })),
    );

    expect(result.error).toBe('Interview not found.');
    expect(h.db.submission.create).not.toHaveBeenCalled();
  });

  it('scopes the assignment lookup to the acting candidate, not to the posted id', async () => {
    allowSubmission();

    await createSubmissionAction(submissionInput());

    expect(h.db.interviewAssignment.findFirst).toHaveBeenCalledWith({
      where: { candidateId: 'cand-1', interviewId: 'int-1' },
      select: { id: true, status: true },
    });
  });

  it('refuses a question that is not on the interview, and writes nothing', async () => {
    h.db.interviewAssignment.findFirst.mockResolvedValue({ id: 'assign-1', status: 'IN_PROGRESS' });
    h.db.interviewQuestion.findFirst.mockResolvedValue(null);

    const result = failed(
      await createSubmissionAction(submissionInput({ questionId: 'q-from-another-interview' })),
    );

    expect(result.error).toBe('Question not found.');
    expect(h.db.submission.create).not.toHaveBeenCalled();
  });
});

/**
 * The anti-tamper property. The browser runs the tests, so the browser is the
 * only thing that can report per-test verdicts — but the *score* is recomputed
 * from the weights the server holds. A payload claiming huge weights on every
 * test must not be able to buy a 100%.
 */
describe('createSubmissionAction — the persisted score is recomputed from database weights', () => {
  beforeEach(() => {
    allowSubmission();
    h.db.testCase.findMany.mockResolvedValue([
      { id: 'tc-1', weight: 1 },
      { id: 'tc-2', weight: 3 },
      { id: 'tc-3', weight: 6 },
    ]);
    h.db.interviewQuestion.findMany.mockResolvedValue([{ questionId: 'q-1' }]);
  });

  it('ignores the weights the client reported and the tests it invented', async () => {
    const result = await createSubmissionAction(
      submissionInput({
        results: [
          reported({ testCaseId: 'tc-1', status: 'passed', weight: 1000 }),
          reported({ testCaseId: 'tc-2', status: 'passed', weight: 1000 }),
          // A test case that does not exist: it must not add to the total.
          reported({ testCaseId: 'tc-forged', status: 'passed', weight: 1000 }),
        ],
      }),
    );

    // Earned 1 + 3 of a possible 1 + 3 + 6 = 4/10. Trusting the payload would
    // have produced 3000/3000 = 100.
    const stored = persistedSubmission();
    expect(stored.score).toBe(40);
    expect(stored.passedCount).toBe(2);
    expect(stored.totalCount).toBe(3);
    expect(succeeded(result)).toMatchObject({ score: 40, passed: 2, total: 3 });
  });

  it('counts a test the client omitted entirely as not passed', async () => {
    await createSubmissionAction(
      submissionInput({
        results: [reported({ testCaseId: 'tc-3', status: 'passed', weight: 1 })],
      }),
    );

    // Only the 6-weight test passed: 6/10.
    expect(persistedSubmission().score).toBe(60);
    expect(persistedSubmission().passedCount).toBe(1);
    expect(persistedSubmission().totalCount).toBe(3);
  });

  it('records the weight arithmetic it actually used alongside the score', async () => {
    await createSubmissionAction(
      submissionInput({
        results: [reported({ testCaseId: 'tc-2', status: 'passed', weight: 999 })],
      }),
    );

    const envelope = persistedSubmission().results as {
      score: number;
      earnedWeight: number;
      totalWeight: number;
    };
    expect(envelope).toMatchObject({ score: 30, earnedWeight: 3, totalWeight: 10 });
  });

  it('reads the authoritative weights for the submitted question only', async () => {
    await createSubmissionAction(submissionInput());

    expect(h.db.testCase.findMany).toHaveBeenCalledWith({
      where: { questionId: 'q-1' },
      select: { id: true, weight: true },
    });
  });
});

describe('createSubmissionAction — the question and interview must accept the submission', () => {
  /**
   * The language is part of the client's payload, so it is a claim, not a
   * rule. Nothing downstream re-checks it: the score would be computed and
   * the transcript would record a Python answer to a JavaScript-only
   * question.
   */
  it('refuses a language the question does not support, and writes nothing', async () => {
    allowSubmission({ supportedLanguages: ['JAVASCRIPT'] });

    const result = failed(await createSubmissionAction(submissionInput({ language: 'PYTHON' })));

    expect(result.error).toBe('That language is not allowed for this question.');
    expect(h.db.submission.create).not.toHaveBeenCalled();
  });

  it('accepts a language the question does support', async () => {
    allowSubmission({ supportedLanguages: ['PYTHON'] });

    const result = await createSubmissionAction(submissionInput({ language: 'PYTHON' }));

    expect(result.ok).toBe(true);
    expect(h.db.submission.create).toHaveBeenCalled();
  });

  /** A stale tab must not keep writing to a retired interview. */
  it('refuses an archived interview, and writes nothing', async () => {
    allowSubmission({ status: 'ARCHIVED' });

    const result = failed(await createSubmissionAction(submissionInput()));

    expect(result.error).toBe(
      'This interview has been archived and is no longer accepting answers.',
    );
    expect(h.db.submission.create).not.toHaveBeenCalled();
  });

  /**
   * The admin edited the question (which re-keys its test cases) while this
   * candidate's tab was open, so every id the browser reports is stale. Scoring
   * by id would persist a silent 0/N under a screen full of green rows — and a
   * single-submission interview would give no retry. The action must refuse so
   * the candidate re-runs against the current tests instead of losing the
   * attempt to a race they could not see.
   */
  it('refuses a submission whose reported test ids no longer exist on the question', async () => {
    allowSubmission();
    // The question now has entirely different test-case ids than the tab holds.
    h.db.testCase.findMany.mockResolvedValue([{ id: 'fresh-1', weight: 1 }]);

    const result = failed(
      await createSubmissionAction(
        submissionInput({ results: [reported({ testCaseId: 'stale-1' })] }),
      ),
    );

    expect(result.error).toBe(
      'This question changed while you were working on it. Re-run the tests and submit again.',
    );
    expect(h.db.submission.create).not.toHaveBeenCalled();
  });

  it('still accepts a submission where at least one reported id is current', async () => {
    allowSubmission();
    h.db.testCase.findMany.mockResolvedValue([
      { id: 'tc-1', weight: 1 },
      { id: 'fresh-2', weight: 1 },
    ]);

    // tc-1 still matches, even though the candidate never saw fresh-2.
    const result = await createSubmissionAction(
      submissionInput({ results: [reported({ testCaseId: 'tc-1' })] }),
    );

    expect(result.ok).toBe(true);
    expect(h.db.submission.create).toHaveBeenCalled();
  });
});

describe('createSubmissionAction — allowMultipleSubmissions', () => {
  it('blocks a second submission when the interview allows only one', async () => {
    allowSubmission({ allowMultipleSubmissions: false });
    h.db.submission.findFirst.mockResolvedValue({ id: 'sub-earlier' });

    const result = failed(await createSubmissionAction(submissionInput()));

    expect(result.error).toBe(
      'This interview allows one submission per question, and yours is already recorded.',
    );
    expect(h.db.submission.create).not.toHaveBeenCalled();
  });

  it('allows the first submission when the interview allows only one', async () => {
    allowSubmission({ allowMultipleSubmissions: false });
    h.db.submission.findFirst.mockResolvedValue(null);

    const result = await createSubmissionAction(submissionInput());

    expect(result.ok).toBe(true);
    expect(h.db.submission.create).toHaveBeenCalledTimes(1);
  });

  // The single-submission check is per question, not per interview.
  it('scopes the existing-submission check to candidate, interview and question', async () => {
    allowSubmission({ allowMultipleSubmissions: false });
    h.db.submission.findFirst.mockResolvedValue(null);

    await createSubmissionAction(submissionInput());

    expect(h.db.submission.findFirst).toHaveBeenCalledWith({
      where: { candidateId: 'cand-1', interviewId: 'int-1', questionId: 'q-1' },
      select: { id: true },
    });
  });

  it('does not look for an earlier submission when re-submission is allowed', async () => {
    allowSubmission({ allowMultipleSubmissions: true });

    await createSubmissionAction(submissionInput());

    expect(h.db.submission.findFirst).not.toHaveBeenCalled();
  });
});

/**
 * Completion is derived from the rows rather than from a counter, so a
 * question added to a published interview reopens the assignment instead of
 * leaving it falsely COMPLETED.
 */
describe('createSubmissionAction — the assignment completes only when every question is answered', () => {
  beforeEach(() => {
    allowSubmission();
  });

  it('leaves the assignment open while a question is unanswered', async () => {
    h.db.interviewQuestion.findMany.mockResolvedValue([
      { questionId: 'q-1' },
      { questionId: 'q-2' },
    ]);
    h.db.submission.findMany.mockResolvedValue([{ questionId: 'q-1' }]);

    const result = await createSubmissionAction(submissionInput());

    expect(succeeded(result).interviewCompleted).toBe(false);
    expect(h.db.interviewAssignment.updateMany).not.toHaveBeenCalled();
  });

  it('completes the assignment once every question has a submission', async () => {
    h.db.interviewQuestion.findMany.mockResolvedValue([
      { questionId: 'q-1' },
      { questionId: 'q-2' },
    ]);
    h.db.submission.findMany.mockResolvedValue([{ questionId: 'q-1' }, { questionId: 'q-2' }]);

    const result = await createSubmissionAction(submissionInput());

    expect(succeeded(result).interviewCompleted).toBe(true);
    const update = h.db.interviewAssignment.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: { status: string; completedAt: Date };
    };
    expect(update.where).toMatchObject({ id: 'assign-1', candidateId: 'cand-1' });
    expect(update.data.status).toBe('COMPLETED');
    expect(update.data.completedAt).toBeInstanceOf(Date);
  });

  // An interview with no questions can never be "all answered".
  it('never completes an interview that has no questions', async () => {
    h.db.interviewQuestion.findMany.mockResolvedValue([]);
    h.db.submission.findMany.mockResolvedValue([]);

    const result = await createSubmissionAction(submissionInput());

    expect(succeeded(result).interviewCompleted).toBe(false);
    expect(h.db.interviewAssignment.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * REGRESSION: the `results` envelope the action writes must be readable by
 * `parseStoredResults`.
 *
 * This is the bug that shipped past a green suite. The writer normalises
 * absent optional fields to `null` (Prisma's Json input rejects `undefined`),
 * while the reader's schema used `.optional()`, which accepts `undefined` and
 * *rejects* `null` — and a `.catch([])` on the tests array turned the failure
 * into an empty list. Every submission in the product then displayed "no
 * per-test detail was recorded" for a payload that was perfectly intact.
 *
 * Neither side was wrong on its own, which is exactly why this test feeds the
 * writer's real output to the reader rather than testing either in isolation.
 */
describe('createSubmissionAction — the persisted results envelope round-trips through parseStoredResults', () => {
  beforeEach(() => {
    allowSubmission();
    h.db.testCase.findMany.mockResolvedValue([
      { id: 'tc-1', weight: 2 },
      { id: 'tc-2', weight: 2 },
    ]);
  });

  it('round-trips a mixed pass/fail payload whose optional fields are absent', async () => {
    await createSubmissionAction(
      submissionInput({
        results: [
          // A passing test has no errorKind, no stderr and no errorMessage:
          // precisely the fields the writer turns into `null`.
          reported({ testCaseId: 'tc-1', status: 'passed' }),
          reported({
            testCaseId: 'tc-2',
            status: 'error',
            actualOutput: '',
            errorMessage: 'boom',
            errorKind: 'runtime',
            stderr: 'Traceback',
          }),
        ],
      }),
    );

    const envelope = persistedSubmission().results;
    // The column is JSON, so assert against what actually survives the trip.
    const parsed = parseStoredResults(JSON.parse(JSON.stringify(envelope)) as unknown);

    expect(parsed.unreadable).toBe(false);
    expect(parsed.tests).toHaveLength(2);
    expect(parsed.tests[0]?.status).toBe('passed');
    expect(parsed.tests[1]?.status).toBe('error');
    expect(parsed.tests[1]?.errorMessage).toBe('boom');
  });

  it('round-trips a submission with no test results at all', async () => {
    h.db.testCase.findMany.mockResolvedValue([]);

    await createSubmissionAction(submissionInput({ results: [] }));

    const parsed = parseStoredResults(
      JSON.parse(JSON.stringify(persistedSubmission().results)) as unknown,
    );

    expect(parsed.unreadable).toBe(false);
    expect(parsed.tests).toEqual([]);
  });
});

describe('saveDraftAction', () => {
  beforeEach(() => {
    h.db.interviewQuestion.findFirst.mockResolvedValue({
      id: 'link-1',
      question: { supportedLanguages: ['JAVASCRIPT', 'PYTHON'] },
    });
    h.db.codeDraft.upsert.mockResolvedValue({ updatedAt: new Date('2026-01-01T00:00:00.000Z') });
  });

  /**
   * Autosave fires from the workspace, but the action is reachable directly.
   * A candidate must not be able to seed a draft against a question they were
   * never assigned — the reachability is re-derived from the assignment graph
   * rather than taken from the posted id.
   */
  it('refuses a question outside the candidate’s own assignments, and writes nothing', async () => {
    h.db.interviewQuestion.findFirst.mockResolvedValue(null);

    const result = failed(
      await saveDraftAction({ questionId: 'q-elsewhere', language: 'PYTHON', sourceCode: 'x' }),
    );

    expect(result.error).toBe('Question not found.');
    expect(h.db.codeDraft.upsert).not.toHaveBeenCalled();
  });

  it('derives reachability from the acting candidate’s assignments', async () => {
    await saveDraftAction({ questionId: 'q-1', language: 'PYTHON', sourceCode: 'x' });

    expect(h.db.interviewQuestion.findFirst).toHaveBeenCalledWith({
      where: { questionId: 'q-1', interview: { assignments: { some: { candidateId: 'cand-1' } } } },
      select: { id: true },
    });
  });

  // One row per (candidate, question, language): autosave has to overwrite
  // the buffer, not accumulate a row per keystroke burst.
  it('upserts on the (candidate, question, language) compound key', async () => {
    const result = await saveDraftAction({
      questionId: 'q-1',
      language: 'PYTHON',
      sourceCode: 'print(1)',
    });

    expect(succeeded(result).savedAt).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
    const upsert = h.db.codeDraft.upsert.mock.calls[0]?.[0] as {
      where: { candidateId_questionId_language: Record<string, string> };
      create: Record<string, string>;
      update: Record<string, string>;
    };
    expect(upsert.where.candidateId_questionId_language).toEqual({
      candidateId: 'cand-1',
      questionId: 'q-1',
      language: 'PYTHON',
    });
    expect(upsert.update).toEqual({ sourceCode: 'print(1)' });
    expect(upsert.create.candidateId).toBe('cand-1');
  });

  it('rejects a language the platform does not run, before touching the database', async () => {
    const result = failed(
      await saveDraftAction({ questionId: 'q-1', language: 'RUBY', sourceCode: 'x' }),
    );

    expect(result.fieldErrors?.language).toBeDefined();
    expect(h.db.interviewQuestion.findFirst).not.toHaveBeenCalled();
    expect(h.db.codeDraft.upsert).not.toHaveBeenCalled();
  });
});
