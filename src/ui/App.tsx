import { useState } from 'react';
import styles from './App.module.css';
import {
  ActivityIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  RotateCwIcon,
  ShieldIcon,
} from './icons/icons';
import { MemoryPanel } from './MemoryPanel';
import { initialTabs, type Tab } from './mockData';
import { PinnedSites } from './PinnedSites';
import { TabList } from './TabList';

export function App() {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [tabs, setTabs] = useState(initialTabs);
  const activeTab = tabs.find((tab) => tab.state === 'active');

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
          <button type="button" className={styles.iconButton} aria-label="Back">
            <ArrowLeftIcon />
          </button>
          <button type="button" className={styles.iconButton} aria-label="Forward">
            <ArrowRightIcon />
          </button>
          <button type="button" className={styles.iconButton} aria-label="Reload">
            <RotateCwIcon />
          </button>
        </div>
        <div className={styles.address}>
          <input
            type="text"
            className={styles.addressInput}
            aria-label="Address"
            placeholder="Search or enter address"
            key={activeTab?.id}
            defaultValue={activeTab?.url}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
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
      <main className={styles.page}>
        {memoryOpen ? (
          <MemoryPanel />
        ) : activeTab ? (
          <div className={styles.placeholder}>
            <p className={styles.placeholderTitle}>{activeTab.title}</p>
            <p className={styles.placeholderUrl}>{activeTab.url}</p>
          </div>
        ) : (
          <p className={styles.placeholderTitle}>No tab open</p>
        )}
      </main>
    </div>
  );
}
