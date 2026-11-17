# 🧾 Execution & Coding Ledger — Date Calculator Tool

Dated, factual record of execution and verification. Newest entries at the bottom. Each entry names the artifact it applies to; a pass here is a technical result, not owner acceptance.

## 1. Environment

- Windows 11 Pro; cargo 1.99.1 (x86_64-pc-windows-msvc); Node v24.14.0; git 2.40; gh 2.93; Tauri CLI `=2.12.4` (installed 2026-11-16).
- Cargo is run from PowerShell only.

## 2. Evidence log

| ID | Date | Scope / artifact | Command or method | Result |
|---|---|---|---|---|
| E-01 | 2026-11-16 | Design specs 1–3 + critique 4 | Read-only design workflow (3 spec writers + adversarial re-computation of every vector) | 28 contradictions and 4 wrong vectors found; resolved in `0- FROZEN_DECISIONS.md` |
| E-02 | 2026-11-16 | `scripts/generate-icons.mjs` outputs | `node scripts/generate-icons.mjs`; visual inspection of `icon-512.png` | 6 PNGs written; glyph renders as intended |
| E-03 | 2026-11-16 | Tauri icon set | `cargo tauri icon assets/icon-source-1024.png -o src-tauri/icons` (tauri-cli 2.12.4); android/ios outputs removed | 17 files, same names as the reference set |
| E-04 | 2026-11-16 | M0 workspace (stub `src-tauri`) | PowerShell `cargo build -p date-calculator-tool` (target `target/m0-check`) | Pass in 1m 41s; Cargo.lock keeps tauri 2.12.5 |
| E-05 | 2026-11-16 | date-core M1–M3 (workflow `wf_46a89d26-95b`: implement → 2 independent reviews → fix, per milestone) | Reviews: M1 pass (4 minor, fixed), M2 pass (3 minor, fixed), M3 pass (2 minor, fixed) | 13,965-case golden.json (22.1 MB raw, ~2.2 MB gzip) |
| E-06 | 2026-11-16 | date-core at commit after E-05 | Coordinator re-run (PowerShell): `cargo fmt --all -- --check`; `cargo clippy --workspace --all-targets --locked -- -D warnings`; `cargo test -p date-core --locked --release`; `gen_golden --check`; bridge spot checks | All pass: 104 tests in 11 binaries incl. chrono oracle over 3,652,059 days; golden up to date; bridge: 2024-01-31→2025-03-15 = 409 d / 1y 1m 15d, US 2026 = 11 holidays, US Jan 2024 = 20 business days |
| E-07 | 2026-11-16 | GitHub repository | Owner asked to create it early ("yes, do it now"): `gh repo create CipherVaults/Date-Calculator-Tool --public`; `git push -u origin dev` | Public repo created; `dev` pushed at `84e7347`; no workflows yet, so nothing builds or publishes |
| E-08 | 2026-11-17 | M4 `src-tauri` (workflow review: security + contract lenses pass; 3 minor fixed) | Coordinator: `cargo fmt --all -- --check`; `cargo clippy --workspace --all-targets --locked -- -D warnings`; `cargo test --workspace --locked` | All pass (16 backend tests + all date-core suites). Committed; M5 UI committed as WIP `7154ac5`; remote SHA verified |
| E-09 | 2026-11-17 | M5 desktop UI (8 minor review findings fixed), M6 mobile PWA (2 reviews, no findings), M7 safety-eval (4 findings fixed) — workflow `wf_05af85e7-2c1` | Coordinator (PowerShell): fmt, clippy -D warnings, `cargo test --workspace --locked`, `gen_golden --check`, debug `--smoke-test`; `node scripts/check-mobile.mjs`; `node scripts/safety-eval.mjs --json target/safety-eval-system-card.json`; browser pane at 375 px via `serve-mobile.mjs` | All pass: smoke SMOKE_TEST_OK; check-mobile golden 13,965/13,965 ×3 time zones; safety-eval 48/48 criteria, 34,631 assertions; 375 px no horizontal scroll, SW active, results match vectors. Not run: release-exe smoke, native-window click-through, real-phone install. Commits `a2d5657`, `3a4948b`, `3b731e8`; remote verified |
| E-10 | 2026-11-17 | M8 `.github/workflows/{build,pages}.yml`, safety-eval D.workflow-* criteria, docs 1/2/4, HANDOFF, release notes, README previews (workflow `wf_e187f8b8-200`: CI + docs agents, 1 review — 1 major (main-creation release trap) + 3 minor, all fixed in docs) | Coordinator: PyYAML load of both workflows; read triggers, release `if:`, permissions, pins, smoke step; `node scripts/check-mobile.mjs`; `node scripts/safety-eval.mjs --json …` | All pass: safety-eval 52/52 criteria, 34,669 assertions (D.workflow-* 4/4 incl. planted-mutant self-tests). Previews made from the PWA with headless Edge (throwaway profile). Not run: actionlint/shellcheck (not installed), `cargo tauri build` bundling, anything on GitHub runners |

## 3. Coding lessons

- PowerShell pipes prepend a UTF-8 BOM to the first stdin line; the NDJSON bridge rejects that line as `invalid_request`. Start piped input with a blank line (or use a file) when testing by hand.
- Spec deviations recorded by implementers (accepted by coordinator): `later date included` wording; ASCII trace text (`->`); `daysRemainingInMonth` extra field; amounts limited to 15 raw digits (leading zeros count); `Strict` deserializer rejects serde map-form enums; 1024-byte string cap on every request string.
