import { contextBridge, ipcRenderer } from 'electron';

// Narrow API for the UI view. No raw ipcRenderer is ever exposed (PLAN section 7).
contextBridge.exposeInMainWorld('bliss', {
  platform: process.platform,
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
});
