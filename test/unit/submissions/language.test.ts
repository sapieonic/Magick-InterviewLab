import { describe, expect, it } from 'vitest';

import {
  DB_TO_RUNTIME_LANGUAGE,
  LANGUAGE_LABEL,
  RUNTIME_TO_DB_LANGUAGE,
  toDbLanguage,
  toRuntimeLanguage,
} from '@/features/submissions/language';

/**
 * The database enum (`JAVASCRIPT`) and the executor / Monaco / starter-code
 * key (`javascript`) are two spellings of one idea. TypeScript's `satisfies`
 * already proves both records are total; what it cannot prove is that they
 * are inverses of each other — a transposed entry would compile and would
 * silently hand the executor a language the candidate did not pick, or look
 * up starter code under a key nothing answers to.
 */
describe('language mapping', () => {
  it('is a bijection: every language survives a round trip in both directions', () => {
    for (const db of Object.keys(DB_TO_RUNTIME_LANGUAGE) as Array<
      keyof typeof DB_TO_RUNTIME_LANGUAGE
    >) {
      expect(toDbLanguage(toRuntimeLanguage(db))).toBe(db);
    }
    for (const runtime of Object.keys(RUNTIME_TO_DB_LANGUAGE) as Array<
      keyof typeof RUNTIME_TO_DB_LANGUAGE
    >) {
      expect(toRuntimeLanguage(toDbLanguage(runtime))).toBe(runtime);
    }
  });

  // The runtime id is also the `Question.starterCode` JSON key, so it has to
  // be the lowercase form and not merely *some* stable string.
  it('maps each database enum to its lowercase runtime id', () => {
    expect(toRuntimeLanguage('JAVASCRIPT')).toBe('javascript');
    expect(toRuntimeLanguage('PYTHON')).toBe('python');
  });

  it('labels every runtime language for the UI', () => {
    for (const runtime of Object.keys(RUNTIME_TO_DB_LANGUAGE) as Array<
      keyof typeof RUNTIME_TO_DB_LANGUAGE
    >) {
      expect(LANGUAGE_LABEL[runtime]).toBeTruthy();
    }
  });
});
