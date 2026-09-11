import { describe, expect, it } from 'vitest';

import {
  RECOMMENDATION_POSITION,
  detectDisagreement,
  isPositive,
  normaliseScore,
  scorecardOverall,
  summariseApplication,
  summariseCriteria,
  summariseRecommendations,
  summariseStage,
  toPercent,
  weightedOverall,
  type AggregateCriterion,
  type AggregateScorecard,
  type AggregateStageInput,
} from '@/features/scorecard/aggregate';
import type { Recommendation } from '@/generated/prisma/enums';

/**
 * The aggregation is the one part of this feature with real arithmetic in it,
 * and the arithmetic is the part a debrief will be argued from. It is pure, so
 * it can be pinned exactly rather than inferred from a rendered page.
 */

function criterion(overrides: Partial<AggregateCriterion> = {}): AggregateCriterion {
  return { id: 'c1', name: 'Criterion', weight: 1, maxScore: 4, position: 0, ...overrides };
}

function card(
  recommendation: Recommendation | null,
  scores: Array<{ criterionId: string; score: number }> = [],
  authorId = 'u1',
): AggregateScorecard {
  return { authorId, authorName: authorId, recommendation, scores };
}

function stageInput(overrides: Partial<AggregateStageInput> = {}): AggregateStageInput {
  return {
    stageId: 's1',
    stageName: 'Round',
    stageType: 'BEHAVIORAL',
    criteria: [],
    scorecards: [],
    panelSize: 0,
    submittedCount: 0,
    ...overrides,
  };
}

describe('normaliseScore', () => {
  it('maps the bottom of any scale to 0 and the top to 1', () => {
    expect(normaliseScore(1, 4)).toBe(0);
    expect(normaliseScore(4, 4)).toBe(1);
    expect(normaliseScore(1, 10)).toBe(0);
    expect(normaliseScore(10, 10)).toBe(1);
  });

  /**
   * The reason the denominator is `maxScore - 1`: dividing by `maxScore` would
   * report the worst possible 1..10 score as 10% and the worst possible 1..4
   * score as 25%, making the harsher scale look kinder.
   */
  it('makes different scales comparable at the same relative position', () => {
    expect(normaliseScore(2.5, 4)).toBeCloseTo(0.5, 10);
    expect(normaliseScore(5.5, 10)).toBeCloseTo(0.5, 10);
  });

  it('clamps out-of-range input rather than returning a value outside 0..1', () => {
    expect(normaliseScore(0, 4)).toBe(0);
    expect(normaliseScore(99, 4)).toBe(1);
  });

  it('refuses a scale that carries no information', () => {
    expect(normaliseScore(1, 1)).toBeNull();
    expect(normaliseScore(1, 0)).toBeNull();
    expect(normaliseScore(Number.NaN, 4)).toBeNull();
  });
});

describe('summariseRecommendations', () => {
  it('always reports all six buckets in scale order', () => {
    const distribution = summariseRecommendations([]);
    expect(distribution.buckets.map((b) => b.recommendation)).toEqual([
      'STRONG_NO',
      'NO',
      'LEAN_NO',
      'LEAN_HIRE',
      'HIRE',
      'STRONG_HIRE',
    ]);
    expect(distribution.total).toBe(0);
    expect(distribution.meanPosition).toBeNull();
  });

  it('counts each point and splits the scale at the hire line', () => {
    const distribution = summariseRecommendations(['HIRE', 'HIRE', 'LEAN_NO', 'STRONG_NO']);
    expect(distribution.total).toBe(4);
    expect(distribution.positive).toBe(2);
    expect(distribution.negative).toBe(2);
    expect(distribution.buckets.find((b) => b.recommendation === 'HIRE')?.count).toBe(2);
  });

  it('ignores scorecards with no recommendation rather than counting them as neutral', () => {
    const distribution = summariseRecommendations(['HIRE', null, null]);
    expect(distribution.total).toBe(1);
    expect(distribution.meanPosition).toBe(RECOMMENDATION_POSITION.HIRE);
  });

  /** The documented limitation, asserted so it cannot quietly change meaning. */
  it('averages positions ordinally, which is why the mean has a name and not a verdict', () => {
    const distribution = summariseRecommendations(['STRONG_NO', 'STRONG_HIRE']);
    expect(distribution.meanPosition).toBe(3.5);
    expect(distribution.positive).toBe(1);
    expect(distribution.negative).toBe(1);
  });

  it('has no neutral point', () => {
    expect(isPositive('LEAN_NO')).toBe(false);
    expect(isPositive('LEAN_HIRE')).toBe(true);
  });
});

