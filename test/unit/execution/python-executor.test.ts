/**
 * Same injected-fake-worker approach as the JavaScript executor tests, plus
 * the two things that are unique to Python: the `init` handshake, and the fact
 * that a timeout destroys the interpreter and forces a re-init.
 *
 * Pyodide itself is never loaded here. Downloading ~10MB of WebAssembly in a
 * unit test would be slow, network-dependent and would not exercise anything
 * this file is responsible for.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PythonExecutor } from '@/features/execution/python-executor';
import { pyodideIndexUrl } from '@/features/execution/runtime-config';
import { ExecutorEnvironmentError } from '@/features/execution/types';
import type { TestCase } from '@/features/execution/types';
import type {
  WorkerEventLike,
  WorkerEventName,
  WorkerLike,
} from '@/features/execution/worker-bridge';

type Listener = (event: WorkerEventLike) => void;
type Responder = (message: Record<string, unknown>, worker: FakeWorker) => void;

const INDEX_URL = 'https://cdn.example.test/pyodide/v0/full/';

class FakeWorker implements WorkerLike {
  readonly received: Record<string, unknown>[] = [];
  terminateCount = 0;

  readonly #listeners = new Map<WorkerEventName, Set<Listener>>();
  readonly #respond: Responder;

  constructor(respond: Responder) {
    this.#respond = respond;
  }

  get messageTypes(): string[] {
    return this.received.map((m) => String(m['type']));
  }

  postMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const record = message as Record<string, unknown>;
    this.received.push(record);
    queueMicrotask(() => {
      if (this.terminateCount > 0) return;
      this.#respond(record, this);
    });
  }

  addEventListener(type: WorkerEventName, listener: Listener): void {
    const set = this.#listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: WorkerEventName, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(data: unknown): void {
    for (const listener of [...(this.#listeners.get('message') ?? [])]) listener({ data });
  }

  replyResult(run: Record<string, unknown>, payload: Record<string, unknown>): void {
    this.emit({ type: 'result', id: run['id'], stdout: '', stderr: '', durationMs: 1, ...payload });
  }
}

function makeTest(overrides: Partial<TestCase> = {}): TestCase {
  return { id: 'case-1', input: '1\n', expectedOutput: '1', weight: 1, ...overrides };
}

function harness(
  respond: Responder,
  options: { initTimeoutMs?: number } = {},
): { executor: PythonExecutor; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const executor = new PythonExecutor({
    indexUrl: INDEX_URL,
    initTimeoutMs: options.initTimeoutMs ?? 1000,
    workerFactory: () => {
      const worker = new FakeWorker(respond);
      workers.push(worker);
      return worker;
    },
  });
  return { executor, workers };
}

/** The common case: the worker loads Pyodide and echoes stdin back as stdout. */
const echoRunner: Responder = (message, worker) => {
  if (message['type'] === 'init') {
    worker.emit({ type: 'ready' });
    return;
  }
  if (message['type'] === 'run') {
    worker.replyResult(message, { stdout: `${String(message['input']).trim()}\n` });
  }
};

