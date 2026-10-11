import { app, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';

const trustedUis = new WeakSet<WebContents>();

export function addTrustedUi(webContents: WebContents): void {
  trustedUis.add(webContents);
}

// The one definition of the UI URL, used by the loader and by the sender check.
// Only a local dev server may supply a URL, and only when unpackaged.
function resolveUiUrl(): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) {
    if (URL.canParse(devUrl)) {
      const { protocol, hostname } = new URL(devUrl);
      if (protocol === 'http:' && hostname === 'localhost') return devUrl;
    }
    console.warn(`Ignoring ELECTRON_RENDERER_URL (only http://localhost is allowed): ${devUrl}`);
  }
  return 'blisz://app/index.html';
}

export const UI_URL = resolveUiUrl();

// Node's URL.origin is "null" for blisz:// (only http(s) and a few schemes have one),
// so compare protocol plus host (host includes the port) instead.
function isUiOrigin(frameUrl: string): boolean {
  if (!URL.canParse(frameUrl)) return false;
  const frame = new URL(frameUrl);
  const ui = new URL(UI_URL);
  return frame.host !== '' && frame.protocol === ui.protocol && frame.host === ui.host;
}

// Registers an ipcMain.handle handler that only trusted UI views may call.
// Handlers receive unknown args and must validate them themselves.
export function handleFromUi<Result>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Result,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    const frame = event.senderFrame;
    const isTrusted =
      frame !== null &&
      trustedUis.has(event.sender) &&
      frame === event.sender.mainFrame &&
      isUiOrigin(frame.url);
    if (!isTrusted) throw new Error('Untrusted IPC sender');
    return handler(event, ...args);
  });
}
