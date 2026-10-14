import { describe, expect, it } from 'vitest';
import { mergeByPid, parseBenchConfig } from './bench';

const site = { name: 'MDN', url: 'https://developer.mozilla.org/' };

describe('parseBenchConfig', () => {
  it('accepts a valid config', () => {
    const config = { settleSeconds: 60, sites: [site] };
    expect(parseBenchConfig(config)).toEqual(config);
  });

  it('rejects a bad URL', () => {
    expect(() =>
      parseBenchConfig({ settleSeconds: 5, sites: [{ name: 'x', url: 'nope' }] }),
    ).toThrow();
  });

  it.each(['file:///C:/secret.txt', 'javascript:alert(1)', 'ftp://example.com/', 'blisz://ui/'])(
    'rejects %s',
    (url) => {
      expect(() => parseBenchConfig({ settleSeconds: 5, sites: [{ name: 'x', url }] })).toThrow();
    },
  );

  it('rejects an empty or missing list', () => {
    expect(() => parseBenchConfig({ settleSeconds: 5, sites: [] })).toThrow();
    expect(() => parseBenchConfig({ settleSeconds: 5 })).toThrow();
  });

  it('rejects a site without a name', () => {
    expect(() => parseBenchConfig({ settleSeconds: 5, sites: [{ url: site.url }] })).toThrow();
  });

  it.each([0, 601, 1.5, '60', undefined])('rejects settleSeconds %s', (settleSeconds) => {
    expect(() => parseBenchConfig({ settleSeconds, sites: [site] })).toThrow();
  });

  it('accepts the limits 1 and 600', () => {
    expect(parseBenchConfig({ settleSeconds: 1, sites: [site] }).settleSeconds).toBe(1);
    expect(parseBenchConfig({ settleSeconds: 600, sites: [site] }).settleSeconds).toBe(600);
  });

  it('rejects non-objects', () => {
    expect(() => parseBenchConfig(null)).toThrow();
    expect(() => parseBenchConfig('x')).toThrow();
  });
});

describe('mergeByPid', () => {
  it('adds the private working set by PID, or null when the script has no row', () => {
    const base = { type: 'Tab', label: 'a', privateKB: 1, workingSetKB: 2, cpuPercent: 0 };
    const merged = mergeByPid(
      [
        { ...base, pid: 1 },
        { ...base, pid: 2 },
      ],
      [{ pid: 1, name: 'electron.exe', privateWorkingSetKB: 500 }],
    );
    expect(merged.map((p) => p.privateWorkingSetKB)).toEqual([500, null]);
  });
});
