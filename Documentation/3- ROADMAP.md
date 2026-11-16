# 🛣️ Roadmap — Date Calculator Tool

## v1.0.0 milestones (approved 2026-11-16)

| # | Milestone | Done when | Status |
|---|---|---|---|
| M0 | Scaffold | git `dev` + `core.autocrlf false`; specs + frozen decisions; icons; src-tauri stub; `cargo build --workspace` (PowerShell) | done 2026-11-16 |
| M1 | Civil engine + 6 modes | chrono oracle over all 3.65M days; date-math vectors pass; clippy `-D warnings` clean | done 2026-11-16 |
| M2 | Calendar/holidays | weekend, US/UK/EG presets, Easter ×2, Hijri, custom/exclusions/overrides, business count/add, month_grid; `holiday_tables.rs` passes | done 2026-11-16 |
| M3 | api + bridge + golden | `gen_golden --check` clean; parity + safety tests green | done 2026-11-16 |
| M4 | Tauri backend | settings/history validators, storage, update check + tests; `cargo test --workspace` green | — |
| M5 | Desktop UI | 6 cards, mini calendar, settings calendar, history, About; debug and release smoke exit 0; live walkthrough | — |
| M6 | Mobile PWA | engine mirror, CSP hashes, node golden replay under 3 time zones, offline via `serve-mobile.mjs`, phone-width check | — |
| M7 | safety-eval | all slices pass; System Card JSON written | — |
| M8 | CI, docs, repo | workflows, docs, release notes, previews; repo created; `dev` pushed; PR with green CI | — |
| M9 | Release | **owner-approved** merge → v1.0.0 Release (5 assets + SHA256SUMS), Pages live, PWA installs | — |

## Backlog (proposed, not authorized)

- More holiday presets (e.g. Saudi Arabia, UAE, EU countries).
- Official Egyptian decree overrides published as data updates.
- Light theme.
