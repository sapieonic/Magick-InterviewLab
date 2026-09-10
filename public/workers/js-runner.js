/**
 * JavaScript candidate-code runner. Plain ES2020, no imports, no build step —
 * it is served verbatim from /public and loaded as a classic Web Worker.
 *
 * ## Why a worker at all
 *
 * Two reasons, and only the second is about safety. First: `terminate()` is
 * the only way to stop `while (true) {}`, and you cannot terminate the main
 * thread. Second: a dedicated worker realm has no `document`, no `window`, no
 * cookies and no `localStorage`, so candidate code cannot reach the session
 * that is grading it.
 *
 * ## What the hardening below is and is not
 *
 * It is defence in depth against exfiltration and accidents — a candidate who
 * pastes something that phones home, or whose "solution" opens an IndexedDB.
 * It is *not* a security boundary. Same-origin JavaScript that really wants to
 * misbehave has more surface than any denylist covers, which is precisely why
 * the roadmap has a server-side sandbox and why browser results are advisory.
 * Do not add a feature that assumes this is a jail.
 *
 * ## The shape of the harness
 *
 * Programs are stdin -> stdout (see `src/features/execution/types.ts`). We give
 * user code `readLine()`, `readAll()` and `input()` as real globals rather than
 * as parameters of the wrapper function: a parameter named `input` makes
 * `const input = readAll()` — a line thousands of candidates will type — throw
 * "Identifier 'input' has already been declared", which reads as a mystifying
 * syntax error in their own code. A global is shadowed harmlessly instead.
 *
 * The core is exported on the global as `__MVIL_JS_RUNNER_INTERNALS__` so the
 * unit tests can drive `runUserCode` under `node:vm` without a browser. The
 * worker bootstrap at the bottom only runs when there is a real `self`.
 */

'use strict';

