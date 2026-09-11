import { describe, expect, it } from 'vitest';

import { decodeRunSnapshot } from '@/components/workspace/run-cache';

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
