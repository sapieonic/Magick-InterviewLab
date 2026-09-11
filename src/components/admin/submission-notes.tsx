'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { MessageSquare, Trash2 } from 'lucide-react';
import { addSubmissionNoteAction, deleteSubmissionNoteAction } from '@/features/feedback/actions';
import { FieldErrors } from '@/components/admin/form';
import { Markdown } from '@/components/markdown';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { SubmissionNoteView } from '@/features/feedback/queries';
import type { ActionResult } from '@/lib/action-result';
import { formatDate } from '@/lib/utils';

/**
 * The reviewer thread on one submission.
 *
 * Not blind, unlike a scorecard: "line 42 reimplements `groupBy`" is exactly
 * the kind of thing the second reviewer should be told rather than have to
 * rediscover, and a note is an observation about code rather than a judgement
 * about a person. The line anchor is optional because most notes are about
 * the whole answer.
 */
export function SubmissionNotes({
  submissionId,
  notes,
  lineCount,
}: {
  submissionId: string;
  notes: readonly SubmissionNoteView[];
  lineCount: number;
}) {
  const [body, setBody] = useState('');
  const [lineStart, setLineStart] = useState('');
  const [lineEnd, setLineEnd] = useState('');
  const [result, setResult] = useState<ActionResult<undefined> | null>(null);
  const [pending, startTransition] = useTransition();

  const fieldErrors = result && !result.ok ? (result.fieldErrors ?? {}) : {};
  const generalError =
    result && !result.ok && Object.keys(fieldErrors).length === 0 ? result.error : null;

  function add(): void {
    const data = new FormData();
    data.set('submissionId', submissionId);
    data.set('body', body);
    data.set('lineStart', lineStart);
    data.set('lineEnd', lineEnd);
    startTransition(async () => {
      const outcome = await addSubmissionNoteAction(null, data);
      setResult(outcome);
      if (outcome.ok) {
        setBody('');
        setLineStart('');
        setLineEnd('');
        toast.success('Note added.');
      } else {
        toast.error(outcome.error);
      }
    });
  }

  function remove(id: string): void {
    const data = new FormData();
    data.set('id', id);
    startTransition(async () => {
      const outcome = await deleteSubmissionNoteAction(null, data);
      if (outcome.ok) toast.success('Note deleted.');
      else toast.error(outcome.error);
    });
  }

  return (
    <div className="space-y-4">
      {notes.length === 0 ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
          <MessageSquare className="size-3.5" aria-hidden />
          No notes yet. The first one usually saves the next reviewer ten minutes.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {notes.map((note) => (
            <li key={note.id} className="space-y-1.5 rounded-md border px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[13px] font-medium">{note.authorName}</span>
                {note.lineStart === null ? null : (
                  <span className="text-muted-foreground text-[12px] tabular-nums">
                    line {note.lineStart}
                    {note.lineEnd !== null && note.lineEnd !== note.lineStart
                      ? `–${note.lineEnd}`
                      : ''}
                  </span>
                )}
                <span className="text-muted-foreground text-[12px]">
                  {formatDate(note.createdAt)}
                </span>
                {note.canDelete ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="ml-auto"
                    disabled={pending}
                    onClick={() => remove(note.id)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    Delete
                  </Button>
                ) : null}
              </div>
              <Markdown content={note.body} className="text-[13px]" />
            </li>
          ))}
        </ul>
      )}

      {generalError ? <Alert tone="error">{generalError}</Alert> : null}

      <div className="space-y-2.5 border-t pt-4">
        <div className="space-y-1.5">
          <Label htmlFor="note-body">Add a note</Label>
          <Textarea
            id="note-body"
            value={body}
            rows={3}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What you noticed, and why it matters. Markdown is supported."
            aria-invalid={!!fieldErrors['body']?.length}
          />
          <FieldErrors errors={fieldErrors['body']} />
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="w-24 space-y-1.5">
            <Label htmlFor="lineStart" className="text-muted-foreground text-[12px]">
              First line
            </Label>
            <Input
              id="lineStart"
              type="number"
              min={1}
              max={lineCount}
              inputMode="numeric"
              value={lineStart}
              onChange={(e) => setLineStart(e.target.value)}
            />
          </div>
          <div className="w-24 space-y-1.5">
            <Label htmlFor="lineEnd" className="text-muted-foreground text-[12px]">
              Last line
            </Label>
            <Input
              id="lineEnd"
              type="number"
              min={1}
              max={lineCount}
              inputMode="numeric"
              value={lineEnd}
              onChange={(e) => setLineEnd(e.target.value)}
            />
          </div>
          <Button type="button" size="sm" loading={pending} onClick={add} disabled={pending}>
            Add note
          </Button>
        </div>
        <FieldErrors errors={fieldErrors['lineEnd'] ?? fieldErrors['lineStart']} />
        <p className="text-muted-foreground text-[12px]">
          Lines are optional, and refer to the source above ({lineCount}{' '}
          {lineCount === 1 ? 'line' : 'lines'}). Only you can delete your own notes.
        </p>
      </div>
    </div>
  );
}
