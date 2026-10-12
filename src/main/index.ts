import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
import { addTrustedUi, handleFromUi, UI_URL } from './ipc';
import { getMetrics } from './metrics';
import { getTabProcessLabels, handleShortcuts, initTabs, isPageContents } from './tabs';

// Native caption buttons via titleBarOverlay (PLAN 4.6); colours come from tokens.css.
// Fallbacks for --color-frame and --color-text, used only if reading them from the UI fails.
const FRAME_FALLBACK = '#e0ddd5';
const SYMBOL_COLOR = '#1f2a26';
// Keep in sync with --titlebar-height in tokens.css: the overlay height is fixed at creation.
const TITLE_BAR_HEIGHT = 40;
// Opaque colours only, as Chromium returns them: a translucent body must not make the window transparent.
const OPAQUE_RGB = /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/;
const READ_COLORS_TIMEOUT_MS = 2000;

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
// through isNavigationAllowed; popups stay denied until the popup step.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event) => {
    if (!isNavigationAllowed(contents, event.url)) event.preventDefault();
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

// Deny everything for now; Phase 2 replaces this with per-site prompts (PLAN 4.2, section 7).
function denyAllPermissions(targetSession: Electron.Session): void {
  targetSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setDevicePermissionHandler(() => false);
}
app.on('session-created', denyAllPermissions);

function createWindow(): WebContents {
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
  initTabs(window, uiView.webContents);
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
  handleFromUi('app:get-version', () => app.getVersion());
  const ui = createWindow();
  handleFromUi('metrics:get', () => getMetrics(ui.getOSProcessId(), getTabProcessLabels()));
  // `npm run bench:memory` passes --bench; never honoured in a packaged app.
  if (!app.isPackaged && process.argv.includes('--bench')) {
    runBench(ui);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
