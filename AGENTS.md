# 🤖 Agent entry: Date Calculator Tool

This file holds the project's persistent execution instructions for AI and human collaborators. It is not the current task and grants no permission. The owner's latest bounded request or approved Goal defines current work (see [Current State](Documentation/pbs/CURRENT_STATE.md#-current-authority)).

**Applies to:** the Rust workspace (`crates/date-core`, `src-tauri`), the desktop UI (`ui/`), the Mobile & Web PWA (`mobile/`), `scripts/`, CI and documentation.
**Sibling/reference:** `CipherVaults/Percentage-Calculator-Tool` v2.2.1. Its architecture, hardening and design system are mirrored here deliberately.

## 🚪 Read the smallest sufficient context

1. The owner's request, then [Current State](Documentation/pbs/CURRENT_STATE.md) and [Continuation](Documentation/pbs/CONTINUATION_STATE.md).
2. [Source & Ownership Map](Documentation/pbs/SOURCE_OWNERSHIP_MAP.md) for who owns each answer.
3. Design: [`Documentation/specs/0- FROZEN_DECISIONS.md`](Documentation/specs/0-%20FROZEN_DECISIONS.md) **overrides** specs 1–3 wherever they disagree. Spec 4 is the critique that motivated the overrides.

## ⚙️ Project conventions

- **Engine purity.** `date-core` is pure: serde only, `#![forbid(unsafe_code)]`, no clock, no time zone, no locale, no panics on any input. "Today"/"now" are always inputs.
- **One engine, two languages.** The mobile JS engine is a line-by-line mirror of `date-core`. It lives between `/* date-core:begin v1.0.0 */` and `/* date-core:end */` in `mobile/index.html` and must never reference `Date`, `Intl`, `toISOString` or `getTimezoneOffset`. Any change to engine behaviour changes both sides and the fixtures in the same commit.
- **Fixtures.** `tests/fixtures/vectors.json` is hand-verified and is never regenerated to make code pass. `tests/fixtures/golden.json` is regenerated only for an intentional engine change (`cargo run -p date-core --example gen_golden -- --write`), and CI runs `--check`.
- **Result envelope.** `#[serde(tag = "ok")]` with string tags `"true"`/`"false"`; camelCase JSON; `deny_unknown_fields` on every request struct.
- **DOM safety.** Use `textContent`/`createElement`/`replaceChildren` only. No `innerHTML`, `outerHTML`, `eval` or `new Function`. Mobile JS toggles classes and never sets `.style`.
- **Mobile CSP.** Any byte change inside the mobile inline `<style>` or `<script>` requires recomputing its SHA-256 (Base64) in the CSP `<meta>`. Never put `frame-ancestors` in a meta CSP. Bump `CACHE_NAME` in `mobile/sw.js` on every mobile change.
- **Line endings.** `git config core.autocrlf false`. `.gitattributes` forces LF on web, script and fixture files, because the CSP hashes are byte-exact.
- **Version** must match in `tauri.conf.json`, both `Cargo.toml` files, mobile `APP_VERSION`, the `sw.js` cache name and the footers.
- **Windows.** Run Cargo/Tauri from **PowerShell**, never Git Bash: Git Bash's `/usr/bin/link` shadows the MSVC linker. Node and gh are fine in either shell.

## 🌿 Git & GitHub rhythm

Commits follow the owner's *Git & GitHub Rhythm* (Claude skill `git-github-rhythm`).

- **Remote:** public `CipherVaults/Date-Calculator-Tool`. Work happens on `dev`. `main` is reached only by PR from `dev`.
- **Who does what:**
  - The coordinating maintainer integrates, commits and pushes `dev`. Parallel agents edit files but do not commit.
  - Merging to `main`, tags and releases need the owner's explicit yes.
- **One coherent step per commit.** Stage explicit paths, never a blanket `git add -A` while other agents are editing. Read the staged diff before committing.
- **Message format:**
  - A plain-language subject.
  - A bullet body with `Why / Changed / Checks / Remaining`. `Checks` names the real commands and results, and says what was not run.
  - Unfinished work is preserved as `WIP:`.
  - Every commit ends with the required `Co-Authored-By:` trailer.
- **Push and verify:**
  - Push after each verified milestone and before a session ends.
  - Verify with `git ls-remote origin dev` against `git rev-parse HEAD`.
  - Never force-push.
- **Receipts** (published SHA, checks, not covered) go in the closing report and, for milestones, in the [Execution & Coding Ledger](Documentation/pbs/EXECUTION_AND_CODING_LEDGER.md).

## 🔐 Permission checks

- Private per-device state must not be read, cleared or exported without owner authority: `%APPDATA%\com.datecalculator.tool\{history,settings}.json`, browser `localStorage` and PWA caches.
- Pushing to `main`, tags and releases is outward-facing. The release job auto-publishes on a green push to `main`, so merging requires the owner's explicit yes.

## ✅ Verification workflow

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo run -p date-core --example gen_golden --locked -- --check
node scripts/safety-eval.mjs --json target/safety-eval-system-card.json
cargo run -p date-calculator-tool --locked -- --smoke-test
```

The full CI-equivalent checks live in `.github/workflows/build.yml`. Keep the inline node check block byte-identical in all three copies (two jobs in `build.yml`, one in `pages.yml`); safety-eval `D.workflow-node-block-identical` enforces it. Create `main` only from a commit without `.github/workflows`: any push to `main` runs the release job.

## 📦 Reporting and stopping

Report the concrete result, the exact artifacts each check applied to, what was not run, and the next permitted action. Update only the PBS records whose answers changed.
