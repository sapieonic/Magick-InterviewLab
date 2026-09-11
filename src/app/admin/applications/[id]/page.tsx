import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ClipboardList, MessageSquare } from 'lucide-react';
import { requireStaffPage } from '@/features/auth/guards';
import { can } from '@/features/auth/capabilities';
import { getApplication, getApplicationTimeline } from '@/features/pipeline/queries';
import { listActiveJobRoleOptions, listActiveTemplateOptions } from '@/features/pipeline/templates';
import { listApplicationOwners, listStaffForPanel } from '@/features/staff/queries';
import { listPublishedRubrics } from '@/features/rubrics/queries';
import { listAssignableInterviews } from '@/features/candidates/queries';
import { PageHeader, Section } from '@/components/admin/page-header';
import {
  ApplicationStatusBadge,
  DecisionBadge,
  RoleBadge,
  StageStatusBadge,
} from '@/components/admin/badges';
import {
  ApplicationCommentForm,
  ApplicationDetailsForm,
  ApplicationStatusForm,
  ApplyTemplateForm,
} from '@/components/admin/application-forms';
import { AddStageForm, StageList } from '@/components/admin/stage-forms';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const viewer = await requireStaffPage();
  const { id } = await params;
  const application = await getApplication(viewer, id);
  return { title: application ? `${application.candidate.name} — application` : 'Application' };
}

/**
 * Audit actions, in the words a person would use.
 *
 * Unknown actions fall back to the raw string rather than being hidden: this
 * is the record other people are going to be held to, and an event nobody
 * wrote a label for is still an event that happened.
 */
const EVENT_LABELS: Record<string, string> = {
  'application.created': 'Application created',
  'application.status_changed': 'Status changed',
  'application.owner_changed': 'Owner changed',
  'stage.created': 'Round added',
  'stage.updated': 'Round updated',
  'stage.status_changed': 'Round status changed',
  'stage.outcome_recorded': 'Round outcome recorded',
  'stage.deleted': 'Round removed',
  'panel.added': 'Panellist added',
  'panel.removed': 'Panellist removed',
  'feedback.saved': 'Scorecard saved',
  'feedback.submitted': 'Scorecard submitted',
  'feedback.revised': 'Scorecard revised',
  'decision.recorded': 'Decision recorded',
  'decision.changed': 'Decision changed',
  'note.added': 'Note added on a submission',
  'note.deleted': 'Note removed from a submission',
  'comment.added': 'Note added',
};

/** A one-line gloss built from whichever metadata keys an event carries. Kept
 *  deliberately shallow: the audit payload is untyped JSON, and guessing at a
 *  deep shape is how a timeline starts throwing. */
