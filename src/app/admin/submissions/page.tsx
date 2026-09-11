import type { Metadata } from 'next';
import { requireAdminPage } from '@/features/auth/guards';
import Link from 'next/link';
import { FileCode2, Filter } from 'lucide-react';
import { listSubmissionFilterOptions, listSubmissions } from './queries';
import { PageHeader } from '@/components/admin/page-header';
import { LanguageBadge, ScoreBadge } from '@/components/admin/badges';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
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

export const metadata: Metadata = { title: 'Submissions' };

const LIMIT = 200;

/** A query param is only a filter if it is a non-empty single value. */
function readParam(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export default async function SubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();
  const params = await searchParams;
  const candidateId = readParam(params['candidateId']);
  const interviewId = readParam(params['interviewId']);

  const [submissions, options] = await Promise.all([
    listSubmissions({ candidateId, interviewId }, LIMIT),
    listSubmissionFilterOptions(),
  ]);

  const filtered = Boolean(candidateId || interviewId);

  return (
    <>
      <PageHeader
        title="Submissions"
        description={
          submissions.length === LIMIT
            ? `Showing the ${LIMIT} most recent. Narrow the filter to see older ones.`
            : `${submissions.length} ${submissions.length === 1 ? 'submission' : 'submissions'}`
        }
      />

      {/* A plain GET form: the filter lives in the URL, so it survives a
          reload and can be linked to from a candidate or interview page. */}
      <form
        method="get"
        className="bg-card mb-5 flex flex-wrap items-end gap-3 rounded-lg border px-4 py-3 shadow-xs"
      >
        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="candidateId">Candidate</Label>
          <Select id="candidateId" name="candidateId" defaultValue={candidateId ?? ''}>
            <option value="">All candidates</option>
            {options.candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} · {candidate.email}
              </option>
            ))}
          </Select>
        </div>

        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="interviewId">Interview</Label>
          <Select id="interviewId" name="interviewId" defaultValue={interviewId ?? ''}>
            <option value="">All interviews</option>
            {options.interviews.map((interview) => (
              <option key={interview.id} value={interview.id}>
                {interview.title}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex gap-2">
          <Button type="submit" size="sm" variant="outline">
            <Filter className="size-3.5" aria-hidden />
            Apply
          </Button>
          {filtered ? (
            <Button asChild size="sm" variant="ghost">
              <Link href="/admin/submissions">Clear</Link>
            </Button>
          ) : null}
        </div>
      </form>

      {submissions.length === 0 ? (
        <EmptyState
          icon={FileCode2}
          title={filtered ? 'No submissions match that filter' : 'No submissions yet'}
          description={
            filtered
              ? 'Try clearing the filter.'
              : 'Answers appear here as soon as candidates submit them.'
          }
          action={
            filtered ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/submissions">Clear filter</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="bg-card overflow-hidden rounded-lg border shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Candidate</TableHead>
                <TableHead>Interview</TableHead>
                <TableHead>Question</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>Tests</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submissions.map((submission) => (
                <TableRow key={submission.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/submissions/${submission.id}`}
                      className="hover:text-primary transition-colors"
                    >
                      {submission.candidate.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-[13px]">
                    {submission.interview.title}
                  </TableCell>
                  <TableCell className="text-[13px]">{submission.question.title}</TableCell>
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
        </div>
      )}
    </>
  );
}
