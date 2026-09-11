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
// Only the session lookup is faked. `requireCapability` and `assertPanelMember`
// are the controls under test, so the real ones stay in the path.
vi.mock('@/features/auth/session', () => ({ getCurrentUser: h.getCurrentUser }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import {
  addSubmissionNoteAction,
  deleteSubmissionNoteAction,
  saveFeedbackDraftAction,
  submitFeedbackAction,
} from '@/features/feedback/actions';

function user(role: Role, id = 'viewer'): SessionUser {
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

const CRITERIA = [
  { id: 'c1', name: 'Design', maxScore: 4 },
  { id: 'c2', name: 'Communication', maxScore: 10 },
];

/**
 * Two `stage.findUnique` calls run on every write: the panel-seat lookup and
 * the write context. They are told apart by their selects.
 */
function mockStage(options: { onPanel: boolean; rubricVersionId?: string | null }) {
  h.db.stage.findUnique.mockImplementation((args: { select: Record<string, unknown> }) => {
    if (args.select['blindFeedback'] !== undefined) {
      return Promise.resolve({
        id: 'stage1',
        applicationId: 'app1',
        blindFeedback: true,
        interviewers: options.onPanel ? [{ id: 'seat1' }] : [],
      });
    }
    return Promise.resolve({
      id: 'stage1',
      applicationId: 'app1',
      rubricVersionId: options.rubricVersionId === undefined ? 'rv1' : options.rubricVersionId,
    });
  });
}

interface ExistingOptions {
  status: 'DRAFT' | 'SUBMITTED';
  rubricVersionId?: string | null;
  submittedAt?: Date | null;
}

function mockExisting(options: ExistingOptions | null) {
  h.db.feedback.findUnique.mockResolvedValue(
    options === null
      ? null
      : {
          id: 'fb1',
          status: options.status,
          recommendation: 'LEAN_NO',
          confidence: 'MEDIUM',
          summary: 'the original summary',
          strengths: 'original strengths',
          concerns: 'original concerns',
          rubricVersionId: options.rubricVersionId === undefined ? 'rv1' : options.rubricVersionId,
          submittedAt:
            options.submittedAt === undefined
              ? new Date('2026-01-02T00:00:00Z')
              : options.submittedAt,
          updatedAt: new Date('2026-01-03T00:00:00Z'),
          scores: [
            { criterionId: 'c1', score: 2, note: 'shaky' },
            { criterionId: 'c2', score: 5, note: '' },
          ],
        },
  );
}

function completeSubmission(extra: Record<string, string> = {}): FormData {
  return form({
    stageId: 'stage1',
    recommendation: 'HIRE',
    confidence: 'HIGH',
    summary: 'Strong on design, clear communicator.',
    strengths: 'Systematic.',
    concerns: '',
    'score:c1': '4',
    'note:c1': 'good',
    'score:c2': '8',
    'note:c2': '',
    ...extra,
  });
}

function createdFeedbackData(): Record<string, unknown> {
  const call = h.db.feedback.create.mock.calls[0]?.[0] as
    { data: Record<string, unknown> } | undefined;
  if (!call) throw new Error('expected prisma.feedback.create to have been called');
  return call.data;
}

function updatedFeedbackData(): Record<string, unknown> {
  const call = h.db.feedback.update.mock.calls[0]?.[0] as
    { data: Record<string, unknown> } | undefined;
  if (!call) throw new Error('expected prisma.feedback.update to have been called');
  return call.data;
}

function auditActions(): string[] {
  return h.db.auditEvent.create.mock.calls.map(
    (call) => (call[0] as { data: { action: string } }).data.action,
  );
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.revalidatePath.mockReset();
  h.getCurrentUser.mockReset();
  h.getCurrentUser.mockResolvedValue(user('INTERVIEWER'));
  h.db.rubricCriterion.findMany.mockResolvedValue(CRITERIA);
  h.db.feedback.create.mockResolvedValue({ id: 'fb-new' });
  h.db.feedback.update.mockResolvedValue({ id: 'fb1' });
  h.db.feedbackRevision.create.mockResolvedValue({ id: 'rev1' });
  h.db.auditEvent.create.mockResolvedValue({ id: 'audit1' });
});

/**
 * A capability is necessary, never sufficient. These assert that nothing
 * reached the database — a guard that runs after the write is not a guard.
 */
describe('writing a scorecard takes a panel seat', () => {
  it('refuses a candidate', async () => {
    h.getCurrentUser.mockResolvedValue(user('CANDIDATE', 'cand1'));
    mockStage({ onPanel: false });
    mockExisting(null);

    failed(await submitFeedbackAction(null, completeSubmission()));

    expect(h.db.feedback.create).not.toHaveBeenCalled();
    expect(h.db.feedback.update).not.toHaveBeenCalled();
  });

  it('refuses an admin who was not on the panel, capability notwithstanding', async () => {
    h.getCurrentUser.mockResolvedValue(user('ADMIN'));
    mockStage({ onPanel: false });
    mockExisting(null);

    const result = failed(await submitFeedbackAction(null, completeSubmission()));

    expect(result.error).toMatch(/permission/i);
    expect(h.db.feedback.create).not.toHaveBeenCalled();
  });

  it('refuses a draft save from someone with no seat', async () => {
    mockStage({ onPanel: false });
    mockExisting(null);

    failed(await saveFeedbackDraftAction(null, form({ stageId: 'stage1', summary: 'hi' })));

    expect(h.db.feedback.create).not.toHaveBeenCalled();
  });
});

describe('scores are validated against the criterion’s own scale', () => {
  beforeEach(() => {
    mockStage({ onPanel: true });
    mockExisting(null);
  });

  it('rejects a score above the criterion’s maxScore', async () => {
    const result = failed(
      await submitFeedbackAction(null, completeSubmission({ 'score:c1': '7' })),
    );

    expect(result.fieldErrors?.['score:c1']?.[0]).toContain('between 1 and 4');
    expect(h.db.feedback.create).not.toHaveBeenCalled();
  });

  it('accepts on a wider scale exactly what it rejects on a narrower one', async () => {
    const result = await submitFeedbackAction(null, completeSubmission({ 'score:c2': '7' }));

    expect(result.ok).toBe(true);
  });

  it('rejects a criterion that is not on the pinned rubric version', async () => {
    const result = failed(
      await submitFeedbackAction(null, completeSubmission({ 'score:ghost': '2' })),
    );

    expect(result.error).toMatch(/criterion the rubric does not have/i);
    expect(h.db.feedback.create).not.toHaveBeenCalled();
  });

  it('rejects a submit that is missing a criterion, because a partial scorecard is not evidence', async () => {
    const data = completeSubmission();
    data.delete('score:c2');

    const result = failed(await submitFeedbackAction(null, data));

    expect(result.fieldErrors?.['score:c2']).toEqual(['Give this criterion a score.']);
    expect(h.db.feedback.create).not.toHaveBeenCalled();
  });

  it('lets a draft be as incomplete as its author likes', async () => {
    const result = await saveFeedbackDraftAction(
      null,
      form({ stageId: 'stage1', 'score:c1': '3' }),
    );

    expect(result.ok).toBe(true);
    expect(createdFeedbackData()['status']).toBe('DRAFT');
  });

  it('still range-checks a draft', async () => {
    const result = failed(
      await saveFeedbackDraftAction(null, form({ stageId: 'stage1', 'score:c1': '9' })),
    );

    expect(result.fieldErrors?.['score:c1']?.[0]).toContain('between 1 and 4');
  });
});

describe('first submit', () => {
  beforeEach(() => {
    mockStage({ onPanel: true });
    mockExisting(null);
  });

  it('writes the scorecard as submitted, pinned to the stage’s rubric version', async () => {
    const result = await submitFeedbackAction(null, completeSubmission());

    expect(result.ok).toBe(true);
    const data = createdFeedbackData();
    expect(data['status']).toBe('SUBMITTED');
    expect(data['rubricVersionId']).toBe('rv1');
    expect(data['submittedAt']).toBeInstanceOf(Date);
    expect(auditActions()).toEqual(['feedback.submitted']);
    expect(h.db.feedbackRevision.create).not.toHaveBeenCalled();
  });

  it('writes every score, with its note', async () => {
    await submitFeedbackAction(null, completeSubmission());

    const call = h.db.feedbackScore.createMany.mock.calls[0]?.[0] as {
      data: Array<Record<string, unknown>>;
    };
    expect(call.data).toEqual([
      { feedbackId: 'fb-new', criterionId: 'c1', score: 4, note: 'good' },
      { feedbackId: 'fb-new', criterionId: 'c2', score: 8, note: '' },
    ]);
  });
});

describe('a submitted scorecard is append-only', () => {
  beforeEach(() => {
    mockStage({ onPanel: true });
    mockExisting({ status: 'SUBMITTED' });
  });

  it('snapshots the complete prior state before touching the row', async () => {
    const result = await submitFeedbackAction(
      null,
      completeSubmission({ revisionReason: 'Mis-read the transcript.' }),
    );

    expect(result.ok).toBe(true);
    const call = h.db.feedbackRevision.create.mock.calls[0]?.[0] as {
      data: {
        feedbackId: string;
        editedById: string;
        reason: string;
        snapshot: Record<string, unknown>;
      };
    };
    expect(call.data.feedbackId).toBe('fb1');
    expect(call.data.editedById).toBe('viewer');
    expect(call.data.reason).toBe('Mis-read the transcript.');
    expect(call.data.snapshot).toEqual({
      status: 'SUBMITTED',
      recommendation: 'LEAN_NO',
      confidence: 'MEDIUM',
      summary: 'the original summary',
      strengths: 'original strengths',
      concerns: 'original concerns',
      rubricVersionId: 'rv1',
      submittedAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
      scores: [
        { criterionId: 'c1', score: 2, note: 'shaky' },
        { criterionId: 'c2', score: 5, note: '' },
      ],
    });
  });

  it('records the revision in the same transaction as the update', async () => {
    await submitFeedbackAction(null, completeSubmission());

    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(h.db.feedbackRevision.create).toHaveBeenCalledTimes(1);
    expect(h.db.feedback.update).toHaveBeenCalledTimes(1);
  });

  it('audits the edit as a revision, carrying the previous recommendation', async () => {
    await submitFeedbackAction(null, completeSubmission());

    expect(auditActions()).toEqual(['feedback.revised']);
    const call = h.db.auditEvent.create.mock.calls[0]?.[0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(call.data.metadata['previousRecommendation']).toBe('LEAN_NO');
    expect(call.data.metadata['recommendation']).toBe('HIRE');
  });

  it('keeps the original submittedAt, because a revision is not a new submission', async () => {
    await submitFeedbackAction(null, completeSubmission());

    expect(updatedFeedbackData()['submittedAt']).toEqual(new Date('2026-01-02T00:00:00Z'));
  });

  it('refuses to quietly demote a submitted scorecard back to a draft', async () => {
    const result = failed(
      await saveFeedbackDraftAction(null, form({ stageId: 'stage1', summary: 'oops' })),
    );

    expect(result.error).toMatch(/already been submitted/i);
    expect(h.db.feedback.update).not.toHaveBeenCalled();
    expect(h.db.feedbackRevision.create).not.toHaveBeenCalled();
  });
});

describe('the pinned rubric version', () => {
  it('is never re-read from the stage once the scorecard carries one', async () => {
    // The stage has moved to a new rubric version; the scorecard must not.
    mockStage({ onPanel: true, rubricVersionId: 'rv2' });
    mockExisting({ status: 'DRAFT', rubricVersionId: 'rv1' });

    await saveFeedbackDraftAction(null, form({ stageId: 'stage1', summary: 'x' }));

    expect(h.db.rubricCriterion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { rubricVersionId: 'rv1' } }),
    );
    expect(updatedFeedbackData()).not.toHaveProperty('rubricVersionId');
  });

  it('is taken from the stage when the scorecard was opened before a rubric existed', async () => {
    mockStage({ onPanel: true, rubricVersionId: 'rv2' });
    mockExisting({ status: 'DRAFT', rubricVersionId: null });

    await saveFeedbackDraftAction(null, form({ stageId: 'stage1', summary: 'x' }));

    expect(updatedFeedbackData()['rubricVersionId']).toBe('rv2');
  });

  it('lets a stage with no rubric at all still take a recommendation', async () => {
    mockStage({ onPanel: true, rubricVersionId: null });
    mockExisting(null);
    h.db.rubricCriterion.findMany.mockResolvedValue([]);

    const data = form({
      stageId: 'stage1',
      recommendation: 'NO',
      confidence: 'LOW',
      summary: 'Did not get to the design.',
    });
    const result = await submitFeedbackAction(null, data);

    expect(result.ok).toBe(true);
    expect(createdFeedbackData()['rubricVersionId']).toBeNull();
  });
});

describe('submission notes', () => {
  function allowSubmission() {
    h.db.submission.findUnique.mockResolvedValue({
      id: 'sub1',
      candidateId: 'cand1',
      interviewId: 'int1',
    });
    h.db.stage.findFirst.mockResolvedValue({ applicationId: 'app1' });
    h.db.stageInterviewer.findFirst.mockResolvedValue({ id: 'seat1' });
  }

  it('refuses a candidate', async () => {
    h.getCurrentUser.mockResolvedValue(user('CANDIDATE', 'cand1'));
    allowSubmission();

    failed(await addSubmissionNoteAction(null, form({ submissionId: 'sub1', body: 'hi' })));

    expect(h.db.submissionNote.create).not.toHaveBeenCalled();
  });

  it('refuses a staff member with no access to the owning application', async () => {
    allowSubmission();
    h.db.stageInterviewer.findFirst.mockResolvedValue(null);

    const result = failed(
      await addSubmissionNoteAction(null, form({ submissionId: 'sub1', body: 'hi' })),
    );

    expect(result.error).toMatch(/not found/i);
    expect(h.db.submissionNote.create).not.toHaveBeenCalled();
  });

  it('records an accepted note against the owning application', async () => {
    allowSubmission();
    h.db.submissionNote.create.mockResolvedValue({ id: 'note1' });

    const result = await addSubmissionNoteAction(
      null,
      form({ submissionId: 'sub1', body: 'Line 42 reimplements groupBy.', lineStart: '42' }),
    );

    expect(result.ok).toBe(true);
    const call = h.db.submissionNote.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data['lineStart']).toBe(42);
    expect(call.data['lineEnd']).toBeNull();
    expect(auditActions()).toEqual(['note.added']);
  });

  it('rejects a line range that ends before it starts', async () => {
    allowSubmission();

    const result = failed(
      await addSubmissionNoteAction(
        null,
        form({ submissionId: 'sub1', body: 'x', lineStart: '9', lineEnd: '2' }),
      ),
    );

    expect(result.fieldErrors?.['lineEnd']).toBeDefined();
    expect(h.db.submissionNote.create).not.toHaveBeenCalled();
  });

  it('lets only the author delete a note', async () => {
    allowSubmission();
    h.db.submissionNote.findUnique.mockResolvedValue({
      id: 'note1',
      authorId: 'someone-else',
      submissionId: 'sub1',
    });

    failed(await deleteSubmissionNoteAction(null, form({ id: 'note1' })));
    expect(h.db.submissionNote.delete).not.toHaveBeenCalled();

    h.db.submissionNote.findUnique.mockResolvedValue({
      id: 'note1',
      authorId: 'viewer',
      submissionId: 'sub1',
    });
    const result = await deleteSubmissionNoteAction(null, form({ id: 'note1' }));

    expect(result.ok).toBe(true);
    expect(h.db.submissionNote.delete).toHaveBeenCalledWith({ where: { id: 'note1' } });
  });

  /**
   * A retraction is still a thing a reviewer did. An audit log with a hole in
   * it exactly where someone withdrew an opinion is worse than no log at all.
   */
  it('records the removal, so a retracted note still leaves a trail', async () => {
    allowSubmission();
    h.db.submissionNote.findUnique.mockResolvedValue({
      id: 'note1',
      authorId: 'viewer',
      submissionId: 'sub1',
    });

    await deleteSubmissionNoteAction(null, form({ id: 'note1' }));

    expect(auditActions()).toContain('note.deleted');
  });
});
