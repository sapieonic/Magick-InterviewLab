/**
 * Output comparison is where a judge earns or loses trust, and every case here
 * is one a candidate would (rightly) complain about if it went the other way.
 */

import { describe, expect, it } from 'vitest';

import { asSingleNumber, normalizeOutput, outputMatches } from '@/features/execution/normalize';

describe('normalizeOutput', () => {
  it('leaves already-clean output untouched', () => {
    expect(normalizeOutput('1\n2\n3')).toBe('1\n2\n3');
  });

  it('converts CRLF and lone CR to LF', () => {
    expect(normalizeOutput('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips trailing spaces and tabs from every line', () => {
    expect(normalizeOutput('a   \nb\t\t\nc')).toBe('a\nb\nc');
  });

  it('strips leading and trailing blank lines', () => {
    expect(normalizeOutput('\n\n  \nhello\n\n\n')).toBe('hello');
  });

  it('preserves interior blank lines, which can be meaningful', () => {
    expect(normalizeOutput('a\n\nb')).toBe('a\n\nb');
  });

  it('does not collapse runs of spaces inside a line', () => {
    expect(normalizeOutput('1  2')).toBe('1  2');
  });

  it('reduces whitespace-only output to the empty string', () => {
    expect(normalizeOutput('   \n\t\n  ')).toBe('');
    expect(normalizeOutput('')).toBe('');
  });

  it('handles the single trailing newline every print() produces', () => {
    expect(normalizeOutput('42\n')).toBe('42');
  });
});

describe('outputMatches — exact path', () => {
  it('matches identical output', () => {
    expect(outputMatches('hello', 'hello')).toBe(true);
  });

  it('ignores a trailing newline', () => {
    expect(outputMatches('42\n', '42')).toBe(true);
  });

  it('ignores CRLF from a Windows editor', () => {
    expect(outputMatches('a\r\nb\r\n', 'a\nb')).toBe(true);
  });

  it('ignores trailing whitespace on a line', () => {
    expect(outputMatches('a \nb\t', 'a\nb')).toBe(true);
  });

  it('rejects genuinely different text', () => {
    expect(outputMatches('abc', 'abd')).toBe(false);
  });

  it('rejects a missing line', () => {
    expect(outputMatches('1\n2', '1\n2\n3')).toBe(false);
  });

  it('treats two empty outputs as equal', () => {
    expect(outputMatches('', '   \n ')).toBe(true);
  });

  it('does not treat empty output as the number zero', () => {
    expect(outputMatches('', '0')).toBe(false);
  });

  it('is whitespace-sensitive inside a line', () => {
    expect(outputMatches('1  2', '1 2')).toBe(false);
  });
});

describe('outputMatches — numeric path', () => {
  it('absorbs binary floating point error', () => {
    expect(outputMatches(String(0.1 + 0.2), '0.3')).toBe(true);
  });

  it('matches differently spelled equal numbers', () => {
    expect(outputMatches('1.0', '1')).toBe(true);
    expect(outputMatches('1e3', '1000')).toBe(true);
    expect(outputMatches('-0.5', '-.5')).toBe(true);
  });

  it('uses a relative epsilon so large magnitudes still compare', () => {
    expect(outputMatches('1000000000000000000', '1000000000000000001')).toBe(true);
  });

  it('still rejects numbers that differ meaningfully', () => {
    expect(outputMatches('0.3', '0.4')).toBe(false);
    expect(outputMatches('1', '1.0000001')).toBe(false);
  });

  it('matches infinities', () => {
    expect(outputMatches('Infinity', 'Infinity')).toBe(true);
    expect(outputMatches('-Infinity', 'Infinity')).toBe(false);
  });

  it('does not take the numeric path for multi-token output', () => {
    expect(outputMatches('1 2', '1 2')).toBe(true);
    expect(outputMatches('1 2', '1  2')).toBe(false);
  });
});

describe('outputMatches — JSON structural path', () => {
  it('ignores whitespace inside a JSON array', () => {
    expect(outputMatches('[1, 2]', '[1,2]')).toBe(true);
  });

  it('ignores object key order', () => {
    expect(outputMatches('{"a":1,"b":2}', '{"b": 2, "a": 1}')).toBe(true);
  });

  it('compares nested structures deeply', () => {
    expect(outputMatches('[[1,2],[3]]', '[ [ 1, 2 ], [ 3 ] ]')).toBe(true);
  });

  it('applies the numeric epsilon inside JSON too', () => {
    expect(outputMatches(`[${0.1 + 0.2}]`, '[0.3]')).toBe(true);
  });

  it('rejects different lengths, values and key sets', () => {
    expect(outputMatches('[1,2]', '[1,2,3]')).toBe(false);
    expect(outputMatches('[1,2]', '[2,1]')).toBe(false);
    expect(outputMatches('{"a":1}', '{"b":1}')).toBe(false);
    expect(outputMatches('{"a":1}', '{"a":1,"b":2}')).toBe(false);
  });

  it('does not conflate JSON types', () => {
    expect(outputMatches('true', '1')).toBe(false);
    expect(outputMatches('null', '"null"')).toBe(false);
  });

  it('falls back to text comparison when only one side is JSON', () => {
    expect(outputMatches('[1,2]', 'not json')).toBe(false);
  });
});

describe('asSingleNumber', () => {
  it('parses well-formed numbers', () => {
    expect(asSingleNumber('42')).toBe(42);
    expect(asSingleNumber(' -3.5 ')).toBe(-3.5);
    expect(asSingleNumber('1e-3')).toBe(0.001);
    expect(asSingleNumber('+7')).toBe(7);
  });

  it('refuses everything Number() would silently coerce', () => {
    expect(asSingleNumber('')).toBeNull();
    expect(asSingleNumber('   ')).toBeNull();
    expect(asSingleNumber('0x10')).toBeNull();
    expect(asSingleNumber('1 2')).toBeNull();
    expect(asSingleNumber('abc')).toBeNull();
    expect(asSingleNumber('NaN')).toBeNull();
    expect(asSingleNumber('12px')).toBeNull();
  });

  it('recognises infinities', () => {
    expect(asSingleNumber('Infinity')).toBe(Infinity);
    expect(asSingleNumber('-Infinity')).toBe(-Infinity);
  });
});
