import {
  app,
  type BaseWindow,
  type HandlerDetails,
  session,
  shell,
  type WebContents,
  WebContentsView,
  type WebFrameMain,
  type WindowOpenHandlerResponse,
} from 'electron';
import { toNavigableUrl } from '../shared/address';
import { BIDI_CONTROLS } from '../shared/bidi';
import { loadError } from '../shared/tabError';
import type {
  FindOptions,
  FindResult,
  PageArea,
  PromptKind,
  TabAction,
  TabError,
  TabInfo,
  TabsState,
  TabsUpdate,
} from '../shared/tabs';
import { diffTabInfo } from '../shared/tabsUpdate';
import { isWebUrl } from '../shared/url';
import { popupPageMenu, popupTabMenu } from './contextMenu';
import { fetchFavicon, webFaviconUrls } from './favicon';
import { handleFromUi } from './ipc';
import { DecisionStore, isExternalKind, PromptQueue, parseExternalLink } from './permissions';
import { matchShortcut, type ShortcutAction } from './shortcuts';

// The one place the page session is named. The UI view uses the default session, which is the
// only one that serves blisz://, so web pages can't reach app files.
const PAGE_PARTITION = 'persist:main';
// Everything but the partition, which a popup inherits from its opener.
// No preload; sandbox and isolation are explicit even though the app enables the sandbox globally.
const PAGE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  safeDialogs: true,
  navigateOnDragDrop: false,
  devTools: true, // allowed for pages even when packaged; only the UI view's DevTools are dev-only
} satisfies Electron.WebPreferences;
// Real user input that may start a popup.
const POPUP_INPUT_TYPES = new Set<string>(['mouseDown', 'keyDown', 'rawKeyDown', 'touchStart']);
const MAX_INPUT_LENGTH = 32 * 1024;
const MAX_RADIUS = 64;
const FLUSH_DELAY_MS = 16;
const MAX_LABEL_LENGTH = 40;
const ACTIONS: readonly string[] = ['back', 'forward', 'reload', 'stop'] satisfies TabAction[];

const REPEATABLE_ACTIONS = new Set<ShortcutAction>([
  'next-tab',
  'previous-tab',
  'back',
  'forward',
  'find-next',
  'find-previous',
  'zoom-in',
  'zoom-out',
]);

// Popups: only a user-visible opener may open at most POPUP_LIMIT windows per POPUP_WINDOW_MS.
const POPUP_LIMIT = 2;
const POPUP_WINDOW_MS = 5000;
const POPUP_DISPOSITIONS = new Set<string>(['foreground-tab', 'background-tab', 'new-window']);
// Downloads: a recent real click or key in the active tab, at most DOWNLOAD_LIMIT per
// DOWNLOAD_WINDOW_MS. Two explicit requests get a one-shot allowance instead: "Save image" for
// that image URL, and a tab just opened from a click or the menu for its first download.
const DOWNLOAD_INPUT_MS = 5000;
const DOWNLOAD_LIMIT = 3;
const DOWNLOAD_WINDOW_MS = 10_000;
const SAVE_AS_ALLOWANCE_MS = 5000;
// A mailto: or tel: link needs a real click or key this recent. Showing the prompt uses the gesture up.
const EXTERNAL_LINK_INPUT_MS = 5000;
// HTML fullscreen: for the first moments the top of the window stays outside the page so the UI can
// say which site is fullscreen and how to leave. The height is --titlebar-height in tokens.css.
const FULLSCREEN_NOTICE_MS = 3500;
const FULLSCREEN_NOTICE_HEIGHT = 40;
// If the page doesn't leave fullscreen when asked, the window is restored after this long.
const FULLSCREEN_EXIT_FALLBACK_MS = 1000;
// Allow and Block ignore clicks this soon after a prompt appears or the page area moves, so a page
// can't slide something under a click aimed at the page.
const PROMPT_CLICK_DELAY_MS = 500;
// Isolated world for main's own scripts, out of reach of the page's (it can't override what they call).
const MAIN_WORLD_ID = 999;
const MAX_FIND_LENGTH = 1000;
// Chrome's zoom steps. Same-origin tabs share one zoom (Chromium's default policy).
const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];
const ZOOM_EPSILON = 0.01;

interface Tab {
  id: number;
  view: WebContentsView | null; // created on the first navigation, so a blank tab costs no renderer
  favicon: string | null;
  faviconKey: string; // the candidates being fetched or already shown, to skip repeated events
  faviconFetch: AbortController | null;
  htmlFullscreen: boolean; // Esc leaves HTML fullscreen, so it must reach the page
  fullscreenNotice: string | null; // origin shown in the notice strip while it is up
  noticeTimer: NodeJS.Timeout | undefined;
  prompts: PromptQueue; // questions for the user, such as a camera request, oldest first
  error: TabError | null; // why the page can't be shown; the UI shows a card instead of the view
  opener: Tab | null; // the tab that opened this one as a popup
  recentPopups: number[]; // times this tab opened popups, newest last
  blockedPopups: number; // reset on main-frame navigation
  lastInputAt: number; // time of the last real click or key in the page; a popup needs a recent one
  recentDownloads: number[]; // times downloads were allowed from this tab, newest last
  blockedDownloads: number; // reset on main-frame navigation
  saveRequest: { url: string; until: number; kind: 'save-image' | 'save-link' } | null; // what the menu just asked for
  openedAt: number; // when the user opened this tab; until its first navigation commits it may start one download
  isPopup: boolean; // created by window.open or target=_blank
  committed: boolean; // a main-frame navigation has committed; a popup that never did is download-only
}

