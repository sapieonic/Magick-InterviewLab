import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  return { db: createPrismaMock() };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import { listApplicationOwners, listStaffForPanel } from '@/features/staff/queries';

/**
 * The two pickers, and the rule they both have to follow: who may be offered is
 * asked of the capability table, never of a hand-written list of roles. A
 * picker that offers somebody the write path then refuses is a dead end with no
 * explanation in it.
 */

const STAFF = [
  { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'ADMIN' as const },
  { id: 'r', name: 'Rae', email: 'rae@example.com', role: 'RECRUITER' as const },
  { id: 'h', name: 'Hal', email: 'hal@example.com', role: 'HIRING_MANAGER' as const },
  { id: 'i', name: 'Ines', email: 'ines@example.com', role: 'INTERVIEWER' as const },
];

beforeEach(() => {
  resetPrismaMock(h.db);
  h.db.user.findMany.mockResolvedValue(STAFF);
});

describe('listApplicationOwners', () => {
  it('offers exactly the roles that hold MANAGE_PIPELINE', async () => {
    const owners = await listApplicationOwners();

    // An interviewer cannot move an application along, so owning one would be
    // an accountability they have no way to discharge.
    expect(owners.map((owner) => owner.id)).toEqual(['a', 'r', 'h']);
  });

  it('asks the database only for active staff and lets the table do the rest', async () => {
    await listApplicationOwners();

    const where = (h.db.user.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> })
      .where;
    expect(where['isActive']).toBe(true);
    // Not a literal list of three roles: the filter that decides is `can(...)`,
    // so a role gaining or losing the capability needs no edit here.
    expect(where['role']).toEqual({ in: ['ADMIN', 'RECRUITER', 'HIRING_MANAGER', 'INTERVIEWER'] });
  });
});

describe('listStaffForPanel', () => {
  it('offers everyone who may write a scorecard', async () => {
    const panel = await listStaffForPanel();

    // Every staff role holds GIVE_FEEDBACK today, which is the point: the two
    // pickers differ because the capabilities differ, not because someone
    // typed two different lists.
    expect(panel.map((person) => person.id)).toEqual(['a', 'r', 'h', 'i']);
  });
});
