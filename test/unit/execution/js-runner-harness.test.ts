/**
 * The JavaScript runner is an untranspiled worker script with no imports, so
 * it cannot simply be `import`ed. Rather than mirror its harness into a second
 * module that would immediately drift out of sync, the real file is evaluated
 * in a `node:vm` context and its `runUserCode` is driven directly.
 *
 * That works because the file only wires up `self.addEventListener` when a
 * real worker global exists; in a bare vm context it just publishes
 * `__MVIL_JS_RUNNER_INTERNALS__` and stops. So these tests exercise the exact
 * bytes that get served to the browser — stdout capture, stdin line reading,
 * and the syntax-vs-runtime classification the executor's short-circuit logic
 * depends on.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  new URL('../../../public/workers/js-runner.js', import.meta.url),
  'utf8',
);

interface HarnessResult {
  stdout: string;
  stderr: string;
  error?: string;
  errorKind?: string;
  durationMs: number;
}

interface Stdin {
  readLine(): string | null;
  readAll(): string;
  remaining(): string;
}

interface Internals {
  runUserCode(sourceCode: string, input: string): Promise<HarnessResult>;
  createStdin(input: string): Stdin;
  hardenGlobalScope(): void;
  MAX_OUTPUT_CHARS: number;
}

/** A fresh realm per call, so one test's globals cannot leak into the next. */
function loadRunner(): { internals: Internals; context: Record<string, unknown> } {
  const context: Record<string, unknown> = {};
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  const internals = context['__MVIL_JS_RUNNER_INTERNALS__'];
  if (internals === undefined || internals === null) {
    throw new Error('js-runner.js did not publish __MVIL_JS_RUNNER_INTERNALS__');
  }
  return { internals: internals as Internals, context };
}

async function run(sourceCode: string, input = ''): Promise<HarnessResult> {
  const { internals } = loadRunner();
  return internals.runUserCode(sourceCode, input);
}

describe('stdin', () => {
  it('reads lines one at a time and returns null at the end', () => {
    const { internals } = loadRunner();
    const stdin = internals.createStdin('a\nb\n');
    expect(stdin.readLine()).toBe('a');
    expect(stdin.readLine()).toBe('b');
    expect(stdin.readLine()).toBeNull();
    expect(stdin.readLine()).toBeNull();
  });

  it('does not invent a trailing empty line', () => {
    const { internals } = loadRunner();
    const stdin = internals.createStdin('1\n2\n3\n');
    expect([stdin.readLine(), stdin.readLine(), stdin.readLine(), stdin.readLine()]).toEqual([
      '1',
      '2',
      '3',
      null,
    ]);
  });

  it('preserves a deliberate blank line in the middle of input', () => {
    const { internals } = loadRunner();
    const stdin = internals.createStdin('a\n\nb\n');
    expect([stdin.readLine(), stdin.readLine(), stdin.readLine()]).toEqual(['a', '', 'b']);
  });

  it('normalises CRLF input', () => {
    const { internals } = loadRunner();
    const stdin = internals.createStdin('a\r\nb\r\n');
    expect([stdin.readLine(), stdin.readLine()]).toEqual(['a', 'b']);
  });

  it('returns null immediately for empty input', () => {
    const { internals } = loadRunner();
    expect(internals.createStdin('').readLine()).toBeNull();
  });

  it('readAll returns the whole input, not the remainder', () => {
    const { internals } = loadRunner();
    const stdin = internals.createStdin('a\nb\n');
    stdin.readLine();
    expect(stdin.readAll()).toBe('a\nb\n');
    expect(stdin.remaining()).toBe('b');
  });
});

describe('runUserCode — stdout and stderr capture', () => {
  it('captures console.log with a trailing newline', async () => {
    const result = await run('console.log("hello");');
    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('');
    expect(result.error).toBeUndefined();
  });

  it('joins multiple arguments with a space, Node-style', async () => {
    const result = await run('console.log(1, "two", [3, 4], { a: 1 });');
    expect(result.stdout).toBe('1 two [ 3, 4 ] { a: 1 }\n');
  });

  it('prints a top-level string raw so console.log("5") equals console.log(5)', async () => {
    const result = await run('console.log("5"); console.log(5);');
    expect(result.stdout).toBe('5\n5\n');
  });

  it('sends console.error to stderr ONLY — debugging noise is never graded', async () => {
    const result = await run('console.log("answer"); console.error("debug");');
    expect(result.stdout).toBe('answer\n');
    expect(result.stderr).toBe('debug\n');
  });

  it('sends console.warn to both, since people do print answers with it', async () => {
    const result = await run('console.warn("careful");');
    expect(result.stdout).toBe('careful\n');
    expect(result.stderr).toBe('careful\n');
  });

  it('supports process.stdout.write for output with no trailing newline', async () => {
    const result = await run('process.stdout.write("a"); process.stdout.write("b");');
    expect(result.stdout).toBe('ab');
  });

  it('handles circular structures instead of throwing inside the logger', async () => {
    const result = await run('const a = {}; a.self = a; console.log(a);');
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('Circular');
  });

  it('truncates runaway output rather than exhausting memory', async () => {
    const { internals } = loadRunner();
    const result = await internals.runUserCode(
      'for (let i = 0; i < 40000; i++) console.log("0123456789");',
      '',
    );
    expect(result.stdout.length).toBeLessThan(internals.MAX_OUTPUT_CHARS + 200);
    expect(result.stdout).toContain('output truncated');
  });
});

