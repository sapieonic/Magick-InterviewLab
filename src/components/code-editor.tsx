'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { useTheme } from 'next-themes';
import type { OnMount } from '@monaco-editor/react';
import type { Language } from '@/features/execution/types';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * Monaco, with an escape hatch.
 *
 * Monaco is loaded from a CDN by `@monaco-editor/loader`. That is fine until
 * it isn't — a corporate proxy, an offline laptop, a bad afternoon at
 * jsDelivr — and a candidate in a timed interview cannot be left staring at a
 * skeleton. So the load is watched explicitly and a plain monospace textarea
 * takes over on failure or after `LOAD_TIMEOUT_MS`. It is a worse editor; it
 * is not a locked door.
 */

const LOAD_TIMEOUT_MS = 20_000;

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((mod) => mod.Editor), {
  ssr: false,
  loading: () => <EditorSkeleton />,
});

type LoadStatus = 'loading' | 'ready' | 'failed';

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: Language;
  readOnly?: boolean;
  /** Cmd/Ctrl+Enter. */
  onRunShortcut?: () => void;
  /** Cmd/Ctrl+S — the browser's Save dialog is suppressed either way. */
  onSaveShortcut?: () => void;
  className?: string;
  ariaLabel?: string;
}

function EditorSkeleton() {
  return (
    <div className="bg-surface-code h-full w-full p-4" aria-hidden>
      <div className="space-y-2.5">
        {[92, 64, 78, 40, 84, 56, 70].map((width, i) => (
          <div
            key={i}
            className="bg-muted-foreground/12 h-3 animate-pulse rounded"
            style={{ width: `${width}%`, animationDelay: `${i * 60}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

/** Python conventionally indents four; JavaScript two. */
function tabSizeFor(language: Language): number {
  return language === 'python' ? 4 : 2;
}

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  onRunShortcut,
  onSaveShortcut,
  className,
  ariaLabel = 'Code editor',
}: CodeEditorProps) {
  const { resolvedTheme } = useTheme();
  const [status, setStatus] = React.useState<LoadStatus>('loading');

  // Monaco actions are registered once on mount, so they must read the
  // *current* handlers rather than the ones that existed at mount time.
  // Synced in an effect, not during render: a ref write during render is
  // invisible to React and breaks under concurrent rendering.
  const runRef = React.useRef(onRunShortcut);
  const saveRef = React.useRef(onSaveShortcut);
  const changeRef = React.useRef(onChange);
  React.useEffect(() => {
    runRef.current = onRunShortcut;
    saveRef.current = onSaveShortcut;
    changeRef.current = onChange;
  }, [onRunShortcut, onSaveShortcut, onChange]);

  React.useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) {
        setStatus((current) => (current === 'loading' ? 'failed' : current));
      }
    }, LOAD_TIMEOUT_MS);

    // `loader.init()` is memoised inside the package, so resolving it here
    // costs nothing extra when <Editor> mounts a moment later — it just gives
    // us a promise to attach a failure path to.
    void import('@monaco-editor/react')
      .then((mod) => mod.loader.init())
      .then(() => {
        if (!cancelled) setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('failed');
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const handleMount = React.useCallback<OnMount>((editor, monaco) => {
    editor.addAction({
      id: 'interviewlab.runTests',
      label: 'Run tests',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => runRef.current?.(),
    });
    editor.addAction({
      id: 'interviewlab.saveDraft',
      label: 'Save draft',
      // Registering Cmd/Ctrl+S is also what stops the browser Save dialog:
      // Monaco consumes the keydown before the page ever sees it.
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => saveRef.current?.(),
    });
  }, []);

  const options = React.useMemo(
    () => ({
      readOnly,
      domReadOnly: readOnly,
      fontSize: 13,
      lineHeight: 20,
      fontFamily:
        "ui-monospace, 'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace",
      fontLigatures: false,
      lineNumbers: 'on' as const,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderLineHighlight: 'line' as const,
      tabSize: tabSizeFor(language),
      insertSpaces: true,
      detectIndentation: false,
      autoIndent: 'full' as const,
      formatOnPaste: true,
      matchBrackets: 'always' as const,
      bracketPairColorization: { enabled: true },
      autoClosingBrackets: 'languageDefined' as const,
      autoClosingQuotes: 'languageDefined' as const,
      suggestOnTriggerCharacters: true,
      quickSuggestions: { other: true, comments: false, strings: false },
      wordBasedSuggestions: 'currentDocument' as const,
      tabCompletion: 'on' as const,
      padding: { top: 12, bottom: 12 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      automaticLayout: true,
      cursorBlinking: 'smooth' as const,
      renderWhitespace: 'selection' as const,
      stickyScroll: { enabled: false },
      contextmenu: false,
    }),
    [language, readOnly],
  );

  if (status === 'failed') {
    return (
      <FallbackEditor
        value={value}
        onChange={onChange}
        language={language}
        readOnly={readOnly}
        onRunShortcut={onRunShortcut}
        onSaveShortcut={onSaveShortcut}
        className={className}
        ariaLabel={ariaLabel}
      />
    );
  }

  return (
    <div className={cn('bg-surface-code h-full w-full overflow-hidden', className)}>
      {status === 'loading' ? (
        <EditorSkeleton />
      ) : (
        <MonacoEditor
          language={language}
          theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
          value={value}
          onChange={(next) => changeRef.current(next ?? '')}
          onMount={handleMount}
          options={options}
          loading={<EditorSkeleton />}
          wrapperProps={{ 'aria-label': ariaLabel }}
        />
      )}
    </div>
  );
}

/**
 * The degraded editor. No autocomplete, but Tab still indents and the two
 * shortcuts still work, which is the difference between "cramped" and
 * "unusable".
 */
function FallbackEditor({
  value,
  onChange,
  language,
  readOnly,
  onRunShortcut,
  onSaveShortcut,
  className,
  ariaLabel,
}: Required<Pick<CodeEditorProps, 'value' | 'onChange' | 'language'>> &
  Pick<CodeEditorProps, 'readOnly' | 'onRunShortcut' | 'onSaveShortcut' | 'className'> & {
    ariaLabel: string;
  }) {
  const indent = ' '.repeat(tabSizeFor(language));

  return (
    <div className={cn('bg-surface-code flex h-full w-full flex-col', className)}>
      <p className="text-muted-foreground border-b px-3 py-1.5 text-[11px]">
        The rich editor could not be loaded, so this is a plain text editor. Your code still runs
        and submits normally.
      </p>
      <Textarea
        aria-label={ariaLabel}
        spellCheck={false}
        readOnly={readOnly}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          const mod = event.metaKey || event.ctrlKey;
          if (mod && event.key === 'Enter') {
            event.preventDefault();
            onRunShortcut?.();
            return;
          }
          if (mod && event.key.toLowerCase() === 's') {
            event.preventDefault();
            onSaveShortcut?.();
            return;
          }
          if (event.key === 'Tab') {
            event.preventDefault();
            const target = event.currentTarget;
            const { selectionStart, selectionEnd } = target;
            const next = value.slice(0, selectionStart) + indent + value.slice(selectionEnd);
            onChange(next);
            // Restore the caret after React re-renders with the new value.
            requestAnimationFrame(() => {
              target.selectionStart = target.selectionEnd = selectionStart + indent.length;
            });
          }
        }}
        className="h-full min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-[13px] leading-5 shadow-none focus-visible:outline-0"
      />
    </div>
  );
}
