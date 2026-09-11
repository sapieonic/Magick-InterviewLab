import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Archive, ArchiveRestore, CheckCircle2, FilePlus2, Ruler } from 'lucide-react';
import { requireCapabilityPage } from '@/features/auth/guards';
import { getRubric, type RubricVersionRow } from '@/features/rubrics/queries';
import {
  archiveRubricAction,
  createRubricVersionAction,
  publishRubricVersionAction,
  unarchiveRubricAction,
} from '@/features/rubrics/actions';
import { PageHeader, Section } from '@/components/admin/page-header';
import {
  RubricCriteriaEditor,
  RubricProfileForm,
  ScalePreview,
} from '@/components/admin/rubric-editor';
import { ActiveBadge } from '@/components/admin/badges';
import { ActionForm } from '@/components/admin/action-form';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { SubmitButton } from '@/components/admin/form';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  await requireCapabilityPage('MANAGE_CONTENT');
  const { id } = await params;
  const rubric = await getRubric(id);
  return { title: rubric ? rubric.name : 'Rubric' };
}

/** Mirrors the editor's live preview so a published version reads identically. */
function totalWeightOf(version: RubricVersionRow): number {
  return version.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
}

function sharePercent(weight: number, totalWeight: number): string {
  if (totalWeight <= 0) return '—';
  return `${Math.round((weight / totalWeight) * 100)}%`;
}

/**
 * A frozen version, rendered read-only. There is no edit affordance here on
 * purpose: the criteria of a published version are what the scorecards already
 * written against them mean, so the only way forward is a new draft.
 */