// The page area as distances from the window edges, so a window resize can be applied at once.
interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
  radius: number;
  hidden: boolean;
}

// HTML fullscreen: the page fills the window, with no insets or rounded corners. During the notice
// the top strip is left free.
const FULL_WINDOW: Insets = { left: 0, top: 0, right: 0, bottom: 0, radius: 0, hidden: false };
const NOTICE_WINDOW: Insets = { ...FULL_WINDOW, top: FULLSCREEN_NOTICE_HEIGHT };

export const pageDecisions = new DecisionStore(); // answers for the page session
let promptReadyAt = 0; // clicks on a prompt count after this time
let userFullscreen = false; // the user made the window fullscreen with F11

const tabs: Tab[] = []; // sidebar order
const pageContents = new WeakSet<WebContents>();
const lastSent = new Map<number, TabInfo>();
const dirty = new Set<number>();
let structureChanged = false; // tabs added, removed or activated since the last flush
let flushTimer: NodeJS.Timeout | undefined;
let nextTabId = 1;
let activeId = 0;
let insets: Insets | null = null;
let attachedView: WebContentsView | null = null;
let focusOnAttach = false; // set by a navigation; layout() focuses the page once it is attached
let findOpen = false; // the UI's find strip is showing for the active tab
let findText = ''; // the last query, for F3 and Ctrl+G
let window: BaseWindow;
let ui: WebContents;

export function isPageContents(contents: WebContents): boolean {
  return pageContents.has(contents);
}

// Decides whether a download that started in `contents` may proceed: 'save-image' or 'save-link'
// when the context menu just asked for this URL, 'gesture' when a real click or key started it, null when blocked
// (the tab then shows a note). `refuse` lets the caller veto it, for example when too many are running.
export function gateDownload(
  contents: WebContents,
  url: string,
  refuse: boolean,
): 'gesture' | 'save-image' | 'save-link' | null {
  const tab = tabs.find((other) => other.view?.webContents === contents);
  if (!tab) return null;
  const now = Date.now();
  if (tab.saveRequest && now >= tab.saveRequest.until) tab.saveRequest = null;
  if (!refuse && tab.saveRequest?.url === url) {
    const { kind } = tab.saveRequest;
    tab.saveRequest = null;
    return kind;
  }
  // A tab the user just opened may be a direct link to a file; that's its one download.
  const firstDownload = !tab.committed && now - tab.openedAt < DOWNLOAD_INPUT_MS;
  tab.openedAt = 0;
  if (!refuse && firstDownload) return 'gesture';
  tab.recentDownloads = tab.recentDownloads.filter((time) => now - time < DOWNLOAD_WINDOW_MS);
  const allowed =
    !refuse &&
    tab.id === activeId &&
    now - tab.lastInputAt < DOWNLOAD_INPUT_MS &&
    tab.recentDownloads.length < DOWNLOAD_LIMIT;
  if (!allowed) {
    tab.blockedDownloads++;
    queueUpdate(tab.id);
    return null;
  }
  tab.recentDownloads.push(now);
  tab.lastInputAt = 0; // one gesture starts one download
  return 'gesture';
}

// Like other browsers, a popup that was opened only to start a download closes itself.
export function closeDownloadOnlyPopup(contents: WebContents): void {
  const tab = tabs.find((other) => other.view?.webContents === contents);
  if (!tab?.isPopup || tab.committed) return;
  setImmediate(() => {
    if (tabs.includes(tab)) closeTab(tab);
  });
}

function createView(): WebContentsView {
  return new WebContentsView({
    webPreferences: { partition: PAGE_PARTITION, ...PAGE_WEB_PREFERENCES },
  });
}

// Per-page setup shared by tabs we create and popups we adopt.
function attachPage(tab: Tab, view: WebContentsView): void {
  const contents = view.webContents;
  tab.view = view;
  pageContents.add(contents);
  handleShortcuts(contents);
  contents.setWindowOpenHandler((details) => handleWindowOpen(tab, details));
  contents.on('input-event', (_event, input) => {
    if (POPUP_INPUT_TYPES.has(input.type)) tab.lastInputAt = Date.now();
  });
  // A link opened from DevTools becomes a tab, web URLs only (never shell.openExternal).
  contents.on('devtools-open-url', (_event, url) => {
    if (isWebUrl(url)) navigate(createTab(), url);
  });
  contents.on('context-menu', (_event, params) =>
    popupPageMenu(window, contents, params, {
      openTab: (url, options) => openInNewTab(tab, url, options),
      saveImage: (url) => saveAs(tab, url, 'save-image'),
      saveLink: (url) => saveAs(tab, url, 'save-link'),
    }),
  );
  watchPageEvents(tab, contents);
}

// The index right after `tab` and the popups it opened, so they keep their order.
function indexAfter(tab: Tab): number {
  const isDescendant = (other: Tab) => {
    for (let ancestor = other.opener; ancestor; ancestor = ancestor.opener) {
      if (ancestor === tab) return true;
    }
    return false;
  };
  let index = tabs.indexOf(tab) + 1;
  while (tabs[index] && isDescendant(tabs[index] as Tab)) index++;
  return index;
}

