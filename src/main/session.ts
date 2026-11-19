import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isWebUrl } from '../shared/url';
import { faviconFromDataUrl } from './favicon';

export interface SavedTab {
  entries: { url: string; title: string }[];
  index: number;
  favicon: string | null;
  active: boolean;
}

// The file is untrusted when read back, so these cap what one row can cost.
const MAX_TABS = 500;
const MAX_ENTRIES = 50;
const MAX_URL_LENGTH = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 4096;

// Replaces the saved session. Only url and title are stored: page state can hold form data.
export function writeSession(db: DatabaseSync, tabs: SavedTab[]): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM session_tab');
    const insertFavicon = db.prepare(
      'INSERT OR IGNORE INTO session_favicon (hash, data) VALUES (?, ?)',
    );
    const insertTab = db.prepare(
      'INSERT INTO session_tab (position, active, entry_index, entries, favicon) VALUES (?, ?, ?, ?, ?)',
    );
    for (const [position, tab] of tabs.entries()) {
      let hash: string | null = null;
      if (tab.favicon) {
        hash = createHash('sha256').update(tab.favicon).digest('hex');
        insertFavicon.run(hash, tab.favicon);
      }
      const entries = JSON.stringify(tab.entries.map(({ url, title }) => ({ url, title })));
      insertTab.run(position, tab.active ? 1 : 0, tab.index, entries, hash);
    }
    db.exec(
      'DELETE FROM session_favicon WHERE hash NOT IN (SELECT favicon FROM session_tab WHERE favicon IS NOT NULL)',
    );
    db.exec('COMMIT');
  } catch (error) {
    // SQLite may already have rolled back; a failing ROLLBACK would hide the real error.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function parseEntries(value: unknown): SavedTab['entries'] | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_ENTRIES) return null;
  const entries: SavedTab['entries'] = [];
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const { url, title } = item as Record<string, unknown>;
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH || !isWebUrl(url)) return null;
    if (typeof title !== 'string') return null;
    // Chromium doesn't cap titles, so a long one is cut rather than losing the tab.
    entries.push({ url, title: title.slice(0, MAX_TITLE_LENGTH) });
  }
  return entries;
}

// Tabs that fail a check are dropped; exactly one of the rest is active. Never throws.
export function readSession(db: DatabaseSync): SavedTab[] {
  try {
    const rows = db
      .prepare(
        `SELECT t.active, t.entry_index, t.entries, f.data
           FROM session_tab t LEFT JOIN session_favicon f ON f.hash = t.favicon
          ORDER BY t.position LIMIT ${MAX_TABS}`,
      )
      .all();
    const tabs: SavedTab[] = [];
    let activeIndex = -1;
    for (const row of rows) {
      const entries = parseEntries(row.entries);
      const index = row.entry_index;
      if (!entries || typeof index !== 'number' || !Number.isInteger(index)) continue;
      if (index < 0 || index >= entries.length) continue;
      if (row.active === 1 && activeIndex === -1) activeIndex = tabs.length;
      tabs.push({ entries, index, favicon: faviconFromDataUrl(row.data), active: false });
    }
    const active = tabs[Math.max(activeIndex, 0)];
    if (active) active.active = true;
    return tabs;
  } catch {
    return [];
  }
}
