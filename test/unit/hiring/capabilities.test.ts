import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  STAFF_ROLES,
  can,
  capabilitiesOf,
  isStaff,
  roleLabel,
  type Capability,
} from '@/features/auth/capabilities';
import type { Role } from '@/generated/prisma/enums';

const ALL_ROLES: readonly Role[] = [
  'ADMIN',
  'RECRUITER',
  'HIRING_MANAGER',
  'INTERVIEWER',
  'CANDIDATE',
];

/**
 * The grant table is the authorization specification, so it is asserted
 * exhaustively rather than sampled: every (role, capability) pair is named
 * here. A test that only checked the happy path would not notice a role
 * quietly gaining `DECIDE`.
 */
const EXPECTED: Record<Role, Record<Capability, boolean>> = {
  ADMIN: {
    ACCESS_CONSOLE: true,
    MANAGE_USERS: true,
    MANAGE_CONTENT: true,
    MANAGE_PIPELINE: true,
    VIEW_ALL_APPLICATIONS: true,
    GIVE_FEEDBACK: true,
    DECIDE: true,
  },
  RECRUITER: {
    ACCESS_CONSOLE: true,
    MANAGE_USERS: false,
    MANAGE_CONTENT: false,
    MANAGE_PIPELINE: true,
    VIEW_ALL_APPLICATIONS: true,
    GIVE_FEEDBACK: true,
    DECIDE: false,
  },
  HIRING_MANAGER: {
    ACCESS_CONSOLE: true,
    MANAGE_USERS: false,
    MANAGE_CONTENT: false,
    MANAGE_PIPELINE: true,
    VIEW_ALL_APPLICATIONS: true,
    GIVE_FEEDBACK: true,
    DECIDE: true,
  },
  INTERVIEWER: {
    ACCESS_CONSOLE: true,
    MANAGE_USERS: false,
    MANAGE_CONTENT: false,
    MANAGE_PIPELINE: false,
    VIEW_ALL_APPLICATIONS: false,
    GIVE_FEEDBACK: true,
    DECIDE: false,
  },
  CANDIDATE: {
    ACCESS_CONSOLE: false,
    MANAGE_USERS: false,
    MANAGE_CONTENT: false,
    MANAGE_PIPELINE: false,
    VIEW_ALL_APPLICATIONS: false,
    GIVE_FEEDBACK: false,
    DECIDE: false,
  },
};

describe('capability grants', () => {
  for (const role of ALL_ROLES) {
    for (const capability of CAPABILITIES) {
      const expected = EXPECTED[role][capability];
      it(`${role} ${expected ? 'has' : 'does not have'} ${capability}`, () => {
        expect(can(role, capability)).toBe(expected);
      });
    }
  }

  it('covers every capability for every role, with nothing extra', () => {
    for (const role of ALL_ROLES) {
      const granted = [...capabilitiesOf(role)].sort();
      const expected = CAPABILITIES.filter((c) => EXPECTED[role][c]).sort();
      expect(granted).toEqual(expected);
    }
  });
});

describe('the candidate boundary', () => {
  /**
   * The rule the whole hiring console rests on. If this ever passes for
   * CANDIDATE, feedback, notes and decisions become readable by the person
   * they are about.
   */
  it('grants a candidate no capability at all', () => {
    expect(capabilitiesOf('CANDIDATE')).toHaveLength(0);
    for (const capability of CAPABILITIES) {
      expect(can('CANDIDATE', capability)).toBe(false);
    }
  });

  it('treats every non-candidate role as staff', () => {
    for (const role of ALL_ROLES) {
      expect(isStaff(role)).toBe(role !== 'CANDIDATE');
    }
  });

  it('lists exactly the staff roles', () => {
    expect([...STAFF_ROLES].sort()).toEqual(ALL_ROLES.filter(isStaff).sort());
  });
});

describe('separation of duties', () => {
  /**
   * Moving a candidate along and choosing to hire them are different
   * accountabilities. Collapsing them is how a pipeline stops having a
   * debrief, so it gets its own assertion rather than being implied by the
   * table above.
   */
  it('lets a recruiter run the pipeline but not decide', () => {
    expect(can('RECRUITER', 'MANAGE_PIPELINE')).toBe(true);
    expect(can('RECRUITER', 'DECIDE')).toBe(false);
  });

  it('keeps an interviewer scoped to the candidates they sit on', () => {
    expect(can('INTERVIEWER', 'GIVE_FEEDBACK')).toBe(true);
    expect(can('INTERVIEWER', 'VIEW_ALL_APPLICATIONS')).toBe(false);
  });

  it('keeps content authoring with admins', () => {
    for (const role of ALL_ROLES) {
      expect(can(role, 'MANAGE_CONTENT')).toBe(role === 'ADMIN');
      expect(can(role, 'MANAGE_USERS')).toBe(role === 'ADMIN');
    }
  });
});

describe('roleLabel', () => {
  it('names every role', () => {
    for (const role of ALL_ROLES) {
      expect(roleLabel(role)).toMatch(/\S/);
    }
    expect(roleLabel('HIRING_MANAGER')).toBe('Hiring manager');
  });
});
