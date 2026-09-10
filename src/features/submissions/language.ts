import type { Language as DbLanguage } from '@/generated/prisma/enums';
import type { Language as RuntimeLanguage } from '@/features/execution/types';

/**
 * Two spellings of the same idea: the database enum is SCREAMING_CASE
 * (`JAVASCRIPT`) and the executor — along with Monaco's language ids and the
 * `Question.starterCode` JSON keys — is lowercase (`javascript`).
 *
 * They are mapped here, once, rather than by sprinkling `.toLowerCase()`
 * around: a total record fails to compile the day a third language lands,
 * whereas a `.toLowerCase()` silently produces a key nothing answers to.
 */

export const DB_TO_RUNTIME_LANGUAGE = {
  JAVASCRIPT: 'javascript',
  PYTHON: 'python',
} as const satisfies Record<DbLanguage, RuntimeLanguage>;

export const RUNTIME_TO_DB_LANGUAGE = {
  javascript: 'JAVASCRIPT',
  python: 'PYTHON',
} as const satisfies Record<RuntimeLanguage, DbLanguage>;

export const LANGUAGE_LABEL = {
  javascript: 'JavaScript',
  python: 'Python',
} as const satisfies Record<RuntimeLanguage, string>;

export function toRuntimeLanguage(language: DbLanguage): RuntimeLanguage {
  return DB_TO_RUNTIME_LANGUAGE[language];
}

export function toDbLanguage(language: RuntimeLanguage): DbLanguage {
  return RUNTIME_TO_DB_LANGUAGE[language];
}
