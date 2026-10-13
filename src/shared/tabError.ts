import type { TabError } from './tabs';

const MAX_TEXT_LENGTH = 2048;

// Chromium's net error codes -200 to -299 are certificate errors (ERR_CERT_*).
// -3 (ERR_ABORTED) is the user or a redirect cancelling a load, not a failure.
export function loadError(code: number, description: string, url: string): TabError | null {
  if (code === -3) return null;
  return {
    kind: code <= -200 && code >= -299 ? 'certificate' : 'network',
    code,
    description: description.slice(0, MAX_TEXT_LENGTH),
    url: url.slice(0, MAX_TEXT_LENGTH),
  };
}
