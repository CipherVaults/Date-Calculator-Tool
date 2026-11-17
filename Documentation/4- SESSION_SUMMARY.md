# Session Summary

Factual record of the v1.0.0 build. Sources: `git log` on `dev` and the [Execution & Coding Ledger](pbs/EXECUTION_AND_CODING_LEDGER.md) (evidence IDs E-01 to E-09). Milestones are defined in [3- ROADMAP.md](3-%20ROADMAP.md).

---

## Session: November 16th, 2026 - Plan, Design Specs and the Date Engine (M0–M3)

---

## Time

Start: November 16th, 2026, morning, with the PBS *Start a project* plan and the owner Q&A
End: November 16th, 2026, evening (README commit `6228430`, 18:11)
Commits: `37dcf86` (10:28), `84e7347` (13:38), `0abaa8f`, `3ebf0da`, `6228430`

---

## Session Goal

Start a new sibling of Percentage Calculator Tool v2.2.1 for date calculations, get the owner's approval of a plan, and build the pure Rust date engine with fixtures that the desktop and mobile editions would later share.

---

## What We Worked On

### 1. Plan and owner decisions

The owner approved the PBS plan and answered the open questions on 2026-11-16:
- six modes;
- US, UK and Egypt presets plus custom holidays;
- a configurable weekend, with Egypt switching it to Fri/Sat;
- estimated Islamic dates with an offset and overrides;
- the month-end clamp rule;
- the business-mode stepping order;
- the same platform split and design system as the reference;
- a public repository, UNLICENSED, `com.datecalculator.tool`.

These are recorded in [0- FROZEN_DECISIONS.md](specs/0-%20FROZEN_DECISIONS.md).

### 2. Design specs and adversarial critique (E-01)

A read-only design workflow wrote specs 1–3: date math, holiday rules and the build plan. An adversarial reviewer then recomputed every vector and wrote spec 4 (design critique). It found 28 contradictions and 4 wrong vectors. All were resolved in the 16 frozen decisions, which override specs 1–4.

### 3. M0 scaffold (E-02 to E-04, `37dcf86`)

- Created the Cargo workspace (`crates/date-core`, stub `src-tauri`), set `core.autocrlf false` and added `.gitattributes`.
- Added `AGENTS.md`, the roadmap and the PBS records.
- `scripts/generate-icons.mjs` drew the calendar glyph in the shared palette and wrote 6 PNGs (E-02). `cargo tauri icon` produced the 17-file Tauri icon set (E-03).
- `cargo build -p date-calculator-tool` passed from PowerShell (E-04).

### 4. M1–M3 date-core (E-05, E-06, `84e7347`)

Built in a workflow where every milestone was implemented, reviewed by two independent reviewers, then fixed. All reviews passed with minor findings, all fixed: M1 4, M2 3, M3 2.

- **M1:**
  - civil arithmetic on `i64` day numbers;
  - the strict parsers and ASCII formatting;
  - the six modes.
- **M2:**
  - `CalendarSpec` and `validate_calendar`;
  - weekend masks;
  - US, UK and Egypt presets, with Western and Orthodox Easter and the tabular Hijri calendar;
  - custom holidays, exclusions and overrides;
  - business-day counting and stepping;
  - `month_grid`.
- **M3:**
  - the `api` surface with the `#[serde(tag = "ok")]` envelope, the `Strict` deserializer and the 1024-byte string cap;
  - the NDJSON bridge;
  - `gen_golden.rs` and the 13,965-case `golden.json` (22.1 MB raw, about 2.2 MB gzipped).

The coordinator re-ran everything from PowerShell (E-06):
- fmt, clippy `-D warnings` and `cargo test -p date-core --locked --release`: 104 tests in 11 binaries, including the `chrono` oracle over 3,652,059 days;
- `gen_golden --check`;
- bridge spot checks: 2024-01-31 → 2025-03-15 = 409 days (1y 1m 15d); US 2026 = 11 holidays; US January 2024 = 20 business days.

### 5. Repository (E-07)

At the owner's request ("yes, do it now"), the public repository `CipherVaults/Date-Calculator-Tool` was created early and `dev` was pushed. There were no workflows yet, so nothing was built or published. The commit rhythm and the README followed (`3ebf0da`, `6228430`).

---