// Menu items open web URLs in a new tab next to `opener`. navigate() checks the scheme again.
function openInNewTab(opener: Tab, url: string, { background }: { background: boolean }): void {
  if (!isWebUrl(url) || !tabs.includes(opener)) return;
  const tab = addTab(indexAfter(opener));
  tab.opener = opener;
  tab.openedAt = Date.now();
  if (!background) activateTab(tab);
  navigate(tab, url);
}

function saveAs(tab: Tab, url: string, kind: 'save-image' | 'save-link'): void {
  if (!isWebUrl(url) || !tab.view) return;
  tab.saveRequest = { url: new URL(url).href, until: Date.now() + SAVE_AS_ALLOWANCE_MS, kind };
  tab.view.webContents.downloadURL(url);
}

// Popups open as tabs. Blocked ones are counted so the UI can say so.
function handleWindowOpen(
  tab: Tab,
  { url, disposition }: HandlerDetails,
): WindowOpenHandlerResponse {
  const now = Date.now();
  tab.recentPopups = tab.recentPopups.filter((time) => now - time < POPUP_WINDOW_MS);
  const allowed =
    (isWebUrl(url) || url === 'about:blank') && // OAuth often opens a blank popup, then navigates it
    POPUP_DISPOSITIONS.has(disposition) &&
    tab.id === activeId &&
    tabs.includes(tab) &&
    now - tab.lastInputAt < POPUP_WINDOW_MS && // needs a recent real click or key
    tab.recentPopups.length < POPUP_LIMIT;
  if (!allowed) {
    tab.blockedPopups++;
    queueUpdate(tab.id);
    return { action: 'deny' };
  }
  tab.recentPopups.push(now);
  tab.lastInputAt = 0; // one gesture opens one popup
  return {
    action: 'allow',
    outlivesOpener: true, // popups are tabs of their own; closing the opener must not destroy them
    overrideBrowserWindowOptions: { webPreferences: { ...PAGE_WEB_PREFERENCES, zoomFactor: 1 } },
    createWindow: (options) => {
      // Electron passes the new window's webContents here (its typings don't list it) when the
      // popup needs window.opener. Adopting it keeps the opener, which OAuth flows rely on.
      // Without one (a background tab), we create the view and load the URL ourselves.
      const { webContents } = options as { webContents?: WebContents };
      const view = webContents ? new WebContentsView({ webContents }) : createView();
      if (!webContents) view.webContents.loadURL(url).catch(() => {});
      const popup = addTab(indexAfter(tab));
      popup.opener = tab;
      popup.openedAt = Date.now();
      popup.isPopup = true;
      attachPage(popup, view);
      if (disposition !== 'background-tab') activateTab(popup);
      return view.webContents;
    },
  };
}

function findPageTab(contents: WebContents): Tab | undefined {
  return tabs.find((tab) => tab.view?.webContents === contents);
}

// The page's top-level URL, or null when `contents` is not a page tab (such as the UI view).
export function pageUrl(contents: WebContents): string | null {
  return findPageTab(contents) ? contents.getURL() : null;
}

export function isFullscreen(contents: WebContents): boolean {
  return findPageTab(contents)?.htmlFullscreen ?? false;
}

function delayPromptClicks(): void {
  promptReadyAt = Date.now() + PROMPT_CLICK_DELAY_MS;
}

function originOfUrl(url: string): string | null {
  return isWebUrl(url) ? new URL(url).origin : null;
}

// Shows a question under the address field. Resolves with the user's answer, or false when the
// tab navigates, closes or crashes first. The callback never leaves main.
export function askPrompt(
  contents: WebContents,
  kind: PromptKind,
  origin: string,
  target = '',
): Promise<boolean> {
  const tab = findPageTab(contents);
  return new Promise((resolve) => {
    if (!tab) {
      resolve(false);
      return;
    }
    const shown = tab.prompts.current;
    tab.prompts.add(kind, origin, resolve, target);
    // Only a different question on screen re-arms the delay, not a merged or refused request.
    if (tab.prompts.current !== shown) delayPromptClicks();
    queueUpdate(tab.id);
  });
}

// A mailto: or tel: navigation stopped by the page guard. With a recent real click or key in the
// page itself (the main frame, or a same-origin frame), the user is asked, and the gesture is used
// up. Opening the app happens only after Allow, with the rebuilt link.
export function offerExternalLink(
  contents: WebContents,
  url: string,
  isMainFrame: boolean,
  initiator: WebFrameMain | null | undefined,
): void {
  const tab = findPageTab(contents);
  const link = parseExternalLink(url);
  const origin = originOfUrl(contents.getURL());
  const { mainFrame } = contents;
  if (
    !tab ||
    !link ||
    !origin ||
    !isMainFrame ||
    !initiator ||
    (initiator !== mainFrame &&
      (initiator.origin === 'null' || initiator.origin !== mainFrame.origin)) ||
    tab.htmlFullscreen ||
    Date.now() - tab.lastInputAt >= EXTERNAL_LINK_INPUT_MS ||
    tab.prompts.has(link.kind) // one question at a time per kind
  ) {
    return;
  }
  tab.lastInputAt = 0;
  askPrompt(contents, link.kind, origin, link.target).then((allow) => {
    // This is the only shell.openExternal call in the app. Checked again at the moment of opening.
    const checked = allow ? parseExternalLink(link.url) : null;
    if (checked) shell.openExternal(checked.url).catch(() => {});
  });
}

