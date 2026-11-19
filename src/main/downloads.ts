import { existsSync } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, type DownloadItem, type Session, shell, type WebContents } from 'electron';
import type { DownloadInfo } from '../shared/downloads';
import {
  imageFilename,
  isOpenableFilename,
  sanitizeFilename,
  uniqueFilename,
  zoneIdentifier,
} from './downloadFiles';
import { handleFromUi } from './ipc';
import { closeDownloadOnlyPopup, gateDownload } from './tabs';

const MAX_LISTED = 5;
const MAX_RUNNING = 5;
const PROGRESS_INTERVAL_MS = 250; // at most 4 progress updates per second per download

interface DownloadRecord {
  info: DownloadInfo;
  path: string; // main's own record; the UI only ever sends an id
  item: DownloadItem | null; // only while the download runs
  lastSentAt: number;
}

const records: DownloadRecord[] = []; // oldest first
// Tabs whose "Save as" dialog is open; a page can't stack dialogs. They count toward MAX_RUNNING.
const pendingDialogs = new Set<WebContents>();
// Items that were allowed to start and haven't finished (including ones waiting for the dialog),
// with the page that started each. A record only exists once bytes arrive, so this is separate.
const runningFrom = new Map<DownloadItem, WebContents>();
const claimedPaths = new Set<string>(); // test-only: files of running downloads, lower-cased
let nextId = 1;

// Whether `contents` has a download running; its tab must not be put to sleep.
export function hasRunningDownload(contents: WebContents): boolean {
  return pendingDialogs.has(contents) || [...runningFrom.values()].includes(contents);
}

function findRecord(id: unknown): DownloadRecord | undefined {
  if (!Number.isInteger(id)) throw new Error('Bad download id');
  return records.find((record) => record.info.id === id);
}

function originOf(url: string): string {
  return URL.canParse(url) ? new URL(url).origin : '';
}

// A finished file keeps its Mark of the Web, which SmartScreen and Office use to warn about
// internet files. Chromium writes it itself; this covers the case where it didn't. Returns whether
// the stream exists in the end, so a file we couldn't mark is never offered for Open.
async function ensureMarkOfTheWeb(
  path: string,
  pageUrl: string,
  downloadUrl: string,
): Promise<boolean> {
  const stream = `${path}:Zone.Identifier`;
  const exists = () =>
    readFile(stream).then(
      () => true,
      () => false,
    );
  if (await exists()) return true;
  await writeFile(stream, zoneIdentifier(pageUrl, downloadUrl)).catch(() => {});
  return exists();
}

