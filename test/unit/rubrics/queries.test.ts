import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  return { db: createPrismaMock() };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import {
  getPublishedVersionForRubric,
  getRubric,
  listPublishedRubrics,
  listRubrics,
} from '@/features/rubrics/queries';

/** A version row shaped as `listRubrics` selects it. */
function listVersion(
  version: number,
  isPublished: boolean,
  stages = 0,
): { version: number; isPublished: boolean; _count: { stages: number } } {
  return { version, isPublished, _count: { stages } };
}

/** A version row shaped as `getRubric` selects it. */
function detailVersion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'v-1',
    version: 1,
    isPublished: true,
    notes: '',
    publishedAt: new Date('2026-01-02T09:00:00Z'),
    createdAt: new Date('2026-01-01T09:00:00Z'),
    updatedAt: new Date('2026-01-02T09:00:00Z'),
    createdBy: { id: 'admin-1', name: 'Root' },
    criteria: [],
    _count: { stages: 0, feedback: 0 },
    ...overrides,
  };
}

function whereOf(call: unknown): Record<string, unknown> {
  return (call as { where: Record<string, unknown> }).where;
}

beforeEach(() => {
  resetPrismaMock(h.db);
});

describe('listRubrics', () => {
  /**
   * Every figure on the list page is a property of the version list, so they
   * are folded from one read rather than asked for separately — which is what
   * keeps "3 versions, latest v3" from being able to disagree.
   */
  it('folds version count, latest number, draft state and stage usage from one read', async () => {
    h.db.rubric.findMany.mockResolvedValue([
      {
        id: 'r-1',
        name: 'Behavioural',
        description: '',
        isActive: true,
        createdAt: new Date('2026-01-01T09:00:00Z'),
        versions: [listVersion(3, false), listVersion(2, true, 4), listVersion(1, true, 2)],
      },
    ]);

    const rows = await listRubrics();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'r-1',
      versionCount: 3,
      latestVersion: 3,
      hasOpenDraft: true,
      stageUsageCount: 6,
    });
  });

  it('reports no draft when every version is published', async () => {
    h.db.rubric.findMany.mockResolvedValue([
      {
        id: 'r-1',
        name: 'Behavioural',
        description: '',
        isActive: true,
        createdAt: new Date(),
        versions: [listVersion(2, true, 1), listVersion(1, true)],
      },
    ]);

    const rows = await listRubrics();

    expect(rows[0]?.hasOpenDraft).toBe(false);
    expect(rows[0]?.stageUsageCount).toBe(1);
  });

  it('reports a null latest version for a rubric with none', async () => {
    h.db.rubric.findMany.mockResolvedValue([
      {
        id: 'r-1',
        name: 'Behavioural',
        description: '',
        isActive: true,
        createdAt: new Date(),
        versions: [],
      },
    ]);

    const rows = await listRubrics();

    expect(rows[0]?.latestVersion).toBeNull();
    expect(rows[0]?.versionCount).toBe(0);
    expect(rows[0]?.hasOpenDraft).toBe(false);
  });

  // Archived rubrics sink rather than vanish: they are still the instrument
  // some past scorecard was written against.
  it('lists archived rubrics too, after the active ones', async () => {
    h.db.rubric.findMany.mockResolvedValue([]);

    await listRubrics();

    const call = h.db.rubric.findMany.mock.calls[0]?.[0] as { where?: unknown; orderBy: unknown };
    expect(call.where).toBeUndefined();
    expect(call.orderBy).toEqual([{ isActive: 'desc' }, { name: 'asc' }]);
  });
});

describe('getRubric', () => {
  it('returns null for a rubric that does not exist', async () => {
    h.db.rubric.findUnique.mockResolvedValue(null);

    await expect(getRubric('r-nope')).resolves.toBeNull();
  });

  it('exposes per-version usage and feedback counts', async () => {
    h.db.rubric.findUnique.mockResolvedValue({
      id: 'r-1',
      name: 'Behavioural',
      description: '',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { stageTemplates: 2 },
      versions: [
        detailVersion({ id: 'v-2', version: 2, _count: { stages: 3, feedback: 11 } }),
        detailVersion({ id: 'v-1', version: 1, _count: { stages: 1, feedback: 4 } }),
      ],
    });

    const rubric = await getRubric('r-1');

    expect(rubric?.versions.map((v) => [v.version, v.usageCount, v.feedbackCount])).toEqual([
      [2, 3, 11],
      [1, 1, 4],
    ]);
    expect(rubric?.stageTemplateCount).toBe(2);
  });

  /**
   * At most one version may be unpublished, and the page's whole layout turns
   * on which one it is — so the invariant is asserted here rather than being
   * re-derived by every caller.
   */
  it('picks out the single open draft and the latest published version', async () => {
    h.db.rubric.findUnique.mockResolvedValue({
      id: 'r-1',
      name: 'Behavioural',
      description: '',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { stageTemplates: 0 },
      versions: [
        detailVersion({ id: 'v-3', version: 3, isPublished: false, publishedAt: null }),
        detailVersion({ id: 'v-2', version: 2 }),
        detailVersion({ id: 'v-1', version: 1 }),
      ],
    });

    const rubric = await getRubric('r-1');

    expect(rubric?.draftVersion?.id).toBe('v-3');
    expect(rubric?.latestPublishedVersion?.id).toBe('v-2');
  });

  it('reports no draft when every version is frozen', async () => {
    h.db.rubric.findUnique.mockResolvedValue({
      id: 'r-1',
      name: 'Behavioural',
      description: '',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { stageTemplates: 0 },
      versions: [detailVersion({ id: 'v-1', version: 1 })],
    });

    const rubric = await getRubric('r-1');

    expect(rubric?.draftVersion).toBeNull();
    expect(rubric?.latestPublishedVersion?.id).toBe('v-1');
  });

  it('orders versions newest first and criteria by position', async () => {
    h.db.rubric.findUnique.mockResolvedValue(null);

    await getRubric('r-1');

    const call = h.db.rubric.findUnique.mock.calls[0]?.[0] as {
      select: {
        versions: { orderBy: unknown; select: { criteria: { orderBy: unknown } } };
      };
    };
    expect(call.select.versions.orderBy).toEqual({ version: 'desc' });
    expect(call.select.versions.select.criteria.orderBy).toEqual({ position: 'asc' });
  });
});

