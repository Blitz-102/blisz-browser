import { pinnedSites } from './mockData';
import styles from './PinnedSites.module.css';

export function PinnedSites() {
  return (
    <ul className={styles.grid} aria-label="Pinned sites">
      {pinnedSites.map((site) => (
        <li key={site.url}>
          <button type="button" className={styles.tile} aria-label={site.title} title={site.title}>
            {site.title[0]}
          </button>
        </li>
      ))}
    </ul>
  );
}
