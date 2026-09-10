import { describe, expect, it } from 'vitest';

import {
  changePasswordSchema,
  createCandidateSchema,
  createSubmissionSchema,
  emailSchema,
  interviewInputSchema,
  passwordSchema,
  questionInputSchema,
} from '@/lib/validation/schemas';

/** Narrow a safeParse result to its data, failing loudly with the issues. */
function parsed<T>(result: { success: true; data: T } | { success: false; error: unknown }): T {
  if (!result.success)
    throw new Error(`expected parse to succeed: ${JSON.stringify(result.error)}`);
  return result.data;
}

describe('emailSchema', () => {
  it('trims surrounding whitespace and lower-cases the address', () => {
    // Normalisation is what makes the unique constraint meaningful: without
    // it, "Ada@Example.com" and "ada@example.com" are two accounts.
    expect(parsed(emailSchema.safeParse('  Ada@Example.COM  '))).toBe('ada@example.com');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a bare word', 'ada'],
    ['a missing domain', 'ada@'],
    ['a missing local part', '@example.com'],
    ['an embedded space', 'ad a@example.com'],
  ])('rejects %s', (_label, value) => {
    expect(emailSchema.safeParse(value).success).toBe(false);
  });

  it('rejects an address longer than the column allows', () => {
    const long = `${'a'.repeat(250)}@example.com`;
    expect(emailSchema.safeParse(long).success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('accepts a password with a letter, a digit and at least eight characters', () => {
    expect(passwordSchema.safeParse('abcdefg1').success).toBe(true);
  });

  it.each([
    ['too short', 'abcdef1'],
    ['no digit', 'abcdefghij'],
    ['no letter', '1234567890'],
    ['empty', ''],
  ])('rejects a password that is %s', (_label, value) => {
    expect(passwordSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a password longer than 200 characters', () => {
    expect(passwordSchema.safeParse(`${'a'.repeat(200)}1`).success).toBe(false);
  });

  // Whitespace is a legitimate password character and must not be stripped —
  // trimming here would silently change what the user typed.
  it('does not trim the password', () => {
    expect(parsed(passwordSchema.safeParse(' abcdefg1 '))).toBe(' abcdefg1 ');
  });
});

describe('createCandidateSchema', () => {
  const valid = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    temporaryPassword: 'temp1234',
  };

  it('accepts a well-formed candidate', () => {
    const result = parsed(createCandidateSchema.safeParse(valid));
    expect(result).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(result.interviewId).toBeUndefined();
  });

  it('normalises a padded, upper-cased email and a padded name', () => {
    const result = parsed(
      createCandidateSchema.safeParse({
        ...valid,
        name: '  Ada Lovelace  ',
        email: ' ADA@EXAMPLE.COM ',
      }),
    );
    expect(result.name).toBe('Ada Lovelace');
    expect(result.email).toBe('ada@example.com');
  });

  it('rejects a name that is only whitespace', () => {
    expect(createCandidateSchema.safeParse({ ...valid, name: '   ' }).success).toBe(false);
  });

  it('rejects a temporary password that fails the policy', () => {
    expect(createCandidateSchema.safeParse({ ...valid, temporaryPassword: 'short' }).success).toBe(
      false,
    );
  });

  it('accepts an optional interview assignment', () => {
    const result = parsed(createCandidateSchema.safeParse({ ...valid, interviewId: 'int-1' }));
    expect(result.interviewId).toBe('int-1');
  });
});

describe('interviewInputSchema', () => {
  const base = { title: 'Backend screen' };

  it('applies defaults for everything the form did not send', () => {
    const result = parsed(interviewInputSchema.safeParse(base));
    expect(result).toEqual({
      title: 'Backend screen',
      description: '',
      status: 'DRAFT',
      durationMinutes: null,
      allowMultipleSubmissions: true,
    });
  });

  // An untouched number input posts '' — coercing that to 0 would create an
  // interview that is over the instant it starts.
  it('treats an empty durationMinutes as untimed rather than zero', () => {
    expect(
      parsed(interviewInputSchema.safeParse({ ...base, durationMinutes: '' })).durationMinutes,
    ).toBeNull();
  });

  it('treats an explicit null durationMinutes as untimed', () => {
    expect(
      parsed(interviewInputSchema.safeParse({ ...base, durationMinutes: null })).durationMinutes,
    ).toBeNull();
  });

  it('coerces a numeric string durationMinutes to a number', () => {
    expect(
      parsed(interviewInputSchema.safeParse({ ...base, durationMinutes: '45' })).durationMinutes,
    ).toBe(45);
  });

  it.each([
    ['zero', 0],
    ['a negative', -10],
    ['above the 1440-minute cap', 1441],
    ['a non-numeric string', 'soon'],
  ])('rejects a durationMinutes of %s', (_label, durationMinutes) => {
    expect(interviewInputSchema.safeParse({ ...base, durationMinutes }).success).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(interviewInputSchema.safeParse({ title: '   ' }).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(interviewInputSchema.safeParse({ ...base, status: 'LIVE' }).success).toBe(false);
  });
});

describe('questionInputSchema', () => {
  const base = { title: 'Two Sum' };

  it('applies defaults for an otherwise empty question', () => {
    const result = parsed(questionInputSchema.safeParse(base));
    expect(result).toEqual({
      title: 'Two Sum',
      description: '',
      difficulty: 'EASY',
      supportedLanguages: ['JAVASCRIPT', 'PYTHON'],
      starterCode: {},
      timeLimitMs: 5000,
      memoryLimitMb: 128,
      testCases: [],
    });
  });

  // A question nobody can answer in any language is not a valid question.
  it('rejects an empty supportedLanguages list', () => {
    expect(questionInputSchema.safeParse({ ...base, supportedLanguages: [] }).success).toBe(false);
  });

  it('rejects an unsupported language', () => {
    expect(questionInputSchema.safeParse({ ...base, supportedLanguages: ['RUST'] }).success).toBe(
      false,
    );
  });

  it('coerces a form-posted string weight on a test case', () => {
    const result = parsed(
      questionInputSchema.safeParse({
        ...base,
        testCases: [{ input: '1 2', expectedOutput: '3', weight: '3' }],
      }),
    );
    expect(result.testCases[0]?.weight).toBe(3);
  });

  it('defaults a test case weight to 1 and its text fields to empty strings', () => {
    const result = parsed(questionInputSchema.safeParse({ ...base, testCases: [{}] }));
    expect(result.testCases[0]).toEqual({
      input: '',
      expectedOutput: '',
      description: '',
      weight: 1,
    });
  });

  it('rejects a test case weight below 1', () => {
    expect(questionInputSchema.safeParse({ ...base, testCases: [{ weight: 0 }] }).success).toBe(
      false,
    );
  });

  it.each([
    ['a time limit below the floor', { timeLimitMs: 100 }],
    ['a time limit above the ceiling', { timeLimitMs: 60_000 }],
    ['a memory limit below the floor', { memoryLimitMb: 8 }],
  ])('rejects %s', (_label, overrides) => {
    expect(questionInputSchema.safeParse({ ...base, ...overrides }).success).toBe(false);
  });
});

describe('createSubmissionSchema', () => {
  const validResult = {
    testCaseId: 'tc-1',
    status: 'passed' as const,
    input: '1 2',
    expectedOutput: '3',
    actualOutput: '3',
    weight: 1,
    durationMs: 12,
  };
  const base = {
    interviewId: 'int-1',
    questionId: 'q-1',
    language: 'JAVASCRIPT' as const,
    sourceCode: 'export function solve() {}',
  };

  it('accepts a well-formed submission', () => {
    const result = parsed(createSubmissionSchema.safeParse({ ...base, results: [validResult] }));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe('passed');
  });

  it('accepts a submission that ran no tests', () => {
    expect(createSubmissionSchema.safeParse({ ...base, results: [] }).success).toBe(true);
  });

  // The verdict vocabulary is fixed; an unrecognised status must not slip
  // through to the scorer, which would silently treat it as "not passed".
  it('rejects an unknown test status', () => {
    expect(
      createSubmissionSchema.safeParse({
        ...base,
        results: [{ ...validResult, status: 'skipped' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown language', () => {
    expect(
      createSubmissionSchema.safeParse({ ...base, language: 'RUBY', results: [] }).success,
    ).toBe(false);
  });

  it('rejects a results array beyond the 100-entry cap', () => {
    const results = Array.from({ length: 101 }, (_, i) => ({
      ...validResult,
      testCaseId: `tc-${i}`,
    }));
    expect(createSubmissionSchema.safeParse({ ...base, results }).success).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  it('accepts a valid change', () => {
    const result = parsed(
      changePasswordSchema.safeParse({
        currentPassword: 'oldpass1',
        newPassword: 'newpass1',
        confirmPassword: 'newpass1',
      }),
    );
    expect(result.newPassword).toBe('newpass1');
  });

  it('rejects a confirmation that does not match, on the confirm field', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'oldpass1',
      newPassword: 'newpass1',
      confirmPassword: 'newpass2',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === 'confirmPassword')).toBe(true);
  });

  // Rotating to the same value is a no-op that would leave a "must change
  // password" candidate still on the admin-chosen credential.
  it('rejects a new password identical to the current one, on the new-password field', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'samepass1',
      newPassword: 'samepass1',
      confirmPassword: 'samepass1',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === 'newPassword')).toBe(true);
  });

  it('rejects a new password that fails the policy', () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'oldpass1',
        newPassword: 'short',
        confirmPassword: 'short',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty current password', () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: '',
        newPassword: 'newpass1',
        confirmPassword: 'newpass1',
      }).success,
    ).toBe(false);
  });
});
