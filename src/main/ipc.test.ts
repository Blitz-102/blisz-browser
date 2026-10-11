import * as electron from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const handlers = new Map<string, Handler>();
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
}));

const UI_FRAME_URL = 'blisz://app/index.html';

// ipc.ts resolves UI_URL when it loads, so each test imports a fresh copy.
async function loadIpc(devUrl?: string, isPackaged = false) {
  vi.resetModules();
  (electron.app as { isPackaged: boolean }).isPackaged = isPackaged;
  if (devUrl) vi.stubEnv('ELECTRON_RENDERER_URL', devUrl);
  const ipc = await import('./ipc');
  const handler = vi.fn(() => 'ok');
  ipc.handleFromUi('test:channel', handler);
  return { ipc, handler, invoke: (event: unknown) => handlers.get('test:channel')?.(event) };
}

function makeSender() {
  const mainFrame = { url: UI_FRAME_URL };
  return { mainFrame };
}

describe('handleFromUi sender check', () => {
  beforeEach(() => handlers.clear());
  afterEach(() => vi.unstubAllEnvs());

  it('accepts the trusted view main frame at the UI origin', async () => {
    const { ipc, handler, invoke } = await loadIpc();
    const sender = makeSender();
    ipc.addTrustedUi(sender as never);
    expect(invoke({ sender, senderFrame: sender.mainFrame })).toBe('ok');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects an untrusted webContents', async () => {
    const { handler, invoke } = await loadIpc();
    const sender = makeSender();
    expect(() => invoke({ sender, senderFrame: sender.mainFrame })).toThrow('Untrusted IPC sender');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a subframe', async () => {
    const { ipc, handler, invoke } = await loadIpc();
    const sender = makeSender();
    ipc.addTrustedUi(sender as never);
    const subframe = { url: UI_FRAME_URL };
    expect(() => invoke({ sender, senderFrame: subframe })).toThrow('Untrusted IPC sender');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a null senderFrame', async () => {
    const { ipc, handler, invoke } = await loadIpc();
    const sender = makeSender();
    ipc.addTrustedUi(sender as never);
    expect(() => invoke({ sender, senderFrame: null })).toThrow('Untrusted IPC sender');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a frame at another origin', async () => {
    const { ipc, handler, invoke } = await loadIpc();
    const sender = { mainFrame: { url: 'https://example.com/index.html' } };
    ipc.addTrustedUi(sender as never);
    expect(() => invoke({ sender, senderFrame: sender.mainFrame })).toThrow('Untrusted IPC sender');
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts the dev server origin and rejects a different port', async () => {
    const { ipc, invoke } = await loadIpc('http://localhost:5173');
    const good = { mainFrame: { url: 'http://localhost:5173/' } };
    const otherPort = { mainFrame: { url: 'http://localhost:5174/' } };
    ipc.addTrustedUi(good as never);
    ipc.addTrustedUi(otherPort as never);
    expect(invoke({ sender: good, senderFrame: good.mainFrame })).toBe('ok');
    expect(() => invoke({ sender: otherPort, senderFrame: otherPort.mainFrame })).toThrow(
      'Untrusted IPC sender',
    );
  });

  it('rejects the right host with a different protocol', async () => {
    const { ipc, handler, invoke } = await loadIpc();
    const sender = { mainFrame: { url: 'http://app/index.html' } };
    ipc.addTrustedUi(sender as never);
    expect(() => invoke({ sender, senderFrame: sender.mainFrame })).toThrow('Untrusted IPC sender');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an unparseable frame URL', async () => {
    const { ipc, handler, invoke } = await loadIpc();
    const sender = { mainFrame: { url: 'not a url' } };
    ipc.addTrustedUi(sender as never);
    expect(() => invoke({ sender, senderFrame: sender.mainFrame })).toThrow('Untrusted IPC sender');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects blisz with an empty host', async () => {
    const { ipc, handler, invoke } = await loadIpc();
    const sender = { mainFrame: { url: 'blisz:///index.html' } };
    ipc.addTrustedUi(sender as never);
    expect(() => invoke({ sender, senderFrame: sender.mainFrame })).toThrow('Untrusted IPC sender');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('UI_URL', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses an http://localhost dev server URL', async () => {
    const { ipc } = await loadIpc('http://localhost:5173');
    expect(ipc.UI_URL).toBe('http://localhost:5173');
  });

  it('ignores a non-localhost dev server URL', async () => {
    const { ipc } = await loadIpc('http://example.com:5173');
    expect(ipc.UI_URL).toBe(UI_FRAME_URL);
  });

  it('ignores an https dev server URL', async () => {
    const { ipc } = await loadIpc('https://localhost:5173');
    expect(ipc.UI_URL).toBe(UI_FRAME_URL);
  });

  it('ignores the dev server URL when packaged', async () => {
    const { ipc } = await loadIpc('http://localhost:5173', true);
    expect(ipc.UI_URL).toBe(UI_FRAME_URL);
  });
});
