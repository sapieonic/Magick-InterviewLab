import type { Metadata } from 'next';
import Link from 'next/link';
import { Activity, FileCode2, LogIn, UserCheck, Users } from 'lucide-react';
import { getDashboardStats, getRecentActivity } from '@/features/dashboard/queries';
import { PageHeader, Section } from '@/components/admin/page-header';
import { ScoreBadge } from '@/components/admin/badges';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';

export const metadata: Metadata = { title: 'Dashboard' };

function StatTile({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: number;
  hint?: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="bg-card hover:border-primary/40 group rounded-lg border px-4 py-3.5 shadow-xs transition-colors"
    >
      <p className="text-muted-foreground text-[12px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint ? <p className="text-muted-foreground mt-0.5 text-[12px]">{hint}</p> : null}
    </Link>
  );
}

export default async function AdminDashboardPage() {
  const [stats, activity] = await Promise.all([getDashboardStats(), getRecentActivity(10)]);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Everything happening across InterviewLab right now."
        actions={
          <>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/questions/new">New question</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/admin/candidates/new">New candidate</Link>
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Candidates" value={stats.totalCandidates} href="/admin/candidates" />
        <StatTile
          label="Active"
          value={stats.activeCandidates}
          hint={`${stats.totalCandidates - stats.activeCandidates} deactivated`}
          href="/admin/candidates"
        />
        <StatTile
          label="Interviews"
          value={stats.interviews}
          hint={`${stats.publishedInterviews} published`}
          href="/admin/interviews"
        />
        <StatTile label="Questions" value={stats.questions} href="/admin/questions" />
      </div>

      <Section
        title="Recent activity"
        description="Candidate sign-ins and submissions, most recent first."
      >
        {activity.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No activity yet"
            description="Once a candidate signs in or submits an answer it will show up here."
            className="border-none py-8"
          />
        ) : (
          <ul className="divide-border -my-1 divide-y">
            {activity.map((item) => (
              <li key={item.key} className="flex items-start gap-3 py-2.5">
                <span className="text-muted-foreground mt-0.5 shrink-0" aria-hidden>
                  {item.kind === 'login' ? (
                    <LogIn className="size-4" />
                  ) : (
                    <FileCode2 className="size-4" />
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px]">
                    <Link
                      href={`/admin/candidates/${item.candidate.id}`}
                      className="hover:text-primary font-medium transition-colors"
                    >
                      {item.candidate.name}
                    </Link>{' '}
                    {item.kind === 'login' ? (
                      <span className="text-muted-foreground">signed in</span>
                    ) : (
                      <span className="text-muted-foreground">
                        submitted{' '}
                        <Link
                          href={`/admin/submissions/${item.submissionId}`}
                          className="text-foreground hover:text-primary font-medium transition-colors"
                        >
                          {item.questionTitle}
                        </Link>{' '}
                        in {item.interviewTitle}
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground text-[12px]">{formatDate(item.at)}</p>
                </div>

                {item.kind === 'submission' ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-muted-foreground hidden text-[12px] tabular-nums sm:inline">
                      {item.passedCount}/{item.totalCount} tests
                    </span>
                    <ScoreBadge score={item.score} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="text-muted-foreground mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <span className="inline-flex items-center gap-1.5">
          <Users className="size-3.5" aria-hidden /> Manage candidates and their assignments
        </span>
        <span className="inline-flex items-center gap-1.5">
          <UserCheck className="size-3.5" aria-hidden /> Review submissions test by test
        </span>
      </div>
    </>
  );
}
