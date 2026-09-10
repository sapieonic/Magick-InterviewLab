import { test, expect, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, RUN_ID, signIn, signOut } from './helpers';

/**
 * The workflow this product exists to serve, start to finish, in one test.
 *
 * It is deliberately a single long test rather than several: each step
 * depends on the state the previous one created, and splitting it would
 * either duplicate setup or introduce shared mutable state between tests.
 * When it fails, the step names in the trace say exactly where.
 */

const INTERVIEW_TITLE = `E2E Frontend Interview ${RUN_ID}`;
const QUESTION_TITLE = `E2E Sum Two Numbers ${RUN_ID}`;
const CANDIDATE_NAME = 'John Doe';
const CANDIDATE_EMAIL = `john.doe.${RUN_ID}@example.com`;
const CANDIDATE_TEMP_PASSWORD = 'TempPass123';
const CANDIDATE_NEW_PASSWORD = 'CandidateChosen456';

/** A correct solution to the seeded E2E question, under the stdin/stdout contract. */
const SOLUTION_JS = `const [a, b] = (readLine() ?? '').split(' ').map(Number);
console.log(a + b);`;

test.describe.configure({ mode: 'serial' });

test('admin authors an interview, a candidate solves it, admin reviews the submission', async ({
  page,
}) => {
  test.setTimeout(240_000);

  // ---------------------------------------------------------------- admin in
  await test.step('admin signs in with environment-configured credentials', async () => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL(/\/admin/);
  });

  // -------------------------------------------------------- create question
  await test.step('admin creates a coding question with test cases', async () => {
    await page.goto('/admin/questions/new');
    await page.getByLabel('Title').fill(QUESTION_TITLE);
    await page
      .getByLabel(/description/i)
      .first()
      .fill('Read two space-separated integers from stdin and print their sum.');

    // Two test cases: one supplied by the form's initial row, one added.
    await fillTestCase(page, 0, '2 3', '5');
    await page.getByRole('button', { name: /add test case/i }).click();
    await fillTestCase(page, 1, '10 -4', '6');

    await page.getByRole('button', { name: /^(save|create)/i }).click();
    await expect(page.getByText(QUESTION_TITLE).first()).toBeVisible({ timeout: 30_000 });
  });

  // ------------------------------------------------------- create interview
  await test.step('admin creates an interview and adds the question', async () => {
    await page.goto('/admin/interviews/new');
    await page.getByLabel('Title').fill(INTERVIEW_TITLE);
    await page
      .getByLabel(/description/i)
      .first()
      .fill('Automated end-to-end interview.');
    await page.getByRole('button', { name: /^(save|create)/i }).click();

    await expect(page).toHaveURL(/\/admin\/interviews\/[^/]+$/, { timeout: 30_000 });
    await addQuestionToInterview(page, QUESTION_TITLE);
    await expect(page.getByText(QUESTION_TITLE).first()).toBeVisible();
  });

  // ------------------------------------------------------- create candidate
  await test.step('admin creates a candidate and assigns the interview', async () => {
    await page.goto('/admin/candidates/new');
    await page.getByLabel('Name').fill(CANDIDATE_NAME);
    await page.getByLabel('Email').fill(CANDIDATE_EMAIL);
    await page.getByLabel(/temporary password/i).fill(CANDIDATE_TEMP_PASSWORD);

    const assign = page.getByLabel(/assign interview/i);
    if (await assign.count()) await assign.selectOption({ label: INTERVIEW_TITLE });

    await page.getByRole('button', { name: /^(save|create)/i }).click();
    await expect(page.getByText(CANDIDATE_EMAIL).first()).toBeVisible({ timeout: 30_000 });
  });

  await test.step('the temporary password is never rendered back on a later view', async () => {
    await page.goto('/admin/candidates');
    await expect(page.getByText(CANDIDATE_TEMP_PASSWORD)).toHaveCount(0);
  });

  await signOut(page);

  // ------------------------------------------------------------ candidate in
  await test.step('candidate signs in and is forced to choose a new password', async () => {
    await signIn(page, CANDIDATE_EMAIL, CANDIDATE_TEMP_PASSWORD);
    await expect(page).toHaveURL(/\/change-password/);

    await page.getByLabel(/current password/i).fill(CANDIDATE_TEMP_PASSWORD);
    await page.getByLabel(/^new password/i).fill(CANDIDATE_NEW_PASSWORD);
    await page.getByLabel(/confirm/i).fill(CANDIDATE_NEW_PASSWORD);
    await page.getByRole('button', { name: /update password/i }).click();

    await expect(page).toHaveURL(/\/interview/, { timeout: 30_000 });
  });

  await test.step('candidate cannot reach the admin area', async () => {
    await page.goto('/admin');
    await expect(page).not.toHaveURL(/\/admin(\/|$)/);
  });

  // --------------------------------------------------- solve, run, submit
  await test.step('candidate opens the question and runs code in the browser', async () => {
    await page.goto('/interview');
    await page.getByRole('link', { name: new RegExp(escapeRegExp(QUESTION_TITLE), 'i') }).click();
    await expect(page).toHaveURL(/\/interview\/[^/]+\/q\/[^/]+/, { timeout: 30_000 });

    await writeSolution(page, SOLUTION_JS);
    await page.getByRole('button', { name: /run tests/i }).click();

    // The whole point of the product: this ran in the browser, not on the server.
    await expect(page.getByText(/2\s*\/\s*2|all tests passed|100%/i).first()).toBeVisible({
      timeout: 90_000,
    });
  });

  await test.step('candidate submits the solution', async () => {
    await page.getByRole('button', { name: /^submit/i }).click();
    const confirm = page.getByRole('button', { name: /confirm|submit solution|yes/i }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await expect(page.getByText(/submitted|score/i).first()).toBeVisible({ timeout: 60_000 });
  });

  await signOut(page);

  // ---------------------------------------------------------- admin reviews
  await test.step('admin sees the submission and its score', async () => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/admin/submissions');

    const row = page.getByRole('row', { name: new RegExp(escapeRegExp(CANDIDATE_NAME), 'i') });
    await expect(row.first()).toBeVisible({ timeout: 30_000 });
    await expect(row.first()).toContainText('100');

    await row.first().getByRole('link').first().click();
    await expect(page.getByText(QUESTION_TITLE).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/100\s*%/).first()).toBeVisible();
  });
});

