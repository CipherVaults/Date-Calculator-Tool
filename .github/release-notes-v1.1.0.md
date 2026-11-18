# Date Calculator Tool Desktop & Mobile v1.1.0

**v1.1.0** makes the mini calendars clickable, remembers your countdown across restarts, and makes sure an unreadable history file is never overwritten. It updates both editions: **Windows** (Tauri v2 + Rust) and the single-file **Mobile & Web PWA** for iPhone and Android.

- **Mobile & Web PWA (iPhone Safari and Android Chrome):** https://ciphervaults.github.io/Date-Calculator-Tool/

The date engine is unchanged: it is still **engine v1.0.0**, with the same 13,965 golden cases. Only the app around it moved to 1.1.0.

## What's new in v1.1.0

- **Clickable mini calendars** on the Business Days, Date Info and Countdown cards:
  - **Date Info** and **Countdown:** click a day to set the date. On Countdown the time you entered is kept, and a past day shows the finished state.
  - **Business Days:** a "Calendar click sets" switch chooses whether the next click sets the start or the end date, and a hint says which one is next. After each pick it moves to the other end. Shift+click always sets the end date. Focusing a date field selects the matching side. Typing a start date while the end is empty moves the next click to the end, so a tap never overwrites the date you just typed.
  - The calendar view follows your click, and a new **Today** button jumps the view back to the current month without changing your dates.
  - Clicking a day from the next or previous month selects it and moves the view to that month. Days outside 0001–9999 are disabled.
  - Start, end and selected days are marked from your field values, so they always match what you typed.
  - **Keyboard support:** Tab reaches one day per calendar. Arrow keys move by a day or a week, Home/End go to the start or end of the week, PageUp/PageDown move a month (with Shift, a year), and Enter or Space selects. Moving focus never changes a date.
  - On phones every day is a 44 px touch target, and today keeps its ring when it is also a holiday.
- **Countdown remembered across restarts:**
  - The countdown target is saved on this device when you commit a date (change, quick pills, calendar click, history restore). A note under the card says "Saved on this device. It resumes when you reopen the app." and has a **Forget** button. The card's own clear button also forgets it; the header "clear all" button only empties the fields and keeps the saved countdown. If a save fails, the note says "The countdown could not be saved on this device." instead, and on mobile a browser that does not keep site data shows "Kept for this session only."
  - Clearing a date segment while you type never deletes the saved countdown.
  - When you reopen the app, a phase chip and status line show what happened:
    - **restored:** "Countdown restored: *N* left until *when*." with the exact time left on the first render, no blank flash; from the next second it reads "counting down";
    - **finished:** the target passed while the app was open;
    - **finished while closed:** the target passed while the app was closed.
  - The target is local wall-clock time, like an alarm. If you move to another time zone, it is re-read in the new zone when the app opens.
  - A countdown saved by a newer version of the app is left alone and never overwritten or removed. On desktop a `countdown.json` over the 1 KiB cap is moved aside whole (to `countdown.json.bak`, or a fresh `countdown.json.bak-<time>` if that name is taken) so the countdown works again.
  - On mobile, other open tabs follow a change or a Forget without writing over it.
- **History safety:**
  - If the history file cannot be read safely (locked, too large, a symlink, damaged, or from a newer version), the app no longer starts an empty history that would overwrite it on the next save.
  - Instead history becomes **read-only** and a banner says so. **Retry** reads the file again. **Start a new history** asks you to confirm, keeps the old file, and starts empty. The old file goes to `history.json.bak`, or to a fresh `history.json.bak-<time>` when a different backup is already there; it is only skipped when `history.json.bak` already holds the same bytes. On mobile the same applies to `date_tool_history_v1_bak` and `date_tool_history_v1_bak_<time>`.
  - A damaged file is copied to `history.json.bak` once, before anything else happens. On mobile the same applies to `date_tool_history_v1_bak`.

## Downloads & integrity verification

| Package | File | Description |
| --- | --- | --- |
| **NSIS setup installer** | `Date.Calculator.Tool_1.1.0_x64-setup.exe` | Recommended Windows installer (per-user or per-machine; includes the WebView2 bootstrapper) |
| **MSI installer** | `Date.Calculator.Tool_1.1.0_x64_en-US.msi` | Windows Installer package |
| **Portable executable** | `Date.Calculator.Tool.Portable.1.1.0.exe` | Single-file Windows executable, no install (needs the WebView2 runtime, preinstalled on Windows 10/11) |
| **Standalone mobile HTML** | `Date.Calculator.Tool.Mobile.1.1.0.html` | The whole Mobile & Web app as one offline HTML file |
| **SHA-256 checksums** | `SHA256SUMS.txt` | Checksums for the four files above |

Verify a download in PowerShell before opening it:

```powershell
Get-FileHash .\Date.Calculator.Tool_1.1.0_x64-setup.exe -Algorithm SHA256
# Compare the hash (case-insensitive) with the matching line in SHA256SUMS.txt
```

On Linux or macOS, with the files in one folder: `sha256sum -c --ignore-missing SHA256SUMS.txt` (macOS: `shasum -a 256 -c --ignore-missing SHA256SUMS.txt`).

> **Windows SmartScreen:** the Windows binaries are not code-signed, so SmartScreen may warn on first run. Check the file against `SHA256SUMS.txt` first.

**Updating from v1.0.0:** install over the old version, or replace the portable `.exe`. Your history and settings in `%APPDATA%\com.datecalculator.tool\` are kept. The PWA updates itself on the next visit (new cache `date-tool-v1.1.0-mobile-1`); your saved data in the browser is kept.

## Versions

- **App:** 1.1.0 (installers, portable `.exe`, mobile `APP_VERSION`, footers).
- **Engine:** `date-core` 1.0.0, unchanged. The app and engine versions are now tracked separately. CI checks the app version in one set of places and the engine version (`date-core` `Cargo.toml`, `ENGINE_VERSION`, the `golden.json` header and the mobile engine marker) in another. The mobile engine copy is also pinned by the SHA-256 of its exact bytes, so it cannot change without an engine version bump.

## Honest limitations

- All v1.0.0 limitations still apply: Islamic holidays are estimates, Egypt decree moves are not modelled, UK one-off bank holidays are included through 2027, month ends clamp, the Windows binaries are unsigned, and GitHub Pages cannot send framing headers.
- **One saved countdown per device.** On desktop, if two windows save at the same time, the last save wins.
- **A countdown target is local time.** It is not pinned to the time zone it was set in.

## Security notes

- Nothing new goes online. The countdown is stored only on this device: `%APPDATA%\com.datecalculator.tool\countdown.json` on desktop (1 KiB cap, strict schema, symlink rejection, atomic writes, a one-time `countdown.json.bak` if it is damaged), and `localStorage` key `date_tool_countdown_v1` on mobile.
- History is never overwritten after a failed read; a damaged file is backed up once before anything else.
- New desktop commands (`countdown_load`, `countdown_save`, `countdown_clear`, `history_state`, `history_retry`, `history_reset`) take strictly validated input. The Tauri capability still grants `permissions: []`.
- The calendars use real buttons with one delegated listener per grid; there is still no `innerHTML`, `eval` or `new Function` anywhere. The mobile CSP is re-pinned to the new inline style and script hashes.

## Credits

Made by **Mohamed Sayed · Ahmed Emara**, built with **Claude (Anthropic)**.

All rights reserved (UNLICENSED). The source is public for transparency and review; no open-source license is granted.
