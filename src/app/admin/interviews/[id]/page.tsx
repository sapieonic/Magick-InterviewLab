import type { Metadata } from 'next';
import { requireCapabilityPage } from '@/features/auth/guards';
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
  ScoreBadge,
} from '@/components/admin/badges';
import { ActionForm } from '@/components/admin/action-form';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { SubmitButton } from '@/components/admin/form';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate, formatDuration } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  await requireCapabilityPage('MANAGE_CONTENT');
  const { id } = await params;
  const interview = await getInterview(id);
  return { title: interview ? interview.title : 'Interview' };
}

export default async function InterviewDetailPage({ params }: PageProps) {
  await requireCapabilityPage('MANAGE_CONTENT');
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

          {/*
            The cohort, and how it went. This is the one screen that holds
            everyone who sat a given assessment, and until now it held their
            names and nothing else — the performance was a click away on each
            candidate, which meant nobody ever compared a question against the
            people who answered it.

            It sits in the main column rather than the sidebar because it is now
            a table: six columns do not fit a 22rem aside, and truncating a
            candidate's result to make it fit is how a screen starts lying.
          */}
          <Section
            title="Assigned candidates"
            description="Everyone who can sit this interview, and how their sitting went."
            actions={
              availableCandidates.length > 0 ? (
                <ActionForm
                  action={assignInterviewAction}
                  success="Candidate assigned."
                  className="flex items-center gap-2"
                >
                  <input type="hidden" name="interviewId" value={interview.id} />
                  <Select
                    name="candidateId"
                    aria-label="Candidate to assign"
                    required
                    defaultValue=""
                    className="h-8 w-56 text-[13px]"
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
              ) : null
            }
          >
            {interview.candidates.length === 0 ? (
              <EmptyState
                icon={Users}
                title="Nobody assigned"
                description="Assign a candidate to let them sit this interview."
                className="border-none py-6"
              />
            ) : (
              <Table className="min-w-[46rem]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Candidate</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Tests</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Elapsed</TableHead>
                    <TableHead>Completed</TableHead>
                    <TableHead>
                      <span className="sr-only">Unassign</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {interview.candidates.map((row) => (
                    <TableRow key={row.assignmentId}>
                      <TableCell className="max-w-[16rem]">
                        <Link
                          href={`/admin/candidates/${row.candidate.id}`}
                          className="hover:text-primary block truncate text-[13px] font-medium transition-colors"
                        >
                          {row.candidate.name}
                        </Link>
                        <span className="text-muted-foreground block truncate text-[12px]">
                          {row.candidate.email}
                        </span>
                      </TableCell>

                      <TableCell className="whitespace-nowrap">
                        <span className="flex items-center gap-1.5">
                          <AssignmentStatusBadge status={row.status} />
                          {row.candidate.isActive ? null : <ActiveBadge isActive={false} />}
                        </span>
                      </TableCell>

                      {/* No score for somebody who has not answered anything.
                          A rendered 0% is not an empty cell being tidy, it is
                          a claim about a person who never sat the thing. */}
                      <TableCell>
                        {row.rollUp.score === null ? (
                          <span className="text-muted-foreground text-[13px]">—</span>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <span className="text-[13px] tabular-nums">
                              {row.rollUp.passedCount}/{row.rollUp.totalCount}
                            </span>
                            <ScoreBadge score={row.rollUp.score} />
                          </span>
                        )}
                      </TableCell>

                      <TableCell className="text-[13px] whitespace-nowrap tabular-nums">
                        {row.rollUp.attempts === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            {row.rollUp.attempts} · {row.rollUp.questionsAnswered}q
                          </>
                        )}
                      </TableCell>

                      {/* Elapsed is a plain fact and stays one: no colour, no
                          threshold, no comparison with the row above. Fast is
                          not good, and a duration styled as a comparator is an
                          accommodation problem rather than a weak metric —
                          extra time is an adjustment people are entitled to and
                          it lands in exactly this number. */}
                      <TableCell className="text-[13px] whitespace-nowrap tabular-nums">
                        <span title="Wall clock between the candidate first opening the assessment and answering the last question. Breaks are included.">
                          {row.elapsedMs === null
                            ? row.startedAt
                              ? 'in progress'
                              : '—'
                            : formatDuration(row.elapsedMs)}
                        </span>
                      </TableCell>

                      <TableCell className="text-muted-foreground text-[13px] whitespace-nowrap">
                        {formatDate(row.completedAt)}
                      </TableCell>

                      <TableCell className="text-right">
                        <ActionForm
                          action={unassignInterviewAction}
                          success="Candidate unassigned."
                        >
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
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        </div>

        <aside className="space-y-5">
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
