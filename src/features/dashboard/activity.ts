import type { AuditAction } from '@/lib/audit';

/**
 * Turning an audit row into a sentence.
 *
 * Kept pure and separate from the query so the phrasing is unit-testable and
 * so an unknown action — one written by a newer deploy against an older
 * reader — degrades into something readable rather than a blank row.
 */

export type ActivityTone = 'neutral' | 'positive' | 'negative' | 'attention';

export interface ActivityPhrase {
  /** What happened, with the actor and subject filled in by the caller. */
  verb: string;
  tone: ActivityTone;
  icon: ActivityIcon;
}

export type ActivityIcon =
  'application' | 'stage' | 'panel' | 'feedback' | 'decision' | 'note' | 'comment' | 'rubric';

const PHRASES: Record<AuditAction, ActivityPhrase> = {
  'application.created': { verb: 'opened an application', tone: 'neutral', icon: 'application' },
  'application.status_changed': {
    verb: 'changed the application status',
    tone: 'attention',
    icon: 'application',
  },
  'application.owner_changed': {
    verb: 'reassigned the application',
    tone: 'neutral',
    icon: 'application',
  },
  'stage.created': { verb: 'added a stage', tone: 'neutral', icon: 'stage' },
  'stage.updated': { verb: 'updated a stage', tone: 'neutral', icon: 'stage' },
  'stage.status_changed': { verb: 'moved a stage', tone: 'neutral', icon: 'stage' },
  'stage.outcome_recorded': {
    verb: 'recorded a stage outcome',
    tone: 'attention',
    icon: 'stage',
  },
  'stage.deleted': { verb: 'removed a stage', tone: 'negative', icon: 'stage' },
  'panel.added': { verb: 'added a panellist', tone: 'neutral', icon: 'panel' },
  'panel.removed': { verb: 'removed a panellist', tone: 'neutral', icon: 'panel' },
  // A saved draft is intentionally quiet: it is not evidence yet, and a feed
  // that announces every autosave drowns the events that matter.
  'feedback.saved': { verb: 'saved a draft scorecard', tone: 'neutral', icon: 'feedback' },
  'feedback.submitted': { verb: 'submitted a scorecard', tone: 'positive', icon: 'feedback' },
  'feedback.revised': {
    verb: 'revised a submitted scorecard',
    tone: 'attention',
    icon: 'feedback',
  },
  'decision.recorded': { verb: 'recorded a decision', tone: 'positive', icon: 'decision' },
  // The one a reader must never scroll past: a reversal that looked like a
  // fresh decision would make the history unreadable.
  'decision.changed': { verb: 'changed a recorded decision', tone: 'attention', icon: 'decision' },
  'note.added': { verb: 'left a note on a submission', tone: 'neutral', icon: 'note' },
  'comment.added': { verb: 'commented', tone: 'neutral', icon: 'comment' },
  'rubric.published': { verb: 'published a rubric version', tone: 'neutral', icon: 'rubric' },
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
  const known = PHRASES[action as AuditAction];
  if (known) return known;
  return {
    verb: action.replace(/^[^.]+\./, '').replace(/_/g, ' '),
    tone: 'neutral',
    icon: 'stage',
  };
}
