// Mirrors the API exposed by src/preload/ui.ts.
interface Window {
  bliss: {
    platform: NodeJS.Platform;
    getVersion(): Promise<string>;
    getMetrics(): Promise<import('../shared/metrics').MetricsResult>;
    getTabsState(): Promise<import('../shared/tabs').TabsState>;
    createTab(): Promise<number>;
    closeTab(id: number): Promise<void>;
    activateTab(id: number): Promise<void>;
    duplicateTab(id: number): Promise<number>;
    tabContextMenu(id: number): Promise<void>;
    openDownload(id: number): Promise<void>;
    showDownload(id: number): Promise<void>;
    cancelDownload(id: number): Promise<void>;
    clearDownloads(): Promise<void>;
    navigateTab(id: number, input: string): Promise<boolean>;
    tabGo(id: number, action: import('../shared/tabs').TabAction): Promise<void>;
    resetZoom(id: number): Promise<void>;
    respondToPrompt(id: number, allow: boolean): Promise<void>;
    findQuery(
      id: number,
      text: string,
      options: import('../shared/tabs').FindOptions,
    ): Promise<void>;
    findStop(id: number, focusPage: boolean): Promise<void>;
    queryHistory(
      text: string,
      cursor: import('../shared/history').HistoryCursor | null,
    ): Promise<import('../shared/history').HistoryPage>;
    deleteHistory(id: number): Promise<void>;
    setPageArea(area: import('../shared/tabs').PageArea): Promise<void>;
    onTabsUpdate(callback: (update: import('../shared/tabs').TabsUpdate) => void): () => void;
    onDownloadsUpdate(
      callback: (downloads: import('../shared/downloads').DownloadInfo[]) => void,
    ): () => void;
    onFocusAddress(callback: () => void): () => void;
    onOpenFind(callback: () => void): () => void;
    onCloseFind(callback: () => void): () => void;
    onToggleHistory(callback: () => void): () => void;
    onFindResult(callback: (result: import('../shared/tabs').FindResult) => void): () => void;
  };
}
