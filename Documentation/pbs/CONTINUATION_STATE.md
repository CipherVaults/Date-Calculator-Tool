# 🧷 Continuation State — Date Calculator Tool releases

## 🪪 Checkpoint identity

- Record type: recoverable working checkpoint (PBS v1.1).
- Goal: build Date Calculator Tool v1.0.0 per the approved Plan (milestones M0–M9; see [Roadmap](../3-%20ROADMAP.md)), then Part A of the approved [Portable Calculator Plan](../specs/5-%20PORTABLE_CALCULATOR_PLAN.md) (Date v1.1.0, v1.2.0 and a later sunset release).
- Recorded at: 2026-11-18 · writer: Claude Code (Opus 5.5) · next integrating owner: same session / any successor executor.
- Mission state (2026-11-18, newest): **Date v1.2.0 released and verified (E-17).** PR #5 was merged by the coordinator under the owner's standing release authority. Release v1.2.0 published 2026-11-18T16:50:38Z at `c40fd4d`, latest. Docs PR #6 merged (`68e9b93`). After that, README previews (`assets/preview-*.png`) were retaken from the v1.2.0 PWA; they wait to be committed on `dev` and will reach `main` with the next docs PR. Part B continues in [CipherVaults/Portable-Calculator-Tool](https://github.com/CipherVaults/Portable-Calculator-Tool) (M0 and M1 done, M2a in progress). Open here: the owner's manual checks, and the old-app sunset release, Date v1.3.0, later.
- Mission state (2026-11-18, earlier): **Date v1.1.0 released and verified (E-16).** Part B moved to the new repo, created on the owner's yes on 2026-11-18. Its own PBS records track M0 onward.
- Mission state (2026-11-17): **Approved Portable Calculator Plan, Part A (Date v1.1.0) in progress on `dev`**. See [the plan](../specs/5-%20PORTABLE_CALCULATOR_PLAN.md) and the v1.1.0 milestones in the Roadmap.
- Previous mission state: **M0–M9 done. PR #1 CI green on Ubuntu + Windows after the checksum fix `9c06553` (E-12); merged to `main` as `5a512a3`; Release v1.0.0 published and Pages live 2026-11-17 (E-13). Waiting on owner checks and owner acceptance.**
- Latest authorization: [Current State — Current authority](CURRENT_STATE.md#-current-authority).

## 🔎 Recovery inventory

| ID | Milestone | Classification | Evidence / notes |
|---|---|---|---|
| R0 | M0 scaffold, specs, icons, PBS records | implemented-verified | Ledger E-02–E-04; committed on `dev` |
| R1–R3 | M1–M3 date-core | implemented-verified | Ledger E-05, E-06; committed on `dev` |
| R4 | M4 Tauri backend | implemented-verified | Coordinator re-ran fmt, clippy -D warnings, workspace tests (2026-11-17); commit after 6228430 on `dev` |
| R5 | M5 desktop UI | implemented-verified | Ledger E-09; commit `a2d5657`. Open owner check: leaving the Egypt preset keeps the weekend unchanged |
| R6 | M6 mobile PWA | implemented-verified | Ledger E-09; commit `3a4948b`. Real-phone install not done (owner check) |
| R7 | M7 safety-eval | implemented-verified | Ledger E-09; commit `3b731e8` |
| R8 | M8 CI, docs, PR | implemented-verified | Ledger E-10, E-12; PR #1 runs on `9c06553` green on both jobs; CRLF checksum defect found and fixed |
| R9 | M9 release | implemented-verified | Ledger E-13; merge `5a512a3`, Release v1.0.0 (5 assets, `sha256sum -c` OK 4/4), downloaded portable exe smoke OK, Pages live. Real-phone PWA install not done (owner check); "PWA installs" verified only as service worker active + manifest served |
| A1 | Clickable mini calendars (Business Days, Date Info, Countdown) | implemented-verified, released in v1.1.0 | Ledger E-15 (build checks), E-16 (release). Buttons, Start/End pick switch, Shift sets the end, typing a start moves the next click to the end, roving-tabindex keyboard, Today button, 44px targets. Not run: screen reader, real phone |
| A2 | Countdown persistence | implemented-verified, released in v1.1.0 | Ledger E-15, E-16. Own store (`countdown.json` / `date_tool_countdown_v1`) with restored, finished and finished-while-closed states and a Forget button; commands `countdown_load/save/clear`; smoke round trip |
| A3–A4 | Plan items A3–A4 (shipped in milestone A2): history read-only fix; app/engine version split | implemented-verified, released in v1.1.0 | Ledger E-15, E-16. Any non-NotFound read failure → read-only; corrupt files backed up first; "Start a new history" always keeps a copy; commands `history_state/history_retry/history_reset`. App 1.1.0, engine 1.0.0, checked separately in CI, the release loop and check-mobile; the mobile engine slice is hash-pinned |
| A8 | Date v1.2.0: collapsible and reorderable cards | implemented-verified, released in v1.2.0 | Ledger E-17. `[ − ]`/`[ + ]` collapse; reorder by the ⠿ handle (mouse, pen, finger with a deliberate touch threshold), ArrowUp/Down on the handle, or a Move up / Move down / Done menu that works with VoiceOver/TalkBack; quick-nav follows the order; own store (`layout.json` / `date_tool_layout_v1`); commands `layout_load/save/reset`; Settings → Layout → "Reset card order & expand all". Release assets verified (5 files, `sha256sum -c` OK, downloaded portable exe smoke OK incl. countdown + layout, Pages identical to `main`). Not run: real phone, installed exe, screen reader |

## ▶️ Exact next permitted action

Done 2026-11-18: Release v1.2.0 published and verified (E-17); docs PR #6 merged (`68e9b93`).

Next, for the owner (not something the coordinator can do):

- Install and use the PWA on a real iPhone/Android phone.
- Run the manual checks on the installed exe.
- Try the app with a screen reader.
- Check that leaving the Egypt preset keeps the weekend unchanged (open from M5).
- Decide whether to accept v1.2.0.

Next for the coordinator:

- Part B continues in [CipherVaults/Portable-Calculator-Tool](https://github.com/CipherVaults/Portable-Calculator-Tool) (M2a, the phone-first shell, is in progress). Its own PBS records hold its next action.
- Later: the old-app sunset release, Date **v1.3.0**, per the plan.

Not run by the coordinator: the NSIS and MSI installers on a clean machine, and a native-window click-through of the desktop UI.

Done 2026-11-17 on the owner's "Yes, merge docs": docs-only PR [#2](https://github.com/CipherVaults/Date-Calculator-Tool/pull/2) merged to `main` as `0c3d6e0` (E-14). A docs-only merge is safe: the release job sees that the current version exists and leaves its tag and assets unchanged, and Pages does not run, because `pages.yml` only triggers on changes to `mobile/**` or its own file, so the live site is untouched. Since 2026-11-18 the owner's standing release authority lets the coordinator merge and release work that passed every check and was verified. Any new release needs a version bump in every version location plus `.github/release-notes-v<version>.md`.

## 🚫 Do not repeat / known pitfalls

- Never run Cargo from Git Bash (its `/usr/bin/link` shadows the MSVC linker).
- Keep `core.autocrlf=false`; mobile CSP hashes are byte-exact.
- On the Windows runner, write `SHA256SUMS.txt` with LF (`[System.IO.File]::WriteAllText`), not `Set-Content`, which writes CRLF and breaks `sha256sum -c` (E-12).
- A "cancelled" PR check after a new push is the workflow's `cancel-in-progress` rule, not a failure (E-12).
- The Notion PBS hub link shared by the owner (`3fabd7ad…`) is not visible to the Notion connector; the connected workspace copy `39c90e04…0ad0` is the method source.
