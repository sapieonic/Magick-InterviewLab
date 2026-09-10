/**
 * The executor is driven through an injected fake Worker.
 *
 * A real Worker cannot be used here — vitest runs in Node, there is no DOM
 * `Worker`, and even if there were, asserting "we called terminate() on an
 * infinite loop" would mean actually running an infinite loop in CI. The fake
 * implements only the three members `WorkerBridge` touches, which is the whole
 * reason the factory is injectable.
 */

import { describe, expect, it, vi } from 'vitest';

import { JavaScriptExecutor } from '@/features/execution/javascript-executor';
import type { TestCase } from '@/features/execution/types';
import type {
  WorkerEventLike,
  WorkerEventName,
  WorkerLike,
} from '@/features/execution/worker-bridge';

type Listener = (event: WorkerEventLike) => void;
type Responder = (message: RunMessage, worker: FakeWorker) => void;

interface RunMessage {
  type: 'run';
  id: string;
  sourceCode: string;
  input: string;
}

function asRunMessage(message: unknown): RunMessage | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record['type'] !== 'run' || typeof record['id'] !== 'string') return null;
  return {
    type: 'run',
    id: record['id'],
    sourceCode: typeof record['sourceCode'] === 'string' ? record['sourceCode'] : '',
    input: typeof record['input'] === 'string' ? record['input'] : '',
  };
}

class FakeWorker implements WorkerLike {
  readonly runs: RunMessage[] = [];
  terminateCount = 0;

  readonly #listeners = new Map<WorkerEventName, Set<Listener>>();
  readonly #respond: Responder;

  constructor(respond: Responder) {
    this.#respond = respond;
  }

  postMessage(message: unknown): void {
    const run = asRunMessage(message);
    if (!run) return;
    this.runs.push(run);
    // Asynchronous, like a real worker: a synchronous reply would hide
    // ordering bugs the real thing would expose.
    queueMicrotask(() => {
      if (this.terminateCount > 0) return;
      this.#respond(run, this);
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

  reply(
    run: RunMessage,
    payload: Partial<Omit<RunMessage, 'type'>> & Record<string, unknown>,
  ): void {
    this.emit({
      type: 'result',
      id: run.id,
      stdout: '',
      stderr: '',
      durationMs: 1,
      ...payload,
    });
  }

  emit(data: unknown): void {
    for (const listener of [...(this.#listeners.get('message') ?? [])]) listener({ data });
  }
}

function makeTest(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'case-1',
    input: '1\n',
    expectedOutput: '1',
    weight: 1,
    ...overrides,
  };
}

/** Builds an executor plus a record of every worker the factory handed out. */
function harness(respond: Responder): {
  executor: JavaScriptExecutor;
  workers: FakeWorker[];
  factoryCalls: () => number;
} {
  const workers: FakeWorker[] = [];
  const executor = new JavaScriptExecutor({
    workerFactory: () => {
      const worker = new FakeWorker(respond);
      workers.push(worker);
      return worker;
    },
  });
  return { executor, workers, factoryCalls: () => workers.length };
}

describe('JavaScriptExecutor', () => {
  it('passes every test when stdout matches', async () => {
    const { executor } = harness((run, worker) => {
      worker.reply(run, { stdout: `${run.input.trim()}\n` });
    });

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'console.log(readLine());',
      timeoutMs: 1000,
      tests: [
        makeTest({ id: 'a', input: '1\n', expectedOutput: '1' }),
        makeTest({ id: 'b', input: '2\n', expectedOutput: '2' }),
      ],
    });

    expect(result.status).toBe('passed');
    expect(result.tests.map((t) => t.status)).toEqual(['passed', 'passed']);
    expect(result.tests[0]?.testCaseId).toBe('a');
    expect(result.fatalError).toBeUndefined();
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    executor.dispose();
  });

  it('reports a wrong answer as failed, not as an error', async () => {
    const { executor } = harness((run, worker) => {
      worker.reply(run, { stdout: 'nope\n' });
    });

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'console.log("nope");',
      timeoutMs: 1000,
      tests: [makeTest({ expectedOutput: 'yes' })],
    });

    expect(result.status).toBe('failed');
    expect(result.tests[0]?.status).toBe('failed');
    expect(result.tests[0]?.actualOutput).toBe('nope\n');
    expect(result.tests[0]?.errorMessage).toBeUndefined();
    executor.dispose();
  });

  it('carries stderr through without letting it affect the verdict', async () => {
    const { executor } = harness((run, worker) => {
      worker.reply(run, { stdout: '1\n', stderr: 'debugging\n' });
    });

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'console.error("debugging"); console.log(1);',
      timeoutMs: 1000,
      tests: [makeTest({ expectedOutput: '1' })],
    });

    expect(result.tests[0]?.status).toBe('passed');
    expect(result.tests[0]?.stderr).toBe('debugging\n');
    expect(result.stderr).toBe('debugging\n');
    executor.dispose();
  });

