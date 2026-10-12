import { describe, expect, it } from 'vitest';
import { toNavigableUrl } from './address';

const search = (query: string) => `https://www.google.com/search?q=${encodeURIComponent(query)}`;

describe('toNavigableUrl', () => {
  it('ignores empty input', () => {
    expect(toNavigableUrl('')).toBe('');
    expect(toNavigableUrl('   ')).toBe('');
  });

  it('adds https to a host.tld', () => {
    expect(toNavigableUrl('example.com')).toBe('https://example.com');
    expect(toNavigableUrl('example.com/path?x=1')).toBe('https://example.com/path?x=1');
    expect(toNavigableUrl('sub.example.co.uk:8443/a')).toBe('https://sub.example.co.uk:8443/a');
    expect(toNavigableUrl('  example.com  ')).toBe('https://example.com');
  });

  it('adds http to localhost and IP literals', () => {
    expect(toNavigableUrl('localhost')).toBe('http://localhost');
    expect(toNavigableUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(toNavigableUrl('127.0.0.1')).toBe('http://127.0.0.1');
    expect(toNavigableUrl('192.168.1.1:8080/admin')).toBe('http://192.168.1.1:8080/admin');
    expect(toNavigableUrl('[::1]:3000')).toBe('http://[::1]:3000');
    expect(toNavigableUrl('::1')).toBe('http://[::1]');
  });

  it('keeps an explicit scheme as typed', () => {
    expect(toNavigableUrl('http://example.com')).toBe('http://example.com');
    expect(toNavigableUrl('file:///C:/')).toBe('file:///C:/');
    expect(toNavigableUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(toNavigableUrl('user:pass@host')).toBe('user:pass@host');
  });

  it('searches for everything else', () => {
    expect(toNavigableUrl('hello world')).toBe(search('hello world'));
    expect(toNavigableUrl('what is 1.5')).toBe(search('what is 1.5'));
    expect(toNavigableUrl('note: buy milk')).toBe(search('note: buy milk'));
    expect(toNavigableUrl('12:30:45')).toBe(search('12:30:45'));
    expect(toNavigableUrl('1.5')).toBe(search('1.5'));
    expect(toNavigableUrl('cats')).toBe(search('cats'));
    expect(toNavigableUrl('a&b=c')).toBe(search('a&b=c'));
  });
});
