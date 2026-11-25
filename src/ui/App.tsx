import { useEffect, useRef, useState } from 'react';
import { toNavigableUrl } from '../shared/address';
import type { DownloadInfo } from '../shared/downloads';
import type { TabsState } from '../shared/tabs';
import { applyTabsUpdate } from '../shared/tabsUpdate';
import styles from './App.module.css';
import { Downloads } from './Downloads';
import { ErrorCard } from './ErrorCard';
import { FindStrip } from './FindStrip';
import { HistoryPanel } from './HistoryPanel';
import {
  ActivityIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  HistoryIcon,
  RotateCwIcon,
  ShieldIcon,
  XIcon,
} from './icons/icons';
import { MemoryPanel } from './MemoryPanel';
import { PermissionPrompt } from './PermissionPrompt';
import { PinnedSites } from './PinnedSites';
import { TabList } from './TabList';

export function App() {
  // A panel takes the page's place while it is open.
  const [panel, setPanel] = useState<'memory' | 'history' | null>(null);
  // The tab state comes from main, which owns the tabs.
  const [tabsState, setTabsState] = useState<TabsState | null>(null);
  const [downloads, setDownloads] = useState<DownloadInfo[]>([]);
  const activeTab = tabsState?.tabs.find((tab) => tab.id === tabsState.activeId);
  const isBlank = activeTab?.url === '';
  // Text the user is typing in the address field; null shows the tab's URL.
  const [draft, setDraft] = useState<string | null>(null);
  // What was just submitted, shown until the tab reports its new URL so the field doesn't flicker.
  const [submitted, setSubmitted] = useState<string | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findRequest, setFindRequest] = useState(0); // each Ctrl+F focuses the strip's input

  useEffect(() => {
    window.bliss.getTabsState().then(setTabsState);
    return window.bliss.onTabsUpdate((update) =>
      setTabsState((state) => state && applyTabsUpdate(state, update)),
    );
  }, []);

  useEffect(() => window.bliss.onDownloadsUpdate(setDownloads), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the URL and loading state are the triggers
  useEffect(() => setSubmitted(null), [activeTab?.url, activeTab?.isLoading]);

  // Switching tabs drops what was typed or submitted for the previous one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active tab is the trigger
  useEffect(() => {
    setDraft(null);
    setSubmitted(null);
  }, [tabsState?.activeId]);

  // A blank tab starts with the address field focused (main gives the UI focus when it activates one).
  // biome-ignore lint/correctness/useExhaustiveDependencies: switching between two blank tabs must focus too
  useEffect(() => {
    if (isBlank) addressRef.current?.focus();
  }, [isBlank, tabsState?.activeId]);

  // Ctrl+L, Alt+D and F6 are handled in main, which asks the field to take focus.
  useEffect(
    () =>
      window.bliss.onFocusAddress(() => {
        addressRef.current?.focus();
        addressRef.current?.select(); // focus() alone doesn't select when the field already has focus
      }),
    [],
  );

  // Ctrl+F is handled in main, which also closes the strip on tab switches and navigation.
  // A panel takes the page's place, so there is nothing to search there.
  useEffect(() => {
    const unsubscribeOpen = window.bliss.onOpenFind(() => {
      if (panel !== null) {
        if (activeTab) window.bliss.findStop(activeTab.id, false); // main already counted it as open
        return;
      }
      setFindOpen(true);
      setFindRequest((request) => request + 1);
    });
    const unsubscribeClose = window.bliss.onCloseFind(() => setFindOpen(false));
    return () => {
      unsubscribeOpen();
      unsubscribeClose();
    };
  }, [panel, activeTab]);

  // Tell main where the page goes. While a panel is open it takes the page's place.
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const report = () => {
      const { x, y, width, height } = page.getBoundingClientRect();
      const radius = Number.parseFloat(getComputedStyle(page).borderTopLeftRadius) || 0;
      window.bliss
        .setPageArea({ x, y, width, height, radius, hidden: panel !== null })
        .catch((error) => console.warn('Could not set the page area:', error));
    };
    const observer = new ResizeObserver(report);
    observer.observe(page);
    return () => observer.disconnect();
  }, [panel]);

  function submitAddress() {
    if (!activeTab || draft === null) return;
    setPanel(null);
    const text = toNavigableUrl(draft);
    if (text !== '') setSubmitted(text);
    window.bliss.navigateTab(activeTab.id, draft).then((started) => {
      if (!started) setSubmitted(null);
    });
    setDraft(null);
  }

  function closeFind(focusPage = true) {
    setFindOpen(false);
    if (activeTab) window.bliss.findStop(activeTab.id, focusPage);
  }

  function togglePanel(name: 'memory' | 'history') {
    if (panel === null && findOpen) closeFind(false); // the UI keeps the keyboard
    setPanel((current) => (current === name ? null : name));
  }

  // Ctrl+H is handled in main, which focuses the UI and sends this. The ref keeps the subscription
  // stable while the handler always sees the current find state and tab.
  const togglePanelRef = useRef(togglePanel);
  togglePanelRef.current = togglePanel;
  useEffect(() => window.bliss.onToggleHistory(() => togglePanelRef.current('history')), []);

  function selectTab(id: number) {
    setPanel(null);
    window.bliss.activateTab(id);
  }

  function addTab() {
    setPanel(null);
    window.bliss.createTab();
  }

  return (
    <div className={styles.frame}>
      {activeTab?.fullscreenNotice && (
        <p className={styles.fullscreenNotice} role="status">
          <bdi className={styles.fullscreenOrigin}>{activeTab.fullscreenNotice}</bdi>
          <span> is full screen — press Esc or F11 to exit</span>
        </p>
      )}
      <nav className={styles.sidebar} aria-label="Tabs">
        <div className={styles.topStrip}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Back"
            disabled={!activeTab?.canGoBack}
            onClick={() => activeTab && window.bliss.tabGo(activeTab.id, 'back')}
          >
            <ArrowLeftIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Forward"
            disabled={!activeTab?.canGoForward}
            onClick={() => activeTab && window.bliss.tabGo(activeTab.id, 'forward')}
          >
            <ArrowRightIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={activeTab?.isLoading ? 'Stop' : 'Reload'}
            onClick={() =>
              activeTab && window.bliss.tabGo(activeTab.id, activeTab.isLoading ? 'stop' : 'reload')
            }
          >
            {activeTab?.isLoading ? <XIcon /> : <RotateCwIcon />}
          </button>
        </div>
        <div className={styles.address}>
          <input
            type="text"
            className={styles.addressInput}
            aria-label="Address"
            placeholder="Search or enter address"
            ref={addressRef}
            value={draft ?? submitted ?? activeTab?.url ?? ''}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => setDraft(null)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitAddress();
              if (event.key === 'Escape') {
                setDraft(null);
                setSubmitted(null);
                event.currentTarget.blur();
              }
            }}
          />
          {activeTab && activeTab.zoom !== 1 && (
            <button
              type="button"
              className={styles.zoomButton}
              aria-label="Reset zoom"
              onClick={() => window.bliss.resetZoom(activeTab.id)}
            >
              {Math.round(activeTab.zoom * 100)}%
            </button>
          )}
          <button type="button" className={styles.iconButton} aria-label="Ad blocker">
            <ShieldIcon />
          </button>
        </div>
        {activeTab?.prompt && (
          <PermissionPrompt
            key={activeTab.prompt.id}
            prompt={activeTab.prompt}
            onRespond={(allow) =>
              activeTab.prompt && window.bliss.respondToPrompt(activeTab.prompt.id, allow)
            }
          />
        )}
        {activeTab && activeTab.blockedPopups > 0 && <p className={styles.note}>Popup blocked</p>}
        {activeTab && activeTab.blockedDownloads > 0 && (
          <p className={styles.note}>Download blocked</p>
        )}
        <PinnedSites />
        <TabList
          tabs={tabsState?.tabs ?? []}
          activeId={tabsState?.activeId ?? null}
          onSelect={selectTab}
          onClose={(id) => window.bliss.closeTab(id)}
          onNewTab={addTab}
          onContextMenu={(id) => window.bliss.tabContextMenu(id)}
        />
        <Downloads
          downloads={downloads}
          onOpen={(id) => window.bliss.openDownload(id)}
          onShow={(id) => window.bliss.showDownload(id)}
          onCancel={(id) => window.bliss.cancelDownload(id)}
          onClear={() => window.bliss.clearDownloads()}
        />
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.panelToggle}
            aria-pressed={panel === 'memory'}
            onClick={() => togglePanel('memory')}
          >
            <ActivityIcon />
            Memory
          </button>
          <button
            type="button"
            className={styles.panelToggle}
            aria-pressed={panel === 'history'}
            onClick={() => togglePanel('history')}
          >
            <HistoryIcon />
            History
          </button>
        </div>
      </nav>
      <div className={styles.pageColumn}>
        {findOpen && activeTab && (
          <FindStrip tabId={activeTab.id} focusRequest={findRequest} onClose={() => closeFind()} />
        )}
        <main ref={pageRef} className={styles.page}>
          {panel === 'memory' ? (
            <MemoryPanel />
          ) : panel === 'history' ? (
            <HistoryPanel
              onOpen={(url) => {
                if (!activeTab) return;
                setPanel(null);
                window.bliss.navigateTab(activeTab.id, url);
              }}
            />
          ) : activeTab?.error ? (
            <ErrorCard
              error={activeTab.error}
              onRetry={() => window.bliss.tabGo(activeTab.id, 'reload')}
            />
          ) : (
            isBlank && <p className={styles.placeholderTitle}>New tab</p>
          )}
        </main>
      </div>
    </div>
  );
}
