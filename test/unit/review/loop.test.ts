import { describe, expect, it } from 'vitest';

import {
  EMPTY_ROLL_UP,
  REVIEW_LOOP_STEPS,
  countLate,
  daysSince,
  deriveLoopStep,
  elapsedMs,
  rollUpSubmissions,
  type LoopStepInput,
  type ReviewLoopStep,
  type RollUpSubmission,
} from '@/features/review/loop';
import type { Language, SubmissionTrigger } from '@/generated/prisma/enums';

/**
 * The numbers and the labels the review queue is read from.
 *
 * Two reasons this module gets its own suite rather than being inferred from a
 * rendered page. The first is `deriveLoopStep`, where the *order* of the
 * branches is the behaviour: every one of them is reachable on its own, so the
 * only thing a test can actually catch is a precedence that has quietly moved,
 * and that needs cases written against the orderings rather than the branches.
 * The second is `rollUpSubmissions`, which produces a percentage printed next
 * to a person's name — an arithmetic slip there is not a broken screen, it is a
 * wrong number that reads as authoritative.
 */

const T0 = new Date('2026-03-10T09:00:00Z');
const MINUTE = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Minutes after `T0`, so the orderings in a fixture read as a timeline. */
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * MINUTE);
}

function submission(overrides: Partial<RollUpSubmission> = {}): RollUpSubmission {
  return {
    questionId: 'q1',
    score: 100,
    passedCount: 1,
    totalCount: 1,
    submittedAt: at(0),
    trigger: 'MANUAL' as SubmissionTrigger,
    language: 'JAVASCRIPT' as Language,
    ...overrides,
  };
}

function loopInput(overrides: Partial<LoopStepInput> = {}): LoopStepInput {
  return {
    applicationClosed: false,
    hasDecision: false,
    allStagesResolved: false,
    codeRead: true,
    outstandingScorecards: 0,
    ...overrides,
  };
}

describe('deriveLoopStep', () => {
  it('calls a closed application closed however much is still outstanding', () => {
    // HIRED, REJECTED and WITHDRAWN all arrive here as `applicationClosed`.
    // Nothing is owed on an application that is over, so the scorecards nobody
    // wrote and the decision somebody recorded are both beside the point.
    expect(
      deriveLoopStep(
        loopInput({
          applicationClosed: true,
          hasDecision: true,
          allStagesResolved: false,
          codeRead: false,
          outstandingScorecards: 4,
        }),
      ),
    ).toBe('CLOSED');
  });

  it('is never ready to decide once a decision exists', () => {
    // CLOSEOUT outranks READY. An application somebody has already decided is
    // not waiting for that decision again, even when every round is settled.
    expect(deriveLoopStep(loopInput({ hasDecision: true, allStagesResolved: true }))).toBe(
      'CLOSEOUT',
    );
  });

  it('reports a settled application as ready even when nobody has read the code', () => {
    // READY outranks UNREAD: there is no round left to run, so the work in
    // front of the queue is the decision, not the reading.
    expect(deriveLoopStep(loopInput({ allStagesResolved: true, codeRead: false }))).toBe('READY');
  });

  it('asks for the code to be read before it asks for the scorecard', () => {
    // UNREAD outranks PANEL. Reading the code is the prerequisite for writing
    // the scorecard, so chasing a panelist for a scorecard they are not yet in
    // a position to write is the wrong instruction.
    expect(deriveLoopStep(loopInput({ codeRead: false, outstandingScorecards: 2 }))).toBe('UNREAD');
  });

  it('names the panel once the code has been read and a scorecard is still owed', () => {
    expect(deriveLoopStep(loopInput({ codeRead: true, outstandingScorecards: 1 }))).toBe('PANEL');
  });

  it('treats read, up to date and unfinished as in flight rather than as a problem', () => {
    // The residue, and deliberately a neutral label: nothing is wrong here, a
    // later round simply has not happened yet.
    expect(
      deriveLoopStep(
        loopInput({
          codeRead: true,
          outstandingScorecards: 0,
          allStagesResolved: false,
          hasDecision: false,
        }),
      ),
    ).toBe('IN_FLIGHT');
  });

  it('returns one of the six steps for every combination of its inputs', () => {
    // Totality is a load-bearing claim: the queue buckets every row it builds,
    // so an input that fell through would be a row with no home.
    const bools = [false, true];
    let seen = 0;
    const produced = new Set<ReviewLoopStep>();

    for (const applicationClosed of bools) {
      for (const hasDecision of bools) {
        for (const allStagesResolved of bools) {
          for (const codeRead of bools) {
            for (const outstandingScorecards of [0, 1, 7]) {
              const step = deriveLoopStep({
                applicationClosed,
                hasDecision,
                allStagesResolved,
                codeRead,
                outstandingScorecards,
              });
              expect(REVIEW_LOOP_STEPS).toContain(step);
              produced.add(step);
              seen += 1;
            }
          }
        }
      }
    }

    expect(seen).toBe(48);
    // And every step is reachable, so none of the six is dead labelling.
    expect([...produced].sort()).toEqual([...REVIEW_LOOP_STEPS].sort());
  });
});

