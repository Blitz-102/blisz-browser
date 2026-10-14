# Performance log

One entry per phase (newest at the top). Phase 0 and 1 used `npm run bench:memory` with a 10 s settle, and their numbers come from `app.getAppMetrics()`. "Private" there is private bytes, and "working set" includes shared pages, so it overstates real cost.

From Phase 2 on, the benchmark uses the 10 sites in `bench/sites.json` with a 60 s settle, and the comparable figure is the **private working set**, summed over each browser's process tree (`scripts/measure-memory.ps1`). Brave is measured the same way with `scripts/bench-brave.ps1`. Compare like with like: the same method and settle time each time.

## 2026-10-14: Phase 2 end (first comparison with Brave)
- Blisz: Electron 44.7.0, the 10 sites in `bench/sites.json`, 60 s settle, 3 runs. Brave: the same sites in a clean profile, 3 runs. Windows 11, i5-13450HX, 24 GB RAM.
- Private working set, total of each run (MB):

| Run | Blisz | Tabs loaded | Brave | Brave processes |
|---|---|---|---|---|
| 1 | 1,101.6 | 10 of 10 | 1,097.9 | 33 |
| 2 | 1,264.1 | 9 of 10 | 1,085.3 | 32 |
| 3 | 1,349.7 | 9 of 10 | 1,094.3 | 31 |
| **Median** | **1,264.1** | | **1,094.3** | |

- Blisz's median is about 15% above Brave's on this tab set. Brave's Shields are on and Blisz has no ad or tracker blocking yet (Phase 6), so some of the gap is expected.
- Blisz's total private bytes (Electron's own measure, from the same runs) were 1,350, 1,583 and 1,750 MB, rising from run to run. The working set rose too. This may be ads and content varying between loads. Watch it, because it could also be memory not being released.
- In runs 2 and 3 one of the ten tabs had not finished loading after the settle. The bench does not yet say which site, so that tab's memory is partly counted.
- Budget (agreed by the user, 2026-10-14): total private working set at or below Brave's on this tab set. Blisz does not meet it yet: open gap, to be closed by Phase 3 sleeping tabs and Phase 6 ad blocking. Phase 2 was closed with this gap on 2026-10-14.
- Spellcheck (decision #18): not measured yet.
- Phase 0 and 1 entries below used the older method, so they are not comparable with this entry.

## 2026-10-11: Phase 1 end (sidebar UI with mock data)

## 2026-10-11: Phase 1 end (sidebar UI with mock data)
- Electron 44.7.0 (Chromium 152), same machine and method. Still no page views: the frame plus the full mock sidebar (pinned grid, 10 tabs, icons).
- Three runs: 169.8, 168.9 and 169.4 MB total private, so the run-to-run spread is under 1 MB. Representative run:

| Process | Type | Private MB | Working set MB |
|---|---|---|---|
| Browser (main) | Browser | 38.4 | 127.0 |
| GPU | GPU | 91.2 | 144.6 |
| Network Service | Utility | 11.9 | 82.7 |
| UI (React sidebar) | Tab | 27.4 | 92.7 |
| **Total** | | **168.9** | **447.1** |

- Notes:
  - The UI process is flat: 27.4 MB against Phase 0's 27.0 MB, which is within noise. The whole Phase 1 sidebar cost under 1 MB, so React stays (DECISIONS: UI framework).
  - Total private is +2 MB on Phase 0, inside the noise band noted there.
  - The working set rose by about 118 MB (330 to 447 MB). This is shared pages (fonts, the GPU and the compositor drawing more), not private cost. Watch it, but compare private bytes.
  - Each run logged "Unable to create cache" and "Gpu Cache Creation failed". The likely cause is another instance (for example `npm run dev`) holding the cache folder. The numbers are unaffected; if it persists with no other instance running, look into it.

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
