// Shared by main, preload and the UI (type only, so nothing is bundled).
export interface ProcessMetric {
  pid: number;
  type: string;
  label: string;
  // privateBytes is only reported on some platforms (Windows), hence null.
  privateKB: number | null;
  workingSetKB: number;
  cpuPercent: number;
}

export interface MetricsResult {
  processes: ProcessMetric[];
  totalPrivateKB: number;
  totalWorkingSetKB: number;
}
