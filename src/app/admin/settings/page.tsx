import type { Metadata } from 'next';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { requireStaffPage } from '@/features/auth/guards';
import { can, roleLabel, STAFF_ROLES } from '@/features/auth/capabilities';
import { MIN_PASSWORD_LENGTH } from '@/features/auth/password-policy';
import {
  addStageTemplateAction,
  createJobRoleAction,
  createPipelineTemplateAction,
  listJobRoles,
  listPipelineTemplates,
  moveStageTemplateAction,
  removeStageTemplateAction,
  updateJobRoleAction,
  updatePipelineTemplateAction,
} from '@/features/pipeline/templates';
import { listPublishedRubrics } from '@/features/rubrics/queries';
import { listStaff, type StaffRow } from '@/features/staff/queries';
import {
  createStaffAction,
  setStaffActiveAction,
  setUserRoleAction,
} from '@/features/staff/actions';
import { PageHeader, Section } from '@/components/admin/page-header';
import {
  ActiveBadge,
  RoleBadge,
  StageTypeBadge,
  STAGE_TYPE_LABELS,
} from '@/components/admin/badges';
import { ActionForm, HiddenFields } from '@/components/admin/action-form';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { SubmitButton } from '@/components/admin/form';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/utils';
import type { StageType } from '@/generated/prisma/enums';

export const metadata: Metadata = { title: 'Settings' };

const STAGE_TYPES = Object.keys(STAGE_TYPE_LABELS) as StageType[];

/**
 * Where the shapes live: the requisitions a candidate is measured against, the
 * pipelines those requisitions default to, and the people who run them.
 *
 * Each section is gated on its own capability and simply is not rendered
 * otherwise — a recruiter opening this page sees nothing they cannot use
 * rather than a wall of disabled controls.
 *
 * The page guard is deliberately the weaker one. Both sections here need a
 * capability only an admin holds, so raising the page to match would be
 * defensible — but nothing is *loaded* without the capability that reads it
 * (every query above is behind its own `? :`), so the choice is purely about
 * what a staff member who follows a stale link is told. A short page saying
 * which is the case beats a silent bounce to `/admin` that looks like the link
 * is broken. The nav already hides this link from anyone without
 * `MANAGE_CONTENT`, so nobody arrives here by accident, and the empty state
 * below is what the exception exists for rather than dead code.
 *
 * Every form here is a plain POST through `ActionForm`. There is no client
 * state to hold: these are small, low-frequency edits, and a toast on the way
 * back is the whole of the feedback they need.
 */
