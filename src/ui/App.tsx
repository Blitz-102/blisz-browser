import styles from './App.module.css';

const tabs = [
  { title: 'Example tab', active: true },
  { title: 'Another tab', active: false },
  { title: 'Third tab', active: false },
];

export function App() {
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
      </nav>
      <main className={styles.page}>No page loaded</main>
    </div>
  );
}