(function () {
  var scope = typeof self !== 'undefined' ? self : globalThis;

  // Captured before hardening removes the public reference.
  var nativePostMessage =
    typeof scope.postMessage === 'function' ? scope.postMessage.bind(scope) : null;

  /** A runaway `while (true) console.log(i++)` must not OOM the tab before the deadline. */
  var MAX_OUTPUT_CHARS = 200000;

  var EXIT_MARKER = '__mvilProcessExit__';

  function nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  /* ---------------------------------------------------------------------- */
  /* stdin                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * `readAll()` returns the WHOLE input, not "the rest" — it is not a
   * cursor-aware sibling of `readLine()`. Mixing the two is therefore a
   * candidate bug, not a supported pattern, and making `readAll` consume the
   * cursor would silently change the meaning of the common
   * `const data = readAll()` first line.
   *
   * A single trailing newline is dropped so that "1\n2\n" is two lines, not
   * three. That is what every judge does and what `str.split()` in Python
   * would not do, which is exactly why it has to be explicit here.
   */
  function createStdin(input) {
    var text = typeof input === 'string' ? input : '';
    var normalized = text.replace(/\r\n|\r/g, '\n');
    var lines = normalized.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    var cursor = 0;
    return {
      readLine: function () {
        return cursor < lines.length ? lines[cursor++] : null;
      },
      readAll: function () {
        return text;
      },
      remaining: function () {
        return lines.slice(cursor).join('\n');
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* output capture                                                          */
  /* ---------------------------------------------------------------------- */

  function createSink() {
    var text = '';
    var truncated = false;
    return {
      write: function (chunk) {
        if (truncated) return;
        var s = typeof chunk === 'string' ? chunk : String(chunk);
        if (text.length + s.length > MAX_OUTPUT_CHARS) {
          text += s.slice(0, Math.max(0, MAX_OUTPUT_CHARS - text.length));
          text += '\n[output truncated at ' + MAX_OUTPUT_CHARS + ' characters]\n';
          truncated = true;
          return;
        }
        text += s;
      },
      value: function () {
        return text;
      },
    };
  }

  /**
   * Node-ish formatting. Top-level strings print raw (so `console.log("5")`
   * and `console.log(5)` both produce `5`, which is what an expected-output
   * file assumes); nested strings are quoted so `["a"]` is distinguishable
   * from `[a]`.
   */
  function formatValue(value, depth, seen) {
    var d = typeof depth === 'number' ? depth : 0;
    var visited = seen || [];

    if (typeof value === 'string') return d === 0 ? value : JSON.stringify(value);
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'bigint') return String(value) + 'n';
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') {
      return '[Function: ' + (value.name || 'anonymous') + ']';
    }
    if (value instanceof Error) {
      return (value.name || 'Error') + ': ' + (value.message || '');
    }
    if (visited.indexOf(value) !== -1) return '[Circular]';
    if (d > 6) return '[Object]';

    var next = visited.concat([value]);

    if (Array.isArray(value)) {
      var items = [];
      for (var i = 0; i < value.length; i++) items.push(formatValue(value[i], d + 1, next));
      return '[ ' + items.join(', ') + ' ]';
    }
    if (typeof Map !== 'undefined' && value instanceof Map) {
      var entries = [];
      value.forEach(function (v, k) {
        entries.push(formatValue(k, d + 1, next) + ' => ' + formatValue(v, d + 1, next));
      });
      return 'Map(' + value.size + ') { ' + entries.join(', ') + ' }';
    }
    if (typeof Set !== 'undefined' && value instanceof Set) {
      var members = [];
      value.forEach(function (v) {
        members.push(formatValue(v, d + 1, next));
      });
      return 'Set(' + value.size + ') { ' + members.join(', ') + ' }';
    }

    var keys = Object.keys(value);
    var parts = [];
    for (var j = 0; j < keys.length; j++) {
      parts.push(keys[j] + ': ' + formatValue(value[keys[j]], d + 1, next));
    }
    return parts.length === 0 ? '{}' : '{ ' + parts.join(', ') + ' }';
  }

  function joinArgs(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(formatValue(args[i], 0, []));
    return parts.join(' ');
  }

  /**
   * Routing, spelled out because the spec reads ambiguously and this is the
   * resolution: `log`/`info`/`debug` -> stdout only. `warn` -> stdout AND
   * stderr (it is diagnostic, but people do use it to print answers, and
   * dropping it from stdout would fail otherwise-correct submissions).
   * `error` -> stderr ONLY, because it is the one channel candidates reliably
   * use for debugging noise they do not want graded.
   */
  function createConsoleCapture(stdout, stderr) {
    var timers = Object.create(null);

    function toStdout() {
      stdout.write(joinArgs(arguments) + '\n');
    }
    function toBoth() {
      var line = joinArgs(arguments) + '\n';
      stdout.write(line);
      stderr.write(line);
    }
    function toStderr() {
      stderr.write(joinArgs(arguments) + '\n');
    }

    return {
      log: toStdout,
      info: toStdout,
      debug: toStdout,
      dir: toStdout,
      table: toStdout,
      group: toStdout,
      groupCollapsed: toStdout,
      groupEnd: function () {},
      warn: toBoth,
      error: toStderr,
      trace: toStderr,
      assert: function (condition) {
        if (condition) return;
        var rest = Array.prototype.slice.call(arguments, 1);
        stderr.write('Assertion failed' + (rest.length ? ': ' + joinArgs(rest) : '') + '\n');
      },
      count: function () {},
      time: function (label) {
        timers[label === undefined ? 'default' : String(label)] = nowMs();
      },
      timeEnd: function (label) {
        var key = label === undefined ? 'default' : String(label);
        var started = timers[key];
        if (started === undefined) return;
        delete timers[key];
        stderr.write(key + ': ' + (nowMs() - started).toFixed(3) + 'ms\n');
      },
    };
  }

  /**
   * There is no `process` in a worker, but "read stdin, write stdout" is a
   * Node idiom and `process.stdout.write(...)` is the single most common way
   * competitive-programming JavaScript emits output without a trailing
   * newline. Leaving it undefined turns a correct solution into a
   * ReferenceError, so we shim the three members that matter.
   *
   * `process.exit()` throws a marker that `runUserCode` catches and treats as
   * a clean finish — the alternative (letting it be a ReferenceError) reports
   * a successful program as a runtime failure.
   */
  function createProcessShim(stdout, stderr) {
    return {
      argv: ['node', 'main.js'],
      env: {},
      platform: 'browser',
      version: 'v0.0.0-interviewlab',
      exitCode: 0,
      stdout: {
        write: function (chunk) {
          stdout.write(typeof chunk === 'string' ? chunk : String(chunk));
          return true;
        },
      },
      stderr: {
        write: function (chunk) {
          stderr.write(typeof chunk === 'string' ? chunk : String(chunk));
          return true;
        },
      },
      exit: function (code) {
        var err = new Error('process.exit(' + (code === undefined ? '' : code) + ')');
        err[EXIT_MARKER] = true;
        throw err;
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* error reporting                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Strip harness frames. A candidate looking at
   * "at runUserCode (js-runner.js:214:9)" learns nothing except that our
   * plumbing exists; the frames above it are theirs and are the only ones
   * worth showing. We stop at the first harness frame rather than filtering,
   * because everything below it is ours by construction.
   *
   * Both V8 ("    at foo (…)") and SpiderMonkey ("foo@…") formats are handled;
   * neither gives useful line numbers for `Function`-constructed code, so the
   * frames are a breadcrumb trail of function names, not a source map.
   */
  function cleanStack(stack) {
    if (typeof stack !== 'string' || stack === '') return '';
    var lines = stack.split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('js-runner.js') !== -1) break;
      if (line.indexOf('runUserCode') !== -1) break;
      // V8 puts "Error: message" on line 0; the message is reported separately.
      if (i === 0 && !/^\s*at\s/.test(line) && line.indexOf('@') === -1) continue;
      if (line.trim() === '') continue;
      out.push(line.replace(/\s+$/, ''));
      if (out.length >= 12) break;
    }
    return out.join('\n');
  }

  function describeError(err, includeStack) {
    if (err instanceof Error) {
      var name = err.name || 'Error';
      var message = err.message === undefined ? '' : String(err.message);
      return {
        message: message ? name + ': ' + message : name,
        stack: includeStack ? cleanStack(err.stack) : '',
      };
    }
    return { message: 'Uncaught ' + formatValue(err, 1, []), stack: '' };
  }

  /* ---------------------------------------------------------------------- */
  /* the runner                                                              */
  /* ---------------------------------------------------------------------- */

  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  var HARNESS_GLOBALS = ['readLine', 'readAll', 'input', 'console', 'process', 'require'];

  function installGlobals(values) {
    var saved = [];
    for (var i = 0; i < HARNESS_GLOBALS.length; i++) {
      var key = HARNESS_GLOBALS[i];
      saved.push({
        key: key,
        hadOwn: Object.prototype.hasOwnProperty.call(scope, key),
        previous: scope[key],
      });
      try {
        scope[key] = values[key];
      } catch (e) {
        /* non-writable in some host; the run just loses that global. */
      }
    }
    return saved;
  }

  function restoreGlobals(saved) {
    for (var i = 0; i < saved.length; i++) {
      var entry = saved[i];
      try {
        if (entry.hadOwn) scope[entry.key] = entry.previous;
        else delete scope[entry.key];
      } catch (e) {
        /* best effort */
      }
    }
  }

  /**
   * Run one program against one stdin string.
   *
   * Async on purpose: the body is compiled with the AsyncFunction constructor
   * so that top-level `await` works. With a plain `new Function`, `await`
   * raises at construction time and we would classify a perfectly reasonable
   * `const data = await something()` as the candidate's syntax error.
   *
   * The body is left in sloppy mode (no injected "use strict"): implicit
   * globals are bad style but they are not what we are grading, and turning
   * `x = 5` into a ReferenceError would fail working submissions.
   *
   * Returns a plain object; never throws.
   */
  async function runUserCode(sourceCode, input) {
    var stdout = createSink();
    var stderr = createSink();
    var stdin = createStdin(input);
    var started = nowMs();

    var compiled;
    try {
      compiled = new AsyncFunction(typeof sourceCode === 'string' ? sourceCode : '');
    } catch (err) {
      // Thrown by the *constructor* -> the source never parsed. Nothing ran,
      // so there is no user stack to show and every other test would fail
      // identically; the executor short-circuits on this kind.
      var syntax = describeError(err, false);
      return {
        stdout: '',
        stderr: '',
        error: syntax.message,
        errorKind: 'syntax',
        durationMs: nowMs() - started,
      };
    }

    var saved = installGlobals({
      readLine: stdin.readLine,
      readAll: stdin.readAll,
      input: stdin.readLine,
      console: createConsoleCapture(stdout, stderr),
      process: createProcessShim(stdout, stderr),
      require: function (name) {
        throw new Error(
          "Module imports are not available in the browser runner (tried to require('" +
            String(name) +
            "')). Read stdin with readLine() / readAll() and print with console.log().",
        );
      },
    });

    var error;
    var errorKind;
    try {
      await compiled();
    } catch (err) {
      if (err && typeof err === 'object' && err[EXIT_MARKER] === true) {
        // process.exit() — a deliberate, successful termination.
      } else {
        var described = describeError(err, true);
        error = described.stack ? described.message + '\n' + described.stack : described.message;
        errorKind = 'runtime';
      }
    } finally {
      restoreGlobals(saved);
    }

    return {
      stdout: stdout.value(),
      stderr: stderr.value(),
      error: error,
      errorKind: errorKind,
      durationMs: nowMs() - started,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* hardening                                                               */
  /* ---------------------------------------------------------------------- */

  // Callable exfiltration / escape surfaces. Replaced with a thrower so the
  // candidate gets a clear message instead of a silent no-op.
  var BLOCKED_CALLABLES = [
    'fetch',
    'XMLHttpRequest',
    'importScripts',
    'WebSocket',
    'EventSource',
    'BroadcastChannel',
    'Worker',
    'SharedWorker',
    'postMessage',
    // close() would kill the worker mid-run and the host would see a timeout
    // instead of an error — a genuinely baffling failure to debug.
    'close',
  ];

  // Storage-ish surfaces where a thrower reads worse than absence.
  var BLOCKED_VALUES = ['indexedDB', 'caches', 'localStorage', 'sessionStorage'];

  function hardenGlobalScope() {
    for (var i = 0; i < BLOCKED_CALLABLES.length; i++) {
      (function (name) {
        define(name, function () {
          throw new Error("'" + name + "' is disabled in the InterviewLab sandbox.");
        });
      })(BLOCKED_CALLABLES[i]);
    }
    for (var j = 0; j < BLOCKED_VALUES.length; j++) define(BLOCKED_VALUES[j], undefined);

    function define(name, value) {
      try {
        Object.defineProperty(scope, name, {
          value: value,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch (e) {
        try {
          scope[name] = value;
        } catch (e2) {
          /* Frozen host object: best effort, see the file header. */
        }
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* worker bootstrap                                                        */
  /* ---------------------------------------------------------------------- */

  scope.__MVIL_JS_RUNNER_INTERNALS__ = {
    runUserCode: runUserCode,
    createStdin: createStdin,
    createConsoleCapture: createConsoleCapture,
    createSink: createSink,
    formatValue: formatValue,
    cleanStack: cleanStack,
    hardenGlobalScope: hardenGlobalScope,
    MAX_OUTPUT_CHARS: MAX_OUTPUT_CHARS,
  };

  if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
    // A detached `Promise.reject(...)` in candidate code otherwise surfaces as
    // an `error` event on the Worker object, which the host bridge reads as
    // "the worker crashed" and terminates — losing a run that was fine.
    self.addEventListener('unhandledrejection', function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    });

    self.addEventListener('message', function (event) {
      var data = event && event.data;
      if (!data || data.type !== 'run') return;
      var id = data.id;

      runUserCode(data.sourceCode, data.input).then(
        function (result) {
          reply({
            type: 'result',
            id: id,
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.error,
            errorKind: result.errorKind,
            durationMs: result.durationMs,
          });
        },
        function (err) {
          // runUserCode is not supposed to reject; if it does, that is our bug
          // and the candidate must not see it as their runtime error.
          reply({
            type: 'result',
            id: id,
            stdout: '',
            stderr: '',
            error: 'Internal runner failure: ' + describeError(err, false).message,
            errorKind: 'internal',
            durationMs: 0,
          });
        },
      );
    });

    hardenGlobalScope();
  }

  function reply(message) {
    if (nativePostMessage) nativePostMessage(message);
  }
})();
