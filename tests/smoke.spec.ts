import { _electron as electron, expect, test } from '@playwright/test';

// Run through `npm run test:smoke`, which builds first. Uses the project's Electron, no browser download.
test('sidebar renders and the memory panel lists processes', async () => {
  const app = await electron.launch({
    args: ['.'],
    // Blank forces the built blisz:// UI instead of a dev server URL from the environment.
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Forward' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Address' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Example tab' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Another tab' })).toBeVisible();

    await page.getByRole('button', { name: 'Memory' }).click();
    const table = page.getByRole('table', { name: 'Memory by process' });
    await expect(table.getByRole('cell', { name: 'UI', exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: 'Browser', exact: true }).first()).toBeVisible();

    await page.screenshot({ path: 'test-results/smoke.png' });
  } finally {
    await app.close();
  }
});
