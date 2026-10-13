import type { Session, WebContents } from 'electron';
import type { PromptInfo, PromptKind } from '../shared/tabs';
import { isWebUrl } from '../shared/url';

// What to do with a permission request: answer now, or ask the user about `ask` first.
export type PermissionVerdict = 'allow' | 'deny' | { ask: PromptKind; origin: string };

export interface PermissionRequestInfo {
  permission: string;
  mediaTypes?: readonly string[]; // 'video' and/or 'audio', for `media`
  requestingUrl: string;
  isMainFrame: boolean;
  topUrl: string; // the tab's top-level URL
}

// Fullscreen, safe clipboard writes and pointer lock need no prompt. Everything not listed below
// is denied, including `openExternal`, which main handles itself (see parseExternalLink).
const SILENT_ALLOWS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);

// Asks only on https pages and on the local machine; other http pages get no grants.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function originOf(url: string): string | null {
  return isWebUrl(url) ? new URL(url).origin : null;
}

function isAskableUrl(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return protocol === 'https:' || (protocol === 'http:' && LOCAL_HOSTS.has(hostname));
}

function mediaKind(mediaTypes: readonly string[] | undefined): PromptKind | null {
  const video = mediaTypes?.includes('video') ?? false;
  const audio = mediaTypes?.includes('audio') ?? false;
  if (video && audio) return 'camera-microphone';
  if (video) return 'camera';
  if (audio) return 'microphone';
  return null;
}

export function classifyPermission(request: PermissionRequestInfo): PermissionVerdict {
  const origin = originOf(request.requestingUrl);
  if (origin === null) return 'deny';
  // Chromium's Permissions Policy already decides whether an embedded frame may use these.
  if (SILENT_ALLOWS.has(request.permission)) return 'allow';
  // Only the page the user is looking at can ask: not an ad or embed, and not a page being left.
  if (origin !== originOf(request.topUrl) || !isAskableUrl(request.requestingUrl)) return 'deny';
  let kind: PromptKind | null = null;
  if (request.permission === 'media') kind = mediaKind(request.mediaTypes);
  else if (request.permission === 'geolocation') kind = 'location';
  else if (request.permission === 'notifications') kind = 'notifications';
  else if (request.permission === 'clipboard-read') kind = 'clipboard-read';
  return kind === null ? 'deny' : { ask: kind, origin };
}

// Answers the user gave, for this session only (Phase 3 stores them). Block is remembered too.
export class DecisionStore {
  private decisions = new Map<string, boolean>();

  private key(origin: string, kind: PromptKind): string {
    return `${origin}|${kind}`;
  }

  // An answer for camera+microphone covers both devices. Reading the clipboard is asked every time.
  remember(origin: string, kind: PromptKind, allow: boolean): void {
    if (kind === 'clipboard-read' && allow) return;
    const kinds: PromptKind[] = kind === 'camera-microphone' ? ['camera', 'microphone'] : [kind];
    for (const each of kinds) this.decisions.set(this.key(origin, each), allow);
  }

  // undefined when the user hasn't answered. For camera+microphone, one Block is enough to block.
  recall(origin: string, kind: PromptKind): boolean | undefined {
    if (kind !== 'camera-microphone') return this.decisions.get(this.key(origin, kind));
    const camera = this.decisions.get(this.key(origin, 'camera'));
    const microphone = this.decisions.get(this.key(origin, 'microphone'));
    if (camera === false || microphone === false) return false;
    return camera === true && microphone === true ? true : undefined;
  }
}

// The permission check handler must never prompt: only silent allows and earlier "Allow" answers pass.
export function isPermissionGranted(request: PermissionRequestInfo, store: DecisionStore): boolean {
  const verdict = classifyPermission(request);
  if (typeof verdict === 'string') return verdict === 'allow';
  return store.recall(verdict.origin, verdict.ask) === true;
}