// Answers the oldest question of the tab that shows it. Too soon after it appeared, Allow is
// ignored (Block is harmless, so it always works). If the tab has since moved to another site, the answer is Block and is not remembered.
function respondToPrompt(id: number, allow: boolean): void {
  const tab = tabs.find((other) => other.prompts.current?.id === id);
  const prompt = tab?.prompts.current;
  if (!tab || !prompt || (allow && Date.now() < promptReadyAt)) return;
  const sameSite =
    tab.view !== null && originOfUrl(tab.view.webContents.getURL()) === prompt.origin;
  tab.prompts.respond(id, allow && sameSite);
  if (sameSite && !isExternalKind(prompt.kind)) {
    pageDecisions.remember(prompt.origin, prompt.kind, allow);
  }
  if (tab.prompts.current) delayPromptClicks(); // the next question appears in its place
  queueUpdate(tab.id);
}

function readInfo(tab: Tab): TabInfo {
  if (!tab.view) {
    return {
      id: tab.id,
      url: '',
      title: '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      favicon: null,
      blockedPopups: 0,
      blockedDownloads: 0,
      zoom: 1,
      prompt: null,
      fullscreenNotice: null,
      error: null,
    };
  }
  const contents = tab.view.webContents;
  return {
    id: tab.id,
    url: contents.getURL(),
    title: contents.getTitle(),
    isLoading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    favicon: tab.favicon,
    blockedPopups: tab.blockedPopups,
    blockedDownloads: tab.blockedDownloads,
    zoom: Math.round(contents.getZoomFactor() * 100) / 100,
    prompt: tab.prompts.current,
    fullscreenNotice: tab.fullscreenNotice,
    error: tab.error,
  };
}

function flush(): void {
  flushTimer = undefined;
  const changes: TabsUpdate['tabs'] = {};
  for (const id of dirty) {
    const tab = findTab(id);
    if (!tab) continue;
    const next = readInfo(tab);
    const diff = diffTabInfo(lastSent.get(id), next);
    if (diff) changes[id] = diff;
    lastSent.set(id, next);
  }
  dirty.clear();
  if ((Object.keys(changes).length > 0 || structureChanged) && !ui.isDestroyed()) {
    const update: TabsUpdate = {
      activeId,
      order: tabs.map((tab) => tab.id),
      tabs: changes,
    };
    ui.send('tabs:update', update);
  }
  structureChanged = false;
}

// Page events can fire many times a second; collect them and send one update per frame.
function queueUpdate(id: number): void {
  dirty.add(id);
  flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);
}

function queueStructureUpdate(): void {
  structureChanged = true;
  flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);
}

function getState(): TabsState {
  // lastSent only advances on a flush, so the next update may repeat fields the UI already has,
  // which is harmless because updates are absolute.
  const infos = tabs.map(readInfo);
  return { activeId, order: infos.map((info) => info.id), tabs: infos };
}

function findTab(id: number): Tab | undefined {
  return tabs.find((tab) => tab.id === id);
}

// A view removed from the window is hidden by Chromium, which then throttles that tab (PLAN 4.1).
function detachView(): void {
  if (!attachedView) return;
  delayPromptClicks();
  window.contentView.removeChildView(attachedView);
  attachedView = null;
}

// Attaches the active page view in the page area, or detaches it when the UI covers that area.
function layout(): void {
  const tab = findTab(activeId);
  const view = tab?.view ?? null;
  if (view && tab?.error) {
    detachView(); // the UI shows an error card in the page area
    return;
  }
  let area = insets;
  if (tab?.htmlFullscreen) area = tab.fullscreenNotice === null ? FULL_WINDOW : NOTICE_WINDOW;
  if (!view || !area || area.hidden) {
    detachView();
    focusOnAttach = false; // closing the memory panel later must not make the page take focus
    return;
  }
  if (attachedView !== view) {
    detachView();
    window.contentView.addChildView(view);
    attachedView = view;
  }
  const { width, height } = window.getContentBounds();
  const bounds = {
    x: area.left,
    y: area.top,
    width: Math.max(0, width - area.left - area.right),
    height: Math.max(0, height - area.top - area.bottom),
  };
  const current = view.getBounds();
  if (
    bounds.x !== current.x ||
    bounds.y !== current.y ||
    bounds.width !== current.width ||
    bounds.height !== current.height
  ) {
    delayPromptClicks();
  }
  view.setBounds(bounds);
  view.setBorderRadius(area.radius);
  if (focusOnAttach) {
    focusOnAttach = false;
    view.webContents.focus();
  }
}

