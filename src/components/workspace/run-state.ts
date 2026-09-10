import type { ExecutionResult, Language, TestResult } from '@/features/execution/types';

export type RunPhase = 'idle' | 'running' | 'complete' | 'cancelled' | 'error';

export interface RunState {
  /**
   * Increments on every run. The results list is keyed on it so a second run
   * remounts the rows — without that, a row that failed last time and passes
   * now would keep the expanded state of the previous run.
   */
  id: number;
  phase: RunPhase;
  result: ExecutionResult | null;
  progress: { completed: number; total: number };
  /** Set when the run itself failed (not a test failing) — always human-readable. */
  message: string | null;
  /**
   * The exact buffer and language the result belongs to. Submit reuses the
   * last run only when both still match, so a candidate can never submit a
   * green run for code they have since edited.
   */
  language: Language | null;
  sourceCode: string | null;
}

export const IDLE_RUN: RunState = {
  id: 0,
  phase: 'idle',
  result: null,
  progress: { completed: 0, total: 0 },
  message: null,
  language: null,
  sourceCode: null,
};

export function passedCount(tests: readonly TestResult[]): number {
  return tests.filter((test) => test.status === 'passed').length;
}

/** True when `state` describes a finished run of exactly this code. */
export function runMatches(state: RunState, language: Language, sourceCode: string): boolean {
  return state.phase === 'complete' && state.language === language && state.sourceCode === sourceCode;
}

export function resultOf(state: RunState): ExecutionResult | null {
  return state.phase === 'complete' ? state.result : null;
}
