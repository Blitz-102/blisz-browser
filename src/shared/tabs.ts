export interface TabInfo {
  id: number;
  url: string; // empty while the tab is blank (no page view yet)
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  favicon: string | null; // a data: URL built by main, never a remote URL
  blockedPopups: number; // popups denied since the last main-frame navigation
  blockedDownloads: number; // downloads denied since the last main-frame navigation
  zoom: number; // zoom factor, 1 = 100%
}

export interface TabsState {
  activeId: number;
  order: number[]; // tab ids in sidebar order
  tabs: TabInfo[];
}

// Absolute values for the fields that changed, keyed by tab id; applying one twice is harmless.
// A new tab arrives with all its fields. `order` is the full tab list: ids missing from it are
// closed (ids are never reused).
export interface TabsUpdate {
  activeId: number;
  order: number[];
  tabs: Record<number, Partial<TabInfo>>;
}

export type TabAction = 'back' | 'forward' | 'reload' | 'stop';

// The page area in CSS px, as measured by the UI. `hidden` detaches the page view so the UI
// can show something (like the memory panel) in the same spot.
export interface PageArea {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  hidden: boolean;
}

// Find-in-page result for the active tab, from the final `found-in-page` event.
export interface FindResult {
  tabId: number;
  activeMatchOrdinal: number;
  matches: number;
}

export interface FindOptions {
  forward: boolean;
  findNext: boolean; // false starts a new search, true moves to the next match
}
