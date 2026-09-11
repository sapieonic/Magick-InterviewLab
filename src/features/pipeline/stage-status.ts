import type {
  AssignmentStatus,
  FeedbackStatus,
  InterviewerRole,
  StageStatus,
} from '@/generated/prisma/enums';

/**
 * The stage lifecycle, as pure data.
 *
 * A stage status is a claim about where a round has got to, and a claim that
 * anyone may overwrite with anything is worth nothing: "complete" has to mean
 * the round happened, not that someone picked it from a dropdown. So the legal
 * moves live here, in a table with no imports of consequence, exhaustively
 * unit-tested — and `setStageStatusAction` asks this rather than trusting the
 * select element the browser posted.
 *
 * Deliberately free of `server-only`, Prisma and `next` imports for the same
 * reason `capabilities.ts` and `feedback/visibility.ts` are: a rule that can
 * only be observed by running a page is a rule nobody can check.
 */

/**
 * What may follow what.
 *
 * The shape of it: everything before a round has run is reversible (a
 * scheduled interview slips back to pending, a skipped round is un-skipped),
 * everything after it is not. `COMPLETE` has exactly one exit —
 * `AWAITING_FEEDBACK` — and that is the explicit reopen: a round that is
 * complete but needs one more scorecard goes back to waiting for it, never
 * back to "never happened".
 */
export const STAGE_TRANSITIONS = {
  PENDING: ['SCHEDULED', 'IN_PROGRESS', 'SKIPPED'],
  SCHEDULED: ['PENDING', 'IN_PROGRESS', 'SKIPPED'],
  IN_PROGRESS: ['AWAITING_FEEDBACK', 'COMPLETE', 'SKIPPED'],
  AWAITING_FEEDBACK: ['COMPLETE', 'IN_PROGRESS', 'SKIPPED'],
  // Terminal but for the reopen below. Note the absence of `SKIPPED`: a round
  // that has been sat cannot be retconned into one that never happened.
  COMPLETE: ['AWAITING_FEEDBACK'],
  SKIPPED: ['PENDING'],
} as const satisfies Record<StageStatus, readonly StageStatus[]>;

/** The one move out of `COMPLETE`, named so the UI can label the control
 *  "Reopen" rather than "Set to awaiting feedback". */
export const STAGE_REOPEN_TARGET: StageStatus = 'AWAITING_FEEDBACK';

/**
 * May this stage move from `from` to `to`?
 *
 * `from === to` is legal and means nothing happened — a double-submitted form
 * or a second tab should be a no-op, not an error the user has to read.
 */
export function canTransitionStageStatus(from: StageStatus, to: StageStatus): boolean {
  if (from === to) return true;
  return (STAGE_TRANSITIONS[from] as readonly StageStatus[]).includes(to);
}

export const STAGE_STATUS_LABELS = {
  PENDING: 'Pending',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  AWAITING_FEEDBACK: 'Awaiting feedback',
  COMPLETE: 'Complete',
  SKIPPED: 'Skipped',
} as const satisfies Record<StageStatus, string>;

/** The message a refused transition gets. Names both ends — "invalid status"
 *  tells the person nothing about what they may do instead. */
export function stageTransitionError(from: StageStatus, to: StageStatus): string {
  const allowed: readonly StageStatus[] = STAGE_TRANSITIONS[from];
  const options = allowed.map((status) => STAGE_STATUS_LABELS[status]).join(', ');
  return `A ${STAGE_STATUS_LABELS[from].toLowerCase()} stage cannot become ${STAGE_STATUS_LABELS[
    to
  ].toLowerCase()}. Allowed from here: ${options}.`;
}

/** Statuses that mean the round is over, either way. Used for "which stage is
 *  the candidate actually on" and for the complete/total counts on the board. */
export function isStageResolved(status: StageStatus): boolean {
  return status === 'COMPLETE' || status === 'SKIPPED';
}

/**
 * Who owns the status of a `CODING_ASSESSMENT` stage.
 *
 * The problem: such a stage has two writers. A recruiter sets `Stage.status`
 * from the console, and the candidate's own workspace moves
 * `InterviewAssignment.status` by sitting the assessment. Left alone the two
 * drift, and the pipeline ends up showing "scheduled" for an assessment that
 * was submitted three days ago — exactly the stall the board exists to make
 * visible.
 *
 * How it is resolved: **the assignment wins for everything it can observe**,
 * and it is never copied into the stage row. `Stage.status` keeps what a human
 * last said; this function overlays what actually happened, and the read models
 * return the overlay. Nothing writes the derived value back, so there is no
 * second writer to race and no stale copy to reconcile.
 *
 * The two exceptions are the things an assignment cannot know: `COMPLETE` and
 * `SKIPPED` are human judgements about the *round* — the panel has debriefed,
 * or the round was dropped — and they outrank a candidate who later opens the
 * workspace again. Everything else the assignment decides, which is why
 * `setStageStatusAction` refuses to hand-set the other four on a coding stage.
 */
export function deriveCodingStageStatus(
  stored: StageStatus,
  assignment: AssignmentStatus | null,
): StageStatus {
  if (stored === 'COMPLETE' || stored === 'SKIPPED') return stored;
  if (assignment === null) return stored;
  switch (assignment) {
    case 'ASSIGNED':
      // "Not started" in the assignment's vocabulary covers both of ours, and
      // only the stage knows whether a slot has been booked.
      return stored === 'SCHEDULED' ? 'SCHEDULED' : 'PENDING';
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'COMPLETED':
      // Submitted and now owed a review. Not `COMPLETE`: a machine score is
      // not a verdict, and somebody still has to read the code.
      return 'AWAITING_FEEDBACK';
  }
}