function setPageArea(area: PageArea): void {
  const { width: contentWidth, height: contentHeight } = window.getContentBounds();
  const numbers = [area.x, area.y, area.width, area.height, area.radius];
  if (!numbers.every(Number.isFinite)) throw new Error('Invalid page area');
  // Clamp rather than reject: a fractional or mid-resize report can overshoot slightly.
  const clamp = (value: number, max: number) => Math.min(Math.max(0, Math.round(value)), max);
  const left = clamp(area.x, contentWidth);
  const top = clamp(area.y, contentHeight);
  insets = {
    left,
    top,
    right: clamp(contentWidth - area.x - area.width, contentWidth - left),
    bottom: clamp(contentHeight - area.y - area.height, contentHeight - top),
    radius: clamp(area.radius, MAX_RADIUS),
    hidden: area.hidden,
  };
  layout();
}

function watchPageEvents(tab: Tab, contents: WebContents): void {
  const onChange = () => queueUpdate(tab.id);
  contents.on('did-start-loading', onChange);
  contents.on('did-stop-loading', onChange);
  // A new page load drops the old error.
  contents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    setError(tab, null);
    onChange();
  });
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    const error = isMainFrame ? loadError(code, description, url) : null; // a trailing -3 changes nothing
    if (error) setError(tab, error);
  });
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    tab.prompts.cancelAll();
    dropHtmlFullscreen(tab);
    setError(tab, { kind: 'crashed' });
    onChange();
  });
  contents.on('did-navigate', () => {
    tab.prompts.cancelAll(); // questions belong to the page that asked
    setError(tab, null);
    resetFavicon(tab);
    tab.blockedPopups = 0;
    tab.blockedDownloads = 0;
    tab.committed = true;
    tab.lastInputAt = 0; // a click on the old page doesn't count for the new one
    tab.recentDownloads = [];
    if (tab.id === activeId) closeFind();
    onChange();
  });
  contents.on('did-navigate-in-page', onChange);
  contents.on('page-title-updated', onChange);
  contents.on('enter-html-full-screen', () => {
    if (tab.id !== activeId) {
      requestExitFullscreen(contents); // only the tab in view may take over the window
      restoreWindowSoon();
      return;
    }
    tab.htmlFullscreen = true; // Electron has already made the window fullscreen
    tab.fullscreenNotice = originOfUrl(contents.getURL()) ?? 'This page';
    clearTimeout(tab.noticeTimer);
    tab.noticeTimer = setTimeout(() => {
      tab.fullscreenNotice = null;
      queueUpdate(tab.id);
      layout();
    }, FULLSCREEN_NOTICE_MS);
    queueUpdate(tab.id);
    layout();
  });
  contents.on('leave-html-full-screen', () => leaveHtmlFullscreen(tab));
  contents.on('page-favicon-updated', (_event, favicons) => {
    loadFavicon(tab, webFaviconUrls(favicons));
  });
  contents.on('found-in-page', (_event, result) => {
    if (!result.finalUpdate || tab.id !== activeId || ui.isDestroyed()) return;
    const found: FindResult = {
      tabId: tab.id,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    };
    ui.send('find:result', found);
  });
  // Ctrl+scroll asks for a zoom step.
  contents.on('zoom-changed', (_event, direction) => stepZoom(contents, direction));
  // A page can close its own webContents (window.close()); the tab closes like in other browsers.
  contents.once('destroyed', () => {
    // closeTab or a closing window got here first.
    if (window.isDestroyed() || !tabs.includes(tab)) return;
    // The view's webContents is gone, so closeTab must not touch it.
    if (attachedView === tab.view) detachView();
    tab.view = null;
    closeTab(tab);
  });
}

function setError(tab: Tab, error: TabError | null): void {
  if (tab.error === error) return;
  tab.error = error;
  queueUpdate(tab.id);
  if (tab.id === activeId) layout();
}

// Puts the page area back after HTML fullscreen. Electron itself leaves window fullscreen when the
// page leaves HTML fullscreen (Esc included). Safe to call when not in it.
function leaveHtmlFullscreen(tab: Tab): void {
  if (!tab.htmlFullscreen) return;
  tab.htmlFullscreen = false;
  clearTimeout(tab.noticeTimer);
  tab.fullscreenNotice = null;
  queueUpdate(tab.id);
  layout();
}

// For a page that can no longer say it left (closed or crashed): no leave event will come, so the
// window is restored here, unless the user chose fullscreen with F11.
function dropHtmlFullscreen(tab: Tab): void {
  if (!tab.htmlFullscreen) return;
  if (!userFullscreen) window.setFullScreen(false);
  leaveHtmlFullscreen(tab);
}

function exitHtmlFullscreen(tab: Tab): void {
  if (!tab.htmlFullscreen) return;
  if (tab.view) requestExitFullscreen(tab.view.webContents);
  leaveHtmlFullscreen(tab);
  restoreWindowSoon();
}

// Electron has no webContents.exitFullscreen(), so the page is asked, from an isolated world so
// that the page can't replace what is called.
function requestExitFullscreen(contents: WebContents): void {
  contents
    .executeJavaScriptInIsolatedWorld(MAIN_WORLD_ID, [{ code: 'void document.exitFullscreen()' }])
    .catch(() => {});
}

// Backup for a page that never leaves fullscreen: the window is restored anyway.
function restoreWindowSoon(): void {
  setTimeout(() => {
    if (window.isDestroyed() || userFullscreen || tabs.some((tab) => tab.htmlFullscreen)) return;
    window.setFullScreen(false);
  }, FULLSCREEN_EXIT_FALLBACK_MS);
}

