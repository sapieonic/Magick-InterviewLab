import type { Metadata } from 'next';
import Link from 'next/link';
import { FileQuestion, Plus } from 'lucide-react';
import { listQuestions } from '@/features/questions/queries';
import { PageHeader } from '@/components/admin/page-header';
import { DifficultyBadge, LanguageBadge } from '@/components/admin/badges';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate } from '@/lib/utils';

export const metadata: Metadata = { title: 'Questions' };

export default async function QuestionsPage() {
  const questions = await listQuestions();

  return (
    <>
      <PageHeader
        title="Questions"
        description={`${questions.length} ${questions.length === 1 ? 'question' : 'questions'} in the bank`}
        actions={
          <Button asChild size="sm">
            <Link href="/admin/questions/new">
              <Plus className="size-3.5" aria-hidden />
              New question
            </Link>
          </Button>
        }
      />

      {questions.length === 0 ? (
        <EmptyState
          icon={FileQuestion}
          title="No questions yet"
          description="Questions read from stdin and print to stdout, so the same question works in every supported language."
          action={
            <Button asChild size="sm">
              <Link href="/admin/questions/new">New question</Link>
            </Button>
          }
        />
      ) : (
        <div className="bg-card overflow-hidden rounded-lg border shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Difficulty</TableHead>
                <TableHead>Languages</TableHead>
                <TableHead>Tests</TableHead>
                <TableHead>Interviews</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {questions.map((question) => (
                <TableRow key={question.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/questions/${question.id}`}
                      className="hover:text-primary transition-colors"
                    >
                      {question.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <DifficultyBadge difficulty={question.difficulty} />
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {question.supportedLanguages.length === 0 ? (
                        <span className="text-muted-foreground text-[13px]">—</span>
                      ) : (
                        question.supportedLanguages.map((language) => (
                          <LanguageBadge key={language} language={language} />
                        ))
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-[13px] tabular-nums">{question.testCount}</TableCell>
                  <TableCell className="text-[13px] tabular-nums">
                    {question.interviewCount}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-[13px] whitespace-nowrap">
                    {formatDate(question.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
