import { describe, expect, it, vi } from 'vitest';

// `@/lib/audit` is server-only and opens a connection pool through Prisma at
// module scope; the AUDIT action constants it exports are plain data, so both
// are stubbed rather than the constants being duplicated here and left to drift.
vi.mock('server-only', () => ({}));

const { db } = await vi.hoisted(async () => ({
  db: (await import('../../helpers/prisma-mock')).createPrismaMock(),
}));
vi.mock('@/lib/db/prisma', () => ({ prisma: db }));

import { describeAction, isQuietAction } from '@/features/dashboard/activity';
import { AUDIT } from '@/lib/audit';

describe('describeAction', () => {
  it('has a phrase for every audit action the app can write', () => {
    for (const action of Object.values(AUDIT)) {
      const phrase = describeAction(action);
      expect(phrase.verb).toMatch(/\S/);
      // A fallback would echo the action string; a real phrase never does.
      expect(phrase.verb).not.toContain('.');
    }
  });

  /**
   * A newer deploy can write an action an older reader has never heard of.
   * Dropping the row would silently shorten an audit trail, which is the one
   * thing an audit trail must not do.
   */
  it('degrades an unknown action into something readable rather than dropping it', () => {
    const phrase = describeAction('offer.extended_verbally');
    expect(phrase.verb).toBe('extended verbally');
    expect(phrase.tone).toBe('neutral');
  });

  it('marks a reversal as needing attention, not as routine', () => {
    expect(describeAction(AUDIT.DECISION_CHANGED).tone).toBe('attention');
    expect(describeAction(AUDIT.FEEDBACK_REVISED).tone).toBe('attention');
  });

  it('marks a landed scorecard and a recorded decision as progress', () => {
    expect(describeAction(AUDIT.FEEDBACK_SUBMITTED).tone).toBe('positive');
    expect(describeAction(AUDIT.DECISION_RECORDED).tone).toBe('positive');
  });
});

describe('isQuietAction', () => {
  /**
   * A saved draft is not evidence yet, and a feed that announces every
   * autosave drowns the events that matter.
   */
  it('keeps draft autosaves out of the shared feed', () => {
    expect(isQuietAction(AUDIT.FEEDBACK_SAVED)).toBe(true);
  });

  it('lets everything else through', () => {
    for (const action of Object.values(AUDIT)) {
      if (action === AUDIT.FEEDBACK_SAVED) continue;
      expect(isQuietAction(action)).toBe(false);
    }
  });
});
