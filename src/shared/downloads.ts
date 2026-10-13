export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted';

// What the UI knows about a download. It never gets a file path: actions go by id and main
// looks the path up in its own record.
export interface DownloadInfo {
  id: number;
  filename: string; // sanitized by main; untrusted text all the same
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number; // 0 when the server didn't say
  canOpen: boolean; // completed and not an executable type
}
