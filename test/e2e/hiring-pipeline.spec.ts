import { test, expect, type Locator, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, RUN_ID, signIn, signInAndRotatePassword } from './helpers';

/**
 * The hiring pipeline, end to end, against a real browser and a real database.
 *
 * The assertion this file exists for is the blind rule. The unit tests mock
 * Prisma, so they can only prove that `visibleFeedback` filters whatever rows
 * a query hands it — not that the query withholds them in the first place, and
 * not that the withheld prose stays out of the RSC payload that Next.js
 * streams to the browser. That is provable only here: one panellist writes a
 * canary string, and a second panellist's page is searched for it, both
 * through the accessibility tree and through the raw bytes of the document.
 *
 * Everything the spec needs is built through the UI rather than read out of
 * the seed: a rubric with two criteria, a candidate, three colleagues, an
 * application, a blind round and its panel. The seed's staff passwords are
 * generated and printed once, so they are not available to a test run; the
 * only credential taken from the environment is the admin's, exactly as
 * `helpers.ts` does it.
 *
 * Serial, because step N reads the state step N-1 wrote. State crosses tests
 * in module-level variables, as `full-workflow.spec.ts` does.
 */

test.describe.configure({ mode: 'serial' });

const RUBRIC_NAME = `E2E Blind Rubric ${RUN_ID}`;
const CRITERION_ONE = `Problem solving ${RUN_ID}`;
const CRITERION_TWO = `Communication ${RUN_ID}`;
const STAGE_NAME = `E2E Blind round ${RUN_ID}`;

/**
 * The canaries. Deliberately single alphanumeric tokens: a scorecard summary
 * is rendered through the app's Markdown subset, and punctuation could be
 * consumed as syntax and never reach the DOM as typed.
 */
const CANARY_A = `canaryalpha${RUN_ID}`;
const CANARY_B = `canarybravo${RUN_ID}`;
const RATIONALE_MARK = `rationale${RUN_ID}`;

const TEMP_PASSWORD = 'TempPass123';

const PANELIST_A = {
  name: `Ada Panelist ${RUN_ID}`,
  email: `panel.a.${RUN_ID}@example.com`,
  password: 'PanelistAChosen1',
};
const PANELIST_B = {
  name: `Bo Panelist ${RUN_ID}`,
  email: `panel.b.${RUN_ID}@example.com`,
  password: 'PanelistBChosen2',
};
const MANAGER = {
  name: `Mo Manager ${RUN_ID}`,
  email: `manager.${RUN_ID}@example.com`,
  password: 'ManagerChosen345',
};
const CANDIDATE = {
  name: `Casey Candidate ${RUN_ID}`,
  email: `candidate.${RUN_ID}@example.com`,
  password: 'CandidateChosen6',
};

/** Written by the setup test, read by every test after it. */
let applicationUrl = '';
let stageUrl = '';

