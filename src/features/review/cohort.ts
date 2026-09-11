/**
 * Cohort *context*, and deliberately not cohort rank.
 *
 * The distinction this module exists to hold: a reviewer reading one
 * candidate's 9/12 has no idea whether that is the best anyone managed or the
 * worst, and the question is fair. "Rank 2 of 14" answers it by ordering
 * people, which is the automated selection procedure the rest of this codebase
 * refuses to build — see `scorecard/aggregate.ts`. A median and a distribution
 * answer the same question without ever putting two candidates in an order the
 * system chose.
 *
 * So there is no `rank()` here, no percentile, and no "top quartile" label, and
 * there should never be one. What there is: a middle, and a shape.
 *
 * Pure — no Prisma, no `server-only`, no dates — so the arithmetic is pinned by
 * unit tests rather than inferred from a page.
 */

/**
 * Below this many completed candidates there is no cohort, only a comparison
 * wearing a cohort's clothes.
 *
 * Five is a judgement, and the reasoning is that a "median" of three is one
 * person's score, which reads as an authoritative middle while being nothing of
 * the kind — and with two, the median *is* the ranking. Where the cohort is
 * this small the honest answer is to show nothing, which is what the page does.
 */
export const COHORT_MIN = 5;

/** The median, or null for an empty set. Even counts average the two middles. */
export function median(values: readonly number[]): number | null {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface HistogramBucket {
  /** Inclusive lower bound of the bucket, on the 0..100 score scale. */
  from: number;
  /** Inclusive upper bound. The top bucket ends at 100. */
  to: number;
  count: number;
}

export const HISTOGRAM_BUCKETS = 5;

/**
 * The shape of a cohort's scores, in five fixed 20-point bands.
 *
 * Fixed rather than data-derived: bands that move with the data make two
 * assessments' histograms look comparable when they are not, and a candidate
 * can shift bucket because somebody else submitted.
 */
export function histogram(scores: readonly number[]): HistogramBucket[] {
  const width = 100 / HISTOGRAM_BUCKETS;
  const buckets: HistogramBucket[] = Array.from({ length: HISTOGRAM_BUCKETS }, (_, index) => ({
    from: Math.round(index * width),
    to: index === HISTOGRAM_BUCKETS - 1 ? 100 : Math.round((index + 1) * width) - 1,
    count: 0,
  }));

  for (const score of scores) {
    if (!Number.isFinite(score)) continue;
    const bucket = buckets[bucketIndex(score)];
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

/** Which band a score falls in. 100 belongs to the top band, not a sixth one. */
export function bucketIndex(score: number): number {
  const clamped = Math.min(Math.max(score, 0), 100);
  return Math.min(Math.floor((clamped / 100) * HISTOGRAM_BUCKETS), HISTOGRAM_BUCKETS - 1);
}
