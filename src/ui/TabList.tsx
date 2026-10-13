import { useEffect, useRef } from 'react';
import type { TabInfo } from '../shared/tabs';
import { PlusIcon, XIcon } from './icons/icons';
import styles from './TabList.module.css';

interface TabListProps {
  tabs: TabInfo[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNewTab: () => void;
  onContextMenu: (id: number) => void;
}

// Titles and URLs come from web pages; they are only ever rendered as text.
function tabLabel(tab: TabInfo): string {
  if (tab.title !== '') return tab.title;
  if (URL.canParse(tab.url)) return new URL(tab.url).host || tab.url;
  return 'New tab';
}

export function TabList({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewTab,
  onContextMenu,
}: TabListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const closingId = useRef<number | null>(null);

  // Closing a tab removes the focused button, so once that tab is gone hand focus to the active tab.
  useEffect(() => {
    if (closingId.current === null || tabs.some((tab) => tab.id === closingId.current)) return;
    closingId.current = null;
    const activeButton = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    (activeButton ?? listRef.current)?.focus();
  }, [tabs]);

  return (
    <ul ref={listRef} className={styles.list} aria-label="Open tabs" tabIndex={-1}>
      {tabs.map((tab) => {
        const label = tabLabel(tab);
        const isActive = tab.id === activeId;
        return (
          <li
            key={tab.id}
            className={isActive ? `${styles.row} ${styles.rowActive}` : styles.row}
            onContextMenu={() => onContextMenu(tab.id)}
          >
            <button
              type="button"
              className={styles.select}
              aria-current={isActive ? 'page' : undefined}
              aria-busy={tab.isLoading}
              onClick={() => onSelect(tab.id)}
            >
              {tab.favicon ? (
                <img className={styles.faviconImage} src={tab.favicon} alt="" />
              ) : (
                <span className={styles.favicon} aria-hidden="true">
                  {Array.from(label)[0]?.toUpperCase()}
                </span>
              )}
              <span className={styles.title}>{label}</span>
              {tab.isLoading && <span className={styles.spinner} aria-hidden="true" />}
            </button>
            <button
              type="button"
              className={styles.close}
              aria-label={`Close ${label}`}
              onClick={() => {
                closingId.current = tab.id;
                onClose(tab.id);
              }}
            >
              <XIcon />
            </button>
          </li>
        );
      })}
      <li className={styles.row}>
        <button type="button" className={styles.select} onClick={onNewTab}>
          <PlusIcon />
          <span className={styles.title}>New tab</span>
        </button>
      </li>
    </ul>
  );
}
