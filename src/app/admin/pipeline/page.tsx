import type { Metadata } from 'next';
import Link from 'next/link';
import { Filter, KanbanSquare } from 'lucide-react';
import { requireStaffPage } from '@/features/auth/guards';
import { can } from '@/features/auth/capabilities';
import {
  listApplications,
  listAssignableCandidates,
  listPipelineFilterOptions,
} from '@/features/pipeline/queries';
import { listActiveJobRoleOptions, listActiveTemplateOptions } from '@/features/pipeline/templates';
import { listApplicationOwners } from '@/features/staff/queries';
import { PageHeader } from '@/components/admin/page-header';
import { PipelineBoard } from '@/components/admin/pipeline-board';
import { ApplicationCreateForm } from '@/components/admin/application-forms';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import type { ApplicationStatus } from '@/generated/prisma/enums';

export const metadata: Metadata = { title: 'Pipeline' };

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  HIRED: 'Hired',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

/** A query param is only a filter if it is a non-empty single value. */
function readParam(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readStatus(value: string | undefined): ApplicationStatus | undefined {
  return value && value in STATUS_LABELS ? (value as ApplicationStatus) : undefined;
}

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Every staff role, including an interviewer: the read model scopes the
  // board to what they may see rather than the page turning them away.
  const viewer = await requireStaffPage();
  const params = await searchParams;
  const status = readStatus(readParam(params['status']));
  const jobRoleId = readParam(params['jobRoleId']);
  const ownerId = readParam(params['ownerId']);

  const managePipeline = can(viewer.role, 'MANAGE_PIPELINE');

  const [applications, options] = await Promise.all([
    listApplications(viewer, { status, jobRoleId, ownerId }),
    listPipelineFilterOptions(viewer),
  ]);

  // Only loaded for someone who may actually start one — four extra queries on
  // every interviewer's board would be paid for nothing.
  const starter = managePipeline
    ? await Promise.all([
        listAssignableCandidates(),
        listActiveJobRoleOptions(),
        listActiveTemplateOptions(),
        listApplicationOwners(),
      ])
    : null;

  const filtered = Boolean(status || jobRoleId || ownerId);
  const waiting = applications.reduce((sum, a) => sum + a.outstandingScorecards, 0);

  return (
    <>
      <PageHeader
        title="Pipeline"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {applications.length} {applications.length === 1 ? 'application' : 'applications'}
            </span>
            {waiting > 0 ? (
              <span className="text-warning font-medium">
                {waiting} {waiting === 1 ? 'scorecard' : 'scorecards'} outstanding
              </span>
            ) : null}
          </span>
        }
      />

      {starter ? (
        <details className="bg-card mb-5 rounded-lg border shadow-xs">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold tracking-tight">
            Start an application
          </summary>
          <div className="border-t px-4 py-4">
            <ApplicationCreateForm
              candidates={starter[0]}
              jobRoles={starter[1]}
              templates={starter[2]}
              owners={starter[3]}
            />
          </div>
        </details>
      ) : null}

      {/* A plain GET form: the filter lives in the URL, so it survives a
          reload and a recruiter can bookmark "my candidates". */}
      <form
        method="get"
        className="bg-card mb-5 flex flex-wrap items-end gap-3 rounded-lg border px-4 py-3 shadow-xs"
      >
        <div className="min-w-40 flex-1 space-y-1.5">
          <Label htmlFor="status">Status</Label>
          <Select id="status" name="status" defaultValue={status ?? ''}>
            <option value="">All statuses</option>
            {options.statuses.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>

        <div className="min-w-44 flex-1 space-y-1.5">
          <Label htmlFor="jobRoleId">Job role</Label>
          <Select id="jobRoleId" name="jobRoleId" defaultValue={jobRoleId ?? ''}>
            <option value="">All roles</option>
            {options.jobRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.level ? `${role.title} · ${role.level}` : role.title}
              </option>
            ))}
          </Select>
        </div>

        <div className="min-w-44 flex-1 space-y-1.5">
          <Label htmlFor="ownerId">Owner</Label>
          <Select id="ownerId" name="ownerId" defaultValue={ownerId ?? ''}>
            <option value="">All owners</option>
            {options.owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
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
              <Link href="/admin/pipeline">Clear</Link>
            </Button>
          ) : null}
        </div>
      </form>

      {applications.length === 0 ? (
        <EmptyState
          icon={KanbanSquare}
          title={filtered ? 'No applications match that filter' : 'Nothing in the pipeline'}
          description={
            filtered
              ? 'Try clearing the filter.'
              : managePipeline
                ? 'Start an application above to put a candidate through a process.'
                : 'Applications you are on a panel for will appear here.'
          }
          action={
            filtered ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/pipeline">Clear filter</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <PipelineBoard applications={applications} />
      )}
    </>
  );
}
