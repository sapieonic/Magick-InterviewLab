import type { AssignmentStatus, Difficulty, InterviewStatus } from '@/generated/prisma/enums';
import { Badge } from '@/components/ui/badge';
import { scoreLabel } from '@/features/submissions/score';

const INTERVIEW_STATUS = {
  DRAFT: { label: 'Draft', variant: 'outline' },
  PUBLISHED: { label: 'Published', variant: 'success' },
  ARCHIVED: { label: 'Archived', variant: 'secondary' },
} as const satisfies Record<
  InterviewStatus,
  { label: string; variant: 'outline' | 'success' | 'secondary' }
>;

export function InterviewStatusBadge({ status }: { status: InterviewStatus }) {
  const { label, variant } = INTERVIEW_STATUS[status];
  return <Badge variant={variant}>{label}</Badge>;
}

const DIFFICULTY = {
  EASY: { label: 'Easy', variant: 'success' },
  MEDIUM: { label: 'Medium', variant: 'warning' },
  HARD: { label: 'Hard', variant: 'destructive' },
} as const satisfies Record<
  Difficulty,
  { label: string; variant: 'success' | 'warning' | 'destructive' }
>;

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  const { label, variant } = DIFFICULTY[difficulty];
  return <Badge variant={variant}>{label}</Badge>;
}

const ASSIGNMENT_STATUS = {
  ASSIGNED: { label: 'Assigned', variant: 'outline' },
  IN_PROGRESS: { label: 'In progress', variant: 'default' },
  COMPLETED: { label: 'Completed', variant: 'success' },
} as const satisfies Record<
  AssignmentStatus,
  { label: string; variant: 'outline' | 'default' | 'success' }
>;

export function AssignmentStatusBadge({ status }: { status: AssignmentStatus }) {
  const { label, variant } = ASSIGNMENT_STATUS[status];
  return <Badge variant={variant}>{label}</Badge>;
}

export function ActiveBadge({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <Badge variant="success">Active</Badge>
  ) : (
    <Badge variant="secondary">Inactive</Badge>
  );
}

/** Score colouring shares `scoreLabel` with the rest of the app so the
 *  thresholds can never drift between the list and the detail view. */
export function ScoreBadge({ score }: { score: number }) {
  const label = scoreLabel(score);
  const variant = label === 'strong' ? 'success' : label === 'partial' ? 'warning' : 'destructive';
  return (
    <Badge variant={variant} className="tnum">
      {score}%
    </Badge>
  );
}

export function LanguageBadge({ language }: { language: string }) {
  return <Badge variant="outline">{language === 'PYTHON' ? 'Python' : 'JavaScript'}</Badge>;
}
