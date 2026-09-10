import { test, expect } from '@playwright/test';
import { RUN_ID, signIn } from './helpers';

/**
 * Python is the half of the execution engine the main workflow spec does not
 * touch, and it is the half most likely to break silently: Pyodide is a
 * ~12 MB WebAssembly download, initialised lazily in a Worker, from a URL
 * that is configurable precisely because it does not always resolve.
 *
 * Unit tests drive `PythonExecutor` through a fake worker, which proves the
 * protocol but not that CPython actually boots in a browser and reads stdin.
 * This does.
 *
 * It runs against the seeded "Reverse a String" question, so it needs
 * `npm run db:seed` to have run, and `SEED_CANDIDATE_PASSWORD` to be set.
 */

const CANDIDATE_EMAIL = process.env.SEED_CANDIDATE_EMAIL ?? 'candidate@magicvoice.local';
const CANDIDATE_PASSWORD = process.env.SEED_CANDIDATE_PASSWORD ?? 'CandidateDev123';
const NEW_PASSWORD = `PySpec${RUN_ID}aa1`;

const SOLUTION_PY = `import sys

print(sys.stdin.readline().rstrip("\\n")[::-1])
`;

test('python runs in the browser and passes the seeded question', async ({ page }) => {
  // Pyodide's first boot dominates this test; everything else is instant.
  test.setTimeout(240_000);

  await signIn(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);

  // The seeded candidate starts on a temporary password.
  if (/change-password/.test(page.url())) {
    await page.getByLabel(/current password/i).fill(CANDIDATE_PASSWORD);
    await page.getByLabel(/^new password/i).fill(NEW_PASSWORD);
    await page.getByLabel(/confirm/i).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: /update password/i }).click();
    await expect(page).toHaveURL(/\/interview/, { timeout: 30_000 });
  }

  await page.goto('/interview');
  await page
    .getByRole('link', { name: /Reverse a String/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/interview\/[^/]+\/q\/[^/]+/, { timeout: 30_000 });

  await page.getByRole('button', { name: /^Python$/ }).click();

  const editor = page.locator('.monaco-editor').first();
  await editor.waitFor({ state: 'visible', timeout: 60_000 });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(SOLUTION_PY);

  // Warm-up is triggered by selecting Python, so Run may be briefly disabled.
  const run = page.getByRole('button', { name: /run tests/i });
  await expect(run).toBeEnabled({ timeout: 180_000 });
  await run.click();

  await expect(page.getByText(/4\s*\/\s*4 tests passed/i).first()).toBeVisible({
    timeout: 180_000,
  });
});
