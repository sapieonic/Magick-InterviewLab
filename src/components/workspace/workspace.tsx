'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Check, Play, RotateCcw, Send, WifiOff } from 'lucide-react';
import type {
  ExecutionResult,
  Language,
  RuntimeCapabilities,
  TestResult,
} from '@/features/execution/types';
import { detectRuntimeCapabilities } from '@/features/execution/capabilities';
import { defaultStarterCode } from '@/features/execution/starter-code';
import type { WorkspaceData } from '@/features/submissions/view-model';
import { createSubmissionAction } from '@/features/submissions/actions';
import { LANGUAGE_LABEL, toDbLanguage } from '@/features/submissions/language';
import { CodeEditor } from '@/components/code-editor';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MobileWorkspace } from './mobile-workspace';
import { QuestionNav } from './question-nav';
import { ResultsPanel } from './results-panel';
import { SplitPane } from './split-pane';
import { SubmitDialog } from './submit-dialog';
import { TimerChip, useCountdown } from './interview-timer';
import { IDLE_RUN, runMatches, type RunState } from './run-state';
import { shouldAutoSubmit } from './auto-submit';
import { readRunCache, writeRunCache } from './run-cache';
import { useOnlineStatus } from './use-online-status';
import {
  useDraftAutosave,
  useLocalDrafts,
  writeLocalDraft,
  type DraftAutosave,
  type LocalDraft,
} from './use-draft-autosave';

/** Mirrors the caps in `createSubmissionSchema`; over-long values are clipped
 *  here rather than rejected by the action after a candidate has waited for a
 *  run to finish. */
const MAX_SOURCE = 200_000;
const MAX_IO = 20_000;
const MAX_ERROR = 4_000;
const MAX_DESCRIPTION = 300;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'An unexpected error stopped the run.';
}

function toResultPayload(tests: readonly TestResult[]) {
  return tests.map((test) => ({
    testCaseId: test.testCaseId,
    description: test.description ? clip(test.description, MAX_DESCRIPTION) : undefined,
    status: test.status,
    input: clip(test.input, MAX_IO),
    expectedOutput: clip(test.expectedOutput, MAX_IO),
    actualOutput: clip(test.actualOutput, MAX_IO),
    stderr: test.stderr ? clip(test.stderr, MAX_IO) : undefined,
    errorMessage: test.errorMessage ? clip(test.errorMessage, MAX_ERROR) : undefined,
    errorKind: test.errorKind,
    weight: Math.max(0, Math.min(1000, Math.round(test.weight))),
    durationMs: Math.max(0, Math.min(600_000, Math.round(test.durationMs))),
  }));
}

/**
 * 768px is the line below which a three-pane Monaco layout stops being an
 * editor and starts being a hazard. `useSyncExternalStore` rather than an
 * effect so hydration uses the server snapshot and then corrects in one go,
 * instead of flashing a desktop layout on a phone.
 */
