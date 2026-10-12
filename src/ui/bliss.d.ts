// Mirrors the API exposed by src/preload/ui.ts.
interface Window {
  bliss: {
    platform: NodeJS.Platform;
    getVersion(): Promise<string>;
    getMetrics(): Promise<import('../shared/metrics').MetricsResult>;
    getTabsState(): Promise<import('../shared/tabs').TabsState>;
    navigateTab(id: number, input: string): Promise<boolean>;
    tabGo(id: number, action: import('../shared/tabs').TabAction): Promise<void>;
    setPageArea(area: import('../shared/tabs').PageArea): Promise<void>;
    onTabsUpdate(callback: (update: import('../shared/tabs').TabsUpdate) => void): () => void;
  };
}
