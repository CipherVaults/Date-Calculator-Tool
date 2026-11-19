# Development Handoff — Date Calculator Tool (`v1.2.0`)

This document gives a new collaborator (human or AI) what they need to build, test, change and release the project on Windows.

> **Handoff, 2026-11-19:** development continues with **Ahmed Emara** (CipherVaults partner) on the **[Portable Calculator Tool](https://github.com/CipherVaults/Portable-Calculator-Tool)**. Start with that repo's `HANDOFF.md`. Since 2026-11-19, this Date Calculator is **frozen at v1.2.0** by the owner's decision: maintenance only. Its only planned change is the later "replaced by Portable Calculator Tool" sunset release (v1.3.0, Portable milestone M11). The owner decisions log is in the Portable repo at `Documentation/handoff/DECISIONS_LOG.md`.

> **Start here:** [AGENTS.md](AGENTS.md) (conventions and permission boundaries), then [CURRENT_STATE.md](Documentation/pbs/CURRENT_STATE.md), [CONTINUATION_STATE.md](Documentation/pbs/CONTINUATION_STATE.md) and [SOURCE_OWNERSHIP_MAP.md](Documentation/pbs/SOURCE_OWNERSHIP_MAP.md).
> Evidence and security: [EXECUTION_AND_CODING_LEDGER.md](Documentation/pbs/EXECUTION_AND_CODING_LEDGER.md), [SECURITY_HARDENING_DOSSIER.md](Documentation/pbs/SECURITY_HARDENING_DOSSIER.md) and [4- SESSION_SUMMARY.md](Documentation/4-%20SESSION_SUMMARY.md). Design authority: [0- FROZEN_DECISIONS.md](Documentation/specs/0-%20FROZEN_DECISIONS.md), which overrides specs 1–4.

---

## 1. Repository & Version Identity

- **Repository:** [`CipherVaults/Date-Calculator-Tool`](https://github.com/CipherVaults/Date-Calculator-Tool), public, UNLICENSED.
- **Mobile & Web PWA (GitHub Pages, deployed from `main`, live since 2026-11-17):** `https://ciphervaults.github.io/Date-Calculator-Tool/`
- **Identity:**
  - product name `Date Calculator Tool`;
  - identifier `com.datecalculator.tool`;
  - Cargo package and binary `date-calculator-tool` (`target\release\date-calculator-tool.exe`);
  - engine crate `date-core`.
- **Version:** app `1.2.0`, released 2026-11-18 as the GitHub Release [`v1.2.0`](https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v1.2.0) (tag on merge commit `c40fd4d`). The engine `date-core` is still `1.0.0` (section 9F).
- **Earlier releases:**
  - [`v1.1.0`](https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v1.1.0), 2026-11-18 (tag on `7f46254`);
  - [`v1.0.0`](https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v1.0.0), 2026-11-17 (tag on `5a512a3`).
- **Branches:**
  - All work happens on `dev`. `main` is the default branch and is reached only by PR from `dev`.
  - Merged PRs: #1 (v1.0.0), #2 (docs), #3 (v1.1.0, merged by the owner), #4 (docs), #5 (v1.2.0, merged by the coordinator under the owner's standing release authority) and #6 (docs, `68e9b93`).
  - Every push to `main` runs the release job and the Pages deploy. Who may merge is in section 9G.
  - Never force-push.
- **Sibling/reference:** `CipherVaults/Percentage-Calculator-Tool` v2.2.1. Its architecture, hardening, design system and CI are mirrored here deliberately.

---

## 2. Architecture Overview

```text
+---------------------------------------------------------------------------+
| 1. Windows Desktop App (Tauri v2 + Rust)                                  |
|                                                                           |
|  Static webview UI (ui/index.html, ui/styles.css, ui/main.js)             |
|    - plain HTML/CSS/JS, no bundler, no npm, no innerHTML                  |
|    - window.__TAURI__.core.invoke(cmd, { req })                           |
|                              |                                            |
|                              v                                            |
|  Tauri shell (src-tauri/src/main.rs, commands.rs)                         |
|    - capability permissions: [] ; CSP connect-src 'none'                  |
|    - 9 engine commands + history/countdown/layout/settings/update/copy/   |
|      app-info/smoke (30 commands in all)                                  |
|    - %APPDATA%\com.datecalculator.tool\                                   |
|        {history,settings,countdown,layout}.json                           |
|                              |                                            |
|                              v                                            |
|  Pure Rust engine (crates/date-core)                                      |
|    - serde only, forbid(unsafe), no clock/time zone/locale, no panics     |
|    - {"ok":"true","result":...} / {"ok":"false","error":...}             |
+---------------------------------------------------------------------------+

+---------------------------------------------------------------------------+
| 2. Mobile & Web PWA (mobile/)                                             |
|                                                                           |
|  mobile/index.html + sw.js + manifest.webmanifest + icons/                |
|    - inline <style>/<script> pinned by SHA-256 in a meta CSP              |
|    - JS engine mirror between /* date-core:begin v1.0.0 */ and            |
|      /* date-core:end */ (no Date, Intl, toISOString, getTimezoneOffset)  |
|    - localStorage history/settings/countdown/layout                       |
|    - service worker date-tool-v1.2.0-mobile-1                             |
+---------------------------------------------------------------------------+
```

Details are in [2- ARCHITECTURE.md](Documentation/2-%20ARCHITECTURE.md).

---

## 3. Existing Features (`v1.2.0`)

- **Six calculators**, each backed by one engine function:
  1. Days Between (`calc_days_between`)
  2. Add / Subtract with an optional business-day mode (`calc_add_subtract`)
  3. Business Days (`calc_business_days`)
  4. Age (`calc_age`)
  5. Date Info (`calc_date_info`)
  6. Countdown (`calc_countdown`)

  The supporting functions are `holidays_in_range`, `month_grid` (mini calendars) and `validate_calendar`.
- **Calendar:**
  - Weekend: Sat/Sun, Fri/Sat, Fri only or custom.
  - Presets: US federal, UK (England & Wales) and Egypt. Egypt switches the weekend to Fri/Sat and has estimated Islamic dates with a ±2-day offset and per-year overrides.
  - Custom holidays (one-off or yearly) and exclusions.
  - Rules cover 1900–2199.
- **UI:**
  - quick-jump bar, live results, a "live formula" trace, copy buttons and Enter-to-calculate;
  - history with up to 500 entries, filter, restore and delete;
  - Settings and About modals, and an optional startup update check with an update banner.
- **Clickable mini calendars (v1.1.0)** on Business Days, Date Info and Countdown:
  - a click sets the date; Business Days has a Start/End switch, Shift sets the end, and typing a start moves the next click to the end;
  - roving-tabindex keyboard navigation, a Today button and 44 px cells.
- **Countdown persistence (v1.1.0):** the target is saved in its own store and shows *restored*, *finished* or *finished while closed*. **Forget** clears it.
- **History safety (v1.1.0):**
  - any read failure other than "file not found" makes history read-only, with Retry;
  - a corrupt file is backed up first;
  - "Start a new history" always keeps a copy of the old file.
- **Card layout (v1.2.0):**
  - every card collapses with [ − ] / [ + ];
  - reorder by dragging the ⠿ handle (mouse, pen or finger, with a deliberate touch threshold), with ArrowUp/ArrowDown on the handle, or with a tap-to-open Move up / Move down / Done menu that works with VoiceOver and TalkBack (the ends are marked `aria-disabled`);
  - the quick-jump bar follows the order;
  - the layout is saved in its own store, and **Settings → Layout → "Reset card order & expand all"** restores the default.
- **Mobile:**
  - safe-area insets, 16 px inputs on iOS and 44 px touch targets;
  - an install guide for iPhone and Android;
  - works offline through the service worker.

---

## 4. Important Files & Directories

| Path | Role |
| --- | --- |
| `Cargo.toml` / `Cargo.lock` | Workspace (`crates/date-core`, `src-tauri`) and locked dependencies |
| `.gitattributes` | Forces LF on `mobile/`, `ui/`, `scripts/*.mjs` and the fixtures (CSP hashes are byte-exact) |
| `crates/date-core/src/` | Engine: `api.rs` (IPC surface, size caps), `strict.rs`, `civil.rs`, `calendar.rs`, `business.rs`, `grid.rs`, `holidays/`, `modes/` |
| `crates/date-core/examples/eval_bridge.rs` | NDJSON bridge used by `scripts/safety-eval.mjs` |
| `crates/date-core/examples/gen_golden.rs` | Generates and checks `tests/fixtures/golden.json` |
| `crates/date-core/tests/fixtures/vectors.json` | 195 hand-verified vectors: **never regenerated** |
| `crates/date-core/tests/fixtures/golden.json` | 13,965-case regression lock shared with the mobile engine |
| `src-tauri/src/main.rs` | Window, states, the 30 registered commands, `--smoke-test` with a 20 s watchdog |
| `src-tauri/src/commands.rs` | Command handlers, hardened storage (history, settings, countdown, layout), update check, clipboard, 36 unit tests |
| `src-tauri/tauri.conf.json` | Version, window, desktop CSP, NSIS/MSI bundling |
| `src-tauri/capabilities/default.json` | `permissions: []` |
| `ui/` | Desktop frontend and the in-page smoke suite (`ui/main.js`) |
| `mobile/index.html`, `mobile/sw.js`, `mobile/manifest.webmanifest`, `mobile/icons/` | The PWA |
| `scripts/check-mobile.mjs` | Mobile parity gate: bans, CSP hashes, LF, sinks, app and engine versions, engine slice hash, golden replay in 3 time zones |
| `scripts/safety-eval.mjs` | Cross-surface safety evaluation (slices A–D), writes the System Card |
| `scripts/serve-mobile.mjs` | Local PWA server at `http://127.0.0.1:8787/Date-Calculator-Tool/` |
| `scripts/generate-icons.mjs` | Draws the icon PNGs (no dependencies) |
| `.github/release-notes-v<version>.md` | Release notes used by the release job, one per release (`v1.0.0`, `v1.1.0`, `v1.2.0`) |
| `.github/workflows/` | `build.yml` (checks, Windows build, release) and `pages.yml` (Pages deploy); green on every release PR and on `main` |
| `Documentation/` | Context, architecture, roadmap, session summary, `specs/`, `pbs/` |

---

## 5. Key Architectural & Security Decisions

1. **One engine, two languages.**
   - `date-core` is the single source of date logic. The mobile JS engine is a line-by-line mirror of it.
   - Any engine change updates the Rust code, the JS mirror and the fixtures in the same commit.
2. **Pure engine.**
   - "Today", "now" and per-instant UTC offsets are request fields.
   - The engine has no clock, time zone or locale, and all text is locale-free ASCII.
3. **Envelope** `#[serde(tag = "ok")]` with `"true"`/`"false"` string tags. JSON is camelCase, with `deny_unknown_fields` on every request.
4. **Strict IPC boundary.**
   - The `Strict` deserializer accepts objects only and enums as strings only.
   - Request strings are capped at 1024 bytes and requests at 64 KiB.
   - A bad shape always returns `invalid_request`, never a Tauri error.
5. **`permissions: []` and `connect-src 'none'` on the desktop.** The update check runs in Rust through `System32\curl.exe`.
6. **Hardened storage:**
   - size caps and symlink and non-regular file rejection;
   - unique temp file + `sync_all` + rename;
   - lock held across the write, memory changed only after it succeeds;
   - a one-time `.bak` / `_bak` for corrupt settings, then defaults with update checks off;
   - the countdown and the layout each have their own small file (1 KiB cap) with the same hardening, so a bad record can never break settings;
   - history: any read failure other than "file not found" makes it read-only (writes return `history_read_only`), and nothing replaces the file without a backup copy.
7. **DOM safety:** only `textContent`, `createElement` and `replaceChildren`. Mobile JS toggles classes and never sets `.style`.
8. **CI supply chain:** SHA-pinned Actions, `persist-credentials: false` and `--locked`. In `build.yml` only the release job can write repo contents; `pages.yml` gets `pages: write` and `id-token: write` for the Pages deploy. Released tags and assets are immutable.

---

## 6. Development Progress

| Milestone | Status |
|---|---|
| M0 scaffold, M1–M3 engine | done, verified 2026-11-16 (ledger E-02 to E-06) |
| M4 backend | done, verified 2026-11-17 (E-08) |
| M5 desktop UI, M6 mobile PWA, M7 safety-eval | done, verified 2026-11-17 (E-09) |
| M8 CI, docs, PR | done 2026-11-17: PR #1 with green CI on Ubuntu and Windows (E-12) |
| M9 release | done 2026-11-17: owner-authorized merge, Release `v1.0.0` with 5 assets, Pages live (E-13). Real-phone PWA install is still an owner check |
| A1 calendars; A2 countdown persistence, history fix and version split | done, verified 2026-11-18 (E-15) |
| A3 v1.1.0 release | done 2026-11-18: the owner merged PR #3 (`7f46254`); Release `v1.1.0` published 04:59:32Z and verified (E-16) |
| A8 v1.2.0 card layout and release | done 2026-11-18: PR #5 merged under the owner's standing release authority (`c40fd4d`); Release `v1.2.0` published 16:50:38Z and verified (E-17) |

These A milestones are Part A of [5- PORTABLE_CALCULATOR_PLAN.md](Documentation/specs/5-%20PORTABLE_CALCULATOR_PLAN.md). Milestone A3 is the v1.1.0 release; the history fix that shipped in it is plan item A3.

Release `v1.2.0` checks (E-17):
- 5 files; `sha256sum -c` OK for the 4 assets, and `SHA256SUMS.txt` has no CR bytes;
- the mobile asset and the live Pages `index.html` / `sw.js` are identical to `main`;
- the downloaded portable exe passed `--smoke-test` (exit code 0, `SMOKE_TEST_OK` including the countdown and layout checks; ProductVersion 1.2.0).

Last local verification (E-17):
- fmt and clippy clean;
- `cargo test --workspace --locked`: 140 tests (104 date-core, 36 desktop backend), all pass;
- `gen_golden --check`: up to date;
- `check-mobile.mjs`: PASS under 3 time zones, engine slice hash pinned;
- `safety-eval.mjs`: 107/107 criteria, 36,134 assertions, with planted-mutant proofs;
- debug `--smoke-test`: `SMOKE_TEST_OK` (renderer, IPC, clipboard, countdown and layout).

v1.0.0 hosted verification (E-12, E-13):
- PR #1 CI found one real defect: `SHA256SUMS.txt` was written with CRLF, so `sha256sum -c` failed on Linux/macOS. Fixed in `9c06553`; the re-run was green.
- The Release `v1.0.0` assets were downloaded and checked: `sha256sum -c` OK for all 4 files, `SHA256SUMS.txt` has no CR bytes, and the mobile HTML is byte-identical to `mobile/index.html`.
- The downloaded portable exe passed `--smoke-test` on the owner's Windows 11 PC (exit code 0, `SMOKE_TEST_OK`; file version 1.0.0).
- The live Pages files are byte-identical to `mobile/`; the service worker is active and sample Days Between and Age results were shown (see E-13).

---

## 7. Outstanding Tasks & Owner-Side Follow-ups

v1.0.0, v1.1.0 and v1.2.0 are released. What is left:

1. **Docs on `main`:** post-release docs reach `main` through a docs-only PR `dev` → `main`, as PRs #2, #4 and #6 did. A docs-only merge is safe: the release job keeps the existing tag and assets, and Pages does not run, because `pages.yml` only triggers on changes to `mobile/**` or its own file.
2. **Owner checks (not yet verified):**
   - Install and use the PWA on a real iPhone and Android phone. So far only "service worker active, manifest served" and headless 390 px screenshots are verified.
   - Manual checks on the installed exe, and the NSIS and MSI installers on a clean machine.
   - A screen-reader pass. The Move menu was built for VoiceOver and TalkBack but not tried on a device.
   - Confirm that leaving the Egypt preset should keep the Fri/Sat weekend (from M5).
   - Optionally check in **Settings → Environments → `github-pages`** that it deploys from `main` only. Pages already reports source `main` with build type "workflow" (GitHub Actions).
3. **What comes next:** this app and Percentage Calculator Tool are being merged into **Portable Calculator Tool**, in the new public repository [`CipherVaults/Portable-Calculator-Tool`](https://github.com/CipherVaults/Portable-Calculator-Tool) (created 2026-11-18 on the owner's yes). The plan is [5- PORTABLE_CALCULATOR_PLAN.md](Documentation/specs/5-%20PORTABLE_CALCULATOR_PLAN.md). Portable status: M0 and M1 done, M2a (the phone-first shell) in progress. The old-app sunset release is planned as **Date v1.3.0**.
4. **Backlog** (not authorized, see [3- ROADMAP.md](Documentation/3-%20ROADMAP.md)): more holiday presets, Egyptian decree overrides as data, a light theme.

---

## 8. Known Bugs, Caveats & Gotchas

- **No known functional bugs** in the engine, desktop UI or PWA as of E-17.
- **Never run Cargo or Tauri from Git Bash.** Its `/usr/bin/link` shadows the MSVC `link.exe`. Use PowerShell or Windows Terminal. Node and `gh` are fine in either shell.
- **Editing `<style>` or `<script>` in `mobile/index.html` breaks the CSP until both hashes are recomputed** (section 9D). `check-mobile.mjs` fails until they match.
- **Line endings:** keep `git config core.autocrlf false` and the `.gitattributes` rules. One stray CR inside `mobile/index.html` changes the hash.
- **Release builds have no console** (`windows_subsystem = "windows"`), so a bare run shows nothing and PowerShell does not wait for it. CI runs the exe with `Start-Process -Wait -PassThru` and redirected stdout, and gates on both `ExitCode` 0 and `SMOKE_TEST_OK` in that stdout (section 9C).
- **The smoke test writes to the real Windows clipboard**: the sentinel `date-tool-smoke-test`. History, settings, the countdown and the layout stay in memory and never touch `%APPDATA%`.
- **App version and engine version are separate.** An app release never bumps `date-core`. Setting date-core or the `golden.json` header to the app version fails CI and `check-mobile.mjs`. Editing the engine slice in `mobile/index.html` fails the pinned slice hash check.
- **The countdown and the layout live in their own files** (`countdown.json`, `layout.json`), not in `settings.json`. That way an older binary never treats a newer settings file as corrupt. Do not fold them back into settings.
- **History never overwrites what it cannot read.** If `history.json` fails to read for any reason other than "not found", history turns read-only until Retry or "Start a new history". The reset always keeps a copy (`history.json.bak` or `history.json.bak-<ms>`).
- **PowerShell adds a UTF-8 BOM to piped stdin.** The bridge rejects that first line as `invalid_request`. When piping requests by hand, start with a blank line or use a file.
- **The update check reads `releases/latest`,** which now returns `v1.2.0`. That equals `APP_VERSION`, so no update banner is expected on v1.2.0 (the banner itself was not separately inspected).
- **`SHA256SUMS.txt` must stay LF.** PowerShell `Set-Content` writes CRLF, which breaks `sha256sum -c` on Linux/macOS. The stage step writes it with `[System.IO.File]::WriteAllText` and LF, and fails if any CR byte remains.
- **"Cancelled" CI runs are not failures.** A newer push to a PR cancels the older `pull_request` run (concurrency rule `cancel-in-progress`).
- **The WebView2 teardown line** "Failed to unregister class Chrome_WidgetWin_0" on stderr after a smoke test is harmless.
- **Unsigned Windows binaries** trigger SmartScreen; users verify with `SHA256SUMS.txt`. **GitHub Pages cannot send framing headers**, so never put `frame-ancestors` in the meta CSP.
- **Platform-conditional code:** Unix-only permission code in `commands.rs` lives under `#[cfg(unix)]`. Clippy runs with `-D warnings` on Windows, so do not declare variables that only Unix code uses.

---

## 9. Dependencies, Environment, Build, Test & Release

### A. Prerequisites (Windows)

- Visual Studio Build Tools with **Desktop development with C++** and the Windows 10/11 SDK.
- WebView2 runtime (preinstalled on Windows 10/11).
- Git, GitHub CLI, Rustup and Node.js 20+ (Node only runs the checks; there are no npm packages):
  ```powershell
  winget install Git.Git
  winget install GitHub.cli
  winget install Rustlang.Rustup
  winget install OpenJS.NodeJS.LTS
  rustup default stable
  rustup component add rustfmt clippy
  cargo install tauri-cli --version "=2.12.4" --locked
  git config core.autocrlf false
  ```
- Rust dependencies (`Cargo.lock`, edition 2021):
  - `date-core`: `serde`; dev-only `serde_json` and `chrono`.
  - `src-tauri`: `tauri` 2, `tauri-build` 2, `tauri-plugin-clipboard-manager` 2, `serde` and `serde_json`.

### B. Verify (PowerShell)

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo run -p date-core --example gen_golden --locked -- --check
node scripts/check-mobile.mjs
node scripts/safety-eval.mjs --json target/safety-eval-system-card.json
cargo run -p date-calculator-tool --locked -- --smoke-test
```

- The `chrono` oracle walks 3.65M days. `cargo test -p date-core --locked --release` is faster when iterating on the engine.
- `check-mobile.mjs` takes about 15 s. `safety-eval.mjs` reuses `target/release/examples/eval_bridge.exe` only when it is newer than every date-core source; otherwise it rebuilds it with `cargo run --release`.
- The debug smoke test prints `SMOKE_TEST_OK: all renderer, IPC, clipboard, countdown, and layout checks passed.` and exits 0.

### C. Run, build and smoke-test

```powershell
cargo tauri dev                      # live desktop app
cargo tauri build -- --locked        # NSIS + MSI + release exe
```

Outputs:
- `target\release\bundle\nsis\Date Calculator Tool_1.2.0_x64-setup.exe`
- `target\release\bundle\msi\Date Calculator Tool_1.2.0_x64_en-US.msi`
- `target\release\date-calculator-tool.exe` (the portable build)

Release-exe smoke test (as in CI, FROZEN §14):

```powershell
$out = Join-Path $env:TEMP "smoke-stdout.txt"
$err = Join-Path $env:TEMP "smoke-stderr.txt"
$p = Start-Process -FilePath .\target\release\date-calculator-tool.exe -ArgumentList "--smoke-test" -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
Get-Content $out, $err -ErrorAction SilentlyContinue
if ($p.ExitCode -ne 0) { throw "smoke test failed ($($p.ExitCode))" }
if (-not (Select-String -Path $out -SimpleMatch 'SMOKE_TEST_OK' -Quiet)) { throw "smoke test exited 0 without SMOKE_TEST_OK" }
```

Mobile PWA locally: `node scripts/serve-mobile.mjs`, then open `http://127.0.0.1:8787/Date-Calculator-Tool/`.

### D. Changing `mobile/index.html`

1. Edit. Keep LF and keep the engine between the `date-core:begin` / `date-core:end` markers.
2. Recompute both CSP hashes with the command below. Paste them into the `style-src` and `script-src` directives of the `<meta http-equiv="Content-Security-Policy">` tag. The `<style>` hash does not change when only the script changes, but recompute both anyway.

```powershell
@'
const fs = require("fs"), crypto = require("crypto");
const html = fs.readFileSync("mobile/index.html", "utf8");
for (const tag of ["style", "script"]) {
  const m = html.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
  console.log(tag + "-src 'sha256-" + crypto.createHash("sha256").update(m[1], "utf8").digest("base64") + "'");
}
'@ | node
```

3. Bump `CACHE_NAME` in `mobile/sw.js` on **every** mobile change (for example `date-tool-v1.2.0-mobile-2`), so installed PWAs pick up the new shell.
4. Run `node scripts/check-mobile.mjs`.

### E. Changing engine behaviour

1. Change `crates/date-core` **and** the JS mirror in `mobile/index.html` in the same commit (then section D). Bump the engine version (section F) and update the pinned engine slice hash `ENGINE_SLICE_SHA256` in `scripts/check-mobile.mjs`.
2. If a hand-verified expectation is wrong, correct `vectors.json` only with the owner's approval. Never regenerate it.
3. Regenerate the golden fixture **only for an intentional engine change**, never to make a parity failure pass:
   ```powershell
   cargo run -p date-core --example gen_golden --locked -- --write
   ```
   Review the diff, then confirm with `--check`. CI runs `--check`.
4. Run the full section B list.

### F. Version-bump checklist

Since v1.1.0 there are two versions. `check-mobile.mjs`, the CI node blocks and the release loop check them separately.

**App version** (now `1.2.0`), bumped for every release. It must match in five places:

| # | Place | Field |
|---|---|---|
| 1 | `src-tauri/tauri.conf.json` | `"version"` |
| 2 | `src-tauri/Cargo.toml` | `version` (and its `Cargo.lock` entry) |
| 3 | `mobile/index.html` | `const APP_VERSION` |
| 4 | `mobile/sw.js` | `CACHE_NAME = "date-tool-v<version>-mobile-<n>"` |
| 5 | Footers and About pills | `ui/index.html` (`Desktop v…`) and `mobile/index.html` (`Mobile & Web v…`) |

Also:
- update the version literals in `ui/main.js` (smoke checks `app-version` and `footer-version`) and the `EVAL_VERSION` and `APP_VERSION` constants in `scripts/safety-eval.mjs`;
- let `Cargo.lock` refresh through a normal `cargo build`;
- recompute the mobile CSP hashes (`APP_VERSION` is inside the inline script);
- add `.github/release-notes-v<version>.md`.

**Engine version** (now `1.0.0`), changed only with a change in engine behaviour, together with `gen_golden -- --write` (section E). It must match in `crates/date-core/Cargo.toml`, `ENGINE_VERSION` (`crates/date-core/src/lib.rs`), the `golden.json` header, the `date-core:begin v…` marker, `EXPECTED_ENGINE_VERSION` in `src-tauri/src/commands.rs`, and the engine constants in `scripts/check-mobile.mjs` and `scripts/safety-eval.mjs`. An app release alone never bumps it.

### G. Commits, PRs and releases

- Follow [AGENTS.md](AGENTS.md):
  - commit messages are a plain subject plus `Why / Changed / Checks / Remaining`;
  - stage explicit paths and read the staged diff before committing;
  - unfinished work is committed as `WIP:`;
  - every commit carries the `Co-Authored-By:` trailer.
- Push `dev` after each verified milestone. Verify with `git ls-remote origin dev` against `git rev-parse HEAD`. Never force-push.
- **Release gating:**
  - A green push to `main` runs the release job. It publishes `v<version>` with the NSIS, MSI, portable exe, mobile HTML and `SHA256SUMS.txt`, and Pages deploys `mobile/`.
  - **Standing authority (owner, 2026-11-18):** "don't wait for my approval to release, I already grant it to you if you tested it and it's good". The coordinator may merge to `main` and release work that passed every check and was verified. v1.2.0 was the first release made this way.
  - Work that is not fully tested and verified still needs the owner's explicit yes. Creating repositories or changing repository settings always needs the owner.
  - Releases are immutable: to publish again, bump the version.
- **How a future release works:**
  1. On `dev`, bump the **app** version in every place in section F, plus the literals listed under "Also", and add `.github/release-notes-v<version>.md`. Leave the engine version alone unless engine behaviour changed.
  2. Run the section B checks, push `dev`, and open a PR `dev` → `main`. Its `pull_request` run cannot release.
  3. When the PR's CI is green and every check passed, merge (under the standing authority above, or with the owner's yes). The release job publishes `v<version>` with the 5 assets, and Pages redeploys `mobile/`.
  4. Verify what was published: download the assets, run `sha256sum -c`, compare the mobile asset and the live Pages files with `main`, and run the downloaded portable exe with `--smoke-test`. Record the result in the ledger.
  5. If release `v<version>` already exists (for example after a docs-only merge without a bump), the release job prints "preserving immutable tag and assets" and exits 0. It never moves or overwrites an existing tag or its assets.

---

## 10. Items That Cannot Be Transferred Automatically

1. **Per-device app data:**
   - desktop `%APPDATA%\com.datecalculator.tool\{history,settings,countdown,layout}.json` and their backups (`*.json.bak`, `history.json.bak-<ms>` and similar);
   - browser `localStorage` (`date_tool_history_v1`, `date_tool_settings_v1`, `date_tool_countdown_v1`, `date_tool_layout_v1` and their `_bak` copies);
   - installed PWA caches.

   They are never synced. Do not read, clear or export them without the owner's authority.
2. **Credentials:** run `gh auth login`, `gh auth setup-git` and set `git config user.name` / `user.email` on each machine.
3. **Local toolchains and build caches:** MSVC Build Tools, WebView2, Rust, Tauri CLI `=2.12.4` and `target/` are installed per machine.
4. **Session transcripts and review workflows:** these live in the AI tooling, not in the repository. Their results are recorded in the PBS ledger, commit messages and this document.
5. **GitHub web UI settings:** the Pages source and environment rules, and the Actions permissions, are checked in the browser by the owner.
6. **Notion project hub:** deferred by the owner on 2026-11-16 and not created.
