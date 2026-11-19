import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  app,
  BaseWindow,
  Menu,
  net,
  protocol,
  session,
  type WebContents,
  WebContentsView,
} from 'electron';
import { isWebUrl } from '../shared/url';
import { runBench } from './bench';
import { openDatabase } from './database';
import { hasRunningDownload, initDownloads } from './downloads';
import { addTrustedUi, handleFromUi, UI_URL } from './ipc';
import { getMetrics } from './metrics';
import { denyAllPermissions, installPermissionHandlers } from './permissions';
import { readSession, writeSession } from './session';
import {
  askPrompt,
  getTabProcessLabels,
  handleShortcuts,
  initTabs,
  isFullscreen,
  isPageContents,
  mediaGranted,
  offerExternalLink,
  pageDecisions,
  pageUrl,
  restoreTabs,
} from './tabs';

// Native caption buttons via titleBarOverlay (PLAN 4.6); colours come from tokens.css.
// Fallbacks for --color-frame and --color-text, used only if reading them from the UI fails.
const FRAME_FALLBACK = '#e0ddd5';
const SYMBOL_COLOR = '#1f2a26';
// Keep in sync with --titlebar-height in tokens.css: the overlay height is fixed at creation.
const TITLE_BAR_HEIGHT = 40;
// Opaque colours only, as Chromium returns them: a translucent body must not make the window transparent.
const OPAQUE_RGB = /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/;
const READ_COLORS_TIMEOUT_MS = 2000;

// `npm run bench:memory` passes --bench. Never honoured in a packaged app, and only read before
// a `--` separator.
const args = process.argv.slice(1);
const benchMode =
  !app.isPackaged &&
  args.slice(0, args.includes('--') ? args.indexOf('--') : undefined).includes('--bench');

// Smoke tests and the benchmark use a throwaway profile so they never touch the real one.
// Ignored when packaged.
let throwawayProfile = !app.isPackaged ? process.env.BLISZ_USER_DATA : undefined;
if (benchMode && !throwawayProfile) {
  const benchProfile = mkdtempSync(join(tmpdir(), 'blisz-bench-'));
  throwawayProfile = benchProfile;
  // Chromium's helper processes (and this one) still hold the profile's files while we exit, so
  // a detached Node process deletes it once they have let go. The path is passed as an argument.
  process.on('exit', () => {
    spawn(
      process.execPath,
      [
        '-e',
        "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 50, retryDelay: 200 })",
        benchProfile,
      ],
      { detached: true, stdio: 'ignore', env: { ELECTRON_RUN_AS_NODE: '1' } },
    ).unref();
  });
}
if (throwawayProfile) {
  app.setPath('userData', throwawayProfile);
  // Test downloads land in the throwaway profile, not the real Downloads folder.
  const downloads = join(throwawayProfile, 'Downloads');
  mkdirSync(downloads, { recursive: true });
  app.setPath('downloads', downloads);
}
// Test-only: smoke tests can't drive the native "Save as" dialog, so they ask for downloads to
// be saved straight into the Downloads folder. Ignored when packaged.
const saveDownloadsWithoutPrompt = !app.isPackaged && process.env.BLISZ_DOWNLOAD_NO_PROMPT === '1';

// A debugging port lets malware (infostealers) read cookies and drive the UI over CDP. Unpackaged
// builds keep it because Playwright needs it.
if (
  app.isPackaged &&
  (app.commandLine.hasSwitch('remote-debugging-port') ||
    app.commandLine.hasSwitch('remote-debugging-pipe'))
) {
  app.exit(1);
}

Menu.setApplicationMenu(null);

// Must run before the app is ready: sandboxes every renderer, whatever its webPreferences say.
app.enableSandbox();

// Must run before ready. standard makes blisz://app a real origin (CSP 'self', URL.origin);
// secure makes it a secure context. Nothing else is needed for scripts, CSS and fonts.
protocol.registerSchemesAsPrivileged([
  { scheme: 'blisz', privileges: { standard: true, secure: true } },
]);

const RENDERER_DIR = join(__dirname, '../renderer');

// Serves the bundled UI from blisz://app/. Only the default session gets this handler: the UI
// view uses it, while Phase 2 page views use persist:main, so web pages can't load app files.
function serveUiFiles(request: Request): Promise<Response> | Response {
  const notFound = () => new Response('Not found', { status: 404 });
  try {
    const url = new URL(request.url);
    if (url.host !== 'app') return notFound();
    const path = decodeURIComponent(url.pathname);
    // Rejects Windows aliases such as index.html::$DATA, backslash tricks and NUL bytes.
    if (path.includes(':') || path.includes('\\') || path.includes('\0')) return notFound();
    const file = resolve(RENDERER_DIR, `.${path}`);
    const fromRoot = relative(RENDERER_DIR, file);
    if (
      fromRoot === '' ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      return notFound();
    }
    return net.fetch(pathToFileURL(file).toString()).then(addSecurityHeaders, notFound);
  } catch {
    return notFound(); // malformed URL or percent-encoding
  }
}

// The meta CSP in index.html is enforced as well; this header adds only frame-ancestors.
function addSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  return new Response(res.body, { status: res.status, headers });
}

// Page views may go to http(s) only; trusted UI views may not navigate at all.
function isNavigationAllowed(contents: Electron.WebContents, url: string): boolean {
  return isPageContents(contents) && isWebUrl(url);
}

