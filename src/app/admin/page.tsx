import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Activity,
  ClipboardList,
  FileCode2,
  Gavel,
  MessageSquare,
  ScrollText,
  StickyNote,
  UserPlus,
  Users,
} from 'lucide-react';
import { requireStaffPage } from '@/features/auth/guards';
import { can } from '@/features/auth/capabilities';
import {
  getDashboardTiles,
  getPipelineActivity,
  type DashboardTile,
  type PipelineActivityItem,
} from '@/features/dashboard/queries';
import type { ActivityIcon, ActivityTone } from '@/features/dashboard/activity';
import { PageHeader, Section } from '@/components/admin/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Dashboard' };

function StatTile({ tile }: { tile: DashboardTile }) {
  return (
    <Link
      href={tile.href}
      className={cn(
        'bg-card group rounded-lg border px-4 py-3.5 shadow-xs transition-colors',
        // Only a non-zero urgent count earns the accent. A zero styled as a
        // warning teaches people to ignore the colour.
        tile.urgent ? 'border-warning/40 hover:border-warning' : 'hover:border-primary/40',
      )}
    >
      <p className="text-muted-foreground text-[12px] font-medium tracking-wide uppercase">
        {tile.label}
      </p>
      <p
        className={cn(
          'mt-1.5 text-2xl font-semibold tracking-tight tabular-nums',
          tile.urgent && 'text-warning',
        )}
      >
        {tile.value}
      </p>
      {tile.hint ? <p className="text-muted-foreground mt-0.5 text-[12px]">{tile.hint}</p> : null}
    </Link>
  );
}

const ACTIVITY_ICONS: Record<ActivityIcon, typeof Activity> = {
  application: UserPlus,
  stage: ClipboardList,
  panel: Users,
  feedback: FileCode2,
  decision: Gavel,
  note: StickyNote,
  comment: MessageSquare,
  rubric: ScrollText,
};

const TONE_CLASS: Record<ActivityTone, string> = {
  neutral: 'text-muted-foreground',
  positive: 'text-success',
  negative: 'text-destructive',
  attention: 'text-warning',
};

function ActivityRow({ item }: { item: PipelineActivityItem }) {
  const Icon = ACTIVITY_ICONS[item.icon];

  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className={cn('mt-0.5 shrink-0', TONE_CLASS[item.tone])} aria-hidden>
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[13px]">
          <span className="font-medium">{item.actorName}</span>{' '}
          <span className="text-muted-foreground">{item.verb}</span>
          {item.candidateName ? (
            <>
              <span className="text-muted-foreground"> for </span>
              {item.applicationId ? (
                <Link
                  href={`/admin/applications/${item.applicationId}`}
                  className="hover:text-primary font-medium transition-colors"
                >
                  {item.candidateName}
                </Link>
              ) : (
                <span className="font-medium">{item.candidateName}</span>
              )}
            </>
          ) : null}
        </p>
        <p className="text-muted-foreground text-[12px]">{formatDate(item.at)}</p>
      </div>
    </li>
  );
}

export default async function AdminDashboardPage() {
  const viewer = await requireStaffPage();
  const [tiles, activity] = await Promise.all([
    getDashboardTiles(viewer),
    getPipelineActivity(viewer, 12),
  ]);

  const canManagePipeline = can(viewer.role, 'MANAGE_PIPELINE');
  const canManageUsers = can(viewer.role, 'MANAGE_USERS');

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="What needs you, and what has moved since you were last here."
        actions={
          <>
            {canManageUsers ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/candidates/new">New candidate</Link>
              </Button>
            ) : null}
            {canManagePipeline ? (
              <Button asChild size="sm">
                <Link href="/admin/pipeline">Open pipeline</Link>
              </Button>
            ) : null}
          </>
        }
      />

      {tiles.length > 0 ? (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((tile) => (
            <StatTile key={tile.key} tile={tile} />
          ))}
        </div>
      ) : null}

      <Section
        title="Recent activity"
        description="Round moves, scorecards and decisions across the candidates you can see."
      >
        {activity.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="Nothing has happened yet"
            description="Once an application moves, a scorecard lands or a decision is recorded, it shows up here."
            className="border-none py-8"
          />
        ) : (
          <ul className="divide-border -my-1 divide-y">
            {activity.map((item) => (
              <ActivityRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
