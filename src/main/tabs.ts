import { app, type BaseWindow, session, type WebContents, WebContentsView } from 'electron';
import { toNavigableUrl } from '../shared/address';
import type { PageArea, TabAction, TabInfo, TabsState, TabsUpdate } from '../shared/tabs';
import { diffTabInfo } from '../shared/tabsUpdate';
import { isWebUrl } from '../shared/url';
import { fetchFavicon, webFaviconUrls } from './favicon';
import { handleFromUi } from './ipc';

// The one place the page session is named. The UI view uses the default session, which is the
// only one that serves blisz://, so web pages can't reach app files.
const PAGE_PARTITION = 'persist:main';
const MAX_INPUT_LENGTH = 32 * 1024;
const MAX_RADIUS = 64;
const FLUSH_DELAY_MS = 16;
const MAX_LABEL_LENGTH = 40;
// Bidi controls in a title could reorder the text around it in the memory panel.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const ACTIONS: readonly string[] = ['back', 'forward', 'reload', 'stop'] satisfies TabAction[];

interface Tab {
  id: number;
  view: WebContentsView | null; // created on the first navigation, so a blank tab costs no renderer
  favicon: string | null;
  faviconKey: string; // the candidates being fetched or already shown, to skip repeated events
  faviconFetch: AbortController | null;
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
      favicon: null,
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
  window.contentView.removeChildView(attachedView);
  attachedView = null;
}

// Attaches the active page view in the page area, or detaches it when the UI covers that area.
function layout(): void {
  const view = findTab(activeId)?.view ?? null;
  if (!view || !insets || insets.hidden) {
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
  contents.on('did-navigate', () => {
    resetFavicon(tab);
    onChange();
  });
  contents.on('did-navigate-in-page', onChange);
  contents.on('page-title-updated', onChange);
  contents.on('page-favicon-updated', (_event, favicons) => {
    loadFavicon(tab, webFaviconUrls(favicons));
  });
  // A page can close its own webContents (window.close()); the tab goes back to blank.
  contents.once('destroyed', () => {
    if (attachedView === tab.view) {
      if (!window.isDestroyed() && tab.view) window.contentView.removeChildView(tab.view);
      attachedView = null;
    }
    tab.view = null;
    resetFavicon(tab);
    lastSent.delete(tab.id);
    queueUpdate(tab.id);
    if (tab.id === activeId && !ui.isDestroyed()) ui.focus();
  });
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
  if (!tab.view) {
    tab.view = createView();
    watchPageEvents(tab, tab.view.webContents);
  }
  // Failures are reported through did-fail-load (error pages come in a later step).
  tab.view.webContents.loadURL(new URL(target).href).catch(() => {});
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
  };
  tabs.splice(index, 0, tab);
  queueUpdate(tab.id); // sends the new tab's full info
  queueStructureUpdate();
  return tab;
}

// A tab with a page gets focus once its view is attached; a blank tab hands focus to the address field.
function activateTab(tab: Tab): void {
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
  if (tab.view) {
    if (attachedView === tab.view) detachView();
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    tab.view = null;
  }
  if (tab.id !== activeId) return;
  const neighbour = tabs[index] ?? tabs[index - 1];
  if (neighbour) activateTab(neighbour);
  else createTab(); // closing the last tab leaves a blank one
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
  createTab();

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
  handleFromUi('page:set-area', (_event, area) => {
    if (!isPageArea(area)) throw new Error('Bad page area');
    setPageArea(area);
  });

  // Recompute at once instead of waiting for the UI to report the new size.
  window.on('resize', layout);
  // WebContentsView contents are not destroyed with the window.
  window.on('closed', () => {
    clearTimeout(flushTimer);
    for (const tab of tabs) {
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
  });
}
