// Mirrors the API exposed by src/preload/ui.ts.
interface Window {
  bliss: {
    platform: NodeJS.Platform;
    getVersion(): Promise<string>;
  };
}
