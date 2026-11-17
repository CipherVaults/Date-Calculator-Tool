# Project Context

## Project Name

Date Calculator Tool (Desktop & Mobile)

---

## Project Purpose

The purpose of this project is to build a small, private, offline date calculator for Windows and phones that gives the same answer on every platform.

The app should:

- work fully offline, with no accounts, telemetry or cloud
- cover what the common online date calculators do, with more modes and real holiday rules
- keep the dark-terminal design of its sibling, Percentage Calculator Tool
- install on Windows (NSIS or MSI), run as a portable `.exe`, and install as a PWA on iPhone and Android
- be honest about the limits of holiday data instead of guessing silently
- be documented clearly enough to be picked up again later

It is a personal utility, not a commercial product.

---

## Final Core Idea

The app is a thin interface around one pure date engine:

```text
User input (HTML/JS card)
-> Tauri command IPC (desktop) or the in-page JS engine copy (mobile)
-> date-core: pure Rust engine (desktop) / its line-by-line JS mirror (mobile)
-> {"ok":"true","result":{...}} or {"ok":"false","error":{...}}
-> live result, "live formula" trace, mini calendar, optional copy and history
```

The main design decision is to keep **all** date and holiday logic in one engine (`crates/date-core`), copy it line by line into the mobile page, and prove the two identical in CI, instead of keeping two independent implementations.

