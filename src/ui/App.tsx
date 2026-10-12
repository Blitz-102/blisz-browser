import { useEffect, useRef, useState } from 'react';
import { toNavigableUrl } from '../shared/address';
import type { TabsState } from '../shared/tabs';
import { applyTabsUpdate } from '../shared/tabsUpdate';
import styles from './App.module.css';
import {
  ActivityIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  RotateCwIcon,
  ShieldIcon,
  XIcon,
} from './icons/icons';
import { MemoryPanel } from './MemoryPanel';
import { initialTabs, type Tab } from './mockData';
import { PinnedSites } from './PinnedSites';
import { TabList } from './TabList';

export function App() {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [tabs, setTabs] = useState(initialTabs);
  const activeTab = tabs.find((tab) => tab.state === 'active');

  // The real tab state comes from main. The mock tabs above are replaced in the next step.
  const [tabsState, setTabsState] = useState<TabsState | null>(null);
  const realTab = tabsState?.tabs.find((tab) => tab.id === tabsState.activeId);
  const isBlank = realTab?.url === '';
  // Text the user is typing in the address field; null shows the tab's URL.
  const [draft, setDraft] = useState<string | null>(null);
  // What was just submitted, shown until the tab reports its new URL so the field doesn't flicker.
  const [submitted, setSubmitted] = useState<string | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLElement>(null);

  useEffect(() => {
    window.bliss.getTabsState().then(setTabsState);
    return window.bliss.onTabsUpdate((update) =>
      setTabsState((state) => state && applyTabsUpdate(state, update)),
    );
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the URL and loading state are the triggers
  useEffect(() => setSubmitted(null), [realTab?.url, realTab?.isLoading]);

  // A blank tab starts with the address field focused.
  useEffect(() => {
    if (isBlank) addressRef.current?.focus();
  }, [isBlank]);

  // Tell main where the page goes. While the memory panel is open it takes the page's place.
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const report = () => {
      const { x, y, width, height } = page.getBoundingClientRect();
      const radius = Number.parseFloat(getComputedStyle(page).borderTopLeftRadius) || 0;
      window.bliss
        .setPageArea({ x, y, width, height, radius, hidden: memoryOpen })
        .catch((error) => console.warn('Could not set the page area:', error));
    };
    const observer = new ResizeObserver(report);
    observer.observe(page);
    return () => observer.disconnect();
  }, [memoryOpen]);

  function submitAddress() {
    if (!realTab || draft === null) return;
    setMemoryOpen(false);
    const text = toNavigableUrl(draft);
    if (text !== '') setSubmitted(text);
    window.bliss.navigateTab(realTab.id, draft).then((started) => {
      if (!started) setSubmitted(null);
    });
    setDraft(null);
  }

  // A tab that becomes active wakes up; the previously active one goes back to normal.
  function selectTab(id: string) {
    setTabs(
      tabs.map((tab): Tab => {
        if (tab.id === id) return { ...tab, state: 'active' };
        return tab.state === 'active' ? { ...tab, state: 'normal' } : tab;
      }),
    );
  }

  function closeTab(id: string) {
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    if (id === activeTab?.id && remaining.length > 0) {
      const neighbour = remaining[Math.min(index, remaining.length - 1)];
      setTabs(remaining.map((tab): Tab => (tab === neighbour ? { ...tab, state: 'active' } : tab)));
    } else {
      setTabs(remaining);
    }
  }

  function addTab() {
    const newTab: Tab = { id: crypto.randomUUID(), title: 'New tab', url: '', state: 'active' };
    setTabs([
      ...tabs.map((tab): Tab => (tab.state === 'active' ? { ...tab, state: 'normal' } : tab)),
      newTab,
    ]);
  }

  return (
    <div className={styles.frame}>
      <nav className={styles.sidebar} aria-label="Tabs">
        <div className={styles.topStrip}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Back"
            disabled={!realTab?.canGoBack}
            onClick={() => realTab && window.bliss.tabGo(realTab.id, 'back')}
          >
            <ArrowLeftIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Forward"
            disabled={!realTab?.canGoForward}
            onClick={() => realTab && window.bliss.tabGo(realTab.id, 'forward')}
          >
            <ArrowRightIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={realTab?.isLoading ? 'Stop' : 'Reload'}
            onClick={() =>
              realTab && window.bliss.tabGo(realTab.id, realTab.isLoading ? 'stop' : 'reload')
            }
          >
            {realTab?.isLoading ? <XIcon /> : <RotateCwIcon />}
          </button>
        </div>
        <div className={styles.address}>
          <input
            type="text"
            className={styles.addressInput}
            aria-label="Address"
            placeholder="Search or enter address"
            ref={addressRef}
            value={draft ?? submitted ?? realTab?.url ?? ''}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => setDraft(null)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitAddress();
              if (event.key === 'Escape') {
                setDraft(null);
                setSubmitted(null);
                event.currentTarget.blur();
              }
            }}
          />
          <button type="button" className={styles.iconButton} aria-label="Ad blocker">
            <ShieldIcon />
          </button>
        </div>
        <PinnedSites />
        <TabList tabs={tabs} onSelect={selectTab} onClose={closeTab} onNewTab={addTab} />
        <button
          type="button"
          className={styles.memoryToggle}
          aria-pressed={memoryOpen}
          onClick={() => setMemoryOpen(!memoryOpen)}
        >
          <ActivityIcon />
          Memory
        </button>
      </nav>
      <main ref={pageRef} className={styles.page}>
        {memoryOpen ? (
          <MemoryPanel />
        ) : (
          isBlank &&
          (activeTab ? (
            <div className={styles.placeholder}>
              <p className={styles.placeholderTitle}>{activeTab.title}</p>
              <p className={styles.placeholderUrl}>{activeTab.url}</p>
            </div>
          ) : (
            <p className={styles.placeholderTitle}>No tab open</p>
          ))
        )}
      </main>
    </div>
  );
}
