'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react';
import type { Difficulty, Language } from '@/generated/prisma/enums';
import { saveQuestionAction } from '@/features/questions/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Section } from '@/components/admin/page-header';
import { Field, FieldErrors } from '@/components/admin/form';
import { Markdown } from '@/components/markdown';

const LANGUAGES: Array<{ value: Language; label: string; key: string }> = [
  { value: 'JAVASCRIPT', label: 'JavaScript', key: 'javascript' },
  { value: 'PYTHON', label: 'Python', key: 'python' },
];

const DIFFICULTIES: Difficulty[] = ['EASY', 'MEDIUM', 'HARD'];

export interface QuestionEditorTestCase {
  input: string;
  expectedOutput: string;
  description: string;
  weight: number;
}

export interface QuestionEditorValues {
  id?: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  supportedLanguages: Language[];
  starterCode: Record<string, string>;
  timeLimitMs: number;
  memoryLimitMb: number;
  testCases: QuestionEditorTestCase[];
}

interface TestCaseRow extends QuestionEditorTestCase {
  /** Stable across reorders so React keeps focus in the right textarea. */
  key: string;
}

let rowCounter = 0;
function newKey(): string {
  rowCounter += 1;
  return `row-${rowCounter}`;
}

function emptyRow(): TestCaseRow {
  return { key: newKey(), input: '', expectedOutput: '', description: '', weight: 1 };
}

const TEST_FIELD_LABELS: Readonly<Record<string, string>> = {
  input: 'input',
  expectedOutput: 'expected output',
  description: 'description',
  weight: 'weight',
};

/** `testCases.2.weight` reads as "Test 3 — weight". */
function describeErrorPath(path: string): string {
  const match = /^testCases\.(\d+)(?:\.(\w+))?$/.exec(path);
  if (!match) return path;
  const position = Number(match[1]) + 1;
  const field = match[2];
  return field ? `Test ${position} — ${TEST_FIELD_LABELS[field] ?? field}` : `Test ${position}`;
}

