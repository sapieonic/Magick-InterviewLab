import type { Metadata } from 'next';
import Link from 'next/link';
import { ClipboardList, Plus } from 'lucide-react';
import { listInterviews } from '@/features/interviews/queries';
import { PageHeader } from '@/components/admin/page-header';
import { InterviewStatusBadge } from '@/components/admin/badges';
import { Button } from '@/components/ui/button';
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

export const metadata: Metadata = { title: 'Interviews' };

export default async function InterviewsPage() {
  const interviews = await listInterviews();

  return (
    <>
      <PageHeader
        title="Interviews"
        description={`${interviews.length} ${interviews.length === 1 ? 'interview' : 'interviews'}`}
        actions={
          <Button asChild size="sm">
            <Link href="/admin/interviews/new">
              <Plus className="size-3.5" aria-hidden />
              New interview
            </Link>
          </Button>
        }
      />

      {interviews.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No interviews yet"
          description="An interview is an ordered set of questions you assign to candidates."
          action={
            <Button asChild size="sm">
              <Link href="/admin/interviews/new">New interview</Link>
            </Button>
          }
        />
      ) : (
        <div className="bg-card overflow-hidden rounded-lg border shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Questions</TableHead>
                <TableHead>Candidates</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {interviews.map((interview) => (
                <TableRow key={interview.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/interviews/${interview.id}`}
                      className="hover:text-primary transition-colors"
                    >
                      {interview.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <InterviewStatusBadge status={interview.status} />
                  </TableCell>
                  <TableCell className="text-[13px] tabular-nums">
                    {interview.questionCount}
                  </TableCell>
                  <TableCell className="text-[13px] tabular-nums">
                    {interview.candidateCount}
                  </TableCell>
                  <TableCell className="text-[13px] whitespace-nowrap">
                    {interview.durationMinutes === null ? (
                      <span className="text-muted-foreground">Untimed</span>
                    ) : (
                      `${interview.durationMinutes} min`
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-[13px] whitespace-nowrap">
                    {formatDate(interview.updatedAt)}
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
