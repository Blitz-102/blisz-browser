# Decisions

Newest at the top. Each entry: what was chosen, what else was considered, why, and when to revisit.

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
