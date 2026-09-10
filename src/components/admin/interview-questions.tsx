'use client';

import Link from 'next/link';
import { useOptimistic, useTransition } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type { Difficulty } from '@/generated/prisma/enums';
import {
  removeInterviewQuestionAction,
  reorderInterviewQuestionsAction,
} from '@/features/interviews/actions';
import { DifficultyBadge } from '@/components/admin/badges';
import { ActionForm } from '@/components/admin/action-form';
import { SubmitButton } from '@/components/admin/form';
import { Button } from '@/components/ui/button';

export interface InterviewQuestionItem {
  id: string;
  title: string;
  difficulty: Difficulty;
  testCount: number;
}

/**
 * Up/down buttons rather than drag-and-drop: no dependency, keyboard-usable
 * for free, and the reorder is expressed as the whole ordered list so a
 * double-click cannot commit half a swap.
 *
 * `useOptimistic` rather than local state synced from props: the swap shows
 * instantly, and when the transition ends the list falls back to whatever
 * the server actually has — which is also the revert path when the write is
 * refused, with no reconciliation code of our own.
 */
export function InterviewQuestions({
  interviewId,
  questions,
}: {
  interviewId: string;
  questions: InterviewQuestionItem[];
}) {
  const [ordered, setOptimisticOrder] = useOptimistic(questions);
  const [pending, startTransition] = useTransition();

  function move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;

    const next = [...ordered];
    const moved = next[index];
    const displaced = next[target];
    if (moved === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = moved;

    startTransition(async () => {
      setOptimisticOrder(next);
      const result = await reorderInterviewQuestionsAction({
        interviewId,
        questionIds: next.map((q) => q.id),
      });
      if (!result.ok) toast.error(result.error);
    });
  }

  if (ordered.length === 0) {
    return (
      <p className="text-muted-foreground py-2 text-[13px]">
        No questions yet. Add one from the picker above — a published interview with no questions
        gives the candidate an empty screen.
      </p>
    );
  }

  return (
    <ol className="space-y-2">
      {ordered.map((question, index) => (
        <li
          key={question.id}
          className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
        >
          <span className="text-muted-foreground w-5 shrink-0 text-[12px] tabular-nums">
            {index + 1}.
          </span>

          <Link
            href={`/admin/questions/${question.id}`}
            className="hover:text-primary min-w-0 flex-1 truncate text-[13px] font-medium transition-colors"
          >
            {question.title}
          </Link>

          <DifficultyBadge difficulty={question.difficulty} />
          <span className="text-muted-foreground text-[12px] tabular-nums">
            {question.testCount} {question.testCount === 1 ? 'test' : 'tests'}
          </span>

          <span className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={index === 0 || pending}
              onClick={() => move(index, -1)}
              aria-label={`Move ${question.title} up`}
              title="Move up"
            >
              <ArrowUp className="size-3.5" aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={index === ordered.length - 1 || pending}
              onClick={() => move(index, 1)}
              aria-label={`Move ${question.title} down`}
              title="Move down"
            >
              <ArrowDown className="size-3.5" aria-hidden />
            </Button>
            <ActionForm action={removeInterviewQuestionAction} success="Question removed.">
              <input type="hidden" name="interviewId" value={interviewId} />
              <input type="hidden" name="questionId" value={question.id} />
              <SubmitButton
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${question.title} from this interview`}
                title="Remove from interview"
              >
                <X className="size-3.5" aria-hidden />
              </SubmitButton>
            </ActionForm>
          </span>
        </li>
      ))}
    </ol>
  );
}
