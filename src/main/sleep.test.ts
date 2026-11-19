import { describe, expect, it } from 'vitest';
import { type SleepCandidate, shouldAutoSleep, sleepLimitMs } from './sleep';

const MINUTE_MS = 60_000;
const NOW = 100 * MINUTE_MS;
const idle: SleepCandidate = {
  isActive: false,
  asleepOrRestoring: false,
  audible: false,
  mediaInUse: false,
  downloading: false,
  loading: false,
  devToolsOpen: false,
  hasPrompt: false,
  hasOpenPopup: false,
  lastActiveAt: NOW - 40 * MINUTE_MS,
};
const limit = 30 * MINUTE_MS;

describe('sleepLimitMs', () => {
  it('is 30 minutes with enough free memory', () => {
    expect(sleepLimitMs(1024 * 1024)).toBe(30 * MINUTE_MS);
    expect(sleepLimitMs(8 * 1024 * 1024)).toBe(30 * MINUTE_MS);
  });

  it('is 5 minutes under 1 GB free', () => {
    expect(sleepLimitMs(1024 * 1024 - 1)).toBe(5 * MINUTE_MS);
    expect(sleepLimitMs(0)).toBe(5 * MINUTE_MS);
  });
});

describe('shouldAutoSleep', () => {
  it('sleeps an idle background tab', () => {
    expect(shouldAutoSleep(idle, NOW, limit)).toBe(true);
  });

  it('waits until the limit is reached', () => {
    expect(shouldAutoSleep({ ...idle, lastActiveAt: NOW - limit + 1 }, NOW, limit)).toBe(false);
    expect(shouldAutoSleep({ ...idle, lastActiveAt: NOW - limit }, NOW, limit)).toBe(true);
  });

  it('uses the shorter limit when given', () => {
    const state = { ...idle, lastActiveAt: NOW - 6 * MINUTE_MS };
    expect(shouldAutoSleep(state, NOW, sleepLimitMs(0))).toBe(true);
    expect(shouldAutoSleep(state, NOW, sleepLimitMs(4 * 1024 * 1024))).toBe(false);
  });

  it.each([
    'isActive',
    'asleepOrRestoring',
    'audible',
    'mediaInUse',
    'downloading',
    'loading',
    'devToolsOpen',
    'hasPrompt',
    'hasOpenPopup',
  ] as const)('never sleeps a tab with %s', (reason) => {
    expect(shouldAutoSleep({ ...idle, [reason]: true }, NOW, limit)).toBe(false);
    expect(shouldAutoSleep({ ...idle, [reason]: true }, NOW, 0)).toBe(false);
  });
});