## Session: November 17th, 2026 - Desktop Backend & UI, Mobile PWA and Safety Evaluation (M4–M7), M8 Start

---

## Time

Start: November 17th, 2026, with the M4 backend (`133e351`, 12:50)
End: November 17th, 2026, with M5–M7 recorded (`dc4c05e`, 18:01), followed by the M8 documentation and CI work (pending)
Commits: `133e351`, `7154ac5` (WIP), `3f27ed3`, `a2d5657`, `3a4948b`, `3b731e8`, `dc4c05e`

---

## Session Goal

Build the desktop backend and UI, the Mobile & Web PWA and the cross-surface safety evaluation on top of the finished engine. Then start M8: CI, documentation and the PR to `main`.

---

## What We Worked On

### 1. M4 Tauri backend (E-08, `133e351`)

`src-tauri/src/commands.rs` provides:
- one command per engine operation, passed straight to `date_core::api`, so bad input gets the bridge's envelope;
- hardened history (500 entries, 1 MiB, atomic private writes, symlink rejection);
- settings with the calendar (64 KiB, one-time `.bak` on corruption, update checks off after corruption);
- the update check through `System32\curl.exe`;
- the 4096-byte clipboard copy, `get_app_info` and `--smoke-test`.

Security and contract reviews passed with 3 minor findings, all fixed. 16 backend tests plus all date-core suites passed.

### 2. M5 desktop UI (E-09, `7154ac5` → `a2d5657`)

The six cards, mini calendars, the Settings calendar editor, history and About. The UI went in first as `WIP:` and was finished after design and behaviour reviews, which raised 8 minor findings. Among the fixes:
- 44 px touch targets;
- stable focus while the holiday list redraws;
- the year shown as "2026", not "2,026";
- the Business highlight stopping before an excluded later date;
- a "business days left" line on the Countdown;
- no stale target after an edit;
- custom holiday dates limited to 1900–2199;
- leaving the Egypt preset no longer changes the weekend.

New smoke checks cover these fixes.

### 3. M6 Mobile & Web PWA (E-09, `3a4948b`)

- `mobile/index.html` with the JS port of date-core between the `date-core:begin v1.0.0` / `date-core:end` markers, the CSP pinned by SHA-256, `sw.js` (`date-tool-v1.0.0-mobile-1`), the manifest and icons.
- `scripts/check-mobile.mjs`, the parity gate.
- `scripts/serve-mobile.mjs`, the local server at the Pages path.

Two reviews found nothing. check-mobile passed:
- golden 13,965/13,965, vectors 195/195 and boundary cases 42/42;
- under `UTC`, `America/St_Johns` and `Pacific/Kiritimati`.

In the browser pane at 375 px there was no horizontal scroll and the service worker was active. Results matched the vectors, for example 2024-01-31 → 2025-03-15 = 409 days.

### 4. M7 safety evaluation (E-09, `3b731e8`)

`scripts/safety-eval.mjs` has four slices:
- A: engine parity with an independent oracle;
- B: the mobile UI under a virtual clock;
- C: the desktop UI with `invoke` routed to the Rust bridge;
- D: static hygiene.

Review fixes:
- a stale bridge binary is rebuilt instead of trusted;
- holiday ids are read from the Rust sources.

E-09 result: 48/48 criteria, 34,631/34,631 assertions. Planted bugs each made it fail: a wrong ISO-week rule, an `innerHTML` sink, a stale bridge and a changed Egypt holiday.

### 5. M8 CI, documentation and PR (in progress)

- **CI:** `.github/workflows/build.yml` and `pages.yml` are adapted from the reference, SHA-pinned, with `persist-credentials: false`, the `Start-Process -Wait -PassThru` smoke gate, `check-mobile.mjs` and safety-eval. **Status: pending first CI run.**
- **Documentation:** this summary, [1- PROJECT_CONTEXT.md](1-%20PROJECT_CONTEXT.md), [2- ARCHITECTURE.md](2-%20ARCHITECTURE.md), [HANDOFF.md](../HANDOFF.md), the README previews and the v1.0.0 release notes.
- **Safety-eval slice D:** four workflow criteria (`D.workflow-pins`, `D.workflow-persist-credentials`, `D.workflow-node-block-identical`, `D.workflow-release-gate`). The local run now passes 52/52 criteria and 34,669 assertions.
- **PR:** `dev` → `main`, after creating `main` from a commit without `.github/workflows` (see Next Steps).