function PublishedCriteria({ version }: { version: RubricVersionRow }) {
  const total = totalWeightOf(version);

  if (version.criteria.length === 0) {
    return <p className="text-muted-foreground text-[13px]">No criteria.</p>;
  }

  return (
    <ul className="divide-border -my-2 divide-y">
      {version.criteria.map((criterion) => (
        <li key={criterion.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-[13px] font-medium">{criterion.name}</p>
            {criterion.description ? (
              <p className="text-muted-foreground text-[12px]">{criterion.description}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <ScalePreview
              maxScore={criterion.maxScore}
              label={`${criterion.name} scale: 1 to ${criterion.maxScore}`}
            />
            <span className="text-muted-foreground w-12 text-right text-[12px] tabular-nums">
              {sharePercent(criterion.weight, total)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function RubricDetailPage({ params }: PageProps) {
  await requireCapabilityPage('MANAGE_CONTENT');
  const { id } = await params;
  const rubric = await getRubric(id);
  if (!rubric) notFound();

  const draft = rubric.draftVersion;
  const stageUsageCount = rubric.versions.reduce((sum, version) => sum + version.usageCount, 0);
  const feedbackCount = rubric.versions.reduce((sum, version) => sum + version.feedbackCount, 0);
  const publishedCount = rubric.versions.filter((version) => version.isPublished).length;

  return (
    <>
      <PageHeader
        title={rubric.name}
        backHref="/admin/rubrics"
        backLabel="Rubrics"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ActiveBadge isActive={rubric.isActive} />
            <span>
              {rubric.versions.length} {rubric.versions.length === 1 ? 'version' : 'versions'}
            </span>
            <span>
              {publishedCount} published
              {draft ? `, v${draft.version} in draft` : ''}
            </span>
            <span>
              Pinned by {stageUsageCount} {stageUsageCount === 1 ? 'round' : 'rounds'}
            </span>
            <span>Created {formatDate(rubric.createdAt)}</span>
          </span>
        }
        actions={
          <>
            {draft ? null : (
              <ActionForm action={createRubricVersionAction} success="New draft version opened.">
                <input type="hidden" name="rubricId" value={rubric.id} />
                <SubmitButton size="sm" variant="outline">
                  <FilePlus2 className="size-3.5" aria-hidden />
                  New draft version
                </SubmitButton>
              </ActionForm>
            )}
            {/*
              Archive and restore swap places rather than one of them sitting
              here greyed out: archiving is a filing decision, and the way back
              has to be where the way out was, not a checkbox in the sidebar.
            */}
            {rubric.isActive ? (
              <ConfirmAction
                action={archiveRubricAction}
                fields={{ id: rubric.id }}
                title="Archive this rubric?"
                description={
                  <>
                    <p>
                      It drops out of the pickers for new rounds. Nothing already scored changes:
                      every published version stays readable, and the{' '}
                      <strong>
                        {stageUsageCount} {stageUsageCount === 1 ? 'round' : 'rounds'}
                      </strong>{' '}
                      pinned to one keep it.
                    </p>
                    <p>
                      Rubrics are never deleted. A delete would cascade through the versions and
                      their criteria to every score entered against them, leaving the scorecards as
                      prose with the numbers gone.
                    </p>
                    <p>Restore puts it back in the pickers whenever you want it again.</p>
                  </>
                }
                confirmLabel="Archive"
                triggerLabel="Archive"
                triggerIcon={<Archive className="size-3.5" aria-hidden />}
                success="Rubric archived."
              />
            ) : (
              <ActionForm action={unarchiveRubricAction} success="Rubric restored.">
                <input type="hidden" name="id" value={rubric.id} />
                <SubmitButton size="sm" variant="outline">
                  <ArchiveRestore className="size-3.5" aria-hidden />
                  Restore
                </SubmitButton>
              </ActionForm>
            )}
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          {draft ? (
            <Section
              title={`Draft — version ${draft.version}`}
              description="Editable until you publish it. Publishing is final."
              actions={
                <ConfirmAction
                  action={publishRubricVersionAction}
                  fields={{ versionId: draft.id }}
                  title={`Publish version ${draft.version}?`}
                  description={
                    <>
                      <p>
                        Publishing freezes these {draft.criteria.length}{' '}
                        {draft.criteria.length === 1 ? 'criterion' : 'criteria'} and makes the
                        version eligible to be pinned to a round.
                      </p>
                      <p className="text-destructive">
                        This cannot be undone. A published version can never be edited or
                        unpublished &mdash; scorecards written against it have to keep meaning what
                        they said. To change the rubric afterwards, open a new draft version, which
                        starts as a copy of this one.
                      </p>
                    </>
                  }
                  confirmLabel="Publish version"
                  triggerLabel="Publish"
                  triggerIcon={<CheckCircle2 className="size-3.5" aria-hidden />}
                  confirmVariant="default"
                  // A version with no criteria is refused by the action too;
                  // disabling here just saves the round trip.
                  disabled={draft.criteria.length === 0}
                  success="Version published."
                />
              }
            >
              <RubricCriteriaEditor
                draft={{
                  versionId: draft.id,
                  version: draft.version,
                  notes: draft.notes,
                  criteria: draft.criteria.map((criterion) => ({
                    id: criterion.id,
                    name: criterion.name,
                    description: criterion.description,
                    weight: criterion.weight,
                    maxScore: criterion.maxScore,
                  })),
                }}
              />
            </Section>
          ) : (
            <Section title="No open draft" description="Every version of this rubric is frozen.">
              <EmptyState
                icon={Ruler}
                title="Nothing to edit"
                description="Changing a rubric means adding a version. A new draft starts as a copy of the latest one, so you edit the wording you expect and the published rows stay exactly as scored."
                className="border-none py-6"
                action={
                  <ActionForm
                    action={createRubricVersionAction}
                    success="New draft version opened."
                  >
                    <input type="hidden" name="rubricId" value={rubric.id} />
                    <SubmitButton size="sm">
                      <FilePlus2 className="size-3.5" aria-hidden />
                      New draft version
                    </SubmitButton>
                  </ActionForm>
                }
              />
            </Section>
          )}

          <Section
            title="Version history"
            description="Newest first. A round pins one of these, and the scorecards on it report that version."
          >
            {rubric.versions.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">No versions yet.</p>
            ) : (
              <ol className="space-y-3">
                {rubric.versions.map((version) => (
                  <li key={version.id} className="rounded-md border">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium">Version {version.version}</span>
                        {version.isPublished ? (
                          <Badge variant="success">Published</Badge>
                        ) : (
                          <Badge variant="warning">Draft</Badge>
                        )}
                        <span className="text-muted-foreground text-[12px]">
                          {version.isPublished
                            ? `Published ${formatDate(version.publishedAt)}`
                            : `Started ${formatDate(version.createdAt)}`}
                          {version.createdBy ? ` · ${version.createdBy.name}` : ''}
                        </span>
                      </span>
                      <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 text-[12px] tabular-nums">
                        <span>
                          {version.usageCount} {version.usageCount === 1 ? 'round' : 'rounds'}
                        </span>
                        <span>
                          {version.feedbackCount}{' '}
                          {version.feedbackCount === 1 ? 'scorecard' : 'scorecards'}
                        </span>
                      </span>
                    </div>

                    <div className="space-y-2 px-3 py-3">
                      {version.notes ? (
                        <p className="text-muted-foreground text-[12px]">{version.notes}</p>
                      ) : null}

                      {version.isPublished ? (
                        <PublishedCriteria version={version} />
                      ) : (
                        /* The draft's criteria are already on this page, in the
                           editor above. Rendering them a second time would only
                           invite an author to wonder which copy is the real one. */
                        <p className="text-muted-foreground text-[13px]">
                          {version.criteria.length}{' '}
                          {version.criteria.length === 1 ? 'criterion' : 'criteria'}, edited in the
                          draft above.
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>

        <aside className="space-y-5">
          <Section title="Details">
            <RubricProfileForm
              rubric={{
                id: rubric.id,
                name: rubric.name,
                description: rubric.description,
                isActive: rubric.isActive,
              }}
            />
          </Section>

          <Section title="At a glance">
            <dl className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Published versions</dt>
                <dd className="tabular-nums">{publishedCount}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Open draft</dt>
                <dd>{draft ? `v${draft.version}` : 'None'}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Rounds pinned</dt>
                <dd className="tabular-nums">{stageUsageCount}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Scorecards written</dt>
                <dd className="tabular-nums">{feedbackCount}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Stage templates</dt>
                <dd className="tabular-nums">{rubric.stageTemplateCount}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Updated</dt>
                <dd>{formatDate(rubric.updatedAt)}</dd>
              </div>
            </dl>
          </Section>
        </aside>
      </div>
    </>
  );
}
