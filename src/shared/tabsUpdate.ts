import type { TabInfo, TabsState, TabsUpdate } from './tabs';

// Returns the fields of `next` that differ from `prev`, or null when nothing changed.
// Without a previous value, everything counts as changed.
export function diffTabInfo(prev: TabInfo | undefined, next: TabInfo): Partial<TabInfo> | null {
  if (!prev) return next;
  const changes: Partial<TabInfo> = {};
  let changed = false;
  for (const key of Object.keys(next) as (keyof TabInfo)[]) {
    if (prev[key] !== next[key]) {
      Object.assign(changes, { [key]: next[key] });
      changed = true;
    }
  }
  return changed ? changes : null;
}

// Tabs follow `order`; a tab missing from the state is created from its (full) update.
export function applyTabsUpdate(state: TabsState, update: TabsUpdate): TabsState {
  const known = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const tabs: TabInfo[] = [];
  for (const id of update.order) {
    const merged = { ...known.get(id), ...update.tabs[id] } as TabInfo;
    if (merged.id === id) tabs.push(merged);
  }
  return { activeId: update.activeId, order: tabs.map((tab) => tab.id), tabs };
}