/** The statuses a person may set by hand on a coding stage. See above. */
export const CODING_STAGE_MANUAL_STATUSES: readonly StageStatus[] = ['COMPLETE', 'SKIPPED'];

export function isManualStatusAllowedOnCodingStage(status: StageStatus): boolean {
  return CODING_STAGE_MANUAL_STATUSES.includes(status);
}

/**
 * The two tables above, composed — which is the only way either is safe to ask.
 *
 * Read on its own, `isManualStatusAllowedOnCodingStage` says a coding round may
 * only be set to `COMPLETE` or `SKIPPED` by hand. Read on its own,
 * `STAGE_TRANSITIONS` says the only way out of `COMPLETE` is
 * `AWAITING_FEEDBACK` and the only way out of `SKIPPED` is `PENDING`. Applied
 * one after the other to a *target* status they cancel each other out: every
 * exit from a terminal state is a status the coding guard refuses, so a coding
 * round marked complete could never be reopened and a skipped one could never
 * be un-skipped. The documented reopen was unreachable.
 *
 * The resolution is that the coding guard is about *claiming progress the
 * assignment owns*, not about leaving a state a person put the round in.
 * `COMPLETE` and `SKIPPED` are the two human judgements; withdrawing one hands
 * the round straight back to `deriveCodingStageStatus`, which re-derives it
 * from the assignment — so the write claims nothing the assignment does not
 * already say. Every other hand-set move on a live coding round is still
 * refused, which is the whole point of the guard.
 */
export function canSetCodingStageStatusByHand(from: StageStatus, to: StageStatus): boolean {
  if (!canTransitionStageStatus(from, to)) return false;
  if (isManualStatusAllowedOnCodingStage(to)) return true;
  // Leaving a terminal state: a judgement being withdrawn, not progress typed
  // over the assessment.
  return isStageResolved(from);
}

// --- the panel's scorecards -------------------------------------------------

/** A panel seat, narrowed to what counting needs. */
export interface CountableSeat {
  userId: string;
  role: InterviewerRole;
}

/** A scorecard, narrowed to what counting needs. Status and author only — the
 *  prose is access-controlled elsewhere and is never needed to count. */
export interface CountableScorecard {
  authorId: string;
  status: FeedbackStatus;
}

export interface ScorecardCounts {
  /** Seats that owe a scorecard. */
  expected: number;
  /** Submitted scorecards from those seats. Never exceeds `expected`. */
  submitted: number;
  /** What is actually late, which is zero until the round has run. */
  outstanding: number;
}

/**
 * A shadow is an observer: they are on the round to learn, not to judge.
 *
 * The single definition, exported so the read models, the feedback layer and
 * the scorecard aggregate all answer "is this person's opinion part of the
 * panel's verdict" the same way, rather than each filtering `SHADOW` (or
 * forgetting to) on its own.
 */
export function isExpectedToScore(role: InterviewerRole): boolean {
  return role !== 'SHADOW';
}

/**
 * A scorecard is not late until there is something to write about.
 *
 * `PENDING` and `SCHEDULED` rounds have not happened; nobody owes anything yet.
 * `SKIPPED` never will. Exported for the same reason as `isExpectedToScore`:
 * three other modules were each deciding this for themselves.
 */
export function isScorecardDue(status: StageStatus): boolean {
  return status === 'IN_PROGRESS' || status === 'AWAITING_FEEDBACK' || status === 'COMPLETE';
}

/**
 * How many scorecards a round is owed and how many have arrived.
 *
 * **This is the single definition of the panel denominator**, and both halves
 * have to come from it or the numbers contradict each other. The bug it exists
 * to prevent: the denominator excluded `SHADOW` seats while the numerator
 * counted every submitted row, so a shadow who submitted one made the stage
 * card render "3/2 scorecards in".
 *
 * The rule chosen, and why: a shadow's scorecard is **neither expected nor
 * counted**. The alternative — widening the denominator to include any shadow
 * who happened to submit — would make the panel's size depend on who got round
 * to writing something, and would quietly restore a shadow's opinion to the
 * verdict the moment they typed one. A shadow is there to learn; if their view
 * is meant to count, they are a `PANELIST`, and that is a seat someone assigns
 * on purpose.
 *
 * Counting the numerator by seat rather than by row is what makes
 * `submitted <= expected` true by construction: `Feedback` is unique per
 * `(stageId, authorId)`, so each expected seat contributes at most one.
 */
export function countScorecards(
  seats: readonly CountableSeat[],
  feedback: readonly CountableScorecard[],
  status: StageStatus,
): ScorecardCounts {
  const owed = new Set(seats.filter((seat) => isExpectedToScore(seat.role)).map((s) => s.userId));
  const expected = owed.size;
  const submitted = feedback.filter(
    (row) => row.status === 'SUBMITTED' && owed.has(row.authorId),
  ).length;
  return {
    expected,
    submitted,
    outstanding: isScorecardDue(status) ? Math.max(0, expected - submitted) : 0,
  };
}