// Prompts that open an app; they are never remembered or merged, since each has its own URL.
export function isExternalKind(kind: PromptKind): boolean {
  return kind === 'open-mail' || kind === 'open-phone';
}

const MAX_PENDING_PROMPTS = 5;
const MAX_MERGED_REQUESTS = 20;
let nextPromptId = 1;

interface PendingPrompt {
  info: PromptInfo;
  resolvers: ((allow: boolean) => void)[];
}

// One tab's questions, oldest first. Only the first is shown; each holds the callbacks waiting for the answer.
export class PromptQueue {
  private pending: PendingPrompt[] = [];

  // Same object until the question is answered, so it can be compared by reference.
  get current(): PromptInfo | null {
    return this.pending[0]?.info ?? null;
  }

  has(kind: PromptKind): boolean {
    return this.pending.some((prompt) => prompt.info.kind === kind);
  }

  // Identical permission requests from the same origin wait for one answer. A full queue refuses.
  // `target` is what a mail or phone link points at, shown as text.
  add(kind: PromptKind, origin: string, resolve: (allow: boolean) => void, target = ''): void {
    const same = this.pending.find(
      (prompt) =>
        !isExternalKind(kind) && prompt.info.kind === kind && prompt.info.origin === origin,
    );
    if (same) {
      if (same.resolvers.length < MAX_MERGED_REQUESTS) same.resolvers.push(resolve);
      else resolve(false);
    } else if (this.pending.length >= MAX_PENDING_PROMPTS) {
      resolve(false);
    } else {
      this.pending.push({
        info: { id: nextPromptId++, kind, origin, target },
        resolvers: [resolve],
      });
    }
  }

  // Returns the answered question, or null when it is already gone.
  respond(id: number, allow: boolean): PromptInfo | null {
    const index = this.pending.findIndex((prompt) => prompt.info.id === id);
    if (index === -1) return null;
    const [answered] = this.pending.splice(index, 1);
    if (!answered) return null;
    for (const resolve of answered.resolvers) resolve(allow);
    return answered.info;
  }

  // The tab navigated, closed or crashed: every question is answered "no" and not remembered.
  cancelAll(): void {
    const cancelled = this.pending;
    this.pending = [];
    for (const prompt of cancelled) {
      for (const resolve of prompt.resolvers) resolve(false);
    }
  }
}

