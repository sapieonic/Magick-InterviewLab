/**
 * Python candidate-code runner, backed by Pyodide (CPython compiled to WASM).
 * Plain ES2020, served verbatim from /public as a *module* worker.
 *
 * Module, not classic, and not by preference: Pyodide 314 refuses to
 * initialise in a classic worker at all ("Classic web workers are not
 * supported"), and its loader ships as an ES module. The runtime URL is
 * configurable, so the import has to be dynamic rather than a static
 * `import` — which module workers allow and classic workers do not.
 *
 * ## Why init is a separate message
 *
 * `loadPyodide()` downloads and instantiates ~10MB of WebAssembly. That is
 * seconds on a good connection and much worse on a bad one, and it must happen
 * exactly once for the life of the worker. Folding it into the first `run`
 * would make the first test case's timeout have to cover a CDN download, so
 * the host does an explicit `init` handshake, can call it early (`warmUp()`),
 * and gets a distinguishable `init-error` when the CDN is blocked — an
 * environment problem, not a candidate problem.
 *
 * ## Why a fresh globals dict per run
 *
 * Test cases run back to back in one interpreter. A candidate who memoises
 * into a module-level dict would otherwise have test 2 answered by test 1's
 * cache — which usually *helps* them, which is worse than if it hurt, because
 * nobody reports it. `exec` into a new dict every time makes each test case
 * an independent program, the same as a fresh `python main.py` would be.
 *
 * ## Interrupting
 *
 * There is none. Pyodide can only be interrupted through a
 * `SharedArrayBuffer` interrupt buffer, which requires cross-origin isolation
 * headers (COOP/COEP) across the whole app — a change with real costs for
 * Monaco and any third-party embed. Until then the host's only lever is
 * `Worker.terminate()`, which destroys this interpreter and forces a full
 * re-init. `PythonExecutor` knows that and treats a timeout as expensive.
 */

'use strict';

