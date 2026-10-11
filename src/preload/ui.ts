import { contextBridge, ipcRenderer } from 'electron';
import type { MetricsResult } from '../shared/metrics';

// Narrow API for the UI view. No raw ipcRenderer is ever exposed (PLAN section 7).
contextBridge.exposeInMainWorld('bliss', {
  platform: process.platform,
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  getMetrics: (): Promise<MetricsResult> => ipcRenderer.invoke('metrics:get'),
});