---

## Key Concepts Learned

### 1. One engine needs a byte-level contract

A Rust engine and its JavaScript copy can only be proven identical when all text is built in the engine, without locale formatting, and the comparison covers raw bytes and key order. Comparing parsed JSON alone is not enough.

### 2. Purity makes time-zone bugs testable

"Today", "now" and the UTC offsets are inputs, and the mobile engine runs with `Date` and `Intl` deleted. That is what lets check-mobile replay the same golden cases under three extreme time zones and expect identical bytes.

### 3. Hand-verified and generated fixtures do different jobs

`vectors.json` states what is correct and is never regenerated. `golden.json` locks what the engine currently does and is regenerated only for an intentional change.

---

## Issues / Frictions

- **Git Bash shadows the MSVC linker.** `/usr/bin/link` breaks Cargo builds, so Cargo and Tauri run from PowerShell only.
- **PowerShell adds a UTF-8 BOM to piped stdin.** The bridge rejects that first line as `invalid_request`; start piped input with a blank line or use a file (ledger coding lessons).
- **The startup update check returns 404** until the first release exists. This is expected; the banner stays hidden.
- **The Notion PBS hub link was not visible to the connector.** The owner deferred the Notion hub ("skip notion for now").

---

## Important Decisions

- `0- FROZEN_DECISIONS.md` overrides specs 1–4.
- The envelope uses `"true"`/`"false"` string tags everywhere (FROZEN §1).
- Month ends clamp, so Jan 31 + 1 month − 1 month = Jan 28. This is documented as a limit, not hidden.
- Islamic holidays are estimated and labelled; decree moves in Egypt are not modelled.
- `month_grid` lives in the engine, so the mini calendars are covered by parity.
- Spec deviations accepted by the coordinator (ledger):
  - "later date included" wording;
  - ASCII trace arrows (`->`);
  - the extra `daysRemainingInMonth` field;
  - 15 raw digits for amounts;
  - `Strict` rejects map-form enums;
  - the 1024-byte string cap.
- Merging to `main` publishes a release, so it needs the owner's explicit yes.

---

## Current State

| Milestone | State |
|---|---|
| M0–M3 engine | done, verified (E-02 to E-06) |
| M4 backend | done, verified (E-08) |
| M5 desktop UI | done, verified (E-09); release-exe smoke test and a native-window click-through not yet run |
| M6 mobile PWA | done, verified (E-09); real-phone install not done (owner check) |
| M7 safety-eval | done, verified (E-09) |
| M8 CI, docs, PR | workflows and docs being added; **pending first CI run** |
| M9 release | **owner-gated:** needs an explicit yes to merge `dev` → `main` |

---

## Next Steps

### Immediate (M8)

- Commit the workflows and documentation on `dev`, push, and verify the remote SHA.
- Create `main` from a commit **without** `.github/workflows`, for example `git push origin dc4c05e:refs/heads/main`. Never create it from `dev` HEAD once the workflows are committed: creating the branch is a push to `main`, which would publish the v1.0.0 Release and deploy Pages without the owner's merge approval.
- Then open the PR `dev` → `main` (its `pull_request` run cannot release) and get CI green, including the release-exe smoke test on `windows-latest`.
- Done 2026-11-17 (owner yes): `main` is the default branch, so the first Pages deploy from `main` should be allowed.

### After owner approval (M9)

- Merge to `main`. CI then publishes the v1.0.0 Release (NSIS, MSI, portable `.exe`, mobile HTML, `SHA256SUMS.txt`) and deploys Pages.
- Owner checks: install the PWA on a real phone; confirm that leaving the Egypt preset should keep the weekend.

---

## Session Outcome

The engine, the desktop app, the PWA and the safety evaluation are built and verified locally, and pushed on `dev`. What remains is CI on GitHub and the owner-approved release.

---

## Confidence Level

High for calculation correctness and parity: the `chrono` oracle, hand-verified tables, 13,965 golden cases under three time zones and the 52-criterion safety evaluation all pass.

The remaining risk is in steps not yet run: the first hosted CI run (Windows bundling and release-exe smoke test), the Pages deployment, and installing on physical phones.