test.describe('hiring pipeline', () => {
  // ------------------------------------------------------------------ setup
  test('an admin publishes a rubric and seats two panellists on a blind round', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL(/\/admin/);

    await test.step('author a rubric with two criteria and publish it', async () => {
      await page.goto('/admin/rubrics');
      await page.getByLabel('Name', { exact: true }).fill(RUBRIC_NAME);
      await page.getByRole('button', { name: /create rubric/i }).click();

      // The action redirects straight into the editor for version 1.
      await expect(page).toHaveURL(/\/admin\/rubrics\/[^/]+$/, { timeout: 30_000 });
      await expect(page.getByRole('heading', { name: RUBRIC_NAME })).toBeVisible();

      await addCriterion(page, 1);
      await criterionRow(page, 1).getByLabel('Name', { exact: true }).fill(CRITERION_ONE);
      await criterionRow(page, 1)
        .getByLabel('Description', { exact: true })
        .fill('Breaks the problem down and justifies the approach.');

      await addCriterion(page, 2);
      await criterionRow(page, 2).getByLabel('Name', { exact: true }).fill(CRITERION_TWO);
      await criterionRow(page, 2)
        .getByLabel('Description', { exact: true })
        .fill('Explains trade-offs so a colleague could act on them.');

      await page.getByRole('button', { name: /save draft/i }).click();
      // The version history is rendered from a fresh read, so this line only
      // appears once the save has actually landed in the database.
      await expect(page.getByText('2 criteria, edited in the draft above.')).toBeVisible({
        timeout: 30_000,
      });

      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await page.getByRole('button', { name: 'Publish version', exact: true }).click();

      // Publishing is final: the draft, and with it the publish affordance,
      // is gone.
      await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page.getByRole('heading', { name: 'No open draft' })).toBeVisible();
    });

    await test.step('create the candidate and the three colleagues', async () => {
      await page.goto('/admin/candidates/new');
      await page.getByLabel('Name', { exact: true }).fill(CANDIDATE.name);
      await page.getByLabel('Email', { exact: true }).fill(CANDIDATE.email);
      await page.getByLabel(/temporary password/i).fill(TEMP_PASSWORD);
      await page.getByRole('button', { name: /create candidate/i }).click();
      await expect(page.getByText(CANDIDATE.email).first()).toBeVisible({ timeout: 30_000 });

      await createStaff(page, PANELIST_A.name, PANELIST_A.email, 'INTERVIEWER');
      await createStaff(page, PANELIST_B.name, PANELIST_B.email, 'INTERVIEWER');
      await createStaff(page, MANAGER.name, MANAGER.email, 'HIRING_MANAGER');
    });

    await test.step('start an application for the candidate', async () => {
      await page.goto('/admin/pipeline');
      // The starter form lives in a collapsed <details>.
      await page.getByText('Start an application', { exact: true }).click();
      await selectOptionContaining(page.getByLabel('Candidate', { exact: true }), CANDIDATE.email);
      await page.getByRole('button', { name: /start application/i }).click();

      await expect(page).toHaveURL(/\/admin\/applications\/[^/]+$/, { timeout: 30_000 });
      applicationUrl = new URL(page.url()).pathname;
      await expect(page.getByRole('heading', { name: CANDIDATE.name })).toBeVisible();
    });

    await test.step('add a blind round pinned to the published rubric', async () => {
      await page.getByLabel('Round name', { exact: true }).fill(STAGE_NAME);
      await selectOptionContaining(page.getByLabel('Rubric', { exact: true }), RUBRIC_NAME);
      // Blind feedback is the default; the whole spec rests on it, so assert
      // rather than assume.
      await expect(page.getByLabel('Blind feedback', { exact: true })).toBeChecked();
      await page.getByRole('button', { name: /add round/i }).click();

      await expect(page.getByRole('link', { name: STAGE_NAME })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Blind', { exact: true }).first()).toBeVisible();
    });

    await test.step('seat both panellists on the round', async () => {
      await addPanelist(page, PANELIST_A.name);
      await addPanelist(page, PANELIST_B.name);
      // Two seats, nothing submitted: the round now owes two scorecards.
      await expect(page.getByText('0/2 scorecards in')).toBeVisible({ timeout: 30_000 });
    });

    await test.step('remember the round URL for the panellists', async () => {
      await page.getByRole('link', { name: STAGE_NAME }).click();
      await expect(page).toHaveURL(/\/admin\/stages\/[^/]+$/, { timeout: 30_000 });
      stageUrl = new URL(page.url()).pathname;
      await expect(page.getByRole('heading', { name: STAGE_NAME })).toBeVisible();
    });
  });

  // -------------------------------------------------------------- panellist A
  test('panellist A writes a scorecard carrying a canary and submits it', async ({ page }) => {
    test.setTimeout(180_000);

    await signInAndRotatePassword(page, PANELIST_A.email, TEMP_PASSWORD, PANELIST_A.password);
    await expect(page).toHaveURL(/\/admin/);

    await page.goto(stageUrl);
    await expect(page.getByRole('heading', { name: STAGE_NAME })).toBeVisible();

    // Nothing to read yet, and the notice says why rather than showing an
    // empty panel.
    await expect(page.getByText('Hidden until you submit yours').first()).toBeVisible();
    await expect(page.getByText('Nobody else has submitted yet.').first()).toBeVisible();

    await writeScorecard(page, {
      canary: CANARY_A,
      recommendation: 'HIRE',
      confidence: 'HIGH',
    });

    await expect(page.getByText('This scorecard has been submitted').first()).toBeVisible({
      timeout: 30_000,
    });
    // Their own words come back to them; the blind rule was never about the
    // author.
    await expect(page.getByText(CANARY_A).first()).toBeVisible();
  });

  // -------------------------------------------------------------- panellist B
  test('panellist B cannot read A before submitting, and can immediately after', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await signInAndRotatePassword(page, PANELIST_B.email, TEMP_PASSWORD, PANELIST_B.password);
    await page.goto(stageUrl);
    await expect(page.getByRole('heading', { name: STAGE_NAME })).toBeVisible();

    await test.step("A's scorecard is nowhere on B's page", async () => {
      await expect(page.getByText(CANARY_A)).toHaveCount(0);
      /*
       * And not in the bytes either.
       *
       * `getByText` only searches the accessibility tree, so a withheld
       * scorecard serialised into an RSC flight payload or a client
       * component's props would pass that assertion while sitting in plain
       * text inside the document. This is the assertion that makes the
       * difference between "the page hides it" and "the query never returned
       * it".
       */
      expect(await page.content()).not.toContain(CANARY_A);
    });

    await test.step('B is told why, and how much is being withheld', async () => {
      await expect(page.getByText('Hidden until you submit yours').first()).toBeVisible();
      await expect(
        page.getByText('1 scorecard is hidden until you submit yours.').first(),
      ).toBeVisible();
      // The panel roster still reports status — who owes what is not content.
      await expect(page.getByText('1 of 2 submitted').first()).toBeVisible();
    });

    await test.step('B submits their own scorecard', async () => {
      await writeScorecard(page, {
        canary: CANARY_B,
        recommendation: 'LEAN_NO',
        confidence: 'MEDIUM',
      });
      await expect(page.getByText('This scorecard has been submitted').first()).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("A's scorecard is now readable by B", async () => {
      await page.reload();
      await expect(page.getByText(CANARY_A).first()).toBeVisible({ timeout: 30_000 });
      expect(await page.content()).toContain(CANARY_A);
      await expect(page.getByText('Hidden until you submit yours')).toHaveCount(0);
      await expect(page.getByText('2 of 2 submitted').first()).toBeVisible();
    });
  });

  // ---------------------------------------------------------------- candidate
  test('the candidate cannot reach the round or the debrief', async ({ page }) => {
    test.setTimeout(120_000);

    await signInAndRotatePassword(page, CANDIDATE.email, TEMP_PASSWORD, CANDIDATE.password);
    await expect(page).toHaveURL(/\/interview/);

    for (const target of [stageUrl, `${applicationUrl}/scorecard`, applicationUrl]) {
      await page.goto(target);
      // Bounced out of the console entirely — not to an empty page inside it.
      await expect(page).toHaveURL(/\/(interview|login)(\/|$|\?)/, { timeout: 30_000 });
      await expect(page).not.toHaveURL(/\/admin(\/|$)/);
      await expect(page.getByText(CANARY_A)).toHaveCount(0);
      await expect(page.getByText(CANARY_B)).toHaveCount(0);
      const html = await page.content();
      expect(html).not.toContain(CANARY_A);
      expect(html).not.toContain(CANARY_B);
    }
  });

  // ----------------------------------------------------------------- debrief
  test('the hiring manager debriefs both scorecards and records a decision', async ({ page }) => {
    test.setTimeout(180_000);

    await signInAndRotatePassword(page, MANAGER.email, TEMP_PASSWORD, MANAGER.password);
    await page.goto(`${applicationUrl}/scorecard`);
    await expect(page.getByRole('heading', { name: `${CANDIDATE.name} — debrief` })).toBeVisible();

    await test.step('both scorecards are readable — the manager is not on the panel', async () => {
      await expect(page.getByText(CANARY_A).first()).toBeVisible();
      await expect(page.getByText(CANARY_B).first()).toBeVisible();
    });

    await test.step('the aggregate signal is present and labelled as evidence', async () => {
      await expect(page.getByRole('heading', { name: 'Signal across the process' })).toBeVisible();
      await expect(page.getByText('This is evidence, not a verdict').first()).toBeVisible();
      await expect(page.getByText('2 scorecards counted.').first()).toBeVisible();
      // Rubric scores were aggregated, not just recommendations counted.
      await expect(page.getByText('Weighted rubric average').first()).toBeVisible();
      // A hire and a lean-no on the same round is exactly the split the
      // debrief exists to surface.
      await expect(page.getByText('The panel does not agree').first()).toBeVisible();
    });

    await test.step('a decision without a real rationale is refused', async () => {
      await page.getByLabel('Outcome', { exact: true }).selectOption('HIRE');
      await page.getByLabel('Rationale', { exact: true }).fill('Looks fine');
      await page.getByRole('button', { name: /record decision/i }).click();

      await expect(page.getByText(/at least a sentence of reasoning/i)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(RATIONALE_MARK)).toHaveCount(0);
    });

    await test.step('a decision with one is recorded and visible afterwards', async () => {
      await page
        .getByLabel('Rationale', { exact: true })
        .fill(
          `Strong on the first criterion and the concerns raised are coachable — ${RATIONALE_MARK}.`,
        );
      await page.getByRole('button', { name: /record decision/i }).click();
      await expect(page.getByText(/at least a sentence of reasoning/i)).toHaveCount(0, {
        timeout: 30_000,
      });

      await page.reload();
      await expect(page.getByText(RATIONALE_MARK).first()).toBeVisible({ timeout: 30_000 });
      // Only rendered once a decision exists, so it is proof the row landed.
      await expect(page.getByText('This replaces the current decision').first()).toBeVisible();
      await expect(page.getByText(MANAGER.name).first()).toBeVisible();

      // And it is the application's decision, not a note on one page. The
      // recommendation distribution is not on this page, so a bare "Hire" here
      // can only be the decision badge.
      await page.goto(applicationUrl);
      await expect(page.getByText(RATIONALE_MARK).first()).toBeVisible();
      await expect(page.getByText('Hire', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Decision recorded').first()).toBeVisible();
    });
  });

  // ------------------------------------------------------ capability boundary
  test('an interviewer is refused rubric authoring and is not offered it', async ({ page }) => {
    test.setTimeout(120_000);

    // Panellist A is an INTERVIEWER: ACCESS_CONSOLE and GIVE_FEEDBACK, no
    // MANAGE_CONTENT.
    await signIn(page, PANELIST_A.email, PANELIST_A.password);
    await expect(page).toHaveURL(/\/admin/);

    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Pipeline' })).toBeVisible();
    for (const label of ['Rubrics', 'Questions', 'Interviews', 'Settings', 'Candidates']) {
      await expect(nav.getByRole('link', { name: label })).toHaveCount(0);
    }

    for (const target of ['/admin/rubrics', '/admin/questions', '/admin/candidates']) {
      await page.goto(target);
      // Sent to the console home rather than rendered, and not to /login:
      // they are staff, just not staff who may author content or accounts.
      await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });
      await expect(page.getByRole('heading', { name: 'Rubrics' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Questions' })).toHaveCount(0);
    }

    // Settings is the deliberate exception: the page needs only
    // ACCESS_CONSOLE and gates each section on its own capability, so an
    // interviewer gets a coherent short page rather than a bounce.
    await page.goto('/admin/settings');
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expect(page.getByText('Nothing here for your role').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /create staff account/i })).toHaveCount(0);

    // The round they actually sit on is still theirs to read.
    await page.goto(stageUrl);
    await expect(page.getByRole('heading', { name: STAGE_NAME })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------

/** One criterion row in the draft editor, addressed by its own header. */
function criterionRow(page: Page, position: number): Locator {
  return page.getByRole('listitem').filter({ hasText: `Criterion ${position}` });
}

/**
 * Add a criterion and wait for the editor's own count to agree.
 *
 * The click is retried rather than issued once: the button is server-rendered
 * and therefore actionable before React has attached its handler, so a single
 * early click is swallowed silently. The running total in the editor is the
 * cheapest honest signal that the handler ran.
 */
async function addCriterion(page: Page, expected: number): Promise<void> {
  const noun = expected === 1 ? 'criterion' : 'criteria';
  await expect(async () => {
    await page.getByRole('button', { name: /add criterion/i }).click();
    await expect(page.getByText(`${expected} ${noun} · total weight ${expected}`)).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
}

async function createStaff(
  page: Page,
  name: string,
  email: string,
  role: 'INTERVIEWER' | 'HIRING_MANAGER',
): Promise<void> {
  await page.goto('/admin/settings');
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Role', { exact: true }).selectOption(role);
  await page.getByLabel('Temporary password', { exact: true }).fill(TEMP_PASSWORD);
  await page.getByRole('button', { name: /create staff account/i }).click();
  await expect(page.getByText(email).first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Seat somebody on the round and wait for the seat to exist.
 *
 * The confirmation is the person's name leaving the "add a panellist" picker:
 * the read model excludes anyone already seated, so it can only disappear once
 * the write has been committed and the page re-read.
 */
async function addPanelist(page: Page, name: string): Promise<void> {
  const picker = page.getByLabel(`Add a panellist to ${STAGE_NAME}`);
  await selectOptionContaining(picker, name);
  // The button's accessible name carries the round, because an application
  // normally has several and "Add" alone would be ambiguous to a screen reader.
  await page.getByRole('button', { name: `Add panellist to ${STAGE_NAME}` }).click();
  await expect(picker.locator('option', { hasText: name })).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Fill and submit a scorecard.
 *
 * The first score is clicked through a retry loop for the same hydration
 * reason as `addCriterion`, and the "still unscored" counter — which only the
 * client component can render — is what proves the click was heard.
 */
async function writeScorecard(
  page: Page,
  options: { canary: string; recommendation: string; confidence: string },
): Promise<void> {
  await expect(async () => {
    await scoreCriterion(page, CRITERION_ONE, 4);
    await expect(page.getByText('1 of 2 criteria still unscored.')).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });

  await scoreCriterion(page, CRITERION_TWO, 3);
  await expect(page.getByText(/criteria still unscored/)).toHaveCount(0);

  await page.getByLabel('Recommendation', { exact: true }).selectOption(options.recommendation);
  await page.getByLabel('Confidence', { exact: true }).selectOption(options.confidence);
  await page
    .getByLabel('Summary', { exact: true })
    .fill(`Worked through the brief carefully. ${options.canary}`);
  await page
    .getByLabel('Strengths', { exact: true })
    .fill('Named the failure mode before being asked about it.');
  await page.getByLabel('Concerns', { exact: true }).fill('Left the retry path unexplained.');

  await page.getByRole('button', { name: /submit scorecard/i }).click();
  // The confirm dialog's own button, not the trigger that opened it.
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
}

/**
 * One criterion's scale is a radio group whose inputs are visually hidden
 * behind their labels, so the point is clicked the way a reviewer clicks it.
 * The fieldset's legend names the group, which is what keeps two criteria with
 * the same 1–4 scale apart.
 */
async function scoreCriterion(page: Page, criterion: string, point: number): Promise<void> {
  await page
    .getByRole('group', { name: criterion })
    .getByText(String(point), { exact: true })
    .click();
}

/**
 * `selectOption({ label })` needs an exact string, but these options carry
 * suffixes ("… · an@email", "… (v1)") that the test has no business
 * hard-coding. Resolve the option's value from the DOM and select by that.
 */
async function selectOptionContaining(select: Locator, text: string): Promise<void> {
  const value = await select.locator('option', { hasText: text }).first().getAttribute('value');
  if (!value) throw new Error(`No option containing "${text}"`);
  await select.selectOption(value);
}
