import 'server-only';
import { prisma } from '@/lib/db/prisma';

/**
 * Read models for rubric authoring.
 *
 * The shape of these queries follows from one rule in the schema: a `Rubric`
 * is only a name, and the criteria that a scorecard is actually written
 * against live on a `RubricVersion`. So almost nothing here reads a rubric on
 * its own — an author's question is always "which version, and is anything
 * already pinned to it", because that is what decides whether the thing in
 * front of them may still be edited.
 *
 * Every select is explicit, for the same reason the candidate read models give:
 * these rows are handed to Client Components as props, and a `select`-free
 * query hands over whatever the schema grows next.
 */

export interface RubricListRow {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  createdAt: Date;
  versionCount: number;
  /** Highest version number, or null for a rubric with no versions at all. */
  latestVersion: number | null;
  /** At most one unpublished version may exist; this says whether it does. */
  hasOpenDraft: boolean;
  /** Stages pinned to any version of this rubric — i.e. scorecards in flight. */
  stageUsageCount: number;
}

export async function listRubrics(): Promise<RubricListRow[]> {
  const rows = await prisma.rubric.findMany({
    // Archived rubrics sink to the bottom rather than disappearing: they are
    // still the instrument some past scorecard was written against.
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      description: true,
      isActive: true,
      createdAt: true,
      versions: {
        orderBy: { version: 'desc' },
        select: { version: true, isPublished: true, _count: { select: { stages: true } } },
      },
    },
  });

  // The counts are folded from the versions already loaded rather than asked
  // for with a second `_count`: every figure on this page is a property of the
  // version list, and deriving them in one place is what keeps "3 versions,
  // latest v3" from ever disagreeing.
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    createdAt: row.createdAt,
    versionCount: row.versions.length,
    latestVersion: row.versions[0]?.version ?? null,
    hasOpenDraft: row.versions.some((version) => !version.isPublished),
    stageUsageCount: row.versions.reduce((sum, version) => sum + version._count.stages, 0),
  }));
}

export interface RubricCriterionRow {
  id: string;
  name: string;
  description: string;
  weight: number;
  maxScore: number;
  position: number;
}

export interface RubricVersionRow {
  id: string;
  version: number;
  isPublished: boolean;
  notes: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: { id: string; name: string } | null;
  criteria: RubricCriterionRow[];
  /** Stages pinned to this exact version. */
  usageCount: number;
  /** Scorecards written against this exact version. */
  feedbackCount: number;
}

export interface RubricDetail {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Newest first. */
  versions: RubricVersionRow[];
  /**
   * The one editable version, if there is one. Derived here rather than in the
   * page so the "at most one draft" invariant is asserted in a single place.
   */
  draftVersion: RubricVersionRow | null;
  latestPublishedVersion: RubricVersionRow | null;
  /** Pipeline stage templates that name this rubric. */
  stageTemplateCount: number;
}

export async function getRubric(id: string): Promise<RubricDetail | null> {
  const row = await prisma.rubric.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { stageTemplates: true } },
      versions: {
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          isPublished: true,
          notes: true,
          publishedAt: true,
          createdAt: true,
          updatedAt: true,
          createdBy: { select: { id: true, name: true } },
          criteria: {
            orderBy: { position: 'asc' },
            select: {
              id: true,
              name: true,
              description: true,
              weight: true,
              maxScore: true,
              position: true,
            },
          },
          _count: { select: { stages: true, feedback: true } },
        },
      },
    },
  });

  if (!row) return null;

  const versions: RubricVersionRow[] = row.versions.map((version) => ({
    id: version.id,
    version: version.version,
    isPublished: version.isPublished,
    notes: version.notes,
    publishedAt: version.publishedAt,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    createdBy: version.createdBy,
    criteria: version.criteria,
    usageCount: version._count.stages,
    feedbackCount: version._count.feedback,
  }));

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    versions,
    draftVersion: versions.find((version) => !version.isPublished) ?? null,
    latestPublishedVersion: versions.find((version) => version.isPublished) ?? null,
    stageTemplateCount: row._count.stageTemplates,
  };
}

export interface PublishedRubricOption {
  id: string;
  name: string;
  latestPublishedVersionId: string;
  latestPublishedVersion: number;
}

/**
 * The rubrics another feature may offer in a picker.
 *
 * Publishing is what makes a version eligible to be pinned to a stage, so a
 * rubric whose only version is still a draft is deliberately absent rather
 * than present-and-unselectable: there is nothing an author could pick that
 * would be legal, and an option that always errors is worse than no option.
 *
 * Archived rubrics are excluded on the same grounds `listAssignableInterviews`
 * drops archived interviews — they are history, not work. Existing pins are
 * untouched by that; this list is only about what may be chosen next.
 */
export async function listPublishedRubrics(): Promise<PublishedRubricOption[]> {
  const rows = await prisma.rubric.findMany({
    where: { isActive: true, versions: { some: { isPublished: true } } },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      versions: {
        where: { isPublished: true },
        orderBy: { version: 'desc' },
        take: 1,
        select: { id: true, version: true },
      },
    },
  });

  return rows.flatMap((row) => {
    const latest = row.versions[0];
    // The `some` filter above already guarantees this, but the narrowing is
    // what lets the caller have a non-optional id rather than a maybe.
    if (!latest) return [];
    return [
      {
        id: row.id,
        name: row.name,
        latestPublishedVersionId: latest.id,
        latestPublishedVersion: latest.version,
      },
    ];
  });
}

export interface RubricVersionWithCriteria {
  id: string;
  rubricId: string;
  rubricName: string;
  version: number;
  isPublished: boolean;
  publishedAt: Date | null;
  criteria: RubricCriterionRow[];
}

/**
 * The version a stage created *today* would be pinned to: the newest published
 * one. A draft is never returned, whatever its version number — an unpublished
 * version is still moving, and pinning a moving target is exactly what the
 * version table exists to prevent.
 */
export async function getPublishedVersionForRubric(
  rubricId: string,
): Promise<RubricVersionWithCriteria | null> {
  const row = await prisma.rubricVersion.findFirst({
    where: { rubricId, isPublished: true },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      rubricId: true,
      version: true,
      isPublished: true,
      publishedAt: true,
      rubric: { select: { name: true } },
      criteria: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          name: true,
          description: true,
          weight: true,
          maxScore: true,
          position: true,
        },
      },
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    rubricId: row.rubricId,
    rubricName: row.rubric.name,
    version: row.version,
    isPublished: row.isPublished,
    publishedAt: row.publishedAt,
    criteria: row.criteria,
  };
}
