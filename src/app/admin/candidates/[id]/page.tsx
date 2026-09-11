import type { Metadata } from 'next';
import { requireAdminPage } from '@/features/auth/guards';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ClipboardList, FileCode2, X } from 'lucide-react';
import {
  computeProgress,
  getCandidate,
  listAssignableInterviews,
} from '@/features/candidates/queries';
import { assignInterviewAction, unassignInterviewAction } from '@/features/interviews/actions';
import { PageHeader, Section } from '@/components/admin/page-header';
import {
  ActiveBadge,
  AssignmentStatusBadge,
  InterviewStatusBadge,
  LanguageBadge,
  ScoreBadge,
} from '@/components/admin/badges';
import {
  CandidatePasswordResetForm,
  CandidateProfileForm,
  CandidateStatusForm,
} from '@/components/admin/candidate-forms';
import { ActionForm } from '@/components/admin/action-form';
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
import { formatDate } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  await requireAdminPage();
  const { id } = await params;
  const candidate = await getCandidate(id);
  return { title: candidate ? candidate.name : 'Candidate' };
}

export default async function CandidateDetailPage({ params }: PageProps) {
  await requireAdminPage();
  const { id } = await params;
  const candidate = await getCandidate(id);
  if (!candidate) notFound();

  const allInterviews = await listAssignableInterviews();
  const assignedIds = new Set(candidate.assignments.map((a) => a.interview.id));
  const assignable = allInterviews.filter((interview) => !assignedIds.has(interview.id));
  const progress = computeProgress(candidate.assignments, candidate.submissions);
  const progressByInterview = new Map(progress.map((p) => [p.interviewId, p]));

  return (
    <>
      <PageHeader
        title={candidate.name}
        backHref="/admin/candidates"
        backLabel="Candidates"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{candidate.email}</span>
            <ActiveBadge isActive={candidate.isActive} />
            <span>Last login {formatDate(candidate.lastLoginAt)}</span>
            <span>Added {formatDate(candidate.createdAt)}</span>
          </span>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">
          <Section title="Profile">
            <CandidateProfileForm
              candidate={{ id: candidate.id, name: candidate.name, email: candidate.email }}
            />
          </Section>

          <Section
            title="Interviews"
            description="Assigned interviews and how far this candidate has got."
            actions={
              assignable.length > 0 ? (
                <ActionForm
                  action={assignInterviewAction}
                  success="Interview assigned."
                  className="flex items-center gap-2"
                >
                  <input type="hidden" name="candidateId" value={candidate.id} />
                  <Select
                    name="interviewId"
                    aria-label="Interview to assign"
                    required
                    defaultValue=""
                    className="h-8 w-48 text-[13px]"
                  >
                    <option value="" disabled>
                      Assign interview…
                    </option>
                    {assignable.map((interview) => (
                      <option key={interview.id} value={interview.id}>
                        {interview.title}
                        {interview.status === 'DRAFT' ? ' (draft)' : ''}
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
            {candidate.assignments.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="No interviews assigned"
                description={
                  assignable.length > 0
                    ? 'Pick one from the selector above to assign it.'
                    : 'Create or publish an interview first.'
                }
                className="border-none py-6"
              />
            ) : (
              <ul className="space-y-3">
                {candidate.assignments.map((assignment) => {
                  const stats = progressByInterview.get(assignment.interview.id);
                  return (
                    <li key={assignment.id} className="rounded-md border">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <Link
                            href={`/admin/interviews/${assignment.interview.id}`}
                            className="hover:text-primary truncate text-[13px] font-medium transition-colors"
                          >
                            {assignment.interview.title}
                          </Link>
                          <InterviewStatusBadge status={assignment.interview.status} />
                          <AssignmentStatusBadge status={assignment.status} />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground text-[12px] tabular-nums">
                            {stats ? `${stats.answered}/${stats.total} answered` : '—'}
                          </span>
                          <ActionForm
                            action={unassignInterviewAction}
                            success="Interview unassigned."
                          >
                            <input type="hidden" name="candidateId" value={candidate.id} />
                            <input
                              type="hidden"
                              name="interviewId"
                              value={assignment.interview.id}
                            />
                            <SubmitButton
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Unassign ${assignment.interview.title}`}
                              title="Unassign"
                            >
                              <X className="size-3.5" aria-hidden />
                            </SubmitButton>
                          </ActionForm>
                        </div>
                      </div>

                      {stats && stats.questions.length > 0 ? (
                        <ul className="divide-border divide-y">
                          {stats.questions.map((question) => (
                            <li
                              key={question.questionId}
                              className="flex items-center justify-between gap-3 px-3 py-1.5"
                            >
                              <span className="truncate text-[13px]">{question.title}</span>
                              <span className="flex shrink-0 items-center gap-2">
                                <span className="text-muted-foreground text-[12px] tabular-nums">
                                  {question.attempts === 0
                                    ? 'Not attempted'
                                    : `${question.attempts} ${question.attempts === 1 ? 'attempt' : 'attempts'}`}
                                </span>
                                {question.bestScore === null ? null : (
                                  <ScoreBadge score={question.bestScore} />
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-muted-foreground px-3 py-2 text-[12px]">
                          This interview has no questions yet.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            title="Submissions"
            description={`${candidate.submissions.length} in total, newest first.`}
          >
            {candidate.submissions.length === 0 ? (
              <EmptyState
                icon={FileCode2}
                title="Nothing submitted yet"
                className="border-none py-6"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Question</TableHead>
                    <TableHead>Interview</TableHead>
                    <TableHead>Language</TableHead>
                    <TableHead>Tests</TableHead>
                    <TableHead>Score</TableHead>
                    <TableHead>Submitted</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {candidate.submissions.map((submission) => (
                    <TableRow key={submission.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/admin/submissions/${submission.id}`}
                          className="hover:text-primary transition-colors"
                        >
                          {submission.question.title}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-[13px]">
                        {submission.interview.title}
                      </TableCell>
                      <TableCell>
                        <LanguageBadge language={submission.language} />
                      </TableCell>
                      <TableCell className="text-[13px] tabular-nums">
                        {submission.passedCount}/{submission.totalCount}
                      </TableCell>
                      <TableCell>
                        <ScoreBadge score={submission.score} />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-[13px] whitespace-nowrap">
                        {formatDate(submission.submittedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        </div>

        <aside className="space-y-5">
          <Section title="Access">
            <dl className="mb-4 space-y-2 text-[13px]">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  <ActiveBadge isActive={candidate.isActive} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Password</dt>
                <dd className="text-right">
                  {candidate.mustChangePassword
                    ? 'Temporary — change required'
                    : 'Chosen by candidate'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Last login</dt>
                <dd className="text-right">{formatDate(candidate.lastLoginAt)}</dd>
              </div>
            </dl>
            <CandidateStatusForm candidateId={candidate.id} isActive={candidate.isActive} />
          </Section>

          <Section
            title="Reset password"
            description="Sets a new temporary password and signs the candidate out everywhere."
          >
            <CandidatePasswordResetForm candidateId={candidate.id} />
          </Section>

          <Section title="Review">
            <Button asChild size="sm" variant="outline" className="w-full">
              <Link href={`/admin/submissions?candidateId=${candidate.id}`}>
                View all submissions
              </Link>
            </Button>
          </Section>
        </aside>
      </div>
    </>
  );
}