describe('PythonExecutor', () => {
  it('performs the init handshake before the first test and then runs', async () => {
    const { executor, workers } = harness(echoRunner);

    const result = await executor.execute({
      language: 'python',
      sourceCode: 'print(input())',
      timeoutMs: 1000,
      tests: [makeTest({ id: 'a', input: '1\n', expectedOutput: '1' })],
    });

    expect(workers).toHaveLength(1);
    expect(workers[0]?.messageTypes).toEqual(['init', 'run']);
    expect(workers[0]?.received[0]?.['indexUrl']).toBe(INDEX_URL);
    expect(result.status).toBe('passed');
    executor.dispose();
  });

  it('initialises exactly once across warmUp and several runs', async () => {
    const { executor, workers } = harness(echoRunner);

    await executor.warmUp();
    await executor.warmUp();
    await executor.execute({
      language: 'python',
      sourceCode: 'print(input())',
      timeoutMs: 1000,
      tests: [makeTest({ id: 'a' }), makeTest({ id: 'b' })],
    });
    await executor.execute({
      language: 'python',
      sourceCode: 'print(input())',
      timeoutMs: 1000,
      tests: [makeTest({ id: 'c' })],
    });

    expect(workers).toHaveLength(1);
    // One init, three runs — Pyodide is never reloaded on the happy path.
    expect(workers[0]?.messageTypes).toEqual(['init', 'run', 'run', 'run']);
    executor.dispose();
  });

  it('surfaces an init failure as ExecutorEnvironmentError, not as failed tests', async () => {
    const { executor } = harness((message, worker) => {
      if (message['type'] === 'init') {
        worker.emit({ type: 'init-error', message: 'Failed to fetch pyodide.js' });
      }
    });

    // The candidate's code is irrelevant here; blaming it would be a lie.
    await expect(
      executor.execute({
        language: 'python',
        sourceCode: 'print(1)',
        timeoutMs: 1000,
        tests: [makeTest()],
      }),
    ).rejects.toThrow(ExecutorEnvironmentError);

    await expect(executor.warmUp()).rejects.toThrow(/Failed to fetch pyodide\.js/);
    executor.dispose();
  });

  it('does not cache a failed init — clicking Run again really retries', async () => {
    let attempts = 0;
    const { executor, workers } = harness((message, worker) => {
      if (message['type'] === 'init') {
        attempts += 1;
        if (attempts === 1) {
          worker.emit({ type: 'init-error', message: 'transient CDN blip' });
          return;
        }
        worker.emit({ type: 'ready' });
        return;
      }
      if (message['type'] === 'run') worker.replyResult(message, { stdout: '1\n' });
    });

    await expect(executor.warmUp()).rejects.toThrow(ExecutorEnvironmentError);

    const result = await executor.execute({
      language: 'python',
      sourceCode: 'print(1)',
      timeoutMs: 1000,
      tests: [makeTest({ expectedOutput: '1' })],
    });

    expect(attempts).toBe(2);
    expect(workers[0]?.messageTypes).toEqual(['init', 'init', 'run']);
    expect(result.status).toBe('passed');
    executor.dispose();
  });

  it('reports an init that never answers as an environment error naming the CDN', async () => {
    const { executor, workers } = harness(
      () => {
        /* the worker never replies to init */
      },
      { initTimeoutMs: 30 },
    );

    await expect(executor.warmUp()).rejects.toThrow(new RegExp(INDEX_URL.replace(/[/.]/g, '\\$&')));
    expect(workers[0]?.terminateCount).toBe(1);
    executor.dispose();
  });

  it('reports a worker that cannot start as an environment error', async () => {
    const executor = new PythonExecutor({
      indexUrl: INDEX_URL,
      workerFactory: () => {
        throw new Error('blocked by CSP');
      },
    });

    await expect(executor.warmUp()).rejects.toThrow(ExecutorEnvironmentError);
    await expect(executor.warmUp()).rejects.toThrow(/blocked by CSP/);
    executor.dispose();
  });

  it('terminates on a run timeout and re-initialises on the next call', async () => {
    let runs = 0;
    const { executor, workers } = harness((message, worker) => {
      if (message['type'] === 'init') {
        worker.emit({ type: 'ready' });
        return;
      }
      if (message['type'] === 'run') {
        runs += 1;
        if (runs === 1) return; // `while True: pass`
        worker.replyResult(message, { stdout: '1\n' });
      }
    });

    const first = await executor.execute({
      language: 'python',
      sourceCode: 'while True: pass',
      timeoutMs: 30,
      tests: [makeTest({ id: 'a', expectedOutput: '1' })],
    });

    expect(first.tests[0]?.status).toBe('timeout');
    expect(workers).toHaveLength(1);
    expect(workers[0]?.terminateCount).toBe(1);

    const second = await executor.execute({
      language: 'python',
      sourceCode: 'print(1)',
      timeoutMs: 1000,
      tests: [makeTest({ id: 'b', expectedOutput: '1' })],
    });

    // A killed interpreter cannot be reused; a second worker had to be built
    // and Pyodide loaded into it again.
    expect(workers).toHaveLength(2);
    expect(workers[1]?.messageTypes).toEqual(['init', 'run']);
    expect(second.status).toBe('passed');
    executor.dispose();
  });

  it('re-initialises mid-run after a timeout so later tests still execute', async () => {
    let runs = 0;
    const { executor, workers } = harness((message, worker) => {
      if (message['type'] === 'init') {
        worker.emit({ type: 'ready' });
        return;
      }
      if (message['type'] === 'run') {
        runs += 1;
        if (runs === 1) return;
        worker.replyResult(message, { stdout: '1\n' });
      }
    });

    const result = await executor.execute({
      language: 'python',
      sourceCode: 'print(1)',
      timeoutMs: 30,
      tests: [
        makeTest({ id: 'a', expectedOutput: '1' }),
        makeTest({ id: 'b', expectedOutput: '1' }),
      ],
    });

    expect(result.tests.map((t) => t.status)).toEqual(['timeout', 'passed']);
    expect(workers).toHaveLength(2);
    executor.dispose();
  });

  it('short-circuits the remaining tests on a Python SyntaxError', async () => {
    const { executor, workers } = harness((message, worker) => {
      if (message['type'] === 'init') {
        worker.emit({ type: 'ready' });
        return;
      }
      worker.replyResult(message, {
        error: 'SyntaxError: invalid syntax',
        errorKind: 'syntax',
      });
    });

    const result = await executor.execute({
      language: 'python',
      sourceCode: 'def f(:',
      timeoutMs: 1000,
      tests: [makeTest({ id: 'a' }), makeTest({ id: 'b' })],
    });

    expect(workers[0]?.messageTypes).toEqual(['init', 'run']);
    expect(result.tests.every((t) => t.errorKind === 'syntax')).toBe(true);
    expect(result.fatalError).toContain('SyntaxError');
    executor.dispose();
  });

  it('honours an AbortSignal', async () => {
    const controller = new AbortController();
    const { executor, workers } = harness((message, worker) => {
      if (message['type'] === 'init') {
        worker.emit({ type: 'ready' });
        return;
      }
      setTimeout(() => controller.abort(), 10);
    });

    const result = await executor.execute({
      language: 'python',
      sourceCode: 'while True: pass',
      timeoutMs: 5000,
      signal: controller.signal,
      tests: [makeTest({ id: 'a' })],
    });

    expect(result.tests[0]?.errorMessage).toBe('Run cancelled.');
    expect(workers[0]?.terminateCount).toBe(1);
    executor.dispose();
  });
});

