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

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

export async function signOut(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /sign out/i }).first();
  if (await button.count()) {
    await button.click();
  } else {
    // Some viewports collapse the control into a menu; fall back to the route.
    await page.goto('/login');
  }
  await page.waitForURL(/\/login/, { timeout: 30_000 });
}

export async function expectSignedOut(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/login/);
}