// Cancels a fetch in flight and forgets the favicon (navigation, close, page gone).
function resetFavicon(tab: Tab): void {
  tab.faviconFetch?.abort();
  tab.faviconFetch = null;
  tab.faviconKey = '';
  tab.favicon = null;
}

function loadFavicon(tab: Tab, urls: string[]): void {
  const key = urls.join(' ');
  if (key === '' || key === tab.faviconKey) return;
  tab.faviconFetch?.abort();
  const controller = new AbortController();
  tab.faviconFetch = controller;
  tab.faviconKey = key;
  fetchFavicon(session.fromPartition(PAGE_PARTITION), urls, controller.signal)
    .then((favicon) => {
      if (favicon === null || controller.signal.aborted) return;
      tab.favicon = favicon;
      queueUpdate(tab.id);
    })
    .catch(() => {}); // a missing favicon just leaves the letter tile
}

// Returns whether a navigation started.
function navigate(tab: Tab, input: string): boolean {
  const target = toNavigableUrl(input);
  // loadURL from main doesn't fire will-navigate, so the scheme is checked here.
  if (!isWebUrl(target)) {
    if (target !== '' && !app.isPackaged) console.warn(`Refused to navigate to ${target}`);
    return false;
  }
  if (!tab.view) attachPage(tab, createView());
  // Failures are reported through did-fail-load (error pages come in a later step).
  tab.view?.webContents.loadURL(new URL(target).href).catch(() => {});
  if (tab.id === activeId) focusOnAttach = true;
  layout();
  return true;
}

function addTab(index: number): Tab {
  const tab: Tab = {
    id: nextTabId++,
    view: null,
    favicon: null,
    faviconKey: '',
    faviconFetch: null,
    htmlFullscreen: false,
    fullscreenNotice: null,
    noticeTimer: undefined,
    prompts: new PromptQueue(),
    error: null,
    opener: null,
    recentPopups: [],
    blockedPopups: 0,
    lastInputAt: 0,
    recentDownloads: [],
    blockedDownloads: 0,
    saveRequest: null,
    openedAt: 0,
    isPopup: false,
    committed: false,
  };
  tabs.splice(index, 0, tab);
  queueUpdate(tab.id); // sends the new tab's full info
  queueStructureUpdate();
  return tab;
}

// A tab with a page gets focus once its view is attached; a blank tab hands focus to the address field.
function activateTab(tab: Tab): void {
  if (tab.id !== activeId) {
    closeFind();
    const previous = findTab(activeId);
    if (previous) exitHtmlFullscreen(previous);
  }
  activeId = tab.id;
  queueStructureUpdate();
  if (tab.view) focusOnAttach = true;
  else ui.focus();
  layout();
}

function createTab(): Tab {
  const tab = addTab(tabs.length);
  activateTab(tab);
  return tab;
}

function duplicateTab(source: Tab): Tab {
  const tab = addTab(tabs.indexOf(source) + 1);
  activateTab(tab);
  if (source.view) navigate(tab, source.view.webContents.getURL());
  return tab;
}

function closeTab(tab: Tab): void {
  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  lastSent.delete(tab.id);
  queueStructureUpdate();
  tab.faviconFetch?.abort();
  tab.prompts.cancelAll();
  dropHtmlFullscreen(tab);
  if (tab.view) {
    if (attachedView === tab.view) detachView();
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    tab.view = null;
  }
  if (tab.id !== activeId) return;
  for (const other of tabs) {
    if (other.opener === tab) other.opener = null;
  }
  // Closing a popup goes back to the tab that opened it, like other browsers.
  const opener = tab.opener && tabs.includes(tab.opener) ? tab.opener : null;
  const neighbour = opener ?? tabs[index] ?? tabs[index - 1];
  if (neighbour) activateTab(neighbour);
  else createTab(); // closing the last tab leaves a blank one
}

// Benchmark only (src/main/bench.ts): loads every URL as a tab, the first in the blank tab that
// exists at launch. The last tab ends up active.
export function openBenchTabs(urls: string[]): void {
  for (const [index, url] of urls.entries()) {
    const tab = index === 0 ? tabs[0] : createTab();
    if (tab) navigate(tab, url);
  }
}

// Benchmark only: how many tabs have a page that finished loading.
export function countLoadedTabs(): number {
  return tabs.filter((tab) => tab.view && !tab.view.webContents.isLoading()).length;
}

// "Tab: <title>" per page process, for the memory panel. Text only; the title is untrusted.
export function getTabProcessLabels(): Map<number, string> {
  const titles = new Map<number, string[]>();
  for (const tab of tabs) {
    if (!tab.view || tab.view.webContents.isDestroyed()) continue;
    const contents = tab.view.webContents;
    const name = Array.from((contents.getTitle() || contents.getURL()).replace(BIDI_CONTROLS, '')); // by code point, not UTF-16 unit
    const short =
      name.length > MAX_LABEL_LENGTH
        ? `${name.slice(0, MAX_LABEL_LENGTH).join('')}...`
        : name.join('');
    const pid = contents.getOSProcessId();
    titles.set(pid, [...(titles.get(pid) ?? []), short]); // tabs can share a process
  }
  return new Map([...titles].map(([pid, names]) => [pid, `Tab: ${names.join(', ')}`]));
}

