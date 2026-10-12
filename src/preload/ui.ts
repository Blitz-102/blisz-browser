import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import type { MetricsResult } from '../shared/metrics';
import type { PageArea, TabAction, TabsState, TabsUpdate } from '../shared/tabs';

// Narrow API for the UI view. No raw ipcRenderer is ever exposed (PLAN section 7).
contextBridge.exposeInMainWorld('bliss', {
  platform: process.platform,
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  getMetrics: (): Promise<MetricsResult> => ipcRenderer.invoke('metrics:get'),
  getTabsState: (): Promise<TabsState> => ipcRenderer.invoke('tabs:get-state'),
  navigateTab: (id: number, input: string): Promise<boolean> =>
    ipcRenderer.invoke('tab:navigate', id, input),
  tabGo: (id: number, action: TabAction): Promise<void> => ipcRenderer.invoke('tab:go', id, action),
  setPageArea: (area: PageArea): Promise<void> => ipcRenderer.invoke('page:set-area', area),
  // The IPC event object stays in the preload; the UI only gets the update. Returns an unsubscribe function.
  onTabsUpdate: (callback: (update: TabsUpdate) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, update: TabsUpdate) => callback(update);
    ipcRenderer.on('tabs:update', listener);
    return () => ipcRenderer.removeListener('tabs:update', listener);
  },
});
