/**
 * The decision behind client-side auto-submit at the deadline.
 *
 * Pure and separate so the guard — the subtle part — is unit-tested rather than
 * buried in an effect. Auto-submit is *best-effort by nature*: it can only fire
 * in an open tab with a live clock, so a closed laptop or a dead connection at
 * time-up means it never runs. That is exactly why the server still accepts a
 * late submission (see `interview-timer.tsx`) — this convenience captures a
 * snapshot at the deadline for the common case, it does not enforce a cutoff.
 */
export interface AutoSubmitConditions {
  /** Phones are read-only, so nothing can be submitted from them. */
  isDesktop: boolean;
  /** The countdown has crossed zero. */
  expired: boolean;
  /**
   * The timer was already past its deadline when the workspace loaded. Without
   * this guard, every refresh after time-up would resubmit — the deadline
   * crossing has to happen *while the candidate is working*, not on arrival.
   */
  expiredAtLoad: boolean;
  /** A submit is already in flight. */
  submitting: boolean;
  /** One-submission interview whose single submission is already spent. */
  singleSubmissionUsed: boolean;
  /** Something was already submitted this session — don't double up. */
  alreadyRecorded: boolean;
  /** This mount has already auto-submitted once. */
  alreadyAutoSubmitted: boolean;
}

export function shouldAutoSubmit(c: AutoSubmitConditions): boolean {
  return (
    c.isDesktop &&
    c.expired &&
    !c.expiredAtLoad &&
    !c.submitting &&
    !c.singleSubmissionUsed &&
    !c.alreadyRecorded &&
    !c.alreadyAutoSubmitted
  );
}
