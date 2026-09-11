# Manifest format reference

The importer (`Admin → Questions → Import`) accepts either a bare array of
questions or an object with a `questions` array. Prefer the object form with a
`version`:

```json
{ "version": 1, "questions": [/* … */] }
```

The envelope is lenient (an unknown top-level key and any `version` number are
accepted and ignored). **Each question entry is strict** — an unknown or
misspelled field name is a hard error, not silently dropped.

## Question fields

| Field                | Type              | Required | Rules / default                                                                                                                                                                                                    |
| -------------------- | ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`              | string            | **yes**  | trimmed, 1–160 chars. Must be unique within the manifest; an existing title in the bank is skipped on import.                                                                                                      |
| `description`        | string (Markdown) | no       | ≤ 20000 chars. Default `""`. What the candidate reads.                                                                                                                                                             |
| `difficulty`         | enum              | no       | `EASY` \| `MEDIUM` \| `HARD`. Default `EASY`.                                                                                                                                                                      |
| `supportedLanguages` | array             | no       | 1–2 of `JAVASCRIPT`, `PYTHON` (uppercase, unique). Default `["JAVASCRIPT","PYTHON"]`.                                                                                                                              |
| `starterCode`        | object            | no       | Keys are **lowercase** runtime ids (`javascript`, `python`) and must be a subset of `supportedLanguages`; each value a string ≤ 20000 chars. A key for an unsupported language is dropped on import. Default `{}`. |
| `timeLimitMs`        | integer           | no       | 500–30000. Default 5000. Per test case.                                                                                                                                                                            |
| `memoryLimitMb`      | integer           | no       | 16–2048. Default 128. Advisory only (not enforced by browser execution).                                                                                                                                           |
| `testCases`          | array             | no       | 0–50 entries (a question with 0 always scores 0). Default `[]`.                                                                                                                                                    |

## Test-case fields

| Field            | Type    | Required | Rules / default                                               |
| ---------------- | ------- | -------- | ------------------------------------------------------------- |
| `input`          | string  | no       | Fed to stdin. ≤ 20000 chars. Default `""`.                    |
| `expectedOutput` | string  | no       | Compared against trimmed stdout. ≤ 20000 chars. Default `""`. |
| `description`    | string  | no       | ≤ 300 chars. What the case checks (shown to reviewers).       |
| `weight`         | integer | no       | 1–100. Default 1. Relative weight in the score.               |

`id`, `position`, `isHidden`, `createdAt` etc. are server-managed — do not
include them. Position follows array order.

## Output comparison (how a test passes)

Actual stdout is compared to `expectedOutput` after normalizing (CRLF→LF,
trailing whitespace per line stripped, leading/trailing blank lines removed).
If they aren't exactly equal, two fallbacks apply: a single numeric literal on
both sides matches within epsilon (`0.1+0.2` ≈ `0.3`), and two JSON-parseable
sides match structurally (`[1, 2]` ≡ `[1,2]`, key order ignored). Derive
`expectedOutput` by _running your reference solution_ — never hand-compute it.

## Worked example (JavaScript, EASY)

````json
{
  "version": 1,
  "questions": [
    {
      "title": "Sum of Two Numbers",
      "difficulty": "EASY",
      "supportedLanguages": ["JAVASCRIPT"],
      "description": "Read a line with two space-separated integers and print their sum.\n\n### Input\n```\n5 7\n```\n### Output\n```\n12\n```",
      "timeLimitMs": 5000,
      "memoryLimitMb": 128,
      "starterCode": {
        "javascript": "const line = readLine() ?? '';\nconst [a, b] = line.split(' ').map(Number);\n\n// TODO: print the sum of a and b\n"
      },
      "testCases": [
        { "description": "two positives", "input": "5 7", "expectedOutput": "12", "weight": 1 },
        { "description": "a negative", "input": "-3 10", "expectedOutput": "7", "weight": 1 },
        { "description": "larger values", "input": "100 250", "expectedOutput": "350", "weight": 2 }
      ]
    }
  ]
}
````

Reference solution used for validation (NOT shipped):

```js
const line = readLine() ?? '';
const [a, b] = line.split(' ').map(Number);
console.log(a + b);
```

## Language I/O cheatsheet

- **JavaScript:** `readLine()` → next line or `null`; `readAll()` → whole input;
  `console.log(...)` to print. `process.stdout.write(...)` also works.
- **Python:** `sys.stdin.readline()` / `sys.stdin.read()` / iterate `sys.stdin`;
  `print(...)` to print.
