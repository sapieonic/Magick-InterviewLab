#!/usr/bin/env node
/**
 * Validate an InterviewLab question manifest BEFORE it is handed to anyone.
 *
 * Two things are checked, and both must pass:
 *   1. Schema — every field the importer's `questionManifestSchema` enforces
 *      (strict entries, enums, caps, starter-code keys), so a manifest that
 *      would be rejected on import is caught here instead.
 *   2. Test-case correctness — each provided reference solution is executed
 *      against every test case using the SAME stdin shim, console formatting
 *      and output comparison as the platform's grader, and its output must
 *      match the manifest's `expectedOutput`. This is what stops a question
 *      shipping with a wrong expected answer.
 *
 * Usage:
 *   node validate.mjs <manifest.json> <solutions.json>
 *
 * solutions.json is validation scaffolding only (never shipped). It is an array
 * parallel to manifest.questions; each element maps a runtime language id to a
 * reference solution that SOLVES the question:
 *   { "solutions": [ { "javascript": "…", "python": "…" }, { "python": "…" } ] }
 *
 * A reference solution is required for every language a question supports;
 * otherwise that language cannot be validated and the run fails.
 *
 * Exit code 0 = everything passed. Non-zero = at least one problem; fix and
 * re-run before delivering the manifest.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const RUNTIME_KEY = { JAVASCRIPT: 'javascript', PYTHON: 'python' };
const DIFFICULTIES = new Set(['EASY', 'MEDIUM', 'HARD']);
const DB_LANGUAGES = new Set(['JAVASCRIPT', 'PYTHON']);
const QUESTION_KEYS = new Set([
  'title',
  'description',
  'difficulty',
  'supportedLanguages',
  'starterCode',
  'timeLimitMs',
  'memoryLimitMb',
  'testCases',
]);
const TESTCASE_KEYS = new Set(['id', 'input', 'expectedOutput', 'description', 'weight']);

/* -------------------------------------------------------------------------- */
/* Output comparison — a faithful port of src/features/execution/normalize.ts */
/* so validation matches grading exactly.                                     */
/* -------------------------------------------------------------------------- */

const EPSILON = 1e-9;
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INFINITY_RE = /^[+-]?Infinity$/;

