import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { TabsState } from '../src/shared/tabs';

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

    // Initial state: one blank tab, memory panel closed. The native caption buttons are
    // drawn by Electron outside the webContents, so they are not in this screenshot (expected).
    await page.screenshot({ path: 'test-results/sidebar-1280x800.png', scale: 'css' });

    const memory = page.getByRole('button', { name: 'Memory' });
    const pageArea = page.getByRole('main');
    const rows = page.getByRole('list', { name: 'Open tabs' }).getByRole('listitem');
    await expect(memory).toHaveAttribute('aria-pressed', 'false');
    await expect(pageArea).toContainText('New tab');
    const active = page.locator('[aria-current="page"]');
    await expect(active).toContainText('New tab');
    await expect(page.getByRole('textbox', { name: 'Address' })).toHaveValue('');
    await expect(rows).toHaveCount(2);

    // The "New tab" button is the list's last item, after the tab rows.
    await rows.last().getByRole('button').click();
    await expect(rows).toHaveCount(3);

    // Closing by keyboard: the close button shows on focus, and focus lands on the active tab.
    const close = page.getByRole('button', { name: 'Close New tab' }).first();
    await close.focus();
    await expect(close).toBeVisible();
    await expect(close).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(rows).toHaveCount(2);
    await expect(active).toBeFocused();

    // Closing the last tab leaves a new blank one.
    const lastTabId = (await page.evaluate<TabsState>('window.bliss.getTabsState()')).activeId;
    await page.getByRole('button', { name: 'Close New tab' }).click();
    await expect
      .poll(async () => (await page.evaluate<TabsState>('window.bliss.getTabsState()')).activeId)
      .not.toBe(lastTabId);
    await expect(rows).toHaveCount(2);
    await expect(active).toContainText('New tab');

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

const FAVICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('tabs: create, switch, hide, close, favicon and duplicate', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/favicon.png') {
      response.setHeader('Content-Type', 'image/png');
      response.end(FAVICON_PNG);
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/next') {
      response.end('<title>Fixture next</title><p>Second page</p>');
    } else if (request.url === '/icon') {
      response.end('<title>Fixture icon</title><link rel="icon" href="/favicon.png">');
    } else {
      response.end('<title>Fixture home</title><p>First page</p>');
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const home = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const app = await launch();
    try {
      const ui = await findUi(app);
      const address = ui.getByRole('textbox', { name: 'Address' });
      const tabList = ui.getByRole('list', { name: 'Open tabs' });
      const active = ui.locator('[aria-current="page"]');
      const newTab = tabList.getByRole('listitem').last().getByRole('button');

      // URLs of the page views currently attached to the window (the UI view is not a page).
      const attachedUrls = () =>
        app.evaluate(({ BaseWindow }) =>
          (BaseWindow.getAllWindows()[0]?.contentView.children ?? [])
            .map((view) => (view as Electron.WebContentsView).webContents.getURL())
            .filter((url) => url.startsWith('http')),
        );
      const getState = () => ui.evaluate<TabsState>('window.bliss.getTabsState()');

      await address.fill(home);
      await address.press('Enter');
      await expect(active).toContainText('Fixture home');

      await newTab.click();
      await expect(address).toBeFocused();
      await address.fill(`${home}next`);
      await address.press('Enter');
      await expect(active).toContainText('Fixture next');
      await expect(tabList.getByRole('listitem')).toHaveCount(3);

      // Switching back attaches the first page and detaches the second, which Chromium then hides.
      // document.visibilityState can't be asserted here: Playwright keeps every page it is attached to "visible".
      await ui.getByRole('button', { name: 'Fixture home', exact: true }).click();
      await expect(active).toContainText('Fixture home');
      await expect.poll(attachedUrls).toEqual([home]);

      // Page processes are labelled by tab in the memory panel.
      await ui.getByRole('button', { name: 'Memory' }).click();
      const table = ui.getByRole('table', { name: 'Memory by process' });
      await expect(table.getByRole('cell', { name: /^Tab: .*Fixture next/ })).toBeVisible();
      await ui.getByRole('button', { name: 'Memory' }).click();

      // Closing the active tab activates its neighbour.
      await ui.getByRole('button', { name: 'Close Fixture home' }).click();
      await expect(active).toContainText('Fixture next');
      await expect.poll(attachedUrls).toEqual([`${home}next`]);
      await expect(tabList.getByRole('listitem')).toHaveCount(2);

      // A favicon from the page ends up in the tab row as a data: URL.
      await address.fill(`${home}icon`);
      await address.press('Enter');
      await expect(active).toContainText('Fixture icon');
      await expect(tabList.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);

      // Duplicate (IPC only, no UI yet): a new tab right after the source, with the same URL.
      const { activeId } = await getState();
      const copyId = await ui.evaluate<number>(`window.bliss.duplicateTab(${activeId})`);
      await expect.poll(async () => (await getState()).order).toEqual([activeId, copyId]);
      await expect(address).toHaveValue(`${home}icon`);
      expect((await getState()).activeId).toBe(copyId);

      // Closing every tab leaves one blank tab.
      const oldOrder = (await getState()).order;
      await ui.evaluate(
        `(async () => { for (const id of ${JSON.stringify(oldOrder)}) await window.bliss.closeTab(id); })()`,
      );
      await expect.poll(async () => (await getState()).tabs.map((tab) => tab.url)).toEqual(['']);
      expect(oldOrder).not.toContain((await getState()).activeId);
      await expect(address).toHaveValue('');
      await expect(tabList.getByRole('listitem')).toHaveCount(2);
    } finally {
      await app.close();
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
