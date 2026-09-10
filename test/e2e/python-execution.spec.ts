import { test, expect } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, RUN_ID, signIn, signOut } from './helpers';

/**
 * Python is the half of the execution engine the main workflow spec does not
 * touch, and it is the half most likely to break silently: Pyodide is a
 * ~12 MB WebAssembly download, initialised lazily in a Worker, from a URL
 * that is configurable precisely because it does not always resolve.
 *
 * Unit tests drive `PythonExecutor` through a fake worker, which proves the
 * message protocol but not that CPython actually boots in a browser and
 * reads stdin. This does.
 *
 * It provisions its own question, interview and candidate rather than using
 * the seeded ones. An earlier version signed in as the seeded candidate and
 * changed its password to a per-run value — which passed once and then
 * failed forever, and, worse, turned Playwright's CI retry into a guaranteed
 * second failure because the retry re-ran the sign-in with a password that
 * no longer existed.
 */

const QUESTION_TITLE = `E2E Python Echo ${RUN_ID}`;
const INTERVIEW_TITLE = `E2E Python Interview ${RUN_ID}`;
const CANDIDATE_EMAIL = `py.candidate.${RUN_ID}@example.com`;
const TEMP_PASSWORD = 'PyTemp12345';
const NEW_PASSWORD = 'PyChosen67890';

const SOLUTION_PY = `import sys

print(sys.stdin.readline().rstrip("\\n")[::-1])
`;

test('python runs in the browser against a freshly authored question', async ({ page }) => {
  // Pyodide's first boot dominates this test; everything else is instant.
  test.setTimeout(300_000);

  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

  await test.step('admin authors a Python question', async () => {
    await page.goto('/admin/questions/new');
    await page.getByLabel('Title', { exact: true }).fill(QUESTION_TITLE);
    await page
      .getByLabel('Description', { exact: true })
      .first()
      .fill('Read one line from stdin and print it reversed.');
    await page.getByLabel('Input (stdin)').first().fill('magicvoice');
    await page.getByLabel('Expected output (stdout)').first().fill('eciovcigam');
    await page.getByRole('button', { name: /create question/i }).click();
    await expect(page.getByText(QUESTION_TITLE).first()).toBeVisible({ timeout: 30_000 });
  });

  await test.step('admin publishes an interview containing it', async () => {
    await page.goto('/admin/interviews/new');
    await page.getByLabel('Title', { exact: true }).fill(INTERVIEW_TITLE);
    await page.getByLabel('Status', { exact: true }).selectOption('PUBLISHED');
    await page.getByRole('button', { name: /create interview/i }).click();
    await expect(page).toHaveURL(/\/admin\/interviews\/[^/]+$/, { timeout: 30_000 });

    const picker = page.getByLabel('Question to add');
    const value = await picker
      .locator('option', { hasText: QUESTION_TITLE })
      .first()
      .getAttribute('value');
    if (!value) throw new Error('Question not offered by the interview picker');
    await picker.selectOption(value);
    await page.getByRole('button', { name: /^add$/i }).click();
    await expect(page.getByText(QUESTION_TITLE).first()).toBeVisible();
  });

  await test.step('admin creates a candidate for it', async () => {
    await page.goto('/admin/candidates/new');
    await page.getByLabel('Name', { exact: true }).fill('Py Candidate');
    await page.getByLabel('Email', { exact: true }).fill(CANDIDATE_EMAIL);
    await page.getByLabel(/temporary password/i).fill(TEMP_PASSWORD);

    const assign = page.getByLabel(/assign interview/i);
    const value = await assign
      .locator('option', { hasText: INTERVIEW_TITLE })
      .first()
      .getAttribute('value');
    if (!value) throw new Error('Interview not offered by the assignment picker');
    await assign.selectOption(value);
    await page.getByRole('button', { name: /create candidate/i }).click();
    await expect(page.getByText(CANDIDATE_EMAIL).first()).toBeVisible({ timeout: 30_000 });
  });

  await signOut(page);

  await signIn(page, CANDIDATE_EMAIL, TEMP_PASSWORD);
  await expect(page).toHaveURL(/change-password/);
  await page.getByLabel(/current password/i).fill(TEMP_PASSWORD);
  await page.getByLabel(/^new password/i).fill(NEW_PASSWORD);
  await page.getByLabel(/confirm/i).fill(NEW_PASSWORD);
  await page.getByRole('button', { name: /update password/i }).click();
  await expect(page).toHaveURL(/\/interview/, { timeout: 30_000 });

  await page.getByRole('link', { name: new RegExp(escapeRegExp(QUESTION_TITLE), 'i') }).click();
  await expect(page).toHaveURL(/\/interview\/[^/]+\/q\/[^/]+/, { timeout: 30_000 });

  await page.getByRole('button', { name: /^Python$/ }).click();

  const editor = page.locator('.monaco-editor').first();
  await editor.waitFor({ state: 'visible', timeout: 60_000 });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(SOLUTION_PY);

  // Selecting Python starts the Pyodide warm-up, so Run is briefly disabled.
  const run = page.getByRole('button', { name: /run tests/i });
  await expect(run).toBeEnabled({ timeout: 240_000 });
  await run.click();

  await expect(page.getByText(/1\s*\/\s*1 tests? passed/i).first()).toBeVisible({
    timeout: 240_000,
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
