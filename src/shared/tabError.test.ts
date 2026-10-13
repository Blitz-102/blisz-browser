import { describe, expect, it } from 'vitest';
import { loadError } from './tabError';

describe('loadError', () => {
  it('ignores a cancelled load', () => {
    expect(loadError(-3, 'ERR_ABORTED', 'https://example.com/')).toBeNull();
  });

  it('maps ERR_CERT_* codes to a certificate error', () => {
    expect(loadError(-200, 'ERR_CERT_COMMON_NAME_INVALID', 'https://a.test/')?.kind).toBe(
      'certificate',
    );
    expect(loadError(-201, 'ERR_CERT_DATE_INVALID', 'https://a.test/')?.kind).toBe('certificate');
    expect(loadError(-299, 'ERR_CERT_END', 'https://a.test/')?.kind).toBe('certificate');
  });

  it('maps everything else to a network error', () => {
    expect(loadError(-102, 'ERR_CONNECTION_REFUSED', 'http://a.test/')).toEqual({
      kind: 'network',
      code: -102,
      description: 'ERR_CONNECTION_REFUSED',
      url: 'http://a.test/',
    });
    expect(loadError(-199, 'x', 'http://a.test/')?.kind).toBe('network');
    expect(loadError(-300, 'x', 'http://a.test/')?.kind).toBe('network');
  });

  it('cuts very long text', () => {
    const error = loadError(-105, 'd'.repeat(5000), `http://a.test/${'p'.repeat(5000)}`);
    expect(error).toMatchObject({ kind: 'network' });
    expect(error && 'url' in error && error.url.length).toBe(2048);
  });
});
