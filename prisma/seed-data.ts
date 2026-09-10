/**
 * Sample content for `npm run db:seed`.
 *
 * Every question follows the platform's execution contract: the program reads
 * from stdin and prints to stdout. Keeping the samples in that shape means a
 * new admin can copy one as a template and get a working question.
 */
import type { Difficulty, Language } from '../src/generated/prisma/enums.js';

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
