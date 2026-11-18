# 🛣️ Roadmap — Date Calculator Tool

## v1.0.0 milestones (approved 2026-11-16)

| # | Milestone | Done when | Status |
|---|---|---|---|
| M0 | Scaffold | git `dev` + `core.autocrlf false`; specs + frozen decisions; icons; src-tauri stub; `cargo build --workspace` (PowerShell) | done 2026-11-16 |
| M1 | Civil engine + 6 modes | chrono oracle over all 3.65M days; date-math vectors pass; clippy `-D warnings` clean | done 2026-11-16 |
| M2 | Calendar/holidays | weekend, US/UK/EG presets, Easter ×2, Hijri, custom/exclusions/overrides, business count/add, month_grid; `holiday_tables.rs` passes | done 2026-11-16 |
| M3 | api + bridge + golden | `gen_golden --check` clean; parity + safety tests green | done 2026-11-16 |
| M4 | Tauri backend | settings/history validators, storage, update check + tests; `cargo test --workspace` green | done 2026-11-17 |
| M5 | Desktop UI | 6 cards, mini calendar, settings calendar, history, About; debug and release smoke exit 0; live walkthrough | done 2026-11-17 |
| M6 | Mobile PWA | engine mirror, CSP hashes, node golden replay under 3 time zones, offline via `serve-mobile.mjs`, phone-width check | done 2026-11-17 |
| M7 | safety-eval | all slices pass; System Card JSON written | done 2026-11-17 |
| M8 | CI, docs, repo | workflows, docs, release notes, previews; repo created; `dev` pushed; PR with green CI | done 2026-11-17 |
| M9 | Release | **owner-approved** merge → v1.0.0 Release (5 assets incl. SHA256SUMS), Pages live, PWA installs | done 2026-11-17 (real-phone PWA install: owner check) |

## v1.1.0 milestones (approved 2026-11-17, [plan](specs/5-%20PORTABLE_CALCULATOR_PLAN.md) Part A)

| # | Milestone | Done when | Status |
|---|---|---|---|
| A1 | Clickable mini calendars | Business Days, Date Info and Countdown days are clickable, with keyboard support and focus kept; safety-eval criteria green | done 2026-11-18 (`c66843a`) |
| A2 | Countdown persistence, history-loss fix, version split | countdown restores after close/reopen with "finished" wording; an unreadable history goes read-only, never overwritten; CI version checks split app/engine | done 2026-11-18 (`c66843a`) |
| A3 | v1.1.0 release | full checks + manual checklist; **owner-approved** merge → v1.1.0 Release | done 2026-11-18 (owner merged PR #3 → `7f46254`; Release v1.1.0 verified, E-16). Manual installed-exe/phone checklist: owner check |

After v1.1.0: Part B, Portable Calculator Tool v1.0.0, in a new repo (M0–M11 in the plan).

## Backlog (proposed, not authorized)

- More holiday presets (e.g. Saudi Arabia, UAE, EU countries).
- Official Egyptian decree overrides published as data updates.
- Light theme.
