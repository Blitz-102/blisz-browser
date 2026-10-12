import { app } from 'electron';
import type { MetricsResult } from '../shared/metrics';

// tabLabels maps a page process id to its tab label (PLAN 5.1).
export function getMetrics(uiPid: number, tabLabels: Map<number, string>): MetricsResult {
  const processes = app.getAppMetrics().map((metric) => {
    const label =
      metric.pid === uiPid ? 'UI' : (tabLabels.get(metric.pid) ?? metric.name ?? metric.type);
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
