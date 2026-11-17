# Date Calculator Tool Desktop & Mobile v1.0.0

**v1.0.0** is the first release of **Date Calculator Tool**: an offline date calculator for **Windows** (Tauri v2 + Rust) and a single-file **Mobile & Web PWA** for iPhone and Android. Both editions run the same date engine. CI checks that the Rust engine and its JavaScript copy give byte-identical output on all 13,965 golden test cases.

- **Mobile & Web PWA (iPhone Safari and Android Chrome):** https://ciphervaults.github.io/Date-Calculator-Tool/

It is a sibling of [Percentage Calculator Tool](https://github.com/CipherVaults/Percentage-Calculator-Tool) v2.2.1 and reuses that project's architecture, security hardening and dark-terminal design.

## What's in v1.0.0

- **Six calculators** (desktop and mobile):
  - **Days Between Two Dates:** years, months, weeks and days, totals in days, weeks, hours, minutes and seconds, swap, and "include the later date (+1 day)".
  - **Add / Subtract from a Date:** ± years, months, weeks and days. Month ends clamp (Jan 31 + 1 month = Feb 28 or 29). An optional business-day mode moves years and months on the calendar first, then counts weeks as working weeks and days as working days.
  - **Business Days:** working days between two dates, skipping the weekend and holidays, and listing the holidays it hit. The earlier date counts; the later date counts only when "include the later date" is on.
  - **Age:** exact age in years, months and days, totals, and the next birthday. Feb 29 birthdays count on Feb 28 (default) or Mar 1.
  - **Date Info:** weekday, ISO week, day of year, quarter, leap year, and days left in the month and year.
  - **Countdown:** a live countdown to a date and optional time, correct across daylight-saving changes.
- **Weekends and holidays:**
  - Weekend: Sat/Sun (default), Fri/Sat, Fri only, or any custom set of days.
  - **United States:** the 11 federal holidays with Saturday→Friday and Sunday→Monday observed days.
  - **United Kingdom (England & Wales):** bank holidays, Easter, substitute days and one-off royal holidays.
  - **Egypt:** national days, Coptic Christmas, Coptic Easter and Sham el-Nessim, plus Islamic holidays estimated from the tabular Hijri calendar. These are marked "estimated" and have a ±2-day offset and per-year overrides. Choosing Egypt switches the weekend to Fri/Sat.
  - **Custom holidays** (one-off or yearly, up to 100) and per-holiday exclusions for every preset.
  - Holiday rules cover 1900–2199. Outside that range the weekend still applies and the result carries a warning.
- **Mini calendars** on the Business Days, Date Info and Countdown cards show weekends, holidays and the selected range.
- **History:** up to 500 entries with filter, copy, restore and delete. Custom holiday names are never stored in history.
- **Live formula panel:** each card shows how its result was worked out, step by step.
- **Settings and About:** weekend, holiday preset, Hijri offset and overrides, custom holidays, first day of the week, and an optional startup update check against GitHub Releases.
- **Mobile & Web PWA:** one HTML file that installs to the home screen and works offline. It has safe-area insets, 16 px inputs on iOS (so Safari does not zoom) and an install guide.

## Downloads & integrity verification

| Package | File | Description |
| --- | --- | --- |
| **NSIS setup installer** | `Date.Calculator.Tool_1.0.0_x64-setup.exe` | Recommended Windows installer (per-user or per-machine; includes the WebView2 bootstrapper) |
| **MSI installer** | `Date.Calculator.Tool_1.0.0_x64_en-US.msi` | Windows Installer package |
| **Portable executable** | `Date.Calculator.Tool.Portable.1.0.0.exe` | Single-file Windows executable, no install (needs the WebView2 runtime, preinstalled on Windows 10/11) |
| **Standalone mobile HTML** | `Date.Calculator.Tool.Mobile.1.0.0.html` | The whole Mobile & Web app as one offline HTML file |
| **SHA-256 checksums** | `SHA256SUMS.txt` | Checksums for the four files above |

Verify a download in PowerShell before opening it:

```powershell
Get-FileHash .\Date.Calculator.Tool_1.0.0_x64-setup.exe -Algorithm SHA256
# Compare the hash (case-insensitive) with the matching line in SHA256SUMS.txt
```

On Linux or macOS, with the files in one folder: `sha256sum -c --ignore-missing SHA256SUMS.txt` (macOS: `shasum -a 256 -c --ignore-missing SHA256SUMS.txt`).

> **Windows SmartScreen:** the Windows binaries are not code-signed, so SmartScreen may warn on first run. Check the file against `SHA256SUMS.txt` first.

## How it was verified

- **Engine (`crates/date-core`):** every day from 0001-01-01 to 9999-12-31 (3,652,059 days) is checked against the `chrono` library. The suite also runs 195 hand-verified vectors, the published US, UK and Egypt holiday tables, business-day properties against a day-by-day loop, and adversarial safety cases.
- **Parity:** the 13,965-case `golden.json` is replayed through the Rust API and through the mobile JavaScript engine. The mobile replay runs under three time zones with `Date` and `Intl` removed, and compares raw bytes.
- **Desktop:** a `--smoke-test` run opens the real app window hidden, keeps history and settings in memory, runs more than 40 checks inside the web view (calculators, history, settings, About, real clipboard), and exits 0 or 1.
- **Cross-surface safety evaluation** (`scripts/safety-eval.mjs`): Rust engine vs mobile engine vs an independent JavaScript oracle, the mobile and desktop UIs in a mini-DOM, and static hygiene. Before release: 52/52 criteria, 34,669 assertions.

## Honest limitations

- **Islamic holidays are estimates.** Real dates follow moon sighting and official announcements and can differ by 1–2 days. Use the offset or per-year overrides to match the official dates.
- **Egypt moves some holidays by decree** (for example to a Thursday). Those moves are not modelled; use exclusions and custom holidays instead.
- **UK one-off bank holidays** (royal events and similar) are included through 2027. Later ones need an app update.
- **Month ends clamp, so adding and subtracting does not always round-trip:** Jan 31 + 1 month − 1 month = Jan 28.
- **Leaving the Egypt preset keeps the Fri/Sat weekend.** Change the weekend in Settings if you need Sat/Sun again.
- **Unsigned Windows binaries:** see the SmartScreen note above.
- **GitHub Pages cannot send framing headers** (`frame-ancestors`, `X-Frame-Options`). Open or install the PWA only from `https://ciphervaults.github.io/Date-Calculator-Tool/`.
- **Not tested on a physical phone before release.** The PWA was checked at 375 px in a desktop browser with its service worker active; installing on a real iPhone or Android device is an owner check.

## Security notes

- **No accounts, telemetry, cookies or tracking.** Calculations make no network calls. The only network use is the optional GitHub Releases update check, which can be turned off in Settings.
- **Desktop:**
  - CSP `default-src 'self'; connect-src 'none'` with no inline script or style.
  - Tauri capability with `permissions: []`.
  - The update check runs in Rust through `System32\curl.exe` (HTTPS only, 8 s timeout, 64 KiB cap), so the web view itself never goes online.
  - History and settings in `%APPDATA%\com.datecalculator.tool\` use size caps, symlink rejection, atomic writes and strict schemas. A corrupt `settings.json` is kept once as `settings.json.bak`, and the app falls back to defaults with update checks off.
- **Mobile:**
  - CSP pinned to the SHA-256 hashes of the inline style and script.
  - `no-referrer`.
  - A same-origin, scope-checked service worker.
  - Validated `localStorage`, with a one-time `_bak` copy of corrupt data.
- **Code:**
  - No `innerHTML`, `outerHTML`, `eval` or `new Function` anywhere.
  - The engine is pure Rust (`#![forbid(unsafe_code)]`, no clock or time-zone access, no panics on any input). Every request string is capped at 1024 bytes and every request at 64 KiB.
- **CI:** Actions are pinned to commit SHAs with `persist-credentials: false`, builds use `--locked`, and releases ship `SHA256SUMS.txt`.

## Credits

Made by **Mohamed Sayed · Ahmed Emara**, built with **Claude (Anthropic)**.

All rights reserved (UNLICENSED). The source is public for transparency and review; no open-source license is granted.
