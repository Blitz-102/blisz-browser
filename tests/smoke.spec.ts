import { _electron as electron, expect, test } from '@playwright/test';

// Run through `npm run test:smoke`, which builds first. Uses the project's Electron, no browser download.
test('sidebar renders and the memory panel lists processes', async () => {
  const app = await electron.launch({
    // Scale factor 1 so 1280x800 is exact; at 125% display scaling Windows rounds the height to 801.
    args: ['.', '--force-device-scale-factor=1'],
    // Blank forces the built blisz:// UI instead of a dev server URL from the environment.
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    // Fixed size so the screenshot is the same every run; fail if Windows gives us less.
    await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0]?.setContentSize(1280, 800),
    );
    await expect
      .poll(() => page.evaluate<number[]>('[innerWidth, innerHeight]'))
      .toEqual([1280, 800]);

    await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Forward' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Address' })).toBeVisible();

    // Nothing is focused on launch (no ring on Back), and the first Tab lands on Back with a ring.
    // The window must be shown and focused first: that is when Chromium used to tab into Back.
    await expect
      .poll(() =>
        app.evaluate(({ BaseWindow }) => {
          const window = BaseWindow.getAllWindows()[0];
          return window?.isVisible() && window.isFocused();
        }),
      )
      .toBe(true);
    await expect(page.locator('body')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Back' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Back' })).toHaveCSS('outline-style', 'solid');
    await page.getByRole('button', { name: 'Back' }).blur();

    const pinned = page.getByRole('list', { name: 'Pinned sites' });
    await expect(pinned.getByRole('button')).toHaveCount(8);
    await expect(pinned.getByRole('button', { name: 'GitHub' })).toBeVisible();

    // Initial state: mock data's active tab, memory panel closed. The native caption buttons are
    // drawn by Electron outside the webContents, so they are not in this screenshot (expected).
    await page.screenshot({ path: 'test-results/sidebar-1280x800.png', scale: 'css' });

    const memory = page.getByRole('button', { name: 'Memory' });
    const pageArea = page.getByRole('main');
    await expect(memory).toHaveAttribute('aria-pressed', 'false');
    await expect(pageArea).toContainText('GitHub: bliss-browser');

    // Clicking a tab moves aria-current to it and the address follows.
    const address = page.getByRole('textbox', { name: 'Address' });
    const active = page.locator('[aria-current="page"]');
    await expect(active).toContainText('GitHub: bliss-browser');
    await page.getByRole('button', { name: 'Stack Overflow', exact: true }).click();
    await expect(active).toContainText('Stack Overflow');
    await expect(pageArea).toContainText('Stack Overflow');
    await expect(address).toHaveValue('https://stackoverflow.com/questions');

    // Sleeping tabs say so to screen readers.
    await expect(page.getByRole('button', { name: /^Weather ?, sleeping$/ })).toBeVisible();

    // Closing by keyboard: the close button shows on focus, and focus lands on the active tab.
    const close = page.getByRole('button', { name: 'Close Weather' });
    await close.focus();
    await expect(close).toBeVisible();
    await expect(close).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Weather', exact: true })).toHaveCount(0);
    await expect(active).toBeFocused();

    // Closing the active tab makes its neighbour active.
    await page.getByRole('button', { name: 'Close Stack Overflow' }).click();
    await expect(active).toContainText('Inbox (3)');

    await page.getByRole('button', { name: 'New tab', exact: true }).click();
    await expect(active).toContainText('New tab');
    await expect(page.getByRole('button', { name: 'New tab', exact: true })).toHaveCount(2);

    await memory.click();
    await expect(memory).toHaveAttribute('aria-pressed', 'true');
    const table = page.getByRole('table', { name: 'Memory by process' });
    await expect(table.getByRole('cell', { name: 'UI', exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: 'Browser', exact: true }).first()).toBeVisible();

    // End state with the memory panel open, to eyeball the table.
    await page.screenshot({ path: 'test-results/smoke.png' });
  } finally {
    await app.close();
  }
});
