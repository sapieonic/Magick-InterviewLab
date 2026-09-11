/**
 * The aggregate *signal* a debrief reads — and deliberately not a verdict.
 *
 * Nothing in this file emits a recommended outcome, a hire probability, a
 * pass/fail or a ranking. It counts what the panel said, averages the rubric
 * scores they gave, and reports where they disagree. The call is made by a
 * person, in `Decision`, with a written rationale, or it is not made at all.
 *
 * That is partly craft and partly law. A number that decides who gets hired is
 * an automated employment decision tool: NYC Local Law 144 requires an annual
 * independent bias audit and published impact ratios for exactly that, the
 * EEOC treats a selection procedure's adverse impact as the employer's problem
 * however the score was produced, and GDPR Art. 22 gives a candidate a right
 * not to be subject to a decision based solely on automated processing. A
 * product that ships a "hire probability" acquires all three obligations on
 * behalf of every customer, silently. Counting and averaging what humans wrote
 * acquires none of them, because a human is still deciding.
 *
 * Pure by design: no Prisma, no `server-only`, no dates, no I/O. Everything
 * here is a function of its arguments so the arithmetic can be pinned by unit
 * tests rather than inferred from a page.
 */

// Type-only imports; erased at compile time, so this module still pulls in no
// runtime dependency of any kind.
import type { Recommendation, StageType } from '@/generated/prisma/enums';

/**
 * A numeric position for each point of the six-point scale, used to measure
 * *spread* and to sort — never to compute a verdict.
 *
 * The scale is ordinal, not interval: nothing says the gap between "no" and
 * "lean no" is the same size as the gap between "hire" and "strong hire". Any
 * mean over these numbers is therefore a summary statistic with no units, and
 * that is why the one this module exposes is called `meanPosition` rather than
 * "score".
 */
export const RECOMMENDATION_POSITION = {
  STRONG_NO: 1,
  NO: 2,
  LEAN_NO: 3,
  LEAN_HIRE: 4,
  HIRE: 5,
  STRONG_HIRE: 6,
} as const satisfies Record<Recommendation, number>;

export const RECOMMENDATION_ORDER = [
  'STRONG_NO',
  'NO',
  'LEAN_NO',
  'LEAN_HIRE',
  'HIRE',
  'STRONG_HIRE',
] as const satisfies readonly Recommendation[];

/** The scale has no neutral point, so "positive" is simply the top half. */
export function isPositive(recommendation: Recommendation): boolean {
  return RECOMMENDATION_POSITION[recommendation] >= 4;
}

// --- inputs ----------------------------------------------------------------

export interface AggregateCriterion {
  id: string;
  name: string;
  /** Relative weight when averaging across criteria. */
  weight: number;
  /** Top of the scale; 1 is always the bottom. */
  maxScore: number;
  position: number;
}

export interface AggregateScore {
  criterionId: string;
  score: number;
}

/** One submitted scorecard, reduced to the parts that aggregate. */
export interface AggregateScorecard {
  authorId: string;
  authorName: string;
  recommendation: Recommendation | null;
  scores: readonly AggregateScore[];
}

/** One automated coding run, kept separate from anything a human said. */
export interface AggregateAutomatedRun {
  submissionId: string;
  questionTitle: string;
  /** 0..100, weighted by test weight. */
  score: number;
  passedCount: number;
  totalCount: number;
}

export interface AggregateStageInput {
  stageId: string;
  stageName: string;
  stageType: StageType;
  criteria: readonly AggregateCriterion[];
  /** Submitted scorecards *the viewer may read* — see the note on `partial`. */
  scorecards: readonly AggregateScorecard[];
  /** Everyone who owes a scorecard on this stage. */
  panelSize: number;
  /** Submitted scorecards that exist, including any withheld from the viewer. */
  submittedCount: number;
  automated?: readonly AggregateAutomatedRun[];
}

// --- outputs ---------------------------------------------------------------

export interface RecommendationDistribution {
  /** One entry per point of the scale, always all six, in scale order. */
  buckets: Array<{ recommendation: Recommendation; count: number }>;
  total: number;
  positive: number;
  negative: number;
  /**
   * The mean of the ordinal positions, 1..6, or null when nobody has said
   * anything yet.
   *
   * Named for what it is. A "strong no" and a "strong hire" average to 3.5,
   * which describes no opinion any human on the panel holds; read it only
   * alongside `disagreement`, never on its own.
   */
  meanPosition: number | null;
}

export interface CriterionAggregate {
  criterionId: string;
  name: string;
  weight: number;
  maxScore: number;
  /** How many scorecards scored this criterion at all. */
  responses: number;
  /** Mean of the raw scores, on the criterion's own 1..maxScore scale. */
  mean: number | null;
  /** The same mean mapped to 0..1 so criteria with different scales compare. */
  normalised: number | null;
  /** Lowest and highest raw score given, for spotting a split on one criterion. */
  min: number | null;
  max: number | null;
}

