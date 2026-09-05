import { expect, test } from '@playwright/test';

/**
 * Smoke test against the running stack: sign in, run a tool, see it recorded.
 *
 * Prerequisite: `make demo`. This asserts the three things that would make the
 * console useless if broken — the OAuth round trip completes, the audit view
 * loads real rows, and chain verification passes — rather than trying to cover
 * every page.
 */

const ALICE = { email: 'alice.chen@acme-corp.com', password: 'Passw0rd!' };

test.describe('operations console', () => {
  test('signs in through the identity provider and lands on the overview', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Operations console' })).toBeVisible();
    await page.getByRole('link', { name: /continue with single sign-on/i }).click();

    // Now on the identity provider's own page.
    await expect(page.getByRole('heading', { name: /sign in to continue/i })).toBeVisible();
    await page.getByLabel('Work email').fill(ALICE.email);
    await page.getByLabel('Password').fill(ALICE.password);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Back on the console, authenticated.
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByText('Acme Corp')).toBeVisible();
    await expect(page.getByText('Alice Chen')).toBeVisible();
  });

  test('shows audited traffic and verifies the hash chain', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /continue with single sign-on/i }).click();
    await page.getByLabel('Work email').fill(ALICE.email);
    await page.getByLabel('Password').fill(ALICE.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    await page.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();

    // Seeded history means there is always something to show.
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);

    await page.getByRole('button', { name: /verify chain/i }).click();
    await expect(page.getByText(/chain intact/i)).toBeVisible({ timeout: 30_000 });
  });

  test('runs a policy evaluation and explains the decision', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /continue with single sign-on/i }).click();
    await page.getByLabel('Work email').fill(ALICE.email);
    await page.getByLabel('Password').fill(ALICE.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    await page.getByRole('link', { name: 'Policies' }).click();
    await expect(page.getByText('baseline bundle')).toBeVisible();

    // The defaults on the form describe a viewer running a warehouse query,
    // which the baseline bundle refuses.
    await page.getByRole('button', { name: 'Evaluate' }).click();

    await expect(page.getByText('deny-warehouse-query-for-viewers')).toBeVisible();
  });
});
