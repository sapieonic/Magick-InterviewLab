import type { Metadata } from 'next';
import { requireAdminPage } from '@/features/auth/guards';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Archive, Users, X } from 'lucide-react';
import {
  getInterview,
  listCandidateOptions,
  listQuestionOptions,
} from '@/features/interviews/queries';
import {
  addInterviewQuestionAction,
  archiveInterviewAction,
  assignInterviewAction,
  unassignInterviewAction,
} from '@/features/interviews/actions';
import { PageHeader, Section } from '@/components/admin/page-header';
import { InterviewForm } from '@/components/admin/interview-form';
import { InterviewQuestions } from '@/components/admin/interview-questions';
import {
  ActiveBadge,
  AssignmentStatusBadge,
  InterviewStatusBadge,
} from '@/components/admin/badges';
import { ActionForm } from '@/components/admin/action-form';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { SubmitButton } from '@/components/admin/form';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  await requireAdminPage();
  const { id } = await params;
  const interview = await getInterview(id);
  return { title: interview ? interview.title : 'Interview' };
}

export default async function InterviewDetailPage({ params }: PageProps) {
  await requireAdminPage();
  const { id } = await params;
  const interview = await getInterview(id);
  if (!interview) notFound();

  const [availableQuestions, availableCandidates] = await Promise.all([
    listQuestionOptions(interview.questions.map((q) => q.question.id)),
    listCandidateOptions(interview.candidates.map((c) => c.candidate.id)),
  ]);

  return (
    <>
      <PageHeader
        title={interview.title}
        backHref="/admin/interviews"
        backLabel="Interviews"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <InterviewStatusBadge status={interview.status} />
            <span>
              {interview.questions.length}{' '}
              {interview.questions.length === 1 ? 'question' : 'questions'}
            </span>
            <span>
              {interview.candidates.length}{' '}
              {interview.candidates.length === 1 ? 'candidate' : 'candidates'}
            </span>
            <span>
              {interview.durationMinutes === null
                ? 'Untimed'
                : `${interview.durationMinutes} minutes`}
            </span>
            <span>Updated {formatDate(interview.updatedAt)}</span>
          </span>
        }
        actions={
          <>
            <Button asChild size="sm" variant="outline">
              <Link href={`/admin/submissions?interviewId=${interview.id}`}>Submissions</Link>
            </Button>
            <ConfirmAction
              action={archiveInterviewAction}
              fields={{ id: interview.id }}
              title="Archive this interview?"
              description={
                <>
                  <p>
                    Archived interviews stay readable and keep their submissions, but candidates can
                    no longer sit them and the interview drops out of the assignment pickers.
                  </p>
                  <p>You can publish it again from the form on this page.</p>
                </>
              }
              confirmLabel="Archive"
              triggerLabel="Archive"
              triggerIcon={<Archive className="size-3.5" aria-hidden />}
              disabled={interview.status === 'ARCHIVED'}
              success="Interview archived."
            />
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <Section title="Details">
            <InterviewForm
              interview={{
                id: interview.id,
                title: interview.title,
                description: interview.description,
                status: interview.status,
                durationMinutes: interview.durationMinutes,
                allowMultipleSubmissions: interview.allowMultipleSubmissions,
              }}
            />
          </Section>

          <Section
            title="Questions"
            description="Candidates work through them in this order."
            actions={
              availableQuestions.length > 0 ? (
                <ActionForm
                  action={addInterviewQuestionAction}
                  success="Question added."
                  className="flex items-center gap-2"
                >
                  <input type="hidden" name="interviewId" value={interview.id} />
                  <Select
                    name="questionId"
                    aria-label="Question to add"
                    required
                    defaultValue=""
                    className="h-8 w-56 text-[13px]"
                  >
                    <option value="" disabled>
                      Add question…
                    </option>
                    {availableQuestions.map((question) => (
                      <option key={question.id} value={question.id}>
                        {question.title} · {question.testCount} tests
                      </option>
                    ))}
                  </Select>
                  <SubmitButton size="sm" variant="outline">
                    Add
                  </SubmitButton>
                </ActionForm>
              ) : (
                <Button asChild size="sm" variant="outline">
                  <Link href="/admin/questions/new">New question</Link>
                </Button>
              )
            }
          >
            <InterviewQuestions
              interviewId={interview.id}
              questions={interview.questions.map((row) => ({
                id: row.question.id,
                title: row.question.title,
                difficulty: row.question.difficulty,
                testCount: row.question.testCount,
              }))}
            />
          </Section>
        </div>

        <aside className="space-y-5">
          <Section
            title="Assigned candidates"
            description="Only assigned candidates can see this interview."
          >
            {availableCandidates.length > 0 ? (
              <ActionForm
                action={assignInterviewAction}
                success="Candidate assigned."
                className="mb-4 flex items-center gap-2"
              >
                <input type="hidden" name="interviewId" value={interview.id} />
                <Select
                  name="candidateId"
                  aria-label="Candidate to assign"
                  required
                  defaultValue=""
                  className="h-8 text-[13px]"
                >
                  <option value="" disabled>
                    Assign candidate…
                  </option>
                  {availableCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name} · {candidate.email}
                    </option>
                  ))}
                </Select>
                <SubmitButton size="sm" variant="outline">
                  Assign
                </SubmitButton>
              </ActionForm>
            ) : null}

            {interview.candidates.length === 0 ? (
              <EmptyState
                icon={Users}
                title="Nobody assigned"
                description="Assign a candidate to let them sit this interview."
                className="border-none py-6"
              />
            ) : (
              <ul className="divide-border -my-2 divide-y">
                {interview.candidates.map((row) => (
                  <li key={row.assignmentId} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/admin/candidates/${row.candidate.id}`}
                        className="hover:text-primary block truncate text-[13px] font-medium transition-colors"
                      >
                        {row.candidate.name}
                      </Link>
                      <p className="text-muted-foreground truncate text-[12px]">
                        {row.candidate.email}
                      </p>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {row.candidate.isActive ? null : <ActiveBadge isActive={false} />}
                      <AssignmentStatusBadge status={row.status} />
                      <ActionForm action={unassignInterviewAction} success="Candidate unassigned.">
                        <input type="hidden" name="interviewId" value={interview.id} />
                        <input type="hidden" name="candidateId" value={row.candidate.id} />
                        <SubmitButton
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Unassign ${row.candidate.name}`}
                          title="Unassign"
                        >
                          <X className="size-3.5" aria-hidden />
                        </SubmitButton>
                      </ActionForm>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="At a glance">
            <dl className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Submissions</dt>
                <dd className="tabular-nums">{interview.submissionCount}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Retries</dt>
                <dd>{interview.allowMultipleSubmissions ? 'Allowed' : 'One attempt'}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Created</dt>
                <dd>{formatDate(interview.createdAt)}</dd>
              </div>
            </dl>
          </Section>
        </aside>
      </div>
    </>
  );
}
