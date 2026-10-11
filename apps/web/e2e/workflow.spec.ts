import { expect, test } from '@playwright/test';

test('publisher creates, generates, validates, reviews, and exports a product', async ({ page }) => {
  const email = `e2e-${Date.now()}@test.local`;
  await page.goto('/register');
  await page.fill('#name', 'E2E Publisher');
  await page.fill('#email', email);
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // Wizard
  await page.getByRole('link', { name: 'New product' }).first().click();
  await page.fill('#wt', 'Trail Notes for New Hikers');
  await page.fill('#niche', 'beginner hiking journal');
  await page.fill('#tr', 'Adults starting day hiking in their first season');
  await page.fill('#rp', 'Planning safe hikes and remembering what they learned on the trail');
  await page.fill('#diff', 'Each entry pairs a pre-hike safety checklist with a post-hike reflection and a skills tracker built around the first 20 hikes.');
  await page.fill('#author', 'Riley Stone');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#trim')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.selectOption('#ct', 'LINED');
  await page.getByRole('button', { name: 'Next' }).click();
  // Step 4 (generation settings) must be shown — not skipped.
  await expect(page.getByText('Generate original content')).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).click();

  // Project page: background generation completes without blocking the UI.
  await expect(page.getByRole('heading', { name: 'Trail Notes for New Hikers' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Project status' }).locator('[aria-current=step]')).toHaveText('Ready For Review', { timeout: 120_000 });

  // Interior preview renders
  await page.getByRole('link', { name: 'Interior' }).click();
  await expect(page.getByRole('img', { name: /Preview of page/ })).toBeVisible();

  // Validation: review every NEEDS HUMAN REVIEW item
  await page.getByRole('link', { name: 'Validation' }).click();
  await expect(page.getByText(/Report from/)).toBeVisible();
  await page.getByLabel('Filter by status').selectOption('NEEDS_HUMAN_REVIEW');
  // Each unreviewed row offers "Review"; it becomes "Change" once a decision is recorded.
  for (let i = 0; i < 15; i++) {
    const btn = page.getByRole('button', { name: 'Review', exact: true }).first();
    if ((await btn.count()) === 0) break;
    await btn.click();
    await page.fill('#note', 'Checked by the publisher; acceptable for this product.');
    await page.getByRole('button', { name: 'Record decision' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);

  // Export
  await page.getByRole('link', { name: 'Exports' }).click();
  await page.getByRole('button', { name: /Export \d+ item/ }).click();
  await expect(page.getByText(/trail-notes-for-new-hikers-interior\.pdf/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('manifest.json')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.locator('li', { hasText: 'trail-notes-for-new-hikers-interior.pdf' }).getByRole('link', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('trail-notes-for-new-hikers-interior.pdf');
});
