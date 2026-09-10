'use client';

import Link from 'next/link';
import { Check, CircleDot, Circle } from 'lucide-react';
import type { QuestionNavItem } from '@/features/submissions/view-model';
import { cn } from '@/lib/utils';

/**
 * The question rail. It doubles as progress: a candidate should be able to
 * tell at a glance which questions still need work without leaving the one
 * they are on.
 */
export function QuestionNav({
  assignmentId,
  questions,
  currentQuestionId,
  className,
}: {
  assignmentId: string;
  questions: QuestionNavItem[];
  currentQuestionId: string;
  className?: string;
}) {
  return (
    <nav aria-label="Questions" className={cn('flex min-h-0 flex-col', className)}>
      <p className="text-muted-foreground px-3 pt-3 pb-1.5 text-[11px] font-medium tracking-wide uppercase">
        Questions
      </p>
      <ul className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {questions.map((question) => {
          const active = question.id === currentQuestionId;
          const submitted = question.submissionCount > 0;
          return (
            <li key={question.id}>
              <Link
                href={`/interview/${assignmentId}/q/${question.id}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors',
                  active ? 'bg-secondary text-foreground' : 'hover:bg-muted/60',
                )}
              >
                {submitted ? (
                  <Check className="text-success mt-0.5 size-3.5 shrink-0" aria-hidden />
                ) : question.hasDraft ? (
                  <CircleDot className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
                ) : (
                  <Circle className="text-muted-foreground/40 mt-0.5 size-3.5 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block truncate text-[13px]',
                      active ? 'font-medium' : 'text-foreground/85',
                    )}
                  >
                    {question.position}. {question.title}
                  </span>
                  <span className="text-muted-foreground block text-[11px]">
                    {submitted
                      ? `Best ${question.bestScore ?? 0}%`
                      : question.hasDraft
                        ? 'In progress'
                        : 'Not started'}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
