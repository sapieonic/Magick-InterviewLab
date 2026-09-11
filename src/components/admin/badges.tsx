import type {
  ApplicationStatus,
  AssignmentStatus,
  Confidence,
  DecisionOutcome,
  Difficulty,
  FeedbackStatus,
  InterviewStatus,
  InterviewerRole,
  Recommendation,
  Role,
  StageOutcome,
  StageStatus,
  StageType,
} from '@/generated/prisma/enums';
import { Badge } from '@/components/ui/badge';
import { scoreLabel } from '@/features/submissions/score';
import { roleLabel } from '@/features/auth/capabilities';

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

// --- hiring pipeline -------------------------------------------------------

const APPLICATION_STATUS = {
  ACTIVE: { label: 'Active', variant: 'default' },
  ON_HOLD: { label: 'On hold', variant: 'warning' },
  HIRED: { label: 'Hired', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  WITHDRAWN: { label: 'Withdrawn', variant: 'secondary' },
} as const satisfies Record<
  ApplicationStatus,
  { label: string; variant: 'default' | 'warning' | 'success' | 'destructive' | 'secondary' }
>;

export function ApplicationStatusBadge({ status }: { status: ApplicationStatus }) {
  const { label, variant } = APPLICATION_STATUS[status];
  return <Badge variant={variant}>{label}</Badge>;
}

const STAGE_STATUS = {
  PENDING: { label: 'Pending', variant: 'outline' },
  SCHEDULED: { label: 'Scheduled', variant: 'default' },
  IN_PROGRESS: { label: 'In progress', variant: 'default' },
  // The state that needs chasing, so it is the one that reads as a warning.
  AWAITING_FEEDBACK: { label: 'Awaiting feedback', variant: 'warning' },
  COMPLETE: { label: 'Complete', variant: 'success' },
  SKIPPED: { label: 'Skipped', variant: 'secondary' },
} as const satisfies Record<
  StageStatus,
  { label: string; variant: 'outline' | 'default' | 'warning' | 'success' | 'secondary' }
>;

export function StageStatusBadge({ status }: { status: StageStatus }) {
  const { label, variant } = STAGE_STATUS[status];
  return <Badge variant={variant}>{label}</Badge>;
}

export const STAGE_TYPE_LABELS = {
  CODING_ASSESSMENT: 'Coding assessment',
  LIVE_CODING: 'Live coding',
  SYSTEM_DESIGN: 'System design',
  BEHAVIORAL: 'Behavioural',
  HIRING_MANAGER: 'Hiring manager',
} as const satisfies Record<StageType, string>;

export function StageTypeBadge({ type }: { type: StageType }) {
  return <Badge variant="outline">{STAGE_TYPE_LABELS[type]}</Badge>;
}

const STAGE_OUTCOME = {
  ADVANCE: { label: 'Advance', variant: 'success' },
  HOLD: { label: 'Hold', variant: 'warning' },
  REJECT: { label: 'Reject', variant: 'destructive' },
} as const satisfies Record<
  StageOutcome,
  { label: string; variant: 'success' | 'warning' | 'destructive' }
>;

export function StageOutcomeBadge({ outcome }: { outcome: StageOutcome }) {
  const { label, variant } = STAGE_OUTCOME[outcome];
  return <Badge variant={variant}>{label}</Badge>;
}

/**
 * The six-point scale. Note there is no neutral colour because there is no
 * neutral point — the scale exists to force a side.
 */
export const RECOMMENDATION_LABELS = {
  STRONG_NO: 'Strong no',
  NO: 'No',
  LEAN_NO: 'Lean no',
  LEAN_HIRE: 'Lean hire',
  HIRE: 'Hire',
  STRONG_HIRE: 'Strong hire',
} as const satisfies Record<Recommendation, string>;

const RECOMMENDATION_VARIANT = {
  STRONG_NO: 'destructive',
  NO: 'destructive',
  LEAN_NO: 'warning',
  LEAN_HIRE: 'warning',
  HIRE: 'success',
  STRONG_HIRE: 'success',
} as const satisfies Record<Recommendation, 'destructive' | 'warning' | 'success'>;

export function RecommendationBadge({ recommendation }: { recommendation: Recommendation }) {
  return (
    <Badge variant={RECOMMENDATION_VARIANT[recommendation]}>
      {RECOMMENDATION_LABELS[recommendation]}
    </Badge>
  );
}

export const CONFIDENCE_LABELS = {
  LOW: 'Low confidence',
  MEDIUM: 'Medium confidence',
  HIGH: 'High confidence',
} as const satisfies Record<Confidence, string>;

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return <Badge variant="outline">{CONFIDENCE_LABELS[confidence]}</Badge>;
}

const FEEDBACK_STATUS = {
  DRAFT: { label: 'Draft', variant: 'outline' },
  SUBMITTED: { label: 'Submitted', variant: 'success' },
} as const satisfies Record<FeedbackStatus, { label: string; variant: 'outline' | 'success' }>;

export function FeedbackStatusBadge({ status }: { status: FeedbackStatus }) {
  const { label, variant } = FEEDBACK_STATUS[status];
  return <Badge variant={variant}>{label}</Badge>;
}

const DECISION_OUTCOME = {
  HIRE: { label: 'Hire', variant: 'success' },
  NO_HIRE: { label: 'No hire', variant: 'destructive' },
  HOLD: { label: 'Hold', variant: 'warning' },
} as const satisfies Record<
  DecisionOutcome,
  { label: string; variant: 'success' | 'destructive' | 'warning' }
>;

export function DecisionBadge({ outcome }: { outcome: DecisionOutcome }) {
  const { label, variant } = DECISION_OUTCOME[outcome];
  return <Badge variant={variant}>{label}</Badge>;
}

const ROLE_VARIANT = {
  ADMIN: 'default',
  RECRUITER: 'secondary',
  HIRING_MANAGER: 'secondary',
  INTERVIEWER: 'outline',
  CANDIDATE: 'outline',
} as const satisfies Record<Role, 'default' | 'secondary' | 'outline'>;

export function RoleBadge({ role }: { role: Role }) {
  return <Badge variant={ROLE_VARIANT[role]}>{roleLabel(role)}</Badge>;
}

const INTERVIEWER_ROLE_LABELS = {
  LEAD: 'Lead',
  PANELIST: 'Panellist',
  SHADOW: 'Shadow',
} as const satisfies Record<InterviewerRole, string>;

export function InterviewerRoleBadge({ role }: { role: InterviewerRole }) {
  return (
    <Badge variant={role === 'SHADOW' ? 'outline' : 'secondary'}>
      {INTERVIEWER_ROLE_LABELS[role]}
    </Badge>
  );
}