// --------------------------------------------------------------------------

async function fillTestCase(
  page: Page,
  index: number,
  input: string,
  expectedOutput: string,
): Promise<void> {
  await page.getByLabel(/^input$/i).nth(index).fill(input);
  await page.getByLabel(/expected output/i).nth(index).fill(expectedOutput);
}

async function addQuestionToInterview(page: Page, title: string): Promise<void> {
  const picker = page.getByLabel(/add (a )?question/i).first();
  if (await picker.count()) {
    await picker.selectOption({ label: title });
    await page.getByRole('button', { name: /^add/i }).first().click();
    return;
  }
  // Fallback: a row per available question with its own Add control.
  await page
    .getByRole('row', { name: new RegExp(escapeRegExp(title), 'i') })
    .getByRole('button', { name: /add/i })
    .click();
}

/**
 * Monaco is a canvas-backed editor with a hidden textarea; `fill()` on it is
 * unreliable. Focusing and typing through the keyboard is what a candidate
 * actually does, and it is what works.
 */
async function writeSolution(page: Page, source: string): Promise<void> {
  const editor = page.locator('.monaco-editor').first();
  await editor.waitFor({ state: 'visible', timeout: 60_000 });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  // Monaco auto-closes brackets; paste-like insertion avoids fighting it.
  await page.keyboard.insertText(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
