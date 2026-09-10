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
export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;
