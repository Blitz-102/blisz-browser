import type { ProcessMetric } from './metrics';
import { isWebUrl } from './url';

export interface BenchSite {
  name: string;
  url: string;
}

export interface BenchConfig {
  settleSeconds: number;
  sites: BenchSite[];
}

// One row from scripts/measure-memory.ps1 -Json.
export interface MeasuredProcess {
  pid: number;
  name: string;
  privateWorkingSetKB: number;
}

// Validates bench/sites.json. Throws with a readable message on the first problem.
export function parseBenchConfig(data: unknown): BenchConfig {
  if (typeof data !== 'object' || data === null) throw new Error('Bench config must be an object');
  const { settleSeconds, sites } = data as Record<string, unknown>;
  if (
    typeof settleSeconds !== 'number' ||
    !Number.isInteger(settleSeconds) ||
    settleSeconds < 1 ||
    settleSeconds > 600
  ) {
    throw new Error('settleSeconds must be an integer from 1 to 600');
  }
  if (!Array.isArray(sites) || sites.length === 0) {
    throw new Error('sites must be a non-empty list');
  }
  const parsed = sites.map((site: unknown): BenchSite => {
    const { name, url } = (site ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || name === '') throw new Error('Every site needs a name');
    if (typeof url !== 'string' || !isWebUrl(url)) {
      throw new Error(`Site "${name}" needs an http or https URL`);
    }
    return { name, url };
  });
  return { settleSeconds, sites: parsed };
}

// Adds the private working set (from the script) to each Electron process row, matched by PID.
export function mergeByPid(
  processes: ProcessMetric[],
  measured: MeasuredProcess[],
): (ProcessMetric & { privateWorkingSetKB: number | null })[] {
  const byPid = new Map(measured.map((m) => [m.pid, m.privateWorkingSetKB]));
  return processes.map((p) => ({ ...p, privateWorkingSetKB: byPid.get(p.pid) ?? null }));
}
