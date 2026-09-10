import { describe, expect, it } from 'vitest';

import { parseStoredResults } from '@/features/submissions/stored-results';

/**
 * `submissions.results` is a Json column written by the candidate-side runner
 * and read by the admin review screen. It is the seam where a `null`-vs-
 * `undefined` mismatch once blanked the per-test breakdown on every
 * submission in the product, so the shapes that actually reach it are pinned
 * here rather than left to the union to work out.
 */

/** Exactly what `createSubmissionAction` writes, after a JSON round trip. */
function writtenEnvelope(): unknown {
  return {
    tests: [
      {
        testCaseId: 'tc-1',
        description: '',
        status: 'passed',
        input: '1',
        expectedOutput: '1',
        actualOutput: '1',
        stderr: '',
        errorMessage: '',
        // The writer emits `null`, not `undefined`: Prisma's Json input
        // rejects `undefined`, and JSON has no way to carry it anyway.
        errorKind: null,
        weight: 2,
        durationMs: 4,
      },
      {
        testCaseId: 'tc-2',
        description: 'edge case',
        status: 'error',
        input: '2',
        expectedOutput: '4',
        actualOutput: '',
        stderr: 'Traceback',
        errorMessage: 'boom',
        errorKind: 'runtime',
        weight: 3,
        durationMs: 11,
      },
    ],
    score: 40,
    earnedWeight: 2,
    totalWeight: 5,
  };
}

describe('parseStoredResults — the shape the writer actually emits', () => {
  // The regression: `null` on every optional field has to be accepted.
  it('reads the enveloped payload whose optional fields are null', () => {
    const parsed = parseStoredResults(writtenEnvelope());

    expect(parsed.unreadable).toBe(false);
    expect(parsed.tests).toHaveLength(2);
    expect(parsed.tests[0]?.testCaseId).toBe('tc-1');
    expect(parsed.tests[1]?.errorMessage).toBe('boom');
  });

  it('surfaces the envelope’s own optional fields, mapping null to undefined', () => {
    const parsed = parseStoredResults({
      tests: [],
      stdout: 'hello',
      stderr: null,
      fatalError: null,
      executionTimeMs: 42,
    });

    expect(parsed.unreadable).toBe(false);
    expect(parsed.stdout).toBe('hello');
    expect(parsed.stderr).toBeUndefined();
    expect(parsed.fatalError).toBeUndefined();
    expect(parsed.executionTimeMs).toBe(42);
  });

  // Older rows were written as a bare array, before the envelope existed.
  it('reads a bare array of tests', () => {
    const bare = (writtenEnvelope() as { tests: unknown[] }).tests;

    const parsed = parseStoredResults(bare);

    expect(parsed.unreadable).toBe(false);
    expect(parsed.tests).toHaveLength(2);
    expect(parsed.stdout).toBeUndefined();
  });
});

/**
 * "Nothing recorded" and "something is broken" are different messages to an
 * admin, and conflating them is what let the original bug hide: every intact
 * submission reported as empty and nobody was told anything was wrong.
 */
describe('parseStoredResults — empty is not corrupt', () => {
  it.each([
    ['the column default', {}],
    ['a null column', null],
  ])('treats %s as an empty result set rather than corruption', (_label, value) => {
    const parsed = parseStoredResults(value);

    expect(parsed).toMatchObject({ tests: [], unreadable: false });
  });

  it('reads an explicitly empty envelope as an empty result set', () => {
    expect(parseStoredResults({ tests: [] })).toMatchObject({ tests: [], unreadable: false });
  });

  it('reads an empty array as an empty result set', () => {
    expect(parseStoredResults([])).toMatchObject({ tests: [], unreadable: false });
  });
});

describe('parseStoredResults — genuinely corrupt input is reported, not swallowed', () => {
  it.each([
    ['a string', 'nope'],
    ['a number', 42],
    ['an envelope whose tests is not an array', { tests: 'nope' }],
    ['an envelope with no tests key', { score: 100 }],
    ['an array of non-objects', [1, 2, 3]],
    ['an envelope of non-object tests', { tests: [1, 2] }],
  ])('flags %s as unreadable and yields no tests', (_label, value) => {
    const parsed = parseStoredResults(value);

    expect(parsed.unreadable).toBe(true);
    expect(parsed.tests).toEqual([]);
  });
});

/**
 * Within a well-formed test object the parse is forgiving: the review screen
 * showing a slightly-degraded row beats it hiding the submission an admin is
 * trying to look at.
 */
describe('parseStoredResults — per-field coercion', () => {
  it('coerces an unrecognised status to error rather than dropping the test', () => {
    const parsed = parseStoredResults({
      tests: [{ testCaseId: 'tc-1', status: 'exploded', weight: 1, durationMs: 0 }],
    });

    expect(parsed.unreadable).toBe(false);
    expect(parsed.tests[0]?.status).toBe('error');
  });

  it('falls back to safe defaults for missing or wrongly-typed scalars', () => {
    const parsed = parseStoredResults({ tests: [{}] });

    expect(parsed.unreadable).toBe(false);
    expect(parsed.tests[0]).toMatchObject({
      testCaseId: '',
      status: 'error',
      input: '',
      expectedOutput: '',
      actualOutput: '',
      weight: 1,
      durationMs: 0,
    });
  });

  it('keeps the remaining tests when one of them is degraded', () => {
    const parsed = parseStoredResults({
      tests: [
        { testCaseId: 'tc-1', status: 'passed', weight: 1, durationMs: 1 },
        { testCaseId: 'tc-2', status: 42, weight: 'heavy', durationMs: null },
      ],
    });

    expect(parsed.unreadable).toBe(false);
    expect(parsed.tests).toHaveLength(2);
    expect(parsed.tests[0]?.status).toBe('passed');
    expect(parsed.tests[1]?.status).toBe('error');
    expect(parsed.tests[1]?.weight).toBe(1);
  });
});
