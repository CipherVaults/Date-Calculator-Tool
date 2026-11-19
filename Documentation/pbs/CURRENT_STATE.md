# 📍 Current State — Date Calculator Tool

## 🪪 Present-state identity

- Record type: accepted present and active authority pointer (PBS v1.1).
- Canonical project home: [CipherVaults/Date-Calculator-Tool](https://github.com/CipherVaults/Date-Calculator-Tool) (public, created 2026-11-16). Branches: `dev` (work) and `main` (created 2026-11-17 at `dc4c05e`; default branch since 2026-11-17 on the owner's yes). Local working copy: `D:\Claude Projects\Date Calculator`. Repository entry: [AGENTS.md](../../AGENTS.md).
- Chosen granularity: combined small-project checkpoint. [Continuation](CONTINUATION_STATE.md) owns unfinished milestone work; the [Execution & Coding Ledger](EXECUTION_AND_CODING_LEDGER.md) owns detailed execution evidence.
- State owner: coordinating maintainer (Claude Code, Opus 5.5); the project owner (Ahmed) decides acceptance.
- As of: **2026-11-18**: Release **v1.2.0** published 2026-11-18T16:50:38Z at `c40fd4d` and verified (E-17). It is the latest release. v1.1.0 (E-16) and v1.0.0 (E-13) came before it. None is owner-accepted yet.

## ✅ Accepted present

- Released present: **v1.2.0 is the latest release, not yet owner-accepted.** Release [v1.2.0](https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v1.2.0) (tag at `c40fd4d`, 5 assets incl. `SHA256SUMS.txt`); PWA live at <https://ciphervaults.github.io/Date-Calculator-Tool/>, identical to `main`. Evidence: Ledger E-17. A published release is not owner acceptance.
  - v1.2.0 adds collapsible cards, card reordering (drag handle, arrow keys, or a Move menu that works with VoiceOver/TalkBack) and a saved card layout in its own store.
  - v1.1.0 (2026-11-18, tag at `7f46254`, E-16) added clickable mini calendars, saved countdowns, the history read-only fix and the app/engine version split.
  - v1.0.0 (2026-11-17, tag at `5a512a3`, E-13) was the first release.
- Versions now: app **1.2.0**; engine `date-core` **1.0.0** (unchanged since v1.0.0).
- Checks at v1.2.0: date-core 104 tests and desktop backend 36 tests pass; safety-eval 107/107 criteria (36,134 assertions) with planted-mutant proofs; the smoke test covers renderer, IPC, clipboard, countdown and layout.
- Accepted baseline: **none yet**. The owner has not accepted v1.0.0, v1.1.0 or v1.2.0.
- Still not verified: PWA install and use on a real phone; manual checks of the installed exe; a screen reader pass; NSIS/MSI installers on a clean machine; the M5 Egypt-preset weekend check. Windows binaries are unsigned (SmartScreen will warn).
- Sibling/reference product: `CipherVaults/Percentage-Calculator-Tool` v2.2.1 (architecture, hardening and design system mirrored; not modified by this project).

## 🎯 Current authority

- **Focus (2026-11-19, newest owner direction):** "stop working on them separately, and focus all of our efforts on the Portable Calculator tool". Date Calculator is frozen at v1.2.0 except for maintenance and the later sunset release (v1.3.0).

- **Standing release authority (newest, 2026-11-18):** "don't wait for my approval to release, I already grant it to you if you tested it and it's good".
  - The coordinator may merge `dev` to `main` and release work that passed every check and was verified.
  - Used for PR #5 and Release v1.2.0 (E-17).
  - Still needs the owner: creating repositories and changing repository settings.
- **Active Goal: the owner's 2026-11-17 approval of the [Portable Calculator Plan](../specs/5-%20PORTABLE_CALCULATOR_PLAN.md)** ("Yeah, I approve of that"). It covers:
  - **Part A, the Date Calculator releases**: v1.1.0 (A1 calendars, A2 countdown persistence, A3 history read-only fix, A4 version split; released, E-16), v1.2.0 (A8 collapsible and reorderable cards; released, E-17), and a later old-app sunset release, now planned as Date **v1.3.0**.
  - **Part B, Portable Calculator Tool v1.0.0** in the new public repo [CipherVaults/Portable-Calculator-Tool](https://github.com/CipherVaults/Portable-Calculator-Tool), created 2026-11-18 on the owner's yes. Its own PBS records track it.
- Owner clarifications at approval:
  - no legacy history migration (start fresh);
  - fixes, improvements and security hardening that matter are done without waiting;
  - the web app is phone-first.
- v1.1.0 was released after the owner merged PR #3 and said to release it if fit (E-16).
- Earlier authority: the owner's **2026-11-16 approval of the project Plan** (PBS *Start a project* → proposed Plan → approved Goal). The approved Plan is preserved as [Documentation/specs/0- FROZEN_DECISIONS.md](../specs/0-%20FROZEN_DECISIONS.md) (decisions) and the milestone table in [Roadmap](../3-%20ROADMAP.md).
- Authorizes: all local work M0–M7; creating the **public** repository `CipherVaults/Date-Calculator-Tool`, pushing the `dev` branch and opening a PR to `main` (M8).
- Merge of PR #1 (2026-11-17): done under the owner's conditional authorization ("I give you my authorization to do that if you tested it and agreed it's ready"). The coordinator judged it ready after green CI and artifact checks (Ledger E-12) and merged; that authorization covered this one merge only. The 2026-11-18 standing release authority now replaces the per-merge yes for tested work.
- Excludes until an explicit owner "yes": merging or releasing work that has not passed every check, creating repositories, and any hosted repository setting change beyond Pages enablement done by the workflow.
- Deferred by the owner (2026-11-16): the Notion project hub ("skip notion for now"). Revisit only if the owner asks.
- Not possible from this environment: installing the PWA on a physical iPhone/Android device (owner check).

## 🧭 Operational orientation

- Current phase: **v1.2.0 released 2026-11-18 (E-17); Part B continues in CipherVaults/Portable-Calculator-Tool** (M0 and M1 done, M2a phone-first shell in progress). The old-app sunset release, Date v1.3.0, comes later. Owner checks still open: real-phone PWA install and use, installed-exe manual checks, a screen reader pass, the M5 Egypt-preset weekend question, and acceptance. Live operational source: the working tree and `git log` on `dev`; `main` holds the released code.
- Source/owner map: [SOURCE_OWNERSHIP_MAP.md](SOURCE_OWNERSHIP_MAP.md).
- Unaccepted work pointer: [CONTINUATION_STATE.md](CONTINUATION_STATE.md).
