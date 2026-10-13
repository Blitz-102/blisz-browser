# Decisions

Newest at the top. Each entry: what was chosen, what else was considered, why, and when to revisit.

## 2026-10-13: Error cards, fullscreen notice, no certificate bypass
- Chosen:
  - **Error cards:**
    - Main-frame load failures (not aborts) and renderer crashes show a card in the UI's page area, with the page view detached and a "Try again" button.
    - `ERR_CERT_*` codes get a certificate card.
    - `certificate-error` always calls `callback(false)`; there is no bypass (user decision).
  - **HTML fullscreen:**
    - The page fills the window, after a 3.5 s notice strip ("<origin> is full screen — press Esc to exit").
    - Electron handles Esc.
    - Switching tabs exits fullscreen through an isolated-world `document.exitFullscreen()`, with a window-restore fallback after 1 s.
    - F11 toggles window fullscreen.
- Alternatives considered: Chromium's own error pages; an overlay view for the notice.
- Why:
  - Chromium's error pages can't be styled and show internal URLs.
  - With no notice, a fullscreen page could draw a fake browser or vault prompt.
  - A strip costs no extra renderer.
- Revisit if: the Phase 7 overlay view exists (the notice could float instead of shrinking the page).
- Status: settled

## 2026-10-13: Permission prompts and external links
- Chosen:
  - **Sessions:** `persist:main` gets per-site prompts in the sidebar. Every other session, including the UI's default session, stays deny-all through `session-created`.
  - **What's asked and what's silent:**
    - Asked: camera and/or microphone, location, notifications, clipboard-read.
    - Allowed silently: fullscreen, sanitized clipboard write, pointer lock. These are allowed from cross-origin iframes too, since Permissions Policy gates them.
    - Denied: everything else, including unknown future permissions, USB, HID, serial, Bluetooth choosers and screen capture.
  - **Who can be asked:** only https origins (plus http on localhost), and only the tab's current top origin.
  - **Prompt safety:**
    - Allow and Block ignore clicks for 500 ms after the prompt appears or the layout changes (clickjacking).
    - Requests made during HTML fullscreen are denied.
    - Prompts are cancelled when the tab commits a navigation.
  - **Remembering:** decisions are remembered per origin for the session; Phase 3 stores them. A clipboard-read Allow is never remembered.
  - **Notifications:** the prompt warns they appear as coming from Blisz.
  - **External links:** `mailto:` and `tel:` only. They need a real gesture in the main frame (or same-origin), go through a prompt showing the target, and are rebuilt before opening:
    - mailto keeps only to, cc, bcc, subject and body, so attach/attachment are dropped;
    - tel is a strict character set;
    - quotes, backslashes, angle brackets and spaces are refused.
  - That is the app's only `shell.openExternal`.
- Alternatives considered: allow-by-default with a revoke UI; blocking `mailto:` entirely.
- Why: the step 2f code and security reviews. Mail clients that honour `attach=` with UNC paths can leak the Windows login hash, and tel handlers can take injected arguments.
- Revisit if:
  - Phase 3 stores decisions, which needs a way to change a remembered Block;
  - notifications can be labelled by site.
- Known gap (still open): popups adopted for `window.opener` lack `safeDialogs`, and Electron has no hook to intercept JS dialogs. Background-tab `alert()` behaviour is to be checked by hand.
- Status: settled

