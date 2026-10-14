# Memory benchmark

How to measure Blisz and Brave on the same sites, and how to read the output. Windows only. Results are recorded in [perf-log.md](perf-log.md).

## What is measured

The figure is the **private working set**, summed over the browser's whole process tree. It is the number Task Manager shows as Memory (private working set) on the Details tab, so you can check it by eye.

Electron's own numbers from `app.getAppMetrics()` are **not** comparable with Brave. Its "private" value is private bytes (commit charge), and its "working set" includes shared pages. The Phase 0 and Phase 1 entries in the perf log used those numbers, so they cannot be compared with Brave.

Both browsers use the same method. `scripts/measure-memory.ps1` takes the browser's root process ID, follows the parent links down to every child process, and adds up each one's private working set. Other programs, including your daily browser, are not in that tree and are not counted.

## Before you start

- Close other Brave windows first. The script only measures the Brave it starts, but a quiet machine keeps the run comparable.
- Leave the machine alone during the settle time.
- Run both commands from the project folder, `C:\bliss-browser`.

## Commands

Blisz:

```
npm run bench:memory
```

This builds the app, then runs it with `--bench`. It opens the sites, waits, prints the report and quits on its own.

Brave:

```
powershell -ExecutionPolicy Bypass -File scripts\bench-brave.ps1
```

The script looks for `brave.exe` in the standard install folders (Program Files, Program Files (x86) and `%LOCALAPPDATA%`). If Brave is somewhere else, pass its path:

```
powershell -ExecutionPolicy Bypass -File scripts\bench-brave.ps1 -BravePath "D:\Apps\Brave\brave.exe"
```

Brave starts with a new temp profile, `--no-first-run`, and every site as a URL. It has no extensions, no logins and no history, and Shields are on.

Run each browser three times and use the **median** of the three totals.

## The site list

The sites are in `bench/sites.json`. Both browsers read this one file, so they open the same sites with the same wait.

```json
{
  "settleSeconds": 60,
  "sites": [
    { "name": "MDN", "url": "https://developer.mozilla.org/en-US/docs/Web/CSS" }
  ]
}
```

- To change a site, edit its `url`. To add one, add an entry with a `name` and a `url`. The `name` is for you only. Neither script prints it.
- Every `url` must start with `http://` or `https://`. Blisz checks the file when it starts and exits with an error if something is wrong. The Brave script does not check it, so keep to valid URLs.
- The file is part of the method. If you change the list, earlier numbers no longer compare with new ones, so note the list in the perf log entry.

## Settle time

`settleSeconds` in the same file is how long both browsers wait after the sites are opened. It is 60 at the moment. It must be a whole number from 1 to 600.

Change it only for every run in a comparison, and note the value in the perf log. Blisz stops with "Bench timed out" if the whole run takes longer than the settle time plus 60 seconds.

## Reading the output

Blisz prints:

1. **A table with one row per process.** The useful columns are:
   - `label`: "UI" for the sidebar, "Tab: <page title>" for a page, and the process type (for example GPU) for the rest.
   - `privateWorkingSetMB`: the comparable figure. A `-` means the PowerShell script did not report that process.
   - `privateMB`, `workingSetMB` and `cpuPercent`: Electron's own measures. Use them for diagnosis, not for comparison.
2. **`Tabs finished loading: X of N`.** If X is less than N, some pages were still loading when the total was taken, so the run is not a fair reading. Rerun it or note it in the perf log.
3. **`Total private`** and **`working set`**: Electron's totals. Not for comparison.
4. **`Total private working set: X MB`**: the comparable total, and the number for the perf log.

Brave prints:

1. `Brave started (PID ...) with N sites`, then the countdown message.
2. **A table with one row per process.** It has no tab labels, so you only see the process name and its numbers. The `privateMB` column here is the private working set too, which is the figure to use. The header name is a little misleading.
3. **`Total private working set: X MB across N processes`.** Record both X and N. N is the process count, which is comparable with the process counts in the perf log.

The Brave script does not count loaded tabs. While the settle runs, look at the Brave window and check that the pages have finished loading.

## Caveats

- **Run-to-run variance.** The Phase 2 Blisz runs ranged from about 1,100 to 1,350 MB, and the Brave runs from about 1,085 to 1,100 MB. One run is only a rough reading. Use the median of three.
- **Pages change between loads.** News, social and video sites change their ads and content from one load to the next. Do not swap sites in the middle of a comparison.
- **Brave's Shields are on.** Shields block ads and trackers by default. Blisz has no ad or tracker blocking until Phase 6, so part of the gap with Brave is expected. Brave's number is a hard target until then. Phase 6 will rerun the comparison.
- **Dev build versus packaged.** `npm run bench:memory` runs the app unpackaged, from a fresh build. The packaged app ignores `--bench`. Brave is an installed release build. Treat the comparison as a guide, and keep the Blisz method the same from run to run.
- **Temp profiles.** Blisz's `--bench` run uses a temporary profile folder, deleted when it exits. Brave's script uses its own temporary profile and deletes it after the run. Your real profiles are not touched. The script ends the Brave process tree with `taskkill /F`, so any unsaved work in that test window is lost.

## Where results go

Record each comparison in [perf-log.md](perf-log.md), as a new entry at the top. Include the date, the Electron version, the settle time, any change to the site list, the three runs for each browser (with tabs loaded and process counts) and the medians.
