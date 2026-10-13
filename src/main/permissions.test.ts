import { describe, expect, it, vi } from 'vitest';
import {
  classifyPermission,
  DecisionStore,
  isPermissionGranted,
  type PermissionRequestInfo,
  PromptQueue,
  parseExternalLink,
} from './permissions';

const page = 'https://shop.example/cart';
const request = (overrides: Partial<PermissionRequestInfo>): PermissionRequestInfo => ({
  permission: 'geolocation',
  requestingUrl: page,
  isMainFrame: true,
  topUrl: page,
  ...overrides,
});

describe('classifyPermission', () => {
  it('asks about camera, microphone and both', () => {
    const media = (mediaTypes: string[]) => request({ permission: 'media', mediaTypes });
    const origin = 'https://shop.example';
    expect(classifyPermission(media(['video']))).toEqual({ ask: 'camera', origin });
    expect(classifyPermission(media(['audio']))).toEqual({ ask: 'microphone', origin });
    expect(classifyPermission(media(['video', 'audio']))).toEqual({
      ask: 'camera-microphone',
      origin,
    });
  });

  it('denies media without a type', () => {
    expect(classifyPermission(request({ permission: 'media' }))).toBe('deny');
    expect(classifyPermission(request({ permission: 'media', mediaTypes: [] }))).toBe('deny');
  });

  it('asks about location, notifications and clipboard-read', () => {
    const origin = 'https://shop.example';
    expect(classifyPermission(request({ permission: 'geolocation' }))).toEqual({
      ask: 'location',
      origin,
    });
    expect(classifyPermission(request({ permission: 'notifications' }))).toEqual({
      ask: 'notifications',
      origin,
    });
    expect(classifyPermission(request({ permission: 'clipboard-read' }))).toEqual({
      ask: 'clipboard-read',
      origin,
    });
  });

  it('allows fullscreen, safe clipboard writes and pointer lock silently', () => {
    for (const permission of ['fullscreen', 'clipboard-sanitized-write', 'pointerLock']) {
      expect(classifyPermission(request({ permission }))).toBe('allow');
    }
  });

  it('leaves fullscreen and pointer lock to Permissions Policy for other-origin frames', () => {
    const frame = { isMainFrame: false, requestingUrl: 'https://video.example/embed' };
    expect(classifyPermission(request({ ...frame, permission: 'fullscreen' }))).toBe('allow');
    expect(classifyPermission(request({ ...frame, permission: 'pointerLock' }))).toBe('allow');
  });

  it('denies everything else, including openExternal', () => {
    for (const permission of ['openExternal', 'hid', 'usb', 'serial', 'display-capture', 'midi']) {
      expect(classifyPermission(request({ permission }))).toBe('deny');
    }
  });

  it('denies a request from another origin than the tab, in a frame or in the main frame', () => {
    expect(
      classifyPermission(request({ isMainFrame: false, requestingUrl: 'https://ads.example/x' })),
    ).toBe('deny');
    expect(classifyPermission(request({ requestingUrl: 'https://old.example/' }))).toBe('deny');
    expect(
      classifyPermission(request({ isMainFrame: false, requestingUrl: 'https://shop.example/f' })),
    ).toEqual({ ask: 'location', origin: 'https://shop.example' });
  });

  it('asks only on https and on the local machine', () => {
    const at = (url: string) => request({ requestingUrl: url, topUrl: url });
    expect(classifyPermission(at('http://shop.example/'))).toBe('deny');
    expect(classifyPermission(at('http://localhost:3000/'))).toEqual({
      ask: 'location',
      origin: 'http://localhost:3000',
    });
    expect(classifyPermission(at('http://127.0.0.1:8080/'))).toEqual({
      ask: 'location',
      origin: 'http://127.0.0.1:8080',
    });
    expect(classifyPermission(at('http://[::1]:8080/'))).toEqual({
      ask: 'location',
      origin: 'http://[::1]:8080',
    });
    // Fullscreen needs no prompt, so it still works on plain http.
    expect(classifyPermission({ ...at('http://shop.example/'), permission: 'fullscreen' })).toBe(
      'allow',
    );
  });

  it('denies a request from a non-web URL', () => {
    expect(classifyPermission(request({ requestingUrl: 'blisz://app/index.html' }))).toBe('deny');
    expect(classifyPermission(request({ requestingUrl: 'file:///C:/a.html' }))).toBe('deny');
    expect(classifyPermission(request({ requestingUrl: '' }))).toBe('deny');
  });
});

