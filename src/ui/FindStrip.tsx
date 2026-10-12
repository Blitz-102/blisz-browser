import { useEffect, useRef, useState } from 'react';
import type { FindResult } from '../shared/tabs';
import styles from './FindStrip.module.css';
import { ChevronDownIcon, ChevronUpIcon, XIcon } from './icons/icons';

interface FindStripProps {
  tabId: number;
  focusRequest: number; // changes each time Ctrl+F asks for focus
  onClose: () => void;
}

export function FindStrip({ tabId, focusRequest, onClose }: FindStripProps) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<FindResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each request is a trigger
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  useEffect(() => window.bliss.onFindResult(setResult), []);

  function search(query: string, forward: boolean, findNext: boolean) {
    if (query === '') setResult(null);
    window.bliss.findQuery(tabId, query, { forward, findNext });
  }

  const count =
    text !== '' && result?.tabId === tabId
      ? `${result.activeMatchOrdinal} of ${result.matches}`
      : '';

  return (
    <div className={styles.strip}>
      <input
        type="text"
        className={styles.input}
        aria-label="Find in page"
        ref={inputRef}
        value={text}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          search(event.target.value, true, false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') search(text, !event.shiftKey, true);
          if (event.key === 'Escape') onClose();
        }}
      />
      <span className={styles.count} aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        className={styles.button}
        aria-label="Previous match"
        onClick={() => search(text, false, true)}
      >
        <ChevronUpIcon />
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Next match"
        onClick={() => search(text, true, true)}
      >
        <ChevronDownIcon />
      </button>
      <button type="button" className={styles.button} aria-label="Close find" onClick={onClose}>
        <XIcon />
      </button>
    </div>
  );
}
