import type { AuditAction } from '@/lib/audit';

/**
 * Turning an audit row into a sentence.
 *
 * Kept pure and separate from the query so the phrasing is unit-testable and
 * so an unknown action — one written by a newer deploy against an older
 * reader — degrades into something readable rather than a blank row.
 *
 * **One map, two grammars.** The same event has to be describable in a feed
 * ("Priya moved a round") and in a timeline ("Round status changed"), and when
 * those lived in two files they drifted: the feed said "added a stage" where
 * the application timeline said "Round added", for the identical row. So each
 * action carries both forms here and `ACTIVITY_PHRASES` is exported for any
 * surface that needs either.
 *
 * The vocabulary is "round", not "stage". `Stage` is what the schema calls the
 * row; a round is what the people using this call the thing, and the audit
 * trail is read by them.
 */

export type ActivityTone = 'neutral' | 'positive' | 'negative' | 'attention';

export interface ActivityPhrase {
  /** What happened, with the actor and subject filled in by the caller. */
  verb: string;
  /** The same event as a standalone noun phrase, for a timeline row. */
  label: string;
  tone: ActivityTone;
  icon: ActivityIcon;
}

export type ActivityIcon =
  'application' | 'stage' | 'panel' | 'feedback' | 'decision' | 'note' | 'comment' | 'rubric';

export const ACTIVITY_PHRASES: Record<AuditAction, ActivityPhrase> = {
  'application.created': {
    verb: 'opened an application',
    label: 'Application created',
    tone: 'neutral',
    icon: 'application',
  },
  'application.status_changed': {
    verb: 'changed the application status',
    label: 'Status changed',
    tone: 'attention',
    icon: 'application',
  },
  'application.owner_changed': {
    verb: 'reassigned the application',
    label: 'Owner changed',
    tone: 'neutral',
    icon: 'application',
  },
  'stage.created': { verb: 'added a round', label: 'Round added', tone: 'neutral', icon: 'stage' },
  'stage.updated': {
    verb: 'updated a round',
    label: 'Round updated',
    tone: 'neutral',
    icon: 'stage',
  },
  'stage.status_changed': {
    verb: 'moved a round',
    label: 'Round status changed',
    tone: 'neutral',
    icon: 'stage',
  },
  'stage.outcome_recorded': {
    verb: 'recorded a round outcome',
    label: 'Round outcome recorded',
    tone: 'attention',
    icon: 'stage',
  },
  'stage.deleted': {
    verb: 'removed a round',
    label: 'Round removed',
    tone: 'negative',
    icon: 'stage',
  },
  'panel.added': {
    verb: 'added a panellist',
    label: 'Panellist added',
    tone: 'neutral',
    icon: 'panel',
  },
  'panel.removed': {
    verb: 'removed a panellist',
    label: 'Panellist removed',
    tone: 'neutral',
    icon: 'panel',
  },
  // A saved draft is intentionally quiet: it is not evidence yet, and a feed
  // that announces every autosave drowns the events that matter.
  'feedback.saved': {
    verb: 'saved a draft scorecard',
    label: 'Scorecard saved',
    tone: 'neutral',
    icon: 'feedback',
  },
  'feedback.submitted': {
    verb: 'submitted a scorecard',
    label: 'Scorecard submitted',
    tone: 'positive',
    icon: 'feedback',
  },
  'feedback.revised': {
    verb: 'revised a submitted scorecard',
    label: 'Scorecard revised',
    tone: 'attention',
    icon: 'feedback',
  },
  'decision.recorded': {
    verb: 'recorded a decision',
    label: 'Decision recorded',
    tone: 'positive',
    icon: 'decision',
  },
  // The one a reader must never scroll past: a reversal that looked like a
  // fresh decision would make the history unreadable.
  'decision.changed': {
    verb: 'changed a recorded decision',
    label: 'Decision changed',
    tone: 'attention',
    icon: 'decision',
  },
  'note.added': {
    verb: 'left a note on a submission',
    label: 'Note added on a submission',
    tone: 'neutral',
    icon: 'note',
  },
  'note.deleted': {
    verb: 'deleted a note on a submission',
    label: 'Note removed from a submission',
    tone: 'negative',
    icon: 'note',
  },
  'comment.added': { verb: 'commented', label: 'Note added', tone: 'neutral', icon: 'comment' },
  'rubric.published': {
    verb: 'published a rubric version',
    label: 'Rubric version published',
    tone: 'neutral',
    icon: 'rubric',
  },
};

/** Events that are too routine to earn a line in a shared feed. */
const QUIET: ReadonlySet<string> = new Set(['feedback.saved']);

export function isQuietAction(action: string): boolean {
  return QUIET.has(action);
}

/**
 * A newer deploy can write an action this build has never heard of. Rather
 * than dropping the row — which would silently shorten an audit trail — fall
 * back to the raw action with its namespace stripped.
 */
export function describeAction(action: string): ActivityPhrase {
  const known = ACTIVITY_PHRASES[action as AuditAction];
  if (known) return known;
  const words = action.replace(/^[^.]+\./, '').replace(/_/g, ' ');
  return {
    verb: words,
    // Capitalised so an unlabelled event still reads as a timeline entry
    // rather than as a fragment of the one above it.
    label: words.charAt(0).toUpperCase() + words.slice(1),
    tone: 'neutral',
    icon: 'stage',
  };
}

/**
 * The noun-phrase form, for a timeline that lists events rather than narrating
 * them. Same fallback as `describeAction`: an event nobody wrote a label for is
 * still an event that happened.
 */
export function actionLabel(action: string): string {
  return describeAction(action).label;
}