function go(tab: Tab, action: TabAction): void {
  if (!tab.view) return;
  const contents = tab.view.webContents;
  if (action === 'back') contents.navigationHistory.goBack();
  else if (action === 'forward') contents.navigationHistory.goForward();
  else if (action === 'reload') contents.reload();
  else contents.stop();
}

function toggleDevTools(contents: WebContents): void {
  if (contents.isDevToolsOpened()) contents.closeDevTools();
  else contents.openDevTools({ mode: 'detach' }); // a WebContentsView has no window to dock into
}

// Hides the find strip and clears the highlighted matches of the active tab.
function closeFind(): void {
  if (!findOpen) return;
  findOpen = false;
  findText = '';
  findTab(activeId)?.view?.webContents.stopFindInPage('clearSelection');
  if (!ui.isDestroyed()) ui.send('ui:close-find');
}

// Zoom is per origin in Chromium, so a change can show up in every tab on that site.
function queueZoomUpdates(): void {
  for (const tab of tabs) {
    if (tab.view) queueUpdate(tab.id);
  }
}

function stepZoom(contents: WebContents, direction: 'in' | 'out'): void {
  const current = contents.getZoomFactor();
  const next =
    direction === 'in'
      ? ZOOM_STEPS.find((step) => step > current + ZOOM_EPSILON)
      : ZOOM_STEPS.findLast((step) => step < current - ZOOM_EPSILON);
  if (next === undefined) return;
  contents.setZoomFactor(next);
  queueZoomUpdates();
}

function switchTab(offset: number): void {
  const index = tabs.findIndex((tab) => tab.id === activeId);
  const next = tabs[(index + offset + tabs.length) % tabs.length];
  if (next) activateTab(next);
}

function runShortcut(action: ShortcutAction): void {
  if (typeof action === 'object') {
    const tab = tabs[action.selectTab - 1];
    if (tab) activateTab(tab);
    return;
  }
  const active = findTab(activeId);
  switch (action) {
    case 'new-tab':
      createTab();
      break;
    case 'close-tab':
      if (active) closeTab(active);
      break;
    case 'next-tab':
      switchTab(1);
      break;
    case 'previous-tab':
      switchTab(-1);
      break;
    case 'last-tab': {
      const last = tabs.at(-1);
      if (last) activateTab(last);
      break;
    }
    case 'focus-address':
      ui.focus();
      ui.send('ui:focus-address');
      break;
    case 'reload':
    case 'back':
    case 'forward':
    case 'stop':
      if (active) go(active, action);
      break;
    case 'reload-ignoring-cache':
      active?.view?.webContents.reloadIgnoringCache();
      break;
    case 'toggle-devtools':
      if (active?.view) toggleDevTools(active.view.webContents);
      break;
    case 'toggle-ui-devtools':
      toggleDevTools(ui);
      break;
    case 'find':
      if (!active?.view) break;
      findOpen = true;
      ui.focus();
      ui.send('ui:open-find');
      break;
    case 'find-next':
    case 'find-previous':
      if (findText !== '') {
        active?.view?.webContents.findInPage(findText, {
          forward: action === 'find-next',
          findNext: true,
        });
      }
      break;
    case 'zoom-in':
      if (active?.view) stepZoom(active.view.webContents, 'in');
      break;
    case 'zoom-out':
      if (active?.view) stepZoom(active.view.webContents, 'out');
      break;
    case 'zoom-reset':
      active?.view?.webContents.setZoomFactor(1);
      queueZoomUpdates();
      break;
    case 'toggle-fullscreen':
      // F11 in HTML fullscreen leaves it; otherwise it toggles the window.
      if (active?.htmlFullscreen) exitHtmlFullscreen(active);
      else {
        userFullscreen = !window.isFullScreen();
        window.setFullScreen(userFullscreen);
      }
      break;
  }
}

// Browser shortcuts must work whichever view has focus (PLAN 4.5), so every view but DevTools gets this.
export function handleShortcuts(contents: WebContents): void {
  contents.on('before-input-event', (event, input) => {
    const action = matchShortcut(input);
    if (!action) return;
    if (action === 'toggle-ui-devtools' && app.isPackaged) return;
    // F3 and Ctrl+G only mean "next match" while the strip is open; otherwise the page keeps them.
    if ((action === 'find-next' || action === 'find-previous') && !findOpen) return;
    if (action === 'stop') {
      // The UI uses Esc in the address field, so only a loading page is stopped, and not in HTML fullscreen.
      const active = findTab(activeId);
      if (
        contents !== active?.view?.webContents ||
        active.htmlFullscreen ||
        !contents.isLoading()
      ) {
        return;
      }
    }
    event.preventDefault();
    // Holding a key must not open or close dozens of tabs; only cycling and history repeat.
    if (input.isAutoRepeat && !REPEATABLE_ACTIONS.has(action)) return;
    runShortcut(action);
  });
}

// Google sign-in rejects a UA that claims to be plain Chrome when the engine isn't Chrome, so
// keep a product token like Edge's Edg/ (named Blisz explicitly; app.getName() is the npm name).
// Drop the Electron token, which some sites block.
function toPageUserAgent(userAgent: string): string {
  const electronAppToken = `${app.getName().replaceAll(' ', '')}/`;
  const chromeTokens = userAgent
    .split(' ')
    .filter((token) => !token.startsWith('Electron/') && !token.startsWith(electronAppToken));
  return [...chromeTokens, `Blisz/${app.getVersion()}`].join(' ');
}

