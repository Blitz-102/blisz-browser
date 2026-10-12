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
    navigateTab(id: number, input: string): Promise<boolean>;
    tabGo(id: number, action: import('../shared/tabs').TabAction): Promise<void>;
    resetZoom(id: number): Promise<void>;
    findQuery(
      id: number,
      text: string,
      options: import('../shared/tabs').FindOptions,
    ): Promise<void>;
    findStop(id: number, focusPage: boolean): Promise<void>;
    setPageArea(area: import('../shared/tabs').PageArea): Promise<void>;
    onTabsUpdate(callback: (update: import('../shared/tabs').TabsUpdate) => void): () => void;
    onFocusAddress(callback: () => void): () => void;
    onOpenFind(callback: () => void): () => void;
    onCloseFind(callback: () => void): () => void;
    onFindResult(callback: (result: import('../shared/tabs').FindResult) => void): () => void;
  };
}