const MAX_EXTERNAL_URL_LENGTH = 2048;
const MAIL_FIELDS = new Set(['to', 'cc', 'bcc', 'subject', 'body']);
const ADDRESS_FIELDS = new Set(['to', 'cc', 'bcc']);
const PHONE_LINK = /^tel:\+?[0-9A-Za-z().\-;=,*#]{1,64}$/;
const FORMAT = /\p{Cf}/u; // invisible format characters, such as bidi controls
const CONTROL = /\p{Cc}/u;
const CONTROL_EXCEPT_NEWLINES = /[^\P{Cc}\r\n\t]/u; // a mail body may have line breaks
const FORBIDDEN = /["\\<> ]/; // includes a literal space

export interface ExternalLink {
  kind: 'open-mail' | 'open-phone';
  url: string; // rebuilt from checked parts; the only string ever opened
  target: string; // the address or number, shown in the prompt
}

function splitOnce(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator);
  return index === -1 ? [text, ''] : [text.slice(0, index), text.slice(index + 1)];
}

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

// Addresses stay readable: only the @ is left as it is.
function encodeAddresses(addresses: string[]): string {
  return addresses.map((address) => encodeURIComponent(address).replaceAll('%40', '@')).join(',');
}

// Keeps the addresses and the to, cc, bcc, subject and body fields; every other field (attach and
// the like) is dropped. Each value is decoded, checked and encoded again.
function rebuildMailto(rest: string): ExternalLink | null {
  const [addressPart, query] = splitOnce(rest.split('#')[0] ?? '', '?');
  const targets: string[] = [];
  const fields: string[] = [];
  const addAddresses = (text: string): string | null => {
    const addresses = decode(text)?.split(',').filter(Boolean);
    if (!addresses || addresses.some((a) => a.includes('\\') || CONTROL.test(a) || FORMAT.test(a)))
      return null;
    targets.push(...addresses);
    return encodeAddresses(addresses);
  };

  const first = addAddresses(addressPart);
  if (first === null) return null;
  for (const pair of query.split('&')) {
    const [rawName, rawValue] = splitOnce(pair, '=');
    const name = decode(rawName)?.toLowerCase();
    if (!name || !MAIL_FIELDS.has(name)) continue;
    if (ADDRESS_FIELDS.has(name)) {
      const encoded = addAddresses(rawValue);
      if (encoded === null) return null;
      fields.push(`${name}=${encoded}`);
      continue;
    }
    const value = decode(rawValue);
    if (value === null || (name === 'subject' ? CONTROL : CONTROL_EXCEPT_NEWLINES).test(value)) {
      return null;
    }
    if (name === 'subject' && FORMAT.test(value)) return null;
    fields.push(`${name}=${encodeURIComponent(value)}`);
  }
  const url = `mailto:${first}${fields.length > 0 ? `?${fields.join('&')}` : ''}`;
  if (url.length > MAX_EXTERNAL_URL_LENGTH) return null; // re-encoding can make it longer
  return { kind: 'open-mail', url, target: targets.join(', ') };
}

// A mailto: or tel: link rebuilt in a safe form, or null. The only schemes ever opened outside the browser.
export function parseExternalLink(url: string): ExternalLink | null {
  if (url.length > MAX_EXTERNAL_URL_LENGTH || CONTROL.test(url) || FORBIDDEN.test(url)) return null;
  if (url.slice(0, 7).toLowerCase() === 'mailto:') return rebuildMailto(url.slice(7));
  if (PHONE_LINK.test(url)) return { kind: 'open-phone', url, target: url.slice(4) };
  return null;
}

export interface PermissionHost {
  // The tab's top-level URL, or null when `contents` is not a page view (then everything is denied).
  topUrl(contents: WebContents): string | null;
  // A page in HTML fullscreen could hide the prompt, so it can't ask.
  isFullscreen(contents: WebContents): boolean;
  // Shows the question in the tab and resolves with the answer; false if the tab navigates or closes first.
  ask(contents: WebContents, kind: PromptKind, origin: string): Promise<boolean>;
}

// Denies everything and shows no device chooser. Every new session starts like this; only the
// page session is then given the handlers below.
export function denyAllPermissions(targetSession: Session): void {
  targetSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setDevicePermissionHandler(() => false);
  targetSession.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  targetSession.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  targetSession.on('select-serial-port', (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback(''); // an empty id cancels
  });
}

// Per-site prompts for page views. Anything that is not a page tab is still denied.
export function installPermissionHandlers(
  targetSession: Session,
  host: PermissionHost,
  store: DecisionStore,
): void {
  targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const topUrl = host.topUrl(contents);
    if (topUrl === null) {
      callback(false);
      return;
    }
    const verdict = classifyPermission({
      permission,
      mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined,
      requestingUrl: details.requestingUrl,
      isMainFrame: details.isMainFrame,
      topUrl,
    });
    if (typeof verdict === 'string') {
      callback(verdict === 'allow');
      return;
    }
    if (host.isFullscreen(contents)) {
      callback(false); // not remembered
      return;
    }
    const remembered = store.recall(verdict.origin, verdict.ask);
    if (remembered !== undefined) callback(remembered);
    else host.ask(contents, verdict.ask, verdict.origin).then(callback);
  });

  targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const topUrl = contents ? host.topUrl(contents) : null;
    if (topUrl === null) return false;
    return isPermissionGranted(
      {
        permission,
        mediaTypes: details.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : [],
        requestingUrl: details.requestingUrl ?? requestingOrigin,
        isMainFrame: details.isMainFrame,
        topUrl,
      },
      store,
    );
  });
}
