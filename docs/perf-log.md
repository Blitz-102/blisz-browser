# Performance log

One entry per phase (newest at the top), measured with `npm run bench:memory`: the built app, unpackaged, after a fixed 10 s settle. Numbers come from `app.getAppMetrics()`. "Private" is private bytes; "working set" includes shared pages, so it overstates real cost. Compare like with like: the same method and settle time each time.

The Brave comparison is manual: Windows Task Manager, "Memory (private working set)" summed over Brave's processes, on the same tab set after the same settle time.

## 2026-10-11: Phase 0 baseline (empty window)
- Electron 44.7.0 (Chromium 152), Windows 11, i5-13450HX, 24 GB RAM. No page views: just the frame and the sidebar UI.
- Three runs: 166.4, 167.2 and 176.3 MB total private. The spread is almost all the GPU process (89 to 97 MB); the UI stayed at 26 to 27 MB. Treat differences under about 10 MB as noise. Representative run:

| Process | Type | Private MB | Working set MB |
|---|---|---|---|
| Browser (main) | Browser | 39.1 | 100.7 |
| GPU | GPU | 89.3 | 111.7 |
| Network Service | Utility | 11.9 | 45.7 |
| UI (React sidebar) | Tab | 27.0 | 71.7 |
| **Total** | | **167.2** | **329.8** |

- Notes:
  - The GPU process is the largest single cost. PLAN 5.3 rules out disabling GPU acceleration, so this is a fixed cost to accept, not tune.
  - The UI process is about 27 MB. The framework spike's blank page was 21.4 MB, so React plus the sidebar costs about 5 to 6 MB.
  - The benchmark tab set and the first Brave comparison come in Phase 2.
