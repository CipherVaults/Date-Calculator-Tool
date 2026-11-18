# 📍 Current State — Date Calculator Tool

## 🪪 Present-state identity

- Record type: accepted present and active authority pointer (PBS v1.1).
- Canonical project home: [CipherVaults/Date-Calculator-Tool](https://github.com/CipherVaults/Date-Calculator-Tool) (public, created 2026-11-16). Branches: `dev` (work) and `main` (created 2026-11-17 at `dc4c05e`; default branch since 2026-11-17 on the owner's yes). Local working copy: `D:\Claude Projects\Date Calculator`. Repository entry: [AGENTS.md](../../AGENTS.md).
- Chosen granularity: combined small-project checkpoint. [Continuation](CONTINUATION_STATE.md) owns unfinished milestone work; the [Execution & Coding Ledger](EXECUTION_AND_CODING_LEDGER.md) owns detailed execution evidence.
- State owner: coordinating maintainer (Claude Code, Opus 5.5); the project owner (Ahmed) decides acceptance.
- As of: **2026-11-17**: M0–M9 done. PR #1 merged to `main` (merge commit `5a512a3`) under the owner's conditional authorization; GitHub Release **v1.0.0** published 2026-11-17 and Pages live. Not yet owner-accepted.

## ✅ Accepted present

- Released present: **v1.0.0 published 2026-11-17, not yet owner-accepted.** Release [v1.0.0](https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v1.0.0) (tag at `5a512a3`, 5 assets incl. `SHA256SUMS.txt`); PWA live at <https://ciphervaults.github.io/Date-Calculator-Tool/>. Evidence: Ledger E-12, E-13. A published release is not owner acceptance.
- Accepted baseline: **none yet**. The owner has not accepted v1.0.0.
- Still not verified: PWA install on a real phone; NSIS/MSI installers on a clean machine; native-window click-through of the desktop UI; the M5 Egypt-preset weekend check. Windows binaries are unsigned (SmartScreen will warn).
- Sibling/reference product: `CipherVaults/Percentage-Calculator-Tool` v2.2.1 (architecture, hardening and design system mirrored; not modified by this project).

## 🎯 Current authority

- **Active authority (newest): the owner's 2026-11-17 approval of the [Portable Calculator Plan](../specs/5-%20PORTABLE_CALCULATOR_PLAN.md)** ("Yeah, I approve of that"), which is the approved Goal for:
  - **Part A, Date Calculator v1.1.0**: clickable mini calendars, countdown persistence, the history-loss read-only fix, and the app/engine version split.
  - **Part B, Portable Calculator Tool v1.0.0** in a new repo.
- Owner clarifications at approval:
  - no legacy history migration (start fresh);
  - fixes, improvements and security hardening that matter are done without waiting;
  - the web app is phone-first.
- Still gated on an explicit owner yes: merging to `main`, tags and releases, creating the new repository, and enabling Pages on it.
- Earlier authority: the owner's **2026-11-16 approval of the project Plan** (PBS *Start a project* → proposed Plan → approved Goal). The approved Plan is preserved as [Documentation/specs/0- FROZEN_DECISIONS.md](../specs/0-%20FROZEN_DECISIONS.md) (decisions) and the milestone table in [Roadmap](../3-%20ROADMAP.md).
- Authorizes: all local work M0–M7; creating the **public** repository `CipherVaults/Date-Calculator-Tool`, pushing the `dev` branch and opening a PR to `main` (M8).
- Merge of PR #1 (2026-11-17): done under the owner's conditional authorization ("I give you my authorization to do that if you tested it and agreed it's ready"). The coordinator judged it ready after green CI and artifact checks (Ledger E-12) and merged; that authorization covered this one merge only.
- Excludes until an explicit owner "yes": **any further merge to `main`** (including a docs-only `dev` → `main` PR), new tags or releases, and any hosted repository setting change beyond Pages enablement done by the workflow.
- Deferred by the owner (2026-11-16): the Notion project hub ("skip notion for now"). Revisit only if the owner asks.
- Not possible from this environment: installing the PWA on a physical iPhone/Android device (owner check).

## 🧭 Operational orientation

- Current phase: **v1.1.0 build (Part A of the Portable Calculator Plan)** on `dev`. Owner checks still open from v1.0.0: real-phone PWA install and acceptance. Live operational source: the working tree and `git log` on `dev`; `main` holds the released code.
- Source/owner map: [SOURCE_OWNERSHIP_MAP.md](SOURCE_OWNERSHIP_MAP.md).
- Unaccepted work pointer: [CONTINUATION_STATE.md](CONTINUATION_STATE.md).
