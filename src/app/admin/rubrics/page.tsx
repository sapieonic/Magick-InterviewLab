import type { Metadata } from 'next';
import Link from 'next/link';
import { Ruler } from 'lucide-react';
import { requireCapabilityPage } from '@/features/auth/guards';
import { listRubrics } from '@/features/rubrics/queries';
import { PageHeader, Section } from '@/components/admin/page-header';
import { NewRubricForm } from '@/components/admin/rubric-editor';
import { ActiveBadge } from '@/components/admin/badges';
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

export const metadata: Metadata = { title: 'Rubrics' };

export default async function RubricsPage() {
  await requireCapabilityPage('MANAGE_CONTENT');
  const rubrics = await listRubrics();

  return (
    <>
      <PageHeader
        title="Rubrics"
        description={`${rubrics.length} ${rubrics.length === 1 ? 'rubric' : 'rubrics'}`}
      />

      {/*
        Create sits on the list page rather than behind a /new route: a rubric
        is two fields, and the useful screen is the editor the create redirects
        into. The grid collapses to one column below lg, so the form lands
        under the table on a narrow window instead of squeezing it.
      */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          {rubrics.length === 0 ? (
            <EmptyState
              icon={Ruler}
              title="No rubrics yet"
              description="A rubric is the scoring instrument a panel writes against. Its criteria live on a version, so publishing one freezes what a scorecard means."
            />
          ) : (
            <div className="bg-card overflow-hidden rounded-lg border shadow-xs">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Versions</TableHead>
                    <TableHead>Latest</TableHead>
                    <TableHead>In use</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rubrics.map((rubric) => (
                    <TableRow key={rubric.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/admin/rubrics/${rubric.id}`}
                          className="hover:text-primary transition-colors"
                        >
                          {rubric.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <ActiveBadge isActive={rubric.isActive} />
                          {/* The one thing an author needs to spot from the
                              list: where the editable version is. */}
                          {rubric.hasOpenDraft ? <Badge variant="warning">Draft open</Badge> : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-[13px] tabular-nums">
                        {rubric.versionCount}
                      </TableCell>
                      <TableCell className="text-[13px] whitespace-nowrap tabular-nums">
                        {rubric.latestVersion === null ? (
                          <span className="text-muted-foreground">&mdash;</span>
                        ) : (
                          `v${rubric.latestVersion}`
                        )}
                      </TableCell>
                      <TableCell className="text-[13px] tabular-nums">
                        {rubric.stageUsageCount === 0 ? (
                          <span className="text-muted-foreground">&mdash;</span>
                        ) : (
                          `${rubric.stageUsageCount} ${rubric.stageUsageCount === 1 ? 'round' : 'rounds'}`
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-[13px] whitespace-nowrap">
                        {formatDate(rubric.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <aside>
          <Section title="New rubric" description="Starts as version 1, unpublished.">
            <NewRubricForm />
          </Section>
        </aside>
      </div>
    </>
  );
}
