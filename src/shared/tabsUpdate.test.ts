import { describe, expect, it } from 'vitest';
import type { TabInfo } from './tabs';
import { applyTabsUpdate, diffTabInfo } from './tabsUpdate';

const tab: TabInfo = {
  id: 1,
  url: 'https://example.com/',
  title: 'Example',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
};

describe('diffTabInfo', () => {
  it('returns everything when there is no previous value', () => {
    expect(diffTabInfo(undefined, tab)).toEqual(tab);
  });

  it('returns null when nothing changed', () => {
    expect(diffTabInfo(tab, { ...tab })).toBeNull();
  });

  it('returns only the changed fields', () => {
    expect(diffTabInfo(tab, { ...tab, isLoading: true, title: 'New' })).toEqual({
      isLoading: true,
      title: 'New',
    });
  });
});

describe('applyTabsUpdate', () => {
  it('merges changed fields and the active id', () => {
    const state = { activeId: 1, tabs: [tab, { ...tab, id: 2 }] };
    const next = applyTabsUpdate(state, { activeId: 2, tabs: { 1: { title: 'Changed' } } });
    expect(next.activeId).toBe(2);
    expect(next.tabs[0]?.title).toBe('Changed');
    expect(next.tabs[1]).toEqual(state.tabs[1]);
  });

  it('gives the same result when applied twice', () => {
    const state = { activeId: 1, tabs: [tab] };
    const update = { activeId: 1, tabs: { 1: { isLoading: true } } };
    const once = applyTabsUpdate(state, update);
    expect(applyTabsUpdate(once, update)).toEqual(once);
  });
});
