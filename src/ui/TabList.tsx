import { useEffect, useRef } from 'react';
import { PlusIcon, XIcon } from './icons/icons';
import type { Tab } from './mockData';
import styles from './TabList.module.css';

interface TabListProps {
  tabs: Tab[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
}

export function TabList({ tabs, onSelect, onClose, onNewTab }: TabListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const focusAfterClose = useRef(false);

  // Closing a tab removes the focused button, so hand focus to the active tab (or the list when empty).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each tabs change, but only acts once a close was requested
  useEffect(() => {
    if (!focusAfterClose.current) return;
    focusAfterClose.current = false;
    const activeButton = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    (activeButton ?? listRef.current)?.focus();
  }, [tabs]);

  return (
    <ul ref={listRef} className={styles.list} aria-label="Open tabs" tabIndex={-1}>
      {tabs.map((tab) => (
        <li
          key={tab.id}
          className={tab.state === 'active' ? `${styles.row} ${styles.rowActive}` : styles.row}
        >
          <button
            type="button"
            className={styles.select}
            aria-current={tab.state === 'active' ? 'page' : undefined}
            onClick={() => onSelect(tab.id)}
          >
            <span
              className={
                tab.state === 'sleeping'
                  ? `${styles.favicon} ${styles.faviconSleeping}`
                  : styles.favicon
              }
              aria-hidden="true"
            >
              {tab.title[0]}
            </span>
            <span className={tab.state === 'sleeping' ? styles.titleSleeping : styles.title}>
              {tab.title}
              {tab.state === 'sleeping' && <span className="visually-hidden">, sleeping</span>}
            </span>
          </button>
          <button
            type="button"
            className={styles.close}
            aria-label={`Close ${tab.title}`}
            onClick={() => {
              focusAfterClose.current = true;
              onClose(tab.id);
            }}
          >
            <XIcon />
          </button>
        </li>
      ))}
      <li className={styles.row}>
        <button type="button" className={styles.select} onClick={onNewTab}>
          <PlusIcon />
          <span className={styles.title}>New tab</span>
        </button>
      </li>
    </ul>
  );
}
