import { app, type WebContents } from 'electron';
import { getMetrics } from './metrics';
import { getTabProcessLabels } from './tabs';

const SETTLE_MS = 10_000;
const SAFETY_TIMEOUT_MS = 60_000;
const toMB = (kb: number) => (kb / 1024).toFixed(1);

function fail(message: string, error?: unknown): void {
  console.error(message, error ?? '');
  process.exitCode = 1;
  app.quit();
}

// Prints per-process memory after a fixed settle time, then quits. Always exits: on any
// failure it sets exit code 1. Phase 2 will open the benchmark tab set first.
export function runBench(ui: WebContents): void {
  setTimeout(() => fail('Bench timed out'), SAFETY_TIMEOUT_MS).unref();
  ui.once('did-fail-load', (_event, _code, description) =>
    fail(`UI failed to load: ${description}`),
  );
  ui.once('did-finish-load', () => {
    // CPU % is measured since the previous call, so this resets it to cover the settle window.
    app.getAppMetrics();
    setTimeout(() => {
      try {
        const { processes, totalPrivateKB, totalWorkingSetKB } = getMetrics(
          ui.getOSProcessId(),
          getTabProcessLabels(),
        );
        console.log(`Memory after ${SETTLE_MS / 1000}s settle (MB)`);
        console.table(
          processes.map((p) => ({
            pid: p.pid,
            label: p.label,
            type: p.type,
            privateMB: p.privateKB === null ? '-' : toMB(p.privateKB),
            workingSetMB: toMB(p.workingSetKB),
            cpuPercent: p.cpuPercent.toFixed(1),
          })),
        );
        console.log(
          `Total private: ${toMB(totalPrivateKB)} MB, working set: ${toMB(totalWorkingSetKB)} MB`,
        );
      } catch (error) {
        process.exitCode = 1;
        console.error('Bench failed', error);
      } finally {
        app.quit();
      }
    }, SETTLE_MS);
  });
}
