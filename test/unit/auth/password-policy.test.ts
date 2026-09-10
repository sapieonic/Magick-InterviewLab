import { describe, expect, it } from 'vitest';

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
} from '@/features/auth/password-policy';

describe('passwordProblem', () => {
  it('returns null for a password that satisfies every rule', () => {
    expect(passwordProblem('correct9horse')).toBeNull();
  });

  it('accepts a password of exactly the minimum length', () => {
    const value = 'abcdefg1';
    expect(value).toHaveLength(MIN_PASSWORD_LENGTH);
    expect(passwordProblem(value)).toBeNull();
  });

  it('rejects a password one character below the minimum', () => {
    const value = 'abcdef1';
    expect(value).toHaveLength(MIN_PASSWORD_LENGTH - 1);
    expect(passwordProblem(value)).toMatch(/at least 8 characters/);
  });

  it('accepts a password of exactly the maximum length', () => {
    const value = `${'a'.repeat(MAX_PASSWORD_LENGTH - 1)}1`;
    expect(passwordProblem(value)).toBeNull();
  });

  it('rejects a password one character above the maximum', () => {
    const value = `${'a'.repeat(MAX_PASSWORD_LENGTH)}1`;
    expect(passwordProblem(value)).toMatch(/at most 200 characters/);
  });

  it('rejects an all-digit password (no letter)', () => {
    expect(passwordProblem('1234567890')).toBe('Password must contain a letter.');
  });

  it('rejects an all-letter password (no digit)', () => {
    expect(passwordProblem('abcdefghij')).toBe('Password must contain a digit.');
  });

  // Length is checked before composition, so the message a user sees for an
  // empty field is the actionable one rather than "must contain a letter".
  it('reports the length problem first for an empty password', () => {
    expect(passwordProblem('')).toMatch(/at least 8 characters/);
  });

  it('counts a letter anywhere in the string, not only at the start', () => {
    expect(passwordProblem('1234567a')).toBeNull();
  });
});