function normalizeOutput(s) {
  return s
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function asSingleNumber(s) {
  const t = s.trim();
  if (t === '') return null;
  if (INFINITY_RE.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (!NUMERIC_RE.test(t)) return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

function numbersClose(a, b) {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  return diff <= EPSILON || diff <= EPSILON * Math.max(Math.abs(a), Math.abs(b));
}

function tryParseJson(s) {
  if (s === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

function deepEquals(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return numbersClose(a, b);
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEquals(item, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEquals(a[k], b[k]));
}

function outputMatches(actual, expected) {
  const a = normalizeOutput(actual);
  const b = normalizeOutput(expected);
  if (a === b) return true;
  const na = asSingleNumber(a);
  const nb = asSingleNumber(b);
  if (na !== null && nb !== null) return numbersClose(na, nb);
  const ja = tryParseJson(a);
  const jb = tryParseJson(b);
  if (ja.ok && jb.ok) return deepEquals(ja.value, jb.value);
  return false;
}

/* -------------------------------------------------------------------------- */
/* JavaScript runner — ports the stdin shim and console formatting from       */
/* public/workers/js-runner.js so captured stdout equals the browser's.       */
/* -------------------------------------------------------------------------- */

function createStdin(input) {
  const text = typeof input === 'string' ? input : '';
  const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let cursor = 0;
  return {
    readLine: () => (cursor < lines.length ? lines[cursor++] : null),
    readAll: () => text,
  };
}

function formatValue(value, depth, seen) {
  const d = typeof depth === 'number' ? depth : 0;
  const visited = seen || [];
  if (typeof value === 'string') return d === 0 ? value : JSON.stringify(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return String(value) + 'n';
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return '[Function: ' + (value.name || 'anonymous') + ']';
  if (value instanceof Error) return (value.name || 'Error') + ': ' + (value.message || '');
  if (visited.indexOf(value) !== -1) return '[Circular]';
  if (d > 6) return '[Object]';
  const next = visited.concat([value]);
  if (Array.isArray(value)) {
    return '[ ' + value.map((v) => formatValue(v, d + 1, next)).join(', ') + ' ]';
  }
  if (value instanceof Map) {
    const entries = [];
    value.forEach((v, k) =>
      entries.push(formatValue(k, d + 1, next) + ' => ' + formatValue(v, d + 1, next)),
    );
    return 'Map(' + value.size + ') { ' + entries.join(', ') + ' }';
  }
  if (value instanceof Set) {
    const members = [];
    value.forEach((v) => members.push(formatValue(v, d + 1, next)));
    return 'Set(' + value.size + ') { ' + members.join(', ') + ' }';
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  return '{ ' + keys.map((k) => k + ': ' + formatValue(value[k], d + 1, next)).join(', ') + ' }';
}

function joinArgs(args) {
  return args.map((a) => formatValue(a, 0, [])).join(' ');
}

/** Run JS source against one stdin string; returns { stdout } or { error }. */
function runJs(source, input) {
  const stdin = createStdin(input);
  let stdout = '';
  const toStdout = (...args) => {
    stdout += joinArgs(args) + '\n';
  };
  const noop = () => {};
  const EXIT = Symbol('exit');
  const consoleShim = {
    log: toStdout,
    info: toStdout,
    debug: toStdout,
    dir: toStdout,
    table: toStdout,
    group: toStdout,
    groupCollapsed: toStdout,
    groupEnd: noop,
    warn: toStdout, // warn writes to stdout (and stderr); only stdout is graded
    error: noop,
    trace: noop,
    assert: noop,
    count: noop,
    time: noop,
    timeEnd: noop,
  };
  const processShim = {
    argv: ['node', 'main.js'],
    env: {},
    platform: 'browser',
    stdout: {
      write: (chunk) => {
        stdout += typeof chunk === 'string' ? chunk : String(chunk);
        return true;
      },
    },
    stderr: { write: () => true },
    exit: () => {
      const e = new Error('exit');
      e[EXIT] = true;
      throw e;
    },
  };
  const sandbox = {
    readLine: stdin.readLine,
    readAll: stdin.readAll,
    input: stdin.readLine,
    console: consoleShim,
    process: processShim,
  };
  try {
    vm.runInNewContext(source, sandbox, { timeout: 5000 });
    return { stdout };
  } catch (err) {
    if (err && err[EXIT]) return { stdout };
    return { error: err && err.message ? err.message : String(err) };
  }
}

/** Run Python source against one stdin string via python3. */
function runPython(source, input) {
  const bin = process.env.PYTHON_BIN || 'python3';
  const res = spawnSync(bin, ['-c', source], {
    input,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      return {
        error: `'${bin}' not found. Install Python 3 (or set PYTHON_BIN) to validate Python questions.`,
        fatal: true,
      };
    }
    return { error: res.error.message };
  }
  if (res.status !== 0) {
    return { error: (res.stderr || '').trim() || `python exited with code ${res.status}` };
  }
  return { stdout: res.stdout };
}

function runSolution(language, source, input) {
  return language === 'python' ? runPython(source, input) : runJs(source, input);
}

/* -------------------------------------------------------------------------- */
/* Schema validation — mirrors questionManifestSchema (strict entries).       */
/* -------------------------------------------------------------------------- */

function validateSchema(questions, errors, warnings) {
  if (!Array.isArray(questions)) {
    errors.push('Manifest has no `questions` array (nor is it a bare array of questions).');
    return;
  }
  if (questions.length === 0) errors.push('The manifest contains no questions.');
  if (questions.length > 200) errors.push(`A manifest may hold at most 200 questions (has ${questions.length}).`);

  const seenTitles = new Map();
  questions.forEach((q, i) => {
    const at = `questions[${i}]`;
    if (typeof q !== 'object' || q === null) {
      errors.push(`${at} is not an object.`);
      return;
    }
    for (const key of Object.keys(q)) {
      if (!QUESTION_KEYS.has(key)) {
        errors.push(`${at}: unknown field "${key}" (strict — a typo like timeLimtMs is rejected on import).`);
      }
    }
    const title = q.title;
    if (typeof title !== 'string' || title.trim().length === 0) {
      errors.push(`${at}.title is required.`);
    } else {
      if (title.trim().length > 160) errors.push(`${at}.title exceeds 160 chars.`);
      const norm = title.trim();
      if (seenTitles.has(norm)) {
        errors.push(`${at}.title "${norm}" duplicates questions[${seenTitles.get(norm)}] — the import rejects a repeated title.`);
      } else {
        seenTitles.set(norm, i);
      }
    }
    if (q.description !== undefined && (typeof q.description !== 'string' || q.description.length > 20000)) {
      errors.push(`${at}.description must be a string ≤ 20000 chars.`);
    }
    if (q.difficulty !== undefined && !DIFFICULTIES.has(q.difficulty)) {
      errors.push(`${at}.difficulty must be EASY, MEDIUM or HARD.`);
    }
    const langs = q.supportedLanguages ?? ['JAVASCRIPT', 'PYTHON'];
    if (!Array.isArray(langs) || langs.length < 1 || langs.length > 2) {
      errors.push(`${at}.supportedLanguages must be an array of 1–2 languages.`);
    } else {
      if (new Set(langs).size !== langs.length) errors.push(`${at}.supportedLanguages has duplicates.`);
      for (const l of langs) if (!DB_LANGUAGES.has(l)) errors.push(`${at}.supportedLanguages: "${l}" is not JAVASCRIPT or PYTHON.`);
    }
    if (q.starterCode !== undefined) {
      if (typeof q.starterCode !== 'object' || q.starterCode === null) {
        errors.push(`${at}.starterCode must be an object keyed by lowercase language id.`);
      } else {
        const allowed = new Set((Array.isArray(langs) ? langs : []).map((l) => RUNTIME_KEY[l]).filter(Boolean));
        for (const [k, v] of Object.entries(q.starterCode)) {
          if (typeof v !== 'string' || v.length > 20000) errors.push(`${at}.starterCode.${k} must be a string ≤ 20000 chars.`);
          if (!allowed.has(k)) warnings.push(`${at}.starterCode.${k} is not a supported language and will be dropped on import.`);
        }
      }
    }
    if (q.timeLimitMs !== undefined && (!Number.isInteger(q.timeLimitMs) || q.timeLimitMs < 500 || q.timeLimitMs > 30000)) {
      errors.push(`${at}.timeLimitMs must be an integer 500–30000.`);
    }
    if (q.memoryLimitMb !== undefined && (!Number.isInteger(q.memoryLimitMb) || q.memoryLimitMb < 16 || q.memoryLimitMb > 2048)) {
      errors.push(`${at}.memoryLimitMb must be an integer 16–2048.`);
    }
    const tests = q.testCases ?? [];
    if (!Array.isArray(tests) || tests.length > 50) {
      errors.push(`${at}.testCases must be an array of at most 50.`);
    } else {
      if (tests.length === 0) warnings.push(`${at} has no test cases — it will always score 0. Add at least one.`);
      tests.forEach((t, j) => {
        const tat = `${at}.testCases[${j}]`;
        if (typeof t !== 'object' || t === null) {
          errors.push(`${tat} is not an object.`);
          return;
        }
        for (const key of Object.keys(t)) if (!TESTCASE_KEYS.has(key)) errors.push(`${tat}: unknown field "${key}".`);
        if (t.input !== undefined && (typeof t.input !== 'string' || t.input.length > 20000)) errors.push(`${tat}.input must be a string ≤ 20000 chars.`);
        if (t.expectedOutput !== undefined && (typeof t.expectedOutput !== 'string' || t.expectedOutput.length > 20000)) errors.push(`${tat}.expectedOutput must be a string ≤ 20000 chars.`);
        if (t.description !== undefined && (typeof t.description !== 'string' || t.description.length > 300)) errors.push(`${tat}.description must be a string ≤ 300 chars.`);
        if (t.weight !== undefined && (!Number.isInteger(t.weight) || t.weight < 1 || t.weight > 100)) errors.push(`${tat}.weight must be an integer 1–100.`);
      });
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${label} at ${path}: ${err.message}`);
    process.exit(2);
  }
}

function main() {
  const [manifestPath, solutionsPath] = process.argv.slice(2);
  if (!manifestPath || !solutionsPath) {
    console.error('Usage: node validate.mjs <manifest.json> <solutions.json>');
    process.exit(2);
  }

  const manifestRaw = readJson(manifestPath, 'manifest');
  const solutionsRaw = readJson(solutionsPath, 'solutions');
  const questions = Array.isArray(manifestRaw) ? manifestRaw : manifestRaw.questions;
  const solutions = Array.isArray(solutionsRaw) ? solutionsRaw : solutionsRaw.solutions;

  const errors = [];
  const warnings = [];

  validateSchema(questions, errors, warnings);

  // Run reference solutions against every test case.
  let checks = 0;
  let failures = 0;
  if (Array.isArray(questions)) {
    if (!Array.isArray(solutions)) {
      errors.push('solutions file must have a `solutions` array parallel to the questions.');
    } else {
      questions.forEach((q, i) => {
        const title = (q && q.title) || `questions[${i}]`;
        const langs = (q && q.supportedLanguages) || ['JAVASCRIPT', 'PYTHON'];
        const tests = (q && q.testCases) || [];
        const sol = solutions[i] || {};
        for (const dbLang of Array.isArray(langs) ? langs : []) {
          const rk = RUNTIME_KEY[dbLang];
          if (!rk) continue;
          const source = sol[rk];
          if (typeof source !== 'string' || source.trim() === '') {
            errors.push(`"${title}": missing ${rk} reference solution — cannot validate this language.`);
            continue;
          }
          tests.forEach((t, j) => {
            checks += 1;
            const res = runSolution(rk, source, t.input ?? '');
            if (res.fatal) {
              errors.push(res.error);
              failures += 1;
              return;
            }
            if (res.error !== undefined) {
              failures += 1;
              console.log(`  ✗ [${rk}] "${title}" test ${j + 1}: reference solution errored: ${res.error}`);
              return;
            }
            if (!outputMatches(res.stdout, t.expectedOutput ?? '')) {
              failures += 1;
              console.log(
                `  ✗ [${rk}] "${title}" test ${j + 1}: expected ${JSON.stringify(normalizeOutput(t.expectedOutput ?? ''))}, got ${JSON.stringify(normalizeOutput(res.stdout))}`,
              );
            }
          });
        }
      });
    }
  }

  console.log('');
  for (const w of warnings) console.log(`⚠ ${w}`);
  for (const e of errors) console.log(`✗ ${e}`);

  const ok = errors.length === 0 && failures === 0;
  console.log('');
  console.log(
    ok
      ? `✓ VALID — ${Array.isArray(questions) ? questions.length : 0} question(s), ${checks} test-case check(s) passed${warnings.length ? `, ${warnings.length} warning(s)` : ''}.`
      : `✗ INVALID — ${errors.length} schema error(s), ${failures} failed test-case check(s). Fix and re-run before delivering.`,
  );
  process.exit(ok ? 0 : 1);
}

main();
