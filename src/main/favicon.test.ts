import type { Session } from 'electron';
import { describe, expect, it } from 'vitest';
import { fetchFavicon, isValidFavicon, webFaviconUrls } from './favicon';

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

const gif = (width: number, height: number) => {
  const bytes = new Uint8Array(10);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
};

// One directory entry per [width, height] pair; 0 means 256.
const ico = (...sizes: [number, number][]) => {
  const bytes = new Uint8Array(6 + sizes.length * 16);
  bytes.set([0, 0, 1, 0, sizes.length, 0]);
  sizes.forEach(([width, height], i) => {
    bytes[6 + i * 16] = width;
    bytes[7 + i * 16] = height;
  });
  return bytes;
};

describe('isValidFavicon', () => {
  it('accepts small PNG, GIF and ICO headers', () => {
    expect(isValidFavicon('png', png(32, 32))).toBe(true);
    expect(isValidFavicon('gif', gif(16, 16))).toBe(true);
    expect(isValidFavicon('ico', ico([16, 16], [0, 0]))).toBe(true);
  });

  it('rejects images over 256 px or with zero size', () => {
    expect(isValidFavicon('png', png(257, 16))).toBe(false);
    expect(isValidFavicon('png', png(0, 16))).toBe(false);
    expect(isValidFavicon('gif', gif(16, 300))).toBe(false);
  });

  it('rejects bytes that do not match the declared type', () => {
    expect(isValidFavicon('png', gif(16, 16))).toBe(false);
    expect(isValidFavicon('gif', png(16, 16))).toBe(false);
    expect(isValidFavicon('ico', png(16, 16))).toBe(false);
  });

  it('rejects truncated data', () => {
    expect(isValidFavicon('png', png(16, 16).slice(0, 12))).toBe(false);
    expect(isValidFavicon('ico', ico([16, 16]).slice(0, 10))).toBe(false);
    expect(isValidFavicon('ico', new Uint8Array(0))).toBe(false);
  });

  it('accepts SVG without header checks', () => {
    expect(isValidFavicon('svg', new TextEncoder().encode('<svg/>'))).toBe(true);
  });
});

describe('webFaviconUrls', () => {
  it('drops non-web URLs and keeps at most 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => `https://a.test/${i}.png`);
    expect(webFaviconUrls(['data:image/png;base64,AA', ...many])).toEqual(many.slice(0, 8));
  });
});

describe('fetchFavicon', () => {
  const svgBytes = new TextEncoder().encode('<svg/>');
  const respond = (type: string, body: Uint8Array) =>
    new Response(body, { headers: { 'content-type': type } });
  const sessionServing = (files: Record<string, Response>) =>
    ({ fetch: async (url: string) => files[url] }) as unknown as Session;
  const signal = new AbortController().signal;

  it('prefers a valid raster over an SVG that comes first, whatever the URL says', async () => {
    const pageSession = sessionServing({
      'https://a.test/first.png': respond('image/svg+xml', svgBytes),
      'https://a.test/second.png': respond('image/png', png(16, 16)),
    });
    const urls = ['https://a.test/first.png', 'https://a.test/second.png'];
    expect(await fetchFavicon(pageSession, urls, signal)).toMatch(/^data:image\/png;base64,/);
  });

  it('falls back to the SVG when no raster validates', async () => {
    const pageSession = sessionServing({
      'https://a.test/a.svg': respond('image/svg+xml', svgBytes),
      'https://a.test/big.png': respond('image/png', png(999, 999)),
    });
    const urls = ['https://a.test/a.svg', 'https://a.test/big.png'];
    expect(await fetchFavicon(pageSession, urls, signal)).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});
