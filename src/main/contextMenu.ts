import {
  type BaseWindow,
  type ContextMenuParams,
  clipboard,
  Menu,
  type WebContents,
} from 'electron';
import { searchUrl } from '../shared/address';
import {
  buildPageMenu,
  type EditCommand,
  type MenuAction,
  type MenuEntry,
} from './contextMenuTemplate';

// What the page menu needs from the tab manager.
interface PageMenuHost {
  openTab(url: string, options: { background: boolean }): void;
  saveImage(url: string): void;
  saveLink(url: string): void;
}

const EDIT_COMMANDS: Record<EditCommand, (contents: WebContents) => void> = {
  undo: (contents) => contents.undo(),
  redo: (contents) => contents.redo(),
  cut: (contents) => contents.cut(),
  copy: (contents) => contents.copy(),
  paste: (contents) => contents.paste(),
  'paste-plain': (contents) => contents.pasteAndMatchStyle(),
  'select-all': (contents) => contents.selectAll(),
};

function toMenu(entries: MenuEntry[], run: (action: MenuAction) => void): Menu {
  return Menu.buildFromTemplate(
    entries.map((entry) =>
      entry === 'separator'
        ? { type: 'separator' }
        : { label: entry.label, enabled: entry.enabled, click: () => run(entry.action) },
    ),
  );
}

// A native menu for a right-click on a page. Everything runs here in main; the page only supplied
// the click position and what was under it, and nothing goes through shell.openExternal.
export function popupPageMenu(
  window: BaseWindow,
  contents: WebContents,
  params: ContextMenuParams,
  host: PageMenuHost,
): void {
  const run = (action: MenuAction) => {
    switch (action.type) {
      case 'open-link':
        host.openTab(action.url, { background: true });
        break;
      case 'open-image':
        host.openTab(action.url, { background: false });
        break;
      case 'search':
        host.openTab(searchUrl(action.text), { background: false });
        break;
      case 'save-image':
        host.saveImage(action.url);
        break;
      case 'save-link':
        host.saveLink(action.url);
        break;
      case 'copy-text':
        clipboard.writeText(action.text).catch(() => {}); // main only: the UI view can't write the clipboard
        break;
      case 'copy-image':
        contents.copyImageAt(params.x, params.y);
        break;
      case 'replace-misspelling':
        contents.replaceMisspelling(action.word);
        break;
      case 'edit':
        EDIT_COMMANDS[action.command](contents);
        break;
      case 'go':
        if (action.direction === 'back') contents.navigationHistory.goBack();
        else if (action.direction === 'forward') contents.navigationHistory.goForward();
        else contents.reload();
        break;
      case 'inert':
        break;
      case 'inspect':
        contents.openDevTools({ mode: 'detach' }); // a WebContentsView has no window to dock into
        contents.inspectElement(params.x, params.y);
        break;
    }
  };
  const entries = buildPageMenu(params, {
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  });
  toMenu(entries, run).popup({ window });
}

// The menu for a right-click on a tab row in the sidebar.
export function popupTabMenu(
  window: BaseWindow,
  actions: { duplicate(): void; close(): void },
): void {
  Menu.buildFromTemplate([
    { label: 'Duplicate', click: actions.duplicate },
    { label: 'Close', click: actions.close },
  ]).popup({ window });
}
