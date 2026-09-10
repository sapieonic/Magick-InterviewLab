import 'server-only';
import { prisma } from '@/lib/db/prisma';
import type { Language } from '@/generated/prisma/enums';

export interface DashboardStats {
  totalCandidates: number;
  activeCandidates: number;
  interviews: number;
  publishedInterviews: number;
  questions: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [totalCandidates, activeCandidates, interviews, publishedInterviews, questions] =
    await Promise.all([
      prisma.user.count({ where: { role: 'CANDIDATE' } }),
      prisma.user.count({ where: { role: 'CANDIDATE', isActive: true } }),
      prisma.interview.count(),
      prisma.interview.count({ where: { status: 'PUBLISHED' } }),
      prisma.question.count(),
    ]);

  return { totalCandidates, activeCandidates, interviews, publishedInterviews, questions };
}

interface ActivityCandidate {
  id: string;
  name: string;
  email: string;
}

export type ActivityItem =
  | { kind: 'login'; key: string; at: Date; candidate: ActivityCandidate }
  | {
      kind: 'submission';
      key: string;
      at: Date;
      candidate: ActivityCandidate;
      submissionId: string;
      score: number;
      passedCount: number;
      totalCount: number;
      language: Language;
      questionTitle: string;
      interviewTitle: string;
    };

/**
 * Two small windows merged in memory rather than a UNION: each side is
 * bounded by `limit`, so the merge can never read more than 2×limit rows,
 * and keeping it in TypeScript means the shapes stay typed end to end.
 */
export async function getRecentActivity(limit = 10): Promise<ActivityItem[]> {
  const [logins, submissions] = await Promise.all([
    prisma.user.findMany({
      where: { role: 'CANDIDATE', lastLoginAt: { not: null } },
      orderBy: { lastLoginAt: 'desc' },
      take: limit,
      select: { id: true, name: true, email: true, lastLoginAt: true },
    }),
    prisma.submission.findMany({
      orderBy: { submittedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        score: true,
        passedCount: true,
        totalCount: true,
        language: true,
        submittedAt: true,
        candidate: { select: { id: true, name: true, email: true } },
        question: { select: { title: true } },
        interview: { select: { title: true } },
      },
    }),
  ]);

  const items: ActivityItem[] = [
    ...logins.flatMap<ActivityItem>((user) =>
      user.lastLoginAt
        ? [
            {
              kind: 'login',
              key: `login:${user.id}`,
              at: user.lastLoginAt,
              candidate: { id: user.id, name: user.name, email: user.email },
            },
          ]
        : [],
    ),
    ...submissions.map<ActivityItem>((submission) => ({
      kind: 'submission',
      key: `submission:${submission.id}`,
      at: submission.submittedAt,
      candidate: submission.candidate,
      submissionId: submission.id,
      score: submission.score,
      passedCount: submission.passedCount,
      totalCount: submission.totalCount,
      language: submission.language,
      questionTitle: submission.question.title,
      interviewTitle: submission.interview.title,
    })),
  ];

  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