describe('listPublishedRubrics', () => {
  /**
   * Publishing is what makes a version eligible to be pinned to a stage, so a
   * rubric whose only version is a draft has nothing a picker could legally
   * offer. It is absent rather than present-and-broken.
   */
  it('asks only for active rubrics that have a published version', async () => {
    h.db.rubric.findMany.mockResolvedValue([]);

    await listPublishedRubrics();

    expect(whereOf(h.db.rubric.findMany.mock.calls[0]?.[0])).toEqual({
      isActive: true,
      versions: { some: { isPublished: true } },
    });
  });

  it('offers the newest published version of each rubric', async () => {
    h.db.rubric.findMany.mockResolvedValue([
      { id: 'r-1', name: 'Behavioural', versions: [{ id: 'v-7', version: 7 }] },
      { id: 'r-2', name: 'System design', versions: [{ id: 'v-1', version: 1 }] },
    ]);

    const options = await listPublishedRubrics();

    expect(options).toEqual([
      {
        id: 'r-1',
        name: 'Behavioural',
        latestPublishedVersionId: 'v-7',
        latestPublishedVersion: 7,
      },
      {
        id: 'r-2',
        name: 'System design',
        latestPublishedVersionId: 'v-1',
        latestPublishedVersion: 1,
      },
    ]);

    const call = h.db.rubric.findMany.mock.calls[0]?.[0] as {
      select: { versions: { where: unknown; orderBy: unknown; take: number } };
    };
    expect(call.select.versions.where).toEqual({ isPublished: true });
    expect(call.select.versions.orderBy).toEqual({ version: 'desc' });
    expect(call.select.versions.take).toBe(1);
  });

  /**
   * The `where` filter already excludes these, so this is belt-and-braces —
   * but the alternative to dropping the row is emitting an option with an
   * undefined version id, which would fail at the point of pinning instead of
   * here.
   */
  it('drops a rubric that comes back with no published version', async () => {
    h.db.rubric.findMany.mockResolvedValue([
      { id: 'r-draft-only', name: 'Unfinished', versions: [] },
      { id: 'r-1', name: 'Behavioural', versions: [{ id: 'v-2', version: 2 }] },
    ]);

    const options = await listPublishedRubrics();

    expect(options.map((option) => option.id)).toEqual(['r-1']);
  });
});

describe('getPublishedVersionForRubric', () => {
  it('returns null when the rubric has only drafts', async () => {
    h.db.rubricVersion.findFirst.mockResolvedValue(null);

    await expect(getPublishedVersionForRubric('r-1')).resolves.toBeNull();
  });

  /**
   * A draft is never returned whatever its version number: an unpublished
   * version is still moving, and pinning a moving target is exactly what the
   * version table exists to prevent.
   */
  it('asks for the newest published version only', async () => {
    h.db.rubricVersion.findFirst.mockResolvedValue(null);

    await getPublishedVersionForRubric('r-1');

    const call = h.db.rubricVersion.findFirst.mock.calls[0]?.[0] as {
      where: unknown;
      orderBy: unknown;
    };
    expect(call.where).toEqual({ rubricId: 'r-1', isPublished: true });
    expect(call.orderBy).toEqual({ version: 'desc' });
  });

  it('flattens the rubric name onto the version it returns', async () => {
    h.db.rubricVersion.findFirst.mockResolvedValue({
      id: 'v-2',
      rubricId: 'r-1',
      version: 2,
      isPublished: true,
      publishedAt: new Date('2026-02-01T09:00:00Z'),
      rubric: { name: 'Behavioural' },
      criteria: [
        {
          id: 'c-1',
          name: 'Depth',
          description: '',
          weight: 2,
          maxScore: 5,
          position: 0,
        },
      ],
    });

    const version = await getPublishedVersionForRubric('r-1');

    expect(version).toMatchObject({ id: 'v-2', rubricName: 'Behavioural', version: 2 });
    expect(version?.criteria).toHaveLength(1);
    expect(version?.criteria[0]?.name).toBe('Depth');
  });
});