export function QuestionEditor({ initial }: { initial: QuestionEditorValues }) {
  const router = useRouter();
  const uid = useId();
  const [pending, startTransition] = useTransition();

  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [difficulty, setDifficulty] = useState<Difficulty>(initial.difficulty);
  const [languages, setLanguages] = useState<Language[]>(initial.supportedLanguages);
  const [starterCode, setStarterCode] = useState<Record<string, string>>(initial.starterCode);
  const [timeLimitMs, setTimeLimitMs] = useState(String(initial.timeLimitMs));
  const [memoryLimitMb, setMemoryLimitMb] = useState(String(initial.memoryLimitMb));
  const [rows, setRows] = useState<TestCaseRow[]>(
    initial.testCases.map((test) => ({ ...test, key: newKey() })),
  );

  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const totalWeight = rows.reduce(
    (sum, row) => sum + (Number.isFinite(row.weight) ? row.weight : 0),
    0,
  );

  function toggleLanguage(language: Language, checked: boolean): void {
    setLanguages((current) =>
      checked ? [...new Set([...current, language])] : current.filter((l) => l !== language),
    );
  }

  function patchRow(index: number, patch: Partial<QuestionEditorTestCase>): void {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function moveRow(index: number, delta: number): void {
    const target = index + delta;
    setRows((current) => {
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const moved = next[index];
      const displaced = next[target];
      if (moved === undefined || displaced === undefined) return current;
      next[index] = displaced;
      next[target] = moved;
      return next;
    });
  }

  function save(): void {
    setError(null);
    setFieldErrors({});

    const payload = {
      ...(initial.id ? { id: initial.id } : {}),
      title,
      description,
      difficulty,
      supportedLanguages: languages,
      // Only the supported languages' starter code is sent; the server
      // filters again, because this is a client and clients are suggestions.
      starterCode: Object.fromEntries(
        LANGUAGES.filter((l) => languages.includes(l.value)).map((l) => [
          l.key,
          starterCode[l.key] ?? '',
        ]),
      ),
      timeLimitMs,
      memoryLimitMb,
      testCases: rows.map((row) => ({
        input: row.input,
        expectedOutput: row.expectedOutput,
        description: row.description,
        weight: row.weight,
      })),
    };

    startTransition(async () => {
      const result = await saveQuestionAction(payload);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }
      toast.success(initial.id ? 'Question saved.' : 'Question created.');
      if (result.data.created) {
        router.push(`/admin/questions/${result.data.id}`);
      } else {
        router.refresh();
      }
    });
  }

  // Anything the form does not render next to a field — most usefully the
  // per-test-case messages, whose Zod paths look like `testCases.2.weight`
  // and mean nothing to the person reading them.
  const unmappedErrors = Object.entries(fieldErrors)
    .filter(
      ([key]) =>
        ![
          'title',
          'description',
          'difficulty',
          'supportedLanguages',
          'timeLimitMs',
          'memoryLimitMb',
        ].includes(key),
    )
    .map(([key, messages]) => [describeErrorPath(key), messages] as const);

  return (
    <div className="space-y-5">
      {error ? (
        <Alert tone="error" title={error}>
          {unmappedErrors.length > 0 ? (
            <ul className="mt-1 list-disc pl-4">
              {unmappedErrors.map(([label, messages]) => (
                <li key={label}>
                  <span className="font-medium">{label}</span>: {messages.join(' ')}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <Section title="Basics">
        <div className="space-y-4">
          <Field id={`${uid}-title`} label="Title" errors={fieldErrors['title']}>
            <Input
              id={`${uid}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              aria-invalid={!!fieldErrors['title']?.length}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={`${uid}-difficulty`} label="Difficulty" errors={fieldErrors['difficulty']}>
              <Select
                id={`${uid}-difficulty`}
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as Difficulty)}
              >
                {DIFFICULTIES.map((value) => (
                  <option key={value} value={value}>
                    {value.charAt(0) + value.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              id={`${uid}-time`}
              label="Time limit (ms)"
              errors={fieldErrors['timeLimitMs']}
              hint="Per test case."
            >
              <Input
                id={`${uid}-time`}
                type="number"
                inputMode="numeric"
                min={500}
                max={30000}
                value={timeLimitMs}
                onChange={(e) => setTimeLimitMs(e.target.value)}
                aria-invalid={!!fieldErrors['timeLimitMs']?.length}
              />
            </Field>

            <Field
              id={`${uid}-memory`}
              label="Memory limit (MB)"
              errors={fieldErrors['memoryLimitMb']}
              hint="Advisory — not enforced by browser execution."
            >
              <Input
                id={`${uid}-memory`}
                type="number"
                inputMode="numeric"
                min={16}
                max={2048}
                value={memoryLimitMb}
                onChange={(e) => setMemoryLimitMb(e.target.value)}
                aria-invalid={!!fieldErrors['memoryLimitMb']?.length}
              />
            </Field>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-[13px] font-medium">Supported languages</legend>
            <div className="flex flex-wrap gap-4">
              {LANGUAGES.map((language) => (
                <div key={language.value} className="flex items-center gap-2">
                  <Checkbox
                    id={`${uid}-lang-${language.key}`}
                    checked={languages.includes(language.value)}
                    onChange={(e) => toggleLanguage(language.value, e.target.checked)}
                  />
                  <Label htmlFor={`${uid}-lang-${language.key}`}>{language.label}</Label>
                </div>
              ))}
            </div>
            <FieldErrors errors={fieldErrors['supportedLanguages']} />
          </fieldset>
        </div>
      </Section>

      <Section title="Description" description="Markdown. This is what the candidate reads.">
        <Tabs defaultValue="edit">
          <TabsList className="mb-2">
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
          <TabsContent value="edit">
            <Label htmlFor={`${uid}-description`} className="sr-only">
              Description
            </Label>
            <Textarea
              id={`${uid}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={16}
              spellCheck={false}
              className="font-mono text-[13px]"
              aria-invalid={!!fieldErrors['description']?.length}
            />
            <FieldErrors errors={fieldErrors['description']} />
          </TabsContent>
          <TabsContent value="preview">
            <div className="bg-background min-h-40 rounded-md border px-4 py-3">
              {/*
                The same renderer the candidate gets, deliberately. A
                second, admin-only Markdown implementation existed here and
                had drifted: it dropped tables, ignored `__bold__`, flattened
                nested lists and clamped headings at h3 — so "Preview" showed
                something the candidate would never see, which is worse than
                no preview at all.
              */}
              <Markdown content={description} />
            </div>
          </TabsContent>
        </Tabs>
      </Section>

      <Section
        title="Starter code"
        description="Pre-filled in the candidate's editor. One buffer per supported language."
      >
        {languages.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">Select a language first.</p>
        ) : (
          <div className="space-y-4">
            {LANGUAGES.filter((l) => languages.includes(l.value)).map((language) => (
              <Field
                key={language.key}
                id={`${uid}-starter-${language.key}`}
                label={`${language.label} starter code`}
              >
                <Textarea
                  id={`${uid}-starter-${language.key}`}
                  value={starterCode[language.key] ?? ''}
                  onChange={(e) =>
                    setStarterCode((current) => ({ ...current, [language.key]: e.target.value }))
                  }
                  rows={8}
                  spellCheck={false}
                  className="font-mono text-[13px]"
                />
              </Field>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Test cases"
        description="Input is fed to stdin; output is compared against trimmed stdout."
        actions={
          <span className="flex items-center gap-3">
            <span className="text-muted-foreground text-[12px] tabular-nums">
              {rows.length} {rows.length === 1 ? 'test' : 'tests'} · total weight {totalWeight}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRows((current) => [...current, emptyRow()])}
            >
              <Plus className="size-3.5" aria-hidden />
              Add test
            </Button>
          </span>
        }
      >
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">
            No test cases. A question with no tests always scores zero, so add at least one.
          </p>
        ) : (
          <ol className="space-y-3">
            {rows.map((row, index) => (
              <li key={row.key} className="rounded-md border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                  <span className="text-[13px] font-medium">Test {index + 1}</span>
                  <span className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={index === 0}
                      onClick={() => moveRow(index, -1)}
                      aria-label={`Move test ${index + 1} up`}
                      title="Move up"
                    >
                      <ArrowUp className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={index === rows.length - 1}
                      onClick={() => moveRow(index, 1)}
                      aria-label={`Move test ${index + 1} down`}
                      title="Move down"
                    >
                      <ArrowDown className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                      aria-label={`Remove test ${index + 1}`}
                      title="Remove test"
                    >
                      <Trash2 className="text-destructive size-3.5" aria-hidden />
                    </Button>
                  </span>
                </div>

                <div className="space-y-3 px-3 py-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id={`${uid}-input-${row.key}`} label="Input (stdin)">
                      <Textarea
                        id={`${uid}-input-${row.key}`}
                        value={row.input}
                        onChange={(e) => patchRow(index, { input: e.target.value })}
                        rows={4}
                        spellCheck={false}
                        className="font-mono text-[12.5px]"
                      />
                    </Field>
                    <Field id={`${uid}-expected-${row.key}`} label="Expected output (stdout)">
                      <Textarea
                        id={`${uid}-expected-${row.key}`}
                        value={row.expectedOutput}
                        onChange={(e) => patchRow(index, { expectedOutput: e.target.value })}
                        rows={4}
                        spellCheck={false}
                        className="font-mono text-[12.5px]"
                      />
                    </Field>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                    <Field id={`${uid}-desc-${row.key}`} label="Description">
                      <Input
                        id={`${uid}-desc-${row.key}`}
                        value={row.description}
                        onChange={(e) => patchRow(index, { description: e.target.value })}
                        placeholder="What this case checks"
                      />
                    </Field>
                    <Field id={`${uid}-weight-${row.key}`} label="Weight">
                      <Input
                        id={`${uid}-weight-${row.key}`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={100}
                        value={String(row.weight)}
                        onChange={(e) =>
                          patchRow(index, { weight: Number.parseInt(e.target.value, 10) || 0 })
                        }
                      />
                    </Field>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <div className="bg-background/90 sticky bottom-0 flex flex-wrap items-center gap-2 border-t py-3 backdrop-blur">
        <Button type="button" onClick={save} loading={pending}>
          <Save className="size-3.5" aria-hidden />
          {initial.id ? 'Save question' : 'Create question'}
        </Button>
        <Button asChild variant="ghost">
          <Link href="/admin/questions">Cancel</Link>
        </Button>
        <span className="text-muted-foreground ml-auto text-[12px]">
          Saving replaces this question&rsquo;s test cases with exactly what is listed above.
        </span>
      </div>
    </div>
  );
}
