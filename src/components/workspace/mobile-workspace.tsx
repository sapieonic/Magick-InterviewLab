'use client';

import Link from 'next/link';
import { Monitor } from 'lucide-react';
import type { WorkspaceData } from '@/features/submissions/view-model';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LANGUAGE_LABEL } from '@/features/submissions/language';
import { formatDate } from '@/lib/utils';
import { QuestionNav } from './question-nav';
import { ResultsPanel } from './results-panel';
import { TimerChip, type Countdown } from './interview-timer';
import type { RunState } from './run-state';

/**
 * The phone view.
 *
 * Deliberately not a squeezed version of the workspace: Monaco on a 375px
 * screen with a soft keyboard covering half of it is worse than no editor at
 * all, and pretending otherwise invites someone to attempt an interview on a
 * train. Read the problem here, write the answer on a laptop.
 */
export function MobileWorkspace({
  data,
  countdown,
  recorded,
  run,
  blockedReason,
}: {
  data: WorkspaceData;
  countdown: Countdown | null;
  recorded: { score: number; passed: number; total: number } | null;
  run: RunState;
  blockedReason: string | null;
}) {
  const { assignment, interview, question, questions, submissions } = data;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href="/interview"
            className="text-muted-foreground hover:text-foreground text-[12px] transition-colors"
          >
            {interview.title}
          </Link>
          <h1 className="truncate text-base font-semibold tracking-tight">
            {question.position}. {question.title}
          </h1>
        </div>
        <TimerChip countdown={countdown} />
      </div>

      <div className="border-warning/30 bg-warning/8 flex gap-2.5 rounded-md border px-3 py-2.5">
        <Monitor className="text-warning mt-px size-4 shrink-0" aria-hidden />
        <p className="text-[13px]">
          Open this page on a desktop browser to write and run code. Everything below is
          read-only on a small screen.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Problem</CardTitle>
        </CardHeader>
        <CardContent>
          <Markdown content={question.description} />
        </CardContent>
      </Card>

      {recorded ? (
        <Card>
          <CardHeader>
            <CardTitle>Last submission this session</CardTitle>
          </CardHeader>
          <CardContent className="text-[13px]">
            <span className="tnum font-medium">{recorded.score}%</span> — {recorded.passed} of{' '}
            {recorded.total} tests passed.
          </CardContent>
        </Card>
      ) : null}

      {submissions.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Your submissions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {submissions.map((submission) => (
              <div
                key={submission.id}
                className="flex items-center justify-between gap-3 text-[13px]"
              >
                <span className="text-muted-foreground">
                  {formatDate(new Date(submission.submittedAt))}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">{LANGUAGE_LABEL[submission.language]}</Badge>
                  <span className="tnum font-medium">{submission.score}%</span>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {run.phase !== 'idle' ? (
        <Card className="overflow-hidden">
          <div className="max-h-96">
            <ResultsPanel state={run} onCancel={() => {}} blockedReason={blockedReason} />
          </div>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <QuestionNav
          assignmentId={assignment.id}
          questions={questions}
          currentQuestionId={question.id}
        />
      </Card>
    </div>
  );
}
