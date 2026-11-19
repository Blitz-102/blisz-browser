import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app, type WebContents } from 'electron';
import { type MeasuredProcess, mergeByPid, parseBenchConfig } from '../shared/bench';
import { getMetrics } from './metrics';
import { countLoadedTabs, getTabProcessLabels, openBenchTabs, sleepBackgroundTabs } from './tabs';

const SAFETY_MARGIN_MS = 90_000;
const SCRIPT_TIMEOUT_MS = 30_000;
const SLEEP_SETTLE_MS = 15_000; // time for the renderers of sleeping tabs to exit
const toMB = (kb: number) => (kb / 1024).toFixed(1);
const run = promisify(execFile);

function fail(message: string, error?: unknown): void {
  console.error(message, error ?? '');
  process.exitCode = 1;
  app.quit();
}

// Runs scripts/measure-memory.ps1 on this app's own process tree. Fixed script path and
// arguments; the only variable is our own PID.
async function measurePrivateWorkingSet(): Promise<{
  totalKB: number;
  processes: MeasuredProcess[];
}> {
  const script = join(app.getAppPath(), 'scripts', 'measure-memory.ps1');
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-RootPid',
      String(process.pid),
      '-Json',
    ],
    { timeout: SCRIPT_TIMEOUT_MS },
  );
  return JSON.parse(stdout);
}

// Opens the sites from bench/sites.json, waits for them to settle, prints per-process memory,
// then quits. Always exits: on any failure it sets exit code 1. Sync file reads are fine here;
// this is a one-off run, not a hot path.
export function runBench(ui: WebContents): void {
  let settleMs: number;
  let urls: string[];
  try {
    // The config path can only be overridden in an unpackaged build (tests use fixtures).
    const configPath =
      (!app.isPackaged && process.env.BLISZ_BENCH_CONFIG) ||
      join(app.getAppPath(), 'bench', 'sites.json');
    const config = parseBenchConfig(JSON.parse(readFileSync(configPath, 'utf-8')));
    settleMs = config.settleSeconds * 1000;
    urls = config.sites.map((site) => site.url);
  } catch (error) {
    fail('Could not read the bench config', error);
    return;
  }

  setTimeout(() => fail('Bench timed out'), settleMs + SLEEP_SETTLE_MS + SAFETY_MARGIN_MS).unref();
  ui.once('did-fail-load', (_event, _code, description) =>
    fail(`UI failed to load: ${description}`),
  );
  ui.once('did-finish-load', () => {
    openBenchTabs(urls);
    // CPU % is measured since the previous call, so this resets it to cover the settle window.
    app.getAppMetrics();
    setTimeout(() => {
      measureBoth(ui, urls.length, settleMs)
        .catch((error) => {
          process.exitCode = 1;
          console.error('Bench failed', error);
        })
        .finally(() => app.quit());
    }, settleMs);
  });
}

async function measureBoth(ui: WebContents, tabCount: number, settleMs: number): Promise<void> {
  console.log(`Tabs finished loading: ${countLoadedTabs()} of ${tabCount}`);
  await report(ui, `Memory after ${settleMs / 1000}s settle (MB)`);
  sleepBackgroundTabs();
  await new Promise((resolve) => setTimeout(resolve, SLEEP_SETTLE_MS));
  await report(ui, `Memory after sleeping background tabs, ${SLEEP_SETTLE_MS / 1000}s later (MB)`);
}

async function report(ui: WebContents, heading: string): Promise<void> {
  const { processes, totalPrivateKB, totalWorkingSetKB } = getMetrics(
    ui.getOSProcessId(),
    getTabProcessLabels(),
  );
  let measured: Awaited<ReturnType<typeof measurePrivateWorkingSet>> | null = null;
  if (process.platform === 'win32') {
    measured = await measurePrivateWorkingSet();
  } else {
    console.log('Private working set skipped: measure-memory.ps1 only runs on Windows.');
  }
  const rows = mergeByPid(processes, measured?.processes ?? []);

  console.log(heading);
  console.table(
    rows.map((p) => ({
      pid: p.pid,
      label: p.label,
      type: p.type,
      privateMB: p.privateKB === null ? '-' : toMB(p.privateKB),
      privateWorkingSetMB: p.privateWorkingSetKB === null ? '-' : toMB(p.privateWorkingSetKB),
      workingSetMB: toMB(p.workingSetKB),
      cpuPercent: p.cpuPercent.toFixed(1),
    })),
  );
  console.log(
    `Total private: ${toMB(totalPrivateKB)} MB, working set: ${toMB(totalWorkingSetKB)} MB`,
  );
  if (measured) {
    console.log(`Total private working set: ${toMB(measured.totalKB)} MB`);
  }
}
