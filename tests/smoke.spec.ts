import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { TabsState } from '../src/shared/tabs';

// Each launch gets a throwaway profile, so tests never touch (or depend on) the real one.
async function launch(): Promise<ElectronApplication> {
  const userData = mkdtempSync(join(tmpdir(), 'blisz-test-'));
  const app = await electron.launch({
    // Scale factor 1 so 1280x800 is exact; at 125% display scaling Windows rounds the height to 801.
    args: ['.', '--force-device-scale-factor=1'],
    // Blank forces the built blisz:// UI instead of a dev server URL from the environment.
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      BLISZ_USER_DATA: userData,
      BLISZ_DOWNLOAD_NO_PROMPT: '1', // the native Save as dialog can't be driven by a test
    },
  });
  app.on('close', () => rmSync(userData, { recursive: true, force: true, maxRetries: 5 }));
  return app;
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

// Playwright's keyboard goes through CDP, which skips before-input-event, so keys are sent with
// webContents.sendInputEvent instead. `target` is the start of the URL of the view that gets the key.
async function pressKey(
  app: ElectronApplication,
  target: string,
  keyCode: string,
  modifiers: ('control' | 'shift' | 'alt')[] = [],
) {
  await app.evaluate(
    ({ webContents }, { target, keyCode, modifiers }) => {
      const contents = webContents.getAllWebContents().find((c) => c.getURL().startsWith(target));
      if (!contents) throw new Error(`No view at ${target}`);
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    },
    { target, keyCode, modifiers },
  );
}

