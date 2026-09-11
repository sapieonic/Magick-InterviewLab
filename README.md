<div align="center">

<img src="public/magicvoice-logo.svg" alt="MagicVoice" width="56" height="56" />

# MagicVoice InterviewLab

**Internal technical-interview and coding-assessment platform.**

<sub>Powered by MagicVoice</sub>

</div>

---

InterviewLab is a single Next.js application that lets an admin author coding
questions and test cases, assemble them into interviews, create candidate
accounts, and review submissions — while candidates solve the questions in a
browser IDE and run their code **entirely on their own machine**.

- **Admin**: dashboard, candidate management, interview management, question
  authoring with Markdown + live preview, test-case editor, submission review.
- **Candidate**: assigned interview, Monaco editor, JavaScript and Python
  execution in the browser, per-test results, explicit submit, scoring.
- **Zero server-side code execution.** Candidate code never touches the
  Node process, the database, or any secret. See
  [Code execution](#code-execution) for exactly how, and for the limitation
  that comes with it.

## Contents

- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [The end-to-end workflow](#the-end-to-end-workflow)
- [Code execution](#code-execution)
- [Writing a question](#writing-a-question)
- [Architecture](#architecture)
- [Architecture decisions](#architecture-decisions)
- [Security model](#security-model)
- [Testing](#testing)
- [Deployment](#deployment)
- [Project layout](#project-layout)
- [Future work](#future-work)

---

## Quick start

**Requirements:** Node.js ≥ 20 (22 recommended) and a PostgreSQL 16 database.
Docker is **not** required for local development.

```bash
git clone <this-repo> && cd Magick-InterviewLab
npm install                 # also generates the Prisma client and stages Monaco
cp .env.example .env        # then edit DATABASE_URL and the admin settings
npm run db:setup            # migrate deploy + seed
npm run dev                 # http://localhost:3000
```

`npm install` runs a `postinstall` that generates the Prisma client and copies
the Monaco distribution into `public/monaco`. Both are git-ignored build
outputs, so without it a fresh clone cannot even typecheck — `src/generated`
would not exist.

`npm run db:setup` prints the seeded credentials **once**. Nothing is
hard-coded in the repository — see [Environment variables](#environment-variables).

If you would rather bring your own Postgres via Docker but still run the app
on the host:

```bash
docker compose up -d db
```

The `db` service is published on host port **5433**, not 5432, so it cannot
collide with a Postgres you may already run locally. Point the host app at it
by setting the port in `.env` accordingly:

```bash
DATABASE_URL="postgresql://interviewlab:interviewlab@localhost:5433/interviewlab?schema=public"
```

(The default in `.env.example` is `5432` for a Postgres you run yourself; the
compose `db` service is `5433`. Override `POSTGRES_PORT` to change it.)

### Setting the admin password

The bootstrap admin is configured entirely through the environment, and the
recommended form is a hash rather than a plaintext password:

```bash
npm run hash-password -- 'a long passphrase you will remember'
# → ADMIN_PASSWORD_HASH='$argon2id$v=19$m=19456,t=2,p=1$...'
```

Paste that into `.env` alongside `ADMIN_EMAIL`. The account is created on
first sign-in (and by the seed) if it does not already exist. An existing
admin is **never** silently re-hashed from the environment — rotating a live
admin's password by editing an env var would be a takeover vector, so the
bootstrap is create-only.

`ADMIN_PASSWORD` (plaintext) is accepted as a development convenience and is
**refused when `NODE_ENV=production`**.

---

## Environment variables

Every variable, what it does, and whether it is required.

| Variable                        | Required    | Default                      | Exposed to browser | Purpose                                                                                                                                       |
| ------------------------------- | ----------- | ---------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | **yes**     | —                            | no                 | PostgreSQL connection string.                                                                                                                 |
| `ADMIN_EMAIL`                   | recommended | —                            | no                 | Bootstrap admin's email. Without it no admin is created.                                                                                      |
| `ADMIN_PASSWORD_HASH`           | recommended | —                            | no                 | Argon2id hash for the bootstrap admin. Generate with `npm run hash-password`.                                                                 |
| `ADMIN_PASSWORD`                | no          | —                            | no                 | Plaintext alternative, **development only**; throws in production.                                                                            |
| `ADMIN_NAME`                    | no          | `MagicVoice Admin`           | no                 | Display name for the bootstrap admin.                                                                                                         |
| `SESSION_TTL_HOURS`             | no          | `12`                         | no                 | Session lifetime.                                                                                                                             |
| `COOKIE_SECURE`                 | no          | auto                         | no                 | Force the `Secure` cookie flag. Defaults to on when `NODE_ENV=production`. Set `true` when TLS terminates upstream in a non-production build. |
| `SEED_CANDIDATE_EMAIL`          | no          | `candidate@magicvoice.local` | no                 | Email for the seeded demo candidate.                                                                                                          |
| `SEED_CANDIDATE_PASSWORD`       | no          | random                       | no                 | Password for the seeded candidate. If unset, one is generated and printed once.                                                               |
| `SEED_DEMO_DATA`                | no          | `true`                       | no                 | Set `false` to seed only the admin.                                                                                                           |
| `NEXT_PUBLIC_APP_NAME`          | no          | `MagicVoice`                 | **yes**            | Brand name in the UI.                                                                                                                         |
| `NEXT_PUBLIC_APP_URL`           | no          | `http://localhost:3000`      | **yes**            | Canonical URL.                                                                                                                                |
| `NEXT_PUBLIC_PYODIDE_INDEX_URL` | no          | jsDelivr CDN                 | **yes**            | Where the Python (Pyodide) runtime is fetched from. Point at your own host to run air-gapped.                                                 |
| `PORT`                          | no          | `3000`                       | no                 | Server port.                                                                                                                                  |
| `RUN_MIGRATIONS`                | no          | `true`                       | no                 | Docker entrypoint only: run `prisma migrate deploy` on container start.                                                                       |

Only `NEXT_PUBLIC_*` variables reach the browser. This is enforced structurally,
not by convention: `src/lib/env.server.ts` imports `server-only`, so importing
it from a Client Component is a **build error**, while the browser-safe values
live in `src/lib/env.ts`.

---

## The end-to-end workflow

This is the flow the product is built around, and the one the
[end-to-end test](#testing) exercises on every CI run.

1. Admin signs in with the environment-configured credentials.
2. Admin creates an interview — _Frontend Engineer Interview_.
3. Admin creates questions — _Reverse a String_, _Two Sum_, _Find the Duplicate_.
4. Admin adds test cases to each question (input, expected output, weight).
5. Admin adds the questions to the interview and orders them.
6. Admin creates a candidate with an explicitly chosen temporary password.
7. Admin assigns the interview to the candidate.
8. Candidate signs in and is required to choose a new password.
9. Candidate opens a question, writes JavaScript or Python.
10. Candidate clicks **Run tests** — the code executes in their browser.
11. Results appear per test; a failure expands to show input / expected / actual.
12. Candidate clicks **Submit**.
13. Admin reviews the submission, its score and its per-test breakdown.

The seed puts steps 2–7 in place already so you can jump straight to step 8.

---

## Code execution

**Candidate code never runs on the server.** No `eval`, no `child_process`, no
`exec`/`spawn`, no Python subprocess, no per-submission container. This is a
deliberate architectural constraint, not an optimisation: the Node process
holds the database credentials, the session secrets and the whole tenant's
data, and no amount of care makes running arbitrary candidate code next to
that a good idea.

### The execution contract

Programs are **stdin → stdout**. A test case supplies an `input` string on
standard input and the program's trimmed standard output is compared against
`expectedOutput`. That contract is language-agnostic, deterministic, and maps
one-to-one onto a future server-side sandbox — which is the point.

|                | JavaScript                           | Python                                          |
| -------------- | ------------------------------------ | ----------------------------------------------- |
| Runtime        | Web Worker (isolated realm)          | Pyodide (CPython → WebAssembly) in a Web Worker |
| Reading input  | `readLine()`, `readAll()`, `input()` | `input()`, `sys.stdin.read()`                   |
| Writing output | `console.log`                        | `print()`                                       |
| Loaded         | immediately (tiny)                   | lazily, on first Python run                     |
| Hard timeout   | `worker.terminate()`                 | `worker.terminate()` + re-init                  |

Both runtimes are behind one interface, so the UI has no idea which is which:

```ts
interface CodeExecutor {
  readonly language: Language;
  warmUp?(): Promise<void>;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  dispose(): void;
}
```

Swapping in a `RemoteSandboxExecutor` later means changing one registry
function (`getExecutor`) and nothing in the UI.

### The limitation — read this before running a real interview

Because the tests execute in the candidate's browser, **the tests are visible
to the candidate.** A technically sophisticated candidate can open developer
tools and read every test input and expected output. Test cases are shipped to
the client because they have to be.

The product does not pretend otherwise:

- `TestCase.isHidden` exists in the schema and is **always false in the MVP**.
- Scores are recomputed **on the server** from the authoritative test weights,
  so a tampered payload cannot invent a 100% out of results that say otherwise.
  It can still lie about _which_ tests passed. That is the honest boundary.
- Closing it properly requires the second executor —
  see [Future work](#future-work).

Use InterviewLab as a _live, observed_ interview tool or an _unproctored
screen where the code is read by a human_, not as an unsupervised
pass/fail gate.

### Where the runtimes come from

**Monaco is self-hosted.** `@monaco-editor/loader` defaults to a CDN;
`scripts/copy-monaco.mjs` stages the npm copy into `public/monaco/vs` before
`dev` and `build` and the loader is pointed at our own origin. A candidate
behind a corporate proxy gets the real editor, not the fallback. The
directory is generated, so it is git-ignored — `npm run build` recreates it.

**Pyodide is still fetched from a CDN by default**, because the full
distribution is large and most deployments have egress. Set
`NEXT_PUBLIC_PYODIDE_INDEX_URL` to a self-hosted copy for an air-gapped
install; a failed download surfaces as a specific, actionable error rather
than a hang.

### Browser requirements

Execution needs WebAssembly and Web Workers. The workspace probes for both up
front (`detectRuntimeCapabilities()`); if either is missing, **Run tests** is
disabled with an explanation instead of failing silently. Every run is wrapped
in a hard timeout that terminates the worker, so the UI never sits on a
permanent "Running…". If Monaco itself cannot load, the editor degrades to a
monospace textarea that still runs and submits — a worse editor, not a locked
door.

---

## Writing a question

A question is Markdown plus a set of test cases. Keep to the stdin/stdout
contract and the same question works in both languages and, later, on the
remote executor.

```
Title:            Two Sum
Difficulty:       MEDIUM
Languages:        JavaScript, Python
Time limit:       5000 ms

Test case 1
  Input:            2 7 11 15
                    9
  Expected output:  0 1
  Weight:           1
```

Output comparison normalises line endings and trailing whitespace, and falls
back to numeric (epsilon) and structural-JSON comparison, so `[1, 2]` matches
`[1,2]` and `3.0000000001` matches `3`. Exact string equality is tried first.

### Importing a question set

To add a whole set at once, use **Admin → Questions → Import** and paste (or
upload) a JSON manifest. A manifest is either a bare array of questions or an
object with a `questions` array:

```json
{
  "version": 1,
  "questions": [
    {
      "title": "Echo",
      "description": "Read a line from stdin and print it back.",
      "difficulty": "EASY",
      "supportedLanguages": ["JAVASCRIPT", "PYTHON"],
      "starterCode": {
        "javascript": "const line = readLine() ?? '';\nconsole.log(line);\n",
        "python": "import sys\nprint(sys.stdin.readline().rstrip('\\n'))\n"
      },
      "timeLimitMs": 5000,
      "memoryLimitMb": 128,
      "testCases": [
        { "input": "hello", "expectedOutput": "hello", "weight": 1 },
        { "input": "42", "expectedOutput": "42", "weight": 1 }
      ]
    }
  ]
}
```

Only `title` is required — every other field falls back to the same default the
editor uses (`difficulty` `EASY`, both languages, `timeLimitMs` 5000,
`memoryLimitMb` 128, an empty `testCases`). `starterCode` is keyed by lowercase
runtime id (`javascript`, `python`); a key for an unsupported language is
dropped, exactly as the editor does. Each entry is validated with the same
schema and written through the same create path as a hand-entered question, so
an imported question is indistinguishable from one typed in.

An entry whose `title` already exists in the bank is **skipped, never
overwritten** — re-running the same manifest is a no-op rather than a pile of
duplicates — and the import reports how many it created and how many it skipped.
The whole batch is one transaction: if any entry is invalid the import writes
nothing and names the offending entry (e.g. _Question 3 → Test 2 → weight_). A
manifest may hold up to 200 questions; a title repeated within the manifest
itself is rejected. Use the **Load sample** button on the import page for a
ready-to-edit starting point.

---

## Architecture

One Next.js application. No microservices.

```
Browser                          Server (Next.js)              Postgres
┌──────────────────────┐         ┌────────────────────┐       ┌─────────┐
│ Admin console (RSC)  │◀───────▶│ Server Components  │◀─────▶│ Prisma  │
│ Candidate workspace  │         │ Server Actions     │       └─────────┘
│                      │         │  ├ requireAdmin()  │
│  ┌────────────────┐  │         │  ├ requireCandidate│
│  │ Monaco editor  │  │         │  └ Zod validation  │
│  └────────────────┘  │         │ Session (HttpOnly) │
│  ┌────────────────┐  │         └────────────────────┘
│  │ Web Worker: JS │  │
│  │ Web Worker: Py │  │   ← candidate code lives and dies here
│  └────────────────┘  │
└──────────────────────┘
```

Data flows one way: Server Components read through Prisma, Client Components
mutate through Server Actions, and every action re-authorises server-side
before it touches a row.

---

## Architecture decisions

Where the implementation departs from the original brief, and why.

### WebContainers were rejected in favour of a plain Web Worker for JavaScript

The brief suggested WebContainers. We use a hardened Web Worker instead, for
three reasons that compound:

1. **Cross-origin isolation is a hard conflict.** WebContainers require
   `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` on every response. That same
   header pair blocks the CDN-delivered Pyodide assets unless every one of
   them carries `Cross-Origin-Resource-Policy`. Adopting WebContainers for
   JavaScript would therefore have broken Python, and self-hosting the entire
   Pyodide distribution to work around it is a large amount of infrastructure
   for an MVP.
2. **Licensing.** The WebContainer API requires registration and a commercial
   licence for use outside StackBlitz-hosted origins. That is a procurement
   dependency in the critical path of an internal tool.
3. **It buys nothing here.** WebContainers exist to run a _Node project_ —
   npm installs, a dev server, a filesystem. Our contract is
   "one file, stdin in, stdout out". A Worker already gives us a realm with no
   DOM, no cookies, no `localStorage`, and — critically — `terminate()`, which
   is the only reliable way to stop an infinite loop.

Both workers revoke the network and storage surfaces so a candidate program
cannot call home or reach internal services from the reviewer's browser. The
JavaScript worker removes `fetch`, `XMLHttpRequest`, `WebSocket`,
`importScripts`, `indexedDB` and `caches` before user code runs. The Python
worker does the same **after** Pyodide has finished loading — the ~10MB runtime
needs `fetch` to download, and candidate code runs strictly afterwards; because
Pyodide's `js` module proxies the worker's global scope, revoking `self.fetch`
also closes the `import js; js.fetch(...)` bridge. This hardens the
honest-mistake path; as with the JavaScript worker it is **not** a security
boundary — a candidate whose code runs in their own browser can always read the
test cases (see _Test cases are not secret_ above), so treat client-side
execution as advisory and add a `RemoteSandboxExecutor` before it needs to be
one.

Pyodide is used for Python exactly as the brief specified.

### Prisma 7 with the `pg` driver adapter

Prisma 7 removed `url` from the schema's datasource block; the connection
string now lives in `prisma.config.ts` and the client is constructed with an
explicit `PrismaPg` adapter. This is the current supported shape, not a
workaround.

### Sessions are database rows, not JWTs

The cookie carries a 256-bit random token; the database stores only its
SHA-256. This costs one indexed lookup per request and buys **revocation**:
deactivating a candidate or resetting their password kills their live sessions
immediately. A stateless JWT could not do that without a denylist, which is a
session table with extra steps.

### Scoring is recomputed server-side

The browser is the only thing that _can_ report which tests passed, but it is
not trusted to report a score. `scoreSubmission()` takes the authoritative
`TestCase` weights from the database and ignores anything weight-shaped in the
client payload. Results for test ids that do not belong to the question are
discarded rather than counted.

### Server Actions rather than a REST API

Mutations are Server Actions wrapped in a single `actionGuard`, which turns
expected failures into typed `{ ok: false, error }` results and logs anything
unexpected server-side rather than leaking a stack trace to the browser. There
is no public API surface to secure separately, and no client-side data-fetching
layer to keep in sync.

### Native `<select>` over a headless listbox

Keyboard and screen-reader behaviour for free, works in a plain form POST, and
this application never needs rich option rendering.

---

## Security model

| Concern             | Control                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password storage    | Argon2id (19 MiB, t=2, p=1 — OWASP baseline). Plaintext is never stored, logged, or returned.                                                                                                                                                                                                                                                                                                                             |
| Session             | 256-bit opaque token in an `HttpOnly`, `SameSite=Lax`, `Secure`-in-production cookie. Only the SHA-256 is stored.                                                                                                                                                                                                                                                                                                         |
| Revocation          | Password change, admin reset and deactivation all delete every session for that user.                                                                                                                                                                                                                                                                                                                                     |
| Authorization       | Enforced in Server Components and in **every** Server Action via `requireAdmin()` / `requireCandidate()`. Hiding a nav item is presentation, never a control.                                                                                                                                                                                                                                                             |
| Object-level access | A candidate's workspace re-verifies that the assignment is theirs _and_ that the question belongs to that interview. Anything else is a 404, not a 403 — existence does not leak.                                                                                                                                                                                                                                         |
| User enumeration    | Login returns one message for unknown-email and wrong-password, and performs a dummy Argon2 verification on the unknown-email path so the timing matches. Account-inactive is only reported _after_ a correct password.                                                                                                                                                                                                   |
| Open redirect       | `?next=` is honoured only for same-origin absolute paths.                                                                                                                                                                                                                                                                                                                                                                 |
| Input validation    | Zod at every network boundary, server-side, before any database call.                                                                                                                                                                                                                                                                                                                                                     |
| Secret exposure     | `server-only` on the server env module makes a browser import a build failure.                                                                                                                                                                                                                                                                                                                                            |
| Candidate code      | Runs in the candidate's browser, never on the server, so it cannot reach the server's environment, filesystem, database or internal network. Both workers additionally revoke `fetch`/`XMLHttpRequest`/`WebSocket`/storage (the Python worker after Pyodide loads, which also closes the `js.fetch` bridge) — honest-mistake hardening, not a boundary, since a candidate can always read their own browser's test cases. |
| XSS                 | Markdown is escaped before rendering; candidate source code and program output are rendered as text, never as HTML.                                                                                                                                                                                                                                                                                                       |
| Headers             | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` set globally.                                                                                                                                                                                                                                                                                                                  |

**Known and accepted for the MVP:**

- Test cases are visible to the candidate
  (see [the limitation](#the-limitation--read-this-before-running-a-real-interview)).
- There is no rate limiting on the login endpoint — put the app behind your
  existing reverse proxy or WAF if it is internet-facing.
- **The interview duration is a countdown, enforced only best-effort on the
  client.** The clock is anchored to the server-stamped `startedAt`, so it
  survives a refresh. When it crosses zero in an open desktop tab the workspace
  **auto-submits the current question once** (a snapshot of the current work),
  which is a convenience, not a guarantee: a closed tab, a dead connection, or
  a candidate who sets their clock back all skip it. The server therefore still
  **accepts a late submission** and never rejects one for arriving after the
  timer — a reviewer judges lateness from `submittedAt`. If you need a hard
  cut-off, enforce it in `createSubmissionAction` against `startedAt`.
- **A session is resilient to a lost connection and to a refresh, on the client
  side.** Every keystroke is mirrored to `localStorage` synchronously, so a
  dropped connection never loses work; a failed cloud save is re-queued and
  retried on the next change and the moment the browser comes back online (a
  header shows _Offline_ / _Saved on this device_ meanwhile). A refresh restores
  the editor buffer **and** the last test-run results panel from `localStorage`.
  What is inherently server-side — a durable activity/audit log of every run,
  keystroke or focus event — is out of scope for the browser and not recorded.
- **Candidates and interviews are deactivated / archived, never hard-deleted.**
  Deactivating a candidate revokes their sessions and blocks sign-in;
  archiving an interview stops it accepting answers. Both preserve the
  submission history a hard delete would destroy.
- **The candidate workspace is desktop-first.** Below ~768px the editor, Run
  and Submit are not shown — a coding assessment is not sat on a phone — and
  the candidate is told to switch to a larger screen.

---

## Testing

```bash
npm run typecheck     # tsc --noEmit, strict
npm run lint          # eslint (next/core-web-vitals + typescript)
npm run format:check  # prettier
npm test              # vitest — unit and integration
npm run test:e2e      # playwright — full workflow against a real build
```

Unit tests cover authentication (hashing, session token handling, login
enumeration resistance), authorization guards, validation schemas, scoring
(including the anti-tamper properties), and both execution adapters via an
injected fake worker.

The end-to-end suite drives the entire admin → candidate → admin workflow in
a real Chromium against a real build and a real database: sign in as admin,
create an interview, create a question, add test cases, create a candidate,
assign, sign in as the candidate, write JavaScript, run it in the browser,
submit, and confirm the admin sees the submission and its score.

E2E prerequisites: a reachable `DATABASE_URL`, `npm run build` completed, and
`npx playwright install chromium`. Playwright starts the server itself on port
3100 (override with `E2E_PORT`, or point at an already-running instance with
`E2E_BASE_URL`).

The Python spec boots real Pyodide, so it needs the runtime to be reachable.
Run `npm run fetch:pyodide` and set `NEXT_PUBLIC_PYODIDE_INDEX_URL="/pyodide/"`
before building if your network blocks the CDN — CI does exactly that, so a
jsDelivr blip cannot fail a build for a reason unrelated to the change.

---

## Deployment

The application is a standard Next.js server (`output: 'standalone'`) with one
dependency: PostgreSQL. It is not tied to any hosting provider.

### Docker Compose (app + database)

```bash
cp .env.example .env      # set ADMIN_EMAIL and ADMIN_PASSWORD_HASH
docker compose up --build
```

Migrations run automatically on container start (set `RUN_MIGRATIONS=false` to
opt out). To load the demo content:

```bash
docker compose exec app npm run db:seed
```

### Any Node host / cloud VM

```bash
npm ci
npm run build
npx prisma migrate deploy
npm start
```

Set `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` and
`NEXT_PUBLIC_APP_URL` in the environment. `SESSION_TTL_HOURS` and
`COOKIE_SECURE` are the two knobs worth reviewing.

### Vercel

Works as-is. Add the same environment variables in the project settings and
point `DATABASE_URL` at a managed Postgres. Run `prisma migrate deploy` as
part of your release step — the build itself does not migrate, deliberately,
so a preview deployment cannot mutate a shared database.

---

## Project layout

```
prisma/
  schema.prisma            data model
  migrations/              generated SQL migrations
  seed.ts, seed-data.ts    idempotent development seed
public/
  workers/                 the two execution workers (plain JS, no bundler)
  monaco/                  Monaco distribution, staged at build time (git-ignored)
src/
  app/
    login/                 sign-in
    change-password/       forced first-login password change
    admin/                 admin console
    interview/             candidate workspace
  components/
    ui/                    design-system primitives
    admin/                 admin-only composites
    workspace/             candidate workspace composites
  features/
    auth/                  password, session, guards, bootstrap, actions
    candidates/            admin CRUD for candidates
    interviews/            admin CRUD for interviews
    questions/             admin CRUD for questions + test cases
    submissions/           submission creation, drafts, scoring
    execution/             CodeExecutor abstraction + JS/Python adapters
    dashboard/             dashboard aggregates
  lib/
    db/                    Prisma client singleton
    validation/            Zod schemas
    env.ts / env.server.ts browser-safe vs server-only configuration
test/
  unit/                    vitest
  e2e/                     playwright
```

The execution engine is the one part deliberately isolated behind an
interface, because it is the one part expected to move out of this process.

---

## Future work

Designed for, not built:

- **`RemoteSandboxExecutor`** — the same `CodeExecutor` interface, backed by an
  isolated execution service. This is what makes `TestCase.isHidden` real and
  closes the MVP's visibility limitation.
- Additional languages (C, C++, Java, Go, Rust) — a new executor, no UI change.
- Hidden tests, partial credit, custom graders — the `Grader` interface exists.
- AI-assisted evaluation, question banks, randomisation, organisations/tenants,
  invitation and password-reset email, proctoring, plagiarism detection.

None of these are stubbed. The seams are there; the code is not.

---

<div align="center"><sub>Powered by MagicVoice</sub></div>
