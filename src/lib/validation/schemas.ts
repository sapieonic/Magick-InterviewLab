import { z } from 'zod';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/features/auth/password-policy';

/**
 * One place for every input shape crossing the network. Server Actions parse
 * with these before touching the database — client-side validation is a
 * convenience, never the control.
 */

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Email is required.')
  .max(254, 'Email is too long.')
  .email('Enter a valid email address.')
  .transform((v) => v.toLowerCase());

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`)
  .refine((v) => /[a-zA-Z]/.test(v), 'Password must contain a letter.')
  .refine((v) => /[0-9]/.test(v), 'Password must contain a digit.');

export const languageSchema = z.enum(['JAVASCRIPT', 'PYTHON']);
export const difficultySchema = z.enum(['EASY', 'MEDIUM', 'HARD']);
export const interviewStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);

export const cuidSchema = z.string().min(1, 'Required.').max(64);

// --- auth ------------------------------------------------------------------

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required.').max(200),
  next: z.string().max(512).optional(),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.').max(200),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'Choose a password different from your current one.',
    path: ['newPassword'],
  });

// --- candidates ------------------------------------------------------------

export const createCandidateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  email: emailSchema,
  temporaryPassword: passwordSchema,
  interviewId: z.string().max(64).optional(),
  // The coercion that matters is in `createCandidateAction`, which reads the
  // field as `=== 'true'` — an unchecked checkbox submits nothing at all, and
  // anything that is not the literal tick must not send. The default here is
  // the same decision for any other caller: absent means do not mail.
  sendWelcomeEmail: z.boolean().default(false),
});

export const updateCandidateSchema = z.object({
  id: cuidSchema,
  name: z.string().trim().min(1, 'Name is required.').max(120),
  email: emailSchema,
});

export const resetCandidatePasswordSchema = z.object({
  id: cuidSchema,
  temporaryPassword: passwordSchema,
});

export const setCandidateActiveSchema = z.object({
  id: cuidSchema,
  isActive: z.boolean(),
});

export const assignInterviewSchema = z.object({
  candidateId: cuidSchema,
  interviewId: cuidSchema,
});

// --- interviews ------------------------------------------------------------

export const interviewInputSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(160),
  description: z.string().trim().max(5000).default(''),
  status: interviewStatusSchema.default('DRAFT'),
  // An empty form field arrives as '' — normalise it to "untimed" rather than
  // letting coerce turn it into 0.
  durationMinutes: z
    .union([z.literal(''), z.null(), z.coerce.number().int().min(1).max(1440)])
    .optional()
    .transform((v) => (typeof v === 'number' ? v : null)),
  allowMultipleSubmissions: z.boolean().default(true),
});

export const reorderQuestionsSchema = z.object({
  interviewId: cuidSchema,
  // Uniqueness is load-bearing, not hygiene. The action checks the payload
  // length against the number of existing links and then resolves each id
  // through a Map, so `[a, a]` against links `[a, b]` passes the length
  // check, writes `a` at both positions and never touches `b` — producing
  // exactly the duplicated/gapped `position` that the contiguous renumber
  // exists to prevent.
  questionIds: z
    .array(cuidSchema)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, 'Question order contains duplicates.'),
});

// --- questions -------------------------------------------------------------

export const testCaseInputSchema = z.object({
  id: z.string().max(64).optional(),
  input: z.string().max(20000).default(''),
  expectedOutput: z.string().max(20000).default(''),
  description: z.string().trim().max(300).default(''),
  weight: z.coerce.number().int().min(1, 'Weight must be at least 1.').max(100).default(1),
});

export const questionInputSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(160),
  description: z.string().max(20000).default(''),
  difficulty: difficultySchema.default('EASY'),
  supportedLanguages: z
    .array(languageSchema)
    .min(1, 'Select at least one language.')
    .max(2)
    .default(['JAVASCRIPT', 'PYTHON']),
  starterCode: z.record(z.string(), z.string().max(20000)).default({}),
  timeLimitMs: z.coerce.number().int().min(500).max(30000).default(5000),
  memoryLimitMb: z.coerce.number().int().min(16).max(2048).default(128),
  testCases: z.array(testCaseInputSchema).max(50).default([]),
});

/**
 * A question inside an import manifest. Identical to `questionInputSchema`, but
 * `.strict()` — an unknown key on an entry (a typo like `timeLimtMs` or
 * `dificulty`) is a hard error rather than being silently stripped and
 * defaulted, which for a hand-written bulk file is a data-quality trap. Nested
 * test cases are strict for the same reason. Every default still applies, so an
 * entry may omit anything but a title.
 */
const manifestQuestionSchema = questionInputSchema
  .extend({
    testCases: z.array(testCaseInputSchema.strict()).max(50).default([]),
  })
  .strict();

/**
 * Bulk import. A manifest is either a bare array of questions or an object with
 * a `questions` array. The envelope stays lenient — an unknown top-level key (a
 * future `metadata`, say) is ignored and `version` accepts any number and is
 * otherwise unused — so a manifest from a later exporter still imports; the
 * per-entry strictness above is where typos are caught. Every Zod error path
 * stays rooted at `questions.<i>...` for a legible per-entry message.
 */
export const questionManifestSchema = z.preprocess(
  (value) => (Array.isArray(value) ? { questions: value } : value),
  z.object({
    version: z.number().int().positive().optional(),
    questions: z
      .array(manifestQuestionSchema)
      .min(1, 'The manifest contains no questions.')
      .max(200, 'A manifest may hold at most 200 questions.'),
  }),
);

// --- submissions -----------------------------------------------------------

export const testResultSchema = z.object({
  testCaseId: z.string().max(64),
  description: z.string().max(300).optional(),
  status: z.enum(['passed', 'failed', 'error', 'timeout']),
  input: z.string().max(20000),
  expectedOutput: z.string().max(20000),
  actualOutput: z.string().max(20000),
  stderr: z.string().max(20000).optional(),
  errorMessage: z.string().max(4000).optional(),
  errorKind: z.enum(['syntax', 'runtime', 'timeout', 'internal']).optional(),
  weight: z.number().int().min(0).max(1000),
  durationMs: z.number().min(0).max(600000),
});

export const createSubmissionSchema = z.object({
  interviewId: cuidSchema,
  questionId: cuidSchema,
  language: languageSchema,
  sourceCode: z.string().max(200000),
  results: z.array(testResultSchema).max(100),
});

export const saveDraftSchema = z.object({
  questionId: cuidSchema,
  language: languageSchema,
  sourceCode: z.string().max(200000),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateCandidateInput = z.infer<typeof createCandidateSchema>;
export type InterviewInput = z.infer<typeof interviewInputSchema>;
export type QuestionInput = z.infer<typeof questionInputSchema>;
export type TestCaseInput = z.infer<typeof testCaseInputSchema>;
export type QuestionManifestInput = z.infer<typeof questionManifestSchema>;
export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;

// --- hiring pipeline -------------------------------------------------------

export const roleSchema = z.enum([
  'ADMIN',
  'RECRUITER',
  'HIRING_MANAGER',
  'INTERVIEWER',
  'CANDIDATE',
]);
export const staffRoleSchema = z.enum(['ADMIN', 'RECRUITER', 'HIRING_MANAGER', 'INTERVIEWER']);
export const applicationStatusSchema = z.enum([
  'ACTIVE',
  'ON_HOLD',
  'HIRED',
  'REJECTED',
  'WITHDRAWN',
]);
export const stageTypeSchema = z.enum([
  'CODING_ASSESSMENT',
  'LIVE_CODING',
  'SYSTEM_DESIGN',
  'BEHAVIORAL',
  'HIRING_MANAGER',
]);
export const stageStatusSchema = z.enum([
  'PENDING',
  'SCHEDULED',
  'IN_PROGRESS',
  'AWAITING_FEEDBACK',
  'COMPLETE',
  'SKIPPED',
]);
export const stageOutcomeSchema = z.enum(['ADVANCE', 'HOLD', 'REJECT']);
export const recommendationSchema = z.enum([
  'STRONG_NO',
  'NO',
  'LEAN_NO',
  'LEAN_HIRE',
  'HIRE',
  'STRONG_HIRE',
]);
export const confidenceSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const interviewerRoleSchema = z.enum(['LEAD', 'PANELIST', 'SHADOW']);
export const decisionOutcomeSchema = z.enum(['HIRE', 'NO_HIRE', 'HOLD']);

/** An empty `<input type="datetime-local">` posts '' — that means "unset". */
const optionalDateSchema = z
  .union([z.literal(''), z.null(), z.coerce.date()])
  .optional()
  .transform((v) => (v instanceof Date ? v : null));

/** An empty `<select>` option posts '' — that means "none", not an id. */
const optionalIdSchema = z
  .union([z.literal(''), z.null(), z.string().max(64)])
  .optional()
  .transform((v) => (typeof v === 'string' && v.length > 0 ? v : null));

// --- staff accounts --------------------------------------------------------

export const createStaffSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  email: emailSchema,
  role: staffRoleSchema,
  temporaryPassword: passwordSchema,
});

export const updateUserRoleSchema = z.object({
  id: cuidSchema,
  role: staffRoleSchema,
});

// --- job roles and pipeline templates --------------------------------------

export const jobRoleInputSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(160),
  level: z.string().trim().max(60).default(''),
  description: z.string().trim().max(5000).default(''),
  pipelineTemplateId: optionalIdSchema,
  isActive: z.boolean().default(true),
});

export const pipelineTemplateInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(160),
  description: z.string().trim().max(5000).default(''),
  isActive: z.boolean().default(true),
});

export const pipelineStageTemplateInputSchema = z.object({
  templateId: cuidSchema,
  name: z.string().trim().min(1, 'Stage name is required.').max(160),
  type: stageTypeSchema,
  rubricId: optionalIdSchema,
  isRequired: z.boolean().default(true),
});

// --- applications ----------------------------------------------------------

export const createApplicationSchema = z.object({
  candidateId: cuidSchema,
  jobRoleId: optionalIdSchema,
  pipelineTemplateId: optionalIdSchema,
  ownerId: optionalIdSchema,
  source: z.string().trim().max(120).default(''),
});

export const updateApplicationSchema = z.object({
  id: cuidSchema,
  jobRoleId: optionalIdSchema,
  ownerId: optionalIdSchema,
  source: z.string().trim().max(120).default(''),
});

export const setApplicationStatusSchema = z.object({
  id: cuidSchema,
  status: applicationStatusSchema,
});

export const applicationCommentSchema = z.object({
  applicationId: cuidSchema,
  body: z.string().trim().min(1, 'Write something first.').max(10000),
});

// --- stages ----------------------------------------------------------------

export const createStageSchema = z.object({
  applicationId: cuidSchema,
  name: z.string().trim().min(1, 'Stage name is required.').max(160),
  type: stageTypeSchema,
  rubricId: optionalIdSchema,
  scheduledAt: optionalDateSchema,
  /** Only meaningful for CODING_ASSESSMENT; the action rejects it otherwise. */
  interviewId: optionalIdSchema,
  blindFeedback: z.boolean().default(true),
});

export const updateStageSchema = z.object({
  id: cuidSchema,
  name: z.string().trim().min(1, 'Stage name is required.').max(160),
  scheduledAt: optionalDateSchema,
  blindFeedback: z.boolean().default(true),
});

export const setStageStatusSchema = z.object({
  id: cuidSchema,
  status: stageStatusSchema,
});

export const recordStageOutcomeSchema = z.object({
  id: cuidSchema,
  outcome: stageOutcomeSchema,
});

export const stageIdSchema = z.object({ id: cuidSchema });

export const addPanelistSchema = z.object({
  stageId: cuidSchema,
  userId: cuidSchema,
  role: interviewerRoleSchema.default('PANELIST'),
});

export const removePanelistSchema = z.object({
  stageId: cuidSchema,
  userId: cuidSchema,
});

// --- rubrics ---------------------------------------------------------------

export const rubricCriterionInputSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1, 'Criterion name is required.').max(160),
  description: z.string().trim().max(2000).default(''),
  weight: z.coerce.number().int().min(1, 'Weight must be at least 1.').max(100).default(1),
  maxScore: z.coerce.number().int().min(2, 'A scale needs at least two points.').max(10).default(4),
});

export const rubricInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(160),
  description: z.string().trim().max(5000).default(''),
});

export const rubricVersionInputSchema = z.object({
  versionId: cuidSchema,
  notes: z.string().trim().max(2000).default(''),
  criteria: z
    .array(rubricCriterionInputSchema)
    .min(1, 'A rubric needs at least one criterion.')
    .max(30),
});

// --- feedback --------------------------------------------------------------

export const feedbackScoreInputSchema = z.object({
  criterionId: cuidSchema,
  /** Range is checked against the criterion's own `maxScore` in the action —
   *  a schema cannot know the scale of a row it has not read. */
  score: z.coerce.number().int().min(1).max(10),
  note: z.string().trim().max(2000).default(''),
});

const feedbackBodySchema = z.object({
  stageId: cuidSchema,
  recommendation: z.union([z.literal(''), recommendationSchema]).optional(),
  confidence: z.union([z.literal(''), confidenceSchema]).optional(),
  summary: z.string().trim().max(20000).default(''),
  strengths: z.string().trim().max(20000).default(''),
  concerns: z.string().trim().max(20000).default(''),
  scores: z.array(feedbackScoreInputSchema).max(30).default([]),
});

/** A draft may be as empty as the author likes — that is what a draft is. */
export const saveFeedbackDraftSchema = feedbackBodySchema;

/**
 * Submitting is the point at which the scorecard becomes evidence, so the
 * fields a debrief actually reads stop being optional.
 */
export const submitFeedbackSchema = feedbackBodySchema.extend({
  recommendation: recommendationSchema,
  confidence: confidenceSchema,
  summary: z.string().trim().min(1, 'A summary is required before submitting.').max(20000),
  /** Set when editing an already-submitted scorecard; recorded on the revision. */
  revisionReason: z.string().trim().max(1000).default(''),
});

export const submissionNoteSchema = z
  .object({
    submissionId: cuidSchema,
    body: z.string().trim().min(1, 'Write something first.').max(10000),
    lineStart: z
      .union([z.literal(''), z.null(), z.coerce.number().int().min(1).max(100000)])
      .optional()
      .transform((v) => (typeof v === 'number' ? v : null)),
    lineEnd: z
      .union([z.literal(''), z.null(), z.coerce.number().int().min(1).max(100000)])
      .optional()
      .transform((v) => (typeof v === 'number' ? v : null)),
  })
  .refine((v) => v.lineEnd === null || v.lineStart === null || v.lineEnd >= v.lineStart, {
    message: 'The last line must not come before the first.',
    path: ['lineEnd'],
  });

// --- decision --------------------------------------------------------------

export const recordDecisionSchema = z.object({
  applicationId: cuidSchema,
  outcome: decisionOutcomeSchema,
  /** Not optional, and not defaulted. A decision nobody wrote a reason for is
   *  not reviewable, which defeats the point of recording it. */
  rationale: z
    .string()
    .trim()
    .min(20, 'Give at least a sentence of reasoning — this is the record others will read.')
    .max(20000),
});

export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type CreateStageInput = z.infer<typeof createStageSchema>;
export type RubricVersionInput = z.infer<typeof rubricVersionInputSchema>;
export type RubricCriterionInput = z.infer<typeof rubricCriterionInputSchema>;
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>;
export type RecordDecisionInput = z.infer<typeof recordDecisionSchema>;