describe('rollUpSubmissions', () => {
  it('gives a candidate who answered nothing no score rather than a zero', () => {
    // `null`, not 0. Zero is a result; a candidate who never submitted has not
    // produced one, and printing 0 next to their name would defame them.
    const rolled = rollUpSubmissions([], 'latest');
    expect(rolled).toEqual(EMPTY_ROLL_UP);
    expect(rolled.score).toBeNull();
  });

  it('counts every attempt but reports one row per question', () => {
    const rolled = rollUpSubmissions(
      [
        submission({ submittedAt: at(1) }),
        submission({ submittedAt: at(2) }),
        submission({ submittedAt: at(3) }),
      ],
      'latest',
    );

    expect(rolled.attempts).toBe(3);
    expect(rolled.questionsAnswered).toBe(1);
  });

  it('takes the final answer under latest even when an earlier one scored higher', () => {
    // The regression has to stay visible: a candidate whose last edit broke a
    // passing test left behind a broken answer, and that is what they left.
    const attempts = [
      submission({ score: 100, passedCount: 5, totalCount: 5, submittedAt: at(1) }),
      submission({ score: 40, passedCount: 2, totalCount: 5, submittedAt: at(2) }),
    ];

    const rolled = rollUpSubmissions(attempts, 'latest');
    expect(rolled.score).toBe(40);
    expect(rolled.passedCount).toBe(2);
    expect(rolled.totalCount).toBe(5);
  });

  it('takes the high-water mark under best', () => {
    const attempts = [
      submission({ score: 100, passedCount: 5, totalCount: 5, submittedAt: at(1) }),
      submission({ score: 40, passedCount: 2, totalCount: 5, submittedAt: at(2) }),
    ];

    const rolled = rollUpSubmissions(attempts, 'best');
    expect(rolled.score).toBe(100);
    expect(rolled.passedCount).toBe(5);
  });

  it('gives a tie to the later submission under both metrics', () => {
    // Two attempts scoring the same means the candidate changed something
    // without changing the outcome, and the later one is still what they left.
    // The chosen row is identified by its language, which the score cannot.
    const earlier = submission({
      score: 50,
      submittedAt: at(1),
      language: 'JAVASCRIPT' as Language,
    });
    const later = submission({ score: 50, submittedAt: at(2), language: 'PYTHON' as Language });

    for (const metric of ['latest', 'best'] as const) {
      // Both orderings of the input, because the incumbent is whichever row
      // the reducer happened to see first.
      expect(rollUpSubmissions([earlier, later], metric).languages).toEqual(['PYTHON']);
      expect(rollUpSubmissions([later, earlier], metric).languages).toEqual(['PYTHON']);
    }
  });

  it('averages the questions rather than dividing the tests', () => {
    // The two answers differ here on purpose. Summing the fractions gives
    // 3/12 = 25%, which weights the ten-test question five times the two-test
    // one; the mean over questions treats each question as one question.
    const rolled = rollUpSubmissions(
      [
        submission({ questionId: 'q1', score: 10, passedCount: 1, totalCount: 10 }),
        submission({ questionId: 'q2', score: 100, passedCount: 2, totalCount: 2 }),
      ],
      'latest',
    );

    expect(rolled.score).toBe(55);
    expect(rolled.passedCount).toBe(3);
    expect(rolled.totalCount).toBe(12);
    // Stated the other way round, so the failure says which answer was given.
    expect(rolled.score).not.toBe(Math.round((3 / 12) * 100));
  });

  it('counts only the chosen submissions as auto-submitted', () => {
    // Three attempts, two of them produced by the timer — but the answer this
    // roll-up reports is the manual one, so nothing here was auto-submitted.
    const rolled = rollUpSubmissions(
      [
        submission({ submittedAt: at(1), trigger: 'AUTO_DEADLINE' as SubmissionTrigger }),
        submission({ submittedAt: at(2), trigger: 'AUTO_DEADLINE' as SubmissionTrigger }),
        submission({ submittedAt: at(3), trigger: 'MANUAL' as SubmissionTrigger }),
      ],
      'latest',
    );

    expect(rolled.attempts).toBe(3);
    expect(rolled.autoSubmitted).toBe(0);
  });

  it('counts an auto-submitted answer once it is the one being reported', () => {
    const rolled = rollUpSubmissions(
      [
        submission({ questionId: 'q1', submittedAt: at(1) }),
        submission({
          questionId: 'q1',
          submittedAt: at(2),
          trigger: 'AUTO_DEADLINE' as SubmissionTrigger,
        }),
        submission({
          questionId: 'q2',
          submittedAt: at(3),
          trigger: 'AUTO_DEADLINE' as SubmissionTrigger,
        }),
      ],
      'latest',
    );

    expect(rolled.questionsAnswered).toBe(2);
    expect(rolled.autoSubmitted).toBe(2);
  });

  it('lists each language used once, in a stable order', () => {
    const rolled = rollUpSubmissions(
      [
        submission({ questionId: 'q1', language: 'PYTHON' as Language }),
        submission({ questionId: 'q2', language: 'JAVASCRIPT' as Language }),
        submission({ questionId: 'q3', language: 'PYTHON' as Language }),
      ],
      'latest',
    );

    expect(rolled.languages).toEqual(['JAVASCRIPT', 'PYTHON']);
  });

  it('lists only the languages of the answers it reports', () => {
    // A language the candidate abandoned is not a language the facet should
    // find them under.
    const rolled = rollUpSubmissions(
      [
        submission({ questionId: 'q1', submittedAt: at(1), language: 'PYTHON' as Language }),
        submission({ questionId: 'q1', submittedAt: at(2), language: 'JAVASCRIPT' as Language }),
      ],
      'latest',
    );

    expect(rolled.languages).toEqual(['JAVASCRIPT']);
  });
});