## 2026-10-13: Downloads ask where to save, gesture-gated, with an allow-list for Open
- Chosen:
  - **Saving:** every download on `persist:main` opens the Windows "Save as" dialog (user decision, 2026-10-13). The suggested name is sanitized:
    - basename only;
    - no Windows-invalid characters, leading or trailing dots, bidi/Cf/C1 characters, whitespace runs or reserved device names;
    - length capped.
  - **Menu items:** "Save image as…" and "Save link as…" (links, http(s) only).
  - **Tests:** an unpackaged-only `BLISZ_DOWNLOAD_NO_PROMPT` switch saves without the dialog.
  - **Gate:**
    - A download needs a fresh real gesture in the active tab. The gesture is used up, and it resets on navigation.
    - Exception: a tab the user just opened (a `target=_blank` link or "Open link in new tab") that hasn't committed a navigation gets one download within 5 s. Popups never get a made-up gesture, so they can't chain further popups.
    - A popup tab that only downloaded closes itself afterwards.
    - Foreign-origin subframes can't download.
    - At most 3 per 10 s per tab and 5 running at once. Blocked downloads show a "Download blocked" note.
    - "Save image" is allowed only for the chosen image URL and an `image/*` response.
  - **Open:**
    - Offered only for an allow-list of passive types: documents, images, audio, video and archives. Everything else gets "Show in folder" only.
    - Offered only when the Mark of the Web is confirmed. Chromium writes it; our fallback writes it if it's missing, and failing to write it removes Open.
  - **Paths:** `shell.openPath` and `showItemInFolder` only ever receive main's own recorded path, through id-only IPC.
  - **Other sessions:** the default (UI) session cancels every download.
  - **History:** the list is in memory only; Phase 3 adds history.
- Alternatives considered:
  - auto-saving into Downloads (the first version; the user prefers choosing);
  - a deny-list of executable types (incomplete: `.url`, `.library-ms`, `.msix`, `.iso`, `.chm` and others);
  - Chrome's looser gesture rules.
- Why: auto-save with no Safe Browsing would otherwise let pages drop files into Downloads. Listing the safe types can't miss a new dangerous one.
- Trade-off: "your download starts in 5 s" pages (SourceForge style) are blocked; use their direct link.
- Revisit if:
  - the user wants Open for more types;
  - Phase 3 adds download history;
  - a resume UI is wanted (interrupted downloads are cancelled now).
- Status: settled

## 2026-10-13: Native context menus
- Chosen: native `Menu.popup` menus built from a pure, unit-tested template.
  - **Page menu:** link, image, selection, editing (with spelling suggestions) and navigation groups, plus Inspect.
  - **Tab row menu:** Duplicate and Close.
  - **Safety:** clipboard writes happen in main. Untrusted label text is stripped of bidi characters, `&`-escaped and truncated. Nothing goes through `shell.openExternal`.
