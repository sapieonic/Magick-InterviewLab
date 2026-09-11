<div align="center">

<img src="public/magicvoice-logo.svg" alt="MagicVoice" width="56" height="56" />

# MagicVoice InterviewLab

**Internal technical-interview and coding-assessment platform.**

<sub>Powered by MagicVoice</sub>

</div>

---

InterviewLab is a single Next.js application that lets a team author coding
questions and test cases, assemble them into assessments, and run candidates
through a full interview process — recording what each interviewer thought at
every round and ending in one explicit, written hire or no-hire.

- **Hiring console**: a pipeline board, applications and their stages, panels,
  versioned rubrics, blind scorecards, a debrief view and a recorded decision,
  all on an append-only audit trail.
- **Authoring**: questions with Markdown + live preview, a test-case editor,
  assessments assembled from them, and submission review test by test.
- **Candidate**: assigned assessment, Monaco editor, JavaScript and Python
  execution in the browser, per-test results, explicit submit, scoring.
- **Zero server-side code execution.** Candidate code never touches the
  Node process, the database, or any secret. See
  [Code execution](#code-execution) for exactly how, and for the limitation
  that comes with it.

## Contents

- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [The end-to-end workflow](#the-end-to-end-workflow)
- [The hiring pipeline](#the-hiring-pipeline)
- [Candidate invitation email](#candidate-invitation-email)
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

| Variable                        | Required    | Default                      | Exposed to browser | Purpose                                                                                                                                                         |
| ------------------------------- | ----------- | ---------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | **yes**     | —                            | no                 | PostgreSQL connection string.                                                                                                                                   |
| `ADMIN_EMAIL`                   | recommended | —                            | no                 | Bootstrap admin's email. Without it no admin is created.                                                                                                        |
| `ADMIN_PASSWORD_HASH`           | recommended | —                            | no                 | Argon2id hash for the bootstrap admin. Generate with `npm run hash-password`.                                                                                   |
| `ADMIN_PASSWORD`                | no          | —                            | no                 | Plaintext alternative, **development only**; throws in production.                                                                                              |
| `ADMIN_NAME`                    | no          | `MagicVoice Admin`           | no                 | Display name for the bootstrap admin.                                                                                                                           |
| `SESSION_TTL_HOURS`             | no          | `12`                         | no                 | Session lifetime.                                                                                                                                               |
| `COOKIE_SECURE`                 | no          | auto                         | no                 | Force the `Secure` cookie flag. Defaults to on when `NODE_ENV=production`. Set `true` when TLS terminates upstream in a non-production build.                   |
| `SEED_CANDIDATE_EMAIL`          | no          | `candidate@magicvoice.local` | no                 | Email for the seeded demo candidate.                                                                                                                            |
| `SEED_CANDIDATE_PASSWORD`       | no          | random                       | no                 | Password for the seeded candidate. If unset, one is generated and printed once.                                                                                 |
| `SEED_SPARE_CANDIDATE_EMAIL`    | no          | `applicant@magicvoice.local` | no                 | A second candidate with nothing attached, so the "start an application" picker is not empty.                                                                    |
| `SEED_STAFF_PASSWORD`           | no          | random                       | no                 | Shared by the seeded recruiter, hiring manager and interviewer. If unset, three separate passwords are generated and printed — fine on a laptop, useless in CI. |
| `SEED_DEMO_DATA`                | no          | `true`                       | no                 | Set `false` to seed only the admin. Otherwise the seed also creates the staff accounts, rubric, job role, pipeline template and the demo application.           |
| `MAILJET_API_KEY`               | no          | —                            | no                 | Mailjet API key. Enables candidate invitation email. Required alongside the secret and sender.                                                                  |
| `MAILJET_API_SECRET`            | no          | —                            | no                 | Mailjet API secret.                                                                                                                                             |
| `MAIL_FROM_EMAIL`               | no          | —                            | no                 | Sender address. Must be a Mailjet verified sender or verified domain.                                                                                           |
| `MAIL_FROM_NAME`                | no          | `<app name> InterviewLab`    | no                 | Display name on the `From` header. Defaults from `NEXT_PUBLIC_APP_NAME`.                                                                                        |
| `MAIL_REPLY_TO`                 | no          | —                            | no                 | `Reply-To` address, when replies should not go to the sender.                                                                                                   |
| `MAILJET_SANDBOX`               | no          | `false`                      | no                 | `true` makes Mailjet validate every message and deliver nothing.                                                                                                |
| `NEXT_PUBLIC_APP_NAME`          | no          | `MagicVoice`                 | **yes**            | Brand name in the UI.                                                                                                                                           |
| `NEXT_PUBLIC_APP_URL`           | no          | `http://localhost:3000`      | **yes**            | Canonical URL. **Required (and must not be loopback) once email is enabled** — every invitation links to it.                                                    |
| `NEXT_PUBLIC_PYODIDE_INDEX_URL` | no          | jsDelivr CDN                 | **yes**            | Where the Python (Pyodide) runtime is fetched from. Point at your own host to run air-gapped.                                                                   |
| `PORT`                          | no          | `3000`                       | no                 | Server port.                                                                                                                                                    |
| `RUN_MIGRATIONS`                | no          | `true`                       | no                 | Docker entrypoint only: run `prisma migrate deploy` on container start.                                                                                         |

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
6. Admin creates a candidate with an explicitly chosen temporary password —
   emailed to them when a mail provider is configured, handed over otherwise
   (see [Candidate invitation email](#candidate-invitation-email)).
7. Admin assigns the interview to the candidate.
8. Candidate signs in and is required to choose a new password.
9. Candidate opens a question, writes JavaScript or Python.
10. Candidate clicks **Run tests** — the code executes in their browser.
11. Results appear per test; a failure expands to show input / expected / actual.
12. Candidate clicks **Submit**.
13. Admin reviews the submission, its score and its per-test breakdown.

The seed puts steps 2–7 in place already so you can jump straight to step 8.

---

## The hiring pipeline

An **interview** in the sense above is a _coding assessment_: a set of
questions, machine graded. Everything in this section is the hiring process
that assessment sits inside — the rounds a candidate moves through, the human
judgement recorded at each one, and the single explicit decision at the end.

### The shape of it

| Thing                                          | What it is                                                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Application`                                  | A candidate's run at a role. **This**, not the assessment, is what moves through the process and what a decision is made about.                                                                            |
| `Stage`                                        | One round on one application. A `CODING_ASSESSMENT` stage is backed by an `InterviewAssignment`; every other type is a round a human runs however they like, where this platform holds only the scorecard. |
| `StageInterviewer`                             | Who is on the panel. Being on this list — not a role — is what authorizes writing that round's scorecard.                                                                                                  |
| `Rubric` → `RubricVersion` → `RubricCriterion` | The scoring instrument. Criteria live on a _version_ so a published rubric is immutable once anything has been scored against it.                                                                          |
| `Feedback` + `FeedbackScore`                   | One interviewer's scorecard for one round: rubric scores, prose, a recommendation and a confidence.                                                                                                        |
| `FeedbackRevision`                             | The state a submitted scorecard held before an edit. Evidence is never silently rewritten.                                                                                                                 |
| `Decision`                                     | The hire / no-hire. One per application, with a required written rationale.                                                                                                                                |
| `AuditEvent`                                   | Append-only record of everything that moves a candidate or records an opinion.                                                                                                                             |

A `PipelineTemplate` materialises a standard set of stages onto an application,
so "Backend L4" always means the same rounds.

### Four rules the code enforces

These are the whole point of the feature. Each is enforced server-side, and
each has a test that fails if it stops being true.

**1. Nothing computes a verdict.** Scores and recommendations aggregate into a
_signal_ — the distribution of recommendations, weighted rubric averages, the
automated test scores, and an explicit flag when the panel disagrees. A
`Decision` is written by a person, with a rationale, or it does not exist. This
is deliberate on two counts: a computed verdict gets gamed and stops being a
judgement, and automated hiring decisions attract real regulatory exposure
(NYC LL144-style bias-audit rules, EEOC scrutiny, GDPR Art. 22).

The automated test score is presented as **one input among several**. A test
pass-rate is not code quality, and once a human has reviewed the round it must
not be able to overrule them.

**2. Blind until submitted.** An interviewer cannot read anyone else's
scorecard on a stage until their own is submitted. Four interviewers who read
each other first produce one opinion and three echoes of it.

This is enforced in the **query layer**, not the page: a read model that
returns the rows has already leaked them however carefully the UI hides them.
The rule is a pure function in `src/features/feedback/visibility.ts` and is
tested exhaustively.

It does not apply to someone who is _not_ on the panel — they are not writing a
judgement, so there is nothing for them to anchor. A recruiter chasing a late
panellist and a hiring manager preparing a debrief both need to read what has
landed. A panellist waits, **including a panellist who happens to be an admin**;
rank does not make anchoring less likely.

**3. A draft belongs to nobody but its author.** Not to an admin, not to the
hiring manager, not to the recruiter chasing it. Half-written impressions are
not evidence, and a system that exposes them teaches people to write their real
opinion somewhere else.

**4. Submitted feedback is append-only.** A submitted scorecard may be edited,
but the edit first snapshots the complete prior state into a
`FeedbackRevision`. A reversal is never invisible — the same applies to a
`Decision`, where changing one records the previous outcome in the audit log.

### Roles and capabilities

Authorization used to be one equality check — `role !== 'ADMIN'` — because
there were only two roles. With a panel, a recruiter and a hiring manager in
the picture, scattering that check is how a system ends up letting an
interviewer archive an interview. Every permission question now goes through a
grant table in `src/features/auth/capabilities.ts`.

|                                       | Admin | Recruiter | Hiring manager | Interviewer | Candidate |
| ------------------------------------- | :---: | :-------: | :------------: | :---------: | :-------: |
| Reach the console                     |   ●   |     ●     |       ●        |      ●      |           |
| Manage accounts                       |   ●   |           |                |             |           |
| Author questions, interviews, rubrics |   ●   |           |                |             |           |
| Run the pipeline                      |   ●   |     ●     |       ●        |             |           |
| See every application                 |   ●   |     ●     |       ●        |             |           |
| Write a scorecard                     |   ●   |     ●     |       ●        |      ●      |           |
| Record the decision                   |   ●   |           |       ●        |             |           |

Two absences are deliberate. A **recruiter cannot decide**: moving a candidate
along and choosing to hire them are different accountabilities, and collapsing
them is how a pipeline stops having a debrief. An **interviewer cannot see
every application**: they see the candidates they sit on, which is both
least-privilege and a smaller surface for gossip.

**A capability is necessary, never sufficient.** `GIVE_FEEDBACK` says a role may
write scorecards at all; it does not say this person is on _this_ panel. An
admin has the capability and still may not score a round they did not sit in,
because a scorecard from someone who was not there is not evidence. Object-level
checks live in `src/features/pipeline/access.ts`.

**A candidate has no capability in the hiring console whatsoever.** Feedback,
notes and decisions are unreachable by the person they are about — asserted
directly in the tests rather than left to follow from the routing.

### Running a hire, day to day

| Route                                | Who                                            | What it is for                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/admin`                             | any staff                                      | What needs _you_ — the scorecards you owe, the rounds awaiting feedback, the applications ready to decide — plus the activity feed, read from the audit log. |
| `/admin/pipeline`                    | any staff                                      | The board. Every application a viewer may see, with its current stage, outstanding scorecards and how long it has been sitting there.                        |
| `/admin/applications/[id]`           | any staff who can see it                       | The working surface: stages, panel, scheduling, comments and the timeline.                                                                                   |
| `/admin/stages/[id]`                 | the panel + anyone who can see the application | Where a scorecard is written. For a coding round, the candidate's code and test results sit beside the rubric.                                               |
| `/admin/applications/[id]/scorecard` | any staff who can see it                       | The debrief. Every submitted scorecard in full, the aggregate signal, and the decision panel for whoever holds `DECIDE`.                                     |
| `/admin/feedback`                    | any staff                                      | Your outstanding scorecards, oldest first. Feedback rots fast.                                                                                               |
| `/admin/rubrics`                     | admin                                          | Rubric authoring and version history.                                                                                                                        |
| `/admin/settings`                    | any staff; each section gated separately       | Job roles, pipeline templates and staff accounts — all admin-only in practice. Staff without those capabilities are told so rather than silently redirected. |

A round of work looks like this:

1. A recruiter opens an application for a candidate against a job role, and
   applies a pipeline template — which materialises the standard stages and
   pins each one to the current published version of its rubric.
2. For a coding round, the stage is backed by an `InterviewAssignment`: the
   candidate sits the assessment exactly as before, and it is machine graded.
3. A panel is seated on each stage. Only those people may score it.
4. Each panellist writes a scorecard — rubric scores with per-criterion notes,
   a written summary, a recommendation and a confidence. **Save draft** and
   **Submit** are separate, deliberate acts — a draft is saved when you click
   it, not automatically, so do not leave a half-written scorecard in a tab
   overnight. (The candidate's code editor _does_ autosave; the scorecard form
   does not. See [Future work](#future-work).)
5. Once a panellist submits, the rest of the panel's scorecards become
   readable to them, and not before.
6. A hiring manager opens the debrief, reads the signal alongside the
   scorecards, and records a decision with a written rationale.
7. The recruiter closes the application. Every step of this is in the audit log.

### Where the code lives

| Path                                    | What it holds                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/features/auth/capabilities.ts`     | The grant table. The authorization specification, asserted exhaustively in tests.                  |
| `src/features/pipeline/access.ts`       | Object-level access: may this person see _this_ application, and are they on _this_ panel.         |
| `src/features/feedback/visibility.ts`   | The blind rule, as a pure function.                                                                |
| `src/features/pipeline/stage-status.ts` | Which stage transitions are legal, and how a coding stage's status is derived from its assignment. |
| `src/features/scorecard/aggregate.ts`   | Signal, not verdict. No Prisma import, so it is testable in full.                                  |
| `src/lib/audit.ts`                      | The append-only trail. Writing an event can never fail the thing it records.                       |

---

## Candidate invitation email

Optional, and off unless configured. With `MAILJET_API_KEY`,
`MAILJET_API_SECRET` and `MAIL_FROM_EMAIL` all set, the **New candidate**
screen offers _"Email the sign-in details to the candidate"_ (ticked by
default). The message carries the sign-in URL, the candidate's email and the
temporary password, and names the interview if one was assigned at creation.

Set **all three or none**. A partial configuration is refused at startup, as
is a `NEXT_PUBLIC_APP_URL` still pointing at loopback while email is on — the
alternative is an admin ticking a checkbox that can never deliver anything, or
mailing every candidate a `http://localhost:3000` link that reports as sent
and cannot be taken back. "At startup" is literal: `src/instrumentation.ts`
parses the environment during boot, so the process refuses to serve rather
than 500ing on whichever request reads config first.

Three decisions worth knowing:

- **The email contains the temporary password**, and it is worth being exact
  about the trade rather than waving it through. The alternative — "your
  administrator will be in touch" — leaves exactly the out-of-band handover
  this feature exists to remove. `mustChangePassword` is enforced by the
  guards, so the credential buys a candidate nothing except the password
  change itself, and the transport never logs a message body.
  **But it is not single-use and not time-limited.** Nothing expires it:
  `User` has no expiry column, so the password stays valid until the candidate
  chooses to rotate it, and a candidate who never opens the email leaves a
  working credential in a mailbox indefinitely — where anyone else with access
  to that mailbox can rotate it first and lock them out. The window is short in
  practice; nothing in the code makes it short. If that trade is not
  acceptable for your deployment, the fix is a single-use signed invite link
  (a token row with `expiresAt`/`usedAt` and a set-password landing page),
  which would reuse this Mailjet transport and template unchanged — see
  [Future work](#future-work).
- **A failed send is not a failed creation.** The send runs after the row is
  committed, so a Mailjet outage leaves an account that exists and an admin
  who is told to hand the password over — which is precisely the flow that
  existed before this feature. The password is shown on screen either way.
- **`MAILJET_SANDBOX=true`** has Mailjet authenticate and validate every
  message but deliver nothing. The admin is told the email was sandboxed
  rather than sent, so a staging deployment cannot look like it is mailing
  real candidates.

Mailjet is spoken to over `fetch` (Send API v3.1) rather than through
`node-mailjet`: one authenticated POST is the whole surface, and v3.1 reports
a rejected recipient _inside_ a 200-family response — so `src/lib/email/mailjet.ts`
reads the per-message `Status`, not `response.ok`.

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
an imported question is indistinguishable from one typed in. Entries are
**strict** — a misspelled field name (`timeLimtMs`, `dificulty`) is a hard
error rather than being silently ignored and defaulted — while the envelope
stays lenient, so an unknown top-level key and any `version` number are accepted
(forward-compatibility).

An entry whose `title` already exists in the bank is **skipped, never
overwritten**, so re-running the same manifest imports only what is new instead
of a pile of duplicates. This dedup is best-effort: `title` is not uniquely
constrained in the database, so two imports of the same set running at the very
same instant could each insert (the single-page importer already disables its
button while a run is in flight, so a double-click cannot). The import reports
how many it created and how many it skipped. The whole batch is one transaction
— sized to allow a full manifest — so if any entry is invalid, or a write
fails partway, the import writes nothing and names the offending entry (e.g.
_Question 3 → Test 2 → weight_). A manifest may hold up to 200 questions; a
title repeated within the manifest itself is rejected. Use the **Load sample**
button on the import page for a ready-to-edit starting point.

---

## Architecture

One Next.js application. No microservices.

```
Browser                          Server (Next.js)              Postgres
┌──────────────────────┐         ┌────────────────────┐       ┌─────────┐
│ Admin console (RSC)  │◀───────▶│ Server Components  │◀─────▶│ Prisma  │
│ Candidate workspace  │         │ Server Actions     │       └─────────┘
│                      │         │  ├ requireCapability│
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

### Nothing computes a hire decision

Scores and recommendations aggregate into a **signal** — a distribution, some
weighted averages, and a disagreement flag. They never produce a verdict, a
ranking or a hire probability, and `src/features/scorecard/aggregate.ts` says so
at the top of the file.

Two reasons. A computed verdict gets optimised against and stops being a
judgement — panels learn to score for the formula. And automated hiring
decisions carry real regulatory exposure: NYC Local Law 144 bias audits, EEOC
adverse-impact scrutiny, GDPR Article 22 rights around solely automated
decisions. Keeping a person in the loop with a written rationale is both the
better process and the defensible one.

The automated test score is shown as one input among several for the same
reason. A test pass-rate is not code quality, and once a human has reviewed the
round it must not be able to overrule them.

### Feedback is append-only, and editing it leaves a trail

A submitted scorecard can be corrected — people mis-score, and forcing them to
live with a typo is how you get a second, honest opinion recorded in Slack
instead. But the correction snapshots the complete prior state into a
`FeedbackRevision` first, and a changed `Decision` records the previous outcome
in the audit log.

The test is simple: if a hiring decision were challenged six months later,
could you reconstruct what each person actually said, when, and what changed?

### Blind feedback is enforced in the query layer

A read model that returns the rows has already leaked them, however carefully
the page hides them. So `visibleFeedback()` runs inside the query, before
anything is returned, and the page is handed counts and a reason instead of
content it must not render.

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
| Authorization       | A capability grant table (`src/features/auth/capabilities.ts`), asserted in Server Components and in **every** Server Action via `requireCapability()` / `requireCandidate()`. Hiding a nav item is presentation, never a control.                                                                                                                                                                                        |
| Object-level access | A candidate's workspace re-verifies that the assignment is theirs _and_ that the question belongs to that interview. An interviewer reaches an application only through a panel seat on it, and may write a scorecard only for a stage they sit on — an admin has the capability and still may not. Anything else is a 404, not a 403 — existence does not leak.                                                          |
| Feedback isolation  | A candidate has **no** capability in the hiring console, so feedback, notes and decisions are unreachable by the person they are about — asserted directly in the tests. A draft scorecard is readable only by its author. A panellist cannot read the rest of the panel until they submit, enforced in the query layer rather than the page.                                                                             |
| User enumeration    | Login returns one message for unknown-email and wrong-password, and performs a dummy Argon2 verification on the unknown-email path so the timing matches. Account-inactive is only reported _after_ a correct password.                                                                                                                                                                                                   |
| Open redirect       | `?next=` is honoured only for same-origin absolute paths.                                                                                                                                                                                                                                                                                                                                                                 |
| Input validation    | Zod at every network boundary, server-side, before any database call.                                                                                                                                                                                                                                                                                                                                                     |
| Secret exposure     | `server-only` on the server env module makes a browser import a build failure. The Mailjet transport never logs a message body — a candidate invitation carries a plaintext temporary password.                                                                                                                                                                                                                           |
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
(including the anti-tamper properties), both execution adapters via an
injected fake worker, and the invitation email — the Mailjet wire contract
(including that a v3.1 rejection arrives inside a 200), the mail-configuration
gate, template escaping and mail-client robustness, and that a failed or
throwing send never costs the admin a created candidate.

The hiring pipeline is tested as a specification rather than by sampling, since
the rules are the feature:

- Every `(role, capability)` pair in the grant table is named explicitly, so a
  role quietly gaining `DECIDE` fails a test.
- The blind rule is asserted across every combination of blind / on-panel /
  submitted, plus the absolute one — another author's draft is unreadable on
  any stage configuration, by anyone.
- A candidate gets nothing back from every exported feedback and scorecard
  query, asserted directly. For the pipeline read models the same property is
  asserted one level down, on `visibleApplicationsWhere` and
  `canViewApplication` in `test/unit/hiring/access.test.ts`, which every one of
  them routes through.
- Stage transitions, rubric immutability, revision snapshotting on edit, and
  the aggregation maths (weighting, mixed scales, the disagreement flag) each
  have their own suite.

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
    admin/                 hiring console
    interview/             candidate workspace
  components/
    ui/                    design-system primitives
    admin/                 admin-only composites
    workspace/             candidate workspace composites
  features/
    auth/                  password, session, guards, capabilities, bootstrap
    candidates/            admin CRUD for candidates
    staff/                 staff accounts and role changes
    interviews/            admin CRUD for interviews
    questions/             admin CRUD for questions + test cases
    submissions/           submission creation, drafts, scoring
    execution/             CodeExecutor abstraction + JS/Python adapters
    pipeline/              applications, stages, panels, templates, access
    rubrics/               versioned scoring instruments
    feedback/              scorecards, revisions, notes, the blind rule
    scorecard/             aggregation — signal, never verdict
    decisions/             the recorded hire / no-hire
    dashboard/             per-viewer tiles + the audit-log activity feed
  lib/
    db/                    Prisma client singleton
    email/                 Mailjet transport + message templates
    validation/            Zod schemas
    audit.ts               append-only pipeline event log
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
  password-reset email, proctoring, plagiarism detection. (Candidate
  invitation email ships — see [Candidate invitation email](#candidate-invitation-email).)
- **Scorecard autosave.** The candidate's code editor mirrors every keystroke
  to `localStorage` and re-queues a failed save (`use-draft-autosave.ts`); the
  scorecard form does none of that, so an interviewer who closes the tab loses
  what they had typed. The hook already exists and is the obvious thing to
  reuse.
- **Feedback reminders.** The queue and the age are there; the nudge that
  actually makes a late scorecard arrive is not. The Mailjet transport is
  already wired, so this is a scheduler and a template.
- **Interviewer calibration.** Every ingredient is now recorded — each
  panellist's recommendation distribution against the eventual decision — but
  nothing reads it back. This is the analysis that tells you whether a
  particular interviewer is systematically harsh, and it is the main reason
  the data is shaped this way.
- **Live-round collaboration.** A `LIVE_CODING` stage currently means "run it
  however you like, record the scorecard here". Sharing the candidate's
  workspace with the panel in real time is a genuinely different build.
- **Retention and candidate data export.** Interview feedback about
  identifiable people is regulated in most jurisdictions and candidates may
  have a right to access it. The schema keeps everything and deletes nothing;
  a retention window, a purge job and a candidate-facing export are needed
  before this runs at any scale. The existing "deactivate, never delete"
  stance will have to be reconciled with that.

None of these are stubbed. The seams are there; the code is not.

---

<div align="center"><sub>Powered by MagicVoice</sub></div>
