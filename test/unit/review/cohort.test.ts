import { describe, expect, it } from 'vitest';

import {
  COHORT_MIN,
  HISTOGRAM_BUCKETS,
  bucketIndex,
  histogram,
  median,
} from '@/features/review/cohort';

/**
 * Cohort context, and the line it is not allowed to cross.
 *
 * This module exists to answer "is 9/12 good here" without ever putting two
 * candidates in an order the system chose, so the suite checks two different
 * kinds of thing. The arithmetic — a middle and a shape — because it is printed
 * beside a person's score and a quiet slip there is a wrong claim rather than a
 * broken page. And the guards around it: the minimum cohort size, and the fact
 * that the bands are fixed rather than drawn from the data.
 */

describe('median', () => {
  it('reports nothing for an empty cohort', () => {
    expect(median([])).toBeNull();
  });

  it('takes the middle value of an odd-sized cohort', () => {
    expect(median([10, 90, 50])).toBe(50);
    expect(median([1, 2, 3, 4, 5])).toBe(3);
  });

  it('averages the two middles of an even-sized cohort', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([40, 10, 30, 20])).toBe(25);
  });

  it('ignores values that are not finite numbers', () => {
    // A missing score arrives as NaN often enough that dropping it has to be
    // the behaviour; letting one through would make the middle NaN and blank
    // the whole panel.
    expect(median([10, Number.NaN, 30, Number.POSITIVE_INFINITY])).toBe(20);
    expect(median([Number.NaN, Number.NEGATIVE_INFINITY])).toBeNull();
  });

  it('leaves the caller’s array exactly as it found it', () => {
    // The sort is the trap: sorting in place would silently reorder the array
    // the page is about to render rows from.
    const scores = [30, 10, 20];
    expect(median(scores)).toBe(20);
    expect(scores).toEqual([30, 10, 20]);
  });
});

describe('COHORT_MIN', () => {
  it('withholds the cohort until five people have finished, because a median of three is one person', () => {
    // Three scores put one person's number in the middle, which reads as an
    // authoritative middle while being nothing of the kind; with two, the
    // median simply is the ranking. Below five the page shows nothing.
    expect(COHORT_MIN).toBe(5);
  });
});

describe('histogram', () => {
  it('lays out five fixed twenty-point bands', () => {
    // Fixed rather than data-derived: bands that move with the data make two
    // assessments look comparable when they are not, and a candidate would
    // change bucket because somebody else submitted.
    const buckets = histogram([]);
    expect(buckets).toHaveLength(HISTOGRAM_BUCKETS);
    expect(buckets.map((bucket) => [bucket.from, bucket.to])).toEqual([
      [0, 19],
      [20, 39],
      [40, 59],
      [60, 79],
      [80, 100],
    ]);
    expect(buckets.every((bucket) => bucket.count === 0)).toBe(true);
  });

  it('puts a perfect score in the top band rather than a sixth one', () => {
    const buckets = histogram([100]);
    expect(buckets).toHaveLength(HISTOGRAM_BUCKETS);
    expect(buckets[HISTOGRAM_BUCKETS - 1]?.count).toBe(1);
  });

  it('puts a zero in the first band', () => {
    const buckets = histogram([0]);
    expect(buckets[0]?.count).toBe(1);
    expect(buckets.slice(1).every((bucket) => bucket.count === 0)).toBe(true);
  });

  it('places each score in the band its own bounds claim', () => {
    const buckets = histogram([0, 19, 20, 39, 40, 59, 60, 79, 80, 100]);
    expect(buckets.map((bucket) => bucket.count)).toEqual([2, 2, 2, 2, 2]);
  });

  it('accounts for every finite score exactly once', () => {
    const scores = [0, 5, 33, 60, 79.5, 88, 100, Number.NaN, Number.POSITIVE_INFINITY];
    const finite = scores.filter((score) => Number.isFinite(score)).length;

    const total = histogram(scores).reduce((sum, bucket) => sum + bucket.count, 0);
    expect(total).toBe(finite);
    expect(total).toBe(7);
  });
});

describe('bucketIndex', () => {
  it('names the band a score falls in', () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(19.9)).toBe(0);
    expect(bucketIndex(20)).toBe(1);
    expect(bucketIndex(59)).toBe(2);
    expect(bucketIndex(80)).toBe(4);
    expect(bucketIndex(100)).toBe(4);
  });

  it('clamps a score that falls outside the scale instead of indexing off the end', () => {
    // Nothing should produce these, which is exactly why the clamp has to
    // hold: an out-of-range score must land in a band, not vanish.
    expect(bucketIndex(-1)).toBe(0);
    expect(bucketIndex(-1000)).toBe(0);
    expect(bucketIndex(101)).toBe(HISTOGRAM_BUCKETS - 1);
    expect(bucketIndex(1000)).toBe(HISTOGRAM_BUCKETS - 1);
  });
});
