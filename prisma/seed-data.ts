/**
 * Sample content for `npm run db:seed`.
 *
 * Every question follows the platform's execution contract: the program reads
 * from stdin and prints to stdout. Keeping the samples in that shape means a
 * new admin can copy one as a template and get a working question.
 */
import type {
  Difficulty,
  Language,
  Role,
  StageOutcome,
  StageStatus,
  StageType,
} from '../src/generated/prisma/enums.js';

interface SeedTestCase {
  input: string;
  expectedOutput: string;
  description: string;
  weight: number;
}

interface SeedQuestion {
  title: string;
  description: string;
  difficulty: Difficulty;
  supportedLanguages: Language[];
  starterCode: Record<string, string>;
  timeLimitMs: number;
  testCases: SeedTestCase[];
}

export const SAMPLE_INTERVIEW = {
  title: 'Frontend Engineer Interview',
  description:
    'A short screening set covering string handling, hash-map lookups and array scanning. ' +
    'Each question reads its input from standard input and prints the answer to standard output.',
  status: 'PUBLISHED' as const,
  durationMinutes: 60,
  allowMultipleSubmissions: true,
};

export const SAMPLE_QUESTIONS: SeedQuestion[] = [
  {
    title: 'Reverse a String',
    difficulty: 'EASY',
    supportedLanguages: ['JAVASCRIPT', 'PYTHON'],
    timeLimitMs: 5000,
    description: `Read a single line of text from standard input and print it reversed.

### Input

One line containing a string \`s\`.

### Output

The characters of \`s\` in reverse order.

### Example

\`\`\`
Input:
magicvoice

Output:
eciovcigam
\`\`\`

### Constraints

- \`1 <= s.length <= 10000\`
- \`s\` contains printable ASCII characters.`,
    starterCode: {
      javascript: `// Read one line from stdin and print it reversed.
const s = readLine() ?? '';

console.log(/* your answer here */ s);
`,
      python: `# Read one line from stdin and print it reversed.
import sys

s = sys.stdin.readline().rstrip("\\n")

print(s)  # your answer here
`,
    },
    testCases: [
      {
        input: 'magicvoice',
        expectedOutput: 'eciovcigam',
        description: 'Lowercase word',
        weight: 1,
      },
      { input: 'a', expectedOutput: 'a', description: 'Single character', weight: 1 },
      {
        input: 'Never odd or even',
        expectedOutput: 'neve ro ddo reveN',
        description: 'Spaces and mixed case',
        weight: 2,
      },
      { input: '12345', expectedOutput: '54321', description: 'Digits', weight: 1 },
    ],
  },
  {
    title: 'Two Sum',
    difficulty: 'MEDIUM',
    supportedLanguages: ['JAVASCRIPT', 'PYTHON'],
    timeLimitMs: 5000,
    description: `Given an array of integers and a target, print the **indices** of the two numbers that add up to the target.

### Input

- Line 1: space-separated integers.
- Line 2: the target integer.

### Output

The two indices, ascending, space-separated. Exactly one solution exists and an element may not be reused.

### Example

\`\`\`
Input:
2 7 11 15
9

Output:
0 1
\`\`\`

### Hint

A single pass with a hash map of *value → index* is enough; you do not need the nested loop.`,
    starterCode: {
      javascript: `const nums = (readLine() ?? '').trim().split(/\\s+/).map(Number);
const target = Number(readLine());

function twoSum(nums, target) {
  // TODO: return [i, j]
  return [0, 0];
}

console.log(twoSum(nums, target).join(' '));
`,
      python: `import sys

nums = [int(x) for x in sys.stdin.readline().split()]
target = int(sys.stdin.readline())


def two_sum(nums, target):
    # TODO: return (i, j)
    return (0, 0)


i, j = two_sum(nums, target)
print(i, j)
`,
    },
    testCases: [
      {
        input: '2 7 11 15\n9',
        expectedOutput: '0 1',
        description: 'Answer at the front',
        weight: 1,
      },
      { input: '3 2 4\n6', expectedOutput: '1 2', description: 'Answer in the middle', weight: 1 },
      { input: '3 3\n6', expectedOutput: '0 1', description: 'Duplicate values', weight: 2 },
      {
        input: '-1 -2 -3 -4 -5\n-8',
        expectedOutput: '2 4',
        description: 'Negative numbers',
        weight: 2,
      },
    ],
  },
  {
    title: 'Find the Duplicate',
    difficulty: 'MEDIUM',
    supportedLanguages: ['JAVASCRIPT', 'PYTHON'],
    timeLimitMs: 5000,
    description: `An array of \`n + 1\` integers holds values in the range \`1..n\`. Exactly one value appears more than once. Print it.

### Input

One line of space-separated integers.

### Output

The repeated value.

### Example

\`\`\`
Input:
1 3 4 2 2

Output:
2
\`\`\`

### Follow-up

Can you do it without modifying the array and in constant extra space?`,
    starterCode: {
      javascript: `const nums = (readLine() ?? '').trim().split(/\\s+/).map(Number);

function findDuplicate(nums) {
  // TODO
  return -1;
}

console.log(findDuplicate(nums));
`,
      python: `import sys

nums = [int(x) for x in sys.stdin.readline().split()]


def find_duplicate(nums):
    # TODO
    return -1


print(find_duplicate(nums))
`,
    },
    testCases: [
      { input: '1 3 4 2 2', expectedOutput: '2', description: 'Duplicate at the end', weight: 1 },
      { input: '3 1 3 4 2', expectedOutput: '3', description: 'Duplicate at the front', weight: 1 },
      { input: '1 1', expectedOutput: '1', description: 'Smallest possible array', weight: 1 },
      {
        input: '2 5 9 6 9 3 8 9 7 1',
        expectedOutput: '9',
        description: 'Repeats more than twice',
        weight: 2,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Hiring pipeline
//
// Enough of a process to walk the board, an application and a scorecard
// without inventing one by hand. Nothing here carries a credential: staff
// passwords come from the environment or are generated and printed once by
// `seed.ts`, exactly as the sample candidate's does.
// ---------------------------------------------------------------------------

interface SeedStaff {
  /** Default address; `SEED_STAFF_DOMAIN` overrides the domain half. */
  email: string;
  name: string;
  role: Role;
}

export const SAMPLE_STAFF = {
  recruiter: {
    email: 'recruiter@magicvoice.local',
    name: 'Priya Raman',
    role: 'RECRUITER',
  },
  hiringManager: {
    email: 'hiring.manager@magicvoice.local',
    name: 'Tom Okafor',
    role: 'HIRING_MANAGER',
  },
  interviewer: {
    email: 'interviewer@magicvoice.local',
    name: 'Lena Fischer',
    role: 'INTERVIEWER',
  },
} as const satisfies Record<string, SeedStaff>;

export const SAMPLE_JOB_ROLE = {
  title: 'Backend Engineer',
  level: 'L4',
  description:
    'Owns a service end to end: designs it, ships it and carries the pager for it. ' +
    'Evaluated on judgement under ambiguity as much as on code.',
};

export const SAMPLE_PIPELINE_TEMPLATE = {
  name: 'Backend hiring loop',
  description:
    'Four rounds: a machine-graded assessment to establish a floor, then three ' +
    'conversations that each look at something the others cannot see.',
};

interface SeedStageTemplate {
  name: string;
  type: StageType;
  isRequired: boolean;
}

/**
 * The assessment comes first deliberately — it is the cheapest round for both
 * sides, and a loop that spends four people's afternoons before anyone has
 * seen the candidate write code is a loop that wastes them.
 */
export const SAMPLE_PIPELINE_STAGES: SeedStageTemplate[] = [
  { name: 'Coding assessment', type: 'CODING_ASSESSMENT', isRequired: true },
  { name: 'Technical screen', type: 'LIVE_CODING', isRequired: true },
  { name: 'System design', type: 'SYSTEM_DESIGN', isRequired: true },
  { name: 'Hiring manager', type: 'HIRING_MANAGER', isRequired: true },
];

/** Where the demo application sits: the assessment is done and advanced, the
 *  screen has happened and is waiting on its scorecards, the rest are ahead. */
export const SAMPLE_APPLICATION_PROGRESS: ReadonlyArray<{
  status: StageStatus;
  outcome: StageOutcome | null;
  /** Days ago the round was scheduled; null for rounds not yet booked. */
  scheduledDaysAgo: number | null;
}> = [
  { status: 'COMPLETE', outcome: 'ADVANCE', scheduledDaysAgo: 12 },
  { status: 'AWAITING_FEEDBACK', outcome: null, scheduledDaysAgo: 3 },
  { status: 'PENDING', outcome: null, scheduledDaysAgo: null },
  { status: 'PENDING', outcome: null, scheduledDaysAgo: null },
];

/**
 * The rubric the demo pipeline scores against.
 *
 * Seeded rather than left to a human because without it the entire rubric half
 * of the product — versioned criteria, weighted normalisation, the per-criterion
 * table on the debrief — cannot be reached on a fresh install: a stage with no
 * pinned version simply reports that it has nothing to score against.
 *
 * Weights are deliberately unequal and `maxScore` is deliberately not uniform,
 * so the normalisation across differing scales is exercised by the demo rather
 * than only by unit tests.
 */
export const SAMPLE_RUBRIC = {
  name: 'Engineering interview',
  description:
    'The default instrument for engineering rounds. Score against what the ' +
    'candidate demonstrated in this round, not against their CV.',
  criteria: [
    {
      name: 'Problem solving',
      description:
        'Breaks an ambiguous problem down, chooses an approach for stated reasons, ' +
        'and notices when it is not working.',
      weight: 3,
      maxScore: 4,
    },
    {
      name: 'Code quality',
      description: 'Readable, correct, and structured so the next person can change it.',
      weight: 2,
      maxScore: 4,
    },
    {
      name: 'Communication',
      description:
        'Thinks out loud, takes a hint, and disagrees clearly when they think you are wrong.',
      weight: 2,
      maxScore: 4,
    },
    {
      name: 'Testing instinct',
      description: 'Reaches for edge cases unprompted rather than when asked.',
      weight: 1,
      // A different scale on purpose — see the note above.
      maxScore: 5,
    },
  ],
} as const;

/**
 * One submitted scorecard on the round that is awaiting feedback.
 *
 * Exactly one, not two: the point of the demo is that the second panellist
 * opens the round and is told that a scorecard is hidden until they submit
 * their own. Seeding both would show the blind rule's *result* and hide the
 * rule itself.
 */
export const SAMPLE_FEEDBACK = {
  stageName: 'Technical screen',
  recommendation: 'LEAN_HIRE',
  confidence: 'MEDIUM',
  summary:
    'Solid on the core problem — got to a working solution without hints and ' +
    'explained the trade-off between the two approaches unprompted. Slower on ' +
    'the follow-up, and needed a nudge to spot the empty-input case.',
  strengths:
    'Clear reasoning out loud. Chose the hash-map approach for a stated reason ' +
    'rather than by reflex, and could say what it cost in memory.',
  concerns:
    'Did not test the empty input until prompted. I would want to see how they ' +
    'handle a larger codebase before calling this a clear hire.',
  /** Keyed by criterion name so a reordering of the rubric cannot silently
   *  reassign the scores. */
  scores: {
    'Problem solving': { score: 3, note: 'Reached a working solution unaided.' },
    'Code quality': { score: 3, note: 'Readable; naming drifted under time pressure.' },
    Communication: { score: 4, note: 'Genuinely good — disagreed with me once, correctly.' },
    'Testing instinct': { score: 2, note: 'Prompted, not spontaneous.' },
  },
} as const;

/** The code the demo candidate "submitted". Deliberately imperfect — it fails
 *  the last test case, so the review screen shows a real failure. */
export const SAMPLE_SUBMISSION_SOURCE = `const lines = require('fs').readFileSync(0, 'utf8').split('\\n');

function reverse(input) {
  // Splits on code units, so this is wrong for astral-plane characters.
  return input.split('').reverse().join('');
}

console.log(reverse(lines[0] ?? ''));
`;
