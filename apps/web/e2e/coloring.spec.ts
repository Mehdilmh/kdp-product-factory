import { expect, test } from '@playwright/test';

/** Coloring Studio with the offline line-art model (no network, $0, clearly labelled as a mock). */
test('colorist creates a book, confirms the estimate, generates, reviews, builds the interior and runs preflight', async ({ page }) => {
  await page.goto('/register');
  await page.fill('#name', 'E2E Colorist');
  await page.fill('#email', `e2e-color-${Date.now()}@test.local`);
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await page.getByRole('link', { name: 'Coloring Studio' }).click();
  await page.getByRole('link', { name: 'New coloring book' }).first().click();
  await page.fill('#c-title', 'Ocean Friends');
  await page.fill('#c-auth', 'Riley Park');
  await page.selectOption('#c-theme', 'ocean');
  await page.fill('#c-n', '4');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#st-outlineThickness')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('combobox', { name: 'Image model' }).selectOption({ label: 'Offline mock — line art — free mock' });
  await page.getByRole('button', { name: /Create book/ }).click();
  await expect(page.getByRole('heading', { name: 'Ocean Friends' })).toBeVisible();

  await page.getByRole('tab', { name: 'Generate & review' }).click();
  await page.getByRole('button', { name: 'Select shown' }).click();
  await page.getByRole('button', { name: /Generate…/ }).click();
  const go = page.getByRole('button', { name: /Generate 4 page/ });
  await expect(page.getByText(/Known total for 4 page/)).toBeVisible();
  // Nothing runs before the cost is confirmed.
  await expect(go).toBeDisabled();
  await page.getByRole('checkbox', { name: /I confirm/ }).check();
  await go.click();
  await expect(page.getByText('Needs Review').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /Open page 4/ }).locator('img')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: /Open page 1/ }).click();
  await expect(page.getByText('Original (never modified)')).toBeVisible();
  await expect(page.getByText(/Text, signatures, watermarks/)).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Select shown' }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('4 / 4')).toBeVisible();

  await page.getByRole('tab', { name: 'Interior' }).click();
  await page.getByRole('button', { name: /Build interior from 4/ }).click();
  await expect(page.getByText(/4 illustrations → \d+ pages/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/not found/)).toHaveCount(0);

  await page.getByRole('tab', { name: 'Preflight' }).click();
  await page.getByRole('button', { name: 'Run preflight' }).click();
  await expect(page.getByText(/it is not an approval/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Official requirements needing verification' })).toBeVisible();

  await page.getByRole('link', { name: 'Coloring Studio' }).click();
  await expect(page.getByRole('link', { name: 'Ocean Friends' })).toBeVisible();
});