export interface DisagreementSignal {
  /** True when the panel is not saying the same thing. */
  disagrees: boolean;
  /** Recommendations fall on both sides of the hire line. */
  straddlesHireLine: boolean;
  /** Distance between the highest and lowest position, 0..5. */
  spread: number;
  lowest: Recommendation | null;
  highest: Recommendation | null;
}

export interface AutomatedAggregate {
  runs: readonly AggregateAutomatedRun[];
  /** Mean of the per-submission percentages. */
  meanScore: number | null;
  passedCount: number;
  totalCount: number;
}

export interface StageSignal {
  stageId: string;
  stageName: string;
  stageType: StageType;
  distribution: RecommendationDistribution;
  criteria: CriterionAggregate[];
  /** Weight-averaged normalised score across criteria, 0..1, or null. */
  overallNormalised: number | null;
  disagreement: DisagreementSignal;
  panelSize: number;
  submittedCount: number;
  outstandingCount: number;
  /**
   * True when scorecards exist that this viewer may not read, so every number
   * above is computed over a subset. A blinded panellist must not be handed
   * the panel's average — an average anchors exactly as effectively as the
   * prose does — so the read model aggregates only what it may show, and says
   * so here.
   */
  partial: boolean;
  automated: AutomatedAggregate | null;
}

export interface ApplicationSignal {
  stages: StageSignal[];
  /** Every readable scorecard across every stage. */
  distribution: RecommendationDistribution;
  disagreement: DisagreementSignal;
  panelSize: number;
  submittedCount: number;
  outstandingCount: number;
  partial: boolean;
}

// --- arithmetic ------------------------------------------------------------

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Map a raw score onto 0..1.
 *
 * The bottom of every rubric scale is 1, so the denominator is `maxScore - 1`
 * rather than `maxScore`. Dividing by `maxScore` would make the worst possible
 * score on a 1..4 criterion (0.25) look four times better than the worst
 * possible score on a 1..10 one (0.1), which is the opposite of comparable.
 */
export function normaliseScore(score: number, maxScore: number): number | null {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore)) return null;
  // A one-point scale carries no information; refuse rather than divide by zero.
  if (maxScore <= 1) return null;
  const clamped = Math.min(Math.max(score, 1), maxScore);
  return (clamped - 1) / (maxScore - 1);
}

/** A weight below 1 would let one criterion be silently zeroed out. */
function safeWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 1;
  return Math.max(1, Math.floor(weight));
}

export function summariseRecommendations(
  recommendations: ReadonlyArray<Recommendation | null>,
): RecommendationDistribution {
  const given = recommendations.filter((r): r is Recommendation => r !== null);
  const buckets = RECOMMENDATION_ORDER.map((recommendation) => ({
    recommendation: recommendation as Recommendation,
    count: given.filter((r) => r === recommendation).length,
  }));

  return {
    buckets,
    total: given.length,
    positive: given.filter(isPositive).length,
    negative: given.filter((r) => !isPositive(r)).length,
    meanPosition: mean(given.map((r) => RECOMMENDATION_POSITION[r])),
  };
}

/**
 * Where the panel does not agree.
 *
 * Disagreement is the most decision-relevant thing a debrief can be told and
 * the first thing an average destroys: four people at "lean hire" and a
 * two-two split between "strong hire" and "no" produce the same mean. Two
 * conditions count, because they catch different failures:
 *
 *  - `straddlesHireLine` — somebody would hire and somebody would not. That is
 *    a conversation the panel has to have whatever the spread.
 *  - a spread of two or more positions — everybody may be on the same side of
 *    the line, but "strong no" and "lean no" are not the same evidence, and
 *    the scale has only three points per side for the spread to move across.
 *
 * One scorecard cannot disagree with anything, so a single opinion is never
 * flagged.
 */
export function detectDisagreement(
  recommendations: ReadonlyArray<Recommendation | null>,
): DisagreementSignal {
  const given = recommendations.filter((r): r is Recommendation => r !== null);
  if (given.length < 2) {
    return {
      disagrees: false,
      straddlesHireLine: false,
      spread: 0,
      lowest: given[0] ?? null,
      highest: given[0] ?? null,
    };
  }

  const sorted = [...given].sort((a, b) => RECOMMENDATION_POSITION[a] - RECOMMENDATION_POSITION[b]);
  const lowest = sorted[0] as Recommendation;
  const highest = sorted[sorted.length - 1] as Recommendation;
  const spread = RECOMMENDATION_POSITION[highest] - RECOMMENDATION_POSITION[lowest];
  const straddlesHireLine = given.some(isPositive) && given.some((r) => !isPositive(r));

  return {
    disagrees: straddlesHireLine || spread >= 2,
    straddlesHireLine,
    spread,
    lowest,
    highest,
  };
}

