'use client';

import Link from 'next/link';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { FileUp, Upload } from 'lucide-react';
import { importQuestionsAction, type ImportSummary } from '@/features/questions/actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Alert } from '@/components/ui/alert';
import { Section } from '@/components/admin/page-header';

/** A small, valid manifest that doubles as the format reference. */
const SAMPLE_MANIFEST = `{
  "version": 1,
  "questions": [
    {
      "title": "Echo",
      "description": "Read a line from stdin and print it back.",
      "difficulty": "EASY",
      "supportedLanguages": ["JAVASCRIPT", "PYTHON"],
      "starterCode": {
        "javascript": "const line = readLine() ?? '';\\nconsole.log(line);\\n",
        "python": "import sys\\nprint(sys.stdin.readline().rstrip('\\\\n'))\\n"
      },
      "timeLimitMs": 5000,
      "memoryLimitMb": 128,
      "testCases": [
        { "input": "hello", "expectedOutput": "hello", "description": "round-trips a word", "weight": 1 },
        { "input": "42", "expectedOutput": "42", "weight": 1 }
      ]
    }
  ]
}
`;

interface ManifestPreview {
  count: number;
  titles: string[];
}

/**
 * Reads the pasted/loaded JSON just far enough to show what will be imported.
 * The server re-validates every field with the same schema the editor uses —
 * this is a convenience, never the control — so a shape it can't read here is
 * still parsed defensively rather than trusted.
 */
function preview(text: string): { preview?: ManifestPreview; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { error: `That is not valid JSON: ${(error as Error).message}` };
  }

  const questions = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>).questions)
      ? ((parsed as Record<string, unknown>).questions as unknown[])
      : null;

  if (questions === null) {
    return { error: 'Expected a JSON array of questions, or an object with a "questions" array.' };
  }
  if (questions.length === 0) {
    return { error: 'The manifest contains no questions.' };
  }

  const titles = questions.map((q, i) => {
    const title = (q as Record<string, unknown>)?.title;
    return typeof title === 'string' && title.trim()
      ? title.trim()
      : `Question ${i + 1} (untitled)`;
  });

  return { preview: { count: questions.length, titles } };
}

/** `questions.2.testCases.1.weight` reads as "Question 3 → Test 2 → weight". */
function describePath(path: string): string {
  // A whole-payload error (a non-object manifest) has an empty Zod path, which
  // `flattenZod` keys as `_`; name it for what it is rather than showing "_".
  if (path === '_') return 'Manifest';
  return path
    .replace(/^questions\.(\d+)/, (_m, i) => `Question ${Number(i) + 1}`)
    .replace(/\.testCases\.(\d+)/, (_m, i) => ` → Test ${Number(i) + 1}`)
    .replace(/^\./, '')
    .replace(/\./g, ' → ');
}

export function QuestionImporter() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();

  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const parsed = preview(text);

  function loadText(next: string, name: string | null): void {
    setText(next);
    setFileName(name);
    setError(null);
    setFieldErrors({});
    setSummary(null);
  }

  async function onFile(file: File): Promise<void> {
    try {
      loadText(await file.text(), file.name);
    } catch {
      setError('Could not read that file.');
    }
  }

  function runImport(): void {
    setError(null);
    setFieldErrors({});
    setSummary(null);

    const check = preview(text);
    if (check.error) {
      setError(check.error);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      setError('That is not valid JSON.');
      return;
    }

    startTransition(async () => {
      const result = await importQuestionsAction(payload);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }
      setSummary(result.data);
      const { imported, skipped } = result.data;
      toast.success(
        imported === 0
          ? 'Nothing imported — every question already exists.'
          : `Imported ${imported} question${imported === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`,
      );
      // Refresh so the questions list behind this page reflects the new rows.
      router.refresh();
    });
  }

  const fieldErrorEntries = Object.entries(fieldErrors);

  return (
    <div className="space-y-5">
      {summary ? (
        <Alert
          tone="success"
          title={`Imported ${summary.imported} question${summary.imported === 1 ? '' : 's'}.`}
        >
          {summary.skipped > 0 ? (
            <p className="mt-1">
              Skipped {summary.skipped} already in the bank: {summary.skippedTitles.join(', ')}.
            </p>
          ) : null}
          <p className="mt-2">
            <Link href="/admin/questions" className="hover:text-primary font-medium underline">
              Back to questions
            </Link>
          </p>
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="error" title={error}>
          {fieldErrorEntries.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {fieldErrorEntries.map(([path, messages]) => (
                <li key={path}>
                  <span className="font-medium">{describePath(path)}</span>: {messages.join(' ')}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <Section
        title="Manifest"
        description="A JSON array of questions, or an object with a “questions” array. Existing titles are skipped, never overwritten."
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
                // Allow re-selecting the same file after an edit.
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => fileInput.current?.click()}
            >
              <FileUp className="size-3.5" aria-hidden />
              Choose file…
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => loadText(SAMPLE_MANIFEST, 'sample.json')}
            >
              Load sample
            </Button>
          </span>
        }
      >
        <div className="space-y-2">
          <Textarea
            value={text}
            onChange={(e) => loadText(e.target.value, null)}
            rows={18}
            spellCheck={false}
            placeholder='{ "questions": [ … ] }'
            className="font-mono text-[12.5px]"
            aria-label="Question manifest JSON"
          />
          <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <span>{fileName ? `Loaded from ${fileName}.` : 'Paste JSON or choose a file.'}</span>
            {parsed.preview ? (
              <span className="tabular-nums">
                {parsed.preview.count} question{parsed.preview.count === 1 ? '' : 's'} detected
              </span>
            ) : parsed.error ? (
              <span className="text-destructive">{parsed.error}</span>
            ) : null}
          </div>

          {parsed.preview ? (
            <ul className="bg-background max-h-40 space-y-0.5 overflow-auto rounded-md border px-3 py-2 text-[13px]">
              {parsed.preview.titles.map((title, i) => (
                <li key={`${i}-${title}`} className="truncate">
                  {i + 1}. {title}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Section>

      <div className="bg-background/90 sticky bottom-0 flex flex-wrap items-center gap-2 border-t py-3 backdrop-blur">
        <Button type="button" onClick={runImport} loading={pending} disabled={!parsed.preview}>
          <Upload className="size-3.5" aria-hidden />
          Import{' '}
          {parsed.preview
            ? `${parsed.preview.count} question${parsed.preview.count === 1 ? '' : 's'}`
            : 'questions'}
        </Button>
        <Button asChild variant="ghost">
          <Link href="/admin/questions">Cancel</Link>
        </Button>
        <span className="text-muted-foreground ml-auto text-[12px]">
          Each entry becomes a new question — the same fields the editor saves.
        </span>
      </div>
    </div>
  );
}
