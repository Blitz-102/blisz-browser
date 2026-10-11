import { useState } from 'react';
import styles from './App.module.css';
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
        <div className={styles.dragRegion} />
        <div className={styles.address}>about:blank</div>
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
