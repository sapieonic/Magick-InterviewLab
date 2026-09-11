import type { Role } from '@/generated/prisma/enums';

/**
 * What each role may do, as pure data.
 *
 * Authorization used to be one equality check — `role !== 'ADMIN'` — because
 * there were only two roles. With a panel, a recruiter and a hiring manager in
 * the picture, scattering that check is how a system ends up letting an
 * interviewer archive an interview. So every permission question is asked of
 * this table instead, and the guards in `guards.ts` are thin wrappers over it.
 *
 * This module is deliberately free of `server-only`, Prisma and `next` imports:
 * it is a lookup table, it is exhaustively unit-tested, and the client needs
 * the same answers to decide what to render.
 *
 * **A capability is necessary, never sufficient.** `GIVE_FEEDBACK` says the
 * role is allowed to write scorecards at all; it does not say this person is
 * on *this* panel. Object-level checks live next to the queries that can see
 * the row.
 */
export const CAPABILITIES = [
  /** Reach the hiring console at all. */
  'ACCESS_CONSOLE',
  /** Create and edit accounts, reset passwords, deactivate. */
  'MANAGE_USERS',
  /** Author questions, interviews and rubrics. */
  'MANAGE_CONTENT',
  /** Create applications, add and schedule stages, set the panel, advance. */
  'MANAGE_PIPELINE',
  /** Read every application, not just the ones you sit on. */
  'VIEW_ALL_APPLICATIONS',
  /** Write a scorecard — subject to being on the stage's panel. */
  'GIVE_FEEDBACK',
  /** Record the hire / no-hire. */
  'DECIDE',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The grant table. Read it as the specification — if a question about who may
 * do what is not answered here, it is not answered anywhere.
 *
 * `RECRUITER` deliberately lacks `DECIDE`: moving a candidate along and
 * choosing to hire them are different accountabilities, and collapsing them is
 * how a pipeline stops having a debrief. `INTERVIEWER` deliberately lacks
 * `VIEW_ALL_APPLICATIONS`: a panellist sees the candidates they are on, which
 * is both least-privilege and a smaller surface for gossip.
 */
const GRANTS: Record<Role, readonly Capability[]> = {
  ADMIN: [
    'ACCESS_CONSOLE',
    'MANAGE_USERS',
    'MANAGE_CONTENT',
    'MANAGE_PIPELINE',
    'VIEW_ALL_APPLICATIONS',
    'GIVE_FEEDBACK',
    'DECIDE',
  ],
  RECRUITER: ['ACCESS_CONSOLE', 'MANAGE_PIPELINE', 'VIEW_ALL_APPLICATIONS', 'GIVE_FEEDBACK'],
  HIRING_MANAGER: [
    'ACCESS_CONSOLE',
    'MANAGE_PIPELINE',
    'VIEW_ALL_APPLICATIONS',
    'GIVE_FEEDBACK',
    'DECIDE',
  ],
  INTERVIEWER: ['ACCESS_CONSOLE', 'GIVE_FEEDBACK'],
  // Not a typo and not an oversight: a candidate has no capability in the
  // hiring console whatsoever. See `isStaff` below.
  CANDIDATE: [],
};

export const STAFF_ROLES = ['ADMIN', 'RECRUITER', 'HIRING_MANAGER', 'INTERVIEWER'] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * The one rule that must never acquire an exception: a candidate is not staff.
 * Every read model that can surface feedback, notes, decisions or another
 * candidate's existence is gated on this.
 */
export function isStaff(role: Role): role is StaffRole {
  return role !== 'CANDIDATE';
}

export function can(role: Role, capability: Capability): boolean {
  return GRANTS[role].includes(capability);
}

export function capabilitiesOf(role: Role): readonly Capability[] {
  return GRANTS[role];
}

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  RECRUITER: 'Recruiter',
  HIRING_MANAGER: 'Hiring manager',
  INTERVIEWER: 'Interviewer',
  CANDIDATE: 'Candidate',
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}
