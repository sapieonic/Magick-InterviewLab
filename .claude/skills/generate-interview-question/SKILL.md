---
name: generate-interview-question
description: >-
  Generate a validated MagicVoice InterviewLab coding question as an importable
  JSON manifest. Use this whenever someone wants to author, create, write, or
  add a coding/interview/assessment question or a whole question set/bank for
  InterviewLab — including phrasings like "make a JS easy question", "add a
  medium Python problem to the bank", "generate an interview question", or "give
  me a manifest I can import". Always start by asking for complexity and language
  preference, and always validate the question with the bundled script before
  handing it over, so a question can never ship with a wrong expected answer or a
  field the importer would reject.
---

# Generate an InterviewLab question

This skill produces a JSON manifest that imports cleanly through **Admin →
Questions → Import** and — crucially — is **validated before you hand it over**:
every reference solution is executed against every test case with the platform's
own grader, and the manifest is checked against the importer's schema. A question
that would import with a wrong expected answer, or be rejected on import, never
leaves your hands.

InterviewLab questions follow one contract in every language: **read from stdin,
print to stdout.** There is no "call function `twoSum`" convention — a test case
is a string fed to stdin and a string compared against (trimmed) stdout.

## Step 1 — Ask for the essentials, then wait

Do not generate anything until you have these. Ask them together (one question
with options is ideal):

- **Complexity** — `EASY`, `MEDIUM`, or `HARD`.
- **Language(s)** — JavaScript, Python, or both. (A question can support one or
  both; both run the same stdin/stdout contract.)
- **Topic / theme** (optional) — e.g. strings, arrays, math, hashing. If they
  don't care, pick something appropriate for the complexity.
- **How many** questions (default 1).

If the user already gave some of these in their message, don't re-ask — confirm
and fill the gaps.

## Step 2 — Design the question

For each question, write:

1. A **title** (≤ 160 chars) and a **Markdown description** the candidate reads.
   State the input format, the output format, and show a worked example. Keep to
   the stdin→stdout contract.
2. **Starter code** for each supported language — a _scaffold_, not a solution.
   It should read the input and leave the actual answer as a `// TODO` /
   `# TODO`. **Never put the solution in `starterCode`** — candidates see it.
3. **Test cases** (aim for 4–8): cover the normal case, edge cases (empty/zero,
   negatives, single element, boundaries), and one or two larger inputs. Give
   the discriminating cases a higher `weight`. Test cases are **visible to the
   candidate** in this MVP, so don't rely on hidden tests.

Difficulty guidance:

- **EASY** — one idea, a few lines (parse a line, a loop, a slice).
- **MEDIUM** — a data structure or a non-obvious step (hashing, two pointers,
  sorting, a small state machine).
- **HARD** — a real algorithm or careful edge-case handling (DP, graph
  traversal, non-trivial math), with test cases that punish the naive approach.

The I/O APIs the runtime provides:

- **JavaScript** — `readLine()` returns the next input line (or `null`),
  `readAll()` returns the whole input; print with `console.log()`.
- **Python** — read with `sys.stdin` (e.g. `sys.stdin.readline()` or
  `sys.stdin.read()`); print with `print()`.

See `references/manifest-format.md` for the exact field list, limits, and a full
worked example.

## Step 3 — Write a reference solution for every supported language

For each question and **each language it supports**, write a complete solution
that actually solves it. These are **validation scaffolding only** — they are
never shipped in the manifest. Use them to derive the correct `expectedOutput`
for each test case (don't hand-compute expected outputs — let the solution
produce them, then paste them into the manifest).

## Step 4 — Validate before delivering (required)

Write two files to a scratch directory:

- `manifest.json` — the deliverable (`{ "version": 1, "questions": [ … ] }`).
- `solutions.json` — an array **parallel to `questions`**, each entry mapping a
  lowercase runtime id to that question's reference solution:
  ```json
  { "solutions": [{ "javascript": "…", "python": "…" }, { "python": "…" }] }
  ```
  A reference solution is required for every language a question supports.

Then run the validator (Node ≥ 18; Python questions also need `python3` on PATH):

```bash
node <skill-dir>/scripts/validate.mjs <scratch>/manifest.json <scratch>/solutions.json
```

It runs each reference solution against every test case using the platform's
exact stdin shim, `console.log` formatting, and output comparison (trimming,
numeric-epsilon, structural-JSON), and checks the schema (strict entries, enums,
caps, starter-code keys, duplicate titles). It exits **0** only when everything
passes.

**Do not deliver a manifest until the validator prints `✓ VALID` and exits 0.**
If it reports a failure — a wrong `expectedOutput`, a solution that errors, a
typo'd field — fix the manifest (or the reference solution, if _it_ is wrong) and
re-run. Treat a mismatch as a real bug in the question, not noise to override.

## Step 5 — Deliver

Hand over **`manifest.json` only** (never `solutions.json` — it contains the
answers). Tell the user to import it via **Admin → Questions → Import** (upload
the file or paste its contents). If a file-delivery tool is available, send the
file; otherwise show the JSON. Offer to combine multiple questions into one
manifest (the importer accepts up to 200 per file).

## Guardrails

- The manifest is the only artifact the platform consumes; keep reference
  solutions out of it.
- Entries are **strict** — an unknown/misspelled field is a hard error, so match
  the field names in the reference exactly.
- `starterCode` keys are **lowercase** (`javascript`, `python`) and must be a
  subset of `supportedLanguages`.
- Expected outputs come from _running the solution_, not from guessing.