function eventDetail(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const meta = metadata as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof meta['from'] === 'string' && typeof meta['to'] === 'string') {
    parts.push(`${meta['from']} → ${meta['to']}`);
  }
  if (typeof meta['stageName'] === 'string') parts.push(meta['stageName']);
  if (typeof meta['name'] === 'string') parts.push(meta['name']);
  if (typeof meta['outcome'] === 'string') parts.push(meta['outcome']);
  if (typeof meta['templateName'] === 'string') parts.push(meta['templateName']);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export default async function ApplicationDetailPage({ params }: PageProps) {
  const viewer = await requireStaffPage();
  const { id } = await params;

  // `null` covers both "no such application" and "not yours to see", so the
  // 404 never confirms the existence of a candidate the viewer is not on.
  const application = await getApplication(viewer, id);
  if (!application) notFound();

  const editable = can(viewer.role, 'MANAGE_PIPELINE');
  // `/admin/submissions` needs this and bounces anyone else to `/admin`, so it
  // decides whether the cross-link is offered at all — see the candidate link
  // at the foot of this page for the same pattern.
  const canReviewSubmissions = can(viewer.role, 'VIEW_ALL_APPLICATIONS');
  const canReadDebrief = can(viewer.role, 'VIEW_ALL_APPLICATIONS');

  const [timeline, staff, owners, jobRoles, templates, rubrics, interviews] = await Promise.all([
    getApplicationTimeline(viewer, application.id),
    // Behind `editable` like every other picker's data: `StageList` is a client
    // component, so anything passed to it is serialised into the flight payload
    // whether or not a picker renders — and `StaffOption` carries an email
    // address. An interviewer with one seat on one application could read the
    // whole staff directory in View Source.
    editable ? listStaffForPanel() : Promise.resolve([]),
    editable ? listApplicationOwners() : Promise.resolve([]),
    editable ? listActiveJobRoleOptions() : Promise.resolve([]),
    editable ? listActiveTemplateOptions() : Promise.resolve([]),
    editable ? listPublishedRubrics() : Promise.resolve([]),
    editable ? listAssignableInterviews() : Promise.resolve([]),
  ]);

  const roleLine = application.jobRole
    ? application.jobRole.level
      ? `${application.jobRole.title} · ${application.jobRole.level}`
      : application.jobRole.title
    : 'No job role';

  return (
    <>
      <PageHeader
        title={application.candidate.name}
        backHref="/admin/pipeline"
        backLabel="Pipeline"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{application.candidate.email}</span>
            <span>{roleLine}</span>
            <ApplicationStatusBadge status={application.status} />
            {application.decision ? <DecisionBadge outcome={application.decision.outcome} /> : null}
            <span>
              {application.owner ? `Owned by ${application.owner.name}` : 'No owner assigned'}
            </span>
          </span>
        }
        actions={
          // The debrief is gated on VIEW_ALL_APPLICATIONS: someone who sat one
          // round does not read the whole process. An interviewer reaches *this*
          // page through a panel seat, so the link has to be gated too, or it is
          // a button that silently bounces them back to /admin.
          canReadDebrief ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/admin/applications/${application.id}/scorecard`}>Scorecard</Link>
            </Button>
          ) : null
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">
          <Section
            title="Rounds"
            description={`${application.stagesComplete} of ${application.stagesTotal} complete${
              application.outstandingScorecards > 0
                ? ` · ${application.outstandingScorecards} scorecards outstanding`
                : ''
            }`}
          >
            {editable && application.stages.length === 0 ? (
              <div className="mb-4">
                <ApplyTemplateForm applicationId={application.id} templates={templates} />
              </div>
            ) : null}

            <StageList
              applicationId={application.id}
              stages={application.stages}
              staff={staff}
              interviews={interviews}
              editable={editable}
              canReviewSubmissions={canReviewSubmissions}
              viewerId={viewer.id}
            />
          </Section>

          {editable ? (
            <Section
              title="Add a round"
              description="Appended to the end. Reorder with the arrows above."
            >
              <AddStageForm
                applicationId={application.id}
                rubrics={rubrics}
                interviews={interviews}
              />
            </Section>
          ) : null}

          <Section
            title="Notes"
            description="Coordination chatter — scheduling, availability, context. Not part of the scorecard."
          >
            {application.comments.length === 0 ? (
              <EmptyState
                icon={MessageSquare}
                title="No notes yet"
                className="mb-4 border-none py-6"
              />
            ) : (
              <ul className="mb-4 space-y-3">
                {application.comments.map((comment) => (
                  <li key={comment.id} className="rounded-md border px-3 py-2">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium">{comment.author.name}</span>
                      <RoleBadge role={comment.author.role} />
                      <span className="text-muted-foreground text-[12px]">
                        {formatDate(comment.createdAt)}
                      </span>
                    </div>
                    <p className="text-[13px] whitespace-pre-wrap">{comment.body}</p>
                  </li>
                ))}
              </ul>
            )}

            <ApplicationCommentForm applicationId={application.id} />
          </Section>

          <Section
            title="Activity"
            description="Everything that moved this application, newest first."
          >
            {timeline.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="Nothing recorded yet"
                className="border-none py-6"
              />
            ) : (
              <ul className="space-y-2">
                {timeline.map((event) => {
                  const detail = eventDetail(event.metadata);
                  return (
                    <li
                      key={event.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b pb-2 last:border-0 last:pb-0"
                    >
                      <span className="min-w-0 text-[13px]">
                        {EVENT_LABELS[event.action] ?? event.action}
                        {detail ? <span className="text-muted-foreground"> — {detail}</span> : null}
                      </span>
                      <span className="text-muted-foreground text-[12px] whitespace-nowrap">
                        {event.actor ? event.actor.name : 'System'} · {formatDate(event.createdAt)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </div>

        <aside className="space-y-5">
          <Section title="Status">
            <dl className="mb-4 space-y-2 text-[13px]">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Current round</dt>
                <dd className="text-right">
                  {application.currentStage ? (
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      <span className="truncate">{application.currentStage.name}</span>
                      <StageStatusBadge status={application.currentStage.status} />
                    </span>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Days in round</dt>
                <dd className="tabular-nums">{application.daysInStage ?? '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Opened</dt>
                <dd>{formatDate(application.createdAt)}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Closed</dt>
                <dd>{formatDate(application.closedAt)}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Pipeline</dt>
                <dd className="text-right">{application.pipelineTemplate?.name ?? '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Source</dt>
                <dd className="text-right">{application.source || '—'}</dd>
              </div>
            </dl>

            {editable ? (
              <ApplicationStatusForm applicationId={application.id} status={application.status} />
            ) : null}
          </Section>

          {editable ? (
            <Section title="Details">
              <ApplicationDetailsForm
                application={{
                  id: application.id,
                  jobRoleId: application.jobRole?.id ?? null,
                  ownerId: application.owner?.id ?? null,
                  source: application.source,
                }}
                jobRoles={jobRoles}
                owners={owners}
              />
            </Section>
          ) : null}

          <Section
            title="Decision"
            description="The hire or no-hire, with the aggregate signal behind it."
          >
            {application.decision ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <DecisionBadge outcome={application.decision.outcome} />
                  <span className="text-muted-foreground text-[12px]">
                    {application.decision.decidedBy?.name ?? 'Unknown'} ·{' '}
                    {formatDate(application.decision.decidedAt)}
                  </span>
                </div>
                <p className="text-[13px] whitespace-pre-wrap">{application.decision.rationale}</p>
              </div>
            ) : (
              <p className="text-muted-foreground mb-3 text-[13px]">
                Not decided. Nothing on this page decides it — a person records the call, with a
                written reason, on the scorecard.
              </p>
            )}
            {canReadDebrief ? (
              <Button asChild size="sm" variant="outline" className="mt-3 w-full">
                <Link href={`/admin/applications/${application.id}/scorecard`}>Open scorecard</Link>
              </Button>
            ) : null}
          </Section>

          {/* The candidate record is admin-only, so the link is shown only to
              someone it would not bounce straight back to /admin. */}
          {can(viewer.role, 'MANAGE_USERS') ? (
            <Section title="Candidate">
              <Button asChild size="sm" variant="outline" className="w-full">
                <Link href={`/admin/candidates/${application.candidate.id}`}>
                  Open candidate record
                </Link>
              </Button>
            </Section>
          ) : null}
        </aside>
      </div>
    </>
  );
}