describe('detectDisagreement', () => {
  it('does not flag a single opinion', () => {
    const signal = detectDisagreement(['STRONG_NO']);
    expect(signal.disagrees).toBe(false);
    expect(signal.spread).toBe(0);
  });

  it('does not flag unanimity', () => {
    expect(detectDisagreement(['HIRE', 'HIRE', 'HIRE']).disagrees).toBe(false);
  });

  it('does not flag adjacent opinions on the same side', () => {
    const signal = detectDisagreement(['HIRE', 'STRONG_HIRE']);
    expect(signal.disagrees).toBe(false);
    expect(signal.spread).toBe(1);
  });

  it('flags a split across the hire line even when the spread is one point', () => {
    const signal = detectDisagreement(['LEAN_NO', 'LEAN_HIRE']);
    expect(signal.straddlesHireLine).toBe(true);
    expect(signal.disagrees).toBe(true);
    expect(signal.spread).toBe(1);
  });

  it('flags a wide spread on one side of the line', () => {
    const signal = detectDisagreement(['STRONG_NO', 'LEAN_NO']);
    expect(signal.straddlesHireLine).toBe(false);
    expect(signal.disagrees).toBe(true);
    expect(signal.lowest).toBe('STRONG_NO');
    expect(signal.highest).toBe('LEAN_NO');
  });

  it('reports the extremes so the notice can name them', () => {
    const signal = detectDisagreement(['NO', 'STRONG_HIRE', 'LEAN_HIRE']);
    expect(signal.lowest).toBe('NO');
    expect(signal.highest).toBe('STRONG_HIRE');
    expect(signal.spread).toBe(4);
  });

  it('ignores scorecards with no recommendation', () => {
    expect(detectDisagreement(['HIRE', null]).disagrees).toBe(false);
  });
});

describe('summariseCriteria', () => {
  const criteria = [
    criterion({ id: 'a', name: 'Coding', position: 1 }),
    criterion({ id: 'b', name: 'Design', position: 0, maxScore: 10 }),
  ];

  it('returns criteria in rubric order, not input order', () => {
    const result = summariseCriteria(criteria, []);
    expect(result.map((c) => c.criterionId)).toEqual(['b', 'a']);
  });

  it('averages only the scorecards that scored a criterion', () => {
    const result = summariseCriteria(criteria, [
      card('HIRE', [{ criterionId: 'a', score: 4 }]),
      card('NO', [{ criterionId: 'a', score: 2 }]),
      card('HIRE', [{ criterionId: 'b', score: 8 }]),
    ]);
    const coding = result.find((c) => c.criterionId === 'a');
    expect(coding?.responses).toBe(2);
    expect(coding?.mean).toBe(3);
    expect(coding?.min).toBe(2);
    expect(coding?.max).toBe(4);
  });

  it('reports nulls rather than zeros for an unscored criterion', () => {
    const result = summariseCriteria(criteria, [card('HIRE', [{ criterionId: 'a', score: 3 }])]);
    const design = result.find((c) => c.criterionId === 'b');
    expect(design?.responses).toBe(0);
    expect(design?.mean).toBeNull();
    expect(design?.normalised).toBeNull();
  });

  it('normalises each criterion against its own scale', () => {
    const result = summariseCriteria(criteria, [
      card('HIRE', [
        { criterionId: 'a', score: 4 },
        { criterionId: 'b', score: 4 },
      ]),
    ]);
    expect(result.find((c) => c.criterionId === 'a')?.normalised).toBe(1);
    expect(result.find((c) => c.criterionId === 'b')?.normalised).toBeCloseTo(1 / 3, 10);
  });

  it('floors a weight below one, so a criterion cannot be silently zeroed out', () => {
    const result = summariseCriteria([criterion({ id: 'a', weight: 0 })], []);
    expect(result[0]?.weight).toBe(1);
  });
});

describe('weightedOverall', () => {
  it('weights criteria by their rubric weight', () => {
    const criteria = [
      criterion({ id: 'a', weight: 3 }),
      criterion({ id: 'b', weight: 1, position: 1 }),
    ];
    // a normalises to 1, b to 0 → (3*1 + 1*0) / 4
    const result = weightedOverall(
      summariseCriteria(criteria, [
        card('HIRE', [
          { criterionId: 'a', score: 4 },
          { criterionId: 'b', score: 1 },
        ]),
      ]),
    );
    expect(result).toBeCloseTo(0.75, 10);
  });

  it('is scale-independent: the same relative performance scores the same', () => {
    const fourPoint = weightedOverall(
      summariseCriteria([criterion({ id: 'a', maxScore: 4 })], [
        card('HIRE', [{ criterionId: 'a', score: 4 }]),
      ]),
    );
    const tenPoint = weightedOverall(
      summariseCriteria([criterion({ id: 'a', maxScore: 10 })], [
        card('HIRE', [{ criterionId: 'a', score: 10 }]),
      ]),
    );
    expect(fourPoint).toBe(tenPoint);
  });

  it('drops unscored criteria instead of treating missing evidence as a bottom score', () => {
    const criteria = [
      criterion({ id: 'a', weight: 1 }),
      criterion({ id: 'b', weight: 5, position: 1 }),
    ];
    const result = weightedOverall(
      summariseCriteria(criteria, [card('HIRE', [{ criterionId: 'a', score: 4 }])]),
    );
    expect(result).toBe(1);
  });

  it('returns null when nothing has been scored at all', () => {
    expect(weightedOverall(summariseCriteria([criterion()], []))).toBeNull();
  });
});

