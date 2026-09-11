import { expect, type Page } from '@playwright/test';

/**
 * Shared helpers for the workflow spec.
 *
 * Selectors are role/label based rather than CSS: this suite is meant to
 * survive a restyle and fail only when the *product* changes.
 */

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@magicvoice.local';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'LocalDevAdmin!2345';

/** A unique-per-run suffix so repeated runs never collide on the email unique index. */
export const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/**
 * Both helpers assert on the URL with `expect().toHaveURL` rather than
 * `page.waitForURL`. A Server Action's `redirect()` is a client-side RSC
 * transition — the URL changes without a navigation, so `waitForURL`'s
 * default `waitUntil: 'load'` waits for an event that never fires.
 */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

export async function signOut(page: Page): Promise<void> {
  // A modal left open from the previous step would swallow the click.
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: /sign out/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
}

export async function expectSignedOut(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/login/);
}

/**
 * Every account an admin creates — staff or candidate — is born with
 * `mustChangePassword`, so its first sign-in lands on /change-password rather
 * than on the console. Rotate it and hand back a signed-in page.
 *
 * Same `toHaveURL` convention as `signIn`: the change-password form finishes
 * with a Server Action `redirect()`, which is an RSC transition rather than a
 * navigation, so `waitForURL` would wait for a load event that never fires.
 */
export async function signInAndRotatePassword(
  page: Page,
  email: string,
  temporaryPassword: string,
  newPassword: string,
): Promise<void> {
  await signIn(page, email, temporaryPassword);
  await expect(page).toHaveURL(/\/change-password/, { timeout: 30_000 });

  await page.getByLabel(/current password/i).fill(temporaryPassword);
  await page.getByLabel(/^new password/i).fill(newPassword);
  await page.getByLabel(/confirm/i).fill(newPassword);
  await page.getByRole('button', { name: /update password/i }).click();

  await expect(page).not.toHaveURL(/\/change-password/, { timeout: 30_000 });
}
