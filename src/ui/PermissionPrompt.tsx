import type { PromptInfo, PromptKind } from '../shared/tabs';
import styles from './PermissionPrompt.module.css';

// What the site wants, in plain words: "<origin> wants to <action>".
const ACTIONS: Record<PromptKind, string> = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  'camera-microphone': 'use your camera and microphone',
  location: 'know your location',
  notifications: 'show notifications, which will appear as coming from Blisz',
  'clipboard-read': 'read your clipboard',
  'open-mail': 'open your mail app',
  'open-phone': 'open your phone app',
};

interface PermissionPromptProps {
  prompt: PromptInfo;
  onRespond: (allow: boolean) => void;
}

// Shown under the address field. It never takes keyboard focus from the page; Tab reaches the buttons.
export function PermissionPrompt({ prompt, onRespond }: PermissionPromptProps) {
  const action = ACTIONS[prompt.kind];
  return (
    <section className={styles.prompt} aria-label="Permission request">
      <p className={styles.text} role="status">
        <bdi className={styles.origin}>{prompt.origin}</bdi> wants to {action}
        {prompt.target !== '' && (
          <>
            : <bdi className={styles.target}>{prompt.target}</bdi>
          </>
        )}
      </p>
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.allow}
          aria-label={`Allow ${prompt.origin} to ${action}`}
          onClick={() => onRespond(true)}
        >
          Allow
        </button>
        <button
          type="button"
          className={styles.block}
          aria-label={`Block ${prompt.origin} from trying to ${action}`}
          onClick={() => onRespond(false)}
        >
          Block
        </button>
      </div>
    </section>
  );
}
