import { vi, type Mock } from 'vitest';

/**
 * A hand-rolled PrismaClient stand-in.
 *
 * `src/lib/db/prisma.ts` opens a real connection pool at module scope, so a
 * unit test that merely *imports* a module which imports it would try to talk
 * to Postgres. Every suite therefore replaces that module wholesale:
 *
 * ```ts
 * const { db } = await vi.hoisted(async () => ({
 *   db: (await import('../../helpers/prisma-mock')).createPrismaMock(),
 * }));
 * vi.mock('@/lib/db/prisma', () => ({ prisma: db }));
 * ```
 *
 * Building the mock inside `vi.hoisted` matters: the same object must survive
 * a `vi.resetModules()`, otherwise a re-imported module under test would be
 * handed a fresh mock the assertions no longer hold a reference to.
 */

const MODEL_METHODS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
] as const;

const MODEL_NAMES = [
  'user',
  'session',
  'interview',
  'question',
  'testCase',
  'interviewQuestion',
  'interviewAssignment',
  'submission',
  'codeDraft',
  'jobRole',
  'pipelineTemplate',
  'pipelineStageTemplate',
  'application',
  'stage',
  'stageInterviewer',
  'rubric',
  'rubricVersion',
  'rubricCriterion',
  'feedback',
  'feedbackScore',
  'feedbackRevision',
  'submissionNote',
  'applicationComment',
  'decision',
  'auditEvent',
] as const;

export type PrismaModelMethod = (typeof MODEL_METHODS)[number];
export type PrismaModelName = (typeof MODEL_NAMES)[number];

/** Every delegate method is a plain `vi.fn()`; tests stub only what they use. */
export type PrismaModelMock = Record<PrismaModelMethod, Mock>;

export type PrismaMock = Record<PrismaModelName, PrismaModelMock> & {
  $transaction: Mock;
  $connect: Mock;
  $disconnect: Mock;
  $queryRaw: Mock;
  $executeRaw: Mock;
};

/**
 * Interactive transactions run their callback against the same mock, so a
 * repository that wraps writes in `$transaction(async (tx) => ...)` records
 * its calls on the delegates the test is already asserting against.
 */
function defaultTransaction(this: PrismaMock, arg: unknown): Promise<unknown> {
  if (typeof arg === 'function') {
    const fn = arg as (tx: PrismaMock) => unknown;
    return Promise.resolve(fn(this));
  }
  if (Array.isArray(arg)) return Promise.all(arg);
  return Promise.resolve(arg);
}

function createModelMock(): PrismaModelMock {
  const model = {} as PrismaModelMock;
  for (const method of MODEL_METHODS) model[method] = vi.fn();
  return model;
}

export function createPrismaMock(): PrismaMock {
  const client = {
    $transaction: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  } as PrismaMock;
  for (const name of MODEL_NAMES) client[name] = createModelMock();
  client.$transaction.mockImplementation(defaultTransaction.bind(client));
  return client;
}

/**
 * `vi.clearAllMocks()` keeps implementations, so a `mockResolvedValue` set in
 * one test would silently satisfy the next. Reset everything between tests and
 * reinstate the transaction passthrough.
 */
export function resetPrismaMock(client: PrismaMock): void {
  for (const name of MODEL_NAMES) {
    for (const method of MODEL_METHODS) client[name][method].mockReset();
  }
  client.$connect.mockReset();
  client.$disconnect.mockReset();
  client.$queryRaw.mockReset();
  client.$executeRaw.mockReset();
  client.$transaction.mockReset();
  client.$transaction.mockImplementation(defaultTransaction.bind(client));
}
