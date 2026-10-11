// Phase 1 mock data. Phase 2 replaces it with tab state from the main process.
export type TabState = 'active' | 'normal' | 'sleeping';

export interface Tab {
  id: string;
  title: string;
  url: string;
  state: TabState;
}

export const pinnedSites = [
  { title: 'Gmail', url: 'https://mail.google.com' },
  { title: 'Calendar', url: 'https://calendar.google.com' },
  { title: 'GitHub', url: 'https://github.com' },
  { title: 'YouTube', url: 'https://www.youtube.com' },
  { title: 'Notion', url: 'https://www.notion.so' },
  { title: 'Reddit', url: 'https://www.reddit.com' },
  { title: 'Wikipedia', url: 'https://en.wikipedia.org' },
  { title: 'Maps', url: 'https://maps.google.com' },
];

export const initialTabs: Tab[] = [
  {
    id: 'tab-1',
    title: 'Electron Documentation',
    url: 'https://www.electronjs.org/docs/latest',
    state: 'normal',
  },
  {
    id: 'tab-2',
    title: 'GitHub: bliss-browser',
    url: 'https://github.com/example/bliss-browser',
    state: 'active',
  },
  {
    id: 'tab-3',
    title: 'MDN Web Docs: CSS Grid',
    url: 'https://developer.mozilla.org/docs/Web/CSS/grid',
    state: 'normal',
  },
  { id: 'tab-4', title: 'Hacker News', url: 'https://news.ycombinator.com', state: 'sleeping' },
  {
    id: 'tab-5',
    title: 'YouTube: lofi mix',
    url: 'https://www.youtube.com/watch?v=example',
    state: 'sleeping',
  },
  {
    id: 'tab-6',
    title: 'Wikipedia: Chromium',
    url: 'https://en.wikipedia.org/wiki/Chromium_(web_browser)',
    state: 'normal',
  },
  {
    id: 'tab-7',
    title: 'Stack Overflow',
    url: 'https://stackoverflow.com/questions',
    state: 'normal',
  },
  { id: 'tab-8', title: 'Inbox (3)', url: 'https://mail.google.com/mail/u/0', state: 'normal' },
  { id: 'tab-9', title: 'Weather', url: 'https://weather.com', state: 'sleeping' },
  {
    id: 'tab-10',
    title: 'npm: react',
    url: 'https://www.npmjs.com/package/react',
    state: 'normal',
  },
];
