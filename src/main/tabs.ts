import { app, type BaseWindow, session, type WebContents, WebContentsView } from 'electron';
import { toNavigableUrl } from '../shared/address';
import type { PageArea, TabAction, TabInfo, TabsState, TabsUpdate } from '../shared/tabs';
import { diffTabInfo } from '../shared/tabsUpdate';
import { isWebUrl } from '../shared/url';
import { handleFromUi } from './ipc';

// The one place the page session is named. The UI view uses the default session, which is the
// only one that serves blisz://, so web pages can't reach app files.
const PAGE_PARTITION = 'persist:main';
const MAX_INPUT_LENGTH = 32 * 1024;
const MAX_RADIUS = 64;
const FLUSH_DELAY_MS = 16;
const ACTIONS: readonly string[] = ['back', 'forward', 'reload', 'stop'] satisfies TabAction[];

interface Tab {
  id: number;
  view: WebContentsView | null; // created on the first navigation, so a blank tab costs no renderer
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

const tabs = new Map<number, Tab>();
const pageContents = new WeakSet<WebContents>();
const lastSent = new Map<number, TabInfo>();
const dirty = new Set<number>();
let flushTimer: NodeJS.Timeout | undefined;
const activeId = 1;
let insets: Insets | null = null;
let attachedView: WebContentsView | null = null;
let focusOnAttach = false; // set by a navigation; layout() focuses the page once it is attached
let window: BaseWindow;
let ui: WebContents;

export function isPageContents(contents: WebContents): boolean {
  return pageContents.has(contents);
}

// No preload; sandbox and isolation are explicit even though the app enables the sandbox globally.
function createView(): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      partition: PAGE_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      safeDialogs: true,
      navigateOnDragDrop: false,
      devTools: true, // allowed for pages even when packaged; only the UI view's DevTools are dev-only
    },
  });
  pageContents.add(view.webContents);
  return view;
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
  };
}

function flush(): void {
  flushTimer = undefined;
  const changes: TabsUpdate['tabs'] = {};
  for (const id of dirty) {
    const tab = tabs.get(id);
    if (!tab) continue;
    const next = readInfo(tab);
    const diff = diffTabInfo(lastSent.get(id), next);
    if (diff) changes[id] = diff;
    lastSent.set(id, next);
  }
  dirty.clear();
  if (Object.keys(changes).length > 0 && !ui.isDestroyed()) {
    const update: TabsUpdate = { activeId, tabs: changes };
    ui.send('tabs:update', update);
  }
}

// Page events can fire many times a second; collect them and send one update per frame.
function queueUpdate(id: number): void {
  dirty.add(id);
  flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);
}

function getState(): TabsState {
  const infos = [...tabs.values()].map(readInfo);
  for (const info of infos) lastSent.set(info.id, info);
  return { activeId, tabs: infos };
}

// Attaches the active page view in the page area, or detaches it when the UI covers that area.
function layout(): void {
  const view = tabs.get(activeId)?.view ?? null;
  if (!view || !insets || insets.hidden) {
    if (attachedView) window.contentView.removeChildView(attachedView);
    attachedView = null;
    return;
  }
  if (attachedView !== view) {
    if (attachedView) window.contentView.removeChildView(attachedView);
    window.contentView.addChildView(view);
    attachedView = view;
  }
  const { width, height } = window.getContentBounds();
  view.setBounds({
    x: insets.left,
    y: insets.top,
    width: Math.max(0, width - insets.left - insets.right),
    height: Math.max(0, height - insets.top - insets.bottom),
  });
  view.setBorderRadius(insets.radius);
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
  contents.on('did-navigate', onChange);
  contents.on('did-navigate-in-page', onChange);
  contents.on('page-title-updated', onChange);
  // A page can close its own webContents (window.close()); the tab goes back to blank.
  contents.once('destroyed', () => {
    if (attachedView === tab.view) {
      if (!window.isDestroyed() && tab.view) window.contentView.removeChildView(tab.view);
      attachedView = null;
    }
    tab.view = null;
    lastSent.delete(tab.id);
    queueUpdate(tab.id);
  });
}

// Returns whether a navigation started.
function navigate(tab: Tab, input: string): boolean {
  const target = toNavigableUrl(input);
  // loadURL from main doesn't fire will-navigate, so the scheme is checked here.
  if (!isWebUrl(target)) {
    if (target !== '' && !app.isPackaged) console.warn(`Refused to navigate to ${target}`);
    return false;
  }
  if (!tab.view) {
    tab.view = createView();
    watchPageEvents(tab, tab.view.webContents);
  }
  // Failures are reported through did-fail-load (error pages come in a later step).
  tab.view.webContents.loadURL(new URL(target).href).catch(() => {});
  focusOnAttach = true;
  layout();
  return true;
}

function go(tab: Tab, action: TabAction): void {
  if (!tab.view) return;
  const contents = tab.view.webContents;
  if (action === 'back') contents.navigationHistory.goBack();
  else if (action === 'forward') contents.navigationHistory.goForward();
  else if (action === 'reload') contents.reload();
  else contents.stop();
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

function getTab(id: unknown): Tab {
  const tab = typeof id === 'number' ? tabs.get(id) : undefined;
  if (!tab) throw new Error('Unknown tab');
  return tab;
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
export function initTabs(appWindow: BaseWindow, uiContents: WebContents): void {
  window = appWindow;
  ui = uiContents;
  tabs.set(activeId, { id: activeId, view: null });

  const pageSession = session.fromPartition(PAGE_PARTITION);
  pageSession.setUserAgent(toPageUserAgent(pageSession.getUserAgent()));
  // Downloads arrive in a later step; until then cancel them so pages can't open Save As dialogs.
  pageSession.on('will-download', (event) => {
    event.preventDefault();
    if (!app.isPackaged) console.warn('Download cancelled');
  });

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
  handleFromUi('page:set-area', (_event, area) => {
    if (!isPageArea(area)) throw new Error('Bad page area');
    setPageArea(area);
  });

  // Recompute at once instead of waiting for the UI to report the new size.
  window.on('resize', layout);
  // WebContentsView contents are not destroyed with the window.
  window.on('closed', () => {
    clearTimeout(flushTimer);
    for (const tab of tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
  });
}
