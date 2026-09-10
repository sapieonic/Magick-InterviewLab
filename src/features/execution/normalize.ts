/**
 * Output comparison. Pure, no imports, and the single most-argued-about file in
 * any judge.
 *
 * Every rule here exists because a candidate lost a point they should have
 * kept: a trailing newline from `print()`, `\r\n` because they pasted from a
 * Windows editor, `0.30000000000000004` from floating point, `[1, 2]` where the
 * author of the test typed `[1,2]`. None of those are wrong answers, and a
 * grader that says they are is a grader nobody trusts.
 *
 * What we deliberately do NOT do is normalise *inside* a line (collapsing
 * runs of spaces), because plenty of problems are about column alignment or
 * about emitting space-separated tokens, and silently accepting `1  2` for
 * `1 2` hides real bugs.
 */

/** Absolute floor and relative scale for float comparison. */
const EPSILON = 1e-9;

/** A single JSON/JS number literal and nothing else. */
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INFINITY_RE = /^[+-]?Infinity$/;

/**
 * CRLF/CR -> LF, trailing whitespace stripped per line, leading and trailing
 * blank lines removed. Interior blank lines are preserved — they can be
 * meaningful (a grid, a paragraph) and we have no way to know they aren't.
 */
export function normalizeOutput(s: string): string {
  return s
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * Comparison order — deliberately fixed, and worth reading before changing:
 *
 *   1. Normalised exact string equality. The overwhelmingly common case, and
 *      the only one that can never produce a false positive.
 *   2. Numeric tolerance — only when BOTH sides are a single number literal.
 *      `0.1+0.2` printing `0.30000000000000004` must match `0.3`.
 *   3. JSON structural equality — only when both sides parse as JSON. Makes
 *      `[1, 2]` match `[1,2]` and `{"a":1,"b":2}` match `{"b":2,"a":1}`.
 *      Numbers nested inside use the same epsilon as (2), for consistency:
 *      it would be strange for `0.3` to match at the top level but not inside
 *      a one-element array.
 *
 * (2) before (3) is not arbitrary: `JSON.parse('1')` succeeds, so without the
 * ordering a bare number would take the structural path and compare with `===`,
 * losing the tolerance that is the whole point.
 */
export function outputMatches(actual: string, expected: string): boolean {
  const a = normalizeOutput(actual);
  const b = normalizeOutput(expected);

  if (a === b) return true;

  const na = asSingleNumber(a);
  const nb = asSingleNumber(b);
  if (na !== null && nb !== null) return numbersClose(na, nb);

  const ja = tryParseJson(a);
  const jb = tryParseJson(b);
  if (ja.ok && jb.ok) return deepEquals(ja.value, jb.value);

  return false;
}

/**
 * `Number()` is far too permissive for this job: it turns `''` into 0, `'0x1f'`
 * into 31 and `' 1 '` into 1. A judge that treats an empty stdout as the
 * number zero is a judge that passes empty submissions.
 */
export function asSingleNumber(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  if (INFINITY_RE.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (!NUMERIC_RE.test(t)) return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

/**
 * Absolute epsilon for values near zero, relative for large ones. A pure
 * absolute 1e-9 rejects `1e18` vs `1.0000000000000001e18`, which is the same
 * number as far as a double is concerned.
 */
function numbersClose(a: number, b: number): boolean {
  if (a === b) return true; // catches Infinity === Infinity
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  return diff <= EPSILON || diff <= EPSILON * Math.max(Math.abs(a), Math.abs(b));
}

type ParseOutcome = { ok: true; value: unknown } | { ok: false };

function tryParseJson(s: string): ParseOutcome {
  if (s === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch {
    return { ok: false };
  }
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return numbersClose(a, b);
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEquals(item, b[i]));
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(bo, key) && deepEquals(ao[key], bo[key]),
  );
}
