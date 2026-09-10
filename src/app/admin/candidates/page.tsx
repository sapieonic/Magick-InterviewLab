import type { Metadata } from 'next';
import Link from 'next/link';
import { UserPlus, Users } from 'lucide-react';
import { listCandidates } from '@/features/candidates/queries';
import { PageHeader } from '@/components/admin/page-header';
import { ActiveBadge } from '@/components/admin/badges';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

export const metadata: Metadata = { title: 'Candidates' };

export default async function CandidatesPage() {
  const candidates = await listCandidates();

  return (
    <>
      <PageHeader
        title="Candidates"
        description={`${candidates.length} ${candidates.length === 1 ? 'candidate' : 'candidates'}`}
        actions={
          <Button asChild size="sm">
            <Link href="/admin/candidates/new">
              <UserPlus className="size-3.5" aria-hidden />
              New candidate
            </Link>
          </Button>
        }
      />

      {candidates.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No candidates yet"
          description="Create a candidate and hand them a temporary password to get started."
          action={
            <Button asChild size="sm">
              <Link href="/admin/candidates/new">New candidate</Link>
            </Button>
          }
        />
      ) : (
        <div className="bg-card overflow-hidden rounded-lg border shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Interviews</TableHead>
                <TableHead>Last login</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((candidate) => (
                <TableRow key={candidate.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/candidates/${candidate.id}`}
                      className="hover:text-primary transition-colors"
                    >
                      {candidate.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{candidate.email}</TableCell>
                  <TableCell>
                    <ActiveBadge isActive={candidate.isActive} />
                  </TableCell>
                  <TableCell>
                    {candidate.interviews.length === 0 ? (
                      <span className="text-muted-foreground text-[13px]">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {candidate.interviews.slice(0, 2).map((interview) => (
                          <Badge key={interview.id} variant="secondary">
                            {interview.title}
                          </Badge>
                        ))}
                        {candidate.interviews.length > 2 ? (
                          <Badge variant="outline">+{candidate.interviews.length - 2}</Badge>
                        ) : null}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-[13px] whitespace-nowrap">
                    {formatDate(candidate.lastLoginAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-[13px] whitespace-nowrap">
                    {formatDate(candidate.createdAt)}
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
