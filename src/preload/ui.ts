import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import type { DownloadInfo } from '../shared/downloads';
import type { HistoryCursor, HistoryPage } from '../shared/history';
import type { MetricsResult } from '../shared/metrics';
import type {
  FindOptions,
  FindResult,
  PageArea,
  TabAction,
  TabsState,
  TabsUpdate,
} from '../shared/tabs';

// Narrow API for the UI view. No raw ipcRenderer is ever exposed (PLAN section 7).
contextBridge.exposeInMainWorld('bliss', {
  platform: process.platform,
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  getMetrics: (): Promise<MetricsResult> => ipcRenderer.invoke('metrics:get'),
  getTabsState: (): Promise<TabsState> => ipcRenderer.invoke('tabs:get-state'),
  createTab: (): Promise<number> => ipcRenderer.invoke('tabs:create'),
  closeTab: (id: number): Promise<void> => ipcRenderer.invoke('tabs:close', id),
  activateTab: (id: number): Promise<void> => ipcRenderer.invoke('tabs:activate', id),
  duplicateTab: (id: number): Promise<number> => ipcRenderer.invoke('tabs:duplicate', id),
  tabContextMenu: (id: number): Promise<void> => ipcRenderer.invoke('tabs:context-menu', id),
  openDownload: (id: number): Promise<void> => ipcRenderer.invoke('downloads:open', id),
  showDownload: (id: number): Promise<void> => ipcRenderer.invoke('downloads:show', id),
  cancelDownload: (id: number): Promise<void> => ipcRenderer.invoke('downloads:cancel', id),
  clearDownloads: (): Promise<void> => ipcRenderer.invoke('downloads:clear'),
  navigateTab: (id: number, input: string): Promise<boolean> =>
    ipcRenderer.invoke('tab:navigate', id, input),
  tabGo: (id: number, action: TabAction): Promise<void> => ipcRenderer.invoke('tab:go', id, action),
  resetZoom: (id: number): Promise<void> => ipcRenderer.invoke('tab:reset-zoom', id),
  respondToPrompt: (id: number, allow: boolean): Promise<void> =>
    ipcRenderer.invoke('prompts:respond', id, allow),
  findQuery: (id: number, text: string, options: FindOptions): Promise<void> =>
    ipcRenderer.invoke('find:query', id, text, options),
  findStop: (id: number, focusPage: boolean): Promise<void> =>
    ipcRenderer.invoke('find:stop', id, focusPage),
  queryHistory: (text: string, cursor: HistoryCursor | null): Promise<HistoryPage> =>
    ipcRenderer.invoke('history:query', text, cursor),
  deleteHistory: (id: number): Promise<void> => ipcRenderer.invoke('history:delete', id),
  setPageArea: (area: PageArea): Promise<void> => ipcRenderer.invoke('page:set-area', area),
  // The IPC event object stays in the preload; the UI only gets the update. Returns an unsubscribe function.
  onTabsUpdate: (callback: (update: TabsUpdate) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, update: TabsUpdate) => callback(update);
    ipcRenderer.on('tabs:update', listener);
    return () => ipcRenderer.removeListener('tabs:update', listener);
  },
  onDownloadsUpdate: (callback: (downloads: DownloadInfo[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, downloads: DownloadInfo[]) => callback(downloads);
    ipcRenderer.on('downloads:update', listener);
    return () => ipcRenderer.removeListener('downloads:update', listener);
  },
  // Main asks the UI to focus the address field (Ctrl+L, Alt+D, F6). Returns an unsubscribe function.
  onFocusAddress: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('ui:focus-address', listener);
    return () => ipcRenderer.removeListener('ui:focus-address', listener);
  },
  // Main asks the UI to show the find strip (Ctrl+F) or hide it (tab switch, navigation).
  onOpenFind: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('ui:open-find', listener);
    return () => ipcRenderer.removeListener('ui:open-find', listener);
  },
  onCloseFind: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('ui:close-find', listener);
    return () => ipcRenderer.removeListener('ui:close-find', listener);
  },
  // Main asks the UI to open or close the history panel (Ctrl+H).
  onToggleHistory: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('ui:toggle-history', listener);
    return () => ipcRenderer.removeListener('ui:toggle-history', listener);
  },
  onFindResult: (callback: (result: FindResult) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, result: FindResult) => callback(result);
    ipcRenderer.on('find:result', listener);
    return () => ipcRenderer.removeListener('find:result', listener);
  },
});
