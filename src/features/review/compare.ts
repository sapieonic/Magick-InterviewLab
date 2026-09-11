import 'server-only';
import { prisma } from '@/lib/db/prisma';
import { can, isStaff } from '@/features/auth/capabilities';
import { canViewApplication } from '@/features/pipeline/access';
import { getApplicationScorecard } from '@/features/scorecard/queries';
import { elapsedMs, rollUpSubmissions, type ReviewMetric } from './loop';
import { COHORT_MIN, histogram, median, type HistogramBucket } from './cohort';
import type { SessionUser } from '@/features/auth/session';
import type { ApplicationSignal } from '@/features/scorecard/aggregate';
import type { Language, SubmissionTrigger } from '@/generated/prisma/enums';

/**
 * Two to four candidates on one assessment, side by side.
 *
 * The rules this read model holds, all of which are easy to lose the moment a
 * table has more than one candidate in it:
 *
 *  1. **Selection order is preserved.** Nothing here sorts by score. The
 *     caller's order is the column order, so the page cannot imply a ranking
 *     the system produced.
 *  2. **Same assessment or nothing.** Aligning question rows across two
 *     different question sets produces a grid that looks comparable and is
 *     not, so a mismatch is refused with the titles named rather than rendered.
 *  3. **Cohort context, never cohort rank.** See `cohort.ts`. The distribution
 *     is withheld entirely below `COHORT_MIN` completed candidates.
 *  4. **Elapsed is per candidate and never in the cohort column.** A median
 *     elapsed turns duration into a comparator, and duration is the one number
 *     here that is an accommodation risk rather than merely a weak signal.
 *  5. **The blind rule survives aggregation.** Human rounds come from
 *     `getApplicationScorecard`, which already filters per viewer, so a
 *     panellist who owes a scorecard sees the same nothing here as there.
 */

export const MAX_COMPARE = 4;
export const MIN_COMPARE = 2;

export interface ComparePerQuestion {
  questionId: string;
  title: string;
  position: number;
  /** Null when this candidate never answered the question. */
  passedCount: number | null;
  totalCount: number | null;
  score: number | null;
  attempts: number;
  autoSubmitted: boolean;
}

export interface CompareCandidate {
  applicationId: string;
  candidateName: string;
  candidateEmail: string;
  jobRoleTitle: string | null;
  status: string;
  elapsedMs: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lateCount: number;
  attempts: number;
  questionsAnswered: number;
  passedCount: number;
  totalCount: number;
  score: number | null;
  languages: Language[];
  perQuestion: ComparePerQuestion[];
  signal: ApplicationSignal;
  decision: { outcome: string; decidedAt: Date } | null;
}

export interface CohortQuestion {
  questionId: string;
  title: string;
  position: number;
  /** Median of the completed cohort's chosen submission for this question. */
  medianScore: number | null;
  medianPassed: number | null;
  totalCount: number | null;
}

export interface CompareCohort {
  /** Candidates who have *completed* the assessment, this selection included. */
  size: number;
  /** False below `COHORT_MIN`; the page then shows no cohort column at all. */
  shown: boolean;
  medianScore: number | null;
  questions: CohortQuestion[];
  distribution: HistogramBucket[];
}

export interface CompareMismatch {
  kind: 'MIXED_ASSESSMENTS';
  assessments: Array<{ candidateName: string; interviewTitle: string | null }>;
}

export interface CompareView {
  interviewId: string;
  interviewTitle: string;
  metric: ReviewMetric;
  questions: Array<{ questionId: string; title: string; position: number }>;
  candidates: CompareCandidate[];
  cohort: CompareCohort;
}

export type CompareResult =
  | { ok: true; view: CompareView }
  | { ok: false; reason: 'NOT_ENOUGH' | 'TOO_MANY' | 'NOT_FOUND'; mismatch?: undefined }
  | { ok: false; reason: 'MISMATCH'; mismatch: CompareMismatch };

interface RollUpRow {
  questionId: string;
  score: number;
  passedCount: number;
  totalCount: number;
  submittedAt: Date;
  trigger: SubmissionTrigger;
  language: Language;
}

