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

## 3. Coding lessons

- (none yet)
