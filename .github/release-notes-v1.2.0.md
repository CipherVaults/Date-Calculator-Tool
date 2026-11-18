# Date Calculator Tool Desktop & Mobile v1.2.0

**v1.2.0** lets you collapse the cards you do not need and put the rest in the order you like, and it remembers that layout on this device. It updates both editions: **Windows** (Tauri v2 + Rust) and the single-file **Mobile & Web PWA** for iPhone and Android.

- **Mobile & Web PWA (iPhone Safari and Android Chrome):** https://ciphervaults.github.io/Date-Calculator-Tool/

The date engine is unchanged: it is still **engine v1.0.0**, with the same 13,965 golden cases. Only the app around it moved to 1.2.0.

## What's new in v1.2.0

- **Collapsible cards.** Every card header has a `[ − ]` button. A collapsed card shows only its title row, so it takes almost no scroll space; `[ + ]` opens it again.
  - Hidden inputs keep their values, and their results keep updating while the card is collapsed.
  - The Countdown keeps counting from the real time, so expanding it shows the right value straight away.
- **Reorderable cards.** Every card header has a `⠿` handle.
  - Drag it with a mouse, a pen or a finger. Only the handle starts a drag, so the page still scrolls normally everywhere else.
  - A gold line shows where the card will land, and holding near the top or bottom edge scrolls the page.
  - **Keyboard:** focus the handle and press ArrowUp or ArrowDown to move the card one place. A screen-reader status says, for example, "Moved Business Days to position 2 of 6."
  - **Tap the handle** (or press Enter on it) to open a small **Move up / Move down / Done** menu. This is the easy way on a phone, and it works with VoiceOver and TalkBack. At the top or bottom, the button that cannot move is shown as unavailable.
  - On touch screens a drag starts only after a deliberate movement, so a slightly shaky tap never moves a card by accident.
  - The quick-nav pills follow the card order.
- **Your layout is remembered** on this device: the card order and which cards are collapsed come back when you reopen the app.
- **Opening a collapsed card expands it** (and saves that): from its quick-nav pill, from a history restore, or from an Edit-calendar link.
- **Reset in Settings.** Settings → Layout → **Reset card order & expand all** restores the default order (Days Between Two Dates, Add / Subtract, Business Days, Age, Date Info, Countdown) and expands every card.
- **Phone-first:** the handle and the collapse button are 44 × 44 px touch targets on touch screens. With reduced motion turned on, there are no transitions.

## Downloads & integrity verification

| Package | File | Description |
| --- | --- | --- |
| **NSIS setup installer** | `Date.Calculator.Tool_1.2.0_x64-setup.exe` | Recommended Windows installer (per-user or per-machine; includes the WebView2 bootstrapper) |
| **MSI installer** | `Date.Calculator.Tool_1.2.0_x64_en-US.msi` | Windows Installer package |
| **Portable executable** | `Date.Calculator.Tool.Portable.1.2.0.exe` | Single-file Windows executable, no install (needs the WebView2 runtime, preinstalled on Windows 10/11) |
| **Standalone mobile HTML** | `Date.Calculator.Tool.Mobile.1.2.0.html` | The whole Mobile & Web app as one offline HTML file |
| **SHA-256 checksums** | `SHA256SUMS.txt` | Checksums for the four files above |

Verify a download in PowerShell before opening it:

```powershell
Get-FileHash .\Date.Calculator.Tool_1.2.0_x64-setup.exe -Algorithm SHA256
# Compare the hash (case-insensitive) with the matching line in SHA256SUMS.txt
```

On Linux or macOS, with the files in one folder: `sha256sum -c --ignore-missing SHA256SUMS.txt` (macOS: `shasum -a 256 -c --ignore-missing SHA256SUMS.txt`).

> **Windows SmartScreen:** the Windows binaries are not code-signed, so SmartScreen may warn on first run. Check the file against `SHA256SUMS.txt` first.

**Updating from v1.1.0 or v1.0.0:** install over the old version, or replace the portable `.exe`. Your history, settings and saved countdown in `%APPDATA%\com.datecalculator.tool\` are kept, and the cards start in the default order until you change it. The PWA updates itself on the next visit (new cache `date-tool-v1.2.0-mobile-1`); your saved data in the browser is kept.

## Versions

- **App:** 1.2.0 (installers, portable `.exe`, mobile `APP_VERSION`, footers).
- **Engine:** `date-core` 1.0.0, unchanged. CI still checks the app version and the engine version separately, and the mobile engine copy is still pinned by the SHA-256 of its exact bytes.

## Honest limitations

- All v1.1.0 limitations still apply: Islamic holidays are estimates, Egypt decree moves are not modelled, UK one-off bank holidays are included through 2027, month ends clamp, the Windows binaries are unsigned, GitHub Pages cannot send framing headers, there is one saved countdown per device, and a countdown target is local time.
- **One layout per device.** On desktop, if two windows change the layout at the same time, the last save wins. On mobile, other open tabs follow a change, except a tab where you are in the middle of a drag.
- The layout is not part of history and is not shared between the desktop app and the PWA.

## Security notes

- Nothing new goes online. The layout is stored only on this device: `%APPDATA%\com.datecalculator.tool\layout.json` on desktop, and `localStorage` key `date_tool_layout_v1` on mobile. It is kept apart from settings, so an older version never mistakes the newer settings file for a damaged one.
- The desktop file has the same protections as the countdown: a 1 KiB cap, a strict schema (each of the six cards exactly once, no unknown cards or fields), symlink rejection and atomic writes. A damaged file is copied once to `layout.json.bak` (on mobile, `date_tool_layout_v1_bak`) and the default layout is used. A layout saved by a newer version is left alone and never overwritten, not even by Reset.
- New desktop commands (`layout_load`, `layout_save`, `layout_reset`) take strictly validated input. The Tauri capability still grants `permissions: []`.
- Collapsing and dragging only switch CSS classes; the mobile app still never sets inline styles. There is still no `innerHTML`, `eval` or `new Function` anywhere. The mobile CSP is re-pinned to the new inline style and script hashes.

## Credits

Made by **Mohamed Sayed · Ahmed Emara**, built with **Claude (Anthropic)**.

All rights reserved (UNLICENSED). The source is public for transparency and review; no open-source license is granted.