The project mirrors [Percentage Calculator Tool](https://github.com/CipherVaults/Percentage-Calculator-Tool) v2.2.1 on purpose: the same Tauri v2 + Rust split, hardened storage, CSP setup, single-file PWA, safety-eval harness and CI shape.

---

## Final Scope Definition

### Included in the current version (v1.0.0)

- Cargo workspace with a pure engine crate (`crates/date-core`) and a Tauri v2 desktop shell (`src-tauri`)
- Windows native title bar; window 1120×860, minimum 760×620, background `#0E0F12` (`src-tauri/tauri.conf.json`)
- six calculator cards (FROZEN owner decisions):
  1. Days Between Two Dates
  2. Add / Subtract from a Date, with a business-day option
  3. Business Days
  4. Age, with the next birthday
  5. Date Info
  6. Live Countdown
- configurable weekend (Sat/Sun, Fri/Sat, Fri only, custom) and holiday presets for the US (federal), UK (England & Wales) and Egypt, plus custom holidays and per-holiday exclusions (`crates/date-core/src/calendar.rs`, `crates/date-core/src/holidays/`)
- Egypt Islamic holidays from the tabular Hijri calendar, marked "estimated", with a −2..+2 day offset and up to 50 per-year overrides
- 42-cell mini calendars on the Business Days, Date Info and Countdown cards, built by the engine's `month_grid`
- "live formula" panel (`traceLines`) and copy buttons on every card
- quick-jump navigation bar, Enter-to-calculate, swap buttons, dark Settings and About modals
- persistent local history: up to 500 entries with filter, copy, restore and delete
  - desktop: `%APPDATA%\com.datecalculator.tool\history.json`
  - mobile: `localStorage` key `date_tool_history_v1`
- persistent settings including the calendar
  - desktop: `settings.json`, max 64 KiB
  - mobile: `date_tool_settings_v1`
  - a corrupt file is kept once as `.bak` / `_bak`, then defaults load with update checks off
- optional GitHub Releases update check
  - desktop: in Rust via `System32\curl.exe`
  - mobile: `fetch` to `api.github.com`
- strict CSPs on both editions, `permissions: []` on the desktop capability, no `innerHTML`-style sinks
- single-file Mobile & Web PWA (`mobile/`) with a service worker and manifest, served at `https://ciphervaults.github.io/Date-Calculator-Tool/`
- tests:
  - engine unit tests;
  - the `chrono` oracle over every day in range;
  - 195 hand-verified vectors;
  - holiday tables;
  - business-day properties;
  - copy-text limits;
  - adversarial safety cases;
  - the 13,965-case golden parity fixture;
  - 16 backend tests;
  - a real-window `--smoke-test`
- Node checks with no dependencies (`scripts/check-mobile.mjs`, `scripts/safety-eval.mjs`)
- Windows NSIS and MSI installers, a portable `.exe`, the standalone mobile HTML and `SHA256SUMS.txt`, produced by CI and published as the GitHub Release `v1.0.0` on 2026-11-17
- PBS continuity records under `Documentation/pbs/`

---

### Calculation types

| Card | Engine entry point | What it answers |
|---|---|---|
| Days Between | `calc_days_between` | y/m/w/d breakdown, totals in days/weeks/hours/minutes/seconds, include-end toggle, direction |
| Add / Subtract | `calc_add_subtract` | date ± years/months/weeks/days; month ends clamp; business mode steps years and months on the calendar, then business weeks, then business days |
| Business Days | `calc_business_days` | working days over [earlier, later), with the later date optional; holidays hit (copy text capped at 10 plus "and n more") |
| Age | `calc_age` | exact age, totals, next birthday; Feb 29 rule `feb28` (default) or `mar1` |
| Date Info | `calc_date_info` | weekday, ISO week, day of year, quarter, leap year, days left in month and year |
| Countdown | `calc_countdown` | time left to a target date and time, using the UTC offset of each instant (DST-correct) |

Supporting entry points: `holidays_in_range`, `month_grid` and `validate_calendar`.

All dates are proleptic Gregorian, 0001-01-01 to 9999-12-31. Holiday presets cover 1900–2199.

---

## What Is Not Included

The project intentionally does not include:

- user accounts, cloud sync, telemetry or analytics
- network calls for calculations (only the optional update check goes online)
- silent auto-updates (the app only links to GitHub Releases)
- time-zone conversion, or time-of-day arithmetic outside the Countdown
- holiday presets other than US, UK (England & Wales) and Egypt; Scotland and Northern Ireland bank holidays
- Egyptian holidays moved by cabinet decree, and observed Islamic dates (only tabular estimates plus user overrides)
- US Inauguration Day and ad-hoc executive-order closures (users can add them as custom holidays)
- paid code signing
- a frontend framework, bundler or npm runtime dependencies
- native App Store / Play Store apps (the PWA covers phones)
- macOS or Linux installers (the code is portable; releases target Windows and the web)
- a light theme (backlog in [3- ROADMAP.md](3-%20ROADMAP.md))

---

## Development Philosophy

- one engine, proven identical on every platform
- "today" and "now" are inputs, never read inside the engine
- honest limits over silent guesses ("estimated" labels, out-of-range warnings)
- defence-in-depth defaults over implicit trust
- hand-verified fixtures are never regenerated to make code pass
- document the real work, not an idealized version
- use Git commits (Why / Changed / Checks / Remaining) as part of the project memory

---

## Success Criteria

The project is successful if:

- the six calculators give the documented answers, and every hand-verified vector passes
- the desktop engine and the mobile engine produce byte-identical JSON for every golden case, in any time zone
- holidays match the published US, UK and Egypt tables in the test suite
- history, settings, copy, update check and the mini calendars work on both editions
- the security controls in [SECURITY_HARDENING_DOSSIER.md](pbs/SECURITY_HARDENING_DOSSIER.md) hold and are checked automatically
- CI builds the Windows installers, portable `.exe`, mobile HTML and checksums, and deploys the PWA from `main`
- the documentation and Git history explain what was built and why

---

## Current Final State

At **v1.0.0 (released 2026-11-17)** the project is:

- implemented as a Cargo workspace (`date-core` + `src-tauri`) with a static `ui/` frontend and a single-file `mobile/` PWA
- verified locally on 2026-11-17 (ledger E-09):
  - fmt, clippy `-D warnings` and `cargo test --workspace --locked` (120 tests; the `chrono` oracle covers 3,652,059 days);
  - `gen_golden --check`;
  - debug `--smoke-test`;
  - `check-mobile.mjs`: 13,965/13,965 golden cases × 3 time zones;
  - `safety-eval.mjs`: 48/48 criteria at E-09; 52/52 criteria and 34,669 assertions with the four M8 workflow criteria
- pushed on `dev` of the public repository `CipherVaults/Date-Calculator-Tool`
- M8 done 2026-11-17 (ledger E-12): PR #1 `dev` → `main` with green CI on Ubuntu and Windows; CI found one defect (`SHA256SUMS.txt` written with CRLF), fixed in `9c06553`
- M9 done 2026-11-17 (ledger E-13), with the owner's authorization to merge:
  - PR #1 merged as `5a512a3` on `main`;
  - GitHub Release `v1.0.0` published with 5 assets; the downloaded files match `SHA256SUMS.txt`, and the downloaded portable exe passed `--smoke-test`;
  - the PWA is live on GitHub Pages, byte-identical to `mobile/`, with its service worker active
- still open (not verified): installing the PWA on a real phone, running the installers on a clean machine, the Egypt-preset weekend check, and the owner's acceptance of v1.0.0. The Windows binaries are unsigned.
