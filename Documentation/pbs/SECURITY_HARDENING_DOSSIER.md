# 🛡️ Security Hardening Dossier — Date Calculator Tool

Planned controls are carried over from Percentage-Calculator-Tool v2.2.1. Each row moves from **planned** to **implemented** to **verified** with a Ledger evidence ID.

| Control | Status | Evidence |
|---|---|---|
| Desktop CSP `connect-src 'none'`, `default-src 'self'`, no inline script/style | planned | — |
| Tauri capability `permissions: []` | implemented (scaffold) | `src-tauri/capabilities/default.json` |
| Update check via `System32\curl.exe` (WebView stays offline) | planned | — |
| Hardened JSON storage: symlink/non-regular rejection, size caps, unique temp + `sync_all` + rename, `deny_unknown_fields` | planned | — |
| Settings corruption: one-time `.bak`, defaults with update checks off | planned | — |
| History caps: 500 entries, field ≤256 B, entry `copyText` ≤1024 B, clipboard ≤4096 B; no custom holiday names in history | planned | — |
| DOM: `textContent`/`createElement` only; no `innerHTML`/`outerHTML`/`eval`/`new Function`; mobile sets no inline styles | planned | — |
| Mobile CSP pinned by SHA-256 of inline style/script; no `frame-ancestors` in meta | planned | — |
| Engine purity: no `Date`/`Intl` in the JS engine slice (static ban + vm context without them) | planned | — |
| CI: Actions pinned to 40-char SHAs, `persist-credentials: false`, read-only default token | planned | — |
| Core: `#![forbid(unsafe_code)]`, no panics on any input, bounded arithmetic | implemented (scaffold) | `crates/date-core/src/lib.rs` |
