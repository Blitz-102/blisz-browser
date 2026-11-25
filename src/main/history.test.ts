import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database';
import { deleteHistoryUrl, historyKey, initHistory, queryHistory, writeHistory } from './history';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const handlers = new Map<string, Handler>();
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('./ipc', () => ({
  handleFromUi: (channel: string, handler: Handler) => handlers.set(channel, handler),
}));

let dir: string;
let db: DatabaseSync;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blisz-history-test-'));
  db = openDatabase(join(dir, 'blisz.db')) as DatabaseSync;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const visit = (url: string, time = 1000) => ({ url, type: 'link' as const, time });
const noTitles = new Map<string, string>();
const count = (table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const titleOf = (url: string) =>
  (db.prepare('SELECT title FROM history_url WHERE url = ?').get(url) as { title: string }).title;

describe('historyKey', () => {
  it('keeps web URLs and strips credentials and the fragment', () => {
    expect(historyKey('https://user:pass@example.com/a?q=1#access_token=secret')).toBe(
      'https://example.com/a?q=1',
    );
  });

  it('skips anything that is not http(s)', () => {
    expect(historyKey('about:blank')).toBeNull();
    expect(historyKey('file:///C:/secret.txt')).toBeNull();
    expect(historyKey('javascript:alert(1)')).toBeNull();
    expect(historyKey('not a url')).toBeNull();
  });

  it('skips URLs over 8 KiB', () => {
    expect(historyKey(`https://example.com/${'a'.repeat(8 * 1024)}`)).toBeNull();
    expect(historyKey(`https://example.com/${'a'.repeat(1000)}`)).not.toBeNull();
  });
});

describe('writeHistory', () => {
  it('stores a visit as one url row and one visit row', () => {
    writeHistory(db, [visit('https://example.com/', 1234)], noTitles);
    expect(db.prepare('SELECT url, last_visit_time FROM history_url').all()).toEqual([
      { url: 'https://example.com/', last_visit_time: 1234 },
    ]);
    expect(db.prepare('SELECT visit_time, type FROM history_visit').all()).toEqual([
      { visit_time: 1234, type: 'link' },
    ]);
  });

  it('keeps one url row for repeat visits and bumps its time', () => {
    writeHistory(db, [visit('https://example.com/', 1000)], noTitles);
    writeHistory(db, [visit('https://example.com/', 2000)], noTitles);
    expect(count('history_url')).toBe(1);
    expect(count('history_visit')).toBe(2);
    expect(db.prepare('SELECT last_visit_time FROM history_url').get()).toEqual({
      last_visit_time: 2000,
    });
  });

  it('never moves last_visit_time backwards', () => {
    writeHistory(
      db,
      [visit('https://example.com/', 2000), visit('https://example.com/', 1000)],
      noTitles,
    );
    expect(db.prepare('SELECT last_visit_time FROM history_url').get()).toEqual({
      last_visit_time: 2000,
    });
  });

  it('attaches a title to the right page, even for a visit in the same batch', () => {
    writeHistory(
      db,
      [visit('https://a.example/'), visit('https://b.example/')],
      new Map([['https://b.example/', 'Page B']]),
    );
    expect(titleOf('https://a.example/')).toBe('');
    expect(titleOf('https://b.example/')).toBe('Page B');
  });

  it('inserts nothing for a title of an unknown page', () => {
    writeHistory(db, [], new Map([['https://unknown.example/', 'Title']]));
    expect(count('history_url')).toBe(0);
  });

  it('ignores an empty title', () => {
    writeHistory(db, [visit('https://example.com/')], new Map([['https://example.com/', 'Real']]));
    const recorder = initHistory(db);
    recorder.updateTitle('https://example.com/', '');
    recorder.flush();
    expect(titleOf('https://example.com/')).toBe('Real');
  });

  it('rolls back everything when a write fails', () => {
    db.exec('DROP TABLE history_visit');
    expect(() => writeHistory(db, [visit('https://example.com/')], noTitles)).toThrow();
    expect(db.isTransaction).toBe(false);
    expect(count('history_url')).toBe(0);
  });
});

describe('initHistory recorder', () => {
  it('queues visits until flush and skips pages that should not be recorded', () => {
    const recorder = initHistory(db);
    recorder.recordVisit('https://example.com/', 'typed');
    recorder.recordVisit('about:blank', 'link');
    recorder.recordVisit('file:///C:/a.txt', 'link');
    recorder.recordVisit(`https://example.com/${'a'.repeat(9000)}`, 'link');
    expect(count('history_url')).toBe(0);
    recorder.flush();
    expect(count('history_url')).toBe(1);
    expect(db.prepare('SELECT type FROM history_visit').get()).toEqual({ type: 'typed' });
  });

  it('strips userinfo and the fragment, and a title still matches with a fragment', () => {
    const recorder = initHistory(db);
    recorder.recordVisit('https://me:pw@example.com/p#token', 'link');
    recorder.updateTitle('https://me:pw@example.com/p#other', 'Title');
    recorder.flush();
    expect(db.prepare('SELECT url, title FROM history_url').all()).toEqual([
      { url: 'https://example.com/p', title: 'Title' },
    ]);
  });

  it('cuts titles at 4096 characters', () => {
    const recorder = initHistory(db);
    recorder.recordVisit('https://example.com/', 'link');
    recorder.updateTitle('https://example.com/', 'x'.repeat(5000));
    recorder.flush();
    expect(titleOf('https://example.com/')).toHaveLength(4096);
  });

  it('strips bidirectional control characters from titles', () => {
    const recorder = initHistory(db);
    recorder.recordVisit('https://example.com/', 'link');
    recorder.updateTitle('https://example.com/', '‮evil‬ ⁦title⁩');
    recorder.flush();
    expect(titleOf('https://example.com/')).toBe('evil title');
  });

  it('drops visits beyond 500 per flush', () => {
    const recorder = initHistory(db);
    for (let i = 0; i < 600; i++) recorder.recordVisit(`https://example.com/${i}`, 'link');
    recorder.flush();
    expect(count('history_visit')).toBe(500);
    recorder.recordVisit('https://example.com/next', 'link'); // the queue is empty again
    recorder.flush();
    expect(count('history_visit')).toBe(501);
  });

  it('writes by itself after the throttle delay', () => {
    vi.useFakeTimers();
    try {
      const recorder = initHistory(db);
      recorder.recordVisit('https://example.com/', 'link');
      vi.advanceTimersByTime(1999);
      expect(count('history_url')).toBe(0);
      vi.advanceTimersByTime(1);
      expect(count('history_url')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('empties its queues when a write fails', () => {
    const recorder = initHistory(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.exec('DROP TABLE history_visit');
    recorder.recordVisit('https://secret.example/', 'link');
    recorder.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret.example');
    warn.mockRestore();
    db.exec(
      'CREATE TABLE history_visit (id INTEGER PRIMARY KEY, url_id INTEGER NOT NULL REFERENCES history_url (id) ON DELETE CASCADE, visit_time INTEGER NOT NULL, type TEXT NOT NULL) STRICT',
    );
    recorder.flush();
    expect(count('history_url')).toBe(0);
  });
});

describe('queryHistory', () => {
  it('returns the newest page first, and everything for empty text', () => {
    writeHistory(
      db,
      [
        visit('https://old.example/', 1000),
        visit('https://new.example/', 3000),
        visit('https://mid.example/', 2000),
      ],
      noTitles,
    );
    const page = queryHistory(db, '  ', null);
    expect(page.entries.map((entry) => entry.url)).toEqual([
      'https://new.example/',
      'https://mid.example/',
      'https://old.example/',
    ]);
    expect(page.entries[0]).toEqual({
      id: expect.any(Number),
      url: 'https://new.example/',
      title: '',
      lastVisitTime: 3000,
    });
    expect(page.next).toBeNull();
  });

  it('pages 250 rows with equal timestamps without duplicates or gaps', () => {
    const visits = Array.from({ length: 250 }, (_, index) =>
      visit(`https://example.com/${index}`, 5000),
    );
    writeHistory(db, visits, noTitles);
    const seen: number[] = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = queryHistory(db, '', cursor);
      seen.push(...page.entries.map((entry) => entry.id));
      cursor = page.next;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
  });

  it('gives no next page when exactly one page of rows exists', () => {
    writeHistory(
      db,
      Array.from({ length: 100 }, (_, i) => visit(`https://example.com/${i}`)),
      noTitles,
    );
    const page = queryHistory(db, '', null);
    expect(page.entries).toHaveLength(100);
    expect(page.next).toBeNull();
  });

  it('matches the url or the title, ignoring ASCII case', () => {
    writeHistory(
      db,
      [visit('https://example.com/Alpha'), visit('https://other.example/')],
      new Map([['https://other.example/', 'Great BETA page']]),
    );
    expect(queryHistory(db, 'alpha', null).entries).toHaveLength(1);
    expect(queryHistory(db, 'beta', null).entries.map((entry) => entry.url)).toEqual([
      'https://other.example/',
    ]);
    expect(queryHistory(db, 'missing', null).entries).toHaveLength(0);
  });

  it('treats %, _ and backslash literally', () => {
    writeHistory(
      db,
      [
        visit('https://example.com/100%25', 1),
        visit('https://example.com/a_b', 2),
        visit('https://example.com/axb', 3),
        visit('https://example.com/back\\slash', 4),
      ],
      noTitles,
    );
    expect(queryHistory(db, '%', null).entries.map((entry) => entry.url)).toEqual([
      'https://example.com/100%25',
    ]);
    expect(queryHistory(db, 'a_b', null).entries.map((entry) => entry.url)).toEqual([
      'https://example.com/a_b',
    ]);
    expect(queryHistory(db, '\\', null).entries.map((entry) => entry.url)).toEqual([
      'https://example.com/back\\slash',
    ]);
  });

  it('requires every term to match', () => {
    writeHistory(
      db,
      [visit('https://example.com/one'), visit('https://example.com/two')],
      new Map([['https://example.com/two', 'about cats']]),
    );
    expect(queryHistory(db, 'example cats', null).entries.map((entry) => entry.url)).toEqual([
      'https://example.com/two',
    ]);
    expect(queryHistory(db, 'one cats', null).entries).toHaveLength(0);
  });

  it('uses at most 8 terms', () => {
    writeHistory(db, [visit('https://example.com/a')], noTitles);
    expect(queryHistory(db, 'a a a a a a a a zzz', null).entries).toHaveLength(1);
  });
});

describe('deleteHistoryUrl', () => {
  it('removes the page and its visits', () => {
    writeHistory(
      db,
      [visit('https://a.example/'), visit('https://a.example/', 2), visit('https://b.example/')],
      noTitles,
    );
    const { entries } = queryHistory(db, 'a.example', null);
    deleteHistoryUrl(db, entries[0]?.id as number);
    expect(count('history_url')).toBe(1);
    expect(count('history_visit')).toBe(1);
    expect(
      db
        .prepare('SELECT count(*) AS n FROM history_visit WHERE url_id = ?')
        .get(entries[0]?.id as number),
    ).toEqual({ n: 0 });
  });

  it('does nothing for an unknown id', () => {
    writeHistory(db, [visit('https://a.example/')], noTitles);
    deleteHistoryUrl(db, 9999);
    expect(count('history_url')).toBe(1);
  });
});

describe('history IPC', () => {
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);

  beforeEach(() => {
    handlers.clear();
  });

  it('flushes queued visits before a query', () => {
    const recorder = initHistory(db);
    recorder.recordVisit('https://example.com/', 'link');
    expect(call('history:query', '', null)).toMatchObject({
      entries: [{ url: 'https://example.com/' }],
      next: null,
    });
  });

  it('flushes before a delete and deletes the page', () => {
    const recorder = initHistory(db);
    recorder.recordVisit('https://example.com/', 'link');
    recorder.flush();
    const { entries } = call('history:query', '', null) as ReturnType<typeof queryHistory>;
    call('history:delete', entries[0]?.id);
    expect(count('history_url')).toBe(0);
  });

  it('rejects bad arguments', () => {
    initHistory(db);
    expect(() => call('history:query', 5, null)).toThrow('Bad text');
    expect(() => call('history:query', 'x'.repeat(201), null)).toThrow('Bad text');
    expect(() => call('history:query', '', undefined)).toThrow('Bad cursor');
    expect(() => call('history:query', '', 'x')).toThrow('Bad cursor');
    expect(() => call('history:query', '', { time: 1 })).toThrow('Bad cursor');
    expect(() => call('history:query', '', { time: -1, id: 1 })).toThrow('Bad cursor');
    expect(() => call('history:query', '', { time: 1.5, id: 1 })).toThrow('Bad cursor');
    expect(() => call('history:query', '', { time: 1, id: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      'Bad cursor',
    );
    expect(() => call('history:delete', 0)).toThrow('Bad id');
    expect(() => call('history:delete', -1)).toThrow('Bad id');
    expect(() => call('history:delete', '1')).toThrow('Bad id');
    expect(() => call('history:delete', 1.5)).toThrow('Bad id');
  });

  it('accepts a valid cursor', () => {
    initHistory(db);
    expect(call('history:query', 'a', { time: 10, id: 3 })).toEqual({ entries: [], next: null });
  });

  it('returns an empty page without a database', () => {
    const recorder = initHistory(null);
    recorder.recordVisit('https://example.com/', 'link');
    recorder.flush();
    expect(call('history:query', '', null)).toEqual({ entries: [], next: null });
    expect(call('history:delete', 1)).toBeUndefined();
  });
});