(function () {
  var pyodide = null;
  var pyRun = null;
  var initPromise = null;

  /**
   * The whole harness, defined once at init.
   *
   * Notes for whoever edits this next:
   *  - `compile()` is called separately from `exec()` so a SyntaxError is
   *    reported as one. If you let `exec` do the compiling you get a runtime
   *    traceback for what is really a parse failure, and the host can no
   *    longer short-circuit the remaining test cases.
   *  - The traceback is filtered down to frames whose filename is
   *    '<candidate>'. Everything else is this harness, and showing a candidate
   *    "File \"<exec>\", line 1, in _mvil_run" teaches them nothing.
   *  - The stream swap is restored in `finally` including on the early return,
   *    because a leaked StringIO as sys.stdout silently swallows every
   *    subsequent test's output.
   */
  var HARNESS = [
    'import sys, io, traceback',
    '',
    "_MVIL_FILENAME = '<candidate>'",
    '',
    'def _mvil_format_exception(exc):',
    '    frames = [f for f in traceback.extract_tb(exc.__traceback__)',
    '              if f.filename == _MVIL_FILENAME]',
    '    parts = []',
    '    if frames:',
    "        parts.append('Traceback (most recent call last):\\n')",
    '        parts.extend(traceback.format_list(frames))',
    '    parts.extend(traceback.format_exception_only(type(exc), exc))',
    "    return ''.join(parts).strip()",
    '',
    'def _mvil_run(source, stdin_text):',
    '    out = io.StringIO()',
    '    err = io.StringIO()',
    '    saved = (sys.stdin, sys.stdout, sys.stderr)',
    "    result = {'stdout': '', 'stderr': '', 'error': None, 'error_kind': None}",
    '    try:',
    '        sys.stdin = io.StringIO(stdin_text)',
    '        sys.stdout = out',
    '        sys.stderr = err',
    '        try:',
    "            code = compile(source, _MVIL_FILENAME, 'exec')",
    '        except SyntaxError as exc:',
    "            result['error'] = ''.join(",
    '                traceback.format_exception_only(type(exc), exc)).strip()',
    "            result['error_kind'] = 'syntax'",
    '            return result',
    '        except ValueError as exc:',
    "            result['error'] = 'ValueError: ' + str(exc)",
    "            result['error_kind'] = 'syntax'",
    '            return result',
    "        run_globals = {'__name__': '__main__', '__file__': _MVIL_FILENAME}",
    '        try:',
    '            exec(code, run_globals)',
    '        except SystemExit:',
    '            pass',
    '        except BaseException as exc:',
    "            result['error'] = _mvil_format_exception(exc)",
    "            result['error_kind'] = 'runtime'",
    '    finally:',
    "        result['stdout'] = out.getvalue()",
    "        result['stderr'] = err.getvalue()",
    '        sys.stdin, sys.stdout, sys.stderr = saved',
    '    return result',
    '',
  ].join('\n');

  /**
   * Revoke the network / storage surfaces on the worker global. Called once,
   * after Pyodide has loaded. `postMessage` and `close` are intentionally
   * excluded (the worker needs them). Each write is best-effort: a frozen host
   * property is left as-is rather than throwing during init.
   */
  function hardenGlobalScope() {
    var blockedCallables = [
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'EventSource',
      'BroadcastChannel',
    ];
    var blockedValues = ['indexedDB', 'caches', 'localStorage', 'sessionStorage'];

    function define(name, value) {
      try {
        Object.defineProperty(self, name, {
          value: value,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch (e) {
        try {
          self[name] = value;
        } catch (e2) {
          /* Frozen host object: best effort. */
        }
      }
    }

    for (var i = 0; i < blockedCallables.length; i++) {
      (function (name) {
        define(name, function () {
          throw new Error("'" + name + "' is disabled in the InterviewLab sandbox.");
        });
      })(blockedCallables[i]);
    }
    for (var j = 0; j < blockedValues.length; j++) define(blockedValues[j], undefined);
  }

  function nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function withTrailingSlash(url) {
    var s = String(url || '');
    return s.length === 0 || s.charAt(s.length - 1) === '/' ? s : s + '/';
  }

  function messageOf(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return String(err);
  }

  function init(indexUrlRaw) {
    if (initPromise) return initPromise;

    initPromise = (async function () {
      var indexUrl = withTrailingSlash(indexUrlRaw);
      var moduleUrl = new URL(indexUrl + 'pyodide.mjs', self.location.href).href;

      var loaderModule;
      try {
        loaderModule = await import(moduleUrl);
      } catch (err) {
        throw new Error(
          'Could not download the Python runtime from ' +
            indexUrl +
            ' (' +
            messageOf(err) +
            '). Check the network connection or set NEXT_PUBLIC_PYODIDE_INDEX_URL ' +
            'to a self-hosted copy.',
        );
      }

      var loadPyodide = loaderModule && loaderModule.loadPyodide;
      if (typeof loadPyodide !== 'function') {
        throw new Error('The script at ' + moduleUrl + ' did not export loadPyodide().');
      }

      pyodide = await loadPyodide({ indexURL: indexUrl });
      pyodide.runPython(HARNESS);
      pyRun = pyodide.globals.get('_mvil_run');
      if (!pyRun) throw new Error('The Python harness failed to install.');

      // Only now, after the ~10MB runtime has finished downloading, revoke the
      // network surfaces — Pyodide needs `fetch` to load, and the candidate's
      // code runs strictly afterwards. Pyodide's `js` module proxies this
      // worker's global scope, so `import js; js.fetch(...)` resolves to
      // `self.fetch`; removing it here closes that bridge. `postMessage` and
      // `close` are deliberately NOT touched — this worker replies to the host
      // through `self.postMessage`. This mirrors the JavaScript runner and, as
      // documented there and in the README, hardens the honest-mistake path; it
      // is not a security boundary (a determined candidate sees the test cases
      // regardless, since execution is in their own browser).
      hardenGlobalScope();
    })();

    // A failed init must not be cached as a permanently rejected promise —
    // the host re-creates the worker to retry, but if it ever reuses one, a
    // sticky rejection would make a transient CDN blip permanent.
    initPromise.catch(function () {
      initPromise = null;
    });

    return initPromise;
  }

  function runOnce(sourceCode, input) {
    var started = nowMs();
    var proxy = null;
    try {
      proxy = pyRun(typeof sourceCode === 'string' ? sourceCode : '', typeof input === 'string' ? input : '');
      var plain = proxy.toJs({ dict_converter: Object.fromEntries });
      return {
        stdout: typeof plain.stdout === 'string' ? plain.stdout : '',
        stderr: typeof plain.stderr === 'string' ? plain.stderr : '',
        error: typeof plain.error === 'string' ? plain.error : undefined,
        errorKind: typeof plain.error_kind === 'string' ? plain.error_kind : undefined,
        durationMs: nowMs() - started,
      };
    } catch (err) {
      // The harness itself blew up (out of memory, a Pyodide fatal). That is
      // ours, not the candidate's — hence 'internal'.
      return {
        stdout: '',
        stderr: '',
        error: 'Internal Python runner failure: ' + messageOf(err),
        errorKind: 'internal',
        durationMs: nowMs() - started,
      };
    } finally {
      if (proxy && typeof proxy.destroy === 'function') {
        try {
          proxy.destroy();
        } catch (e) {
          /* already destroyed */
        }
      }
    }
  }

  self.addEventListener('message', function (event) {
    var data = event && event.data;
    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'init') {
      init(data.indexUrl).then(
        function () {
          self.postMessage({ type: 'ready' });
        },
        function (err) {
          self.postMessage({ type: 'init-error', message: messageOf(err) });
        },
      );
      return;
    }

    if (data.type === 'run') {
      var id = data.id;
      // Defensive: the host always inits first, but a lost handshake must
      // produce a reply rather than a hang the host can only resolve by
      // timing out and killing a perfectly good interpreter.
      if (!pyRun) {
        self.postMessage({
          type: 'result',
          id: id,
          stdout: '',
          stderr: '',
          error: 'The Python runtime is not initialised.',
          errorKind: 'internal',
          durationMs: 0,
        });
        return;
      }
      var result = runOnce(data.sourceCode, data.input);
      self.postMessage({
        type: 'result',
        id: id,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
        errorKind: result.errorKind,
        durationMs: result.durationMs,
      });
    }
  });
})();
