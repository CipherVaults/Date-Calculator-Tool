# 🧷 Continuation State — Date Calculator Tool v1.0.0 build

## 🪪 Checkpoint identity

- Record type: recoverable working checkpoint (PBS v1.1).
- Goal: build Date Calculator Tool v1.0.0 per the approved Plan (milestones M0–M9; see [Roadmap](../3-%20ROADMAP.md)).
- Recorded at: 2026-11-16 · writer: Claude Code (Opus 5.5) · next integrating owner: same session / any successor executor.
- Mission state: **M0 complete (E-03, E-04); M1–M3 (date-core) running as an implement → review → fix workflow.**
- Latest authorization: [Current State — Current authority](CURRENT_STATE.md#-current-authority).

## 🔎 Recovery inventory

| ID | Milestone | Classification | Evidence / notes |
|---|---|---|---|
| R0 | M0 scaffold, specs, icons, PBS records | implemented-verified | Ledger E-02–E-04; committed on `dev` |
| R1–R3 | M1–M3 date-core | in progress | Workflow `wf_46a89d26-95b` edits only `crates/date-core/**` and `Cargo.lock` |
| R4–R9 | M4–M9 | not started | — |

## ▶️ Exact next permitted action

When the date-core workflow returns: verify its report against the tree (fmt, clippy, full tests, gen_golden --check), commit date-core + Cargo.lock, then start M4 (Tauri backend).

## 🚫 Do not repeat / known pitfalls

- Never run Cargo from Git Bash (its `/usr/bin/link` shadows the MSVC linker).
- Keep `core.autocrlf=false`; mobile CSP hashes are byte-exact.
- The Notion PBS hub link shared by the owner (`3fabd7ad…`) is not visible to the Notion connector; the connected workspace copy `39c90e04…0ad0` is the method source.