- Alternatives considered: custom HTML menus (they'd need the overlay view, Phase 7).
- Why: native menus float over page views for free, and they're accessible.
- Revisit if: the Phase 7 overlay makes styled menus cheap.
- Status: settled

## 2026-10-12: Smoke tests use a temporary profile
- Chosen: when unpackaged, `BLISZ_USER_DATA` sets `userData`. Every smoke launch gets a fresh temp folder, which is deleted afterwards.
- Alternatives considered: running against the real profile (what happened until step 2d).
- Why: the real profile now holds Google cookies, and Playwright opens debugging ports while tests run. This settles the 2026-10-11 constraint early. A run was confirmed to leave `%APPDATA%\bliss-browser` untouched.
- Revisit if: `bench:memory` starts opening real sites (2g). Give it a temp profile too, for consistent numbers.
- Status: settled

## 2026-10-12: Find strip and zoom
- Chosen:
  - **Find:** Ctrl+F opens a strip above the page (user decision), using `findInPage`. It shows "n of m"; F3 and Ctrl+G go to the next match. It closes on tab switch, on navigation, and when the memory panel opens.
  - **Zoom:**
    - Chrome's steps, with Ctrl+Plus/Minus/0 and Ctrl+scroll.
    - Same-origin by default (Chromium), so one site's zoom applies to all its tabs.
    - Chromium also saves it per host in the profile, so it survives restarts.
    - A reset button in the address field appears when zoom isn't 100%.
- Alternatives considered: the find bar in the sidebar; our own zoom map.
- Why: the user's choice for find. For zoom, Chromium's built-in behaviour means no code of our own.
- Revisit if: Phase 3 wants zoom stored with other site settings.
- Status: settled

## 2026-10-12: Popups adopted as tabs, gated by real user input
- Chosen:
  - **Allowed:** an `http(s)` or exactly `about:blank` URL; a foreground-tab, background-tab or new-window disposition.
  - **Gates:** the opener must be the active tab and must have had real input (mouse, key or touch, through `input-event`) in the last 5 s. One gesture opens one popup, with a cap of 2 per 5 s. Blocked popups show a "Popup blocked" note.
  - **Adopting:** `window.open` popups are adopted with `createWindow(options.webContents)`, which keeps `window.opener` for sign-in flows, with `outlivesOpener: true`.
  - **Closing:** closing an active popup returns to its opener. A page closing itself closes its tab.
- Alternatives considered: deny and open the URL in a new tab (breaks OAuth); a rate limit only (popups can chain past it).
- Why: Electron has no popup blocker. Requiring a gesture is what Chromium's blocker does, and it ends popup chains.
- Known gap: popups Chromium creates for `window.opener` don't get `safeDialogs`. Electron doesn't apply `overrideBrowserWindowOptions` to them. A popup could loop `alert()` with no "prevent more dialogs" checkbox.
- Revisit if: step 2f handles dialogs (close the gap there if Electron allows it), or Electron fixes the override for adopted guests.
- Status: provisional

## 2026-10-12: Packaged builds refuse remote debugging switches
- Chosen: when packaged, `app.exit(1)` at startup if `--remote-debugging-port` or `--remote-debugging-pipe` is present.
- Alternatives considered: relying on fuses (none covers this switch); `devTools: false` (doesn't stop CDP).
- Why: anything that can launch Blisz could otherwise drive the trusted UI and read cookies over CDP, a known infostealer technique. Unpackaged builds keep the switch for Playwright.
- Revisit if: Phase 5 packaging. Verify that a packaged build launched with `--remote-debugging-port=9222` doesn't answer on `http://127.0.0.1:9222/json`. Add it to the packaging checklist with the fuses.
- Status: provisional (until verified in Phase 5)

## 2026-10-12: Keyboard shortcuts via before-input-event
- Chosen: a pure `matchShortcut` (`src/main/shortcuts.ts`), and one `before-input-event` handler on the UI view and every page view (never on DevTools webContents). Actions run in main.
  - Matching: letters by `key`, falling back to `code` for non-Latin layouts; digits by `code`, falling back to `key`. AltGr (Ctrl+Alt) never matches.
  - Auto-repeat is ignored except for next/previous tab and back/forward.
  - Esc stops loading only when the focused active page is loading and not in HTML fullscreen.
  - F12 and Ctrl+Shift+I open detached DevTools for the page. The UI's DevTools are on Ctrl+Shift+Alt+I and dev-only; when packaged, that chord passes through to the page.
  - Links opened from page DevTools become tabs only if they pass `isWebUrl`.
  - The mouse side buttons use BaseWindow `app-command`.
  - Browser shortcuts always win over the page's own use of the same keys. Ctrl+K is unbound until Phase 7.
- Alternatives considered: a hidden application menu with accelerators.
- Why: works whichever view has focus, needs no menu, and the matching is unit-testable. Pages can't fake these events. The user tested it on Windows.
- Revisit if: a site's own shortcut matters more than the browser's (add a per-site exception), or Phase 7 adds the console.
- Status: settled

## 2026-10-12: Constraints from the step 2b security reviews
- Chosen:
  - Never add `protocol.handle` to `persist:main` without revisiting `src/main/favicon.ts`. `session.fetch` allows any protocol, and only `isWebUrl` stands in the way.
  - (Step 2f, dialogs) Check whether `alert()`, `confirm()` or `prompt()` from a detached background tab shows over the active tab. If it does, switch to that tab first, or hold the dialog until it is active.
  - Accepted residual risks:
    - favicon GETs to LAN or loopback hosts that a page names (no cookies; the result is only shown as an image);
    - ICO entries are checked only by their directory sizes;
    - an https page can name an http favicon.
- Alternatives considered: host filtering for favicons (DNS rebinding defeats it).
- Why: each limits what an untrusted page can make main or the trusted UI do.
- Revisit if: the ad blocker arrives (it can cover favicon requests), or a decoder CVE affects PNG, GIF, ICO or SVG.
- Status: settled

## 2026-10-12: Favicons fetched in main, shown as data: URLs
- Chosen:
  - **Fetching:** main fetches favicons with the page session's `fetch`: `credentials: 'omit'`, `bypassCustomProtocolHandlers`, http(s) only, at most 8 candidates, a 5 s timeout, one fetch per tab (aborted when superseded), 64 KB cap.
  - **Formats:** PNG, ICO and GIF must have magic bytes that match their type and be at most 256 px. JPEG and WebP are refused.
  - **SVG** is used only when no raster candidate validates (user decision).
  - **In the UI:** the image arrives as a `data:` URL, decoded in the sandboxed UI renderer.
- Alternatives considered:
  - the UI loading favicon URLs itself (breaks the "no remote content in trusted views" rule and the CSP);
  - decoding with `nativeImage` in main (unsandboxed);
  - always or never using SVG.
- Why: the page chooses the bytes, so they are checked before they reach the privileged UI. Leaving out cookies stops a page using favicons to send credentialed GETs to other sites.
- Revisit if: decoding can move to the page's own renderer, or the UI starts holding secrets (the vault in Phase 4); then re-check this exposure.
- Status: settled

## 2026-10-12: Tab behaviour in step 2b
- Chosen:
  - **Views:** only the active tab's view is attached. Others are detached with `removeChildView`, which Chromium treats as hidden and throttles. The user confirmed CPU drops when a page is hidden.
  - **Closing:** closing a tab activates the next one, else the previous one. Closing the last tab leaves a blank tab (user decision).
  - **Duplicate** exists as IPC only for now. It loads the source's URL without its history.
  - **Updates:** `order` is authoritative in `TabsUpdate`.
  - **Labels:** memory-panel labels are `Tab: <titles>`, with bidi controls stripped.
- Alternatives considered: `setVisible(false)` for hidden tabs (not confirmed to make Chromium treat the page as hidden).
- Why: PLAN 4.1 and 5.2. Playwright can't observe `visibilityState`, so a manual CPU check confirmed it.
- Revisit if: tab sleeping arrives (Phase 3), or a UI for duplicate is wanted (the context menu, 2e).
- Status: settled

## 2026-10-12: Page user agent, Chrome UA plus a Blisz token
- Chosen: `persist:main` uses Electron's Chrome UA with the `Electron/` and npm app-name tokens removed and `Blisz/<version>` appended (built explicitly in `src/main/tabs.ts`).
- Alternatives considered:
  - a plain Chrome UA with no extra token (Google rejected it: "This browser or app may not be secure");
  - faking the Google Chrome brand through CDP (heavy, lost when DevTools opens, and it still fails Google and Cloudflare according to the Orca project's tests);
  - a different UA only on Google account hosts (more private, more code).
- Why:
  - Electron 44 can't change the Client Hints brands, so a UA claiming to be plain Chrome doesn't match the engine. A product token, like Edge's `Edg/`, passes. The user confirmed sign-in works.
  - The token is unique to this browser, so sites can recognise it. The user accepted that.
- Revisit if:
  - Google starts rejecting the token or ends sessions early (then switch to a Google-only UA);
  - Electron gains `setUserAgentMetadata` (PR #53519);
  - the unique token becomes a concern.
  - Changing the UA can sign the user out of Google.
- Status: provisional

## 2026-10-12: Browser name is Blisz
- Chosen: user-facing name "Blisz". Legacy identifiers stay: npm package `bliss-browser`, `window.bliss`.
- Alternatives considered: renaming the package or `productName`.
- Why: `app.getName()` names the `userData` folder; renaming it would orphan the browsing profile.
- Revisit if: packaging (Phase 5) sets a product name; then move or migrate `userData` deliberately.
- Status: settled

## 2026-10-12: Phase 2 core design
- Chosen:
  - **Tabs:** a tab manager in `src/main/tabs.ts` is the single source of truth, with integer tab ids. Updates are diff-only and coalesced to one `tabs:update` per ~16 ms.
  - **Sizes:** the UI reports the page area through `page:set-area`, which main clamps, so `tokens.css` stays the only source of sizes.
  - **Blank tabs** have no view. Page views are detached while the memory panel shows. A page that closes itself falls back to a blank tab.
- Alternatives considered: computing the bounds in main from constants (duplicates tokens); keeping a view per blank tab.
- Why: PLAN 4.1, low memory, and one place to restyle sizes.
- Revisit if: multiple windows are added (the tab state is single-window today).
- Status: settled

## 2026-10-12: Page navigation and session security
- Chosen:
  - **Page views:** on `persist:main`, sandboxed, context-isolated, no preload, `safeDialogs`, `navigateOnDragDrop: false`, DevTools allowed (user decision).
  - **Navigation:** main frames are http(s) only, via the shared `isWebUrl`; `tab:navigate` loads the normalized `href`.
  - **Subframes** of pages use an allow-list: http, https, data, blob, about:blank, about:srcdoc. All subframe navigation in the UI is blocked.
  - **Client certificates** are never sent automatically. Downloads are cancelled until step 2e.
- Alternatives considered: a subframe deny-list (misses `ms-msdt:`, `search-ms:` and other protocol-handler schemes).
- Why: the step 2a security reviews (M1, M2, L1–L4).
- Revisit if: the permission prompts (2f) change how `openExternal` is handled. They must keep denying it for subframes.
- Status: settled

## 2026-10-12: Search engine, Google, with suggestions off
- Chosen: `https://www.google.com/search?q=` in `src/shared/address.ts`. No search suggestions while typing.
- Alternatives considered: Brave Search, DuckDuckGo; suggestions from the engine's free endpoint.
- Why: the user's choice. Suggestions would send every keystroke to the engine.
- Revisit if: the user wants suggestions or a different engine.
- Status: settled

## 2026-10-11: Focus the UI view before showing the window
- Chosen: main calls `uiView.webContents.focus()` just before `window.show()`.
- Alternatives considered: blurring the focused element from the UI after load; leaving it alone.
- Why: when the window is activated, Chromium tabs into the view's first focusable element. It counts as keyboard focus, so Back opened with a focus ring. Focusing the view first prevents it, and focusing after the show is too late (measured). A smoke check covers it.
- Revisit if: Phase 2 adds page views. The new tab or restored page may then be the better initial focus.
- Status: settled

## 2026-10-11: Smoke screenshot at 1280×800 with device scale factor 1
- Chosen: the smoke test launches with `--force-device-scale-factor=1`, sets the content size to 1280×800, waits until the viewport matches, and saves `test-results/sidebar-1280x800.png` before any interaction.
- Alternatives considered: testing at the laptop's real 125% scaling.
- Why: at 125%, `setContentSize(1280, 800)` comes out at 1280×801 (rounding), so an exact-size check can't pass. Scale factor 1 gives the same image on any display. The app itself is unaffected.
- Revisit if: a DPI-specific layout bug turns up; then add a check at the real scaling.
- Status: settled

## 2026-10-11: Phase 1 scope for the optional mockup parts
- Chosen: build the pinned sites grid (mock data). Leave out the Space switcher dots and the settings button for now; the bottom row keeps only the Memory toggle.
- Alternatives considered: building all three, or none.
- Why: the user's choice. Spaces stay a Phase 9 decision (open decision #19); the settings button returns when the console exists.
- Revisit if: Spaces or the console are built.
- Status: settled

## 2026-10-11: Icons as inline SVG components, copied from Lucide
- Chosen: a handful of Lucide icons as small React components in `src/ui/icons/`, coloured with `currentColor`, with Lucide's licence file kept alongside.
- Alternatives considered: the `lucide-react` package.
- Why: about 8 icons don't justify a dependency. Inline SVG elements need no Trusted Types policy.
- Revisit if: the icon count grows past about 30.
- Status: settled

## 2026-10-11: Window controls, native overlay that follows the tokens
- Chosen: `titleBarStyle: 'hidden'` with a transparent `titleBarOverlay`. After the UI loads, main reads the computed `body` background and text colour from the UI view (a fixed `executeJavaScript` script, opaque `rgb()` only, 2 s timeout, shape-checked) and applies them to the window background and the caption symbols.
- Alternatives considered: custom buttons in the sidebar (loses Snap Layouts); a new IPC call from the UI to set the colours; reading the colours in an isolated world.
- Why: native buttons keep Snap Layouts, and `tokens.css` stays the single place to set the colours. Pulling from main adds no IPC surface. The isolated world was skipped: a compromised UI can at most recolour its own window. The user confirmed on Windows that the strip matches the frame.
- Revisit if: a dark theme arrives (inactive-window glyph colour is system-controlled), or tokens move to non-sRGB colours such as `oklch()`, which this check rejects.
- Status: settled

## 2026-10-11: LF line endings via .gitattributes
- Chosen: `* text=auto eol=lf` (fonts marked binary).
- Alternatives considered: changing Biome to CRLF; changing the global `core.autocrlf`.
- Why: Git on this machine has `core.autocrlf=true`, so checkouts and some editor saves produced CRLF, which Biome rejects. The repo already stores LF, so this only fixes the working copy, and it's per-repo so it doesn't touch the user's global Git config.
- Revisit if: a Windows-only tool needs CRLF files.
- Status: settled

## 2026-10-11: npm installs only versions at least 7 days old
- Chosen: project `.npmrc` with `min-release-age=7` (supported in npm 11.17).
- Alternatives considered: no guard; `ignore-scripts=true`.
- Why: most npm supply-chain attacks are caught and pulled within days. Dev tools run with the user's rights on the machine that will later hold the Brave password export. `ignore-scripts` isn't needed: no current dependency on Windows has an install script, and Electron's own install script is needed to fetch its binary.
- Revisit if: an urgent security fix must be installed sooner (override once with `--min-release-age=0`).
- Status: settled

## 2026-10-11: Test dependencies, vitest 5.0.3 and @playwright/test 1.64.0
- Chosen: both as exact-pinned devDependencies. Together they add 19 packages (about 22 MB). None runs an install script, and all have verified registry signatures. Playwright's browsers are not installed: `_electron` drives the project's own Electron.
- Alternatives considered: no smoke test (manual checks only); Node's built-in test runner instead of Vitest.
- Why: Vitest runs TypeScript and ESM with no extra setup and is the conventional choice with Vite. Playwright is the only practical way for agents to launch and check the Electron UI. Nothing from either ships in the app bundle (checked in `out/`).
- Revisit if: either becomes unmaintained, or the smoke test turns flaky on Windows.
- Status: settled

## 2026-10-11: Later-phase constraints from the step 3 security review
- Chosen:
  - (Phase 3+) Run the smoke test against a fresh or temporary `userData` once storage exists, never against a profile holding real data. Playwright opens local debug ports while it runs.
  - (Phase 5) Register the default-browser handler as `"bliss.exe" -- "%1"`, treat only arguments after `--` as URLs, and read flags like `--bench` only from arguments before `--`. Keep `--bench` gated on `!app.isPackaged`.
  - (Phase 5) Limit packaged files to `out/**` plus `package.json`, so `src/`, `tests/` and configs are never packed.
  - (Phase 2) Process labels from tab titles or URLs are rendered as text only. Any future IPC that takes a PID must check that the PID belongs to `app.getAppMetrics()`.
- Alternatives considered: none; these are constraints.
- Why: each closes a known path for untrusted input (command-line URLs, page titles) or for real data leaking into tests.
- Revisit if: the relevant phase's design changes.
- Status: settled

## 2026-10-11: Phase 2 security constraints (from the step 2 reviews)
- Chosen: rules Phase 2 must follow when page views arrive:
  - Every page view uses the `persist:main` partition, created in one place. The UI's default session is the only one that serves `blisz://`, so this keeps web pages away from app files.
  - The "navigate to X" IPC handler checks the scheme itself (http/https only, never `blisz:` or `file:`), because a `loadURL` from main doesn't fire `will-navigate`.
  - Relax navigation for page views only through `isNavigationAllowed`, and keep it returning `false` for trusted UI views. Add `will-frame-navigate` for subframes.
  - Per-site permission prompts replace `denyAllPermissions`, still wired through `session-created` so every new partition gets them.
  - The UI view's clipboard writes are denied today and will need an explicit exception for the trusted UI (for copy link and the vault).
  - If a `select-bluetooth-device` listener is ever added, it must call `preventDefault()`.
  - (Phase 4) In Electron 44 the `clipboard` module is main-process only and Promise-based, so the vault's copy-and-clear runs in main.
- Alternatives considered: none; these are constraints, not options.
- Why: the current baseline is safe only while these hold.
- Revisit if: the view or session layout changes.
- Status: settled

## 2026-10-11: Trusted UI served from a custom scheme, `blisz://app/`
- Chosen: register `blisz` as a privileged (standard, secure) scheme and serve `out/renderer` through `protocol.handle` on the default session only. The handler checks path containment, rejects `:`, `\` and NUL in paths, and adds `nosniff` and `frame-ancestors 'none'` headers. Internal pages will live under the same scheme (`blisz://history` and so on).
- Alternatives considered: `file://` (the original scaffold), deferring to Phase 2.
- Why: on `file://`, `'self'` in the CSP covers local files in general, so script injected into the UI could read files on disk (for example the Brave password export). A custom scheme confines the UI to its own bundle. It was cheapest to do before more code depended on the URL. The scheme name is the user's choice.
- Revisit if: the browser is renamed (a find-and-replace).
- Status: settled

## 2026-10-11: IPC sender check compares protocol plus host
- Chosen: `handleFromUi` accepts a call only from a trusted UI view's main frame whose URL has the same protocol and host (including port) as `UI_URL`. `UI_URL` is computed once: the dev server only when unpackaged and only from `http://localhost`, otherwise `blisz://app/index.html`.
- Alternatives considered: exact URL match (brittle), comparing `URL.origin` (Node reports `"null"` for custom schemes, so it would reject the real UI).
- Why: a single definition shared by the loader and the check means the two can't drift apart.
- Revisit if: internal pages need their own hosts under `blisz://`.
- Status: settled

## 2026-10-11: Production CSP with Trusted Types
- Chosen: `default-src 'none'` with explicit `'self'` allows, `require-trusted-types-for 'script'` and `trusted-types 'none'`. Dev serves a relaxed policy through a Vite plugin (`apply: 'serve'`) that throws if it can't find the meta tag. Trusted Types is on in dev too.
- Alternatives considered: `default-src 'self'` without Trusted Types (the scaffold's version).
- Why: the UI will display untrusted page titles and URLs, and later passwords. React 19 needs no Trusted Types policy, so it costs nothing. UI code can't use `innerHTML`, inline `style=` attributes or `eval`.
- Revisit if: a needed library requires a Trusted Types policy; then name the policy rather than loosening the CSP.
- Status: settled

## 2026-10-11: SQLite driver, `node:sqlite`
- Chosen: `node:sqlite`, built into Node 24.21 in Electron 44.7.0.
- Alternatives considered: `better-sqlite3`.
- Why: a check inside the Electron main process passed. It loads with no warning; prepared statements, transactions, read-only opening of a copied file, and use from a worker thread all work; 100k inserts in one transaction took about 50 ms. There is no native module to rebuild. Caveats: it is synchronous (run heavy work in a worker); there's no `.transaction()` helper (write a small BEGIN/COMMIT/ROLLBACK wrapper); and when importing Brave's `History`, copy the `-wal` file too, or recent visits may be missing.
- Revisit if: an Electron upgrade changes the API (re-run the check after upgrades), or a needed feature is missing.
- Status: settled

## 2026-10-11: UI framework, React 19
- Chosen: React 19.3 with `@vitejs/plugin-react`.
- Alternatives considered: Svelte 5, Preact, Solid.
- Why: a short spike (50 mock tabs, one patch every 100 ms, measuring the UI process's private bytes) showed React and Svelte both settling at 22.9 MB (blank page: 21.4 MB). Growth was +3.2 MB for React and +2.3 MB for Svelte over 1.5 min. No difference reached the "switch to Svelte" thresholds. PLAN 3.1 says to prefer the conventional option when the gap is small. The user accepted this without running the full 1 h 45 min protocol.
- Revisit if: the real Phase 1 sidebar shows the UI process growing over a day of use, or React clearly costs more than a few MB over Svelte.
- Status: provisional

## 2026-10-10: Page view rounded corners
- Chosen: native `View.setBorderRadius()` on page views; the UI view draws the shadow.
- Alternatives considered: approximating with layout or masks.
- Why: Electron supports it natively, so no workaround is needed.
- Revisit if: it renders badly on Windows or costs performance when tested in Phase 1/2.
- Status: provisional

## 2026-10-10: Fonts
- Chosen: Geist and Geist Mono variable woff2 files (vercel/geist-font 1.7.2, OFL 1.1) committed with `OFL.txt`.
- Alternatives considered: the npm package, a CDN.
- Why: no runtime network access, no dependency.
- Revisit if: the user changes fonts.
- Status: settled

## 2026-10-10: Packaging
- Chosen: deferred to Phase 5; leaning electron-builder.
- Alternatives considered: Electron Forge.
- Why: it doesn't affect the scaffold.
- Revisit if: Phase 5 starts.
- Status: provisional

## 2026-10-10: Tests
- Chosen: Vitest for logic; Playwright `_electron` for smoke tests, run against an unfused dev build.
- Alternatives considered: no smoke tests (the user checks by hand).
- Why: keeps tests light while letting agents check the UI. The `nodeCliInspect` fuse blocks Playwright, so smoke tests can't run against a fused build.
- Revisit if: Playwright's Electron support breaks on Windows.
- Status: settled

## 2026-10-10: Styling
- Chosen: plain CSS. One `tokens.css` with all visual values, plus a CSS Module per component that uses tokens only.
- Alternatives considered: Tailwind.
- Why: the user's choice; it's easy to restyle by hand and has no build-time dependency.
- Revisit if: never planned.
- Status: settled

## 2026-10-10: Lint and format
- Chosen: Biome 2.5.x for both.
- Alternatives considered: ESLint + Prettier.
- Why: one package with no dependency tree. `tsc --strict` and code review cover the type-aware rules Biome lacks.
- Revisit if: a needed rule is missing.
- Status: provisional

## 2026-10-10: TypeScript version
- Chosen: `typescript@6.0.3`, strict.
- Alternatives considered: TypeScript 7.0.
- Why: TypeScript 7 has no JS API yet and breaks tools that rely on it.
- Revisit if: the TypeScript 7 JS API ships and electron-vite and Biome tooling support it.
- Status: provisional

## 2026-10-10: Package manager
- Chosen: npm 11.
- Alternatives considered: pnpm, bun.
- Why: already installed; pnpm and bun need extra setup for Electron's install and native tooling.
- Revisit if: install times or disk use become a problem.
- Status: settled

## 2026-10-10: Build tooling
- Chosen: `electron-vite@6.0.0-beta.7` (pinned) with Vite 8 and a hand-written config. Main and preload output CommonJS.
- Alternatives considered: electron-vite 5.0.0 stable with Vite 7.3; the scaffolder.
- Why: 5.0.0 crashes when output isn't a terminal, which breaks agent-run builds. The scaffolder is stale and defaults to Electron 39.
- Revisit if: 6.0.0 stable ships (move to it), or the beta blocks us (fall back to 5.0.0 with Vite 7.3).
- Status: provisional

## 2026-10-10: Electron version
- Chosen: `electron@44.7.0`, pinned exactly (Chromium 152, Node 24.21).
- Alternatives considered: 45.0.0 beta.
- Why: latest stable when the project started.
- Revisit if: 45.0.x goes stable (expected 2026-10-20). Upgrade soon after, while the codebase is small.
- Status: provisional