describe('runUserCode — stdin globals', () => {
  it('exposes readLine as a global', async () => {
    const result = await run(
      'let l; while ((l = readLine()) !== null) console.log(l * 2);',
      '1\n2\n3\n',
    );
    expect(result.stdout).toBe('2\n4\n6\n');
  });

  it('exposes readAll as a global', async () => {
    const result = await run('console.log(readAll().trim().split("\\n").length);', 'a\nb\nc\n');
    expect(result.stdout).toBe('3\n');
  });

  it('exposes input() as an alias for readLine()', async () => {
    const result = await run('console.log(input()); console.log(input());', 'x\ny\n');
    expect(result.stdout).toBe('x\ny\n');
  });

  it('lets user code shadow `input` with its own const — the classic footgun', async () => {
    // If the harness passed these as *parameters* rather than globals, this
    // would be "Identifier 'input' has already been declared", i.e. a syntax
    // error in code that is perfectly valid.
    const result = await run(
      'const input = readAll().trim();\nconsole.log(input.length);',
      'abcd\n',
    );
    expect(result.errorKind).toBeUndefined();
    expect(result.stdout).toBe('4\n');
  });

  it('does not leak the harness globals between runs', async () => {
    const { internals } = loadRunner();
    await internals.runUserCode('globalThis.__leak = readLine();', 'x\n');
    const second = await internals.runUserCode('console.log(typeof readLine);', '');
    // readLine is reinstalled per run; what matters is that it is a function
    // for every run and not a stale closure over the previous input.
    expect(second.stdout).toBe('function\n');
    const third = await internals.runUserCode('console.log(readLine());', 'fresh\n');
    expect(third.stdout).toBe('fresh\n');
  });
});

describe('runUserCode — error classification', () => {
  it('classifies an unparseable program as a syntax error', async () => {
    const result = await run('function broken( { }');
    expect(result.errorKind).toBe('syntax');
    expect(result.error).toContain('SyntaxError');
    expect(result.stdout).toBe('');
  });

  it('does not report a syntax error for top-level await', async () => {
    // Compiled with the AsyncFunction constructor precisely so this works.
    const result = await run('const v = await Promise.resolve(7);\nconsole.log(v);');
    expect(result.errorKind).toBeUndefined();
    expect(result.stdout).toBe('7\n');
  });

  it('classifies a thrown exception as a runtime error', async () => {
    const result = await run('throw new Error("boom");');
    expect(result.errorKind).toBe('runtime');
    expect(result.error).toContain('Error: boom');
  });

  it('classifies a reference to something undefined as a runtime error', async () => {
    const result = await run('nope();');
    expect(result.errorKind).toBe('runtime');
    expect(result.error).toContain('ReferenceError');
  });

  it('classifies a rejected await as a runtime error', async () => {
    const result = await run('await Promise.reject(new Error("async boom"));');
    expect(result.errorKind).toBe('runtime');
    expect(result.error).toContain('async boom');
  });

  it('keeps output produced before the error', async () => {
    const result = await run('console.log("partial"); throw new Error("later");');
    expect(result.stdout).toBe('partial\n');
    expect(result.errorKind).toBe('runtime');
  });

  it('strips harness frames from the stack', async () => {
    const result = await run('function inner() { throw new Error("deep"); }\ninner();');
    expect(result.error).toContain('deep');
    expect(result.error).not.toContain('js-runner.js');
    expect(result.error).not.toContain('runUserCode');
  });

  it('reports a thrown non-Error without crashing the harness', async () => {
    const result = await run('throw "just a string";');
    expect(result.errorKind).toBe('runtime');
    expect(result.error).toContain('just a string');
  });

  it('never rejects, whatever the program does', async () => {
    await expect(run('process.exit(1); throw new Error("unreachable");')).resolves.toBeDefined();
    await expect(run('')).resolves.toBeDefined();
  });
});