export async function getComparison(
  viewer: SessionUser,
  applicationIds: readonly string[],
  metric: ReviewMetric = 'latest',
): Promise<CompareResult> {
  if (!isStaff(viewer.role) || !can(viewer.role, 'VIEW_ALL_APPLICATIONS')) {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  // Order-preserving dedupe: the caller's order is the column order.
  const ids = [...new Set(applicationIds)];
  if (ids.length < MIN_COMPARE) return { ok: false, reason: 'NOT_ENOUGH' };
  if (ids.length > MAX_COMPARE) return { ok: false, reason: 'TOO_MANY' };

  // Access is asked per application rather than once for the set: a viewer who
  // may read three of four must not get a comparison that quietly drops one.
  const allowed = await Promise.all(ids.map((id) => canViewApplication(viewer, id)));
  if (allowed.some((yes) => !yes)) return { ok: false, reason: 'NOT_FOUND' };

  const applications = await prisma.application.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      candidate: { select: { id: true, name: true, email: true } },
      jobRole: { select: { title: true } },
      decision: { select: { outcome: true, decidedAt: true } },
      stages: {
        where: { type: 'CODING_ASSESSMENT' },
        orderBy: { position: 'asc' },
        select: {
          assignment: {
            select: {
              startedAt: true,
              completedAt: true,
              interview: { select: { id: true, title: true, durationMinutes: true } },
            },
          },
        },
      },
    },
  });
  if (applications.length !== ids.length) return { ok: false, reason: 'NOT_FOUND' };

  const byId = new Map(applications.map((row) => [row.id, row]));
  const ordered = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });

  // The latest coding round on each, matching what the queue's row is about.
  const assessments = ordered.map((row) => {
    const coding = row.stages.filter((stage) => stage.assignment);
    return coding.length > 0 ? (coding[coding.length - 1]?.assignment ?? null) : null;
  });

  const interviewIds = new Set(assessments.flatMap((a) => (a ? [a.interview.id] : ['<none>'])));
  if (interviewIds.size !== 1) {
    return {
      ok: false,
      reason: 'MISMATCH',
      mismatch: {
        kind: 'MIXED_ASSESSMENTS',
        assessments: ordered.map((row, index) => ({
          candidateName: row.candidate.name,
          interviewTitle: assessments[index]?.interview.title ?? null,
        })),
      },
    };
  }

  const assessment = assessments[0];
  if (!assessment) return { ok: false, reason: 'NOT_FOUND' };
  const interviewId = assessment.interview.id;

  const [questions, cohortRows, selectedRows, scorecards] = await Promise.all([
    prisma.interviewQuestion.findMany({
      where: { interviewId },
      orderBy: { position: 'asc' },
      select: { position: true, question: { select: { id: true, title: true } } },
    }),
    // The whole cohort: every submission on this assessment by anyone who
    // finished it. Scalars only — never `sourceCode`, never `results`.
    prisma.submission.findMany({
      where: {
        interviewId,
        candidate: {
          assignments: { some: { interviewId, status: 'COMPLETED' } },
        },
      },
      select: {
        candidateId: true,
        questionId: true,
        score: true,
        passedCount: true,
        totalCount: true,
        submittedAt: true,
        trigger: true,
        language: true,
      },
    }),
    prisma.submission.findMany({
      where: { interviewId, candidateId: { in: ordered.map((row) => row.candidate.id) } },
      select: {
        candidateId: true,
        questionId: true,
        score: true,
        passedCount: true,
        totalCount: true,
        submittedAt: true,
        trigger: true,
        language: true,
      },
    }),
    // Bounded at four by the guard above, so a per-application call is fine —
    // and it is the only way the blind rule stays correct per viewer.
    Promise.all(ordered.map((row) => getApplicationScorecard(viewer, row.id))),
  ]);

  const questionList = questions.map((row) => ({
    questionId: row.question.id,
    title: row.question.title,
    position: row.position,
  }));

  const selectedByCandidate = groupBy(selectedRows, (row) => row.candidateId);

  const candidates: CompareCandidate[] = ordered.flatMap((row, index) => {
    const signal = scorecards[index]?.signal;
    if (!signal) return [];
    const mine = selectedByCandidate.get(row.candidate.id) ?? [];
    const rollUp = rollUpSubmissions(mine, metric);
    const theirAssessment = assessments[index];
    const chosen = choosePerQuestion(mine, metric);

    const candidate: CompareCandidate = {
      applicationId: row.id,
      candidateName: row.candidate.name,
      candidateEmail: row.candidate.email,
      jobRoleTitle: row.jobRole?.title ?? null,
      status: row.status,
      elapsedMs: elapsedMs(
        theirAssessment?.startedAt ?? null,
        theirAssessment?.completedAt ?? null,
      ),
      startedAt: theirAssessment?.startedAt ?? null,
      completedAt: theirAssessment?.completedAt ?? null,
      lateCount: countLateFor(mine, theirAssessment ?? null),
      attempts: rollUp.attempts,
      questionsAnswered: rollUp.questionsAnswered,
      passedCount: rollUp.passedCount,
      totalCount: rollUp.totalCount,
      score: rollUp.score,
      languages: rollUp.languages,
      perQuestion: questionList.map((question) => {
        const pick = chosen.get(question.questionId) ?? null;
        return {
          questionId: question.questionId,
          title: question.title,
          position: question.position,
          passedCount: pick?.passedCount ?? null,
          totalCount: pick?.totalCount ?? null,
          score: pick?.score ?? null,
          attempts: mine.filter((s) => s.questionId === question.questionId).length,
          autoSubmitted: pick?.trigger === 'AUTO_DEADLINE',
        };
      }),
      signal,
      decision: row.decision,
    };
    return [candidate];
  });

  return {
    ok: true,
    view: {
      interviewId,
      interviewTitle: assessment.interview.title,
      metric,
      questions: questionList,
      candidates,
      cohort: buildCohort(cohortRows, questionList, metric),
    },
  };
}

