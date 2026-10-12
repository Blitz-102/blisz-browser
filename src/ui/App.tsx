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
import { PinnedSites } from './PinnedSites';
import { TabList } from './TabList';

export function App() {
  const [memoryOpen, setMemoryOpen] = useState(false);
  // The tab state comes from main, which owns the tabs.
  const [tabsState, setTabsState] = useState<TabsState | null>(null);
  const activeTab = tabsState?.tabs.find((tab) => tab.id === tabsState.activeId);
  const isBlank = activeTab?.url === '';
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
  useEffect(() => setSubmitted(null), [activeTab?.url, activeTab?.isLoading]);

  // Switching tabs drops what was typed or submitted for the previous one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active tab is the trigger
  useEffect(() => {
    setDraft(null);
    setSubmitted(null);
  }, [tabsState?.activeId]);

  // A blank tab starts with the address field focused (main gives the UI focus when it activates one).
  // biome-ignore lint/correctness/useExhaustiveDependencies: switching between two blank tabs must focus too
  useEffect(() => {
    if (isBlank) addressRef.current?.focus();
  }, [isBlank, tabsState?.activeId]);

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
    if (!activeTab || draft === null) return;
    setMemoryOpen(false);
    const text = toNavigableUrl(draft);
    if (text !== '') setSubmitted(text);
    window.bliss.navigateTab(activeTab.id, draft).then((started) => {
      if (!started) setSubmitted(null);
    });
    setDraft(null);
  }

  function selectTab(id: number) {
    setMemoryOpen(false);
    window.bliss.activateTab(id);
  }

  function addTab() {
    setMemoryOpen(false);
    window.bliss.createTab();
  }

  return (
    <div className={styles.frame}>
      <nav className={styles.sidebar} aria-label="Tabs">
        <div className={styles.topStrip}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Back"
            disabled={!activeTab?.canGoBack}
            onClick={() => activeTab && window.bliss.tabGo(activeTab.id, 'back')}
          >
            <ArrowLeftIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Forward"
            disabled={!activeTab?.canGoForward}
            onClick={() => activeTab && window.bliss.tabGo(activeTab.id, 'forward')}
          >
            <ArrowRightIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={activeTab?.isLoading ? 'Stop' : 'Reload'}
            onClick={() =>
              activeTab && window.bliss.tabGo(activeTab.id, activeTab.isLoading ? 'stop' : 'reload')
            }
          >
            {activeTab?.isLoading ? <XIcon /> : <RotateCwIcon />}
          </button>
        </div>
        <div className={styles.address}>
          <input
            type="text"
            className={styles.addressInput}
            aria-label="Address"
            placeholder="Search or enter address"
            ref={addressRef}
            value={draft ?? submitted ?? activeTab?.url ?? ''}
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
        <TabList
          tabs={tabsState?.tabs ?? []}
          activeId={tabsState?.activeId ?? null}
          onSelect={selectTab}
          onClose={(id) => window.bliss.closeTab(id)}
          onNewTab={addTab}
        />
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
          isBlank && <p className={styles.placeholderTitle}>New tab</p>
        )}
      </main>
    </div>
  );
}
