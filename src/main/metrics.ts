import { app } from 'electron';
import type { MetricsResult } from '../shared/metrics';

// Phase 2 will also label page processes by tab (PLAN 5.1).
export function getMetrics(uiPid: number): MetricsResult {
  const processes = app.getAppMetrics().map((metric) => {
    const label = metric.pid === uiPid ? 'UI' : (metric.name ?? metric.type);
    return {
      pid: metric.pid,
      type: metric.type,
      label,
      privateKB: metric.memory.privateBytes ?? null,
      workingSetKB: metric.memory.workingSetSize,
      cpuPercent: metric.cpu.percentCPUUsage,
    };
  });
  return {
    processes,
    totalPrivateKB: processes.reduce((sum, p) => sum + (p.privateKB ?? 0), 0),
    totalWorkingSetKB: processes.reduce((sum, p) => sum + p.workingSetKB, 0),
  };
}