describe('DecisionStore', () => {
  it('starts unanswered and remembers Allow and Block per origin', () => {
    const store = new DecisionStore();
    expect(store.recall('https://a.example', 'location')).toBeUndefined();
    store.remember('https://a.example', 'location', true);
    store.remember('https://b.example', 'location', false);
    expect(store.recall('https://a.example', 'location')).toBe(true);
    expect(store.recall('https://b.example', 'location')).toBe(false);
    expect(store.recall('https://a.example', 'notifications')).toBeUndefined();
  });

  it('keeps stores apart', () => {
    const one = new DecisionStore();
    one.remember('https://a.example', 'location', true);
    expect(new DecisionStore().recall('https://a.example', 'location')).toBeUndefined();
  });

  it('lets a camera+microphone answer cover both', () => {
    const store = new DecisionStore();
    store.remember('https://c.example', 'camera-microphone', true);
    expect(store.recall('https://c.example', 'camera')).toBe(true);
    expect(store.recall('https://c.example', 'microphone')).toBe(true);
    expect(store.recall('https://c.example', 'camera-microphone')).toBe(true);
  });

  it('treats camera+microphone as blocked when either is blocked, unknown when one is missing', () => {
    const store = new DecisionStore();
    store.remember('https://d.example', 'camera', false);
    expect(store.recall('https://d.example', 'camera-microphone')).toBe(false);
    store.remember('https://e.example', 'camera', true);
    expect(store.recall('https://e.example', 'camera-microphone')).toBeUndefined();
  });

  it('never remembers Allow for reading the clipboard, but remembers Block', () => {
    const store = new DecisionStore();
    store.remember('https://a.example', 'clipboard-read', true);
    expect(store.recall('https://a.example', 'clipboard-read')).toBeUndefined();
    store.remember('https://a.example', 'clipboard-read', false);
    expect(store.recall('https://a.example', 'clipboard-read')).toBe(false);
  });

  it('answers the check handler without prompting', () => {
    const store = new DecisionStore();
    const asks = request({ permission: 'notifications', requestingUrl: 'https://f.example/' });
    const here = { ...asks, topUrl: 'https://f.example/' };
    expect(isPermissionGranted(here, store)).toBe(false);
    store.remember('https://f.example', 'notifications', true);
    expect(isPermissionGranted(here, store)).toBe(true);
    expect(isPermissionGranted(request({ permission: 'fullscreen' }), store)).toBe(true);
    expect(isPermissionGranted(request({ permission: 'openExternal' }), store)).toBe(false);
  });
});

