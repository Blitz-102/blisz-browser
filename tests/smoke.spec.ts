import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    // Scale factor 1 so 1280x800 is exact; at 125% display scaling Windows rounds the height to 801.
    args: ['.', '--force-device-scale-factor=1'],
    // Blank forces the built blisz:// UI instead of a dev server URL from the environment.
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
}

// app.windows() also lists page views, so find the UI by its URL.
async function findUi(app: ElectronApplication): Promise<Page> {
  const isUi = (page: Page) => page.url().startsWith('blisz://');
  await expect.poll(() => app.windows().some(isUi)).toBe(true);
  const ui = app.windows().find(isUi);
  if (!ui) throw new Error('UI window not found');
  return ui;
}

// Run through `npm run test:smoke`, which builds first. Uses the project's Electron, no browser download.
test('sidebar renders and the memory panel lists processes', async () => {
  const app = await launch();
  try {
    const page = await findUi(app);
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

    // A blank tab focuses the address field on launch, and Shift+Tab goes back to Reload with a ring.
    // The window must be shown and focused first: that is when Chromium used to tab into Back.
    await expect
      .poll(() =>
        app.evaluate(({ BaseWindow }) => {
          const window = BaseWindow.getAllWindows()[0];
          return window?.isVisible() && window.isFocused();
        }),
      )
      .toBe(true);
    await expect(page.getByRole('textbox', { name: 'Address' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Reload' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Reload' })).toHaveCSS('outline-style', 'solid');
    await page.getByRole('button', { name: 'Reload' }).blur();

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

    // Clicking a mock tab moves aria-current to it. The address belongs to the real tab (blank).
    const address = page.getByRole('textbox', { name: 'Address' });
    const active = page.locator('[aria-current="page"]');
    await expect(active).toContainText('GitHub: bliss-browser');
    await page.getByRole('button', { name: 'Stack Overflow', exact: true }).click();
    await expect(active).toContainText('Stack Overflow');
    await expect(pageArea).toContainText('Stack Overflow');
    await expect(address).toHaveValue('');

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

test('the address field loads pages, goes back and refuses file URLs', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/next') {
      response.end('<title>Fixture next</title><p>Second page</p>');
    } else if (request.url === '/close') {
      response.end('<title>Fixture close</title><script>window.close()</script>');
    } else {
      response.end('<title>Fixture home</title><a href="/next">Next page</a>');
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const home = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const app = await launch();
    try {
      const ui = await findUi(app);
      const address = ui.getByRole('textbox', { name: 'Address' });
      const back = ui.getByRole('button', { name: 'Back' });
      const pageView = () => {
        const view = app.windows().find((window) => window.url().startsWith(home));
        if (!view) throw new Error('Page view not found');
        return view;
      };

      const pageTitle = async () => {
        const view = app.windows().find((window) => window.url().startsWith(home));
        return view ? await view.title() : '';
      };

      await address.fill(home);
      await address.press('Enter');
      await expect.poll(pageTitle).toBe('Fixture home');
      await expect(address).toHaveValue(home);
      await expect(back).toBeDisabled();

      // Pages see a Chrome UA with a Blisz token, without Electron or the npm app name.
      const appName = await app.evaluate(({ app }) => app.getName());
      const userAgent = await pageView().evaluate<string>('navigator.userAgent');
      expect(userAgent).not.toContain('Electron/');
      expect(userAgent).not.toContain(`${appName.replaceAll(' ', '')}/`);
      expect(userAgent).toMatch(/ Blisz\/\d+\.\d+\.\d+$/);

      await pageView().getByRole('link', { name: 'Next page' }).click();
      await expect(address).toHaveValue(`${home}next`);
      await expect(back).toBeEnabled();

      await back.click();
      await expect(address).toHaveValue(home);

      // The refused URL is dropped and the field falls back to the current URL. Navigating on
      // afterwards proves the refusal was handled first (IPC runs in order).
      await address.fill('file:///C:/');
      await address.press('Enter');
      await expect(address).toHaveValue(home);
      await address.fill(`${home}next`);
      await address.press('Enter');
      await expect.poll(pageTitle).toBe('Fixture next');
      expect(pageView().url()).toBe(`${home}next`);

      // A page that closes itself must not break the app: the address field still navigates.
      await address.fill(`${home}close`);
      await address.press('Enter');
      await ui.waitForTimeout(500);
      await address.fill(home);
      await address.press('Enter');
      await expect.poll(pageTitle).toBe('Fixture home');
      await expect(address).toHaveValue(home);
    } finally {
      await app.close();
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
