'use server';

import 'server-only';
import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db/prisma';
import { actionGuard, NotFoundError } from '@/lib/errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { requireAdmin } from '@/features/auth/guards';
import { cuidSchema, questionInputSchema } from '@/lib/validation/schemas';
import { starterCodeKey } from './queries';

const saveQuestionSchema = questionInputSchema.extend({
  id: z.string().max(64).optional(),
});

function revalidateQuestion(id?: string): void {
  revalidatePath('/admin');
  revalidatePath('/admin/questions');
  if (id) revalidatePath(`/admin/questions/${id}`);
  // Interview pages show per-question test counts and difficulty.
  revalidatePath('/admin/interviews');
}

export interface SavedQuestion {
  id: string;
  created: boolean;
}

/**
 * One action for create and update. The editor is a single client component
 * holding nested test-case rows, so it posts a typed object rather than
 * FormData — flattening a variable-length array into form field names buys
 * nothing here and loses the schema.
 */
export async function saveQuestionAction(payload: unknown): Promise<ActionResult<SavedQuestion>> {
  return actionGuard(async () => {
    await requireAdmin();
    const input = saveQuestionSchema.parse(payload);

    // Drop starter code for languages the question no longer supports, so an
    // unsupported language cannot come back to life on a later edit.
    const allowedKeys = new Set(input.supportedLanguages.map(starterCodeKey));
    const starterCode: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.starterCode)) {
      if (allowedKeys.has(key)) starterCode[key] = value;
    }

    const data = {
      title: input.title,
      description: input.description,
      difficulty: input.difficulty,
      supportedLanguages: input.supportedLanguages,
      starterCode,
      timeLimitMs: input.timeLimitMs,
      memoryLimitMb: input.memoryLimitMb,
    };

    const testCaseRows = input.testCases.map((test, position) => ({
      id: test.id,
      input: test.input,
      expectedOutput: test.expectedOutput,
      description: test.description,
      weight: test.weight,
      position,
    }));

    // Diff-in-transaction, not replace: the client sends the intended final
    // list, each surviving row carrying its persisted id. Updating in place
    // keeps a test case's id stable across an edit, so a submission already
    // scored against those ids stays scored — a delete-and-recreate re-mints
    // every id and silently zeroes every in-flight submission. Only rows the
    // admin actually removed are deleted.
    const questionId = await prisma.$transaction(async (tx) => {
      let id = input.id;

      if (id) {
        const existing = await tx.question.findUnique({
          where: { id },
          select: { id: true, testCases: { select: { id: true } } },
        });
        if (!existing) throw new NotFoundError('Question');
        await tx.question.update({ where: { id }, data });

        // An id the client sent that this question does not own is treated as a
        // new row (it could be stale, forged, or copied from another question),
        // so it can never adopt or resurrect a foreign test case.
        const ownedIds = new Set(existing.testCases.map((t) => t.id));
        const keptIds = new Set<string>();

        for (const row of testCaseRows) {
          const { id: rowId, ...fields } = row;
          if (rowId && ownedIds.has(rowId)) {
            await tx.testCase.update({ where: { id: rowId }, data: fields });
            keptIds.add(rowId);
          } else {
            await tx.testCase.create({ data: { ...fields, questionId: id } });
          }
        }

        const removed = existing.testCases.filter((t) => !keptIds.has(t.id)).map((t) => t.id);
        if (removed.length > 0) {
          await tx.testCase.deleteMany({ where: { id: { in: removed } } });
        }
      } else {
        const created = await tx.question.create({ data, select: { id: true } });
        id = created.id;
        const newId = created.id;
        if (testCaseRows.length > 0) {
          await tx.testCase.createMany({
            data: testCaseRows.map(({ id: _rowId, ...fields }) => ({
              ...fields,
              questionId: newId,
            })),
          });
        }
      }

      return id;
    });

    revalidateQuestion(questionId);
    return ok({ id: questionId, created: !input.id });
  });
}

export async function deleteQuestionAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireAdmin();
    const id = cuidSchema.parse(formData.get('id'));

    const existing = await prisma.question.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundError('Question');

    // Test cases, interview links and submissions all cascade from the FK.
    await prisma.question.delete({ where: { id } });

    revalidateQuestion(id);
    revalidatePath('/admin/submissions');
    redirect('/admin/questions');
  });
}