  it('reuses one worker across the test cases of a run', async () => {
    const { executor, factoryCalls, workers } = harness((run, worker) => {
      worker.reply(run, { stdout: '1\n' });
    });

    await executor.execute({
      language: 'javascript',
      sourceCode: 'console.log(1);',
      timeoutMs: 1000,
      tests: [makeTest({ id: 'a' }), makeTest({ id: 'b' }), makeTest({ id: 'c' })],
    });

    expect(factoryCalls()).toBe(1);
    expect(workers[0]?.runs).toHaveLength(3);
    executor.dispose();
  });

  it('short-circuits the remaining tests on a syntax error', async () => {
    const { executor, workers } = harness((run, worker) => {
      worker.reply(run, {
        error: "SyntaxError: Unexpected token ')'",
        errorKind: 'syntax',
      });
    });

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'function broken( { }',
      timeoutMs: 1000,
      tests: [makeTest({ id: 'a' }), makeTest({ id: 'b' }), makeTest({ id: 'c' })],
    });

    // The source cannot parse, so re-running it twice more would only produce
    // two more identical errors — and two more seconds of spinner.
    expect(workers[0]?.runs).toHaveLength(1);
    expect(result.tests).toHaveLength(3);
    expect(result.tests.every((t) => t.status === 'error')).toBe(true);
    expect(result.tests.every((t) => t.errorKind === 'syntax')).toBe(true);
    expect(new Set(result.tests.map((t) => t.errorMessage)).size).toBe(1);
    expect(result.fatalError).toContain('SyntaxError');
    expect(result.status).toBe('error');
    executor.dispose();
  });

  it('classifies a runtime error per test and keeps going', async () => {
    let call = 0;
    const { executor } = harness((run, worker) => {
      call += 1;
      if (call === 1) {
        worker.reply(run, { error: 'TypeError: x is not a function', errorKind: 'runtime' });
      } else {
        worker.reply(run, { stdout: '1\n' });
      }
    });

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'x()',
      timeoutMs: 1000,
      tests: [
        makeTest({ id: 'a', expectedOutput: '1' }),
        makeTest({ id: 'b', expectedOutput: '1' }),
      ],
    });

    expect(result.tests.map((t) => t.status)).toEqual(['error', 'passed']);
    expect(result.tests[0]?.errorKind).toBe('runtime');
    expect(result.fatalError).toBeUndefined();
    expect(result.status).toBe('error');
    executor.dispose();
  });

  it('terminates the worker on a timeout and respawns for the next test', async () => {
    let call = 0;
    const { executor, workers, factoryCalls } = harness((run, worker) => {
      call += 1;
      if (call === 1) return; // never answers: the infinite-loop case
      worker.reply(run, { stdout: '1\n' });
    });

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'while (true) {}',
      timeoutMs: 30,
      tests: [
        makeTest({ id: 'a', expectedOutput: '1' }),
        makeTest({ id: 'b', expectedOutput: '1' }),
      ],
    });

    expect(workers[0]?.terminateCount).toBe(1);
    expect(factoryCalls()).toBe(2);
    expect(result.tests[0]?.status).toBe('timeout');
    expect(result.tests[0]?.errorKind).toBe('timeout');
    expect(result.tests[0]?.errorMessage).toContain('30ms');
    // A timeout is not fatal — the next test still ran on a fresh worker.
    expect(result.tests[1]?.status).toBe('passed');
    expect(result.status).toBe('timeout');
    executor.dispose();
  });

  it('cancels the remaining tests when the signal aborts between tests', async () => {
    const controller = new AbortController();
    const { executor } = harness((run, worker) => {
      worker.reply(run, { stdout: '1\n' });
      controller.abort();
    });

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'console.log(1);',
      timeoutMs: 1000,
      signal: controller.signal,
      tests: [makeTest({ id: 'a' }), makeTest({ id: 'b' }), makeTest({ id: 'c' })],
    });

    expect(result.tests.map((t) => t.status)).toEqual(['passed', 'error', 'error']);
    expect(result.tests[1]?.errorMessage).toContain('cancelled');
    expect(result.tests[2]?.errorKind).toBe('internal');
    executor.dispose();
  });

  it('kills the worker when the signal aborts mid-test', async () => {
    const controller = new AbortController();
    const { executor, workers } = harness(() => {
      // Never answers; the abort is the only thing that can end this.
      setTimeout(() => controller.abort(), 10);
    });

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'while (true) {}',
      timeoutMs: 5000,
      signal: controller.signal,
      tests: [makeTest({ id: 'a' })],
    });

    expect(workers[0]?.terminateCount).toBe(1);
    expect(result.tests[0]?.status).toBe('error');
    expect(result.tests[0]?.errorMessage).toBe('Run cancelled.');
    executor.dispose();
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { executor, factoryCalls } = harness((run, worker) =>
      worker.reply(run, { stdout: '1\n' }),
    );

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'console.log(1);',
      timeoutMs: 1000,
      signal: controller.signal,
      tests: [makeTest({ id: 'a' }), makeTest({ id: 'b' })],
    });

    expect(factoryCalls()).toBe(0);
    expect(result.tests.map((t) => t.status)).toEqual(['error', 'error']);
    executor.dispose();
  });

  it('reports progress once per test, including short-circuited ones', async () => {
    const onProgress = vi.fn();
    const { executor } = harness((run, worker) => {
      worker.reply(run, { error: 'SyntaxError: bad', errorKind: 'syntax' });
    });

    await executor.execute({
      language: 'javascript',
      sourceCode: '(',
      timeoutMs: 1000,
      onProgress,
      tests: [makeTest({ id: 'a' }), makeTest({ id: 'b' }), makeTest({ id: 'c' })],
    });

    // The progress bar must reach 3/3 even though only one test really ran.
    expect(onProgress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    executor.dispose();
  });

  it('treats a worker that cannot be created as fatal', async () => {
    const executor = new JavaScriptExecutor({
      workerFactory: () => {
        throw new Error('Refused to create a worker: blocked by CSP');
      },
    });

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'console.log(1);',
      timeoutMs: 1000,
      tests: [makeTest({ id: 'a' }), makeTest({ id: 'b' })],
    });

    expect(result.status).toBe('error');
    expect(result.fatalError).toContain('CSP');
    expect(result.tests.every((t) => t.status === 'error')).toBe(true);
    executor.dispose();
  });

  it('handles a run with no test cases without spawning anything', async () => {
    const { executor, factoryCalls } = harness((run, worker) => worker.reply(run, {}));

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'console.log(1);',
      timeoutMs: 1000,
      tests: [],
    });

    expect(factoryCalls()).toBe(0);
    expect(result.tests).toEqual([]);
    executor.dispose();
  });

  it('ignores a malformed reply and falls through to the timeout', async () => {
    const { executor, workers } = harness((_run, worker) => {
      worker.emit({ type: 'result' }); // no id: not ours
      worker.emit('garbage');
    });

    const result = await executor.execute({
      language: 'javascript',
      sourceCode: 'console.log(1);',
      timeoutMs: 30,
      tests: [makeTest({ id: 'a' })],
    });

    expect(result.tests[0]?.status).toBe('timeout');
    expect(workers[0]?.terminateCount).toBe(1);
    executor.dispose();
  });
});
