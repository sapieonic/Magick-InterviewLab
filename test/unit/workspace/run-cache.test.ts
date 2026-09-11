import { describe, expect, it } from 'vitest';

import { clipResultForCache, decodeRunSnapshot } from '@/components/workspace/run-cache';
import type { ExecutionResult } from '@/features/execution/types';

/** A well-formed serialized snapshot; overrides let each test corrupt one part. */
function raw(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    language: 'javascript',
    sourceCode: 'console.log(1)',
    savedAt: 1_700_000_000_000,
    result: { tests: [{ status: 'passed' }], score: 100 },
    ...overrides,
  });
}

describe('decodeRunSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    const snapshot = decodeRunSnapshot(raw());
    expect(snapshot).not.toBeNull();
    expect(snapshot?.language).toBe('javascript');
    expect(snapshot?.sourceCode).toBe('console.log(1)');
    expect(snapshot?.result.tests).toHaveLength(1);
  });

  it('accepts python as a language', () => {
    expect(decodeRunSnapshot(raw({ language: 'python' }))?.language).toBe('python');
  });

  // Everything below must degrade to "no cached run" rather than throw, so a
  // corrupt or older-format entry can never crash the workspace on load.
  it('rejects invalid JSON', () => {
    expect(decodeRunSnapshot('{ not json')).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(decodeRunSnapshot('42')).toBeNull();
    expect(decodeRunSnapshot('null')).toBeNull();
  });

  it('rejects an unknown language', () => {
    expect(decodeRunSnapshot(raw({ language: 'ruby' }))).toBeNull();
  });

  it('rejects a missing source buffer', () => {
    expect(decodeRunSnapshot(raw({ sourceCode: undefined }))).toBeNull();
  });

  it('rejects a missing savedAt timestamp', () => {
    expect(decodeRunSnapshot(raw({ savedAt: 'soon' }))).toBeNull();
  });

  it('rejects a result without a tests array — the panel needs it to render', () => {
    expect(decodeRunSnapshot(raw({ result: { score: 100 } }))).toBeNull();
    expect(decodeRunSnapshot(raw({ result: null }))).toBeNull();
  });
});

describe('clipResultForCache', () => {
  // A run whose output is hundreds of KB must be bounded before it goes to
  // localStorage, or it could exhaust the quota the draft mirror relies on.
  it('clips oversized per-test output while preserving structure', () => {
    const huge = 'x'.repeat(50_000);
    const result: ExecutionResult = {
      status: 'passed',
      tests: [
        {
          testCaseId: 't1',
          status: 'passed',
          input: huge,
          expectedOutput: huge,
          actualOutput: huge,
          stderr: huge,
          errorMessage: huge,
          weight: 1,
          durationMs: 5,
        },
      ],
      stdout: huge,
    };

    const clipped = clipResultForCache(result);
    const test = clipped.tests[0]!;
    expect(test.actualOutput.length).toBeLessThanOrEqual(20_000);
    expect(test.input.length).toBeLessThanOrEqual(20_000);
    expect(test.expectedOutput.length).toBeLessThanOrEqual(20_000);
    expect(test.stderr!.length).toBeLessThanOrEqual(20_000);
    expect(test.errorMessage!.length).toBeLessThanOrEqual(4_000);
    expect(clipped.stdout!.length).toBeLessThanOrEqual(20_000);
    // Structure and small fields are preserved verbatim.
    expect(test.testCaseId).toBe('t1');
    expect(test.status).toBe('passed');
    expect(test.weight).toBe(1);
    expect(clipped.status).toBe('passed');
  });

  it('leaves a small result untouched in content', () => {
    const result: ExecutionResult = {
      status: 'failed',
      tests: [
        {
          testCaseId: 't1',
          status: 'failed',
          input: '1',
          expectedOutput: '2',
          actualOutput: '3',
          weight: 2,
          durationMs: 9,
        },
      ],
    };

    expect(clipResultForCache(result)).toEqual(result);
  });
});
