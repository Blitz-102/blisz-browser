import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import type { TabsState } from '../src/shared/tabs';

// Each launch gets a throwaway profile, so tests never touch (or depend on) the real one. A test
// that relaunches passes its own `userData`, which it then has to delete itself.
async function launch(
  extraEnv: Record<string, string> = {},
  ownedUserData?: string,
): Promise<ElectronApplication> {
  const userData = ownedUserData ?? mkdtempSync(join(tmpdir(), 'blisz-test-'));
  const app = await electron.launch({
    // Scale factor 1 so 1280x800 is exact; at 125% display scaling Windows rounds the height to 801.
    args: ['.', '--force-device-scale-factor=1'],
    // Blank forces the built blisz:// UI instead of a dev server URL from the environment.
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      BLISZ_USER_DATA: userData,
      BLISZ_DOWNLOAD_NO_PROMPT: '1', // the native Save as dialog can't be driven by a test
      ...extraEnv,
    },
  });
  if (!ownedUserData) {
    app.on('close', () => rmSync(userData, { recursive: true, force: true, maxRetries: 5 }));
  }
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
  '/arm': '<title>Fixture arm</title><button onclick="window.close()">Close me</button>',
  '/blank': `<title>Fixture blank</title><button onclick="window.open('about:blank')">Open blank</button>`,
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
async function openFixtureSession(env: Record<string, string> = {}) {
  const fixture = await startFixture();
  const { home } = fixture;
  const app = await launch(env).catch((error) => {
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

async function openDownloadSession(env: Record<string, string> = {}) {
  const fixture = await startDownloadFixture();
  const app = await launch(env).catch((error) => {
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

// Step 2f: permissions, external links, error cards and fullscreen.
const PROMPT_PAGES: Record<string, string> = {
  '/': `<title>Fixture prompts</title>
    <button id="cam" onclick="ask()">Camera</button>
    <button id="full" onclick="document.documentElement.requestFullscreen()">Fullscreen</button>
    <a href="mailto:test@example.com?subject=Hi">Mail</a> <a href="tel:+15551234567">Call</a>
    <a href="/next">Next</a>
    <iframe src="/frame" title="frame"></iframe>
    <script>
      let count = 0;
      function ask() {
        const n = ++count;
        navigator.mediaDevices.getUserMedia({ video: true }).then(
          () => { document.title = 'cam:allowed:' + n; },
          (error) => { document.title = 'cam:' + error.name + ':' + n; },
        );
      }
    </script>`,
  '/next': '<title>Fixture next</title><p>Next</p>',
  '/frame': `<a href="mailto:frame@example.com"
    onclick="setTimeout(() => { parent.document.title = 'frame clicked' }, 50)">Frame mail</a>`,
  '/auto': `<title>Fixture auto</title><script>setTimeout(() => {
    location.href = 'mailto:auto@example.com';
    document.title = 'Fixture auto done';
  }, 100)</script>`,
};

// Allow and Block ignore clicks for half a second after a prompt shows, so click until it closes.
async function answerPrompt(prompt: Locator, name: RegExp) {
  await expect(async () => {
    if ((await prompt.count()) === 0) return;
    await prompt.getByRole('button', { name }).click({ timeout: 1000 });
    await expect(prompt).toHaveCount(0, { timeout: 300 });
  }).toPass();
}

// Clicks a link (in the page or one of its frames) by its text. Main blocks these navigations, and
// Playwright's own click would wait for them to finish.
async function clickBlockedLink(view: Page, text: string) {
  for (const frame of view.frames()) {
    // The test tsconfig has no DOM types, so the page code is a string.
    const center = await frame.evaluate<{ x: number; y: number } | null>(`(() => {
      const link = [...document.querySelectorAll('a')].find((a) => a.textContent === ${JSON.stringify(text)});
      if (!link) return null;
      const box = link.getBoundingClientRect();
      const offset = window.frameElement?.getBoundingClientRect(); // same-origin fixture frames
      return { x: box.x + box.width / 2 + (offset?.x ?? 0), y: box.y + box.height / 2 + (offset?.y ?? 0) };
    })()`);
    if (center) {
      await view.mouse.click(center.x, center.y);
      return;
    }
  }
  throw new Error(`Link not found: ${text}`);
}

async function openPromptSession() {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(PROMPT_PAGES[request.url ?? '/'] ?? PROMPT_PAGES['/']);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const app = await launch().catch((error) => {
    server.close();
    throw error;
  });
  const close = async () => {
    await app.close();
    server.closeAllConnections();
    server.close();
  };
  try {
    const ui = await findUi(app);
    const pageAt = (url: string) => {
      const view = app.windows().find((window) => window.url() === url);
      if (!view) throw new Error(`Page view not found at ${url}`);
      return view;
    };
    const address = ui.getByRole('textbox', { name: 'Address' });
    await address.fill(home);
    await address.press('Enter');
    await expect(ui.locator('[aria-current="page"]')).toContainText('Fixture prompts');
    return { app, ui, home, pageAt, address, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test('a camera request asks, Block is remembered, and a new page cancels a pending prompt', async () => {
  const { app, ui, home, pageAt, close } = await openPromptSession();
  try {
    const prompt = ui.getByRole('region', { name: 'Permission request' });
    await expect(prompt).toHaveCount(0);

    // The UI view's own session still denies everything.
    expect(
      await ui.evaluate(
        "navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'allowed', (e) => e.name)",
      ),
    ).toBe('NotAllowedError');

    await pageAt(home).getByRole('button', { name: 'Camera' }).click();
    await expect(prompt).toContainText(`${home.slice(0, -1)} wants to use your camera`);
    // The prompt does not take the keyboard focus from the page.
    expect(
      await app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((c) => c.getURL().startsWith('blisz://'))
          ?.isFocused(),
      ),
    ).toBe(false);
    await answerPrompt(prompt, /^Block /);
    await expect.poll(() => pageAt(home).evaluate('document.title')).toBe('cam:NotAllowedError:1');
    await expect(prompt).toHaveCount(0);

    // Block was remembered: the second request fails without a prompt.
    await pageAt(home).getByRole('button', { name: 'Camera' }).click();
    await expect.poll(() => pageAt(home).evaluate('document.title')).toBe('cam:NotAllowedError:2');
    await expect(prompt).toHaveCount(0);

    // A question waits for an answer, and a new page drops it.
    await pageAt(home).evaluate('navigator.geolocation.getCurrentPosition(() => {}, () => {})');
    await expect(prompt).toContainText('wants to know your location');
    await expect(prompt.getByRole('button', { name: /^Allow / })).toBeVisible();
    await pageAt(home).getByRole('link', { name: 'Next' }).click();
    await expect(prompt).toHaveCount(0);
  } finally {
    await close();
  }
});

test('mailto: and tel: links ask first, open only on Allow, and are blocked without a click or from a frame', async () => {
  const { app, ui, home, pageAt, address, close } = await openPromptSession();
  try {
    await app.evaluate(({ shell }) => {
      const calls: string[] = [];
      (globalThis as unknown as { externalCalls: string[] }).externalCalls = calls;
      shell.openExternal = async (url) => {
        calls.push(url);
      };
    });
    const externalCalls = () =>
      app.evaluate(() => (globalThis as unknown as { externalCalls: string[] }).externalCalls);
    const prompt = ui.getByRole('region', { name: 'Permission request' });

    await clickBlockedLink(pageAt(home), 'Mail');
    await expect(prompt).toContainText('wants to open your mail app: test@example.com');
    expect(await externalCalls()).toEqual([]);
    await answerPrompt(prompt, /^Allow /);
    await expect.poll(externalCalls).toEqual(['mailto:test@example.com?subject=Hi']);
    await expect(prompt).toHaveCount(0);
    await expect(address).toHaveValue(home); // the tab stayed on the page

    await clickBlockedLink(pageAt(home), 'Call');
    await expect(prompt).toContainText('wants to open your phone app: +15551234567');
    await answerPrompt(prompt, /^Block /);

    // A link inside a frame never asks; the frame page reports the click, so nothing is waited for blindly.
    await clickBlockedLink(pageAt(home), 'Frame mail');
    await expect.poll(() => pageAt(home).evaluate('document.title')).toBe('frame clicked');
    await expect(prompt).toHaveCount(0);
    expect(await externalCalls()).toEqual(['mailto:test@example.com?subject=Hi']);

    // A script navigating to mailto: without any click never asks.
    await address.fill(`${home}auto`);
    await address.press('Enter');
    await expect(ui.locator('[aria-current="page"]')).toContainText('Fixture auto');
    await expect
      .poll(() => pageAt(`${home}auto`).evaluate('document.title'))
      .toBe('Fixture auto done');
    await expect(prompt).toHaveCount(0);
    expect(await externalCalls()).toEqual(['mailto:test@example.com?subject=Hi']);
  } finally {
    await close();
  }
});

test('a page that cannot be reached shows an error card, and Try again works once it is back', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Fixture back</title><p>Back</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/`;
  const app = await launch();
  try {
    const ui = await findUi(app);
    const address = ui.getByRole('textbox', { name: 'Address' });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await address.fill(url);
    await address.press('Enter');
    const card = ui.getByRole('region', { name: "Can't reach this page" });
    await expect(card).toBeVisible();
    await expect(card).toContainText('ERR_CONNECTION_REFUSED');
    await expect(card).toContainText(url);

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    await card.getByRole('button', { name: 'Try again' }).click();
    await expect(ui.locator('[aria-current="page"]')).toContainText('Fixture back');
    await expect(card).toHaveCount(0);
  } finally {
    await app.close();
    server.closeAllConnections();
    server.close();
  }
});

test('a crashed tab shows a crashed card, and Try again recovers it', async () => {
  const { app, ui, home, close } = await openPromptSession();
  try {
    await app.evaluate(({ webContents }, url) => {
      webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)
        ?.forcefullyCrashRenderer();
    }, home);
    const card = ui.getByRole('region', { name: 'This tab crashed' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Try again' }).click();
    await expect(card).toHaveCount(0);
    await expect(ui.locator('[aria-current="page"]')).toContainText('Fixture prompts');
  } finally {
    await close();
  }
});

async function windowState(app: ElectronApplication, url: string) {
  return app.evaluate(({ BaseWindow }, url) => {
    const window = BaseWindow.getAllWindows()[0];
    if (!window) throw new Error('No window');
    const view = window.contentView.children.find((child) =>
      (child as unknown as { webContents?: Electron.WebContents }).webContents
        ?.getURL()
        .startsWith(url),
    );
    return {
      fullScreen: window.isFullScreen(),
      content: window.getContentBounds(),
      view: view?.getBounds() ?? null,
    };
  }, url);
}

test('HTML fullscreen fills the window; Esc, a tab switch and F11 put things back', async () => {
  const { app, ui, home, pageAt, close } = await openPromptSession();
  try {
    const before = await windowState(app, home);
    expect(before.fullScreen).toBe(false);
    expect(before.view).not.toBeNull();

    // Esc leaves HTML fullscreen.
    await pageAt(home).getByRole('button', { name: 'Fullscreen' }).click();
    await expect.poll(async () => (await windowState(app, home)).fullScreen).toBe(true);
    // For a few seconds the top strip is free and the UI names the site and the way out.
    const notice = ui.getByRole('status').filter({ hasText: 'is full screen' });
    await expect(notice).toContainText(
      `${home.slice(0, -1)} is full screen — press Esc or F11 to exit`,
    );
    const inNotice = await windowState(app, home);
    expect(inNotice.view).toEqual({
      x: 0,
      y: 40,
      width: inNotice.content.width,
      height: inNotice.content.height - 40,
    });
    await expect(notice).toHaveCount(0, { timeout: 8000 });
    await expect
      .poll(async () => (await windowState(app, home)).view)
      .toEqual({ x: 0, y: 0, width: inNotice.content.width, height: inNotice.content.height });
    await pressKey(app, home, 'Escape');
    await expect.poll(async () => (await windowState(app, home)).fullScreen).toBe(false);
    await expect.poll(async () => (await windowState(app, home)).view).toEqual(before.view);

    // A new tab leaves it too.
    await pageAt(home).getByRole('button', { name: 'Fullscreen' }).click();
    await expect.poll(async () => (await windowState(app, home)).fullScreen).toBe(true);
    await pressKey(app, home, 'T', ['control']);
    await expect.poll(async () => (await windowState(app, home)).fullScreen).toBe(false);
    await pressKey(app, 'blisz://', '1', ['control']);
    await expect.poll(async () => (await windowState(app, home)).view).toEqual(before.view);
    expect(await pageAt(home).evaluate('document.fullscreenElement === null')).toBe(true);

    // Closing the tab leaves it too.
    await pageAt(home).getByRole('button', { name: 'Fullscreen' }).click();
    await expect.poll(async () => (await windowState(app, home)).fullScreen).toBe(true);
    await pressKey(app, home, 'W', ['control']);
    await expect.poll(async () => (await windowState(app, home)).fullScreen).toBe(false);
    await expect(ui.getByRole('navigation', { name: 'Tabs' })).toBeVisible();

    // F11 toggles the window itself.
    await pressKey(app, 'blisz://', 'F11');
    await expect.poll(async () => (await windowState(app, home)).fullScreen).toBe(true);
    await pressKey(app, 'blisz://', 'F11');
    await expect.poll(async () => (await windowState(app, home)).fullScreen).toBe(false);
    await expect(ui.getByRole('navigation', { name: 'Tabs' })).toBeVisible();
  } finally {
    await close();
  }
});

test('--bench opens the configured sites, prints the totals and removes its temp profile', async () => {
  test.setTimeout(60_000);
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Fixture bench</title><p>Bench</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // A private TEMP folder shows whether the bench's own temp profile was deleted at exit.
  const temp = mkdtempSync(join(tmpdir(), 'blisz-bench-test-'));
  const configPath = join(temp, 'sites.json');
  const sites = ['a', 'b'].map((name) => ({ name, url: `http://127.0.0.1:${port}/${name}` }));
  writeFileSync(configPath, JSON.stringify({ settleSeconds: 2, sites }));
  const profileParent = join(temp, 'tmp');
  mkdirSync(profileParent);
  try {
    // Plain spawn, not Playwright: the bench must run and exit on its own, with a visible exit code.
    const electronPath = require('electron') as unknown as string;
    const child = spawn(electronPath, ['.', '--bench'], {
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        BLISZ_BENCH_CONFIG: configPath,
        TEMP: profileParent,
        TMP: profileParent,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exitCode = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    expect(exitCode, output).toBe(0);
    expect(output).toMatch(/Total private: [\d.]+ MB, working set: [\d.]+ MB/);
    expect(output).toContain('Tabs finished loading:');
    // Windows runs the PowerShell part; other platforms print a note instead.
    expect(output).toMatch(/Total private working set: [\d.]+ MB|Private working set skipped/);
    // A detached process deletes the profile just after the app exits.
    await expect.poll(() => readdirSync(profileParent), { timeout: 15_000 }).toEqual([]);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
});

// Pops the tab menu for `id` without a real right-click and returns whether "Sleep tab" was enabled.
// With `choose` it also picks the item, as a click would.
async function tabMenuSleep(
  app: ElectronApplication,
  ui: Page,
  id: number,
  choose = false,
): Promise<boolean | undefined> {
  await app.evaluate(({ Menu }, choose) => {
    const store = globalThis as { sleepEnabled?: boolean };
    store.sleepEnabled = undefined;
    Menu.prototype.popup = function () {
      const item = this.items.find((entry) => entry.label === 'Sleep tab');
      store.sleepEnabled = item?.enabled;
      if (choose && item?.enabled) item.click();
    };
  }, choose);
  await ui.evaluate(`window.bliss.tabContextMenu(${id})`);
  return app.evaluate(() => (globalThis as { sleepEnabled?: boolean }).sleepEnabled);
}

// The fixture site plus a second site (localhost is not 127.0.0.1, so it gets its own renderer) with
// a background tab that went through "text" and then "links". The first tab stays active.
async function openSleepSession(env: Record<string, string> = {}) {
  const session = await openFixtureSession(env);
  const { ui, home, openerId, getState } = session;
  const site = home.replace('127.0.0.1', 'localhost');
  const tabId = await ui.evaluate<number>('window.bliss.createTab()');
  const findTab = async () => (await getState()).tabs.find((tab) => tab.id === tabId);
  for (const [path, title] of [
    ['text', 'Fixture text'],
    ['links', 'Fixture links'],
  ]) {
    await ui.evaluate(`window.bliss.navigateTab(${tabId}, '${site}${path}')`);
    await expect.poll(async () => (await findTab())?.title).toBe(title);
  }
  await ui.evaluate(`window.bliss.activateTab(${openerId})`);
  return { ...session, site, tabId, findTab };
}

test('a background tab sleeps without its renderer and wakes with its history', async () => {
  const { app, ui, site, tabId, openerId, findTab, getState, pageAt, close } =
    await openSleepSession();
  try {
    // The active tab can't sleep.
    await ui.evaluate(`window.bliss.activateTab(${tabId})`);
    expect(await tabMenuSleep(app, ui, tabId)).toBe(false);
    await ui.evaluate(`window.bliss.activateTab(${openerId})`);
    expect(await tabMenuSleep(app, ui, tabId)).toBe(true);

    const pid = await app.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url)
          ?.getOSProcessId(),
      `${site}links`,
    );
    expect(pid).toBeGreaterThan(0);
    await tabMenuSleep(app, ui, tabId, true);
    await expect.poll(async () => (await findTab())?.sleeping).toBe(true);
    await expect
      .poll(() => app.evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.pid)))
      .not.toContain(pid);
    expect(await findTab()).toMatchObject({
      url: `${site}links`,
      title: 'Fixture links',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
    });
    const sleepingRow = ui.getByRole('button', { name: 'Fixture links', description: 'Sleeping' });
    await expect(sleepingRow).toBeVisible();
    expect(await tabMenuSleep(app, ui, tabId)).toBe(false); // already asleep

    // Clicking the tab wakes it: same page, same history, same user agent token.
    await sleepingRow.click();
    await expect.poll(async () => (await findTab())?.sleeping).toBe(false);
    await expect.poll(async () => (await getState()).activeId).toBe(tabId);
    await expect.poll(async () => (await findTab())?.isLoading).toBe(false);
    expect(await findTab()).toMatchObject({
      url: `${site}links`,
      title: 'Fixture links',
      canGoBack: true,
    });
    await expect
      .poll(async () => pageAt(`${site}links`).evaluate('navigator.userAgent'))
      .toContain('Blisz/');
    await expect(ui.getByRole('textbox', { name: 'Address' })).not.toBeFocused();

    await ui.evaluate(`window.bliss.tabGo(${tabId}, 'back')`);
    await expect.poll(async () => (await findTab())?.url).toBe(`${site}text`);
  } finally {
    await close();
  }
});

test('a sleeping tab can be duplicated and closed', async () => {
  const { app, ui, site, tabId, openerId, findTab, getState, close } = await openSleepSession();
  try {
    await tabMenuSleep(app, ui, tabId, true);
    await expect.poll(async () => (await findTab())?.sleeping).toBe(true);

    // The copy opens the saved page; the source stays asleep.
    const copyId = await ui.evaluate<number>(`window.bliss.duplicateTab(${tabId})`);
    await expect
      .poll(async () => (await getState()).tabs.find((tab) => tab.id === copyId)?.url)
      .toBe(`${site}links`);
    expect((await findTab())?.sleeping).toBe(true);

    // Closing a sleeping tab removes it.
    await ui.evaluate(`window.bliss.activateTab(${openerId})`);
    await ui.evaluate(`window.bliss.closeTab(${tabId})`);
    await expect.poll(async () => (await getState()).order).not.toContain(tabId);
    expect((await getState()).activeId).toBe(openerId);
  } finally {
    await close();
  }
});

test('a restore that is stuck can be slept again or stopped, and Reload restarts it', async () => {
  let slowRequests = 0;
  let release = false;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Cache-Control', 'no-store'); // a restore would otherwise come from the cache
    if (request.url === '/slow') {
      slowRequests++;
      // The first load answers; the restore after sleeping hangs until released.
      if (slowRequests > 1 && !release) return;
      response.end('<title>Fixture slow</title><p>Slow</p>');
    } else {
      response.end('<title>Fixture first</title><p>First</p>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = await launch();
  try {
    const ui = await findUi(app);
    const getState = () => ui.evaluate<TabsState>('window.bliss.getTabsState()');
    const [firstId = 0] = (await getState()).order;
    const tabId = await ui.evaluate<number>('window.bliss.createTab()');
    const findTab = async () => (await getState()).tabs.find((tab) => tab.id === tabId);
    for (const [path, title] of [
      ['/', 'Fixture first'],
      ['/slow', 'Fixture slow'],
    ]) {
      await ui.evaluate(`window.bliss.navigateTab(${tabId}, '${base}${path}')`);
      await expect.poll(async () => (await findTab())?.title).toBe(title);
    }
    await ui.evaluate(`window.bliss.activateTab(${firstId})`);
    await tabMenuSleep(app, ui, tabId, true);
    await expect.poll(async () => (await findTab())?.sleeping).toBe(true);

    await ui.evaluate(`window.bliss.activateTab(${tabId})`);
    await expect.poll(() => slowRequests).toBe(2);
    expect(await findTab()).toMatchObject({
      url: `${base}/slow`,
      title: 'Fixture slow',
      sleeping: false,
      canGoBack: false,
    });

    // Sleeping while the restore is stuck keeps the page and history.
    await ui.evaluate(`window.bliss.activateTab(${firstId})`);
    await tabMenuSleep(app, ui, tabId, true);
    await expect.poll(async () => (await findTab())?.sleeping).toBe(true);
    expect(await findTab()).toMatchObject({ url: `${base}/slow`, canGoBack: true });
    await ui.evaluate(`window.bliss.activateTab(${tabId})`);
    await expect.poll(() => slowRequests).toBe(3);

    await ui.evaluate(`window.bliss.tabGo(${tabId}, 'stop')`);
    await expect.poll(async () => (await findTab())?.isLoading).toBe(false);
    expect(slowRequests).toBe(3); // a stop is not answered by a second load
    expect((await findTab())?.url).toBe(`${base}/slow`);

    release = true;
    await ui.evaluate(`window.bliss.tabGo(${tabId}, 'reload')`);
    await expect.poll(async () => (await findTab())?.isLoading).toBe(false);
    await expect.poll(async () => (await findTab())?.canGoBack).toBe(true);
    expect(await findTab()).toMatchObject({ url: `${base}/slow`, title: 'Fixture slow' });
  } finally {
    await app.close();
    server.closeAllConnections();
    server.close();
  }
});

test('a woken page can still close its own tab', async () => {
  const { app, ui, site, tabId, openerId, findTab, getState, pageAt, close } =
    await openSleepSession();
  try {
    await ui.evaluate(`window.bliss.navigateTab(${tabId}, '${site}arm')`);
    await expect.poll(async () => (await findTab())?.title).toBe('Fixture arm');
    await ui.evaluate(`window.bliss.activateTab(${openerId})`);
    await tabMenuSleep(app, ui, tabId, true);
    await expect.poll(async () => (await findTab())?.sleeping).toBe(true);

    await ui.evaluate(`window.bliss.activateTab(${tabId})`);
    await expect.poll(async () => (await findTab())?.sleeping).toBe(false);
    await expect.poll(async () => (await findTab())?.title).toBe('Fixture arm');
    await expect
      .poll(() => app.windows().some((window) => window.url() === `${site}arm`))
      .toBe(true);
    await pageAt(`${site}arm`).getByRole('button', { name: 'Close me' }).click();
    await expect.poll(async () => (await getState()).order).not.toContain(tabId);
    expect((await getState()).activeId).toBe(openerId);
  } finally {
    await close();
  }
});

test('an about:blank popup cannot be put to sleep', async () => {
  const { app, ui, home, openerId, getState, pageAt, close } = await openFixtureSession();
  try {
    await ui.evaluate(`window.bliss.navigateTab(${openerId}, '${home}blank')`);
    await expect.poll(async () => (await getState()).tabs[0]?.title).toBe('Fixture blank');
    await pageAt(`${home}blank`).getByRole('button', { name: 'Open blank' }).click();
    await expect.poll(async () => (await getState()).order.length).toBe(2);
    const popupId = (await getState()).order[1] ?? 0;
    await ui.evaluate(`window.bliss.activateTab(${openerId})`);
    expect(await tabMenuSleep(app, ui, popupId)).toBe(false);
    expect(await tabMenuSleep(app, ui, openerId ?? 0)).toBe(false); // the active tab
  } finally {
    await close();
  }
});

test('a restore that fails shows the error card, and Try again works once the site is back', async () => {
  const handler = (_request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Cache-Control', 'no-store');
    response.end('<title>Fixture back</title><p>Back</p>');
  };
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/`;
  const app = await launch();
  try {
    const ui = await findUi(app);
    const getState = () => ui.evaluate<TabsState>('window.bliss.getTabsState()');
    const [firstId = 0] = (await getState()).order;
    const tabId = await ui.evaluate<number>('window.bliss.createTab()');
    const findTab = async () => (await getState()).tabs.find((tab) => tab.id === tabId);
    await ui.evaluate(`window.bliss.navigateTab(${tabId}, '${url}')`);
    await expect.poll(async () => (await findTab())?.title).toBe('Fixture back');
    await ui.evaluate(`window.bliss.activateTab(${firstId})`);
    await tabMenuSleep(app, ui, tabId, true);
    await expect.poll(async () => (await findTab())?.sleeping).toBe(true);

    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ui.evaluate(`window.bliss.activateTab(${tabId})`);
    const card = ui.getByRole('region', { name: "Can't reach this page" });
    await expect(card).toBeVisible();
    expect((await findTab())?.sleeping).toBe(false);

    const revived = createServer(handler);
    await new Promise<void>((resolve) => revived.listen(port, '127.0.0.1', resolve));
    try {
      await card.getByRole('button', { name: 'Try again' }).click();
      await expect.poll(async () => (await findTab())?.title).toBe('Fixture back');
      await expect(card).toHaveCount(0);
    } finally {
      revived.closeAllConnections();
      revived.close();
    }
  } finally {
    await app.close();
  }
});

test('a tab with an open popup cannot be put to sleep', async () => {
  const { app, ui, home, openerId, getState, pageAt, close } = await openFixtureSession();
  try {
    await pageAt(home).getByRole('link', { name: 'Open popup' }).click();
    await expect.poll(async () => (await getState()).order.length).toBe(2);
    const popupId = (await getState()).order[1] ?? 0;
    await ui.evaluate(`window.bliss.activateTab(${popupId})`);
    expect(await tabMenuSleep(app, ui, openerId ?? 0)).toBe(false); // window.opener would break

    await ui.evaluate(`window.bliss.closeTab(${popupId})`);
    const otherId = await ui.evaluate<number>('window.bliss.createTab()');
    expect(otherId).toBeGreaterThan(0);
    expect(await tabMenuSleep(app, ui, openerId ?? 0)).toBe(true);
  } finally {
    await close();
  }
});

// BLISZ_SLEEP_AFTER_MS is set only in the auto-sleep tests, so the sweep never touches the others.
const SLEEP_AFTER_MS = '3000';
const SLOW_SLEEP_AFTER_MS = '8000'; // setup must finish well inside this
const SLEEP_WAIT = { timeout: 20_000 };

test('an idle background tab falls asleep on its own and the active tab stays awake', async () => {
  const { app, openerId, findTab, getState, close } = await openSleepSession({
    BLISZ_SLEEP_AFTER_MS: SLOW_SLEEP_AFTER_MS,
  });
  try {
    const pid = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .find((contents) => contents.getTitle() === 'Fixture links')
        ?.getOSProcessId(),
    );
    expect(pid).toBeDefined();
    expect(pid).toBeGreaterThan(0);
    await expect.poll(async () => (await findTab())?.sleeping, SLEEP_WAIT).toBe(true);
    await expect
      .poll(
        () => app.evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.pid)),
        SLEEP_WAIT,
      )
      .not.toContain(pid);
    const opener = (await getState()).tabs.find((tab) => tab.id === openerId);
    expect(opener?.sleeping).toBe(false);
    expect((await getState()).activeId).toBe(openerId);
  } finally {
    await close();
  }
});

test('a background tab with a running download stays awake, then sleeps once it is done', async () => {
  const { ui, home, release, pageAt, close } = await openDownloadSession({
    BLISZ_SLEEP_AFTER_MS: SLEEP_AFTER_MS,
  });
  try {
    const getState = () => ui.evaluate<TabsState>('window.bliss.getTabsState()');
    const downloadTabId = (await getState()).activeId;
    await pageAt(home).getByRole('link', { name: 'Report', exact: true }).click();
    await expect(ui.getByRole('region', { name: 'Downloads' }).getByRole('listitem')).toHaveCount(
      1,
    );

    // The download itself must be what keeps the tab awake, not a page still loading.
    await expect
      .poll(
        async () =>
          (await getState()).tabs.find((tab) => tab.id === downloadTabId)?.isLoading === false,
      )
      .toBe(true);

    // An idle second tab shows the sweep is running; then a third tab takes the foreground.
    const idleId = await ui.evaluate<number>('window.bliss.createTab()');
    await ui.evaluate(`window.bliss.navigateTab(${idleId}, '${home}pic.png')`);
    await expect
      .poll(
        async () => (await getState()).tabs.find((tab) => tab.id === idleId)?.isLoading === false,
      )
      .toBe(true);
    await ui.evaluate('window.bliss.createTab()');
    const isAsleep = async (id: number) =>
      (await getState()).tabs.find((tab) => tab.id === id)?.sleeping;
    await expect.poll(() => isAsleep(idleId), SLEEP_WAIT).toBe(true);
    expect(await isAsleep(downloadTabId)).toBe(false);

    release();
    await expect(ui.getByRole('region', { name: 'Downloads' })).toContainText('Done');
    await expect.poll(() => isAsleep(downloadTabId), SLEEP_WAIT).toBe(true);
  } finally {
    await close();
  }
});

// Pages for the sleep tests that need their own server: a form that POSTs, a page whose
// beforeunload handler vetoes leaving (unsaved changes), and a plain page.
async function startSleepFixture() {
  let posts = 0;
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'POST') {
      posts++;
      request.resume();
      response.end('<title>Posted</title>Thanks');
    } else if (path === '/form') {
      response.end(
        '<title>Form</title><form method="post" action="/submit"><button>Send</button></form>',
      );
    } else if (path === '/slowleave') {
      // Leaving takes a long time, then the page agrees.
      response.end(
        "<title>Slow leave</title><script>addEventListener('beforeunload', () => { const end = Date.now() + 7000; while (Date.now() < end); })</script>",
      );
    } else if (path === '/unsaved') {
      response.end(
        "<title>Unsaved</title><script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'x'; })</script>",
      );
    } else {
      response.end('<title>Plain</title>Plain page');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    home: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    posts: () => posts,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test('a tab whose page vetoes leaving (unsaved changes) stays awake while a plain tab sleeps', async () => {
  const fixture = await startSleepFixture();
  const app = await launch({ BLISZ_SLEEP_AFTER_MS: SLEEP_AFTER_MS });
  try {
    const ui = await findUi(app);
    const getState = () => ui.evaluate<TabsState>('window.bliss.getTabsState()');
    const guardId = (await getState()).activeId;
    await ui.evaluate(`window.bliss.navigateTab(${guardId}, '${fixture.home}unsaved')`);
    await expect.poll(async () => (await getState()).tabs[0]?.title).toBe('Unsaved');
    // No click is needed: Electron counts closing as user activation, so the handler is honoured.
    const plainId = await ui.evaluate<number>('window.bliss.createTab()');
    await ui.evaluate(`window.bliss.navigateTab(${plainId}, '${fixture.home}plain')`);
    await expect
      .poll(async () => (await getState()).tabs.map((tab) => tab.title))
      .toEqual(['Unsaved', 'Plain']);
    const activeId = await ui.evaluate<number>('window.bliss.createTab()');
    const sleeping = async (id: number) =>
      (await getState()).tabs.find((tab) => tab.id === id)?.sleeping;

    await expect.poll(() => sleeping(plainId), SLEEP_WAIT).toBe(true);
    // Several more sweeps: the guarded tab is asked each time and keeps saying no.
    await ui.waitForTimeout(5000);
    expect(await sleeping(guardId)).toBe(false);
    expect((await getState()).tabs.find((tab) => tab.id === guardId)?.title).toBe('Unsaved');
    expect((await getState()).activeId).toBe(activeId);
  } finally {
    await app.close();
    fixture.stop();
  }
});

test('a page that is slow to answer beforeunload still goes to sleep, not closed', async () => {
  const fixture = await startSleepFixture();
  const app = await launch({ BLISZ_SLEEP_AFTER_MS: SLEEP_AFTER_MS });
  try {
    const ui = await findUi(app);
    const getState = () => ui.evaluate<TabsState>('window.bliss.getTabsState()');
    const slowId = (await getState()).activeId;
    await ui.evaluate(`window.bliss.navigateTab(${slowId}, '${fixture.home}slowleave')`);
    await expect.poll(async () => (await getState()).tabs[0]?.title).toBe('Slow leave');
    await ui.evaluate('window.bliss.createTab()');
    const findTab = async () => (await getState()).tabs.find((tab) => tab.id === slowId);
    // The slow answer must finish the sleep, not close the tab like a page's window.close().
    await expect.poll(async () => (await findTab())?.sleeping, { timeout: 30_000 }).toBe(true);
    expect((await getState()).order).toContain(slowId);
  } finally {
    await app.close();
    fixture.stop();
  }
});

test('a tab that came from a form POST wakes without sending the POST again', async () => {
  const fixture = await startSleepFixture();
  const app = await launch({ BLISZ_SLEEP_AFTER_MS: SLEEP_AFTER_MS });
  try {
    const ui = await findUi(app);
    const getState = () => ui.evaluate<TabsState>('window.bliss.getTabsState()');
    const tabId = (await getState()).activeId;
    const findTab = async () => (await getState()).tabs.find((tab) => tab.id === tabId);
    await ui.evaluate(`window.bliss.navigateTab(${tabId}, '${fixture.home}form')`);
    await expect.poll(async () => (await findTab())?.title).toBe('Form');
    await app
      .windows()
      .find((window) => window.url() === `${fixture.home}form`)
      ?.getByRole('button', { name: 'Send' })
      .click();
    await expect.poll(async () => (await findTab())?.title).toBe('Posted');
    expect(fixture.posts()).toBe(1);

    await ui.evaluate('window.bliss.createTab()');
    await expect.poll(async () => (await findTab())?.sleeping, SLEEP_WAIT).toBe(true);
    await ui.evaluate(`window.bliss.activateTab(${tabId})`);
    await expect.poll(async () => (await findTab())?.sleeping).toBe(false);
    await expect.poll(async () => (await findTab())?.isLoading).toBe(false);
    await ui.waitForTimeout(1000);
    expect(fixture.posts()).toBe(1);
  } finally {
    await app.close();
    fixture.stop();
  }
});

// A fixture site whose pages are titled "Fixture <path>", counting requests per path so a test can
// tell whether a restored tab loaded its page.
async function startCountingServer() {
  const hits = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Cache-Control', 'no-store'); // a restored page may otherwise come from the cache
    response.end(`<title>Fixture ${path.slice(1)}</title><p>${path}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { base, hits, close };
}

// Resolves once the process has exited: close() can return while Chromium still holds the profile.
async function stopApp(app: ElectronApplication, kill = false): Promise<void> {
  const child = app.process();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (kill) child.kill();
  else await app.close();
  if (child.exitCode === null && child.signalCode === null) await exited;
}

// Best effort, like launch(): on Windows Chromium's helpers can keep the profile locked until the
// test worker exits, and a leftover temp folder must not fail a test.
function removeProfile(profile: string): void {
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  } catch {}
}

const tabsOf = (ui: Page) => ui.evaluate<TabsState>('window.bliss.getTabsState()');

test('session restore: tabs come back in order, only the active one awake, history intact', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'blisz-restore-'));
  const site = await startCountingServer();
  let app: ElectronApplication | undefined;
  try {
    app = await launch({}, profile);
    let ui = await findUi(app);
    const firstId = (await tabsOf(ui)).activeId;
    const secondId = await ui.evaluate<number>('window.bliss.createTab()');
    await ui.evaluate<number>('window.bliss.createTab()'); // stays blank, so it is not saved
    const titleOf = async (id: number) => (await tabsOf(ui)).tabs.find((t) => t.id === id)?.title;
    for (const [id, path] of [
      [firstId, 'a'],
      [firstId, 'b'],
      [secondId, 'c'],
    ] as const) {
      await ui.evaluate(`window.bliss.navigateTab(${id}, '${site.base}/${path}')`);
      await expect.poll(() => titleOf(id)).toBe(`Fixture ${path}`);
    }
    await ui.evaluate(`window.bliss.activateTab(${firstId})`);
    await stopApp(app); // closing the window saves the session

    const cHitsBefore = site.hits.get('/c');
    app = await launch({}, profile);
    ui = await findUi(app);
    await expect.poll(async () => (await tabsOf(ui)).tabs.length).toBe(2);
    const state = await tabsOf(ui);
    expect(state.tabs.map((tab) => tab.title)).toEqual(['Fixture b', 'Fixture c']);
    expect(state.activeId).toBe(state.order[0]);
    expect(state.tabs.map((tab) => tab.sleeping)).toEqual([false, true]);
    const [first, second] = state.tabs;
    // Only the UI and the one awake page exist.
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(2);
    expect(site.hits.get('/c')).toBe(cHitsBefore);

    // Once the first tab has committed its page, Back reaches the earlier entry.
    await expect
      .poll(async () => (await tabsOf(ui)).tabs.find((t) => t.id === first?.id)?.canGoBack)
      .toBe(true);
    await ui.evaluate(`window.bliss.tabGo(${first?.id}, 'back')`);
    await expect
      .poll(async () => (await tabsOf(ui)).tabs.find((t) => t.id === first?.id)?.url)
      .toBe(`${site.base}/a`);

    // Activating the sleeping tab loads it for the first time.
    await ui.evaluate(`window.bliss.activateTab(${second?.id})`);
    await expect.poll(() => site.hits.get('/c')).toBe((cHitsBefore ?? 0) + 1);
    await stopApp(app);
  } finally {
    // Only matters when an assertion failed first; a closed app can't be asked for its process.
    if (app) await stopApp(app, true).catch(() => {});
    site.close();
    removeProfile(profile);
  }
});

test('session restore: a killed process restores the last throttled save', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'blisz-restore-'));
  const site = await startCountingServer();
  let app: ElectronApplication | undefined;
  try {
    app = await launch({}, profile);
    let ui = await findUi(app);
    const { activeId } = await tabsOf(ui);
    await ui.evaluate(`window.bliss.navigateTab(${activeId}, '${site.base}/a')`);

    // The save runs a couple of seconds after the change; read the file like another process would.
    const savedUrls = () => {
      try {
        const db = new DatabaseSync(join(profile, 'blisz.db'), { readOnly: true });
        try {
          const rows = db.prepare('SELECT entries FROM session_tab').all();
          return rows.map((row) => (JSON.parse(String(row.entries)) as { url: string }[])[0]?.url);
        } finally {
          db.close();
        }
      } catch {
        return []; // not created yet, or locked for a moment
      }
    };
    await expect.poll(savedUrls, { timeout: 15_000 }).toEqual([`${site.base}/a`]);

    await stopApp(app, true);

    app = await launch({}, profile);
    ui = await findUi(app);
    await expect
      .poll(async () => (await tabsOf(ui)).tabs.map((tab) => tab.title))
      .toEqual(['Fixture a']);
    await stopApp(app);
  } finally {
    // Only matters when an assertion failed first; a closed app can't be asked for its process.
    if (app) await stopApp(app, true).catch(() => {});
    site.close();
    removeProfile(profile);
  }
});

test('session restore: a tab whose page fails to load keeps its saved history', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'blisz-restore-'));
  const site = await startCountingServer();
  let app: ElectronApplication | undefined;
  try {
    app = await launch({}, profile);
    let ui = await findUi(app);
    const { activeId } = await tabsOf(ui);
    for (const path of ['a', 'b']) {
      await ui.evaluate(`window.bliss.navigateTab(${activeId}, '${site.base}/${path}')`);
      await expect.poll(async () => (await tabsOf(ui)).tabs[0]?.title).toBe(`Fixture ${path}`);
    }
    await stopApp(app);

    site.close(); // the restored page now fails to load
    app = await launch({}, profile);
    ui = await findUi(app);
    await expect.poll(async () => (await tabsOf(ui)).tabs[0]?.error?.kind).toBe('network');
    await stopApp(app); // closing the window saves the session again

    const db = new DatabaseSync(join(profile, 'blisz.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT entries FROM session_tab').all();
      expect(rows.map((row) => (JSON.parse(String(row.entries)) as unknown[]).length)).toEqual([2]);
    } finally {
      db.close();
    }
  } finally {
    // Only matters when an assertion failed first; a closed app can't be asked for its process.
    if (app) await stopApp(app, true).catch(() => {});
    site.close();
    removeProfile(profile);
  }
});