describe('pyodideIndexUrl', () => {
  it('always ends in a slash, because the worker concatenates "pyodide.js" onto it', () => {
    expect(pyodideIndexUrl().endsWith('/')).toBe(true);
  });
});

describe('py-runner.js source contract', () => {
  const source = readFileSync(
    new URL('../../../public/workers/py-runner.js', import.meta.url),
    'utf8',
  );

  /**
   * Pyodide 314 refuses to initialise in a classic worker ("Classic web
   * workers are not supported") and ships its loader only as an ES module,
   * so this runner is a *module* worker. It still must not use a top-level
   * static import: the runtime URL is configurable at runtime, so the loader
   * has to be pulled in dynamically. Both halves are pinned here because the
   * failure is invisible until Pyodide actually boots in a browser.
   */
  it('has no top-level static import or export', () => {
    expect(source).not.toMatch(/^\s*import\s+[\w{*]/m);
    expect(source).not.toMatch(/^\s*export\s/m);
  });

  /**
   * The worker script being a module is only half of it — the host has to
   * create it as one. Tests inject a fake factory, so nothing else in this
   * suite would notice `defaultWorkerFactory` losing the 'module' argument.
   */
  it('is created as a module worker by the executor', () => {
    const executorSource = readFileSync(
      new URL('../../../src/features/execution/python-executor.ts', import.meta.url),
      'utf8',
    );
    expect(executorSource).toMatch(/defaultWorkerFactory\([^)]*'module'\s*,?\s*\)/s);
  });

  it('loads Pyodide by dynamic module import, never importScripts', () => {
    expect(source).not.toContain('importScripts');
    expect(source).toContain('pyodide.mjs');
    expect(source).toContain('await import(moduleUrl)');
    expect(source).toContain('loadPyodide');
    expect(source).toContain('indexURL');
  });

  /**
   * The network surfaces are revoked only AFTER `loadPyodide` — Pyodide needs
   * `fetch` to download the runtime, and candidate code runs afterwards. If
   * hardening ever moved before the load it would break init; if it were
   * dropped, `import js; js.fetch(...)` would reach the network again. The
   * ordering and the presence are both verified end to end by
   * `test/e2e/python-execution.spec.ts`; this pins them cheaply against an
   * accidental edit. `postMessage`/`close` must stay callable (the worker
   * replies through them), so they must NOT appear in the revoked set.
   */
  it('hardens the worker globals after Pyodide has loaded', () => {
    expect(source).toContain('hardenGlobalScope');
    const loadAt = source.indexOf('loadPyodide({');
    const hardenAt = source.lastIndexOf('hardenGlobalScope();');
    expect(loadAt).toBeGreaterThan(-1);
    expect(hardenAt).toBeGreaterThan(loadAt);
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket']) {
      expect(source).toContain(`'${name}'`);
    }
    // The worker's own reply channel must survive hardening.
    expect(source).not.toMatch(/blockedCallables\s*=\s*\[[^\]]*'postMessage'/s);
    expect(source).not.toMatch(/blockedCallables\s*=\s*\[[^\]]*'close'/s);
  });

  it('compiles before exec so a SyntaxError is classified as one', () => {
    expect(source).toContain("compile(source, _MVIL_FILENAME, 'exec')");
    expect(source).toContain('except SyntaxError as exc');
    expect(source).toContain("result['error_kind'] = 'syntax'");
  });

  it('gives every run a fresh globals dict and restores the streams', () => {
    expect(source).toContain("run_globals = {'__name__': '__main__'");
    expect(source).toContain('exec(code, run_globals)');
    expect(source).toContain('sys.stdin, sys.stdout, sys.stderr = saved');
    expect(source).toContain('io.StringIO(stdin_text)');
  });

  it('strips harness frames out of the traceback', () => {
    expect(source).toContain('if f.filename == _MVIL_FILENAME');
  });

  it('answers both handshake outcomes so the host never hangs', () => {
    expect(source).toContain("type: 'ready'");
    expect(source).toContain("type: 'init-error'");
  });
});