test('keyboard shortcuts work from the UI and from a page', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/next') {
      response.end('<title>Fixture next</title><p>Second page</p>');
    } else if (request.url === '/slow') {
      setTimeout(() => response.end('<title>Fixture slow</title>'), 10_000);
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
      const focusView = (target: string) =>
        app.evaluate(({ webContents }, target) => {
          webContents
            .getAllWebContents()
            .find((c) => c.getURL().startsWith(target))
            ?.focus();
        }, target);
      const isUiFocused = () =>
        app.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .find((c) => c.getURL().startsWith('blisz://'))
            ?.isFocused(),
        );
      const getState = () => ui.evaluate<TabsState>('window.bliss.getTabsState()');

      await address.fill(home);
      await address.press('Enter');
      await expect.poll(async () => (await getState()).tabs[0]?.title).toBe('Fixture home');
      const [firstId] = (await getState()).order;

      // Ctrl+T from the page: a new blank tab, and the address field gets focus.
      await focusView(home);
      await expect.poll(isUiFocused).toBe(false);
      await pressKey(app, home, 'T', ['control']);
      await expect.poll(async () => (await getState()).order.length).toBe(2);
      await expect.poll(isUiFocused).toBe(true);
      await expect(address).toBeFocused();
      const secondId = (await getState()).activeId;

      // Ctrl+Tab wraps in sidebar order, Ctrl+Shift+Tab goes the other way, Ctrl+1 picks by position.
      await pressKey(app, 'blisz://', 'Tab', ['control']);
      await expect.poll(async () => (await getState()).activeId).toBe(firstId);
      await pressKey(app, home, 'Tab', ['control', 'shift']);
      await expect.poll(async () => (await getState()).activeId).toBe(secondId);
      await pressKey(app, 'blisz://', '1', ['control']);
      await expect.poll(async () => (await getState()).activeId).toBe(firstId);

      // Ctrl+L while the page has focus moves focus to the address field.
      await expect(address).toHaveValue(home);
      await ui.evaluate('document.activeElement.blur()');
      await focusView(home);
      await expect.poll(isUiFocused).toBe(false);
      await pressKey(app, home, 'L', ['control']);
      await expect.poll(isUiFocused).toBe(true);
      await expect(address).toBeFocused();
      expect(
        await ui.evaluate<number[]>(
          '(() => { const i = document.activeElement; return [i.selectionStart, i.selectionEnd, i.value.length]; })()',
        ),
      ).toEqual([0, home.length, home.length]);

      // Alt+Left goes back after following a link.
      await app.evaluate(({ webContents }, target) => {
        webContents
          .getAllWebContents()
          .find((c) => c.getURL().startsWith(target))
          ?.loadURL(`${target}next`);
      }, home);
      await expect.poll(async () => (await getState()).tabs[0]?.title).toBe('Fixture next');
      await pressKey(app, home, 'Left', ['alt']);
      await expect.poll(async () => (await getState()).tabs[0]?.title).toBe('Fixture home');

      // Esc stops a slow load.
      await address.fill(`${home}slow`);
      await address.press('Enter');
      await expect.poll(async () => (await getState()).tabs[0]?.isLoading).toBe(true);
      await pressKey(app, home, 'Escape');
      await expect.poll(async () => (await getState()).tabs[0]?.isLoading).toBe(false);

      // Ctrl+W closes the active tab; the neighbour takes over.
      await pressKey(app, home, 'W', ['control']);
      await expect.poll(async () => (await getState()).order).toEqual([secondId]);
      // Closing the last tab leaves a blank one.
      await pressKey(app, 'blisz://', 'W', ['control']);
      await expect.poll(async () => (await getState()).tabs.map((tab) => tab.url)).toEqual(['']);
      expect((await getState()).order).not.toContain(secondId);

      // F12 on a blank tab does nothing and the app keeps working.
      await pressKey(app, 'blisz://', 'F12');
      await ui.waitForTimeout(200);
      expect((await getState()).tabs).toHaveLength(1);
    } finally {
      await app.close();
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// One fixture site for the popup, find and zoom tests.
const FIXTURE_PAGES: Record<string, string> = {
  '/': `<title>Fixture home</title>
    <a href="/popup" target="_blank">Open popup</a>
    <a href="/closer" target="_blank">Open closer</a>
    <button onclick="window.open('/popup'); window.open('/popup')">Open two</button>`,
  '/popup': `<title>Fixture popup</title><script>document.title = window.opener !== null ? 'opener:yes' : 'opener:no'</script>`,
  '/closer': '<title>Fixture closer</title><script>setTimeout(() => window.close(), 1000)</script>',
  '/scripted': `<title>Fixture scripted</title><button id="go">Go</button>
    <script>document.getElementById('go').onclick = () => {
      const popup = window.open('about:blank');
      popup.eval("setTimeout(() => window.open('/popup'), 100)");
    }</script>`,
  '/spam': `<title>Fixture spam</title>
    <script>setTimeout(() => { for (let i = 0; i < 5; i++) window.open('/popup') }, 100)</script>`,
  '/links':
    '<title>Fixture links</title><a href="/popup">One</a> <a href="/popup">Two</a> <a href="/popup">Three</a>',
  '/text': '<title>Fixture text</title><p>needle one, needle two, needle three</p>',
};

async function startFixture(): Promise<{ home: string; stop: () => void }> {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(FIXTURE_PAGES[request.url ?? '/'] ?? FIXTURE_PAGES['/']);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    home,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// Starts the app on the fixture site with the home page open in the first tab. Popup tests each
// get their own app because the rate limit remembers popups for 5 s.
async function openFixtureSession() {
  const fixture = await startFixture();
  const { home } = fixture;
  const app = await launch().catch((error) => {
    fixture.stop();
    throw error;
  });
  const close = async () => {
    await app.close();
    fixture.stop();
  };
  try {
    const ui = await findUi(app);
    const address = ui.getByRole('textbox', { name: 'Address' });
    const getState = () => ui.evaluate<TabsState>('window.bliss.getTabsState()');
    const pageAt = (url: string) => {
      const view = app.windows().find((window) => window.url() === url);
      if (!view) throw new Error(`Page view not found at ${url}`);
      return view;
    };
    await address.fill(home);
    await address.press('Enter');
    await expect.poll(async () => (await getState()).tabs[0]?.title).toBe('Fixture home');
    const [openerId] = (await getState()).order;
    return { app, ui, address, home, openerId, getState, pageAt, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const SECURE_SETUP = {
  samePartition: true,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  safeDialogs: true, // pages get the "prevent more dialogs" checkbox
  preload: null,
};

// What a page view at `url` runs with: its session and the web preferences it was created with.
function secureSetup(app: ElectronApplication, url: string) {
  return app.evaluate(({ webContents, session }, url) => {
    const contents = webContents.getAllWebContents().find((c) => c.getURL() === url);
    const preferences = (
      contents as unknown as { getLastWebPreferences(): Electron.WebPreferences }
    ).getLastWebPreferences();
    return {
      samePartition: contents?.session === session.fromPartition('persist:main'),
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      webSecurity: preferences.webSecurity,
      safeDialogs: preferences.safeDialogs,
      preload: preferences.preload ?? null,
    };
  }, url);
}

test('a target=_blank link opens an active tab with the same secure setup', async () => {
  const { app, ui, home, openerId, getState, pageAt, close } = await openFixtureSession();
  try {
    await pageAt(home).getByRole('link', { name: 'Open popup' }).click();
    await expect.poll(async () => (await getState()).order.length).toBe(2);
    expect((await getState()).activeId).not.toBe(openerId);
    await expect.poll(async () => (await getState()).tabs[1]?.url).toBe(`${home}popup`);
    // Links with target=_blank are noopener by default in Chromium.
    await expect.poll(async () => (await getState()).tabs[1]?.title).toBe('opener:no');

    // Known gap: Electron does not apply safeDialogs to the webContents it creates for
    // window.opener, whatever overrideBrowserWindowOptions says. Revisit when this fails.
    expect(await secureSetup(app, `${home}popup`)).toEqual({ ...SECURE_SETUP, safeDialogs: false });

    // Closing the popup tab goes back to its opener.
    await ui.evaluate(`window.bliss.closeTab(${(await getState()).activeId})`);
    await expect.poll(async () => (await getState()).activeId).toBe(openerId);
  } finally {
    await close();
  }
});

test('window.open keeps window.opener, and a second popup from the same click is blocked', async () => {
  const { ui, address, home, openerId, getState, pageAt, close } = await openFixtureSession();
  try {
    // The first popup becomes the active tab, so the second comes from an inactive opener.
    await pageAt(home).getByRole('button', { name: 'Open two' }).click();
    await expect.poll(async () => (await getState()).order.length).toBe(2);
    await expect.poll(async () => (await getState()).tabs[1]?.title).toBe('opener:yes');
    await expect.poll(async () => (await getState()).tabs[0]?.blockedPopups).toBe(1);

    // Back on the opener the note shows, and a navigation clears it.
    await ui.getByRole('button', { name: 'Fixture home', exact: true }).click();
    await expect(ui.getByText('Popup blocked')).toBeVisible();
    await address.fill(`${home}text`);
    await address.press('Enter');
    await expect.poll(async () => (await getState()).tabs[0]?.blockedPopups).toBe(0);
    await expect(ui.getByText('Popup blocked')).toHaveCount(0);
    expect((await getState()).activeId).toBe(openerId);
  } finally {
    await close();
  }
});

test('no-gesture popup spam is blocked and noted', async () => {
  const { ui, address, home, getState, close } = await openFixtureSession();
  try {
    await address.fill(`${home}spam`);
    await address.press('Enter');
    // Without a real click or key none of the five opens, and the opener stays active.
    await expect.poll(async () => (await getState()).tabs[0]?.blockedPopups).toBe(5);
    expect((await getState()).order).toHaveLength(1);
    await expect(ui.getByText('Popup blocked')).toBeVisible();
  } finally {
    await close();
  }
});

test('background popups are limited to two in five seconds', async () => {
  const { app, ui, address, home, openerId, getState, pageAt, close } = await openFixtureSession();
  try {
    await address.fill(`${home}links`);
    await address.press('Enter');
    await expect.poll(async () => (await getState()).tabs[0]?.title).toBe('Fixture links');
    // A middle click opens a background tab, so the opener stays active. It is sent with
    // sendInputEvent because Playwright's own middle click waits for the new page and hangs.
    for (const index of [0, 1, 2]) {
      const [x = 0, y = 0] = await pageAt(`${home}links`).evaluate<number[]>(
        `(() => { const r = document.querySelectorAll('a')[${index}].getBoundingClientRect(); return [Math.round(r.x + 2), Math.round(r.y + 2)]; })()`,
      );
      await app.evaluate(
        ({ webContents }, { url, x, y }) => {
          const contents = webContents.getAllWebContents().find((c) => c.getURL() === url);
          const click = { x, y, button: 'middle', clickCount: 1 } as const;
          contents?.sendInputEvent({ type: 'mouseMove', x, y });
          contents?.sendInputEvent({ type: 'mouseDown', ...click });
          contents?.sendInputEvent({ type: 'mouseUp', ...click });
        },
        { url: `${home}links`, x, y },
      );
    }
    await expect.poll(async () => (await getState()).order.length).toBe(3);
    await expect.poll(async () => (await getState()).tabs[0]?.blockedPopups).toBe(1);
    expect((await getState()).activeId).toBe(openerId);
    await expect(ui.getByText('Popup blocked')).toBeVisible();
    // A background popup is a view we created, with the same secure setup.
    await expect.poll(async () => (await getState()).tabs[1]?.url).toBe(`${home}popup`);
    expect(await secureSetup(app, `${home}popup`)).toEqual(SECURE_SETUP);
  } finally {
    await close();
  }
});

test('a popup that closes itself closes its tab and re-activates the opener', async () => {
  const { app, home, openerId, getState, pageAt, close } = await openFixtureSession();
  try {
    await pageAt(home).getByRole('link', { name: 'Open closer' }).click();
    await expect.poll(async () => (await getState()).order.length).toBe(2);
    await expect.poll(async () => (await getState()).order).toEqual([openerId]);
    expect((await getState()).activeId).toBe(openerId);
    // The opener still works afterwards.
    await expect(pageAt(home).getByRole('link', { name: 'Open popup' })).toBeVisible();
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(2);
  } finally {
    await close();
  }
});

test('find strip: Ctrl+F, counts, next and previous, shrinking the page, closing', async () => {
  const fixture = await startFixture();
  const { home } = fixture;
  const app = await launch();
  try {
    const ui = await findUi(app);
    const address = ui.getByRole('textbox', { name: 'Address' });
    const find = ui.getByRole('textbox', { name: 'Find in page' });
    const count = ui.getByText(/^\d+ of \d+$/);
    const pageArea = ui.getByRole('main');
    const areaHeight = async () => (await pageArea.boundingBox())?.height ?? 0;
    const attachedHeight = () =>
      app.evaluate(({ BaseWindow }) => {
        const view = BaseWindow.getAllWindows()[0]?.contentView.children.find((child) =>
          (child as Electron.WebContentsView).webContents.getURL().startsWith('http'),
        );
        return (view as Electron.WebContentsView).getBounds().height;
      });

    await address.fill(`${home}text`);
    await address.press('Enter');
    await expect(ui.locator('[aria-current="page"]')).toContainText('Fixture text');
    const fullHeight = await areaHeight();

    await pressKey(app, home, 'F', ['control']);
    await expect(find).toBeFocused();
    // The page area, and with it the page view, shrinks while the strip is open.
    await expect.poll(areaHeight).toBeLessThan(fullHeight);
    await expect
      .poll(async () => Math.abs((await attachedHeight()) - (await areaHeight())))
      .toBeLessThanOrEqual(1);

    await find.fill('needle');
    await expect(count).toHaveText('1 of 3');
    await find.press('Enter');
    await expect(count).toHaveText('2 of 3');
    await find.press('Shift+Enter');
    await expect(count).toHaveText('1 of 3');
    await ui.getByRole('button', { name: 'Next match' }).click();
    await expect(count).toHaveText('2 of 3');
    await ui.getByRole('button', { name: 'Previous match' }).click();
    await expect(count).toHaveText('1 of 3');
    await pressKey(app, 'blisz://', 'F3');
    await expect(count).toHaveText('2 of 3');
    await pressKey(app, 'blisz://', 'F3', ['shift']);
    await expect(count).toHaveText('1 of 3');
    await find.fill('nothing like this');
    await expect(count).toHaveText('0 of 0');

    // Ctrl+F again focuses the existing input.
    await ui.getByRole('button', { name: 'Next match' }).focus();
    await pressKey(app, 'blisz://', 'F', ['control']);
    await expect(find).toBeFocused();

    // Esc closes the strip and the page area grows back.
    await find.press('Escape');
    await expect(find).toHaveCount(0);
    await expect.poll(areaHeight).toBe(fullHeight);

    // F3 does nothing while the strip is closed; switching tabs closes an open strip.
    await pressKey(app, 'blisz://', 'F3');
    await expect(find).toHaveCount(0);
    await pressKey(app, home, 'F', ['control']);
    await expect(find).toBeFocused();
    await pressKey(app, 'blisz://', 'T', ['control']);
    await expect(find).toHaveCount(0);
  } finally {
    await app.close();
    fixture.stop();
  }
});

test('zoom: shortcuts, steps, shared by origin, reset button and Ctrl+scroll', async () => {
  const fixture = await startFixture();
  const { home } = fixture;
  const app = await launch();
  try {
    const ui = await findUi(app);
    const address = ui.getByRole('textbox', { name: 'Address' });
    const resetZoom = ui.getByRole('button', { name: 'Reset zoom' });
    const getState = () => ui.evaluate<TabsState>('window.bliss.getTabsState()');
    const zooms = async () => (await getState()).tabs.map((tab) => tab.zoom);

    await address.fill(home);
    await address.press('Enter');
    await expect.poll(async () => (await getState()).tabs[0]?.title).toBe('Fixture home');
    await expect(resetZoom).toHaveCount(0);

    await ui.evaluate('window.bliss.createTab()');
    await expect(address).toHaveValue(''); // the UI has switched to the new tab
    await address.fill(`${home}text`);
    await address.press('Enter');
    await expect.poll(async () => (await getState()).tabs[1]?.title).toBe('Fixture text');

    // Ctrl+= steps 100 -> 110 -> 125, Ctrl+- goes back; both tabs share the origin's zoom.
    await pressKey(app, home, '=', ['control']);
    await expect.poll(zooms).toEqual([1.1, 1.1]);
    await expect(resetZoom).toHaveText('110%');
    await pressKey(app, home, '=', ['control']);
    await expect.poll(zooms).toEqual([1.25, 1.25]);
    await pressKey(app, home, '-', ['control']);
    await pressKey(app, home, '-', ['control']);
    await pressKey(app, home, '-', ['control']);
    await expect.poll(zooms).toEqual([0.9, 0.9]);

    await resetZoom.click();
    await expect.poll(zooms).toEqual([1, 1]);
    await expect(resetZoom).toHaveCount(0);

    await pressKey(app, home, '=', ['control']);
    await expect.poll(zooms).toEqual([1.1, 1.1]);
    await pressKey(app, home, '0', ['control']);
    await expect.poll(zooms).toEqual([1, 1]);

    // Ctrl+scroll up zooms in (a synthetic wheel event can count as more than one notch).
    await app.evaluate(({ webContents }, target) => {
      const contents = webContents.getAllWebContents().find((c) => c.getURL().startsWith(target));
      contents?.sendInputEvent({
        type: 'mouseWheel',
        x: 100,
        y: 100,
        deltaX: 0,
        deltaY: 120,
        wheelTicksY: 1,
        modifiers: ['control'],
      });
    }, home);
    await expect.poll(async () => (await zooms())[0]).toBeGreaterThan(1);
  } finally {
    await app.close();
    fixture.stop();
  }
});

// A fixture site with downloads. Every file sends half of its bytes and then waits for release(),
// so tests can look at (or cancel) a download that is really running. /broken.zip drops the connection.
const FILE_SIZE = 2000;

async function startDownloadFixture(): Promise<{
  home: string;
  release: () => void;
  stop: () => void;
}> {
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path === '/report.zip' || path === '/setup.exe' || path === '/broken.zip') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.slice(1)}"`,
        'Content-Length': FILE_SIZE,
      });
      response.write(Buffer.alloc(FILE_SIZE / 2));
      if (path === '/broken.zip') setTimeout(() => request.socket.destroy(), 300);
      else held.push(response);
    } else if (path === '/slow.png') {
      response.setHeader('Content-Type', 'image/png');
      response.write(FAVICON_PNG.subarray(0, 20));
      held.push(response);
    } else if (path === '/pic.png') {
      response.setHeader('Content-Type', 'image/png');
      response.end(FAVICON_PNG);
    } else {
      response.setHeader('Content-Type', 'text/html');
      const pages: Record<string, string> = {
        '/auto': `<title>Fixture auto</title><a id="dl" href="/report.zip">Report</a>
          <script>setTimeout(() => document.getElementById('dl').click(), 100)</script>`,
        '/after': `<title>Fixture after</title><a id="dl" href="/report.zip">Report</a>
          <script>setTimeout(() => document.getElementById('dl').click(), 500)</script>`,
      };
      response.end(
        pages[path] ??
          `<title>Fixture downloads</title><a href="/report.zip">Report</a>
          <a href="/setup.exe">Setup</a> <a href="/broken.zip">Broken</a>
          <a href="/report.zip" target="_blank">Report in new tab</a> <a href="/after">Later</a>
          <img src="/pic.png" alt="Picture">`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const release = () => {
    for (const response of held.splice(0)) {
      response.end(
        response.getHeader('Content-Type') === 'image/png'
          ? FAVICON_PNG.subarray(20)
          : Buffer.alloc(FILE_SIZE / 2),
      );
    }
  };
  return {
    home: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    release,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function openDownloadSession() {
  const fixture = await startDownloadFixture();
  const app = await launch().catch((error) => {
    fixture.stop();
    throw error;
  });
  const close = async () => {
    await app.close();
    fixture.stop();
  };
  try {
    const ui = await findUi(app);
    const address = ui.getByRole('textbox', { name: 'Address' });
    const downloadsDir = await app.evaluate(({ app }) => app.getPath('downloads'));
    const pageAt = (url: string) => {
      const view = app.windows().find((window) => window.url() === url);
      if (!view) throw new Error(`Page view not found at ${url}`);
      return view;
    };
    await address.fill(fixture.home);
    await address.press('Enter');
    await expect(ui.locator('[aria-current="page"]')).toContainText('Fixture downloads');
    return {
      app,
      ui,
      address,
      home: fixture.home,
      release: fixture.release,
      downloadsDir,
      pageAt,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test('a clicked download saves into Downloads, shows progress, and Open and Show use main path', async () => {
  const { app, ui, home, release, downloadsDir, pageAt, close } = await openDownloadSession();
  try {
    // Record the shell calls instead of opening real windows.
    await app.evaluate(({ shell }) => {
      const calls: string[][] = [];
      (globalThis as unknown as { shellCalls: string[][] }).shellCalls = calls;
      shell.openPath = async (path) => {
        calls.push(['open', path]);
        return '';
      };
      shell.showItemInFolder = (path) => {
        calls.push(['show', path]);
      };
    });
    const shellCalls = () =>
      app.evaluate(() => (globalThis as unknown as { shellCalls: string[][] }).shellCalls);
    const section = ui.getByRole('region', { name: 'Downloads' });
    await expect(section).toHaveCount(0);

    await pageAt(home).getByRole('link', { name: 'Report', exact: true }).click();
    const item = section.getByRole('listitem').first();
    await expect(item).toContainText('report.zip');
    await expect(item.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(item.getByRole('button', { name: 'Open' })).toHaveCount(0);
    await expect(item.getByRole('progressbar')).toHaveJSProperty('value', 50);
    release();
    await expect(item.getByRole('progressbar')).toHaveJSProperty('value', 100);
    await expect(item).toContainText('Done');
    const file = join(downloadsDir, 'report.zip');
    expect(statSync(file).size).toBe(FILE_SIZE);

    // The file is marked as downloaded from the internet. Chromium writes the stream itself (a
    // scratch run showed it does, adding ReferrerUrl when there is a referrer); our fallback in
    // downloads.ts only runs if it ever stops. The content is logged so a change is noticed.
    if (process.platform === 'win32') {
      const mark = readFileSync(`${file}:Zone.Identifier`, 'utf8');
      console.log(`Mark of the Web on a fixture download: ${JSON.stringify(mark)}`);
      expect(mark).toMatch(/^\[ZoneTransfer\]\r\nZoneId=3\r\n/);
      expect(mark).toContain(`HostUrl=${home}report.zip`);
    }

    await item.getByRole('button', { name: 'Show report.zip in folder' }).click();
    await item.getByRole('button', { name: 'Open report.zip' }).click();
    await expect.poll(shellCalls).toEqual([
      ['show', file],
      ['open', file],
    ]);

    // The same name again gets a number. Executables can't be opened from the list.
    await pageAt(home).getByRole('link', { name: 'Report', exact: true }).click();
    await expect(
      section
        .getByRole('listitem')
        .nth(1)
        .getByRole('button', { name: /^Cancel/ }),
    ).toBeVisible();
    release();
    await expect(section.getByRole('listitem').nth(1)).toContainText('Done');
    expect(readdirSync(downloadsDir).sort()).toEqual(['report (1).zip', 'report.zip']);
    await pageAt(home).getByRole('link', { name: 'Setup' }).click();
    const setup = section.getByRole('listitem').nth(2);
    await expect(setup.getByRole('button', { name: /^Cancel/ })).toBeVisible();
    release();
    await expect(setup).toContainText('Done');
    await expect(setup.getByRole('button', { name: 'Open' })).toHaveCount(0);
    await expect(setup.getByRole('button', { name: 'Show setup.exe in folder' })).toBeVisible();

    await section.getByRole('button', { name: 'Clear' }).click();
    await expect(section).toHaveCount(0);
  } finally {
    await close();
  }
});

test('a running download can be cancelled', async () => {
  const { ui, home, downloadsDir, pageAt, close } = await openDownloadSession();
  try {
    await pageAt(home).getByRole('link', { name: 'Report', exact: true }).click();
    const item = ui.getByRole('region', { name: 'Downloads' }).getByRole('listitem').first();
    await item.getByRole('button', { name: 'Cancel' }).click();
    await expect(item).toContainText('Cancelled');
    await expect(item.getByRole('button', { name: 'Open' })).toHaveCount(0);
    // Chromium removes the partial file shortly after the cancel.
    await expect.poll(() => readdirSync(downloadsDir)).toEqual([]);
  } finally {
    await close();
  }
});

test('a download without a click or key is blocked and noted', async () => {
  const { ui, address, home, downloadsDir, close } = await openDownloadSession();
  try {
    await address.fill(`${home}auto`);
    await address.press('Enter');
    await expect(ui.getByText('Download blocked')).toBeVisible();
    await expect(ui.getByRole('region', { name: 'Downloads' })).toHaveCount(0);
    await ui.waitForTimeout(500);
    expect(readdirSync(downloadsDir)).toEqual([]);

    // Navigating resets the note.
    await address.fill(home);
    await address.press('Enter');
    await expect(ui.getByText('Download blocked')).toHaveCount(0);
  } finally {
    await close();
  }
});

// Pops the page context menu for `params` without a real right-click, choosing the item `label`.
function pickPageMenuItem(
  app: ElectronApplication,
  url: string,
  params: Record<string, unknown>,
  label: string,
) {
  return app.evaluate(
    ({ Menu, webContents }, { url, params, label }) => {
      const contents = webContents.getAllWebContents().find((c) => c.getURL() === url);
      Menu.prototype.popup = function () {
        this.items.find((entry) => entry.label === label)?.click();
      };
      const base = {
        linkURL: '',
        srcURL: '',
        mediaType: 'none',
        hasImageContents: false,
        selectionText: '',
        isEditable: false,
        misspelledWord: '',
        dictionarySuggestions: [],
        editFlags: {},
        x: 5,
        y: 5,
      };
      contents?.emit('context-menu', {}, { ...base, ...params });
    },
    { url, params, label },
  );
}

test('the page context menu saves and copies images and links through main', async () => {
  const { app, ui, home, downloadsDir, close } = await openDownloadSession();
  try {
    const image = { mediaType: 'image', srcURL: `${home}pic.png`, hasImageContents: true };
    // No click happened, so only the menu's own "Save image as" allowance lets this download through.
    await pickPageMenuItem(app, home, image, 'Save image as…');
    const item = ui.getByRole('region', { name: 'Downloads' }).getByRole('listitem').first();
    await expect(item).toContainText('pic.png');
    await expect(item).toContainText('Done');
    expect(statSync(join(downloadsDir, 'pic.png')).size).toBeGreaterThan(0);
    // The allowance is spent: a second download without input is blocked.
    await app.evaluate(({ webContents }, url) => {
      webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)
        ?.downloadURL(`${url}pic.png`);
    }, home);
    await expect(ui.getByText('Download blocked')).toBeVisible();

    const readClipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
    await pickPageMenuItem(app, home, image, 'Copy image address');
    await expect.poll(readClipboard).toBe(`${home}pic.png`);
    await pickPageMenuItem(app, home, { linkURL: `${home}report.zip` }, 'Copy link address');
    await expect.poll(readClipboard).toBe(`${home}report.zip`);

    // A background tab opens right after the current one; the current tab stays active.
    const tabs = ui.getByRole('list', { name: 'Open tabs' }).getByRole('listitem');
    await expect(tabs).toHaveCount(2);
    await pickPageMenuItem(app, home, { linkURL: `${home}auto` }, 'Open link in new tab');
    await expect(tabs).toHaveCount(3);
    await expect(ui.locator('[aria-current="page"]')).toContainText('Fixture downloads');
    await expect(tabs.nth(1)).toContainText('Fixture auto');
  } finally {
    await close();
  }
});

test('right-clicking a tab offers Duplicate and Close', async () => {
  const { app, ui, close } = await openDownloadSession();
  try {
    const tabs = ui.getByRole('list', { name: 'Open tabs' }).getByRole('listitem');
    const choose = async (label: string) => {
      await app.evaluate(({ Menu }, label) => {
        Menu.prototype.popup = function () {
          this.items.find((entry) => entry.label === label)?.click();
        };
      }, label);
      await tabs.first().click({ button: 'right' });
    };
    await expect(tabs).toHaveCount(2);
    await choose('Duplicate');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(1)).toContainText('Fixture downloads');
    await choose('Close');
    await expect(tabs).toHaveCount(2);
    await expect(ui.locator('[aria-current="page"]')).toContainText('Fixture downloads');
  } finally {
    await close();
  }
});

test('a download that loses its connection ends as Failed and can be cleared', async () => {
  const { ui, home, pageAt, close } = await openDownloadSession();
  try {
    await pageAt(home).getByRole('link', { name: 'Broken' }).click();
    const section = ui.getByRole('region', { name: 'Downloads' });
    const item = section.getByRole('listitem').first();
    await expect(item).toContainText('Failed');
    await expect(item.getByRole('button', { name: /^Cancel/ })).toHaveCount(0);
    await expect(item.getByRole('button', { name: /^Open/ })).toHaveCount(0);
    await expect(item.getByRole('progressbar')).toHaveCount(0);
    await section.getByRole('button', { name: 'Clear' }).click();
    await expect(section).toHaveCount(0);
  } finally {
    await close();
  }
});

test('a target=_blank download link downloads and closes its popup tab', async () => {
  const { ui, home, release, pageAt, close } = await openDownloadSession();
  try {
    const tabs = ui.getByRole('list', { name: 'Open tabs' }).getByRole('listitem');
    await pageAt(home).getByRole('link', { name: 'Report in new tab' }).click();
    const item = ui.getByRole('region', { name: 'Downloads' }).getByRole('listitem').first();
    await expect(item.getByRole('button', { name: /^Cancel/ })).toBeVisible();
    // The popup only existed to start the download, so it is gone and the opener is active again.
    await expect(tabs).toHaveCount(2);
    await expect(ui.locator('[aria-current="page"]')).toContainText('Fixture downloads');
    release();
    await expect(item).toContainText('Done');
  } finally {
    await close();
  }
});

test('a click on the previous page does not let the next page download', async () => {
  const { ui, home, downloadsDir, pageAt, close } = await openDownloadSession();
  try {
    // The click navigates to /after, whose script clicks a download link 500 ms later.
    await pageAt(home).getByRole('link', { name: 'Later' }).click();
    await expect(ui.getByText('Download blocked')).toBeVisible();
    await expect(ui.getByRole('region', { name: 'Downloads' })).toHaveCount(0);
    expect(readdirSync(downloadsDir)).toEqual([]);
  } finally {
    await close();
  }
});

test('at most five downloads run at once', async () => {
  const { app, ui, home, release, close } = await openDownloadSession();
  try {
    const items = ui.getByRole('region', { name: 'Downloads' }).getByRole('listitem');
    // "Save image as" skips the click rule, so five can be started without input.
    for (const number of [1, 2, 3, 4, 5]) {
      const image = { mediaType: 'image', srcURL: `${home}slow.png?n=${number}` };
      await pickPageMenuItem(app, home, image, 'Save image as…');
      await expect(items).toHaveCount(number);
    }
    await pickPageMenuItem(
      app,
      home,
      { mediaType: 'image', srcURL: `${home}slow.png?n=6` },
      'Save image as…',
    );
    await expect(ui.getByText('Download blocked')).toBeVisible();
    await expect(items).toHaveCount(5);
    release();
    await expect(items.getByText('Done')).toHaveCount(5);
  } finally {
    await close();
  }
});

test('a scripted about:blank popup cannot open another popup without real input', async () => {
  const { ui, address, home, getState, pageAt, close } = await openFixtureSession();
  try {
    await address.fill(`${home}scripted`);
    await address.press('Enter');
    await expect.poll(async () => (await getState()).tabs[0]?.title).toBe('Fixture scripted');
    await pageAt(`${home}scripted`).getByRole('button', { name: 'Go' }).click();
    await expect.poll(async () => (await getState()).order.length).toBe(2);
    // The popup is now the active tab; its own window.open has no click or key behind it.
    await expect.poll(async () => (await getState()).tabs[1]?.blockedPopups).toBe(1);
    expect((await getState()).order).toHaveLength(2);
    expect(ui).toBeTruthy();
  } finally {
    await close();
  }
});

test('"Open link in new tab" on a download link downloads and keeps the tab', async () => {
  const { app, ui, home, release, close } = await openDownloadSession();
  try {
    await pickPageMenuItem(app, home, { linkURL: `${home}report.zip` }, 'Open link in new tab');
    const item = ui.getByRole('region', { name: 'Downloads' }).getByRole('listitem').first();
    await expect(item.getByRole('button', { name: /^Cancel/ })).toBeVisible();
    release();
    await expect(item).toContainText('Done');
    // The tab was asked for by the user, so it stays (unlike a download-only popup).
    await expect(ui.getByRole('list', { name: 'Open tabs' }).getByRole('listitem')).toHaveCount(3);
  } finally {
    await close();
  }
});

test('"Save link as" downloads a linked file without a click', async () => {
  const { app, ui, home, release, downloadsDir, close } = await openDownloadSession();
  try {
    await pickPageMenuItem(app, home, { linkURL: `${home}report.zip` }, 'Save link as…');
    const item = ui.getByRole('region', { name: 'Downloads' }).getByRole('listitem').first();
    await expect(item.getByRole('button', { name: /^Cancel/ })).toBeVisible();
    release();
    await expect(item).toContainText('Done');
    expect(readdirSync(downloadsDir)).toEqual(['report.zip']);
    // The allowance was for that one link and is spent.
    await app.evaluate(({ webContents }, url) => {
      webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)
        ?.downloadURL(`${url}report.zip`);
    }, home);
    await expect(ui.getByText('Download blocked')).toBeVisible();
  } finally {
    await close();
  }
});
