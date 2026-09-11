import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  return { db: createPrismaMock() };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import {
  listCandidateAssignments,
  loadWorkspace,
  startAssignmentIfNeeded,
} from '@/features/submissions/queries';

/** A minimal assignment row as the include-heavy query returns it. */
function assignment(overrides: {
  id: string;
  interviewId: string;
  interviewTitle?: string;
  status?: string;
  questionIds: string[];
}): Record<string, unknown> {
  return {
    id: overrides.id,
    interviewId: overrides.interviewId,
    status: overrides.status ?? 'IN_PROGRESS',
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    interview: {
      id: overrides.interviewId,
      title: overrides.interviewTitle ?? 'Interview',
      description: '',
      durationMinutes: null,
      allowMultipleSubmissions: true,
      questions: overrides.questionIds.map((qid, i) => ({
        questionId: qid,
        position: i,
        question: { id: qid, title: `Q ${qid}`, difficulty: 'EASY' },
      })),
    },
  };
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.db.codeDraft.findMany.mockResolvedValue([]);
});

describe('listCandidateAssignments — progress is scoped to the (interview, question) pair', () => {
  /**
   * A question can sit on two interviews. A submission belongs to exactly one.
   * The C2 regression: keying progress on the question id alone made a score
   * earned in interview B show up against the same question in interview A,
   * which the candidate had never worked.
   */
  it('does not credit interview A for a submission made under interview B', async () => {
    h.db.interviewAssignment.findMany.mockResolvedValue([
      assignment({ id: 'a-A', interviewId: 'int-A', questionIds: ['q-shared'] }),
      assignment({ id: 'a-B', interviewId: 'int-B', questionIds: ['q-shared'] }),
    ]);
    // The candidate scored 90 on the shared question — but only under int-B.
    h.db.submission.findMany.mockResolvedValue([
      { interviewId: 'int-B', questionId: 'q-shared', score: 90 },
    ]);

    const result = await listCandidateAssignments('cand-1');
    const a = result.find((r) => r.interview.id === 'int-A');
    const b = result.find((r) => r.interview.id === 'int-B');

    // int-A must show the question as untouched...
    expect(a?.questions[0]?.submissionCount).toBe(0);
    expect(a?.questions[0]?.bestScore).toBeNull();
    // ...while int-B carries the real result.
    expect(b?.questions[0]?.submissionCount).toBe(1);
    expect(b?.questions[0]?.bestScore).toBe(90);
  });

  it('aggregates count and best score within a single interview', async () => {
    h.db.interviewAssignment.findMany.mockResolvedValue([
      assignment({ id: 'a-A', interviewId: 'int-A', questionIds: ['q1'] }),
    ]);
    h.db.submission.findMany.mockResolvedValue([
      { interviewId: 'int-A', questionId: 'q1', score: 40 },
      { interviewId: 'int-A', questionId: 'q1', score: 75 },
    ]);

    const [a] = await listCandidateAssignments('cand-1');
    expect(a?.questions[0]?.submissionCount).toBe(2);
    expect(a?.questions[0]?.bestScore).toBe(75);
  });

  // C3: DRAFT / ARCHIVED interviews must not appear on the candidate home.
  it('asks the database for PUBLISHED interviews only', async () => {
    h.db.interviewAssignment.findMany.mockResolvedValue([]);
    h.db.submission.findMany.mockResolvedValue([]);

    await listCandidateAssignments('cand-1');

    const where = h.db.interviewAssignment.findMany.mock.calls[0]?.[0]?.where as Record<
      string,
      unknown
    >;
    expect(where.candidateId).toBe('cand-1');
    expect(where.interview).toEqual({ status: 'PUBLISHED' });
  });
});

describe('loadWorkspace — only a PUBLISHED interview is openable', () => {
  it('scopes the assignment lookup to a PUBLISHED interview owned by the candidate', async () => {
    // The status predicate makes a DRAFT/ARCHIVED interview return no row.
    h.db.interviewAssignment.findFirst.mockResolvedValue(null);

    const result = await loadWorkspace('cand-1', 'assign-1', 'q1');

    expect(result).toBeNull();
    const where = h.db.interviewAssignment.findFirst.mock.calls[0]?.[0]?.where as Record<
      string,
      unknown
    >;
    expect(where).toMatchObject({
      id: 'assign-1',
      candidateId: 'cand-1',
      interview: { status: 'PUBLISHED' },
    });
  });
});

describe('startAssignmentIfNeeded — the clock only starts on a PUBLISHED interview', () => {
  // Opening a DRAFT or ARCHIVED interview must never stamp startedAt and burn
  // the candidate's timed window; the status predicate makes the update a no-op.
  it('gates the ASSIGNED -> IN_PROGRESS update on a PUBLISHED interview', async () => {
    h.db.interviewAssignment.updateMany.mockResolvedValue({ count: 0 });

    await startAssignmentIfNeeded('cand-1', 'assign-1');

    const where = h.db.interviewAssignment.updateMany.mock.calls[0]?.[0]?.where as Record<
      string,
      unknown
    >;
    expect(where).toMatchObject({
      id: 'assign-1',
      candidateId: 'cand-1',
      status: 'ASSIGNED',
      interview: { status: 'PUBLISHED' },
    });
  });
});
