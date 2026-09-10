'use client';

import * as React from 'react';
import type { Language } from '@/features/execution/types';
import { saveDraftAction } from '@/features/submissions/actions';
import { toDbLanguage } from '@/features/submissions/language';

/**
 * Autosave, twice over.
 *
 * The server copy (`CodeDraft`) is what survives a new laptop; the
 * localStorage copy is what survives a dead wifi connection, and it is
 * written synchronously on every keystroke because it is the only write that
 * is guaranteed to land. The server write is debounced — a keystroke-rate
 * round trip would be both wasteful and slower than the typing.
 *
 * On unload the server write is *best effort* and usually loses the race; the
 * local mirror is the reason that is acceptable rather than a data-loss bug.
 */

const STORAGE_PREFIX = 'ilab.draft.v1';
export const AUTOSAVE_DEBOUNCE_MS = 1500;

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface LocalDraft {
  sourceCode: string;
  updatedAt: number;
}

function storageKey(questionId: string, language: Language): string {
  return `${STORAGE_PREFIX}.${questionId}.${language}`;
}

export function readLocalDraft(questionId: string, language: Language): LocalDraft | null {
  try {
    const raw = window.localStorage.getItem(storageKey(questionId, language));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const sourceCode = record['sourceCode'];
    const updatedAt = record['updatedAt'];
    if (typeof sourceCode !== 'string' || typeof updatedAt !== 'number') return null;
    return { sourceCode, updatedAt };
  } catch {
    // Corrupt entry, private mode, storage disabled — treat as absent.
    return null;
  }
}

export function writeLocalDraft(questionId: string, language: Language, sourceCode: string): void {
  try {
    window.localStorage.setItem(
      storageKey(questionId, language),
      JSON.stringify({ sourceCode, updatedAt: Date.now() } satisfies LocalDraft),
    );
  } catch {
    // Quota or a locked-down browser. The server draft still covers us.
  }
}

export interface DraftAutosave {
  status: SaveStatus;
  savedAt: number | null;
  /** Record a change; the server write happens after the debounce settles. */
  queue: (language: Language, sourceCode: string) => void;
  /** Write anything pending right now (language switch, submit, tab hidden). */
  flush: () => Promise<void>;
}

export function useDraftAutosave(questionId: string): DraftAutosave {
  const [status, setStatus] = React.useState<SaveStatus>('idle');
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const pendingRef = React.useRef(new Map<Language, string>());
  const timerRef = React.useRef<number | null>(null);

  const flush = React.useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = Array.from(pendingRef.current.entries());
    if (pending.length === 0) return;
    pendingRef.current.clear();
    setStatus('saving');

    try {
      const results = await Promise.all(
        pending.map(([language, sourceCode]) =>
          saveDraftAction({ questionId, language: toDbLanguage(language), sourceCode }),
        ),
      );
      if (results.some((result) => !result.ok)) {
        setStatus('error');
        return;
      }
      setStatus('saved');
      setSavedAt(Date.now());
    } catch {
      // A failed save is not fatal — the local mirror already has the code —
      // but the candidate deserves to know the cloud copy is behind.
      setStatus('error');
    }
  }, [questionId]);

  const flushRef = React.useRef(flush);
  flushRef.current = flush;

  const queue = React.useCallback((language: Language, sourceCode: string) => {
    pendingRef.current.set(language, sourceCode);
    setStatus('pending');
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void flushRef.current();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, []);

  React.useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flushRef.current();
    };
    const onUnload = () => {
      void flushRef.current();
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      // Navigating between questions must not drop the buffer we were about
      // to save.
      void flushRef.current();
    };
  }, []);

  return { status, savedAt, queue, flush };
}
