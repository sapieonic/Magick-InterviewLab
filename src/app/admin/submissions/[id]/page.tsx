import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, CheckCircle2, ChevronRight, Timer, XCircle } from 'lucide-react';
import { getSubmission, type StoredTestResult } from '../queries';
import { PageHeader, Section } from '@/components/admin/page-header';
import { LanguageBadge, ScoreBadge } from '@/components/admin/badges';
import { CodeBlock, OutputBlock } from '@/components/admin/code-block';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const submission = await getSubmission(id);
  return {
    title: submission ? `${submission.candidate.name} · ${submission.question.title}` : 'Submission',
  };
}

const STATUS_META = {
  passed: { label: 'Passed', Icon: CheckCircle2, className: 'text-success' },
  failed: { label: 'Failed', Icon: XCircle, className: 'text-destructive' },
  error: { label: 'Error', Icon: AlertTriangle, className: 'text-destructive' },
  timeout: { label: 'Timed out', Icon: Timer, className: 'text-warning' },
} as const;

function TestResultRow({ test, index }: { test: StoredTestResult; index: number }) {
  const meta = STATUS_META[test.status];
  const failed = test.status !== 'passed';

  return (
    <details open={failed} className="group rounded-md border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="text-muted-foreground size-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        <meta.Icon className={`size-4 shrink-0 ${meta.className}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span className="font-medium">Test {index + 1}</span>
          {test.description ? (
            <span className="text-muted-foreground"> — {test.description}</span>
          ) : null}
        </span>
        <span className="text-muted-foreground shrink-0 text-[12px] tabular-nums">
          weight {test.weight} · {Math.round(test.durationMs)} ms
        </span>
        <span className={`shrink-0 text-[12px] font-medium ${meta.className}`}>{meta.label}</span>
      </summary>

      <div className="space-y-3 border-t px-3 py-3">
        {test.errorMessage ? (
          <Alert tone="error" title={test.errorKind ? `${test.errorKind} error` : 'Error'}>
            <pre className="font-mono text-[12px] whitespace-pre-wrap">{test.errorMessage}</pre>
          </Alert>
        ) : null}

        <div className="grid gap-3 md:grid-cols-3">
          <OutputBlock label="Input (stdin)" value={test.input} />
          <OutputBlock label="Expected" value={test.expectedOutput} tone="expected" />
          <OutputBlock
            label="Actual"
            value={test.actualOutput}
            tone={failed ? 'actual' : 'neutral'}
          />
        </div>

        {test.stderr ? <OutputBlock label="stderr" value={test.stderr} /> : null}
      </div>
    </details>
  );
}

export default async function SubmissionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const submission = await getSubmission(id);
  if (!submission) notFound();

  const { results } = submission;

  return (
    <>
      <PageHeader
        title={submission.question.title}
        backHref="/admin/submissions"
        backLabel="Submissions"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link
              href={`/admin/candidates/${submission.candidate.id}`}
              className="hover:text-primary font-medium transition-colors"
            >
              {submission.candidate.name}
            </Link>
            <Link
              href={`/admin/interviews/${submission.interview.id}`}
              className="hover:text-primary transition-colors"
            >
              {submission.interview.title}
            </Link>
            <LanguageBadge language={submission.language} />
            <span>{formatDate(submission.submittedAt)}</span>
          </span>
        }
        actions={
          <>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[13px] tabular-nums">
                {submission.passedCount}/{submission.totalCount} tests
              </span>
              <ScoreBadge score={submission.score} />
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href={`/admin/submissions?candidateId=${submission.candidate.id}`}>
                All by this candidate
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">
          <Section
            title="Source code"
            description={`${submission.language === 'PYTHON' ? 'Python' : 'JavaScript'}, exactly as submitted.`}
          >
            <CodeBlock code={submission.sourceCode} />
          </Section>

          <Section
            title="Test results"
            description="Failures are expanded; passing cases are collapsed."
          >
            {results.unreadable ? (
              <Alert tone="error" title="Test results could not be read">
                The stored result payload does not match the expected shape. The score and counts
                above still come from the database columns, which are authoritative.
              </Alert>
            ) : null}

            {results.fatalError ? (
              <Alert tone="error" title="The run failed before the tests could complete">
                <pre className="font-mono text-[12px] whitespace-pre-wrap">
                  {results.fatalError}
                </pre>
              </Alert>
            ) : null}

            {results.tests.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                No per-test detail was recorded for this submission.
              </p>
            ) : (
              <ol className="mt-3 space-y-2 first:mt-0">
                {results.tests.map((test, index) => (
                  <li key={`${test.testCaseId}-${index}`}>
                    <TestResultRow test={test} index={index} />
                  </li>
                ))}
              </ol>
            )}
          </Section>

          {results.stdout || results.stderr ? (
            <Section title="Run output" description="Combined output captured across the run.">
              <div className="grid gap-3 md:grid-cols-2">
                {results.stdout ? <OutputBlock label="stdout" value={results.stdout} /> : null}
                {results.stderr ? <OutputBlock label="stderr" value={results.stderr} /> : null}
              </div>
            </Section>
          ) : null}
        </div>

        <aside className="space-y-5">
          <Section title="Details">
            <dl className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Score</dt>
                <dd>
                  <ScoreBadge score={submission.score} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Tests passed</dt>
                <dd className="tabular-nums">
                  {submission.passedCount}/{submission.totalCount}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Language</dt>
                <dd>
                  <LanguageBadge language={submission.language} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Time limit</dt>
                <dd className="tabular-nums">{submission.question.timeLimitMs} ms</dd>
              </div>
              {results.executionTimeMs === undefined ? null : (
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Total run time</dt>
                  <dd className="tabular-nums">{Math.round(results.executionTimeMs)} ms</dd>
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Submitted</dt>
                <dd className="text-right">{formatDate(submission.submittedAt)}</dd>
              </div>
            </dl>
          </Section>

          <Section title="Candidate">
            <p className="text-[13px] font-medium">{submission.candidate.name}</p>
            <p className="text-muted-foreground text-[12px]">{submission.candidate.email}</p>
            <Button asChild size="sm" variant="outline" className="mt-3 w-full">
              <Link href={`/admin/candidates/${submission.candidate.id}`}>Open candidate</Link>
            </Button>
          </Section>
        </aside>
      </div>
    </>
  );
}