export default async function SettingsPage() {
  const viewer = await requireStaffPage();
  const manageContent = can(viewer.role, 'MANAGE_CONTENT');
  const manageUsers = can(viewer.role, 'MANAGE_USERS');

  const [jobRoles, templates, rubrics, staff] = await Promise.all([
    manageContent ? listJobRoles() : Promise.resolve([]),
    manageContent ? listPipelineTemplates() : Promise.resolve([]),
    manageContent ? listPublishedRubrics() : Promise.resolve([]),
    manageUsers ? listStaff() : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Job roles, pipeline templates and the people who run them."
      />

      {!manageContent && !manageUsers ? (
        <EmptyState
          title="Nothing here for your role"
          description="Job roles and pipelines are managed by admins; ask one if something needs changing."
        />
      ) : null}

      <div className="space-y-5">
        {manageContent ? (
          <>
            <Section
              title="Job roles"
              description="A requisition a candidate is evaluated against. The pipeline set here becomes the default for new applications."
            >
              {jobRoles.length === 0 ? (
                <p className="text-muted-foreground mb-4 text-[13px]">
                  No job roles yet. An application can run without one, but naming the requisition
                  is what makes &ldquo;Backend L4&rdquo; mean the same rounds every time.
                </p>
              ) : (
                <ul className="mb-5 space-y-2">
                  {jobRoles.map((role) => (
                    <li key={role.id} className="rounded-md border px-3 py-2">
                      <ActionForm
                        action={updateJobRoleAction}
                        success="Job role updated."
                        className="space-y-2"
                      >
                        <input type="hidden" name="id" value={role.id} />
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            name="title"
                            defaultValue={role.title}
                            aria-label="Job title"
                            required
                            className="h-8 min-w-40 flex-1 text-[13px]"
                          />
                          <Input
                            name="level"
                            defaultValue={role.level}
                            aria-label="Level"
                            placeholder="Level"
                            className="h-8 w-28 text-[13px]"
                          />
                          <Select
                            name="pipelineTemplateId"
                            aria-label="Default pipeline"
                            defaultValue={role.pipelineTemplate?.id ?? ''}
                            className="h-8 w-44 text-[13px]"
                          >
                            <option value="">No default pipeline</option>
                            {templates.map((template) => (
                              <option key={template.id} value={template.id}>
                                {template.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <input type="hidden" name="description" value={role.description} readOnly />
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="flex items-center gap-2">
                            <Checkbox
                              id={`role-active-${role.id}`}
                              name="isActive"
                              value="true"
                              defaultChecked={role.isActive}
                            />
                            <Label
                              htmlFor={`role-active-${role.id}`}
                              className="cursor-pointer text-[12px] font-normal"
                            >
                              Open for applications
                            </Label>
                          </span>
                          <span className="text-muted-foreground text-[12px] tabular-nums">
                            {role.applicationCount}{' '}
                            {role.applicationCount === 1 ? 'application' : 'applications'}
                          </span>
                          <ActiveBadge isActive={role.isActive} />
                          <SubmitButton size="xs" variant="outline" className="ml-auto">
                            Save
                          </SubmitButton>
                        </div>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              )}

              <ActionForm
                action={createJobRoleAction}
                success="Job role created."
                className="flex flex-wrap items-end gap-2 border-t pt-4"
              >
                <div className="min-w-40 flex-1 space-y-1.5">
                  <Label htmlFor="new-role-title">New job role</Label>
                  <Input id="new-role-title" name="title" placeholder="Backend Engineer" required />
                </div>
                <div className="w-28 space-y-1.5">
                  <Label htmlFor="new-role-level">Level</Label>
                  <Input id="new-role-level" name="level" placeholder="L4" />
                </div>
                <div className="min-w-44 flex-1 space-y-1.5">
                  <Label htmlFor="new-role-template">Default pipeline</Label>
                  <Select id="new-role-template" name="pipelineTemplateId" defaultValue="">
                    <option value="">None</option>
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <input type="hidden" name="isActive" value="true" />
                <SubmitButton size="sm">
                  <Plus className="size-3.5" aria-hidden />
                  Add role
                </SubmitButton>
              </ActionForm>
            </Section>

            <Section
              title="Pipeline templates"
              description="The rounds a process is made of. A template names a rubric; the version is frozen onto each round when an application is created."
            >
              {templates.length === 0 ? (
                <p className="text-muted-foreground mb-4 text-[13px]">
                  No templates yet. Create one below, then add its rounds in order.
                </p>
              ) : (
                <ul className="mb-5 space-y-4">
                  {templates.map((template) => (
                    <li key={template.id} className="rounded-md border">
                      {/* Editable rather than a label: a template that cannot be
                          renamed or retired is one that lives forever in every
                          picker, and `listActiveTemplateOptions` filters on
                          exactly the flag this checkbox writes. */}
                      <ActionForm
                        action={updatePipelineTemplateAction}
                        success="Template updated."
                        className="space-y-2 border-b px-3 py-2"
                      >
                        <input type="hidden" name="id" value={template.id} />
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            name="name"
                            defaultValue={template.name}
                            aria-label={`Name of ${template.name}`}
                            required
                            className="h-8 min-w-40 flex-1 text-[13px]"
                          />
                          <ActiveBadge isActive={template.isActive} />
                          <span className="text-muted-foreground text-[12px] tabular-nums">
                            {template.stages.length}{' '}
                            {template.stages.length === 1 ? 'round' : 'rounds'}
                          </span>
                        </div>
                        <Input
                          name="description"
                          defaultValue={template.description}
                          aria-label={`Description of ${template.name}`}
                          placeholder="What this loop is for (optional)"
                          className="h-8 text-[13px]"
                        />
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="flex items-center gap-2">
                            <Checkbox
                              id={`template-active-${template.id}`}
                              name="isActive"
                              value="true"
                              defaultChecked={template.isActive}
                            />
                            <Label
                              htmlFor={`template-active-${template.id}`}
                              className="cursor-pointer text-[12px] font-normal"
                            >
                              Offered for new applications
                            </Label>
                          </span>
                          <SubmitButton size="xs" variant="outline" className="ml-auto">
                            Save
                          </SubmitButton>
                        </div>
                      </ActionForm>

                      <ol className="divide-border divide-y">
                        {template.stages.map((stage, index) => (
                          <li
                            key={stage.id}
                            className="flex flex-wrap items-center gap-2 px-3 py-1.5"
                          >
                            <span className="text-muted-foreground w-5 shrink-0 text-[12px] tabular-nums">
                              {index + 1}.
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[13px]">
                              {stage.name}
                            </span>
                            <StageTypeBadge type={stage.type} />
                            <span className="text-muted-foreground text-[12px]">
                              {stage.rubric ? stage.rubric.name : 'No rubric'}
                            </span>
                            <span className="flex shrink-0 items-center gap-0.5">
                              <ActionForm action={moveStageTemplateAction}>
                                <HiddenFields fields={{ id: stage.id, direction: 'up' }} />
                                <SubmitButton
                                  size="icon-sm"
                                  variant="ghost"
                                  disabled={index === 0}
                                  aria-label={`Move ${stage.name} up`}
                                  title="Move up"
                                >
                                  <ArrowUp className="size-3.5" aria-hidden />
                                </SubmitButton>
                              </ActionForm>
                              <ActionForm action={moveStageTemplateAction}>
                                <HiddenFields fields={{ id: stage.id, direction: 'down' }} />
                                <SubmitButton
                                  size="icon-sm"
                                  variant="ghost"
                                  disabled={index === template.stages.length - 1}
                                  aria-label={`Move ${stage.name} down`}
                                  title="Move down"
                                >
                                  <ArrowDown className="size-3.5" aria-hidden />
                                </SubmitButton>
                              </ActionForm>
                              <ActionForm
                                action={removeStageTemplateAction}
                                success="Round removed from the template."
                              >
                                <HiddenFields fields={{ id: stage.id }} />
                                <SubmitButton
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={`Remove ${stage.name}`}
                                  title="Remove"
                                >
                                  <X className="size-3.5" aria-hidden />
                                </SubmitButton>
                              </ActionForm>
                            </span>
                          </li>
                        ))}
                      </ol>

                      <ActionForm
                        action={addStageTemplateAction}
                        success="Round added to the template."
                        className="flex flex-wrap items-end gap-2 border-t px-3 py-2"
                      >
                        <input type="hidden" name="templateId" value={template.id} />
                        <Input
                          name="name"
                          placeholder="Round name"
                          aria-label={`Round name for ${template.name}`}
                          required
                          className="h-8 min-w-36 flex-1 text-[13px]"
                        />
                        <Select
                          name="type"
                          aria-label="Round type"
                          defaultValue="LIVE_CODING"
                          className="h-8 w-40 text-[13px]"
                        >
                          {STAGE_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {STAGE_TYPE_LABELS[type]}
                            </option>
                          ))}
                        </Select>
                        <Select
                          name="rubricId"
                          aria-label="Rubric"
                          defaultValue=""
                          className="h-8 w-40 text-[13px]"
                        >
                          <option value="">No rubric</option>
                          {rubrics.map((rubric) => (
                            <option key={rubric.id} value={rubric.id}>
                              {rubric.name}
                            </option>
                          ))}
                        </Select>
                        <input type="hidden" name="isRequired" value="true" />
                        <SubmitButton size="sm" variant="outline">
                          Add round
                        </SubmitButton>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              )}

              <ActionForm
                action={createPipelineTemplateAction}
                success="Template created."
                className="space-y-2 border-t pt-4"
              >
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-44 flex-1 space-y-1.5">
                    <Label htmlFor="new-template-name">New pipeline template</Label>
                    <Input
                      id="new-template-name"
                      name="name"
                      placeholder="Backend hiring loop"
                      required
                    />
                  </div>
                  <input type="hidden" name="isActive" value="true" />
                  <SubmitButton size="sm">
                    <Plus className="size-3.5" aria-hidden />
                    Add template
                  </SubmitButton>
                </div>
                <Textarea
                  name="description"
                  rows={2}
                  placeholder="What this loop is for (optional)"
                  aria-label="Template description"
                />
              </ActionForm>
            </Section>
          </>
        ) : null}

        {manageUsers ? (
          <Section
            title="Staff accounts"
            description="Everyone who can reach this console. A role decides what they may do; a panel seat decides whose scorecard they may write."
          >
            <div className="mb-5 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-[13px]">
                <thead className="text-muted-foreground text-left text-[12px]">
                  <tr className="border-b">
                    <th className="py-1.5 pr-3 font-medium">Name</th>
                    <th className="py-1.5 pr-3 font-medium">Role</th>
                    <th className="py-1.5 pr-3 font-medium">Owns</th>
                    <th className="py-1.5 pr-3 font-medium">Last login</th>
                    <th className="py-1.5 pr-3 font-medium">Account</th>
                    <th className="py-1.5 font-medium">Change role</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((person) => (
                    <tr key={person.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        <span className="block truncate font-medium">{person.name}</span>
                        <span className="text-muted-foreground block truncate text-[12px]">
                          {person.email}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <RoleBadge role={person.role} />
                      </td>
                      <td className="text-muted-foreground py-2 pr-3 tabular-nums">
                        {person.ownedApplicationCount} app
                        {person.ownedApplicationCount === 1 ? '' : 's'} · {person.panelSeatCount}{' '}
                        panel
                      </td>
                      <td className="text-muted-foreground py-2 pr-3 whitespace-nowrap">
                        {formatDate(person.lastLoginAt)}
                      </td>
                      <td className="py-2 pr-3">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <ActiveBadge isActive={person.isActive} />
                          {person.mustChangePassword ? (
                            <span className="text-muted-foreground text-[12px]">
                              Temporary password
                            </span>
                          ) : null}
                          {person.id === viewer.id ? null : <StaffStatusControl person={person} />}
                        </span>
                      </td>
                      <td className="py-2">
                        {person.id === viewer.id ? (
                          // Not a disabled control with no explanation: this is
                          // the rule that stops an admin removing the only
                          // capability that could put it back.
                          <span className="text-muted-foreground text-[12px]">
                            Your own account
                          </span>
                        ) : (
                          <ActionForm
                            action={setUserRoleAction}
                            success="Role updated and sessions signed out."
                            className="flex items-center gap-1.5"
                          >
                            <input type="hidden" name="id" value={person.id} />
                            <Select
                              name="role"
                              aria-label={`Role for ${person.name}`}
                              defaultValue={person.role}
                              className="h-8 w-36 text-[13px]"
                            >
                              {STAFF_ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {roleLabel(role)}
                                </option>
                              ))}
                            </Select>
                            <SubmitButton size="xs" variant="outline">
                              Set
                            </SubmitButton>
                          </ActionForm>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ActionForm
              action={createStaffAction}
              success="Staff account created."
              className="space-y-3 border-t pt-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="staff-name">Name</Label>
                  <Input id="staff-name" name="name" autoComplete="off" required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="staff-email">Email</Label>
                  <Input id="staff-email" name="email" type="email" autoComplete="off" required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="staff-role">Role</Label>
                  <Select id="staff-role" name="role" defaultValue="INTERVIEWER">
                    {STAFF_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {roleLabel(role)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="staff-password">Temporary password</Label>
                  <Input
                    id="staff-password"
                    name="temporaryPassword"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    required
                  />
                  <p className="text-muted-foreground text-[12px]">
                    At least {MIN_PASSWORD_LENGTH} characters with a letter and a digit. Hand it
                    over yourself — it is never emailed and never shown again, and they must replace
                    it at first sign-in.
                  </p>
                </div>
              </div>
              <SubmitButton size="sm">
                <Plus className="size-3.5" aria-hidden />
                Create staff account
              </SubmitButton>
            </ActionForm>
          </Section>
        ) : null}
      </div>
    </>
  );
}

/**
 * Deactivate or reactivate a colleague's account.
 *
 * The staff half of the flow candidates have had all along: `listStaff` reports
 * what each person owns precisely so an admin can see what a deactivation would
 * strand before doing it. Never rendered for your own row — `setStaffActiveAction`
 * refuses that anyway, for the same lockout reason as a self-demotion.
 */
function StaffStatusControl({ person }: { person: StaffRow }) {
  if (!person.isActive) {
    return (
      <ActionForm action={setStaffActiveAction} success="Account reactivated.">
        <HiddenFields fields={{ id: person.id, isActive: 'true' }} />
        <SubmitButton size="xs" variant="outline">
          Reactivate
        </SubmitButton>
      </ActionForm>
    );
  }

  return (
    <ConfirmAction
      action={setStaffActiveAction}
      fields={{ id: person.id, isActive: 'false' }}
      title={`Deactivate ${person.name}?`}
      description={
        <>
          <p>
            They are signed out immediately and cannot sign in again until someone reactivates them.
          </p>
          <p>
            {person.ownedApplicationCount === 0
              ? 'They own no applications.'
              : `They still own ${person.ownedApplicationCount} application${
                  person.ownedApplicationCount === 1 ? '' : 's'
                } — reassign the owner first, or nobody is accountable for moving them along.`}{' '}
            {person.panelSeatCount === 0
              ? 'They sit on no panels.'
              : `They sit on ${person.panelSeatCount} panel${
                  person.panelSeatCount === 1 ? '' : 's'
                }, and a seat nobody can sign in to fill is a scorecard that never arrives.`}
          </p>
        </>
      }
      confirmLabel="Deactivate"
      triggerLabel="Deactivate"
      triggerSize="xs"
      success="Account deactivated and signed out."
    />
  );
}
