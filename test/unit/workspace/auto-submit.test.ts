import { describe, expect, it } from 'vitest';

import { shouldAutoSubmit, type AutoSubmitConditions } from '@/components/workspace/auto-submit';

/** The one state in which auto-submit is meant to fire. */
function ready(overrides: Partial<AutoSubmitConditions> = {}): AutoSubmitConditions {
  return {
    isDesktop: true,
    expired: true,
    expiredAtLoad: false,
    submitting: false,
    runInFlight: false,
    singleSubmissionUsed: false,
    alreadyRecorded: false,
    alreadyAutoSubmitted: false,
    ...overrides,
  };
}

describe('shouldAutoSubmit', () => {
  it('fires when the deadline is crossed live during an open desktop session', () => {
    expect(shouldAutoSubmit(ready())).toBe(true);
  });

  it('does not fire before the timer expires', () => {
    expect(shouldAutoSubmit(ready({ expired: false }))).toBe(false);
  });

  // The key guard: a reload after time-up must not resubmit on every refresh.
  it('does not fire when the deadline had already passed at load', () => {
    expect(shouldAutoSubmit(ready({ expiredAtLoad: true }))).toBe(false);
  });

  it('does not fire on a phone (read-only, nothing to submit)', () => {
    expect(shouldAutoSubmit(ready({ isDesktop: false }))).toBe(false);
  });

  it('does not fire while a submit is already in flight', () => {
    expect(shouldAutoSubmit(ready({ submitting: true }))).toBe(false);
  });

  // Waits for an in-flight run to settle instead of spending the one attempt on
  // a call that would immediately return null (the run lock is still held).
  it('does not fire while a test run is in progress', () => {
    expect(shouldAutoSubmit(ready({ runInFlight: true }))).toBe(false);
  });

  it('does not spend a one-submission interview that is already used', () => {
    expect(shouldAutoSubmit(ready({ singleSubmissionUsed: true }))).toBe(false);
  });

  it('does not double up when something was already submitted this session', () => {
    expect(shouldAutoSubmit(ready({ alreadyRecorded: true }))).toBe(false);
  });

  it('fires at most once per mount', () => {
    expect(shouldAutoSubmit(ready({ alreadyAutoSubmitted: true }))).toBe(false);
  });
});
