# 🧷 Continuation State — Date Calculator Tool v1.0.0 build

## 🪪 Checkpoint identity

- Record type: recoverable working checkpoint (PBS v1.1).
- Goal: build Date Calculator Tool v1.0.0 per the approved Plan (milestones M0–M9; see [Roadmap](../3-%20ROADMAP.md)).
- Recorded at: 2026-11-17 · writer: Claude Code (Opus 5.5) · next integrating owner: same session / any successor executor.
- Mission state (2026-11-18, newest): **Date v1.1.0 released and verified (E-16).** Part B moved to the new repo [CipherVaults/Portable-Calculator-Tool](https://github.com/CipherVaults/Portable-Calculator-Tool), created on the owner's yes on 2026-11-18. Its own PBS records track M0 onward. Open here: the owner's manual checks (installed exe, real phone) and a docs-only PR so `main`'s README shows v1.1.0 as released.
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

## ▶️ Exact next permitted action

Done 2026-11-17: PR [#1](https://github.com/CipherVaults/Date-Calculator-Tool/pull/1) merged under the owner's conditional authorization; Release v1.0.0 published; Pages live.

Next, for the owner (not something the coordinator can do):

- Install the PWA on a real iPhone/Android phone.
- Check that leaving the Egypt preset keeps the weekend unchanged (open from M5).
- Decide whether to accept v1.0.0.

Not run by the coordinator: the NSIS and MSI installers on a clean machine, and a native-window click-through of the desktop UI.

Done 2026-11-17 on the owner's "Yes, merge docs": docs-only PR [#2](https://github.com/CipherVaults/Date-Calculator-Tool/pull/2) merged to `main` as `0c3d6e0` (E-14). A docs-only merge is safe: the release job sees that v1.0.0 exists and leaves its tag and assets unchanged, and Pages does not run, because `pages.yml` only triggers on changes to `mobile/**` or its own file, so the live site is untouched. Any later merge to `main` still needs the owner's explicit yes. Any new release needs a version bump in every version location plus `.github/release-notes-v<version>.md`.

## 🚫 Do not repeat / known pitfalls

- Never run Cargo from Git Bash (its `/usr/bin/link` shadows the MSVC linker).
- Keep `core.autocrlf=false`; mobile CSP hashes are byte-exact.
- On the Windows runner, write `SHA256SUMS.txt` with LF (`[System.IO.File]::WriteAllText`), not `Set-Content`, which writes CRLF and breaks `sha256sum -c` (E-12).
- A "cancelled" PR check after a new push is the workflow's `cancel-in-progress` rule, not a failure (E-12).
- The Notion PBS hub link shared by the owner (`3fabd7ad…`) is not visible to the Notion connector; the connected workspace copy `39c90e04…0ad0` is the method source.
