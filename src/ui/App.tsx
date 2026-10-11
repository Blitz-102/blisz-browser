import { useState } from 'react';
import styles from './App.module.css';
import { ArrowLeftIcon, ArrowRightIcon, RotateCwIcon, ShieldIcon } from './icons/icons';
import { MemoryPanel } from './MemoryPanel';

const tabs = [
  { title: 'Example tab', active: true },
  { title: 'Another tab', active: false },
  { title: 'Third tab', active: false },
];

export function App() {
  const [memoryOpen, setMemoryOpen] = useState(false);

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
            defaultValue="https://example.com"
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className={styles.iconButton} aria-label="Ad blocker">
            <ShieldIcon />
          </button>
        </div>
        <ul className={styles.tabList}>
          {tabs.map((tab) => (
            <li key={tab.title}>
              <button
                type="button"
                aria-current={tab.active ? 'true' : undefined}
                className={tab.active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              >
                {tab.title}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={
            memoryOpen
              ? `${styles.tab} ${styles.tabActive} ${styles.memoryToggle}`
              : `${styles.tab} ${styles.memoryToggle}`
          }
          aria-pressed={memoryOpen}
          onClick={() => setMemoryOpen(!memoryOpen)}
        >
          Memory
        </button>
      </nav>
      <main className={styles.page}>{memoryOpen ? <MemoryPanel /> : 'No page loaded'}</main>
    </div>
  );
}