// --- the cohort --------------------------------------------------------------

function buildCohort(
  rows: readonly (RollUpRow & { candidateId: string })[],
  questions: ReadonlyArray<{ questionId: string; title: string; position: number }>,
  metric: ReviewMetric,
): CompareCohort {
  const byCandidate = groupBy(rows, (row) => row.candidateId);
  const size = byCandidate.size;
  const shown = size >= COHORT_MIN;

  // Computed even when it will not be shown, then blanked — so the page can
  // say *how many* completed without ever rendering a middle drawn from three
  // people. The size is the honest part; the median is the part that misleads.
  const perCandidateTotals: number[] = [];
  const perQuestionScores = new Map<string, number[]>();
  const perQuestionPassed = new Map<string, number[]>();
  const perQuestionTotal = new Map<string, number[]>();

  for (const [, theirRows] of byCandidate) {
    const rollUp = rollUpSubmissions(theirRows, metric);
    if (rollUp.score !== null) perCandidateTotals.push(rollUp.score);
    for (const [questionId, pick] of choosePerQuestion(theirRows, metric)) {
      push(perQuestionScores, questionId, pick.score);
      push(perQuestionPassed, questionId, pick.passedCount);
      push(perQuestionTotal, questionId, pick.totalCount);
    }
  }

  return {
    size,
    shown,
    medianScore: shown ? median(perCandidateTotals) : null,
    questions: questions.map((question) => ({
      ...question,
      medianScore: shown ? median(perQuestionScores.get(question.questionId) ?? []) : null,
      medianPassed: shown ? median(perQuestionPassed.get(question.questionId) ?? []) : null,
      // The test count is a property of the question, not of the cohort, so
      // the maximum is the right reading even when someone answered an older
      // version of it.
      totalCount: shown ? max(perQuestionTotal.get(question.questionId) ?? []) : null,
    })),
    distribution: shown ? histogram(perCandidateTotals) : [],
  };
}

// --- helpers -----------------------------------------------------------------

/** One chosen submission per question, under the same rule as the queue. */
function choosePerQuestion(
  rows: readonly RollUpRow[],
  metric: ReviewMetric,
): Map<string, RollUpRow> {
  const out = new Map<string, RollUpRow>();
  for (const row of rows) {
    const current = out.get(row.questionId);
    if (!current) {
      out.set(row.questionId, row);
      continue;
    }
    const better =
      metric === 'best' && row.score !== current.score
        ? row.score > current.score
        : row.submittedAt.getTime() >= current.submittedAt.getTime();
    if (better) out.set(row.questionId, row);
  }
  return out;
}

function countLateFor(
  rows: readonly RollUpRow[],
  assessment: { startedAt: Date | null; interview: { durationMinutes: number | null } } | null,
): number {
  if (!assessment?.startedAt || !assessment.interview.durationMinutes) return 0;
  const deadline = assessment.startedAt.getTime() + assessment.interview.durationMinutes * 60_000;
  return rows.filter((row) => row.submittedAt.getTime() > deadline).length;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = out.get(key(row)) ?? [];
    bucket.push(row);
    out.set(key(row), bucket);
  }
  return out;
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const bucket = map.get(key) ?? [];
  bucket.push(value);
  map.set(key, bucket);
}

function max(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}