// For ids that may already be gone (a double click races with the close): undefined when unknown.
function findTabArg(id: unknown): Tab | undefined {
  if (!Number.isInteger(id)) throw new Error('Bad tab id');
  return findTab(id as number);
}

function getTab(id: unknown): Tab {
  const tab = findTabArg(id);
  if (!tab) throw new Error('Unknown tab');
  return tab;
}

function isFindOptions(value: unknown): value is FindOptions {
  if (typeof value !== 'object' || value === null) return false;
  const options = value as Record<string, unknown>;
  return typeof options.forward === 'boolean' && typeof options.findNext === 'boolean';
}

function isPageArea(value: unknown): value is PageArea {
  if (typeof value !== 'object' || value === null) return false;
  const area = value as Record<string, unknown>;
  return (
    ['x', 'y', 'width', 'height', 'radius'].every((key) => typeof area[key] === 'number') &&
    typeof area.hidden === 'boolean'
  );
}

// Creates the first (blank) tab and registers the tab IPC for the given window. Single window
// only: module state is shared and the IPC handlers are registered once.
export function initTabs(appWindow: BaseWindow, uiContents: WebContents): Electron.Session {
  window = appWindow;
  ui = uiContents;
  createTab();

  const pageSession = session.fromPartition(PAGE_PARTITION);
  pageSession.setUserAgent(toPageUserAgent(pageSession.getUserAgent()));

  handleFromUi('tabs:get-state', () => getState());
  handleFromUi('tab:navigate', (_event, id, input) => {
    const tab = getTab(id);
    if (typeof input !== 'string' || input.length > MAX_INPUT_LENGTH) throw new Error('Bad input');
    return navigate(tab, input);
  });
  handleFromUi('tab:go', (_event, id, action) => {
    const tab = getTab(id);
    if (typeof action !== 'string' || !ACTIONS.includes(action)) throw new Error('Bad action');
    go(tab, action as TabAction);
  });
  handleFromUi('tabs:create', () => createTab().id);
  handleFromUi('tabs:close', (_event, id) => {
    const tab = findTabArg(id);
    if (tab) closeTab(tab);
  });
  handleFromUi('tabs:activate', (_event, id) => {
    const tab = findTabArg(id);
    if (tab) activateTab(tab);
  });
  handleFromUi('tabs:duplicate', (_event, id) => duplicateTab(getTab(id)).id);
  handleFromUi('tabs:context-menu', (_event, id) => {
    const tab = getTab(id);
    // The tab may be gone by the time an item is picked.
    popupTabMenu(window, {
      duplicate: () => {
        if (tabs.includes(tab)) duplicateTab(tab);
      },
      close: () => {
        if (tabs.includes(tab)) closeTab(tab);
      },
    });
  });
  handleFromUi('prompts:respond', (_event, id, allow) => {
    if (!Number.isInteger(id) || typeof allow !== 'boolean') throw new Error('Bad prompt answer');
    respondToPrompt(id as number, allow);
  });
  handleFromUi('tab:reset-zoom', (_event, id) => {
    getTab(id).view?.webContents.setZoomFactor(1);
    queueZoomUpdates();
  });
  handleFromUi('find:query', (_event, id, text, options) => {
    const tab = getTab(id);
    if (typeof text !== 'string' || text.length > MAX_FIND_LENGTH) throw new Error('Bad text');
    if (!isFindOptions(options)) throw new Error('Bad options');
    if (!findOpen || tab.id !== activeId || !tab.view) return;
    findText = text;
    if (text === '') tab.view.webContents.stopFindInPage('clearSelection');
    else {
      // A new search must omit findNext: passing findNext: false makes Chromium report nothing.
      tab.view.webContents.findInPage(text, {
        forward: options.forward,
        ...(options.findNext && { findNext: true }),
      });
    }
  });
  handleFromUi('find:stop', (_event, id, focusPage) => {
    const tab = getTab(id);
    if (typeof focusPage !== 'boolean') throw new Error('Bad argument');
    if (tab.id !== activeId) return;
    findOpen = false;
    findText = '';
    tab.view?.webContents.stopFindInPage('clearSelection');
    if (focusPage) tab.view?.webContents.focus(); // the strip is closed, so the page gets the keyboard back
  });
  handleFromUi('page:set-area', (_event, area) => {
    if (!isPageArea(area)) throw new Error('Bad page area');
    setPageArea(area);
  });

  // Mouse side buttons.
  window.on('app-command', (_event, command) => {
    const active = findTab(activeId);
    if (!active) return;
    if (command === 'browser-backward') go(active, 'back');
    else if (command === 'browser-forward') go(active, 'forward');
  });
  // Recompute at once instead of waiting for the UI to report the new size.
  window.on('resize', layout);
  window.on('leave-full-screen', () => {
    userFullscreen = false;
  });
  // WebContentsView contents are not destroyed with the window.
  window.on('closed', () => {
    clearTimeout(flushTimer);
    for (const tab of tabs) {
      tab.prompts.cancelAll();
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
  });
  return pageSession;
}
