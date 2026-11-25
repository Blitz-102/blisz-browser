export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  lastVisitTime: number; // ms since the epoch
}

// Where the next page starts: the last entry of the previous one.
export interface HistoryCursor {
  time: number;
  id: number;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  next: HistoryCursor | null; // null on the last page
}
