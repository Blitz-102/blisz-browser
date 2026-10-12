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

export function applyTabsUpdate(state: TabsState, update: TabsUpdate): TabsState {
  return {
    activeId: update.activeId,
    tabs: state.tabs.map((tab) => ({ ...tab, ...update.tabs[tab.id] })),
  };
}
