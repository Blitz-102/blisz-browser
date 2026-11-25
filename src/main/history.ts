import type { DatabaseSync } from 'node:sqlite';
import { app } from 'electron';
import { BIDI_CONTROLS } from '../shared/bidi';
import type { HistoryCursor, HistoryEntry, HistoryPage } from '../shared/history';
import { isWebUrl } from '../shared/url';
import { handleFromUi } from './ipc';

export type VisitType = 'typed' | 'link' | 'reload' | 'back_forward' | 'other';

interface Visit {
  url: string; // already a history key
  type: VisitType;
  time: number;
}

export interface HistoryRecorder {
  recordVisit: (url: string, type: VisitType) => void;
  updateTitle: (url: string, title: string) => void;
  flush: () => void;
}

const MAX_URL_LENGTH = 8 * 1024;
const MAX_TITLE_LENGTH = 4096;
const PAGE_SIZE = 100;
const MAX_TERMS = 8;
const MAX_QUERY_LENGTH = 200;
const FLUSH_DELAY_MS = 2000;
// A page can't grow the queue (or the database) without limit between flushes: extra visits are dropped.
const MAX_PENDING_VISITS = 500;

// History is stored as plaintext, so what could carry a secret is dropped: credentials in the URL and
// the #fragment (OAuth tokens). Null for anything that should not be recorded.
export function historyKey(url: string): string | null {
  if (!isWebUrl(url)) return null;
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.href.length > MAX_URL_LENGTH ? null : parsed.href;
}

// Records the visits and then the titles in one transaction. A title only updates a page that has
// a row, so a page that was never recorded (a 404, say) doesn't get one.
export function writeHistory(db: DatabaseSync, visits: Visit[], titles: Map<string, string>): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const upsertUrl = db.prepare(
      `INSERT INTO history_url (url, last_visit_time) VALUES (?, ?)
         ON CONFLICT(url) DO UPDATE SET last_visit_time = max(last_visit_time, excluded.last_visit_time)
         RETURNING id`,
    );
    const insertVisit = db.prepare(
      'INSERT INTO history_visit (url_id, visit_time, type) VALUES (?, ?, ?)',
    );
    for (const { url, type, time } of visits) {
      const row = upsertUrl.get(url, time) as { id: number };
      insertVisit.run(row.id, time, type);
    }
    const updateTitle = db.prepare('UPDATE history_url SET title = ? WHERE url = ? AND title <> ?');
    for (const [url, title] of titles) updateTitle.run(title, url, title);
    db.exec('COMMIT');
  } catch (error) {
    // SQLite may already have rolled back; a failing ROLLBACK would hide the real error.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

// Each word must appear in the URL or the title (case-insensitive for ASCII). Newest page first,
// 100 per page; the cursor is the last entry of the previous page.
export function queryHistory(
  db: DatabaseSync,
  text: string,
  cursor: HistoryCursor | null,
): HistoryPage {
  const terms = text.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  for (const term of terms) {
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push("(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (cursor) {
    conditions.push('(last_visit_time < ? OR (last_visit_time = ? AND id < ?))');
    params.push(cursor.time, cursor.time, cursor.id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT id, url, title, last_visit_time FROM history_url ${where}
        ORDER BY last_visit_time DESC, id DESC LIMIT ${PAGE_SIZE + 1}`,
    )
    .all(...params);
  const entries: HistoryEntry[] = rows.slice(0, PAGE_SIZE).map((row) => ({
    id: row.id as number,
    url: row.url as string,
    title: row.title as string,
    lastVisitTime: row.last_visit_time as number,
  }));
  const last = entries.at(-1);
  const next = rows.length > PAGE_SIZE && last ? { time: last.lastVisitTime, id: last.id } : null;
  return { entries, next };
}

// The visits go with it (ON DELETE CASCADE). An unknown id does nothing.
export function deleteHistoryUrl(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM history_url WHERE id = ?').run(id);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Visits and titles are queued and written together at most every FLUSH_DELAY_MS, so a busy page
// costs one transaction, not one per event. Without a database nothing is recorded.
export function initHistory(db: DatabaseSync | null): HistoryRecorder {
  let pendingVisits: Visit[] = [];
  let pendingTitles = new Map<string, string>();
  let flushTimer: NodeJS.Timeout | undefined;

  function flush(): void {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    const visits = pendingVisits;
    const titles = pendingTitles;
    pendingVisits = [];
    pendingTitles = new Map();
    if (!db || (visits.length === 0 && titles.size === 0)) return;
    try {
      writeHistory(db, visits, titles);
    } catch (error) {
      // The queues are dropped either way. Message only: it must never carry a URL or title.
      if (!app.isPackaged) console.warn('Could not save history:', (error as Error).message);
    }
  }

  function schedule(): void {
    flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);
  }

  handleFromUi('history:query', (_event, text, cursor): HistoryPage => {
    if (typeof text !== 'string' || text.length > MAX_QUERY_LENGTH) throw new Error('Bad text');
    if (cursor !== null) {
      if (typeof cursor !== 'object') throw new Error('Bad cursor');
      const { time, id } = cursor as Record<string, unknown>;
      if (!isSafeCount(time) || !isSafeCount(id)) throw new Error('Bad cursor');
    }
    if (!db) return { entries: [], next: null };
    flush();
    return queryHistory(db, text, cursor as HistoryCursor | null);
  });
  handleFromUi('history:delete', (_event, id) => {
    if (!isSafeCount(id) || id === 0) throw new Error('Bad id');
    if (!db) return;
    flush();
    deleteHistoryUrl(db, id);
  });

  return {
    recordVisit(url, type) {
      const key = historyKey(url);
      if (!key) return;
      if (pendingVisits.length >= MAX_PENDING_VISITS) return;
      pendingVisits.push({ url: key, type, time: Date.now() });
      schedule();
    },
    updateTitle(url, title) {
      const key = historyKey(url);
      const clean = title.replace(BIDI_CONTROLS, '').slice(0, MAX_TITLE_LENGTH);
      if (!key || clean === '') return;
      pendingTitles.set(key, clean);
      schedule();
    },
    flush,
  };
}