describe('elapsedMs', () => {
  it('reports nothing when the assessment has not both started and finished', () => {
    expect(elapsedMs(null, at(30))).toBeNull();
    expect(elapsedMs(at(0), null)).toBeNull();
    expect(elapsedMs(null, null)).toBeNull();
  });

  it('reports nothing rather than a negative duration when the clocks disagree', () => {
    // A clock adjustment between the two stamps is the only way this happens,
    // and "-4 minutes" on a screen is worse than a blank.
    expect(elapsedMs(at(30), at(26))).toBeNull();
  });

  it('measures wall clock between the two stamps', () => {
    expect(elapsedMs(at(0), at(45))).toBe(45 * MINUTE);
    expect(elapsedMs(at(10), at(10))).toBe(0);
  });
});

describe('countLate', () => {
  const startedAt = at(0);
  const late = [submission({ submittedAt: at(61) })];

  it('finds nobody late on an untimed interview', () => {
    expect(countLate(late, startedAt, null)).toBe(0);
  });

  it('finds nobody late on an assessment that was never started', () => {
    // Without a start there is no deadline to be late against, and inventing
    // one from the assignment's creation would call every slow starter late.
    expect(countLate(late, null, 60)).toBe(0);
  });

  it('counts only the answers that landed after the deadline', () => {
    const submissions = [
      submission({ submittedAt: at(10) }),
      submission({ submittedAt: at(59) }),
      submission({ submittedAt: at(61) }),
      submission({ submittedAt: at(600) }),
    ];

    expect(countLate(submissions, startedAt, 60)).toBe(2);
  });

  it('does not call an answer on the deadline late', () => {
    // The boundary belongs to the candidate: a submission stamped at exactly
    // the deadline made it.
    expect(countLate([submission({ submittedAt: at(60) })], startedAt, 60)).toBe(0);
    expect(
      countLate([submission({ submittedAt: new Date(at(60).getTime() + 1) })], startedAt, 60),
    ).toBe(1);
  });
});

describe('daysSince', () => {
  const now = new Date('2026-03-20T12:00:00Z');

  it('reports nothing when there is no date to count from', () => {
    expect(daysSince(null, now)).toBeNull();
  });

  it('counts whole days and discards the part day', () => {
    expect(daysSince(new Date(now.getTime() - 3 * DAY_MS), now)).toBe(3);
    expect(daysSince(new Date(now.getTime() - (3 * DAY_MS + 23 * 60 * MINUTE)), now)).toBe(3);
    expect(daysSince(now, now)).toBe(0);
  });

  it('never reports a negative age for a date in the future', () => {
    // A scheduled-ahead stamp is a data problem, not a candidate who has been
    // waiting minus two days.
    expect(daysSince(new Date(now.getTime() + 2 * DAY_MS), now)).toBe(0);
  });
});
