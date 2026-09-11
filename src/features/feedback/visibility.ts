/**
 * Who may read whose scorecard.
 *
 * This is the rule that makes a panel worth having. Four interviewers who read
 * each other first produce one opinion and three echoes of it, so an
 * interviewer cannot see anyone else's feedback on a stage until their own is
 * submitted. That is not a UI affordance — it is enforced in the query layer,
 * because a read model that returns the rows has already leaked them however
 * carefully the page hides them.
 *
 * Kept pure and dependency-free so the rule can be exhaustively unit-tested
 * rather than inferred from the behaviour of a page.
 */

export interface FeedbackVisibilityContext {
  /** The person doing the reading. */
  viewerId: string;
  /** Is this stage running blind? Configurable per stage. */
  stageIsBlind: boolean;
  /** Is the viewer on this stage's panel — i.e. do they owe a scorecard? */
  viewerIsPanelist: boolean;
  /** Has the viewer's own scorecard for this stage been submitted? */
  viewerHasSubmitted: boolean;
}

export interface ReadableFeedback {
  authorId: string;
  status: 'DRAFT' | 'SUBMITTED';
}

/**
 * A draft belongs to nobody but its author — not to an admin, not to the
 * hiring manager, not to the recruiter chasing it. Half-written impressions
 * are not evidence, and a system that exposes them teaches people to write
 * their real opinion somewhere else.
 */
export function canReadFeedback(
  feedback: ReadableFeedback,
  context: FeedbackVisibilityContext,
): boolean {
  if (feedback.authorId === context.viewerId) return true;
  if (feedback.status === 'DRAFT') return false;
  return canReadOthersSubmittedFeedback(context);
}

/**
 * The blind rule proper.
 *
 * Note who it does *not* apply to: someone who is not on the panel is not
 * writing a scorecard, so there is nothing for them to anchor. A recruiter
 * chasing a late panellist and a hiring manager preparing a debrief both need
 * to read what has landed; neither is contributing a judgement of their own.
 * Restricting them would buy no independence and would only push the debrief
 * into a meeting nobody can audit.
 *
 * A panellist, by contrast, waits — including a panellist who happens to be an
 * admin. Rank does not make anchoring less likely.
 */
export function canReadOthersSubmittedFeedback(context: FeedbackVisibilityContext): boolean {
  if (!context.stageIsBlind) return true;
  if (!context.viewerIsPanelist) return true;
  return context.viewerHasSubmitted;
}

/** Why the panel's feedback is hidden, for the message shown in its place. */
export type BlindReason = 'OWN_FEEDBACK_PENDING';

export function blindReason(context: FeedbackVisibilityContext): BlindReason | null {
  return canReadOthersSubmittedFeedback(context) ? null : 'OWN_FEEDBACK_PENDING';
}

/**
 * Filter a stage's feedback to what this viewer may actually receive.
 *
 * Read models call this *before* returning, so an accidental prop drill can
 * never hand a page rows the viewer was not entitled to.
 */
export function visibleFeedback<T extends ReadableFeedback>(
  feedback: readonly T[],
  context: FeedbackVisibilityContext,
): T[] {
  return feedback.filter((f) => canReadFeedback(f, context));
}
