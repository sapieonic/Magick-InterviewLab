import type { Metadata } from 'next';
import { requireAdminPage } from '@/features/auth/guards';
import { QuestionEditor } from '@/components/admin/question-editor';
import { PageHeader } from '@/components/admin/page-header';

export const metadata: Metadata = { title: 'New question' };

const STARTER_JS = `// Read from stdin, print the answer to stdout.
const line = readLine() ?? '';

console.log(line);
`;

const STARTER_PY = `# Read from stdin, print the answer to stdout.
import sys

line = sys.stdin.readline().rstrip("\\n")

print(line)
`;

export default async function NewQuestionPage() {
  await requireAdminPage();
  return (
    <>
      <PageHeader
        title="New question"
        description="Programs read their input from stdin and print the answer to stdout — the same contract in every language."
        backHref="/admin/questions"
        backLabel="Questions"
      />
      <QuestionEditor
        initial={{
          title: '',
          description: '',
          difficulty: 'EASY',
          supportedLanguages: ['JAVASCRIPT', 'PYTHON'],
          starterCode: { javascript: STARTER_JS, python: STARTER_PY },
          timeLimitMs: 5000,
          memoryLimitMb: 128,
          testCases: [{ input: '', expectedOutput: '', description: '', weight: 1 }],
        }}
      />
    </>
  );
}
