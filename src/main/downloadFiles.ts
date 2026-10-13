import { extname, win32 } from 'node:path';
import { isWebUrl } from '../shared/url';

const MAX_NAME_LENGTH = 150;
const MAX_EXTENSION_LENGTH = 20;
const MAX_UNIQUE_TRIES = 1000;
// Characters Windows doesn't allow in file names, plus control characters (C0, DEL, C1) and
// invisible format characters such as bidi overrides, which can disguise an extension.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
const INVALID_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\p{Cf}]/gu;
const LEADING_DOTS_AND_SPACES = /^[. ]+/;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/;
// Device names are reserved on Windows, with or without an extension.
const RESERVED_NAMES = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\..*)?$/i;
// Only these passive types get an Open button. Anything else, including every type that can run
// code and every type we haven't thought of, only gets "Show in folder".
const OPENABLE_EXTENSIONS = new Set([
  '.pdf',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.m4a',
  '.mp4',
  '.webm',
  '.mkv',
  '.mov',
  '.docx',
  '.xlsx',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.zip',
  '.csv',
  '.md',
]);

// What "Save image" may save, by MIME type: the file gets the extension that matches its content.
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/x-icon': '.ico',
  'image/svg+xml': '.svg',
};
const IMAGE_EXTENSION_SET = new Set([...Object.values(IMAGE_EXTENSIONS), '.jpeg']);

// The extension the way Windows sees it: from the last dot, so ".exe" is an extension too.
function windowsExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

// The name comes from the server (Content-Disposition, URL), so it is untrusted.
export function sanitizeFilename(raw: string): string {
  let name = win32
    .basename(raw) // handles both separators on every platform
    .replace(INVALID_CHARACTERS, '')
    .replace(/\s+/g, ' ') // a long run of spaces could hide the real extension in a narrow list
    .replace(LEADING_DOTS_AND_SPACES, '')
    .replace(TRAILING_DOTS_AND_SPACES, '');
  if (name.length > MAX_NAME_LENGTH) {
    const extension = extname(name).slice(0, MAX_EXTENSION_LENGTH);
    let stem = '';
    for (const character of name.slice(0, name.length - extname(name).length)) {
      if (stem.length + character.length + extension.length > MAX_NAME_LENGTH) break;
      stem += character;
    }
    name = (stem.replace(TRAILING_DOTS_AND_SPACES, '') + extension).replace(
      TRAILING_DOTS_AND_SPACES,
      '',
    );
  }
  if (name === '') return 'download';
  return RESERVED_NAMES.test(name) ? `_${name}` : name;
}

// "name.ext" becomes "name (1).ext", "name (2).ext", ... until `isTaken` says the name is free.
export function uniqueFilename(name: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(name)) return name;
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let number = 1; number <= MAX_UNIQUE_TRIES; number++) {
    const candidate = `${stem} (${number})${extension}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${extension}`;
}

// Gives a saved image the extension of its real type, so "pic.exe" served as a PNG is saved as
// "pic.png". Returns null for a type we don't save as an image.
export function imageFilename(name: string, mimeType: string): string | null {
  const extension = IMAGE_EXTENSIONS[mimeType.split(';')[0]?.trim().toLowerCase() ?? ''];
  if (!extension) return null;
  const current = windowsExtension(name);
  if (IMAGE_EXTENSION_SET.has(current)) return name;
  return name.slice(0, name.length - current.length) + extension;
}

export function isOpenableFilename(name: string): boolean {
  return OPENABLE_EXTENSIONS.has(windowsExtension(name));
}

// Only http(s) URLs go in, with any user:password removed.
function cleanUrl(url: string): string | null {
  if (!isWebUrl(url)) return null;
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

// The Mark of the Web (Zone.Identifier stream) that SmartScreen and Office look at. Downloads
// that didn't come from a web URL (blob:, data:) use Windows' own "about:internet" host.
export function zoneIdentifier(pageUrl: string, downloadUrl: string): string {
  const referrer = cleanUrl(pageUrl);
  return [
    '[ZoneTransfer]',
    'ZoneId=3',
    ...(referrer ? [`ReferrerUrl=${referrer}`] : []),
    `HostUrl=${cleanUrl(downloadUrl) ?? 'about:internet'}`,
    '',
  ].join('\r\n');
}
