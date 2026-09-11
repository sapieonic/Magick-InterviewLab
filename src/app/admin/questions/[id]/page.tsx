import type { Metadata } from 'next';
import { requireAdminPage } from '@/features/auth/guards';
import { notFound } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { getQuestion, getQuestionUsage } from '@/features/questions/queries';
import { deleteQuestionAction } from '@/features/questions/actions';
import { QuestionEditor } from '@/components/admin/question-editor';
import { PageHeader } from '@/components/admin/page-header';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { formatDate } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  await requireAdminPage();
  const { id } = await params;
  const question = await getQuestion(id);
  return { title: question ? question.title : 'Question' };
}

export default async function QuestionDetailPage({ params }: PageProps) {
  await requireAdminPage();
  const { id } = await params;
  const question = await getQuestion(id);
  if (!question) notFound();

  const usage = await getQuestionUsage(id);
  const interviewCount = usage.interviews.length;

  return (
    <>
      <PageHeader
        title={question.title}
        backHref="/admin/questions"
        backLabel="Questions"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Used in {interviewCount} {interviewCount === 1 ? 'interview' : 'interviews'}
            </span>
            <span>
              {usage.submissionCount} {usage.submissionCount === 1 ? 'submission' : 'submissions'}
            </span>
            <span>Updated {formatDate(question.updatedAt)}</span>
          </span>
        }
        actions={
          <ConfirmAction
            action={deleteQuestionAction}
            fields={{ id: question.id }}
            title="Delete this question?"
            description={
              <>
                <p>
                  This removes the question from{' '}
                  <strong>
                    {interviewCount} {interviewCount === 1 ? 'interview' : 'interviews'}
                  </strong>{' '}
                  and permanently deletes{' '}
                  <strong>
                    {usage.submissionCount}{' '}
                    {usage.submissionCount === 1 ? 'submission' : 'submissions'}
                  </strong>{' '}
                  along with its test cases.
                </p>
                {interviewCount > 0 ? (
                  <p>
                    Affected {interviewCount === 1 ? 'interview' : 'interviews'}:{' '}
                    {usage.interviews.map((interview) => interview.title).join(', ')}.
                  </p>
                ) : null}
                {usage.submissionCount > 0 ? (
                  <p className="text-destructive">
                    Candidate answers already scored against this question will be gone. Archive the
                    interview instead if you only want to retire the question.
                  </p>
                ) : null}
              </>
            }
            confirmLabel="Delete question"
            triggerLabel="Delete"
            triggerIcon={<Trash2 className="size-3.5" aria-hidden />}
            triggerVariant="outline"
          />
        }
      />

      <QuestionEditor
        initial={{
          id: question.id,
          title: question.title,
          description: question.description,
          difficulty: question.difficulty,
          supportedLanguages: question.supportedLanguages,
          starterCode: question.starterCode,
          timeLimitMs: question.timeLimitMs,
          memoryLimitMb: question.memoryLimitMb,
          testCases: question.testCases.map((test) => ({
            id: test.id,
            input: test.input,
            expectedOutput: test.expectedOutput,
            description: test.description,
            weight: test.weight,
          })),
        }}
      />
    </>
  );
}