describe('PromptQueue', () => {
  it('shows the oldest question first and the next after it is answered', () => {
    const queue = new PromptQueue();
    const first = vi.fn();
    const second = vi.fn();
    queue.add('camera', 'https://a.example', first);
    queue.add('location', 'https://a.example', second);
    const current = queue.current;
    expect(current?.kind).toBe('camera');
    expect(queue.current).toBe(current); // same object while nothing changes

    expect(queue.respond(current?.id ?? 0, true)).toBe(current);
    expect(first).toHaveBeenCalledWith(true);
    expect(second).not.toHaveBeenCalled();
    expect(queue.current?.kind).toBe('location');
  });

  it('resolves identical requests from one origin together', () => {
    const queue = new PromptQueue();
    const one = vi.fn();
    const two = vi.fn();
    const other = vi.fn();
    queue.add('notifications', 'https://a.example', one);
    queue.add('notifications', 'https://a.example', two);
    queue.add('notifications', 'https://b.example', other);
    queue.respond(queue.current?.id ?? 0, false);
    expect(one).toHaveBeenCalledWith(false);
    expect(two).toHaveBeenCalledWith(false);
    expect(other).not.toHaveBeenCalled();
    expect(queue.current?.origin).toBe('https://b.example');
  });

  it('answers "no" to merged requests beyond 20', () => {
    const queue = new PromptQueue();
    const calls = Array.from({ length: 21 }, () => vi.fn());
    for (const call of calls) queue.add('notifications', 'https://a.example', call);
    expect(calls[20]).toHaveBeenCalledWith(false);
    expect(calls[19]).not.toHaveBeenCalled();
    queue.respond(queue.current?.id ?? 0, true);
    expect(calls[19]).toHaveBeenCalledWith(true);
  });

  it('never merges mail or phone prompts, and keeps their target', () => {
    const queue = new PromptQueue();
    const one = vi.fn();
    const two = vi.fn();
    queue.add('open-mail', 'https://a.example', one, 'a@example.com');
    queue.add('open-mail', 'https://a.example', two, 'b@example.com');
    expect(queue.current?.target).toBe('a@example.com');
    queue.respond(queue.current?.id ?? 0, true);
    expect(one).toHaveBeenCalledWith(true);
    expect(two).not.toHaveBeenCalled();
    expect(queue.has('open-mail')).toBe(true);
  });

  it('answers "no" to everything when cancelled', () => {
    const queue = new PromptQueue();
    const one = vi.fn();
    const two = vi.fn();
    queue.add('camera', 'https://a.example', one);
    queue.add('location', 'https://a.example', two);
    queue.cancelAll();
    expect(one).toHaveBeenCalledWith(false);
    expect(two).toHaveBeenCalledWith(false);
    expect(queue.current).toBeNull();
  });

  it('ignores an unknown id and refuses when full', () => {
    const queue = new PromptQueue();
    queue.add('camera', 'https://a.example', () => {});
    expect(queue.respond(99_999, true)).toBeNull();
    expect(queue.current?.kind).toBe('camera'); // nothing was removed

    const kinds = ['microphone', 'location', 'notifications', 'clipboard-read'] as const;
    for (const kind of kinds) queue.add(kind, 'https://a.example', () => {});
    const refused = vi.fn();
    queue.add('open-mail', 'https://a.example', refused);
    expect(refused).toHaveBeenCalledWith(false);
  });
});

