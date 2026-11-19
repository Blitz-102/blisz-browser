const MINUTE_MS = 60_000;
const LOW_MEMORY_KB = 1024 * 1024; // 1 GB

// How long a background tab may sit idle before it falls asleep: sooner when the machine is short on memory.
export function sleepLimitMs(freeMemoryKb: number): number {
  return freeMemoryKb < LOW_MEMORY_KB ? 5 * MINUTE_MS : 30 * MINUTE_MS;
}

export interface SleepCandidate {
  isActive: boolean;
  asleepOrRestoring: boolean;
  audible: boolean;
  mediaInUse: boolean; // camera or microphone was allowed for this page
  downloading: boolean;
  loading: boolean;
  devToolsOpen: boolean;
  hasPrompt: boolean;
  hasOpenPopup: boolean;
  lastActiveAt: number; // ms
}

// A tab sleeps only when it has been idle for `limitMs` and nothing it does would be lost.
export function shouldAutoSleep(tab: SleepCandidate, now: number, limitMs: number): boolean {
  const busy =
    tab.isActive ||
    tab.asleepOrRestoring ||
    tab.audible ||
    tab.mediaInUse ||
    tab.downloading ||
    tab.loading ||
    tab.devToolsOpen ||
    tab.hasPrompt ||
    tab.hasOpenPopup;
  return !busy && now - tab.lastActiveAt >= limitMs;
}