// Subframes of page views: an allow-list that includes normal iframes (about:blank, srcdoc, data:, blob:).
const ALLOWED_FRAME_PROTOCOLS = new Set(['http:', 'https:', 'data:', 'blob:']);
const ALLOWED_FRAME_ABOUT_URLS = new Set(['about:blank', 'about:srcdoc']);

function isAllowedFrameUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  if (parsed.protocol === 'about:') return ALLOWED_FRAME_ABOUT_URLS.has(`about:${parsed.pathname}`);
  return ALLOWED_FRAME_PROTOCOLS.has(parsed.protocol);
}

// Baseline for EVERY webContents; the UI view stays locked. Page views get http(s) navigation
// through isNavigationAllowed; popups are decided per page view in tabs.ts.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  // Bluetooth pairing is never offered: cancel the chooser with an empty id.
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
  });
  contents.on('will-navigate', (event) => {
    if (isNavigationAllowed(contents, event.url)) return;
    event.preventDefault();
    // A mailto: or tel: link may ask the user to open their app; any other scheme stays blocked.
    offerExternalLink(contents, event.url, event.isMainFrame, event.initiator);
  });
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return; // handled by will-navigate
    if (!isPageContents(contents) || !isAllowedFrameUrl(event.url)) event.preventDefault();
  });
  contents.on('will-redirect', (event) => {
    if (!isNavigationAllowed(contents, event.url)) event.preventDefault();
  });
});

// Never send a client certificate automatically: Electron would otherwise pick the first one
// in the store. Calling back with no certificate continues without one.
app.on('select-client-certificate', (event, _contents, _url, _list, callback) => {
  event.preventDefault();
  callback();
});

// A bad certificate fails the load with its ERR_CERT_* code. There is no bypass by design: this
// never calls callback(true), and the error card offers no "continue anyway".
app.on('certificate-error', (event, _contents, _url, _error, _certificate, callback) => {
  event.preventDefault();
  callback(false);
});

// Every session starts denying everything, the UI view's included. Wired here so a session
// created later is covered too; the page session is then given prompts in createWindow.
app.on('session-created', denyAllPermissions);

function createWindow(db: DatabaseSync | null): WebContents {
  const window = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: FRAME_FALLBACK, // never visible: the window stays hidden until the colours are applied
    titleBarStyle: 'hidden',
    // Transparent, so the UI view's frame colour shows behind the native caption buttons.
    titleBarOverlay: {
      color: 'rgba(0, 0, 0, 0)',
      symbolColor: SYMBOL_COLOR,
      height: TITLE_BAR_HEIGHT,
    },
  });

  const uiView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/ui.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  addTrustedUi(uiView.webContents);
  window.contentView.addChildView(uiView);
  const pageSession = initTabs(window, uiView.webContents, hasRunningDownload, (tabs) => {
    if (db) writeSession(db, tabs);
  });
  installPermissionHandlers(
    pageSession,
    { topUrl: pageUrl, isFullscreen, ask: askPrompt, mediaGranted },
    pageDecisions,
  );
  initDownloads(uiView.webContents, pageSession, saveDownloadsWithoutPrompt);
  // Last, because the restored active tab loads at once and needs the user agent (set in initTabs)
  // and the permission and download handlers above.
  restoreTabs(db ? readSession(db) : []);
  handleShortcuts(uiView.webContents);

  // getContentBounds() is in screen coordinates; the view needs window-relative ones.
  const fitUiView = () => {
    const { width, height } = window.getContentBounds();
    uiView.setBounds({ x: 0, y: 0, width, height });
  };
  window.on('resize', fitUiView);
  fitUiView();

  // Once loaded, take the chrome colours from tokens.css. Show the window even if the UI fails to
  // load, hangs or returns invalid colours, so it is never left invisible.
  uiView.webContents.once('did-stop-loading', async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const colors: unknown = await Promise.race([
        uiView.webContents.executeJavaScript(
          '[getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color]',
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), READ_COLORS_TIMEOUT_MS);
        }),
      ]);
      if (window.isDestroyed()) return;
      if (
        !Array.isArray(colors) ||
        colors.length !== 2 ||
        !colors.every((color) => typeof color === 'string' && OPAQUE_RGB.test(color))
      ) {
        throw new Error('unexpected colours');
      }
      const [frame, text] = colors as [string, string];
      window.setBackgroundColor(frame);
      uiView.setBackgroundColor(frame);
      window.setTitleBarOverlay({ symbolColor: text });
    } catch (error) {
      if (!app.isPackaged) console.warn('Could not read window colours from the UI:', error);
    } finally {
      clearTimeout(timer);
      if (!window.isDestroyed()) {
        // Without this, showing the window makes Chromium tab into the view's first focusable
        // element, so Back opens with a focus ring. Focusing the view first prevents that.
        uiView.webContents.focus();
        window.show();
      }
    }
  });

  // WebContentsView contents are not destroyed with the window.
  window.on('closed', () => uiView.webContents.close());

  uiView.webContents.loadURL(UI_URL);
  return uiView.webContents;
}

app.whenReady().then(() => {
  session.defaultSession.protocol.handle('blisz', serveUiFiles);
  // The UI view never downloads; page views use their own session (see downloads.ts).
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  handleFromUi('app:get-version', () => app.getVersion());
  const db = openDatabase(join(app.getPath('userData'), 'blisz.db'));
  app.on('will-quit', () => db?.close());
  const ui = createWindow(db);
  handleFromUi('metrics:get', () => getMetrics(ui.getOSProcessId(), getTabProcessLabels()));
  if (benchMode) runBench(ui);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