describe('parseExternalLink', () => {
  it('keeps normal mailto: links as they are', () => {
    expect(parseExternalLink('mailto:me@example.com')).toEqual({
      kind: 'open-mail',
      url: 'mailto:me@example.com',
      target: 'me@example.com',
    });
    expect(
      parseExternalLink('mailto:me@example.com?subject=Hi%20there&body=Line%201%0D%0ALine%202'),
    ).toEqual({
      kind: 'open-mail',
      url: 'mailto:me@example.com?subject=Hi%20there&body=Line%201%0D%0ALine%202',
      target: 'me@example.com',
    });
    expect(
      parseExternalLink('mailto:a@example.com,b@example.com?cc=c@example.com&bcc=d@example.com'),
    ).toEqual({
      kind: 'open-mail',
      url: 'mailto:a@example.com,b@example.com?cc=c@example.com&bcc=d@example.com',
      target: 'a@example.com, b@example.com, c@example.com, d@example.com',
    });
    expect(parseExternalLink('mailto:?to=x@example.com&subject=S')?.target).toBe('x@example.com');
  });

  it('drops every field but to, cc, bcc, subject and body', () => {
    const attach = parseExternalLink('mailto:me@example.com?attach=C:%5Csecret.txt&subject=Hi');
    expect(attach?.url).toBe('mailto:me@example.com?subject=Hi');
    const attachment = parseExternalLink(
      'mailto:me@example.com?attachment=%5C%5Chost%5Cshare&body=x',
    );
    expect(attachment?.url).toBe('mailto:me@example.com?body=x');
    expect(parseExternalLink('mailto:me@example.com?x-extra=1')?.url).toBe('mailto:me@example.com');
  });

  it('encodes values again, so a decoded value can not add a field', () => {
    const link = parseExternalLink('mailto:me@example.com?subject=a%26attach%3Dx');
    expect(link?.url).toBe('mailto:me@example.com?subject=a%26attach%3Dx');
  });

  it('refuses quotes, backslashes, angle brackets and spaces', () => {
    for (const url of [
      'mailto:"me"@example.com',
      'mailto:me@example.com?subject=a"b',
      'mailto:C:\\x@example.com',
      'mailto:me@example.com?subject=<b>',
      'mailto:me@example.com?subject=a b',
      'mailto:me@example.com>',
    ]) {
      expect(parseExternalLink(url)).toBeNull();
    }
  });

  it('refuses a rebuilt mailto that is too long, even when the original was short', () => {
    // A raw "$" is 1 character and becomes "%24" (3) when encoded again.
    const original = `mailto:me@example.com?subject=${'$'.repeat(1000)}`;
    expect(original.length).toBeLessThan(2048);
    expect(parseExternalLink(original)).toBeNull();
    expect(parseExternalLink(`mailto:me@example.com?subject=${'$'.repeat(600)}`)).not.toBeNull();
  });

  it('refuses invisible format characters in addresses and the subject', () => {
    expect(parseExternalLink('mailto:a%E2%80%AEb@example.com')).toBeNull(); // right-to-left override
    expect(parseExternalLink('mailto:me@example.com?subject=a%E2%80%8Fb')).toBeNull();
    expect(parseExternalLink('mailto:me@example.com?to=a%E2%80%8Eb')).toBeNull();
  });

  it('refuses addresses with an encoded backslash or control character', () => {
    expect(parseExternalLink('mailto:a%5Cb@example.com')).toBeNull();
    expect(parseExternalLink('mailto:me@example.com?to=a%5Cb')).toBeNull();
    expect(parseExternalLink('mailto:me@example.com?subject=a%0D%0ABcc:x@y.z')).toBeNull();
    expect(parseExternalLink('mailto:me@example.com?subject=%ZZ')).toBeNull();
  });

  it('accepts tel: numbers and keeps them', () => {
    expect(parseExternalLink('tel:+15551234567')).toEqual({
      kind: 'open-phone',
      url: 'tel:+15551234567',
      target: '+15551234567',
    });
    expect(parseExternalLink('tel:(555)123-4567;ext=89')?.kind).toBe('open-phone');
    expect(parseExternalLink('tel:555%201234')).toBeNull();
  });

  it('refuses tel: links outside the strict pattern', () => {
    for (const url of [
      'tel:',
      `tel:${'1'.repeat(65)}`,
      'tel:123/456',
      'tel:1 2',
      'tel:12?x=1',
      'tel:1\\2',
    ]) {
      expect(parseExternalLink(url)).toBeNull();
    }
  });

  it('refuses other schemes', () => {
    for (const url of [
      'https://example.com/',
      'file:///C:/Windows/System32/calc.exe',
      'ms-msdt:/id',
      'javascript:alert(1)',
      'blisz://app/',
      'sms:+1555',
    ]) {
      expect(parseExternalLink(url)).toBeNull();
    }
  });

  it('refuses empty, too long and control-character URLs', () => {
    expect(parseExternalLink('')).toBeNull();
    expect(parseExternalLink('mailto')).toBeNull();
    expect(parseExternalLink(`mailto:${'a'.repeat(2048)}`)).toBeNull();
    expect(parseExternalLink('mailto:a@b.c\r\nBcc:x@y.z')).toBeNull();
    expect(parseExternalLink('tel:123\u0000')).toBeNull();
    expect(parseExternalLink('tel:123\u0085')).toBeNull();
  });
});
