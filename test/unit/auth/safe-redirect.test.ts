import { describe, expect, it } from 'vitest';
import { safeRedirect } from '@/features/auth/safe-redirect';

describe('safeRedirect', () => {
  it('accepts a same-origin absolute path', () => {
    expect(safeRedirect('/admin')).toBe('/admin');
    expect(safeRedirect('/interview/abc/q/def?x=1')).toBe('/interview/abc/q/def?x=1');
  });

  /**
   * A backslash is normalised to a slash in the authority position, so these
   * all navigate off-site if only `//` is rejected. This is the exact bug
   * that shipped.
   */
  it.each([
    '//evil.example.com/',
    String.raw`/\evil.example.com/pwn`,
    String.raw`/\\evil.example.com/pwn`,
    'https://evil.example.com/',
    'http://evil.example.com',
    '\t/\\evil.example.com',
    '\n//evil.example.com',
    'admin',
    '',
  ])('rejects %j', (value) => {
    expect(safeRedirect(value)).toBeNull();
  });

  it('rejects undefined', () => {
    expect(safeRedirect(undefined)).toBeNull();
  });
});
