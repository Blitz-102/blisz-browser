import { describe, expect, it } from 'vitest';
import {
  imageFilename,
  isOpenableFilename,
  sanitizeFilename,
  uniqueFilename,
  zoneIdentifier,
} from './downloadFiles';

describe('sanitizeFilename', () => {
  it('keeps normal names', () => {
    expect(sanitizeFilename('report 2026.pdf')).toBe('report 2026.pdf');
  });

  it('keeps only the base name', () => {
    expect(sanitizeFilename('../../Windows/evil.txt')).toBe('evil.txt');
    expect(sanitizeFilename('C:\\Users\\me\\a.zip')).toBe('a.zip');
  });

  it('strips characters Windows rejects', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h\u0001i.txt')).toBe('abcdefghi.txt');
    expect(sanitizeFilename('file.txt:stream')).toBe('file.txtstream');
  });

  it('trims trailing dots and spaces', () => {
    expect(sanitizeFilename('name. . ')).toBe('name');
  });

  it('strips leading dots, format characters and C1 controls', () => {
    expect(sanitizeFilename('..exe')).toBe('exe');
    expect(sanitizeFilename('.hidden.txt')).toBe('hidden.txt');
    expect(sanitizeFilename('a\u202etxt.exe')).toBe('atxt.exe');
    expect(sanitizeFilename('a\u200bb\u0085c\u007f.txt')).toBe('abc.txt');
  });

  it('collapses runs of whitespace', () => {
    const name = sanitizeFilename(`invoice.pdf${' '.repeat(50)}.exe`);
    expect(name).toBe('invoice.pdf .exe');
    expect(sanitizeFilename('a\t\n b.txt')).toBe('a b.txt');
  });

  it('prefixes reserved device names, with or without an extension', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('nul.txt')).toBe('_nul.txt');
    expect(sanitizeFilename('Com1.tar.gz')).toBe('_Com1.tar.gz');
    expect(sanitizeFilename('console.txt')).toBe('console.txt');
    expect(sanitizeFilename('aux ')).toBe('_aux');
    expect(sanitizeFilename('CONIN$')).toBe('_CONIN$');
    expect(sanitizeFilename('conout$.txt')).toBe('_conout$.txt');
    expect(sanitizeFilename('COM\u00b9.txt')).toBe('_COM\u00b9.txt');
    expect(sanitizeFilename('lpt0')).toBe('_lpt0');
    expect(sanitizeFilename('CON  .txt')).toBe('_CON .txt');
    expect(sanitizeFilename('COM10')).toBe('COM10');
  });

  it('caps the length and keeps the extension', () => {
    const name = sanitizeFilename(`${'a'.repeat(300)}.pdf`);
    expect(name).toHaveLength(150);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('does not split a surrogate pair when cutting', () => {
    const name = sanitizeFilename(`${'\u{1F600}'.repeat(100)}.txt`);
    expect(name.length).toBeLessThanOrEqual(150);
    expect(name).toMatch(/^(\u{1F600})+\.txt$/u);
  });

  it('falls back to "download"', () => {
    expect(sanitizeFilename('')).toBe('download');
    expect(sanitizeFilename('...')).toBe('download');
    expect(sanitizeFilename('<>:')).toBe('download');
    expect(sanitizeFilename('/')).toBe('download');
  });
});

describe('uniqueFilename', () => {
  it('returns the name when it is free', () => {
    expect(uniqueFilename('a.zip', () => false)).toBe('a.zip');
  });

  it('adds a number before the extension', () => {
    const taken = new Set(['a.zip', 'a (1).zip']);
    expect(uniqueFilename('a.zip', (name) => taken.has(name))).toBe('a (2).zip');
  });

  it('numbers names without an extension', () => {
    expect(uniqueFilename('notes', (name) => name === 'notes')).toBe('notes (1)');
  });

  it('keeps only the last extension together', () => {
    expect(uniqueFilename('a.tar.gz', (name) => name === 'a.tar.gz')).toBe('a.tar (1).gz');
  });

  it('gives up numbering after 1000 tries', () => {
    let tries = 0;
    const name = uniqueFilename('a.zip', () => {
      tries++;
      return true;
    });
    expect(name).toMatch(/^a \(\d{10,}\)\.zip$/);
    expect(tries).toBe(1001);
  });
});

describe('isOpenableFilename', () => {
  it('allows passive types in any case', () => {
    for (const name of ['a.pdf', 'photo.JPG', 'a.exe.pdf', 'a.zip', 'notes.md']) {
      expect(isOpenableFilename(name)).toBe(true);
    }
  });

  it('does not open anything that can run, or anything unknown', () => {
    for (const name of ['.exe', '..exe', 'a.HTA', 'a.pdf.exe', 'a.txt.lnk', 'a', 'exe', 'a.xyz']) {
      expect(isOpenableFilename(name)).toBe(false);
    }
  });
});

describe('imageFilename', () => {
  it('keeps names that already have an image extension', () => {
    expect(imageFilename('pic.PNG', 'image/png')).toBe('pic.PNG');
    expect(imageFilename('pic.jpeg', 'image/jpeg')).toBe('pic.jpeg');
  });

  it('replaces or adds the extension that matches the type', () => {
    expect(imageFilename('pic.exe', 'image/png')).toBe('pic.png');
    expect(imageFilename('pic', 'image/jpeg; charset=x')).toBe('pic.jpg');
    expect(imageFilename('a.b.html', 'image/svg+xml')).toBe('a.b.svg');
  });

  it('refuses types that are not images we save', () => {
    expect(imageFilename('pic.png', 'text/html')).toBeNull();
    expect(imageFilename('pic.png', 'image/x-unknown')).toBeNull();
  });
});

describe('zoneIdentifier', () => {
  it('writes the zone, referrer and host', () => {
    expect(zoneIdentifier('https://example.com/page', 'https://cdn.example.com/a.zip')).toBe(
      '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.com/page\r\nHostUrl=https://cdn.example.com/a.zip\r\n',
    );
  });

  it('strips user info, and uses about:internet for non-web downloads', () => {
    expect(zoneIdentifier('https://u:p@example.com/x', 'blob:https://example.com/id')).toBe(
      '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.com/x\r\nHostUrl=about:internet\r\n',
    );
    expect(zoneIdentifier('', 'data:text/plain,hi')).toBe(
      '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n',
    );
  });
});
