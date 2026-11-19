import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blisz-db-test-'));
  file = join(dir, 'blisz.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pragma = (db: DatabaseSync, name: string) =>
  Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];

describe('openDatabase', () => {
  it('creates the session tables at user_version 1 in WAL mode', () => {
    const db = openDatabase(file) as DatabaseSync;
    expect(db).not.toBeNull();
    expect(pragma(db, 'user_version')).toBe(1);
    expect(pragma(db, 'journal_mode')).toBe('wal');
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(['session_favicon', 'session_tab']);
    db.close();
  });

  it('does not run the migrations again on reopen', () => {
    const first = openDatabase(file) as DatabaseSync;
    first.exec("INSERT INTO session_tab VALUES (0, 1, 0, '[]', NULL)");
    first.close();
    const second = openDatabase(file) as DatabaseSync;
    expect(second.prepare('SELECT count(*) AS n FROM session_tab').get()).toEqual({ n: 1 });
    second.close();
  });

  it('returns null for a file from a newer version and leaves it untouched', () => {
    const newer = new DatabaseSync(file);
    newer.exec('CREATE TABLE future (x); PRAGMA user_version = 99');
    newer.close();
    const before = readFileSync(file);
    expect(openDatabase(file)).toBeNull();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('moves a file that is not a database aside and starts a new one', () => {
    writeFileSync(file, 'this is definitely not an sqlite database file '.repeat(50));
    const db = openDatabase(file) as DatabaseSync;
    expect(db).not.toBeNull();
    expect(pragma(db, 'user_version')).toBe(1);
    db.close();
    expect(readdirSync(dir)).toContain('blisz.db.broken');
    expect(readFileSync(`${file}.broken`, 'utf8')).toContain('not an sqlite');
  });
});
