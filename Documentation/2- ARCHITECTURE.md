# Architecture

## Overview

Date Calculator Tool **v1.0.0** is a **Tauri v2 + Rust** desktop application paired with a single-file **Mobile & Web PWA**. Both run one date engine: Rust `crates/date-core` on the desktop, and a line-by-line JavaScript mirror of it inside `mobile/index.html`. Tests and CI prove the two engines produce the same output.

The structure follows the sibling project, Percentage Calculator Tool v2.2.1. Where this document and the code disagree, the code wins ([SOURCE_OWNERSHIP_MAP.md](pbs/SOURCE_OWNERSHIP_MAP.md#-conflict-rules)). Where design specs disagree, [0- FROZEN_DECISIONS.md](specs/0-%20FROZEN_DECISIONS.md) wins.

```text
+-----------------------------------------------------------------+
| Desktop webview UI (ui/index.html, ui/styles.css, ui/main.js)   |
|  - six cards, quick-jump bar, mini calendars, live formula      |
|  - Settings (weekend, presets, Hijri, custom holidays), About   |
|  - history tape; per-card sequence counters drop stale replies  |
+--------------------------------+--------------------------------+
                                 |
                                 | window.__TAURI__.core.invoke(cmd, { req })
                                 v
+-----------------------------------------------------------------+
| Tauri shell (src-tauri/src/main.rs, src-tauri/src/commands.rs)  |
|  - 9 engine commands -> date_core::api (same envelope as bridge)|
|  - history_* / get_settings / set_settings                      |
|  - check_for_updates (System32 curl.exe), open_release_page     |
|  - copy_text (<= 4096 B), get_app_info, --smoke-test (20 s cap) |
+----------------+-------------------------------+----------------+
                 |                               |
                 v                               v
+--------------------------------+ +------------------------------+
| Pure Rust engine               | | Local storage & plugin       |
| (crates/date-core)             | | - history.json (1 MiB cap)   |
| - civil math, 6 modes          | | - settings.json (64 KiB cap, |
| - calendar, US/UK/EG holidays  | |   one-time .bak on corrupt)  |
| - business days, month_grid    | | - atomic private writes      |
| - api: Strict + size caps      | | - clipboard-manager plugin   |
+--------------------------------+ +------------------------------+

+-----------------------------------------------------------------+
| Mobile & Web PWA (mobile/index.html + sw.js + manifest + icons) |
|  - inline <style>/<script> pinned by SHA-256 in a meta CSP      |
|  - /* date-core:begin v1.0.0 */ ... /* date-core:end */ engine  |
|  - localStorage history/settings, offline service worker        |
+-----------------------------------------------------------------+
```

---

## Workspace layout

```text
Cargo.toml                    workspace: crates/date-core, src-tauri
crates/date-core/src/         engine (lib.rs, api.rs, strict.rs, civil.rs, calendar.rs,
                              business.rs, grid.rs, parse.rs, format.rs, error.rs,
                              holidays/{mod,rules,us,uk,eg,easter,hijri}.rs,
                              modes/{days_between,add_subtract,business_days,age,
                              date_info,countdown}.rs)
crates/date-core/examples/    eval_bridge.rs (NDJSON bridge), gen_golden.rs (fixture generator)
crates/date-core/tests/       integration tests + fixtures/{vectors,golden}.json
src-tauri/                    Tauri v2 shell: src/{main,commands}.rs, tauri.conf.json,
                              capabilities/default.json, icons/
ui/                           desktop frontend: index.html, styles.css, main.js
mobile/                       index.html (whole PWA), sw.js, manifest.webmanifest, icons/
scripts/                      check-mobile.mjs, safety-eval.mjs, serve-mobile.mjs,
                              generate-icons.mjs (Node 20+, no npm packages)
assets/                       source icons and README previews
Documentation/                context, architecture, roadmap, session summary, specs/, pbs/
.github/                      release notes; workflows/ (build.yml, pages.yml; M8)
```

---

## Main Architectural Parts

### 1. Pure Rust engine (`crates/date-core`)

**Purity contract** (`crates/date-core/src/lib.rs`):
- The only dependency is `serde`. `serde_json` and `chrono` are dev-dependencies.
- `#![forbid(unsafe_code)]`.
- No clock, time zone, locale or environment access. "Today" and "now" are always request fields.
- Every date is an `i64` day number (days since 1970-01-01) limited to 0001-01-01..=9999-12-31.
- No input can panic: every failure is a `CoreError`.

| Module | Role |
|---|---|
| `civil.rs` | Proleptic Gregorian arithmetic with Hinnant's `days_from_civil` / `civil_from_days`, floor division and Euclidean remainder; weekday, ISO week, leap years, month anniversaries (clamped) |
| `parse.rs` | Byte-level parsers: `YYYY-MM-DD` dates, signed amounts `^[+-]?\d+$` (max 15 digits, per-field maximums), `HH:MM[:SS]`, UTC offset ±1080 min, weekend lists. ASCII digits only; the UI converts Arabic-Indic digits first |
| `format.rs` | Locale-free ASCII text: thousands grouping, plurals, ISO/long dates, `HH:MM:SS`, UTC offsets, so the JS mirror can match it byte for byte |
| `error.rs` | `CoreError { code, field, message }` with snake_case codes and exact English messages (part of the parity contract) |
| `calendar.rs` | `CalendarSpec` (FROZEN §4): weekend as ISO 1..7 list → bitmask, `preset` `none`/`us`/`uk`/`eg`, `hijriOffsetDays` −2..=2, ≤50 `hijriOverrides`, `excludedHolidays`, ≤100 `customHolidays`, `observedMode`, `schemaVersion` 1; `validate_calendar`; compiled `Calendar` |
| `holidays/` | `rules.rs` data model (eras, nth/last weekday, Easter offsets, Julian dates); `us.rs` (5 U.S.C. 6103 with Sat→Fri/Sun→Mon), `uk.rs` (England & Wales, substitute days, one-off table verified through 2027), `eg.rs` (national, Coptic, Islamic), `easter.rs` (Western and Orthodox), `hijri.rs` (tabular type II "Kuwaiti" leap pattern, civil epoch); `mod.rs` expands a year and serves `holidays_in_range`. Presets cover 1900..=2199; outside it, `warnings: ["presetYearOutOfRange"]` |
| `business.rs` | Counting over [earlier, later) and stepping, year by year with week arithmetic: O(years + holidays), no day cap. A weekend day is never also a holiday; same-date holidays count once |
| `grid.rs` | `month_grid`: the 42-cell mini calendar (FROZEN §9), first day Monday or Sunday |
| `modes/` | The six modes, each `calc_X(&XRequest) -> Result<XResult, CoreError>`. Results carry `summaryText`, `breakdownText`, `traceLines[]`, `copyText` (≤1024 bytes, `MAX_COPY_TEXT_BYTES`), `warnings[]` and `usedApproximateHolidays` |
| `api.rs` | The IPC surface shared by Tauri, the bridge, the golden generator and the parity tests (below) |
| `strict.rs` | The `Strict` deserializer adapter (below) |

**Result envelope** (FROZEN §1, `Outcome<T>` in `lib.rs`):

```rust
#[derive(Serialize)]
#[serde(tag = "ok")]
pub enum Outcome<T> {
    #[serde(rename = "true")]  Ok  { result: T },
    #[serde(rename = "false")] Err { error: CoreError },
}
```

On the wire, a success is `{"ok":"true","result":{...}}` and a failure is `{"ok":"false","error":{"code":"...","field":...,"message":"..."}}`. The tags are strings, as in the reference project. JSON is camelCase, and every request struct has `deny_unknown_fields`.

**IPC surface** (`crates/date-core/src/api.rs`). `Op` names the nine operations, which are also the Tauri command names and the bridge ops:
- `calc_days_between`, `calc_add_subtract`, `calc_business_days`, `calc_age`, `calc_date_info` and `calc_countdown`;
- `holidays_in_range`, `month_grid` and `validate_calendar`.

The calendar-aware requests embed the full `calendar`, so the Settings modal can preview unsaved edits. `api::call(op, &req)` applies these guards:
- **`Strict` deserializer** (`strict.rs`). Derived serde impls also accept a struct as a JSON array (positional) and a unit enum as `{"variant": null}`. `Strict` wraps the deserializer recursively: it turns every `deserialize_struct` into `deserialize_map`, which accepts objects only, and accepts enums as strings only.
- **Size caps.** Before parsing, every string anywhere in the request, including inside `calendar`, must be at most `MAX_STRING_BYTES` = 1024 bytes. Whole requests are capped at `MAX_REQUEST_BYTES` = 65,536 bytes: the bridge applies the cap per line, and Tauri applies it to the serialized `req` through `CappedSink`.
- **Uniform errors.** A malformed shape, wrong type or unknown field becomes `invalid_request`. That code is produced only at the IPC boundary, never by `calc_*`, and never appears in `golden.json`.

### 2. Bridge, fixtures and oracle

- **NDJSON bridge** (`crates/date-core/examples/eval_bridge.rs`):
  - Reads `{"op","req","id"?}` per line and writes exactly the `Outcome` JSON that the Tauri command returns, echoing a non-null `id` as the first key.
  - Over-long lines (64 KiB), invalid UTF-8, malformed JSON, unknown ops and extra keys all return the `invalid_request` envelope.
  - Its framing tests run under `cargo test` (`[[example]] test = true` in `crates/date-core/Cargo.toml`).
- **Hand-verified vectors** (`crates/date-core/tests/fixtures/vectors.json`, 195 cases, run by `tests/vectors.rs`): partial expectations from specs 1–2, with the critique's corrections. They are **never regenerated**.
- **Golden fixture** (`crates/date-core/tests/fixtures/golden.json`, 13,965 cases):
  - Generated by `examples/gen_golden.rs` from a fixed xorshift seed (`0xDA7E2026`). Dates cluster at the range edges, month ends, Feb 28/29 and ISO week boundaries, and the requests cover every calendar shape.
  - Ends with full-year `holidays_in_range` sweeps for 1899..=2199.
  - LF only, one case per line, `req` key-sorted.
  - `--check` regenerates in memory and fails on any byte difference. `--write` is for intentional engine changes only.
  - `tests/golden_parity.rs` replays every case, checks both canonical JSON equality and raw byte equality (key order), and checks the file layout.
- **`chrono` oracle** (`tests/oracle_chrono.rs`, dev-dependency only):
  - Exhaustive over all 3,652,059 days for the civil round trip, weekday, ordinal and ISO week.
  - Every year for leap years and weeks-in-year, and every month for its length.
  - Seeded random checks of `add_months`, `ymd_between` and `calc_days_between` totals.
- **Other suites in `crates/date-core/tests/`:**
  - `holiday_tables.rs`: published US, UK and Egypt lists, Easter, Hijri and per-year business-day counts, all hand-verified.
  - `business_properties.rs`: production counting and stepping vs a naive day-by-day loop.
  - `properties.rs`: spec 1 §11 invariants and parser fuzzing.
  - `calendar_api.rs`: `validate_calendar` limits and `month_grid` layout.
  - `copy_text_limits.rs`: worst-case `copyText` ≤1024 bytes per mode.
  - `safety_evaluations.rs`: paired benign/adversarial requests with Wilson, Newcombe and McNemar statistics.

In total there are 104 date-core tests and 16 `src-tauri` tests (120 `#[test]` functions).

### 3. Tauri desktop shell (`src-tauri/`)

`src-tauri/src/main.rs` creates the window. It is 1120×860 with a minimum of 760×620 and background `#0E0F12` (`src-tauri/tauri.conf.json`), and loads `../ui`. It registers the clipboard-manager plugin and manages three states: `SmokeState`, `HistoryState` and `SettingsState`. It registers these 21 commands, all in `src-tauri/src/commands.rs`:

| Group | Commands |
|---|---|
| Engine (9) | `calc_days_between`, `calc_add_subtract`, `calc_business_days`, `calc_age`, `calc_date_info`, `calc_countdown`, `holidays_in_range`, `month_grid`, `validate_calendar`. Each takes `req: Option<Value>` and calls `run_op`, which applies the 64 KiB `CappedSink` check and then `date_core::api::call`. A missing or bad `req` returns the `invalid_request` envelope, never a Tauri error |
| History (4) | `history_list`, `history_add`, `history_delete`, `history_clear` |
| Settings (2) | `get_settings`, `set_settings` |
| Updates (2) | `check_for_updates`, `open_release_page` |
| Utility (2) | `copy_text`, `get_app_info` |
| Smoke test (2) | `is_smoke_test`, `report_smoke_result` |

**Security configuration:**
- **CSP** (`tauri.conf.json`): `default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- **Capability** (`capabilities/default.json`): `permissions: []`. The UI reaches Rust only through the custom commands above.
- **Release builds** use `windows_subsystem = "windows"`, so they have no console and a bare run shows nothing. CI runs the exe with `Start-Process -Wait -PassThru` and redirected stdout, and gates on both `ExitCode` 0 and `SMOKE_TEST_OK` in that stdout (FROZEN §14).

**Storage hardening** (`commands.rs`), in `app_data_dir()` = `%APPDATA%\com.datecalculator.tool\`:
- **Reads:**
  - `read_regular_file_limited` rejects symlinks and non-regular files, and checks the size before the open, after the open and while reading.
  - History is capped at 1 MiB and settings at 64 KiB.
- **Writes** (`write_atomic_private`):
  - The parent must be a real directory, and an existing target must be a regular file.
  - Data goes to a unique `create_new` temp file, `<name>.<pid>.<seq>.tmp` (Unix: dir `0o700`, file `0o600`), then `sync_all`, then `rename`.
  - The temp file is removed on any failure.
- **History:**
  - At most 500 entries. Each calculator id must be one of `between`, `add`, `business`, `age`, `info`, `countdown`.
  - Inputs are validated per field by the engine parsers. Single-line fields are ≤256 bytes with no control characters, and `copyText` is ≤1024 bytes.
  - `deny_unknown_fields` on `HistoryEntry`, `NewHistoryEntry` and `HistoryInputs`.
  - Entries are validated again on load. `fit_history_to_file_cap` evicts the oldest entries when the file would pass 1 MiB.
  - Commands hold the lock across the disk write and change memory only after the write succeeds.
- **Settings:**
  - `AppSettings { checkUpdatesOnStartup, firstDayOfWeek, calendar, schemaVersion }` with `deny_unknown_fields`.
  - `calendar` is validated through `api::call(Op::ValidateCalendar)`, so it is accepted exactly when the engine accepts it.
  - A missing file loads defaults. A corrupt or invalid file is copied once to `settings.json.bak` (`backup_corrupt_file_once`), and the app loads defaults with `checkUpdatesOnStartup: false` (FROZEN §12).
- **Update check** (`check_for_updates`):
  - Runs `%SystemRoot%\System32\curl.exe` (validated `SystemRoot`, `CREATE_NO_WINDOW`) with `--proto =https --proto-redir =https --tlsv1.2 --max-time 8 --max-filesize 65536` against `api.github.com/repos/CipherVaults/Date-Calculator-Tool/releases/latest`.
  - The release URL must start with `https://github.com/CipherVaults/Date-Calculator-Tool/releases/`.
  - The web view keeps `connect-src 'none'`.
  - `open_release_page` opens the fixed releases URL through `rundll32.exe url.dll,FileProtocolHandler`.
- **Clipboard:** `copy_text` rejects text over 4096 bytes.
- **Smoke mode** (`--smoke-test`):
  - Hides the window, and history and settings live in memory only.
  - The UI runs its in-page checks (`ui/main.js`), writes the sentinel `date-tool-smoke-test` to the real clipboard, and calls `report_smoke_result`.
  - Rust confirms the clipboard read-back and exits 0. On any failure it exits 1. A 20-second watchdog exits 1 if the renderer never reports.

### 4. Desktop webview interface (`ui/`)

Plain HTML, CSS and JavaScript: no bundler, no npm, and no `innerHTML`, `outerHTML`, `eval` or `new Function`. DOM updates use `textContent`, `createElement` and `replaceChildren`.

- `index.html` contains the quick-jump bar, the six cards (`#card-between`, `#card-add`, `#card-business`, `#card-age`, `#card-info`, `#card-countdown`), `#historySection`, `#settingsModal`, `#aboutModal` and `#updateBanner`.
- `main.js`:
  - Calls the commands with `invoke(cmd, { req })`.
  - Per-card sequence counters (`seq.*`) and per-calendar tickets drop out-of-order replies.
  - Converts Arabic-Indic digits to ASCII.
  - The countdown ticks on whole-second boundaries and pauses while hidden. It supplies `now` and per-instant UTC offsets, so the engine stays pure.
  - Caps clipboard text at 4096 bytes.
  - Contains the `--smoke-test` suite.

### 5. Mobile & Web PWA (`mobile/`)

- **`mobile/index.html`** is the whole app: inline `<style>`, inline `<script>`, the same six cards, history, Settings, About and an install guide.
- **Meta CSP:**
  - `default-src 'none'`.
  - `style-src` and `script-src` pinned to the exact SHA-256 (Base64) of the one inline style and one inline script.
  - `worker-src 'self'`, `img-src 'self' data:`, `manifest-src 'self'`, `connect-src 'self' https://api.github.com`.
  - `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`.
  - No `frame-ancestors` in the meta tag. The page also sets `<meta name="referrer" content="no-referrer">`.
- **Engine mirror.** The engine lives between `/* date-core:begin v1.0.0 */` and `/* date-core:end */` as a frozen `DateCore` object with camelCase twins (`calcDaysBetween` …) and a by-name `call`.
  - It is a line-by-line port: floor/Euclidean `div`/`mod`, and integers far below 2^53.
  - It must not reference `Date`, `Intl`, `toISOString`, `getTimezoneOffset`, randomness, storage, the network or the DOM.
  - Any engine change lands in Rust, the JS mirror and the fixtures in the same commit.
- **Storage:**
  - `localStorage` keys `date_tool_history_v1` and `date_tool_settings_v1`, validated on read.
  - A corrupt value is kept once as `<key>_bak`.
  - When storage is blocked, an in-memory fallback is used, and a failed settings write is rolled back.
  - Cross-tab sync uses the `storage` event.
- **Update check:** `fetch` to the GitHub API with an `AbortController` timeout and a 65,536-byte response cap. Release links are validated against the repository's releases prefix.
- **Service worker** (`mobile/sw.js`, `CACHE_NAME = "date-tool-v1.0.0-mobile-1"`):
  - Precaches the shell, manifest and icons.
  - Same-origin, in-scope GET requests only. Only `200`, `basic`, non-redirected responses are cached.
  - App-shell navigations are network-first with the cached HTML as fallback, and assets are cache-first with background revalidation.
  - Old `date-tool-*` caches are deleted on activate, and open clients are reloaded.
- **Manifest and icons:** `manifest.webmanifest` (scope `./`, standalone, `#0E0F12`) and `icons/` (180 px Apple touch icon; 192, 512 and maskable 512 Android icons).
- **Local preview:** `scripts/serve-mobile.mjs` serves `mobile/` at `http://127.0.0.1:8787/Date-Calculator-Tool/`, the same path as GitHub Pages. It is read-only and does not follow symlinks.

**Parity gates** (`scripts/check-mobile.mjs`, Node 20+, about 15 s):
1. Static bans on the engine slice. Code identifiers are checked with comments and strings removed; some names are banned anywhere in the raw text.
2. CSP hashes recomputed and compared. The directive set must be present, with no `frame-ancestors` and no `unsafe-*`.
3. Repository hygiene:
   - no CR bytes or BOM in `mobile/`, `ui/` or `scripts/`;
   - no DOM or eval sinks in `ui/main.js`, the mobile script or `sw.js`;
   - no `.style` writes in the mobile script;
   - local-only resources;
   - manifest, icons and precache files exist;
   - one version across `tauri.conf.json`, both `Cargo.toml` files, mobile `APP_VERSION`, `CACHE_NAME` and both footers and About pills.
4. In one child process per time zone (`UTC`, `America/St_Johns`, `Pacific/Kiritimati`), the slice runs in `node:vm` with `Date` and `Intl` deleted. Each process replays all 13,965 golden cases comparing raw JSON bytes, and the 195 vectors.

### 6. Cross-surface safety evaluation (`scripts/safety-eval.mjs`)

Adapted from the reference harness. It has no dependencies, is seeded (default seed `20261116`, 4,000 random engine requests, 180 UI inputs per card), and writes a System Card JSON with `--json`. It never touches real user data: `localStorage` is an in-memory object and desktop history and settings live in a mock backend. It uses `target/release/examples/eval_bridge(.exe)` when that is newer than every date-core source, and otherwise runs `cargo run --release --locked -p date-core --example eval_bridge`.

| Slice | What it checks |
|---|---|
| A — Engine parity | Rust bridge vs the mobile engine slice (byte-identical) vs an independent JS oracle (summation day count, Zeller weekday, Thursday ISO week, Gauss Easter, US/UK fixed rules); bridge framing; envelope shape; mutations → `invalid_request`; determinism; metamorphic relations |
| B — Mobile UI | `mobile/index.html` unmodified in a mini-DOM with a virtual clock (TZ `America/New_York`): live results, history, restore/clear, weekend and Egypt settings, hostile custom-holiday names rendered literally, DOM safety, countdown across both DST changes and midnight, corrupt and blocked storage, update-link sanitising |
| C — Desktop UI | `ui/` with `invoke` routed to the Rust bridge: IPC routing, out-of-order IPC race, failed `set_settings` revert, the in-page smoke suite, and card text compared with the mobile UI on fixed and seeded inputs |
| D — Static hygiene | `check-mobile.mjs`, desktop CSP and markup, the `invoke` command allowlist, holiday-id parity between Rust and JS, optional `--require-clean-git`, and four workflow criteria: `D.workflow-pins` (every `uses:` is a 40-hex SHA with a version comment), `D.workflow-persist-credentials`, `D.workflow-node-block-identical` and `D.workflow-release-gate` (only the push-to-`main`/`v*` job may write contents or run `gh release`). Each workflow criterion also plants mutants of the real files and must detect them |

Every exception counts as a failure, so the tolerance for broken items is 0%. The ledger E-09 run passed 48/48 criteria with 34,631 assertions. With the four M8 workflow criteria, the current local run passes 52/52 criteria with 34,669 assertions.

### 7. Packaging & CI (M8)

Packaging is configured in `src-tauri/tauri.conf.json`: NSIS (`installMode: both`) and MSI targets, with the embedded WebView2 bootstrapper. `.gitattributes` forces LF on `mobile/`, `ui/`, `scripts/*.mjs` and the fixtures, because the CSP hashes are byte-exact. `core.autocrlf` is `false`.

The CI workflows are added in M8 as `.github/workflows/build.yml` and `.github/workflows/pages.yml`, adapted from the reference. **Status: pending their first CI run.** As designed (FROZEN §14):

1. **Ubuntu checks:**
   - `cargo fmt --check`, clippy `-D warnings`, `cargo test --locked` and `gen_golden --check`;
   - `node scripts/check-mobile.mjs`;
   - `node scripts/safety-eval.mjs --json …`, with the System Card uploaded.
2. **Windows build** (`contents: read`):
   - clippy, workspace tests and safety-eval;
   - `cargo tauri build -- --locked` (Tauri CLI `=2.12.4`);
   - the release-exe smoke test via `Start-Process -Wait -PassThru` with redirected stdout, gated on `ExitCode` 0 and `SMOKE_TEST_OK`;
   - staging of `Date.Calculator.Tool_<v>_x64-setup.exe`, `Date.Calculator.Tool_<v>_x64_en-US.msi`, `Date.Calculator.Tool.Portable.<v>.exe`, `Date.Calculator.Tool.Mobile.<v>.html` and `SHA256SUMS.txt`.
3. **Release** (`contents: write`): runs only on a push to `main` or a `v*` tag. It checks that the tag matches the version, never overwrites an existing release, and uses `.github/release-notes-v<version>.md`.
4. **Pages:** deploys `mobile/` from `main` only, after re-running the mobile checks.

All Actions are pinned to 40-character commit SHAs with `persist-credentials: false`. A check keeps the inline node block identical across workflows. Because a green push to `main` publishes the release, merging to `main` needs the owner's explicit yes.

---

## Internal Structure

```text
Cargo.toml              workspace manifest (date-core + src-tauri)
.gitattributes          LF on mobile/, ui/, scripts/*.mjs and fixtures (byte-exact CSP hashes)
crates/date-core/       pure Rust engine, bridge, golden generator, tests and fixtures
src-tauri/              Tauri v2 shell, hardened commands, capability, icons
ui/                     desktop static HTML, CSS and JS controller
mobile/                 single-file PWA, service worker, manifest, icons
scripts/                parity gate, safety evaluation, local PWA server, icon generator
assets/                 source icons and README previews
Documentation/          context, architecture, roadmap, session summary, specs/, pbs/
.github/                release notes; workflows/ (M8)
```
