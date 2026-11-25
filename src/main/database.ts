import { renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { app } from 'electron';

// Append only: entry N is run once, in order, and the file's user_version records how many ran.
const MIGRATIONS: string[] = [
  `CREATE TABLE session_tab (
     position INTEGER PRIMARY KEY,
     active INTEGER NOT NULL,
     entry_index INTEGER NOT NULL,
     entries TEXT NOT NULL,
     favicon TEXT
   ) STRICT;
   CREATE TABLE session_favicon (
     hash TEXT PRIMARY KEY,
     data TEXT NOT NULL
   ) STRICT;`,
  `CREATE TABLE history_url (
     id INTEGER PRIMARY KEY,
     url TEXT NOT NULL UNIQUE,
     title TEXT NOT NULL DEFAULT '',
     last_visit_time INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX history_url_last_visit ON history_url (last_visit_time, id);
   CREATE TABLE history_visit (
     id INTEGER PRIMARY KEY,
     url_id INTEGER NOT NULL REFERENCES history_url (id) ON DELETE CASCADE,
     visit_time INTEGER NOT NULL,
     type TEXT NOT NULL
   ) STRICT;
   CREATE INDEX history_visit_url ON history_visit (url_id);`,
];

// SQLITE_CORRUPT and SQLITE_NOTADB, including their extended codes.
const CORRUPT_CODES = [11, 26];

function warn(error: unknown): void {
  if (!app.isPackaged) console.warn('Database unavailable:', (error as Error).message);
}

function isCorrupt(error: unknown): boolean {
  const { errcode } = error as { errcode?: number };
  return typeof errcode === 'number' && CORRUPT_CODES.includes(errcode & 0xff);
}

// Null when the file was written by a newer build; it is left untouched.
function openAndMigrate(file: string): DatabaseSync | null {
  const db = new DatabaseSync(file, { defensive: true, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (row.user_version > MIGRATIONS.length) {
      db.close();
      return null;
    }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');
    for (let version = row.user_version; version < MIGRATIONS.length; version++) {
      db.exec(
        `BEGIN IMMEDIATE; ${MIGRATIONS[version]}; PRAGMA user_version = ${version + 1}; COMMIT`,
      );
    }
    return db;
  } catch (error) {
    db.close(); // rolls back a migration that was left half done
    throw error;
  }
}

// Opens (and migrates) the database, or returns null when it can't be used: the app then runs
// without saving. A corrupt file is kept as <file>.broken and replaced by a new one.
export function openDatabase(file: string): DatabaseSync | null {
  try {
    return openAndMigrate(file);
  } catch (error) {
    if (!isCorrupt(error)) {
      warn(error);
      return null;
    }
  }
  try {
    renameSync(file, `${file}.broken`);
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
    return openAndMigrate(file);
  } catch (error) {
    warn(error);
    return null;
  }
}
