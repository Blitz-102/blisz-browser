import { useEffect, useId, useRef, useState } from 'react';
import type { DownloadInfo, DownloadState } from '../shared/downloads';
import styles from './Downloads.module.css';

interface DownloadsProps {
  downloads: DownloadInfo[];
  onOpen: (id: number) => void;
  onShow: (id: number) => void;
  onCancel: (id: number) => void;
  onClear: () => void;
}

const FINISHED_LABELS = {
  completed: 'Done',
  cancelled: 'Cancelled',
  interrupted: 'Failed',
} as const;

function percent({ receivedBytes, totalBytes }: DownloadInfo): number | null {
  return totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : null;
}

export function Downloads({ downloads, onOpen, onShow, onCancel, onClear }: DownloadsProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStates = useRef(new Map<number, DownloadState>());
  const [announcement, setAnnouncement] = useState('');

  // Tell screen readers when a download finishes, fails or is cancelled (not on every progress tick).
  useEffect(() => {
    const previous = previousStates.current;
    for (const { id, filename, state } of downloads) {
      if (state !== 'progressing' && previous.get(id) === 'progressing') {
        setAnnouncement(`${filename}: ${FINISHED_LABELS[state]}`);
      }
    }
    previousStates.current = new Map(downloads.map(({ id, state }) => [id, state]));
  }, [downloads]);

  if (downloads.length === 0) return null;
  const hasFinished = downloads.some((download) => download.state !== 'progressing');

  // The pressed button disappears, so keyboard focus goes to the section heading instead.
  const focusHeading = () => headingRef.current?.focus();

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <div className={styles.header}>
        <h2 id={headingId} ref={headingRef} className={styles.heading} tabIndex={-1}>
          Downloads
        </h2>
        {hasFinished && (
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              focusHeading();
              onClear();
            }}
          >
            Clear
          </button>
        )}
      </div>
      <p className={styles.hidden} role="status" aria-live="polite">
        {announcement}
      </p>
      <ul className={styles.list}>
        {downloads.map((download) => {
          const done = percent(download);
          const showBar = download.state === 'progressing' || download.state === 'completed';
          return (
            <li key={download.id} className={styles.item}>
              {/* File names come from the server; they are only ever rendered as text. */}
              <span className={styles.name} title={download.filename}>
                {download.filename}
              </span>
              {showBar && (
                <progress
                  className={styles.progress}
                  max={100}
                  value={download.state === 'completed' ? 100 : (done ?? undefined)}
                  aria-label={`${download.filename} progress`}
                />
              )}
              <div className={styles.row}>
                <span className={styles.status}>
                  {download.state === 'progressing'
                    ? done === null
                      ? 'Downloading'
                      : `${done}%`
                    : FINISHED_LABELS[download.state]}
                </span>
                {download.canOpen && (
                  <button
                    type="button"
                    className={styles.action}
                    aria-label={`Open ${download.filename}`}
                    onClick={() => onOpen(download.id)}
                  >
                    Open
                  </button>
                )}
                {download.state === 'completed' && (
                  <button
                    type="button"
                    className={styles.action}
                    aria-label={`Show ${download.filename} in folder`}
                    onClick={() => onShow(download.id)}
                  >
                    Show in folder
                  </button>
                )}
                {download.state === 'progressing' && (
                  <button
                    type="button"
                    className={styles.action}
                    aria-label={`Cancel ${download.filename}`}
                    onClick={() => {
                      focusHeading();
                      onCancel(download.id);
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
