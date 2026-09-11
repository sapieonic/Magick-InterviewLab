import { describe, expect, it } from 'vitest';

import {
  blindReason,
  canReadFeedback,
  canReadOthersSubmittedFeedback,
  visibleFeedback,
  type FeedbackVisibilityContext,
  type ReadableFeedback,
} from '@/features/feedback/visibility';

function context(overrides: Partial<FeedbackVisibilityContext> = {}): FeedbackVisibilityContext {
  return {
    viewerId: 'viewer',
    stageIsBlind: true,
    viewerIsPanelist: true,
    viewerHasSubmitted: false,
    ...overrides,
  };
}

const othersDraft: ReadableFeedback = { authorId: 'someone-else', status: 'DRAFT' };
const othersSubmitted: ReadableFeedback = { authorId: 'someone-else', status: 'SUBMITTED' };
const ownDraft: ReadableFeedback = { authorId: 'viewer', status: 'DRAFT' };
const ownSubmitted: ReadableFeedback = { authorId: 'viewer', status: 'SUBMITTED' };

/**
 * The blind rule decides whether a panel produces four opinions or one opinion
 * and three echoes, so every combination of (blind, on-panel, submitted) is
 * asserted rather than sampled.
 */
describe('canReadOthersSubmittedFeedback', () => {
  const cases: Array<{
    name: string;
    stageIsBlind: boolean;
    viewerIsPanelist: boolean;
    viewerHasSubmitted: boolean;
    expected: boolean;
  }> = [
    {
      name: 'a panellist who has not submitted waits',
      stageIsBlind: true,
      viewerIsPanelist: true,
      viewerHasSubmitted: false,
      expected: false,
    },
    {
      name: 'a panellist who has submitted may read',
      stageIsBlind: true,
      viewerIsPanelist: true,
      viewerHasSubmitted: true,
      expected: true,
    },
    {
      name: 'someone not on the panel has nothing to anchor, so may read',
      stageIsBlind: true,
      viewerIsPanelist: false,
      viewerHasSubmitted: false,
      expected: true,
    },
    {
      name: 'a non-blind stage is open to everyone who can see the application',
      stageIsBlind: false,
      viewerIsPanelist: true,
      viewerHasSubmitted: false,
      expected: true,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        canReadOthersSubmittedFeedback(
          context({
            stageIsBlind: c.stageIsBlind,
            viewerIsPanelist: c.viewerIsPanelist,
            viewerHasSubmitted: c.viewerHasSubmitted,
          }),
        ),
      ).toBe(c.expected);
    });
  }
});

describe('drafts', () => {
  /**
   * Absolute, and deliberately not subject to any capability: half-written
   * impressions are not evidence, and a system that exposes them teaches
   * people to write their real opinion somewhere else.
   */
  it('are never readable by anyone but their author', () => {
    const contexts = [
      context({ viewerIsPanelist: true, viewerHasSubmitted: true }),
      context({ viewerIsPanelist: false }),
      context({ stageIsBlind: false }),
    ];
    for (const ctx of contexts) {
      expect(canReadFeedback(othersDraft, ctx)).toBe(false);
    }
  });

  it('are always readable by their own author', () => {
    expect(canReadFeedback(ownDraft, context())).toBe(true);
  });
});

describe('canReadFeedback', () => {
  it('always lets an author read their own submitted scorecard', () => {
    expect(canReadFeedback(ownSubmitted, context({ viewerHasSubmitted: true }))).toBe(true);
  });

  it("hides another panellist's submitted scorecard until the viewer submits", () => {
    expect(canReadFeedback(othersSubmitted, context({ viewerHasSubmitted: false }))).toBe(false);
    expect(canReadFeedback(othersSubmitted, context({ viewerHasSubmitted: true }))).toBe(true);
  });
});

describe('visibleFeedback', () => {
  const all = [ownDraft, ownSubmitted, othersDraft, othersSubmitted];

  it('returns only the viewer’s own rows while they still owe a scorecard', () => {
    expect(visibleFeedback(all, context({ viewerHasSubmitted: false }))).toEqual([
      ownDraft,
      ownSubmitted,
    ]);
  });

  it("adds the panel's submitted rows once the viewer has submitted, but never their drafts", () => {
    expect(visibleFeedback(all, context({ viewerHasSubmitted: true }))).toEqual([
      ownDraft,
      ownSubmitted,
      othersSubmitted,
    ]);
  });

  it('never returns another author’s draft, on any stage configuration', () => {
    for (const stageIsBlind of [true, false]) {
      for (const viewerIsPanelist of [true, false]) {
        for (const viewerHasSubmitted of [true, false]) {
          const visible = visibleFeedback(
            all,
            context({ stageIsBlind, viewerIsPanelist, viewerHasSubmitted }),
          );
          expect(visible).not.toContain(othersDraft);
        }
      }
    }
  });
});

describe('blindReason', () => {
  it('explains the hold only while one applies', () => {
    expect(blindReason(context({ viewerHasSubmitted: false }))).toBe('OWN_FEEDBACK_PENDING');
    expect(blindReason(context({ viewerHasSubmitted: true }))).toBeNull();
    expect(blindReason(context({ viewerIsPanelist: false }))).toBeNull();
  });
});