// Gates and saves downloads of the page session, and keeps the UI's list up to date.
export function initDownloads(
  ui: WebContents,
  pageSession: Session,
  saveWithoutPrompt: boolean,
): void {
  const sendList = () => {
    if (!ui.isDestroyed()) {
      ui.send(
        'downloads:update',
        records.map((record) => record.info),
      );
    }
  };

  pageSession.on('will-download', (event, item, contents, frame) => {
    // A frame from another site (an ad or embed) can't start downloads. When the frame is already
    // gone, the initiator origin from the item stands in for it.
    const initiator = item.getInitiatorOrigin();
    let foreignFrame: boolean;
    if (frame) {
      // The main frame may start any download (a new popup has no origin of its own yet).
      const topOrigin = (frame.top ?? frame).origin;
      foreignFrame =
        frame.parent !== null &&
        (frame.origin !== topOrigin || (initiator !== '' && initiator !== topOrigin));
    } else {
      const topOrigin = originOf(contents.getURL());
      foreignFrame = topOrigin !== '' && initiator !== topOrigin;
    }
    const running = records.filter((record) => record.item !== null).length;
    const gate = gateDownload(
      contents,
      item.getURLChain()[0] ?? item.getURL(),
      foreignFrame || pendingDialogs.has(contents) || running + pendingDialogs.size >= MAX_RUNNING,
    );
    // "Save image as" must really get an image, not a page or file the URL turned into, and the file
    // gets the extension of that image type.
    let suggestedName = sanitizeFilename(item.getFilename());
    const imageName =
      gate === 'save-image' ? imageFilename(suggestedName, item.getMimeType()) : null;
    if (imageName) suggestedName = imageName;
    if (!gate || (gate === 'save-image' && !imageName)) {
      event.preventDefault();
      if (!app.isPackaged) console.warn('Download blocked');
      return;
    }

    runningFrom.set(item, contents);
    item.once('done', () => runningFrom.delete(item));

    const pageUrl = contents.getURL();
    const downloadUrl = item.getURLChain().at(-1) ?? item.getURL();
    const directory = app.getPath('downloads');
    if (saveWithoutPrompt) {
      // Test-only (see index.ts): save straight into the Downloads folder, since a smoke test can't
      // drive the native dialog. setSavePath must run before this handler returns. Names of
      // running downloads aren't on disk yet, so they are remembered in `claimedPaths`.
      const name = uniqueFilename(suggestedName, (candidate) => {
        const taken = join(directory, candidate).toLowerCase();
        return claimedPaths.has(taken) || existsSync(join(directory, candidate));
      });
      item.setSavePath(join(directory, name));
      claimedPaths.add(join(directory, name).toLowerCase());
      item.once('done', () => claimedPaths.delete(join(directory, name).toLowerCase()));
    } else {
      // Without a save path Electron shows the Windows "Save as" dialog, which also asks before
      // overwriting a file. The page can't get here without a real click (see gateDownload).
      pendingDialogs.add(contents);
      item.setSaveDialogOptions({ title: 'Save as', defaultPath: join(directory, suggestedName) });
    }

    // The download only starts once a place is chosen, so the list entry is made then. Cancelling
    // the dialog leaves no entry.
    let record: DownloadRecord | undefined;
    const startRecord = (): DownloadRecord => {
      if (record) return record;
      const path = item.getSavePath();
      record = {
        info: {
          id: nextId++,
          filename: basename(path) || suggestedName,
          state: 'progressing',
          receivedBytes: 0,
          totalBytes: item.getTotalBytes(),
          canOpen: false,
        },
        path,
        item,
        lastSentAt: 0,
      };
      records.push(record);
      while (records.length > MAX_LISTED) {
        const finished = records.findIndex((other) => other.item === null);
        if (finished === -1) break;
        records.splice(finished, 1);
      }
      closeDownloadOnlyPopup(contents);
      return record;
    };

    item.on('updated', (_event, state) => {
      if (item.getSavePath() === '') return; // still waiting for the dialog
      pendingDialogs.delete(contents);
      const current = startRecord();
      current.info.receivedBytes = item.getReceivedBytes();
      current.info.totalBytes = item.getTotalBytes();
      if (state === 'interrupted') {
        // There is no resume button, so end it: cancelling makes 'done' fire.
        current.info.state = 'interrupted';
        current.lastSentAt = Date.now();
        sendList();
        item.cancel();
        return;
      }
      const now = Date.now();
      if (now - current.lastSentAt < PROGRESS_INTERVAL_MS) return;
      current.lastSentAt = now;
      sendList();
    });

    item.once('done', async (_event, state) => {
      pendingDialogs.delete(contents);
      if (!record && state === 'cancelled') {
        closeDownloadOnlyPopup(contents); // the dialog was cancelled
        return;
      }
      const current = startRecord();
      current.item = null;
      current.path = item.getSavePath() || current.path;
      current.info.filename = basename(current.path) || current.info.filename;
      current.info.receivedBytes = item.getReceivedBytes();
      current.info.totalBytes = item.getTotalBytes();
      if (current.info.state !== 'interrupted') current.info.state = state; // keep "Failed" after item.cancel()
      const completed = current.info.state === 'completed';
      let canOpen = completed && isOpenableFilename(current.info.filename);
      // Every finished file gets its Mark of the Web, and may only be opened once it has one. The
      // UI hears about the finished download after that.
      if (completed && process.platform === 'win32') {
        const marked = await ensureMarkOfTheWeb(current.path, pageUrl, downloadUrl).catch(
          () => false,
        );
        canOpen &&= marked;
      }
      current.info.canOpen = canOpen;
      sendList();
    });
  });

  handleFromUi('downloads:open', async (_event, id) => {
    const record = findRecord(id);
    if (!record?.info.canOpen) return;
    // The file may have been moved or deleted since it finished.
    try {
      await access(record.path);
    } catch {
      return;
    }
    const error = await shell.openPath(record.path);
    if (error && !app.isPackaged) console.warn('Could not open the download:', error);
  });
  handleFromUi('downloads:show', (_event, id) => {
    const record = findRecord(id);
    if (record?.info.state === 'completed') shell.showItemInFolder(record.path);
  });
  handleFromUi('downloads:cancel', (_event, id) => {
    findRecord(id)?.item?.cancel();
  });
  handleFromUi('downloads:clear', () => {
    for (let index = records.length - 1; index >= 0; index--) {
      if (records[index]?.item === null) records.splice(index, 1);
    }
    sendList();
  });
}
