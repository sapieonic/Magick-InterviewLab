import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { db } = await vi.hoisted(async () => ({
  db: (await import('../../helpers/prisma-mock')).createPrismaMock(),
}));
vi.mock('@/lib/db/prisma', () => ({ prisma: db }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import {
  assertCanViewApplication,
  assertPanelMember,
  canViewApplication,
  getPanelSeat,
  visibleApplicationsWhere,
} from '@/features/pipeline/access';
import { AuthorizationError } from '@/features/auth/guards';
import type { SessionUser } from '@/features/auth/session';
import type { Role } from '@/generated/prisma/enums';

function user(role: Role, id = 'u-1'): SessionUser {
  return {
    id,
    name: 'Test',
    email: `${id}@example.com`,
    role,
    isActive: true,
    mustChangePassword: false,
  };
}

const admin = user('ADMIN', 'admin-1');
const recruiter = user('RECRUITER', 'rec-1');
const interviewer = user('INTERVIEWER', 'int-1');
const candidate = user('CANDIDATE', 'cand-1');

beforeEach(() => resetPrismaMock(db));

describe('visibleApplicationsWhere', () => {
  it('adds no constraint for a viewer who may see everything', () => {
    expect(visibleApplicationsWhere(admin)).toEqual({});
    expect(visibleApplicationsWhere(recruiter)).toEqual({});
  });

  it('scopes an interviewer to applications they hold a panel seat on', () => {
    expect(visibleApplicationsWhere(interviewer)).toEqual({
      stages: { some: { interviewers: { some: { userId: 'int-1' } } } },
    });
  });

  /**
   * Unsatisfiable rather than unconstrained. A candidate should never reach a
   * list of applications at all; if a bug routes them here the query must
   * return nothing rather than the whole pipeline.
   */
  it('returns an unsatisfiable filter for a candidate', () => {
    expect(visibleApplicationsWhere(candidate)).toEqual({ id: { in: [] } });
  });
});

describe('canViewApplication', () => {
  it('is false for a candidate without touching the database', async () => {
    await expect(canViewApplication(candidate, 'app-1')).resolves.toBe(false);
    expect(db.application.findUnique).not.toHaveBeenCalled();
    expect(db.stageInterviewer.findFirst).not.toHaveBeenCalled();
  });

  it('lets a privileged viewer see any application that exists', async () => {
    db.application.findUnique.mockResolvedValue({ id: 'app-1' });
    await expect(canViewApplication(recruiter, 'app-1')).resolves.toBe(true);
  });

  it('is false when the application does not exist', async () => {
    db.application.findUnique.mockResolvedValue(null);
    await expect(canViewApplication(admin, 'missing')).resolves.toBe(false);
  });

  it('lets an interviewer through only via a panel seat', async () => {
    db.stageInterviewer.findFirst.mockResolvedValue({ id: 'seat-1' });
    await expect(canViewApplication(interviewer, 'app-1')).resolves.toBe(true);
    expect(db.stageInterviewer.findFirst).toHaveBeenCalledWith({
      where: { userId: 'int-1', stage: { applicationId: 'app-1' } },
      select: { id: true },
    });
  });

  it('refuses an interviewer with no seat on that application', async () => {
    db.stageInterviewer.findFirst.mockResolvedValue(null);
    await expect(canViewApplication(interviewer, 'app-1')).resolves.toBe(false);
  });
});

describe('assertCanViewApplication', () => {
  it('throws AuthorizationError when the viewer may not see it', async () => {
    db.stageInterviewer.findFirst.mockResolvedValue(null);
    await expect(assertCanViewApplication(interviewer, 'app-1')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('resolves quietly when they may', async () => {
    db.application.findUnique.mockResolvedValue({ id: 'app-1' });
    await expect(assertCanViewApplication(admin, 'app-1')).resolves.toBeUndefined();
  });
});

describe('getPanelSeat', () => {
  function stage(interviewers: Array<{ id: string }>, blindFeedback = true) {
    return { id: 'stage-1', applicationId: 'app-1', blindFeedback, interviewers };
  }

  it('reports a panellist as seated', async () => {
    db.stage.findUnique.mockResolvedValue(stage([{ id: 'seat-1' }]));
    await expect(getPanelSeat(interviewer, 'stage-1')).resolves.toEqual({
      stageId: 'stage-1',
      applicationId: 'app-1',
      isPanelist: true,
      stageIsBlind: true,
    });
  });

  it('lets a privileged viewer observe a stage they are not on', async () => {
    db.stage.findUnique.mockResolvedValue(stage([]));
    await expect(getPanelSeat(recruiter, 'stage-1')).resolves.toMatchObject({ isPanelist: false });
  });

  /**
   * Null for "not found" and for "not yours" alike, so a caller can 404 on
   * both — existence does not leak, exactly as the candidate workspace
   * already behaves.
   */
  it('returns null for an unseated interviewer, indistinguishably from a missing stage', async () => {
    db.stage.findUnique.mockResolvedValue(stage([]));
    await expect(getPanelSeat(interviewer, 'stage-1')).resolves.toBeNull();

    db.stage.findUnique.mockResolvedValue(null);
    await expect(getPanelSeat(recruiter, 'missing')).resolves.toBeNull();
  });

  it('returns null for a candidate without querying', async () => {
    await expect(getPanelSeat(candidate, 'stage-1')).resolves.toBeNull();
    expect(db.stage.findUnique).not.toHaveBeenCalled();
  });

  it('carries the stage’s blind setting through', async () => {
    db.stage.findUnique.mockResolvedValue(stage([{ id: 'seat-1' }], false));
    await expect(getPanelSeat(interviewer, 'stage-1')).resolves.toMatchObject({
      stageIsBlind: false,
    });
  });
});

describe('assertPanelMember', () => {
  /**
   * The object-level half of GIVE_FEEDBACK. An admin has the capability and
   * still may not score a round they did not sit in, because a scorecard from
   * someone who was not there is not evidence.
   */
  it('refuses an admin who is not on the panel', async () => {
    db.stage.findUnique.mockResolvedValue({
      id: 'stage-1',
      applicationId: 'app-1',
      blindFeedback: true,
      interviewers: [],
    });
    await expect(assertPanelMember(admin, 'stage-1')).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('returns the seat for an actual panellist', async () => {
    db.stage.findUnique.mockResolvedValue({
      id: 'stage-1',
      applicationId: 'app-1',
      blindFeedback: true,
      interviewers: [{ id: 'seat-1' }],
    });
    await expect(assertPanelMember(interviewer, 'stage-1')).resolves.toMatchObject({
      isPanelist: true,
    });
  });

  it('refuses a candidate', async () => {
    await expect(assertPanelMember(candidate, 'stage-1')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