describe('runUserCode — Node-isms that would otherwise look like candidate bugs', () => {
  it('treats process.exit() as a clean finish, keeping the output', async () => {
    const result = await run('console.log("done"); process.exit(0); console.log("never");');
    expect(result.error).toBeUndefined();
    expect(result.errorKind).toBeUndefined();
    expect(result.stdout).toBe('done\n');
  });

  it('explains require() instead of throwing a bare ReferenceError', async () => {
    const result = await run('const fs = require("fs");');
    expect(result.errorKind).toBe('runtime');
    expect(result.error).toContain('readLine');
  });

  it('allows implicit globals (sloppy mode) rather than failing working code', async () => {
    const result = await run('x = 41;\nconsole.log(x + 1);');
    expect(result.errorKind).toBeUndefined();
    expect(result.stdout).toBe('42\n');
  });

  it('reports a duration', async () => {
    const result = await run('console.log(1);');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.durationMs)).toBe(true);
  });
});

describe('hardenGlobalScope', () => {
  it('replaces network and storage surfaces before user code runs', () => {
    const { internals, context } = loadRunner();
    internals.hardenGlobalScope();

    for (const name of [
      'fetch',
      'XMLHttpRequest',
      'importScripts',
      'WebSocket',
      'Worker',
      'close',
    ]) {
      const blocked = context[name];
      expect(typeof blocked).toBe('function');
      expect(() => (blocked as () => void)()).toThrow(/disabled in the InterviewLab sandbox/);
    }

    for (const name of ['indexedDB', 'caches', 'localStorage', 'sessionStorage']) {
      expect(context[name]).toBeUndefined();
    }
  });

  it('still runs user code afterwards, and blocks it from calling fetch', async () => {
    const { internals } = loadRunner();
    internals.hardenGlobalScope();
    const ok = await internals.runUserCode('console.log("still working");', '');
    expect(ok.stdout).toBe('still working\n');

    const blocked = await internals.runUserCode('fetch("https://example.com");', '');
    expect(blocked.errorKind).toBe('runtime');
    expect(blocked.error).toContain('disabled');
  });
});

describe('js-runner.js source contract', () => {
  it('is plain script code with no ES module syntax', () => {
    expect(SOURCE).not.toMatch(/^\s*import\s+[\w{*]/m);
    expect(SOURCE).not.toMatch(/^\s*export\s/m);
  });

  it('installs readLine, readAll and input as real globals', () => {
    expect(SOURCE).toContain("var HARNESS_GLOBALS = ['readLine', 'readAll', 'input'");
  });

  it('answers every run message with a result envelope', () => {
    expect(SOURCE).toContain("type: 'result'");
    expect(SOURCE).toContain("errorKind: 'syntax'");
    expect(SOURCE).toContain("errorKind: 'internal'");
  });
});

describe('worker bootstrap', () => {
  /**
   * Simulates a real dedicated-worker scope: `self === globalThis`, with
   * `addEventListener` and `postMessage` present. This is the only test that
   * covers the message plumbing and the fact that hardening (which replaces
   * `self.postMessage` with a thrower) does not stop the runner replying —
   * it holds a bound reference captured before the denylist is applied.
   */
  function bootWorker(): {
    dispatch(data: unknown): void;
    posted: Record<string, unknown>[];
    context: Record<string, unknown>;
  } {
    const listeners = new Map<string, ((event: unknown) => void)[]>();
    const posted: Record<string, unknown>[] = [];
    const context: Record<string, unknown> = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      postMessage: (message: unknown) => {
        posted.push(message as Record<string, unknown>);
      },
    };
    vm.createContext(context);
    vm.runInContext('globalThis.self = globalThis;', context);
    vm.runInContext(SOURCE, context);

    return {
      posted,
      context,
      dispatch: (data: unknown) => {
        for (const listener of listeners.get('message') ?? []) listener({ data });
      },
    };
  }

  it('answers a run message with a result envelope carrying the same id', async () => {
    const worker = bootWorker();
    worker.dispatch({
      type: 'run',
      id: 'abc',
      sourceCode: 'console.log(readLine());',
      input: 'hi\n',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({
      type: 'result',
      id: 'abc',
      stdout: 'hi\n',
      stderr: '',
    });
    expect(worker.posted[0]?.['error']).toBeUndefined();
  });

  it('replies even when the program is unparseable, so the host never hangs', async () => {
    const worker = bootWorker();
    worker.dispatch({ type: 'run', id: 'z', sourceCode: 'function (', input: '' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.posted[0]).toMatchObject({ type: 'result', id: 'z', errorKind: 'syntax' });
  });

  it('hardens the scope at startup, before any run message arrives', () => {
    const worker = bootWorker();
    expect(worker.context['indexedDB']).toBeUndefined();
    expect(() => (worker.context['fetch'] as () => void)()).toThrow(/disabled/);
  });

  it('ignores messages it does not understand instead of replying wrongly', async () => {
    const worker = bootWorker();
    worker.dispatch({ type: 'init' });
    worker.dispatch('nonsense');
    worker.dispatch(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.posted).toHaveLength(0);
  });
});
