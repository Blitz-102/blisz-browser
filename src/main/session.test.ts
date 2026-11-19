import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { readSession, type SavedTab, writeSession } from './session';

// The same schema as migration 1 in database.ts.
function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE session_tab (
    position INTEGER PRIMARY KEY, active INTEGER NOT NULL, entry_index INTEGER NOT NULL,
    entries TEXT NOT NULL, favicon TEXT) STRICT;
  CREATE TABLE session_favicon (hash TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;`);
  return db;
}

// A PNG header (16x16) that passes isValidFavicon; `extra` zero bytes make a different icon.
const pngBytes = Buffer.alloc(24);
pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
pngBytes.writeUInt32BE(16, 16);
pngBytes.writeUInt32BE(16, 20);
const icon = (extra = 0) =>
  `data:image/png;base64,${Buffer.concat([pngBytes, Buffer.alloc(extra)]).toString('base64')}`;

const tab = (url: string, overrides: Partial<SavedTab> = {}): SavedTab => ({
  entries: [{ url, title: `Title ${url}` }],
  index: 0,
  favicon: null,
  active: false,
  ...overrides,
});

const urls = (tabs: SavedTab[]) => tabs.map((saved) => saved.entries[0]?.url);

let db: DatabaseSync;
beforeEach(() => {
  db = createDb();
});

// Inserts a row as an edited file could contain it.
function insertRaw(
  position: number,
  active: unknown,
  index: unknown,
  entries: unknown,
  favicon: unknown = null,
) {
  db.prepare('INSERT INTO session_tab VALUES (?, ?, ?, ?, ?)').run(
    position,
    active as number,
    index as number,
    entries as string,
    favicon as string | null,
  );
}
const goodEntries = JSON.stringify([{ url: 'https://a.test/', title: 'A' }]);

describe('writeSession and readSession', () => {
  it('round-trips order, active tab, index, titles and favicon', () => {
    const tabs: SavedTab[] = [
      tab('https://a.test/', { favicon: icon() }),
      {
        entries: [
          { url: 'https://b.test/1', title: 'One' },
          { url: 'https://b.test/2', title: 'Two' },
        ],
        index: 1,
        favicon: null,
        active: true,
      },
    ];
    writeSession(db, tabs);
    expect(readSession(db)).toEqual(tabs);
  });

  it('never stores page state', () => {
    const entries = [{ url: 'https://a.test/', title: 'A', pageState: 'secret form data' }];
    writeSession(db, [tab('https://a.test/', { entries, active: true })]);
    const row = db.prepare('SELECT entries FROM session_tab').get() as { entries: string };
    expect(JSON.parse(row.entries)).toEqual([{ url: 'https://a.test/', title: 'A' }]);
    expect(row.entries).not.toContain('secret');
  });

  it('replaces the previous session and deletes icons nothing uses', () => {
    writeSession(db, [tab('https://a.test/', { favicon: icon(1), active: true })]);
    writeSession(db, [tab('https://b.test/', { active: true })]);
    expect(urls(readSession(db))).toEqual(['https://b.test/']);
    expect(db.prepare('SELECT count(*) AS n FROM session_favicon').get()).toEqual({ n: 0 });
  });

  it('stores an icon shared by two tabs once', () => {
    writeSession(db, [
      tab('https://a.test/', { favicon: icon(), active: true }),
      tab('https://b.test/', { favicon: icon() }),
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM session_favicon').get()).toEqual({ n: 1 });
    expect(readSession(db).map((saved) => saved.favicon)).toEqual([icon(), icon()]);
  });

  it('keeps the previous session when a write fails midway', () => {
    writeSession(db, [tab('https://a.test/', { active: true })]);
    // JSON.stringify throws on a BigInt, after the first tab was already inserted.
    const bad = tab('https://b.test/', {
      entries: [{ url: 'https://b.test/', title: 1n as never }],
    });
    expect(() => writeSession(db, [tab('https://c.test/'), bad])).toThrow();
    expect(urls(readSession(db))).toEqual(['https://a.test/']);
  });
});

describe('readSession on an untrusted file', () => {
  it.each(['javascript:alert(1)', 'file:///C:/secret.txt', 'about:blank', 'data:text/html,hi'])(
    'drops a tab with a %s entry',
    (url) => {
      insertRaw(0, 1, 0, JSON.stringify([{ url, title: 'x' }]));
      insertRaw(1, 0, 0, goodEntries);
      const tabs = readSession(db);
      expect(urls(tabs)).toEqual(['https://a.test/']);
      expect(tabs[0]?.active).toBe(true);
    },
  );

  it.each([
    ['bad JSON', 0, '{nope'],
    ['not an array', 0, '{"url":"https://a.test/","title":"A"}'],
    ['an empty array', 0, '[]'],
    ['an entry that is not an object', 0, '["https://a.test/"]'],
    ['a non-string url', 0, '[{"url":5,"title":"A"}]'],
    ['a non-string title', 0, '[{"url":"https://a.test/","title":5}]'],
    ['a missing title', 0, '[{"url":"https://a.test/"}]'],
    ['a negative index', -1, goodEntries],
    ['an index past the end', 1, goodEntries],
    [
      'more than 50 entries',
      0,
      JSON.stringify(Array.from({ length: 51 }, () => ({ url: 'https://a.test/', title: 'A' }))),
    ],
    [
      'an over-long url',
      0,
      JSON.stringify([{ url: `https://a.test/${'a'.repeat(2 * 1024 * 1024)}`, title: 'A' }]),
    ],
  ])('drops a tab with %s', (_name, index, entries) => {
    insertRaw(0, 1, index, entries);
    expect(readSession(db)).toEqual([]);
  });

  it('keeps a tab whose title is over-long, cut to the limit', () => {
    insertRaw(0, 1, 0, JSON.stringify([{ url: 'https://a.test/', title: 'a'.repeat(5000) }]));
    expect(readSession(db).map((saved) => saved.entries[0]?.title)).toEqual(['a'.repeat(4096)]);
  });

  it('keeps the tab but drops a bad favicon', () => {
    db.prepare('INSERT INTO session_favicon VALUES (?, ?)').run('h', 'data:text/html;base64,AAAA');
    insertRaw(0, 1, 0, goodEntries, 'h');
    const [saved] = readSession(db);
    expect(saved?.entries[0]?.url).toBe('https://a.test/');
    expect(saved?.favicon).toBeNull();
  });

  it('reads at most 500 tabs', () => {
    for (let position = 0; position < 510; position++) insertRaw(position, 0, 0, goodEntries);
    expect(readSession(db)).toHaveLength(500);
  });

  it('returns exactly one active tab', () => {
    for (const actives of [
      [0, 0, 0],
      [0, 1, 1],
      [1, 1, 1],
    ]) {
      db.exec('DELETE FROM session_tab');
      for (const [position, active] of actives.entries())
        insertRaw(position, active, 0, goodEntries);
      const flags = readSession(db).map((saved) => saved.active);
      expect(flags.filter(Boolean)).toHaveLength(1);
      expect(flags.indexOf(true)).toBe(Math.max(actives.indexOf(1), 0));
    }
  });

  it('returns nothing when the tables are missing', () => {
    expect(readSession(new DatabaseSync(':memory:'))).toEqual([]);
  });
});