/** Per-criterion averages across a set of scorecards. */
export function summariseCriteria(
  criteria: readonly AggregateCriterion[],
  scorecards: readonly AggregateScorecard[],
): CriterionAggregate[] {
  return [...criteria]
    .sort((a, b) => a.position - b.position)
    .map((criterion) => {
      const raw = scorecards
        .map((card) => card.scores.find((s) => s.criterionId === criterion.id)?.score)
        .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));

      const average = mean(raw);
      return {
        criterionId: criterion.id,
        name: criterion.name,
        weight: safeWeight(criterion.weight),
        maxScore: criterion.maxScore,
        responses: raw.length,
        mean: average,
        normalised: average === null ? null : normaliseScore(average, criterion.maxScore),
        min: raw.length === 0 ? null : Math.min(...raw),
        max: raw.length === 0 ? null : Math.max(...raw),
      };
    });
}

/**
 * One weighted number for a set of criterion averages, 0..1.
 *
 * Criteria nobody scored are dropped rather than counted as zero: an unscored
 * criterion is missing evidence, and treating it as a bottom score would let a
 * half-filled rubric read as a bad candidate.
 */
export function weightedOverall(aggregates: readonly CriterionAggregate[]): number | null {
  const scored = aggregates.filter(
    (a): a is CriterionAggregate & { normalised: number } => a.normalised !== null,
  );
  if (scored.length === 0) return null;
  const totalWeight = scored.reduce((sum, a) => sum + safeWeight(a.weight), 0);
  if (totalWeight === 0) return null;
  return scored.reduce((sum, a) => sum + a.normalised * safeWeight(a.weight), 0) / totalWeight;
}

/**
 * One interviewer's own weighted average, for the header of their scorecard.
 *
 * Same normalisation as the panel view so the two can be read side by side.
 */
export function scorecardOverall(
  criteria: readonly AggregateCriterion[],
  scores: readonly AggregateScore[],
): number | null {
  return weightedOverall(
    summariseCriteria(criteria, [{ authorId: '', authorName: '', recommendation: null, scores }]),
  );
}

function summariseAutomated(
  runs: readonly AggregateAutomatedRun[] | undefined,
): AutomatedAggregate | null {
  if (!runs || runs.length === 0) return null;
  return {
    runs,
    meanScore: mean(runs.map((r) => r.score)),
    passedCount: runs.reduce((sum, r) => sum + r.passedCount, 0),
    totalCount: runs.reduce((sum, r) => sum + r.totalCount, 0),
  };
}

export function summariseStage(input: AggregateStageInput): StageSignal {
  const recommendations = input.scorecards.map((card) => card.recommendation);
  const criteria = summariseCriteria(input.criteria, input.scorecards);

  return {
    stageId: input.stageId,
    stageName: input.stageName,
    stageType: input.stageType,
    distribution: summariseRecommendations(recommendations),
    criteria,
    overallNormalised: weightedOverall(criteria),
    disagreement: detectDisagreement(recommendations),
    panelSize: input.panelSize,
    submittedCount: input.submittedCount,
    // Never negative: a scorecard can outlive the panel seat that produced it
    // if someone is removed from the panel after submitting.
    outstandingCount: Math.max(0, input.panelSize - input.submittedCount),
    partial: input.submittedCount > input.scorecards.length,
    automated: summariseAutomated(input.automated),
  };
}

/**
 * Roll several stages up to the application.
 *
 * The distribution spans every readable scorecard rather than averaging the
 * per-stage averages: a round with four interviewers is four opinions, and
 * flattening it to one would quietly weight a single-interviewer screen
 * equally with a full panel.
 */
export function summariseApplication(stages: readonly AggregateStageInput[]): ApplicationSignal {
  const stageSignals = stages.map(summariseStage);
  const recommendations = stages.flatMap((stage) =>
    stage.scorecards.map((card) => card.recommendation),
  );

  return {
    stages: stageSignals,
    distribution: summariseRecommendations(recommendations),
    disagreement: detectDisagreement(recommendations),
    panelSize: stageSignals.reduce((sum, s) => sum + s.panelSize, 0),
    submittedCount: stageSignals.reduce((sum, s) => sum + s.submittedCount, 0),
    outstandingCount: stageSignals.reduce((sum, s) => sum + s.outstandingCount, 0),
    partial: stageSignals.some((s) => s.partial),
  };
}

/** 0..1 as a whole-number percentage, for display. */
export function toPercent(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100);
}
