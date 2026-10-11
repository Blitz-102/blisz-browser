import { useEffect, useState } from 'react';
import type { MetricsResult } from '../shared/metrics';
import styles from './MemoryPanel.module.css';

const REFRESH_MS = 2000;
const toMB = (kb: number) => (kb / 1024).toFixed(1);

// Mounted only while open, so the interval runs only while the panel is visible.
export function MemoryPanel() {
  const [metrics, setMetrics] = useState<MetricsResult | null>(null);

  useEffect(() => {
    const refresh = () =>
      window.bliss
        .getMetrics()
        .then(setMetrics)
        .catch((error) => console.error('Failed to read metrics', error));
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  if (!metrics) return null;

  return (
    <table className={styles.table} aria-label="Memory by process">
      <thead>
        <tr>
          <th scope="col">Process</th>
          <th scope="col">Type</th>
          <th scope="col">Private MB</th>
          <th scope="col">Working set MB</th>
          <th scope="col">CPU %</th>
        </tr>
      </thead>
      <tbody>
        {metrics.processes.map((p) => (
          <tr key={p.pid}>
            <td>{p.label}</td>
            <td>{p.type}</td>
            <td>{p.privateKB === null ? '-' : toMB(p.privateKB)}</td>
            <td>{toMB(p.workingSetKB)}</td>
            <td>{p.cpuPercent.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={2}>
            Total
          </th>
          <td>{toMB(metrics.totalPrivateKB)}</td>
          <td>{toMB(metrics.totalWorkingSetKB)}</td>
          <td />
        </tr>
      </tfoot>
    </table>
  );
}
