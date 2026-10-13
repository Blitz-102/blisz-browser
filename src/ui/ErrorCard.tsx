import { useEffect, useRef } from 'react';
import type { TabError } from '../shared/tabs';
import styles from './ErrorCard.module.css';

interface ErrorCardProps {
  error: TabError;
  onRetry: () => void;
}

const TITLES = {
  network: "Can't reach this page",
  certificate: "This site's certificate isn't valid",
  crashed: 'This tab crashed',
} as const;

// Shown in the page area while the tab can't show its page. All text comes from main and is untrusted.
export function ErrorCard({ error, onRetry }: ErrorCardProps) {
  const retryRef = useRef<HTMLButtonElement>(null);
  // The page view is gone, so the keyboard goes to the one thing to do.
  useEffect(() => retryRef.current?.focus(), []);
  return (
    <section className={styles.card} aria-labelledby="error-title">
      <h2 id="error-title" className={styles.title} role="alert">
        {TITLES[error.kind]}
      </h2>
      {error.kind !== 'crashed' && (
        <>
          <p className={styles.detail}>{error.description}</p>
          <p className={styles.url}>
            <bdi>{error.url}</bdi>
          </p>
        </>
      )}
      <button type="button" className={styles.retry} ref={retryRef} onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}
