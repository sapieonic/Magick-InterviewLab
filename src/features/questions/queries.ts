import 'server-only';
import { prisma } from '@/lib/db/prisma';
import type { Difficulty, InterviewStatus, Language } from '@/generated/prisma/enums';

/** `starterCode` is a Json column, so the shape is only a convention. */
export function toStarterCode(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/** Starter code is keyed by the lowercase language id, as the seed writes it. */
export function starterCodeKey(language: Language): string {
  return language.toLowerCase();
}

export interface QuestionListRow {
  id: string;
  title: string;
  difficulty: Difficulty;
  supportedLanguages: Language[];
  updatedAt: Date;
  testCount: number;
  interviewCount: number;
}

export async function listQuestions(): Promise<QuestionListRow[]> {
  const rows = await prisma.question.findMany({
    orderBy: [{ updatedAt: 'desc' }],
    select: {
      id: true,
      title: true,
      difficulty: true,
      supportedLanguages: true,
      updatedAt: true,
      _count: { select: { testCases: true, interviews: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    difficulty: row.difficulty,
    supportedLanguages: row.supportedLanguages,
    updatedAt: row.updatedAt,
    testCount: row._count.testCases,
    interviewCount: row._count.interviews,
  }));
}

export interface QuestionTestCase {
  id: string;
  input: string;
  expectedOutput: string;
  description: string;
  weight: number;
  position: number;
}

export interface QuestionDetail {
  id: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  supportedLanguages: Language[];
  starterCode: Record<string, string>;
  timeLimitMs: number;
  memoryLimitMb: number;
  createdAt: Date;
  updatedAt: Date;
  testCases: QuestionTestCase[];
}

export async function getQuestion(id: string): Promise<QuestionDetail | null> {
  const row = await prisma.question.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      description: true,
      difficulty: true,
      supportedLanguages: true,
      starterCode: true,
      timeLimitMs: true,
      memoryLimitMb: true,
      createdAt: true,
      updatedAt: true,
      testCases: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          input: true,
          expectedOutput: true,
          description: true,
          weight: true,
          position: true,
        },
      },
    },
  });

  if (!row) return null;
  return { ...row, starterCode: toStarterCode(row.starterCode) };
}

export interface QuestionUsage {
  interviews: Array<{ id: string; title: string; status: InterviewStatus }>;
  submissionCount: number;
}

/**
 * What a delete would take with it. The FK cascade makes the delete itself
 * safe; the point of counting is that an admin should never discover after
 * the fact that they removed a question three people had already answered.
 */
export async function getQuestionUsage(id: string): Promise<QuestionUsage> {
  const [links, submissionCount] = await Promise.all([
    prisma.interviewQuestion.findMany({
      where: { questionId: id },
      select: { interview: { select: { id: true, title: true, status: true } } },
      orderBy: { interview: { title: 'asc' } },
    }),
    prisma.submission.count({ where: { questionId: id } }),
  ]);

  return { interviews: links.map((l) => l.interview), submissionCount };
}
