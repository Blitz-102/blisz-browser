import type { Session } from 'electron';
import { isWebUrl } from '../shared/url';

const MAX_FAVICON_BYTES = 64 * 1024;
const MAX_FAVICON_SIDE = 256;
const FETCH_TIMEOUT_MS = 5000;
const MAX_CANDIDATES = 8;

type ImageKind = 'png' | 'gif' | 'ico' | 'svg';
const IMAGE_KINDS: Record<string, ImageKind> = {
  'image/png': 'png',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/svg+xml': 'svg',
};

const startsWith = (bytes: Uint8Array, magic: number[]) =>
  bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte);

// Checks that the bytes match the declared raster type and are at most 256 px on each side. Only
// fixed header fields are read; the image is never decoded. SVG has no header to check.
export function isValidFavicon(kind: ImageKind, bytes: Uint8Array): boolean {
  if (kind === 'svg') return true;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fits = (width: number, height: number) =>
    width > 0 && height > 0 && width <= MAX_FAVICON_SIDE && height <= MAX_FAVICON_SIDE;

  if (kind === 'png') {
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return (
      startsWith(bytes, magic) && bytes.length >= 24 && fits(view.getUint32(16), view.getUint32(20))
    );
  }
  if (kind === 'gif') {
    return (
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
      bytes.length >= 10 &&
      fits(view.getUint16(6, true), view.getUint16(8, true))
    );
  }
  // ICO: a directory of entries, each 16 bytes; a width or height of 0 means 256.
  if (!startsWith(bytes, [0, 0, 1, 0]) || bytes.length < 6) return false;
  const count = view.getUint16(4, true);
  if (count === 0 || bytes.length < 6 + count * 16) return false;
  for (let i = 0; i < count; i++) {
    const width = bytes[6 + i * 16] || 256;
    const height = bytes[7 + i * 16] || 256;
    if (!fits(width, height)) return false;
  }
  return true;
}

// The http(s) candidates a page lists, capped so a page can't make us fetch hundreds.
export function webFaviconUrls(urls: string[]): string[] {
  return urls.filter(isWebUrl).slice(0, MAX_CANDIDATES);
}

interface Favicon {
  kind: ImageKind;
  dataUrl: string;
}

async function fetchOne(
  pageSession: Session,
  url: string,
  signal: AbortSignal,
): Promise<Favicon | null> {
  const response = await pageSession.fetch(url, {
    credentials: 'omit',
    bypassCustomProtocolHandlers: true,
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
  });
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const kind = IMAGE_KINDS[type];
  const length = Number(response.headers.get('content-length') ?? 0);
  if (!response.ok || !kind || length > MAX_FAVICON_BYTES || !response.body) {
    await response.body?.cancel();
    return null;
  }

  // content-length can be missing or wrong, so count the bytes as they arrive.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_FAVICON_BYTES) return null;
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!isValidFavicon(kind, bytes)) return null;
  return { kind, dataUrl: `data:${type};base64,${bytes.toString('base64')}` };
}

// Tries the candidates in order with the page's own session. Returns the first valid raster image
// as a data: URL, else the first valid SVG, judged by the response type rather than the URL. The
// trusted UI only ever shows it in an <img>.
export async function fetchFavicon(
  pageSession: Session,
  urls: string[],
  signal: AbortSignal,
): Promise<string | null> {
  let svg: string | null = null;
  for (const url of urls) {
    try {
      const favicon = await fetchOne(pageSession, url, signal);
      if (favicon?.kind === 'svg') svg ??= favicon.dataUrl;
      else if (favicon) return favicon.dataUrl;
    } catch {
      if (signal.aborted) return null; // otherwise a failed candidate falls through to the next
    }
  }
  return svg;
}

// Re-checks an icon read back from disk, which is untrusted, with the same rules as a fetched one.
export function faviconFromDataUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2 * MAX_FAVICON_BYTES) return null; // base64 is ~4/3 of the bytes
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  const kind =
    match?.[1] && Object.hasOwn(IMAGE_KINDS, match[1]) ? IMAGE_KINDS[match[1]] : undefined;
  if (!match?.[2] || !kind) return null;
  const bytes = Buffer.from(match[2], 'base64');
  // Re-encoding catches stray or truncated base64 that decoding alone would let through.
  const valid =
    bytes.length <= MAX_FAVICON_BYTES &&
    bytes.toString('base64') === match[2] &&
    isValidFavicon(kind, bytes);
  return valid ? value : null;
}