describe('scorecardOverall', () => {
  it('scores one interviewer on the same normalised basis as the panel', () => {
    const criteria = [
      criterion({ id: 'a', maxScore: 4, weight: 1 }),
      criterion({ id: 'b', maxScore: 10, weight: 1, position: 1 }),
    ];
    const result = scorecardOverall(criteria, [
      { criterionId: 'a', score: 4 },
      { criterionId: 'b', score: 1 },
    ]);
    expect(result).toBeCloseTo(0.5, 10);
  });
});

describe('summariseStage', () => {
  it('counts what is outstanding from the panel size', () => {
    const signal = summariseStage(
      stageInput({ panelSize: 3, submittedCount: 1, scorecards: [card('HIRE')] }),
    );
    expect(signal.outstandingCount).toBe(2);
    expect(signal.partial).toBe(false);
  });

  it('never reports a negative outstanding count when a panellist has been removed', () => {
    const signal = summariseStage(
      stageInput({ panelSize: 1, submittedCount: 3, scorecards: [card('HIRE')] }),
    );
    expect(signal.outstandingCount).toBe(0);
  });

  /**
   * The flag that tells the page its numbers are computed over a subset — the
   * read model aggregates only the scorecards the viewer may read, so a
   * blinded panellist is not handed the panel's average.
   */
  it('flags itself partial when scorecards exist that the viewer cannot read', () => {
    const signal = summariseStage(
      stageInput({ panelSize: 3, submittedCount: 3, scorecards: [card('HIRE')] }),
    );
    expect(signal.partial).toBe(true);
    expect(signal.distribution.total).toBe(1);
  });

  it('summarises the automated runs separately from anything a human said', () => {
    const signal = summariseStage(
      stageInput({
        stageType: 'CODING_ASSESSMENT',
        automated: [
          {
            submissionId: 'sub1',
            questionTitle: 'Q1',
            score: 100,
            passedCount: 4,
            totalCount: 4,
          },
          { submissionId: 'sub2', questionTitle: 'Q2', score: 50, passedCount: 2, totalCount: 4 },
        ],
      }),
    );
    expect(signal.automated?.meanScore).toBe(75);
    expect(signal.automated?.passedCount).toBe(6);
    expect(signal.automated?.totalCount).toBe(8);
  });

  it('has no automated section for a round that is not an assessment', () => {
    expect(summariseStage(stageInput()).automated).toBeNull();
  });

  it('emits no verdict field of any kind', () => {
    const signal = summariseStage(stageInput({ scorecards: [card('STRONG_HIRE')] }));
    const keys = Object.keys(signal);
    expect(keys).not.toContain('verdict');
    expect(keys).not.toContain('recommendedOutcome');
    expect(keys).not.toContain('hireProbability');
  });
});

describe('summariseApplication', () => {
  const criteria = [criterion({ id: 'a' })];

  it('counts every scorecard once rather than averaging per-stage averages', () => {
    const signal = summariseApplication([
      stageInput({
        stageId: 's1',
        criteria,
        panelSize: 4,
        submittedCount: 4,
        scorecards: [
          card('HIRE', [{ criterionId: 'a', score: 4 }], 'u1'),
          card('HIRE', [], 'u2'),
          card('HIRE', [], 'u3'),
          card('HIRE', [], 'u4'),
        ],
      }),
      stageInput({
        stageId: 's2',
        criteria,
        panelSize: 1,
        submittedCount: 1,
        scorecards: [card('STRONG_NO', [], 'u5')],
      }),
    ]);

    expect(signal.distribution.total).toBe(5);
    expect(signal.distribution.positive).toBe(4);
    expect(signal.panelSize).toBe(5);
    expect(signal.submittedCount).toBe(5);
    expect(signal.outstandingCount).toBe(0);
  });

  it('reports disagreement across rounds, not only within one', () => {
    const signal = summariseApplication([
      stageInput({ stageId: 's1', panelSize: 1, submittedCount: 1, scorecards: [card('HIRE')] }),
      stageInput({ stageId: 's2', panelSize: 1, submittedCount: 1, scorecards: [card('NO')] }),
    ]);
    expect(signal.disagreement.disagrees).toBe(true);
    expect(signal.disagreement.straddlesHireLine).toBe(true);
  });

  it('is partial when any single round is', () => {
    const signal = summariseApplication([
      stageInput({ stageId: 's1', panelSize: 1, submittedCount: 1, scorecards: [card('HIRE')] }),
      stageInput({ stageId: 's2', panelSize: 2, submittedCount: 2, scorecards: [card('NO')] }),
    ]);
    expect(signal.partial).toBe(true);
  });

  it('sums outstanding work across the whole pipeline', () => {
    const signal = summariseApplication([
      stageInput({ stageId: 's1', panelSize: 3, submittedCount: 1, scorecards: [card('HIRE')] }),
      stageInput({ stageId: 's2', panelSize: 2, submittedCount: 0 }),
    ]);
    expect(signal.outstandingCount).toBe(4);
  });
});

describe('toPercent', () => {
  it('rounds for display and passes null through', () => {
    expect(toPercent(0.666)).toBe(67);
    expect(toPercent(null)).toBeNull();
  });
});
