export interface TabInfo {
  id: number;
  url: string; // empty while the tab is blank (no page view yet)
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface TabsState {
  activeId: number;
  tabs: TabInfo[];
}

// Absolute values for the fields that changed, keyed by tab id; applying one twice is harmless.
export interface TabsUpdate {
  activeId: number;
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
