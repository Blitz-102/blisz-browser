import { describe, expect, it } from 'vitest';
import type { TabInfo, TabsState } from './tabs';
import { applyTabsUpdate, diffTabInfo } from './tabsUpdate';

const tab: TabInfo = {
  id: 1,
  url: 'https://example.com/',
  title: 'Example',
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

const state: TabsState = { activeId: 1, order: [1, 2], tabs: [tab, { ...tab, id: 2 }] };

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

  it('reports a favicon change', () => {
    const favicon = 'data:image/png;base64,AAAA';
    expect(diffTabInfo(tab, { ...tab, favicon })).toEqual({ favicon });
  });

  it('reports a changed blocked popup count and zoom', () => {
    expect(diffTabInfo(tab, { ...tab, blockedPopups: 2, zoom: 1.1 })).toEqual({
      blockedPopups: 2,
      zoom: 1.1,
    });
  });
});

describe('prompt and error', () => {
  const prompt = { id: 1, kind: 'camera', origin: 'https://example.com', target: '' } as const;
  const error = {
    kind: 'network',
    code: -102,
    description: 'ERR_CONNECTION_REFUSED',
    url: 'http://example.com/',
  } as const;

  it('reports a prompt or error appearing and clearing', () => {
    expect(diffTabInfo(tab, { ...tab, prompt })).toEqual({ prompt });
    expect(diffTabInfo({ ...tab, prompt }, tab)).toEqual({ prompt: null });
    expect(diffTabInfo(tab, { ...tab, error })).toEqual({ error });
    expect(diffTabInfo({ ...tab, error }, tab)).toEqual({ error: null });
  });

  it('applies and clears them in the state', () => {
    const shown = applyTabsUpdate(state, {
      activeId: 1,
      order: [1, 2],
      tabs: { 1: { prompt, error: { kind: 'crashed' } } },
    });
    expect(shown.tabs[0]).toMatchObject({ prompt, error: { kind: 'crashed' } });
    const cleared = applyTabsUpdate(shown, {
      activeId: 1,
      order: [1, 2],
      tabs: { 1: { prompt: null, error: null } },
    });
    expect(cleared.tabs[0]).toMatchObject({ prompt: null, error: null });
  });
});

describe('applyTabsUpdate', () => {
  it('merges changed fields and the active id', () => {
    const next = applyTabsUpdate(state, {
      activeId: 2,
      order: [1, 2],
      tabs: { 1: { title: 'Changed' } },
    });
    expect(next.activeId).toBe(2);
    expect(next.tabs[0]?.title).toBe('Changed');
    expect(next.tabs[1]).toEqual(state.tabs[1]);
  });

  it('adds a new tab at its place in the order', () => {
    const added = { ...tab, id: 3, title: 'Added' };
    const next = applyTabsUpdate(state, {
      activeId: 3,
      order: [1, 3, 2],
      tabs: { 3: added },
    });
    expect(next.order).toEqual([1, 3, 2]);
    expect(next.tabs[1]).toEqual(added);
  });

  it('removes tabs and follows the new order', () => {
    const next = applyTabsUpdate(state, { activeId: 2, order: [2], tabs: {} });
    expect(next.order).toEqual([2]);
    expect(next.tabs).toEqual([state.tabs[1]]);
  });

  it('applies blocked popup and zoom changes', () => {
    const next = applyTabsUpdate(state, {
      activeId: 1,
      order: [1, 2],
      tabs: { 2: { blockedPopups: 1, zoom: 1.25 } },
    });
    expect(next.tabs[1]).toMatchObject({ blockedPopups: 1, zoom: 1.25 });
  });

  it('gives the same result when applied twice', () => {
    const update = {
      activeId: 3,
      order: [3, 2],
      tabs: { 3: { ...tab, id: 3 }, 2: { isLoading: true } },
    };
    const once = applyTabsUpdate(state, update);
    expect(applyTabsUpdate(once, update)).toEqual(once);
  });
});