function useIsDesktop(): boolean {
  const subscribe = React.useCallback((onChange: () => void) => {
    const query = window.matchMedia('(min-width: 768px)');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia('(min-width: 768px)').matches,
    () => true,
  );
}

function initialLanguage(data: WorkspaceData): Language {
  const supported = data.question.supportedLanguages;
  const fallback = supported[0] ?? 'javascript';
  // Pick up where they left off: the newest draft, else the newest
  // submission, else the question's first language.
  const newestDraft = [...data.drafts]
    .filter((draft) => supported.includes(draft.language))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (newestDraft) return newestDraft.language;
  const newestSubmission = data.submissions.find((submission) =>
    supported.includes(submission.language),
  );
  return newestSubmission?.language ?? fallback;
}

function starterFor(data: WorkspaceData, language: Language): string {
  return data.question.starterCode[language] ?? defaultStarterCode(language);
}

/**
 * The buffer a candidate starts from, per language: the newer of the server
 * draft and the localStorage mirror, falling back to the question's starter
 * code. `local` is null during SSR and on the hydrating render, which is
 * exactly why this is derived rather than stored — no effect, no mismatch.
 */
function resolveBuffers(
  data: WorkspaceData,
  local: Record<string, LocalDraft> | null,
): Record<string, string> {
  const buffers: Record<string, string> = {};
  for (const language of data.question.supportedLanguages) {
    const serverDraft = data.drafts.find((entry) => entry.language === language);
    const localDraft = local?.[language];
    const localWins =
      localDraft !== undefined &&
      (serverDraft === undefined || localDraft.updatedAt > serverDraft.updatedAt);
    buffers[language] = localWins
      ? localDraft.sourceCode
      : (serverDraft?.sourceCode ?? starterFor(data, language));
  }
  return buffers;
}

// Feature detection is a one-shot read of the environment, so it is cached
// and served as an external store: the server snapshot is null and the client
// snapshot is a stable object, which keeps it out of an effect.
let capabilitiesCache: RuntimeCapabilities | null = null;
const noopSubscribe = () => () => {};

function capabilitiesSnapshot(): RuntimeCapabilities {
  capabilitiesCache ??= detectRuntimeCapabilities();
  return capabilitiesCache;
}

// The last completed run for a question, restored from localStorage and frozen
// for the tab — the run equivalent of `useLocalDrafts`. Read through
// `useSyncExternalStore` with a null server snapshot so SSR and the hydrating
// render agree and React swaps the real value in on commit, no effect needed.
const restoredRunCache = new Map<string, RunState | null>();

function useRestoredRun(questionId: string): RunState | null {
  const getSnapshot = React.useCallback(() => {
    if (restoredRunCache.has(questionId)) return restoredRunCache.get(questionId) ?? null;
    const cached = readRunCache(questionId);
    const value: RunState | null = cached
      ? {
          id: 0,
          phase: 'complete',
          result: cached.result,
          progress: { completed: cached.result.tests.length, total: cached.result.tests.length },
          message: null,
          language: cached.language,
          sourceCode: cached.sourceCode,
        }
      : null;
    restoredRunCache.set(questionId, value);
    return value;
  }, [questionId]);
  return React.useSyncExternalStore(noopSubscribe, getSnapshot, () => null);
}

export function Workspace({ data }: { data: WorkspaceData }) {
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const { assignment, interview, question, questions } = data;

  const [language, setLanguage] = React.useState<Language>(() => initialLanguage(data));
  // Only the candidate's own edits live in state; the starting buffer is
  // derived, so a localStorage draft can appear after hydration without
  // clobbering anything already typed.
  const [edits, setEdits] = React.useState<Record<string, string>>({});
  const [run, setRun] = React.useState<RunState>(IDLE_RUN);
  const [pythonError, setPythonError] = React.useState<string | null>(null);
  const [pythonWarming, setPythonWarming] = React.useState(false);
  const [submitOpen, setSubmitOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [recorded, setRecorded] = React.useState<{
    score: number;
    passed: number;
    total: number;
  } | null>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);

  const autosave = useDraftAutosave(question.id);
  const countdown = useCountdown(assignment.startedAt, interview.durationMinutes);
  const online = useOnlineStatus();

  const localDrafts = useLocalDrafts(question.id, question.supportedLanguages);
  const baseBuffers = React.useMemo(() => resolveBuffers(data, localDrafts), [data, localDrafts]);
  const capabilities = React.useSyncExternalStore(noopSubscribe, capabilitiesSnapshot, () => null);

  const source = edits[language] ?? baseBuffers[language] ?? '';
  const runningRef = React.useRef(false);
  const runIdRef = React.useRef(0);
  const abortRef = React.useRef<AbortController | null>(null);

  // The last completed run for this question, restored from localStorage so a
  // refresh brings back the results panel (which is client-only state) instead
  // of blanking it. Read as an external store — server snapshot null, frozen
  // starting value — exactly like the draft mirror, so there is no hydration
  // mismatch and no restoring effect. It only ever seeds the *idle* run below.
  const restoredRun = useRestoredRun(question.id);

  // Latest values for effects that must not re-subscribe on every keystroke.
  const autosaveRef = React.useRef<DraftAutosave>(autosave);
  const languageRef = React.useRef<Language>(language);
  const sourceRef = React.useRef<string>(source);
  React.useEffect(() => {
    autosaveRef.current = autosave;
    languageRef.current = language;
    sourceRef.current = source;
  }, [autosave, language, source]);

  // Coming back online: re-push the current buffer so the server copy catches
  // up with the edits made while offline (which were held in localStorage and,
  // for failed saves, re-queued). Fires only on the offline→online edge.
  const prevOnlineRef = React.useRef(online);
  React.useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = online;
    if (online && !wasOnline) {
      autosaveRef.current.queue(languageRef.current, sourceRef.current);
      void autosaveRef.current.flush();
    }
  }, [online]);

  // Pyodide is ~10MB. It is fetched when the candidate chooses Python and
  // never for a JavaScript-only session — hence the effect on `language`
  // rather than a warm-up on page load.
  const warmedRef = React.useRef(new Set<Language>());
  React.useEffect(() => {
    if (language !== 'python' || warmedRef.current.has('python')) return;
    warmedRef.current.add('python');
    let cancelled = false;
    setPythonWarming(true);
    setPythonError(null);
    void (async () => {
      try {
        const { getExecutor } = await import('@/features/execution');
        await getExecutor('python').warmUp?.();
      } catch (error) {
        if (!cancelled) {
          setPythonError(
            `${messageOf(error)} You can still write Python, but running it needs a working connection to the runtime CDN.`,
          );
          // Allow a retry the next time they switch back.
          warmedRef.current.delete('python');
        }
      } finally {
        if (!cancelled) setPythonWarming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [language]);

  /**
   * Tear the runtimes down when the workspace unmounts.
   *
   * The executor registry is process-wide and memoised on purpose, so it
   * survives a re-render — but not, deliberately, a navigation away. A leaked
   * Pyodide worker holds tens of megabytes and keeps running whatever the
   * candidate last started, and a candidate who visits one Python question
   * then works through five JavaScript ones should not be carrying that for
   * the rest of the session.
   *
   * Its own dependency-free effect: folding it into the warm-up effect above
   * would dispose the runtime on every language switch, which is exactly the
   * cost the memoisation exists to avoid.
   */
  React.useEffect(() => {
    return () => {
      void import('@/features/execution').then(({ disposeExecutors }) => disposeExecutors());
    };
  }, []);

  const handleChange = React.useCallback(
    (next: string) => {
      setEdits((current) => ({ ...current, [language]: next }));
      writeLocalDraft(question.id, language, next);
      autosave.queue(language, next);
    },
    [autosave, language, question.id],
  );

  const switchLanguage = (next: Language) => {
    if (next === language) return;
    // Flush before swapping the buffer: the debounce timer would otherwise
    // still be holding the previous language's last keystrokes.
    void autosave.flush();
    setLanguage(next);
    setConfirmReset(false);
  };

  const resetToStarter = () => {
    const starter = starterFor(data, language);
    setEdits((current) => ({ ...current, [language]: starter }));
    writeLocalDraft(question.id, language, starter);
    autosave.queue(language, starter);
    setConfirmReset(false);
    toast.success(`Reset to the ${LANGUAGE_LABEL[language]} starter code.`);
  };

  const blockedReason: string | null = (() => {
    if (capabilities && !capabilities.ok) {
      return capabilities.reason ?? 'This browser cannot run code.';
    }
    if (question.testCases.length === 0) {
      return 'This question has no test cases yet, so there is nothing to run. You can still write and submit your answer.';
    }
    if (language === 'python' && pythonError) return pythonError;
    return null;
  })();

  const canRun = blockedReason === null && capabilities !== null;

  /**
   * Every exit from here settles the run state — the `finally` is the whole
   * point. A spinner that never stops during a timed interview is the worst
   * bug this screen can have, so an abort, a fatal error and a thrown
   * exception all land somewhere visible.
   */
  const executeTests = React.useCallback(async (): Promise<ExecutionResult | null> => {
    if (runningRef.current || !canRun) return null;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const sourceCode = source;
    const currentLanguage = language;
    const total = question.testCases.length;
    const runId = (runIdRef.current += 1);

    setRecorded(null);
    setRun({
      id: runId,
      phase: 'running',
      result: null,
      progress: { completed: 0, total },
      message: null,
      language: currentLanguage,
      sourceCode,
    });

    try {
      const { runTests } = await import('@/features/execution');
      const result = await runTests({
        language: currentLanguage,
        sourceCode,
        tests: question.testCases.map((test) => ({
          id: test.id,
          input: test.input,
          expectedOutput: test.expectedOutput,
          description: test.description,
          weight: test.weight,
        })),
        timeoutMs: question.timeLimitMs,
        signal: controller.signal,
        onProgress: (completed, progressTotal) => {
          setRun((current) =>
            current.phase === 'running'
              ? { ...current, progress: { completed, total: progressTotal } }
              : current,
          );
        },
      });

      if (controller.signal.aborted) {
        setRun({ ...IDLE_RUN, id: runId, phase: 'cancelled' });
        return null;
      }

      setRun({
        id: runId,
        phase: 'complete',
        result,
        progress: { completed: result.tests.length, total: result.tests.length },
        message: null,
        language: currentLanguage,
        sourceCode,
      });
      // Mirror the finished run so a refresh restores it (client-only state).
      writeRunCache(question.id, { language: currentLanguage, sourceCode, result });
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        setRun({ ...IDLE_RUN, id: runId, phase: 'cancelled' });
        return null;
      }
      setRun({ ...IDLE_RUN, id: runId, phase: 'error', message: messageOf(error) });
      return null;
    } finally {
      runningRef.current = false;
      abortRef.current = null;
    }
  }, [canRun, language, question.id, question.testCases, question.timeLimitMs, source]);

  const handleRun = React.useCallback(() => {
    void executeTests();
  }, [executeTests]);

  const cancelRun = () => abortRef.current?.abort();

  // Until the candidate starts a run this mount, show the run restored from
  // localStorage; after that, the live one wins. A restored run counts as
  // reusable on submit only while its buffer still matches (`runMatches`).
  const displayRun = run.phase === 'idle' ? (restoredRun ?? IDLE_RUN) : run;
  const reusableRun = runMatches(displayRun, language, source) ? displayRun.result : null;

  // Returns whether the submission was recorded, so the auto-submit path can
  // tell the candidate when a deadline submit did not go through (its dialog is
  // closed, so `submitError` alone would be invisible).
  const handleSubmit = async (): Promise<boolean> => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      await autosave.flush();
      let execution = reusableRun;
      if (!execution) {
        if (!canRun && question.testCases.length > 0) {
          setSubmitError(blockedReason ?? 'Tests cannot be run in this browser.');
          return false;
        }
        execution = await executeTests();
        if (!execution && question.testCases.length > 0) {
          setSubmitError('The test run did not finish, so nothing was submitted.');
          return false;
        }
      }

      const response = await createSubmissionAction({
        interviewId: interview.id,
        questionId: question.id,
        language: toDbLanguage(language),
        sourceCode: clip(source, MAX_SOURCE),
        results: toResultPayload(execution?.tests ?? []),
      });

      if (!response.ok) {
        setSubmitError(response.error);
        return false;
      }

      setSubmitOpen(false);
      setRecorded({
        score: response.data.score,
        passed: response.data.passed,
        total: response.data.total,
      });
      toast.success(`Submitted — scored ${response.data.score}%`);
      // Pull the fresh submission counts into the rail and the home page.
      router.refresh();
      return true;
    } catch (error) {
      // `createSubmissionAction` maps server-side failures to `{ok:false}`, but
      // the call itself can still reject on the transport — a dropped
      // connection, a 500 from the RSC endpoint, a chunk-load failure. Without
      // this catch the dialog would sit open with the spinner stopped and no
      // message, silently losing the most important action in the product.
      setSubmitError(messageOf(error));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const nextQuestion = (() => {
    const index = questions.findIndex((item) => item.id === question.id);
    return index >= 0 ? questions[index + 1] : undefined;
  })();

  const singleSubmissionUsed = !interview.allowMultipleSubmissions && data.submissions.length > 0;
  const submitDisabled = submitting || run.phase === 'running' || singleSubmissionUsed;

  // Client-side auto-submit at the deadline. Best-effort by nature — it can
  // only fire in an open tab with a live clock — so the server still accepts a
  // late submission; this captures a snapshot at time-up for the common case.
  const handleSubmitRef = React.useRef(handleSubmit);
  React.useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  });
  const autoSubmittedRef = React.useRef(false);
  const expiredAtLoadRef = React.useRef<boolean | null>(null);
  React.useEffect(() => {
    if (!countdown) return;
    // Record whether the deadline had already passed on the first real reading,
    // so a reload after time-up does not resubmit.
    if (expiredAtLoadRef.current === null) expiredAtLoadRef.current = countdown.expired;

    if (
      shouldAutoSubmit({
        isDesktop,
        expired: countdown.expired,
        expiredAtLoad: expiredAtLoadRef.current,
        submitting,
        singleSubmissionUsed,
        alreadyRecorded: recorded !== null,
        alreadyAutoSubmitted: autoSubmittedRef.current,
      })
    ) {
      autoSubmittedRef.current = true;
      toast('Time is up — submitting your current work.');
      void handleSubmitRef.current().then((ok) => {
        if (!ok) {
          // The dialog is closed, so its inline error is invisible — tell the
          // candidate here, and let them retry manually.
          toast.error('Auto-submit did not go through. Please submit manually.');
        }
      });
    }
  }, [countdown, isDesktop, submitting, singleSubmissionUsed, recorded]);

  // Offline, "Not saved" is alarming and wrong — the local mirror has the code
  // and the server copy syncs on reconnect — so reassure instead.
  const saveLabel = !online
    ? 'Saved on this device'
    : autosave.status === 'saving'
      ? 'Saving…'
      : autosave.status === 'error'
        ? 'Not saved'
        : autosave.status === 'pending'
          ? 'Unsaved changes'
          : autosave.status === 'saved'
            ? 'Saved'
            : 'Draft synced';
  const saveLabelError = online && autosave.status === 'error';

  if (!isDesktop) {
    return (
      <MobileWorkspace
        data={data}
        countdown={countdown}
        recorded={recorded}
        run={displayRun}
        blockedReason={blockedReason}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b px-3">
        <Link
          href="/interview"
          className="text-muted-foreground hover:text-foreground truncate text-[13px] transition-colors"
        >
          {interview.title}
        </Link>
        <span className="text-muted-foreground/50" aria-hidden>
          /
        </span>
        <h1 className="truncate text-[13px] font-semibold tracking-tight">
          {question.position}. {question.title}
        </h1>
        <Badge variant="outline" className="hidden lg:inline-flex">
          {question.difficulty.toLowerCase()}
        </Badge>

        <div className="ml-auto flex items-center gap-3">
          {!online ? (
            <span
              className="text-warning inline-flex items-center gap-1.5 text-[12px]"
              title="You are offline. Your work is saved in this browser and will sync when the connection returns."
            >
              <WifiOff className="size-3.5" aria-hidden />
              Offline
            </span>
          ) : null}
          <span
            className={cn(
              'text-[12px]',
              saveLabelError ? 'text-destructive' : 'text-muted-foreground',
            )}
            title="Your code is saved automatically, and mirrored in this browser."
          >
            {saveLabel}
          </span>
          <TimerChip countdown={countdown} />
        </div>
      </div>

      {countdown?.expired ? (
        <div className="border-destructive/25 bg-destructive/8 text-destructive flex shrink-0 items-center gap-2 border-b px-3 py-2 text-[13px]">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          <p>
            Your {interview.durationMinutes}-minute window has elapsed. You can still submit, but
            your reviewer will see the time it was recorded.
          </p>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 flex-col border-r lg:flex">
          <QuestionNav
            assignmentId={assignment.id}
            questions={questions}
            currentQuestionId={question.id}
            className="flex-1"
          />
        </aside>

        <div className="min-w-0 flex-1">
          <SplitPane
            className="h-full"
            orientation="vertical"
            storageKey="ilab.split.description"
            defaultFraction={0.34}
            minFraction={0.12}
            maxFraction={0.75}
            label="Resize the problem description"
            first={
              <div className="h-full scrollbar-thin overflow-y-auto px-5 py-4">
                <Markdown content={question.description} />
              </div>
            }
            second={
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex h-11 shrink-0 flex-wrap items-center gap-2 border-y px-3">
                  {question.supportedLanguages.length > 1 ? (
                    <div
                      className="bg-muted/60 flex items-center gap-0.5 rounded-md p-0.5"
                      role="group"
                      aria-label="Language"
                    >
                      {question.supportedLanguages.map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => switchLanguage(option)}
                          aria-pressed={option === language}
                          className={cn(
                            'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
                            option === language
                              ? 'bg-card text-foreground shadow-xs'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {LANGUAGE_LABEL[option]}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Badge variant="secondary">{LANGUAGE_LABEL[language]}</Badge>
                  )}

                  {pythonWarming ? (
                    <span className="text-muted-foreground text-[12px]">
                      Loading the Python runtime…
                    </span>
                  ) : null}

                  <div className="ml-auto flex items-center gap-2">
                    <span className="text-muted-foreground hidden text-[11px] xl:inline">
                      <kbd className="bg-muted rounded border px-1 py-0.5 font-mono text-[10px]">
                        Ctrl/Cmd + Enter
                      </kbd>{' '}
                      to run
                    </span>
                    <Button
                      variant={confirmReset ? 'destructive' : 'ghost'}
                      size="xs"
                      onClick={() => (confirmReset ? resetToStarter() : setConfirmReset(true))}
                      onBlur={() => setConfirmReset(false)}
                      title="Replace your code with the starter template"
                    >
                      <RotateCcw className="size-3.5" aria-hidden />
                      {confirmReset ? 'Confirm reset' : 'Reset'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRun}
                      loading={run.phase === 'running'}
                      disabled={!canRun}
                      title={blockedReason ?? 'Run the question’s test cases'}
                    >
                      {run.phase === 'running' ? null : <Play className="size-3.5" aria-hidden />}
                      Run tests
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setSubmitError(null);
                        setSubmitOpen(true);
                      }}
                      disabled={submitDisabled}
                      title={
                        singleSubmissionUsed
                          ? 'This interview allows one submission per question'
                          : 'Submit this question'
                      }
                    >
                      <Send className="size-3.5" aria-hidden />
                      Submit
                    </Button>
                  </div>
                </div>

                {recorded ? (
                  <div className="border-success/25 bg-success/8 flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-[13px]">
                    <Check className="text-success size-4 shrink-0" aria-hidden />
                    <p className="text-success">
                      Submitted — scored <span className="tnum font-medium">{recorded.score}%</span>{' '}
                      ({recorded.passed} of {recorded.total} tests).
                    </p>
                    {nextQuestion ? (
                      <Button asChild variant="ghost" size="xs" className="ml-auto">
                        <Link href={`/interview/${assignment.id}/q/${nextQuestion.id}`}>
                          Next question
                          <ArrowRight className="size-3.5" aria-hidden />
                        </Link>
                      </Button>
                    ) : (
                      <Button asChild variant="ghost" size="xs" className="ml-auto">
                        <Link href="/interview">Back to your interviews</Link>
                      </Button>
                    )}
                  </div>
                ) : null}

                {singleSubmissionUsed && !recorded ? (
                  <p className="text-muted-foreground shrink-0 border-b px-3 py-1.5 text-[12px]">
                    You have already submitted this question, and this interview allows one
                    submission per question.
                  </p>
                ) : null}

                <SplitPane
                  className="min-h-0 flex-1"
                  orientation="vertical"
                  storageKey="ilab.split.editor"
                  defaultFraction={0.62}
                  minFraction={0.2}
                  maxFraction={0.85}
                  label="Resize the editor"
                  first={
                    <CodeEditor
                      value={source}
                      onChange={handleChange}
                      language={language}
                      onRunShortcut={handleRun}
                      onSaveShortcut={() => void autosave.flush()}
                      ariaLabel={`${LANGUAGE_LABEL[language]} solution for ${question.title}`}
                    />
                  }
                  second={
                    <ResultsPanel
                      state={displayRun}
                      onCancel={cancelRun}
                      blockedReason={blockedReason}
                    />
                  }
                />
              </div>
            }
          />
        </div>
      </div>

      <SubmitDialog
        open={submitOpen}
        onOpenChange={(open) => {
          if (!submitting) setSubmitOpen(open);
        }}
        questionTitle={question.title}
        language={language}
        sourceCode={source}
        lastRun={reusableRun}
        submitting={submitting}
        error={submitError}
        allowMultipleSubmissions={interview.allowMultipleSubmissions}
        previousSubmissionCount={data.submissions.length}
        onConfirm={() => void handleSubmit()}
      />
    </div>
  );
}
