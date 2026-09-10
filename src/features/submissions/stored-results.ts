import { z } from 'zod';

/**
 * Parsing of the `submissions.results` JSON column.
 *
 * Deliberately its own module, free of `server-only`: this logic reads a
 * payload written by the candidate's browser, and the one time it was
 * embedded in a `server-only` query module it could not be unit-tested at
 * all — which is how a `null`-vs-`undefined` mismatch silently blanked the
 * per-test breakdown on every submission in the product. Keep it pure.
 */

/**
 * Every optional field is `nullish`, not `optional`.
 *
 * This is not defensive padding — it is the bug this schema already shipped.
 * The submit action normalises absent fields to `null` (a passing test has no
 * `errorKind`), and Zod's `.optional()` accepts `undefined` but *rejects*
 * `null`. Combined with the `.catch([])` that used to sit on the `tests`
 * array, every real submission parsed to zero tests and the review screen
 * told admins "no per-test detail was recorded" for a payload that was
 * perfectly intact. JSON has no `undefined`, so anything round-tripping
 * through a Json column has to tolerate `null` on arrival.
 */
const storedTestSchema = z.object({
  testCaseId: z.string().max(200).catch(''),
  description: z.string().max(2000).nullish(),
  status: z.enum(['passed', 'failed', 'error', 'timeout']).catch('error'),
  input: z.string().catch(''),
  expectedOutput: z.string().catch(''),
  actualOutput: z.string().catch(''),
  stderr: z.string().nullish(),
  errorMessage: z.string().nullish(),
  errorKind: z.string().nullish(),
  weight: z.number().catch(1),
  durationMs: z.number().catch(0),
});

/**
 * The `results` column is written by the candidate-side runner, so this
 * parses defensively and accepts both the bare array and the enveloped form.
 * A review screen that throws on an unexpected payload would hide the very
 * submission an admin is trying to look at.
 */
const storedResultsSchema = z.union([
  z.array(storedTestSchema),
  z.object({
    // Deliberately NOT `.catch([])`: swallowing a parse failure here turns a
    // schema mismatch into a silent "nothing recorded", which is how the
    // `null`-vs-`undefined` bug above stayed invisible. Let it fail the union
    // so `parseStoredResults` reports `unreadable` and an admin sees that
    // something is wrong rather than that nothing happened.
    tests: z.array(storedTestSchema),
    stdout: z.string().nullish(),
    stderr: z.string().nullish(),
    fatalError: z.string().nullish(),
    executionTimeMs: z.number().nullish(),
  }),
]);

export type StoredTestResult = z.infer<typeof storedTestSchema>;

export interface ParsedResults {
  tests: StoredTestResult[];
  stdout?: string | undefined;
  stderr?: string | undefined;
  fatalError?: string | undefined;
  executionTimeMs?: number | undefined;
  unreadable: boolean;
}

export function parseStoredResults(value: unknown): ParsedResults {
  const parsed = storedResultsSchema.safeParse(value);
  if (!parsed.success) {
    // An empty `{}` is the column default, i.e. "nothing recorded" rather
    // than corruption — don't cry wolf about it.
    const isDefault =
      value === null ||
      (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
    return { tests: [], unreadable: !isDefault };
  }
  if (Array.isArray(parsed.data)) return { tests: parsed.data, unreadable: false };
  return {
    tests: parsed.data.tests,
    stdout: parsed.data.stdout ?? undefined,
    stderr: parsed.data.stderr ?? undefined,
    fatalError: parsed.data.fatalError ?? undefined,
    executionTimeMs: parsed.data.executionTimeMs ?? undefined,
    unreadable: false,
  };
}
