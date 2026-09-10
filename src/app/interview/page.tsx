import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight, Circle, CircleDot, Check, Clock, ListChecks } from 'lucide-react';
import { requireCandidatePage } from '@/features/auth/guards';
import { listCandidateAssignments } from '@/features/submissions/queries';
import type { AssignmentSummary, QuestionNavItem } from '@/features/submissions/view-model';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { scoreLabel } from '@/features/submissions/score';

export const metadata: Metadata = { title: 'Your interviews' };
export const dynamic = 'force-dynamic';

const STATUS_LABEL = {
  ASSIGNED: 'Not started',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
} as const;

function ScoreBadge({ score }: { score: number }) {
  const label = scoreLabel(score);
  return (
    <Badge
      variant={label === 'strong' ? 'success' : label === 'partial' ? 'warning' : 'destructive'}
      className="tnum"
    >
      {score}%
    </Badge>
  );
}

function QuestionRow({
  assignmentId,
  question,
}: {
  assignmentId: string;
  question: QuestionNavItem;
}) {
  const submitted = question.submissionCount > 0;

  return (
    <li>
      <Link
        href={`/interview/${assignmentId}/q/${question.id}`}
        className="hover:bg-muted/50 group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors"
      >
        {submitted ? (
          <Check className="text-success size-4 shrink-0" aria-hidden />
        ) : question.hasDraft ? (
          <CircleDot className="text-warning size-4 shrink-0" aria-hidden />
        ) : (
          <Circle className="text-muted-foreground/40 size-4 shrink-0" aria-hidden />
        )}

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">
            {question.position}. {question.title}
          </span>
          <span className="text-muted-foreground text-[12px]">
            {question.difficulty.toLowerCase()}
            {submitted
              ? ` · ${question.submissionCount} ${question.submissionCount === 1 ? 'submission' : 'submissions'}`
              : question.hasDraft
                ? ' · draft saved'
                : ''}
          </span>
        </span>

        {question.bestScore !== null ? <ScoreBadge score={question.bestScore} /> : null}
        <ChevronRight
          className="text-muted-foreground/50 group-hover:text-muted-foreground size-4 shrink-0 transition-colors"
          aria-hidden
        />
      </Link>
    </li>
  );
}

function AssignmentCard({ summary }: { summary: AssignmentSummary }) {
  const { assignment, interview, questions } = summary;
  const answered = questions.filter((question) => question.submissionCount > 0).length;

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-[15px]">{interview.title}</CardTitle>
          <Badge
            variant={
              assignment.status === 'COMPLETED'
                ? 'success'
                : assignment.status === 'IN_PROGRESS'
                  ? 'warning'
                  : 'secondary'
            }
          >
            {STATUS_LABEL[assignment.status]}
          </Badge>
        </div>

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
          <span className="inline-flex items-center gap-1.5">
            <ListChecks className="size-3.5" aria-hidden />
            {answered} of {questions.length} answered
          </span>
          {interview.durationMinutes !== null ? (
            <span className="inline-flex items-center gap-1.5">
              <Clock className="size-3.5" aria-hidden />
              {interview.durationMinutes} minutes
            </span>
          ) : (
            <span>Untimed</span>
          )}
          {!interview.allowMultipleSubmissions ? <span>One submission per question</span> : null}
        </div>

        {interview.description ? (
          <Markdown content={interview.description} className="text-muted-foreground mt-1" />
        ) : null}
      </CardHeader>

      <CardContent className="px-2 pb-2">
        {questions.length === 0 ? (
          <p className="text-muted-foreground px-3 py-4 text-[13px]">
            This interview has no questions yet. Check back shortly.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {questions.map((question) => (
              <QuestionRow key={question.id} assignmentId={assignment.id} question={question} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default async function InterviewHomePage() {
  const user = await requireCandidatePage();
  const assignments = await listCandidateAssignments(user.id);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6 space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Your interviews</h1>
        <p className="text-muted-foreground text-[13px]">
          Pick a question to open the coding workspace. Your work is saved as you type.
        </p>
      </div>

      {assignments.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="Nothing assigned yet"
          description="No interview has been assigned to you yet. Contact your administrator."
        />
      ) : (
        <div className="space-y-4">
          {assignments.map((summary) => (
            <AssignmentCard key={summary.assignment.id} summary={summary} />
          ))}
        </div>
      )}
    </div>
  );
}
