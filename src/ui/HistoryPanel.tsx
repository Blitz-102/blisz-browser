import { useEffect, useRef, useState } from 'react';
import type { HistoryCursor, HistoryEntry } from '../shared/history';
import styles from './HistoryPanel.module.css';
import { XIcon } from './icons/icons';

const SEARCH_DEBOUNCE_MS = 200;

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

interface DayGroup {
  label: string;
  entries: HistoryEntry[];
}

// Entries arrive newest first, so each day's entries are consecutive.
function groupByDay(entries: HistoryEntry[]): DayGroup[] {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const groups: DayGroup[] = [];
  let currentDay = '';
  let group: DayGroup | undefined;
  for (const entry of entries) {
    const date = new Date(entry.lastVisitTime);
    const day = date.toDateString();
    if (day !== currentDay) {
      currentDay = day;
      const label =
        day === today.toDateString()
          ? 'Today'
          : day === yesterday.toDateString()
            ? 'Yesterday'
            : dateFormat.format(date);
      group = { label, entries: [] };
      groups.push(group);
    }
    group?.entries.push(entry);
  }
  return groups;
}

// Titles and URLs come from web pages; they are only ever rendered as text.
function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : '';
}

function entryLabel(entry: HistoryEntry): string {
  return entry.title || hostOf(entry.url) || entry.url;
}

interface HistoryPanelProps {
  onOpen: (url: string) => void;
}

// Mounted only while open, so nothing is loaded or observed while it is closed.
export function HistoryPanel({ onOpen }: HistoryPanelProps) {
  const [text, setText] = useState(''); // what is typed
  const [query, setQuery] = useState(''); // what was last searched, after the debounce
  const [cursor, setCursor] = useState<HistoryCursor | null>(null); // the page being loaded; null is the first
  const [retry, setRetry] = useState(0);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [next, setNext] = useState<HistoryCursor | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => searchRef.current?.focus(), []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(text);
      setCursor(null);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry re-runs a failed load
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    window.bliss
      .queryHistory(query, cursor)
      .then((page) => {
        if (cancelled) return;
        setEntries((previous) => (cursor ? [...previous, ...page.entries] : page.entries));
        setNext(page.next);
        setStatus('ready');
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to load history', error);
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [query, cursor, retry]);

  // Load the next page when the end of the list scrolls into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (status !== 'ready' || !next || !sentinel) return;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) setCursor(next);
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [status, next]);

  function remove(id: number, label: string, removeButton: HTMLElement) {
    window.bliss
      .deleteHistory(id)
      .then(() => {
        // The pressed button disappears, so focus goes to the next row, else the previous one, else the search box.
        const openButtons = Array.from(
          rootRef.current?.querySelectorAll<HTMLElement>(`.${styles.open}`) ?? [],
        );
        const index = openButtons.indexOf(removeButton.previousElementSibling as HTMLElement);
        (openButtons[index + 1] ?? openButtons[index - 1] ?? searchRef.current)?.focus();
        setEntries((previous) => previous.filter((entry) => entry.id !== id));
      })
      .catch((error) => console.error(`Failed to remove ${label} from history`, error));
  }

  const groups = groupByDay(entries);

  return (
    <div ref={rootRef} className={styles.root}>
      <div className={styles.content}>
        <input
          ref={searchRef}
          type="search"
          className={styles.search}
          aria-label="Search history"
          placeholder="Search history"
          value={text}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
        />
        {groups.map((group) => (
          <section key={group.label} className={styles.group}>
            <h2 className={styles.groupHeading}>{group.label}</h2>
            <ul className={styles.list}>
              {group.entries.map((entry) => {
                const label = entryLabel(entry);
                const host = hostOf(entry.url);
                return (
                  <li key={entry.id} className={styles.row}>
                    <button
                      type="button"
                      className={styles.open}
                      title={entry.url}
                      onClick={() => onOpen(entry.url)}
                    >
                      <span className={styles.tile} aria-hidden="true">
                        {Array.from(label)[0]?.toUpperCase()}
                      </span>
                      <span className={styles.text}>
                        <bdi className={styles.entryTitle}>{label}</bdi>
                        <span className={styles.host}>{host}</span>
                      </span>
                      <time
                        className={styles.time}
                        dateTime={new Date(entry.lastVisitTime).toISOString()}
                      >
                        {timeFormat.format(new Date(entry.lastVisitTime))}
                      </time>
                    </button>
                    <button
                      type="button"
                      className={styles.remove}
                      aria-label={`Remove ${label} from history`}
                      onClick={(event) => remove(entry.id, label, event.currentTarget)}
                    >
                      <XIcon />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {status === 'ready' && entries.length === 0 && (
          <p className={styles.message}>
            {query === '' ? 'No history yet' : <>No pages match “{query}”</>}
          </p>
        )}
        {status === 'error' && (
          <div className={styles.message} role="alert">
            <p className={styles.messageText}>Couldn't load history</p>
            <button type="button" className={styles.retry} onClick={() => setRetry(retry + 1)}>
              Try again
            </button>
          </div>
        )}
        <div ref={sentinelRef} />
      </div>
    </div>
  );
}
