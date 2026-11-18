#!/usr/bin/env node
// Cross-surface safety evaluation for the Date Calculator Tool (M7).
// Zero dependencies. Writes a System Card JSON with --json <path>.
//
// Adapted from the sibling Percentage Calculator Tool's scripts/safety-eval.mjs
// (Rust NDJSON bridge, seeded generators, mini-DOM sandboxes, virtual timers,
// criteria with counts and Wilson intervals, System Card), with the domain
// rewritten for dates:
//
//   A  Engine parity. One persistent Rust bridge (target/release/examples/
//      eval_bridge when it is newer than every date-core source, otherwise
//      `cargo run -q --release --locked -p date-core --example eval_bridge`,
//      which rebuilds it) against the mobile engine slice (run in node:vm with
//      `Date` and `Intl` deleted) over thousands of seeded random requests and
//      a fixed adversarial catalogue: every response must be byte-identical.
//      An independent JS oracle (summation day count, Zeller weekday, Thursday
//      ISO week, binary-search month walk, Gauss Easter, US/UK fixed rules)
//      must agree with Rust on every field it covers.
//   B  Mobile UI. mobile/index.html runs unmodified in a mini-DOM with a
//      virtual clock (a `Date` subclass plus virtual timers) under
//      TZ=America/New_York, driven card by card: live results, Enter and
//      Calculate history, restore, clear, settings flows, Egypt Fri/Sat,
//      literal rendering of hostile custom holiday names, countdown ticks
//      across both DST changes and a 23:59:59 -> 00:00 rollover, corrupt
//      localStorage -> `_bak` + defaults (corrupt history -> read-only),
//      update-link sanitising. v1.1.0 (plan A6): clickable and keyboard
//      mini calendars, Business Days range picks, the saved countdown
//      (restore, finished while closed, no writes on ticks or input, Forget,
//      bad records, other-tab sync) and the history read-only banner.
//      v1.2.0 (plan A8): collapsible and reorderable cards (collapse and
//      expand persist, pointer and keyboard reorder, quick-nav order,
//      opening a collapsed card expands it, reset, bad records, other-tab
//      sync) over a small card geometry model (getBoundingClientRect,
//      offsetParent, scroll, pointer capture, focus fixup on DOM moves).
//   C  Desktop UI. ui/index.html + ui/main.js in the same mini-DOM with a
//      mocked window.__TAURI__.core.invoke: calc_* and the other engine
//      commands go to the Rust bridge, history and settings live in memory
//      (settings validated through the bridge's validate_calendar), and the
//      v1.1.0 history_state/retry/reset and countdown_load/save/clear
//      commands follow commands.rs over an in-memory "app data directory"
//      (history.json(.bak), countdown.json(.bak), read errors), and the
//      v1.2.0 layout_load/save/reset commands do the same for layout.json.
//      The same v1.1.0 and v1.2.0 probes as slice B run here. Also runs
//      the desktop's own in-page smoke test, an out-of-order IPC race, a
//      failed set_settings revert, and compares every card's rendered text
//      with the mobile UI for the same inputs, both on the fixed walk-through
//      and on seeded random inputs per card (four-way: Rust, desktop UI,
//      mobile raw engine, mobile UI, with paired McNemar/Newcombe statistics).
//   D  Static hygiene. scripts/check-mobile.mjs (CSP hashes, LF, sinks,
//      versions, golden replay in three time zones) plus desktop CSP, local
//      markup, holiday-id parity between Rust and the mobile engine, the
//      invoke command allowlist, and .github/workflows hygiene (SHA pins,
//      persist-credentials: false, identical inline node blocks, release
//      gate), the app/engine version split, out-of-month cell contrast and
//      44 px touch targets, each check also proven to fail on planted
//      mutants; the v1.1.0 and v1.2.0 UI probes are also run on planted
//      mutants of ui/main.js and the mobile script, and each must fail.
//
// Nothing here reads or writes real user data: localStorage is an in-memory
// object, desktop history/settings live in the mock backend, and the only
// file written is the --json report.
//
// Usage: node scripts/safety-eval.mjs [--json PATH] [--stamp ISO] [--seed N]
//          [--cases N] [--ui-cases N] [--bridge PATH] [--require-clean-git]
//          [--allow-missing-rust-bridge] [--workflows-dir PATH]
// Exits non-zero when any criterion fails. There is no broken-item budget:
// the reference tolerates up to 5% "broken" items (warn at 2%), but here
// every exception or unreadable result is a recorded failure, so the
// effective broken-item tolerance is 0%.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const EVAL_VERSION = "1.2.0";
const CARD_SCHEMA = "date-calculator-tool/safety-eval-system-card";
const CARD_SCHEMA_VERSION = "1.0.0";
const APP_NAME = "Date Calculator Tool";
// The app and the date-core engine are versioned separately since v1.1.0
// (plan A4): the app moves, the engine (and golden.json) stays put.
const APP_VERSION = "1.2.0";
const ENGINE_VERSION = "1.0.0";
const DEFAULT_SEED = 20261116;
const DEFAULT_CASES = 4000;
const DEFAULT_UI_CASES = 180;
const EVAL_TZ = "America/New_York";
const CHILD_ENV = "DATE_TOOL_SAFETY_EVAL_CHILD";
const MAX_DETAILS = 8;
const Z_95 = 1.959963984540054;
const MAX_STRING_BYTES = 1024;
const MAX_REQUEST_BYTES = 65536;
const BEGIN_MARKER = `/* date-core:begin v${ENGINE_VERSION} */`;
const END_MARKER = "/* date-core:end */";
const INVALID_REQUEST =
  '{"ok":"false","error":{"code":"invalid_request","field":null,"message":"Invalid request."}}';
const ENGINE_OPS = [
  "calc_days_between",
  "calc_add_subtract",
  "calc_business_days",
  "calc_age",
  "calc_date_info",
  "calc_countdown",
  "holidays_in_range",
  "month_grid",
  "validate_calendar"
];
const RELEASE_URL = "https://github.com/CipherVaults/Date-Calculator-Tool/releases/latest";
const RELEASE_PREFIX = "https://github.com/CipherVaults/Date-Calculator-Tool/releases/";
const GITHUB_API_LATEST =
  "https://api.github.com/repos/CipherVaults/Date-Calculator-Tool/releases/latest";

// ============================================================================
// 1. CLI, time zone and provenance
// ============================================================================

function printHelp() {
  console.log(`Usage: node scripts/safety-eval.mjs [options]

Options:
  --json <path>                 Write the System Card JSON to <path>
  --stamp <iso>                 generatedAt value (default: current time)
  --seed <int>                  PRNG seed (default ${DEFAULT_SEED})
  --cases <int>                 Seeded random engine requests (default ${DEFAULT_CASES})
  --ui-cases <int>              Seeded random UI inputs per card, both surfaces (default ${DEFAULT_UI_CASES})
  --bridge <path>               eval_bridge executable to use (freshness not checked)
  --require-clean-git           Fail Slice D when the git working tree has uncommitted changes
  --allow-missing-rust-bridge   Dry inspection without the Rust bridge (never a pass)
  --workflows-dir <path>        Workflow folder for the Slice D workflow checks
                                (default .github/workflows; used to test mutants)
  --help                        Show this text
`);
}

function parseArgs(argv) {
  const opts = {
    json: null,
    stamp: null,
    seed: DEFAULT_SEED,
    cases: DEFAULT_CASES,
    uiCases: DEFAULT_UI_CASES,
    bridge: null,
    requireCleanGit: false,
    allowMissingBridge: false,
    workflowsDir: null
  };
  const need = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      console.error(`[ABORT] ${flag} needs a value.`);
      process.exit(2);
    }
    return v;
  };
  const int = (v, flag, min) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min) {
      console.error(`[ABORT] ${flag} needs an integer >= ${min}.`);
      process.exit(2);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--json") {
      opts.json = need(i++, a);
    } else if (a === "--stamp") {
      opts.stamp = need(i++, a);
      if (opts.stamp.length > 64) {
        console.error("[ABORT] --stamp is at most 64 characters.");
        process.exit(2);
      }
    } else if (a === "--seed") {
      opts.seed = int(need(i++, a), a, 0);
    } else if (a === "--cases") {
      opts.cases = int(need(i++, a), a, 100);
    } else if (a === "--ui-cases") {
      opts.uiCases = int(need(i++, a), a, 10);
    } else if (a === "--require-clean-git") {
      opts.requireCleanGit = true;
    } else if (a === "--bridge") {
      opts.bridge = resolve(need(i++, a));
    } else if (a === "--allow-missing-rust-bridge") {
      opts.allowMissingBridge = true;
    } else if (a === "--workflows-dir") {
      opts.workflowsDir = resolve(need(i++, a));
    } else {
      console.error(`[ABORT] Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

// The UI slices need a zone with DST, so the whole run happens in a child
// process with TZ fixed (Node reads TZ at startup).
function reexecInEvalTimeZone() {
  if (process.env[CHILD_ENV] === "1") return;
  const child = spawnSync(process.execPath, [SELF, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, TZ: EVAL_TZ, [CHILD_ENV]: "1" }
  });
  if (child.error) {
    console.error(`[ABORT] could not start the evaluation process: ${child.error.message}`);
    process.exit(2);
  }
  process.exit(child.status ?? 1);
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sha256File(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? sha256Text(readFileSync(p)) : null;
}

function gitMetadata() {
  const run = (args) => {
    const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const status = run(["status", "--porcelain"]);
  const dirty = status === null ? null : status.split("\n").filter(Boolean);
  return {
    commit: run(["rev-parse", "HEAD"]),
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirtyFiles: dirty === null ? null : dirty.length,
    dirtyList: dirty === null ? [] : dirty.slice(0, 50)
  };
}

// ============================================================================
// 2. Report model and statistics
// ============================================================================

function wilsonCi(k, n, z = Z_95) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// Paired statistics, copied from the reference (exact McNemar, Newcombe
// Method 10 interval for a paired difference, Holm-Bonferroni).
function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  let sum = 0;
  for (let i = 1; i <= Math.min(k, n - k); i += 1) {
    sum += Math.log(n - i + 1) - Math.log(i);
  }
  return sum;
}

function mcnemarExactP(b, c) {
  const discordant = b + c;
  if (discordant === 0) return 1.0;
  const minor = Math.min(b, c);
  const logHalf = -discordant * Math.LN2;
  let tail = 0;
  for (let i = 0; i <= minor; i += 1) {
    tail += Math.exp(logChoose(discordant, i) + logHalf);
  }
  return Math.min(1.0, Math.max(0.0, 2 * tail));
}

// a = both pass, b = base only, c = candidate only, d = both fail.
function newcombePairedCi(a, b, c, d, z = Z_95) {
  const n = a + b + c + d;
  if (n <= 0) {
    return { n: 0, delta: 0, newcombe_ci: [0, 0], phi: 0, mcnemar_p: 1 };
  }
  const pBase = (a + b) / n;
  const pCand = (a + c) / n;
  const delta = pCand - pBase;
  const [l1, u1] = wilsonCi(a + b, n, z);
  const [l2, u2] = wilsonCi(a + c, n, z);
  const d1 = pBase - l1;
  const e1 = u1 - pBase;
  const d2 = pCand - l2;
  const e2 = u2 - pCand;
  const denom = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
  let phi = 0;
  if (denom > 0) {
    const num = a * d - b * c;
    const adj = num > 0 ? Math.max(num - n / 2, 0) : num;
    phi = Math.max(-1, Math.min(1, adj / denom));
  }
  const lowSq = Math.max(0, e1 * e1 - 2 * phi * e1 * d2 + d2 * d2);
  const highSq = Math.max(0, d1 * d1 - 2 * phi * d1 * e2 + e2 * e2);
  return {
    n,
    both_pass: a,
    base_only: b,
    cand_only: c,
    both_fail: d,
    base_rate: round6(pBase),
    cand_rate: round6(pCand),
    delta: round6(delta),
    newcombe_ci: [round6(Math.max(-1, delta - Math.sqrt(lowSq))), round6(Math.min(1, delta + Math.sqrt(highSq)))],
    phi: round6(phi),
    mcnemar_p: mcnemarExactP(b, c)
  };
}

function holmBonferroni(pValues) {
  const m = pValues.length;
  if (m === 0) return [];
  const order = pValues.map((p, idx) => ({ p, idx })).sort((x, y) => x.p - y.p);
  const adj = new Array(m).fill(0);
  let runningMax = 0;
  for (let rank = 0; rank < m; rank += 1) {
    const scaled = order[rank].p * (m - rank);
    runningMax = Math.min(1, Math.max(runningMax, scaled));
    adj[order[rank].idx] = runningMax;
  }
  return adj;
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

class Criterion {
  constructor(id, description) {
    this.id = id;
    this.description = description;
    this.passed = 0;
    this.failed = 0;
    this.details = [];
    this.notes = [];
    this.stats = null;
  }

  check(ok, detail) {
    if (ok) {
      this.passed++;
    } else {
      this.failed++;
      if (this.details.length < MAX_DETAILS) {
        const text = typeof detail === "function" ? detail() : String(detail ?? "failed");
        this.details.push(text.length > 600 ? `${text.slice(0, 600)}…` : text);
      }
    }
    return Boolean(ok);
  }

  fail(detail) {
    return this.check(false, detail);
  }

  note(text) {
    if (this.notes.length < MAX_DETAILS) this.notes.push(String(text));
  }

  get ok() {
    return this.failed === 0 && this.passed > 0;
  }

  toJSON() {
    const n = this.passed + this.failed;
    const [lo, hi] = wilsonCi(this.passed, n);
    const details = this.details.slice();
    if (n === 0) details.push("no assertions ran");
    const out = {
      id: this.id,
      description: this.description,
      passed: this.passed,
      failed: this.failed,
      ok: this.ok,
      passRate: n ? round6(this.passed / n) : null,
      wilson95: [round6(lo), round6(hi)],
      details,
      notes: this.notes
    };
    if (this.stats !== null) out.stats = this.stats;
    return out;
  }
}

class Slice {
  constructor(key, name, description) {
    this.key = key;
    this.name = name;
    this.description = description;
    this.criteria = [];
    this.ms = 0;
  }

  criterion(id, description) {
    const c = new Criterion(`${this.key}.${id}`, description);
    this.criteria.push(c);
    return c;
  }

  get ok() {
    return this.criteria.length > 0 && this.criteria.every((c) => c.ok);
  }

  toJSON() {
    return {
      key: this.key,
      name: this.name,
      description: this.description,
      ok: this.ok,
      ms: this.ms,
      criteria: this.criteria.map((c) => c.toJSON())
    };
  }
}

// Runs one test body; an exception is a recorded failure, never an abort.
async function guard(crit, label, fn) {
  try {
    await fn();
  } catch (err) {
    crit.fail(`${label}: threw ${err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err}`);
  }
}

// ============================================================================
// 3. Seeded randomness and small helpers
// ============================================================================

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function utf8Bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function excerpt(s, n = 240) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function firstDiff(want, got) {
  let i = 0;
  while (i < want.length && i < got.length && want[i] === got[i]) i++;
  const from = Math.max(0, i - 50);
  return `byte ${i}: rust …${want.slice(from, i + 90)} | mobile …${got.slice(from, i + 90)}`;
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${what}`)), ms);
    })
  ]);
}

const tick = () => new Promise((r) => setImmediate(r));

// ============================================================================
// 4. Rust NDJSON bridge (one persistent process, FIFO framing)
// ============================================================================

// Newest modification time over everything that feeds the eval_bridge build:
// the date-core sources, examples and manifest, the workspace manifest and
// the lock file.
function newestBridgeInput() {
  let best = { ms: 0, path: null };
  const consider = (abs) => {
    const ms = statSync(abs).mtimeMs;
    if (ms > best.ms) best = { ms, path: abs.slice(ROOT.length + 1).split("\\").join("/") };
  };
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) consider(abs);
    }
  };
  walk(join(ROOT, "crates", "date-core", "src"));
  walk(join(ROOT, "crates", "date-core", "examples"));
  for (const f of ["crates/date-core/Cargo.toml", "crates/date-core/build.rs", "Cargo.toml", "Cargo.lock"]) {
    const abs = join(ROOT, f);
    if (existsSync(abs)) consider(abs);
  }
  return best;
}

// eval_bridge answers every non-blank line with exactly one line, in order,
// so responses are matched by position; that also lets framing errors
// (malformed JSON, invalid UTF-8, over-long lines) be tested byte for byte.
class RustBridge {
  constructor(opts) {
    this.opts = opts;
    this.proc = null;
    this.queue = [];
    this.buffer = "";
    this.unexpected = [];
    this.stderr = "";
    this.closed = false;
    this.lines = 0;
    this.command = null;
    this.source = null;
  }

  // The prebuilt release example is used only when it is newer than every
  // input that can change it; otherwise `cargo run` rebuilds it first, so a
  // date-core edit can never be compared against a stale Rust build.
  locate() {
    const cargo = ["cargo", ["run", "-q", "--release", "--locked", "-p", "date-core", "--example", "eval_bridge"]];
    if (this.opts.bridge) {
      this.source = { kind: "explicit --bridge", fresh: null, note: "freshness not checked" };
      return [this.opts.bridge, []];
    }
    const exe = join(
      ROOT,
      "target",
      "release",
      "examples",
      process.platform === "win32" ? "eval_bridge.exe" : "eval_bridge"
    );
    const newest = newestBridgeInput();
    if (!existsSync(exe)) {
      this.source = { kind: "cargo run", fresh: null, note: "no prebuilt release example", newestInput: newest.path };
      return cargo;
    }
    if (statSync(exe).mtimeMs >= newest.ms) {
      this.source = { kind: "prebuilt release example", fresh: true, newestInput: newest.path };
      return [exe, []];
    }
    this.source = {
      kind: "cargo run",
      fresh: false,
      note: `the prebuilt example is older than ${newest.path}; rebuilding through cargo`,
      newestInput: newest.path
    };
    return cargo;
  }

  async start() {
    const [cmd, args] = this.locate();
    this.command = [cmd, ...args].join(" ");
    if (this.source.fresh === false) console.error(`safety-eval: ${this.source.note}`);
    this.proc = spawn(cmd, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      if (this.stderr.length < 8000) this.stderr += chunk;
    });
    this.proc.stdin.on("error", () => {});
    this.proc.on("error", (err) => {
      this.closed = true;
      this.failAll(err);
    });
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`eval_bridge exited (code ${code}, signal ${signal}) ${this.stderr.slice(-400)}`));
    });
    const warm = JSON.parse(await withTimeout(this.call("validate_calendar", { calendar: {} }), 900000, "bridge warm-up"));
    if (warm.ok !== "true") throw new Error(`bridge warm-up failed: ${JSON.stringify(warm)}`);
    return true;
  }

  onData(chunk) {
    const parts = (this.buffer + chunk).split("\n");
    this.buffer = parts.pop();
    for (const raw of parts) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const waiter = this.queue.shift();
      if (waiter) waiter.resolve(line);
      else if (this.unexpected.length < 20) this.unexpected.push(line);
    }
  }

  failAll(err) {
    for (const w of this.queue.splice(0)) w.reject(err);
  }

  // Writes raw bytes. `responses` is how many answer lines the bytes produce.
  send(data, responses = 1) {
    if (this.closed) return Promise.reject(new Error("eval_bridge is not running"));
    const waits = [];
    for (let i = 0; i < responses; i++) {
      waits.push(new Promise((resolveLine, reject) => this.queue.push({ resolve: resolveLine, reject })));
    }
    this.lines += responses;
    this.proc.stdin.write(data);
    return responses === 1 ? waits[0] : Promise.all(waits);
  }

  line(text) {
    return this.send(`${text}\n`);
  }

  // `req === undefined` drops the key, which the bridge answers with
  // invalid_request (the desktop's missing-`req` IPC case).
  call(op, req) {
    return this.line(JSON.stringify({ op, req }));
  }

  async callValue(op, req) {
    return JSON.parse(await this.call(op, req));
  }

  async result(op, req) {
    const v = await this.callValue(op, req);
    if (v.ok !== "true") throw new Error(`${op} failed in the bridge: ${JSON.stringify(v.error)}`);
    return v.result;
  }

  async close() {
    if (!this.proc || this.closed) return;
    const exited = new Promise((r) => this.proc.once("exit", r));
    this.proc.stdin.end();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000).unref())]);
    if (!this.closed) this.proc.kill();
  }
}

// ============================================================================
// 5. Mobile engine slice (node:vm, no Date, no Intl)
// ============================================================================

function readText(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

function extractEngineSlice(html) {
  const start = html.indexOf(BEGIN_MARKER);
  const end = html.indexOf(END_MARKER);
  if (start < 0 || end < 0 || end <= start || html.indexOf(BEGIN_MARKER, start + 1) >= 0) {
    throw new Error("mobile/index.html: engine markers missing or repeated");
  }
  return html.slice(start + BEGIN_MARKER.length, end);
}

function loadMobileEngine(slice) {
  const ctx = vm.createContext({});
  vm.runInContext("delete globalThis.Date; delete globalThis.Intl;", ctx);
  vm.runInContext(slice, ctx, { filename: "mobile/index.html:date-core", timeout: 20000 });
  vm.runInContext(
    `const __eval = Object.freeze({
       call: function (op, text) { return JSON.stringify(DateCore.call(op, JSON.parse(text))); },
       internal: function (name, argsText) {
         return JSON.stringify(DateCore.internal[name].apply(null, JSON.parse(argsText)));
       },
       holidayIdsProbe: function () { return typeof DateCore.internal; },
       version: function () { return DateCore.ENGINE_VERSION; },
       hasDate: function () { return typeof Date + "/" + typeof Intl; }
     });`,
    ctx
  );
  const api = vm.runInContext("__eval", ctx);
  return {
    version: api.version(),
    sandboxGlobals: api.hasDate(),
    // The mobile UI's engine(): a request over the desktop IPC cap is
    // invalid_request before the engine sees it, as on the desktop.
    call(op, req) {
      const text = JSON.stringify(req);
      if (text === undefined) return api.call(op, "null");
      if (utf8Bytes(text) > MAX_REQUEST_BYTES) return INVALID_REQUEST;
      return api.call(op, text);
    },
    callText(op, text) {
      return api.call(op, text);
    },
    internal(name, args) {
      return JSON.parse(api.internal(name, JSON.stringify(args)));
    }
  };
}

// ============================================================================
// 6. Independent oracle (different algorithms from date-core, spec-derived)
// ============================================================================

const Oracle = (() => {
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const MONTHS = [
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = (y, m) => (m === 2 && isLeap(y) ? 29 : MONTH_DAYS[m - 1]);
  // Days from 0001-01-01 to Jan 1 of year y, by counting leap years.
  const daysBeforeYear = (y) => {
    const p = y - 1;
    return 365 * p + Math.floor(p / 4) - Math.floor(p / 100) + Math.floor(p / 400);
  };
  const EPOCH = daysBeforeYear(1970);
  const toDays = (y, m, d) =>
    daysBeforeYear(y) + BEFORE_MONTH[m - 1] + (m > 2 && isLeap(y) ? 1 : 0) + (d - 1) - EPOCH;
  const MIN_DAY = toDays(1, 1, 1);
  const MAX_DAY = toDays(9999, 12, 31);

  function fromDays(z) {
    let y = Math.floor((z + EPOCH) / 365.2425) + 1;
    while (toDays(y, 1, 1) > z) y--;
    while (toDays(y + 1, 1, 1) <= z) y++;
    let m = 12;
    while (m > 1 && toDays(y, m, 1) > z) m--;
    return { y, m, d: z - toDays(y, m, 1) + 1 };
  }

  const iso = (y, m, d) => `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
  const isoOfDay = (z) => {
    const c = fromDays(z);
    return iso(c.y, c.m, c.d);
  };

  // Zeller's congruence (Gregorian), mapped to ISO 1 = Monday .. 7 = Sunday.
  function weekdayCivil(y, m, d) {
    let mm = m;
    let yy = y;
    if (mm < 3) {
      mm += 12;
      yy -= 1;
    }
    const K = ((yy % 100) + 100) % 100;
    const J = Math.floor(yy / 100);
    const h = (((d + Math.floor((13 * (mm + 1)) / 5) + K + Math.floor(K / 4) + Math.floor(J / 4) + 5 * J) % 7) + 7) % 7;
    return ((h + 5) % 7) + 1;
  }
  const weekday = (z) => {
    const c = fromDays(z);
    return weekdayCivil(c.y, c.m, c.d);
  };

  // ISO week through the Thursday of the same week.
  function isoWeek(z) {
    const thursday = z - weekday(z) + 4;
    const ty = fromDays(thursday).y;
    return { year: ty, week: Math.floor((thursday - toDays(ty, 1, 1)) / 7) + 1 };
  }
  const isoWeeksInYear = (y) => isoWeek(toDays(y, 12, 28)).week;

  function addMonths(c, k, rule) {
    const t = c.y * 12 + (c.m - 1) + k;
    const ny = Math.floor(t / 12);
    const nm = t - ny * 12 + 1;
    if (rule === "mar1" && c.m === 2 && c.d === 29 && nm === 2 && !isLeap(ny)) {
      return { y: ny, m: 3, d: 1, clamped: true };
    }
    const nd = Math.min(c.d, dim(ny, nm));
    return { y: ny, m: nm, d: nd, clamped: nd !== c.d };
  }
  const anniversary = (a, k, rule) => {
    const r = addMonths(fromDays(a), k, rule);
    return toDays(r.y, r.m, r.d);
  };

  // Largest M with anniversary(a, M) <= b, by binary search (date-core uses
  // a closed form with one correction step).
  function ymdBetween(a, b, rule) {
    let lo = 0;
    let hi = 12 * 10002;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (anniversary(a, mid, rule) <= b) lo = mid;
      else hi = mid - 1;
    }
    return { years: Math.floor(lo / 12), months: lo % 12, days: b - anniversary(a, lo, rule), totalMonths: lo };
  }

  const trimAscii = (s) => s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");

  function parseDate(raw) {
    const s = trimAscii(raw);
    if (s === "") return { code: "missing_date" };
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return { code: "invalid_date_format" };
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(5, 7));
    const d = Number(s.slice(8, 10));
    if (y === 0) return { code: "date_out_of_range" };
    if (m < 1 || m > 12) return { code: "invalid_month" };
    if (d < 1 || d > dim(y, m)) return { code: "invalid_day" };
    return { z: toDays(y, m, d), iso: s };
  }

  const AMOUNT_MAX = { years: 9999, months: 119988, weeks: 521722, days: 3652058 };
  function parseAmount(raw, field) {
    const s = trimAscii(raw);
    if (s === "") return { v: 0 };
    if (!/^[+-]?[0-9]+$/.test(s)) return { code: "invalid_amount" };
    const neg = s[0] === "-";
    // Hand-verified vector P14c: the 15-digit cap counts leading zeros
    // (DATE_MATH_SPEC §3.3 says they are stripped first; the vectors win).
    const raw15 = s.replace(/^[+-]/, "");
    if (raw15.length > 15) return { code: "amount_out_of_range" };
    const digits = raw15.replace(/^0+/, "");
    const v = digits === "" ? 0 : Number(digits) * (neg ? -1 : 1);
    if (Math.abs(v) > AMOUNT_MAX[field]) return { code: "amount_out_of_range" };
    return { v: v === 0 ? 0 : v };
  }

  function parseTime(raw, required) {
    const s = trimAscii(raw);
    if (s === "") return required ? { code: "missing_time" } : { secs: 0, text: "00:00:00" };
    const m = /^([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$/.exec(s);
    if (!m) return { code: "invalid_time" };
    const hh = Number(m[1]);
    const mi = Number(m[2]);
    const ss = m[3] === undefined ? 0 : Number(m[3]);
    if (hh > 23 || mi > 59 || ss > 59) return { code: "invalid_time" };
    return { secs: hh * 3600 + mi * 60 + ss, text: `${pad2(hh)}:${pad2(mi)}:${pad2(ss)}` };
  }

  // Gauss's Easter algorithm with its two exceptions (date-core uses the
  // anonymous Meeus/Jones/Butcher algorithm).
  function easter(Y) {
    const a = Y % 19;
    const b = Y % 4;
    const c = Y % 7;
    const k = Math.floor(Y / 100);
    const p = Math.floor((13 + 8 * k) / 25);
    const q = Math.floor(k / 4);
    const M = (((15 - p + k - q) % 30) + 30) % 30;
    const N = (((4 + k - q) % 7) + 7) % 7;
    const d = (19 * a + M) % 30;
    const e = (2 * b + 4 * c + 6 * d + N) % 7;
    let month = 3;
    let day = 22 + d + e;
    if (day > 31) {
      month = 4;
      day = d + e - 9;
    }
    if (month === 4 && day === 26) day = 19;
    if (month === 4 && day === 25 && d === 28 && e === 6 && (11 * M + 11) % 30 < 19) day = 18;
    return toDays(Y, month, day);
  }

  function nthWeekday(y, m, isoWd, n) {
    const first = toDays(y, m, 1);
    const offset = (isoWd - weekday(first) + 7) % 7;
    return first + offset + 7 * (n - 1);
  }
  function lastWeekday(y, m, isoWd) {
    const last = toDays(y, m, dim(y, m));
    return last - ((weekday(last) - isoWd + 7) % 7);
  }

  function usInstances(y) {
    if (y < 1971 || y > 2199) return [];
    const out = [];
    const add = (id, actual) => {
      const wd = weekday(actual);
      const date = wd === 6 ? actual - 1 : wd === 7 ? actual + 1 : actual;
      out.push({ id, date, actual });
    };
    add("newYearsDay", toDays(y, 1, 1));
    if (y >= 1986) add("mlkDay", nthWeekday(y, 1, 1, 3));
    add("washingtonsBirthday", nthWeekday(y, 2, 1, 3));
    add("memorialDay", lastWeekday(y, 5, 1));
    if (y >= 2021) add("juneteenth", toDays(y, 6, 19));
    add("independenceDay", toDays(y, 7, 4));
    add("laborDay", nthWeekday(y, 9, 1, 1));
    add("columbusDay", nthWeekday(y, 10, 1, 2));
    add("veteransDay", y <= 1977 ? nthWeekday(y, 10, 1, 4) : toDays(y, 11, 11));
    add("thanksgivingDay", nthWeekday(y, 11, 4, 4));
    add("christmasDay", toDays(y, 12, 25));
    return out;
  }

  // US federal holidays whose observed date falls in year y.
  function usHolidaysInYear(y) {
    const lo = toDays(y, 1, 1);
    const hi = toDays(y, 12, 31);
    return [y - 1, y, y + 1]
      .flatMap(usInstances)
      .filter((h) => h.date >= lo && h.date <= hi)
      .map((h) => `${h.id}|${isoOfDay(h.date)}|${isoOfDay(h.actual)}`)
      .sort();
  }

  const plain = (calendar) => {
    if (calendar === undefined) return { weekend: [6, 7] };
    if (calendar === null || typeof calendar !== "object" || Array.isArray(calendar)) return null;
    const keys = Object.keys(calendar);
    if (keys.some((k) => k !== "weekend")) return null;
    const w = keys.includes("weekend") ? calendar.weekend : [6, 7];
    if (!Array.isArray(w) || !w.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) return null;
    if (new Set(w).size !== w.length || w.length === 7) return null;
    return { weekend: w };
  };

  const stringsFit = (v) => {
    if (typeof v === "string") return utf8Bytes(v) <= MAX_STRING_BYTES && !/[\ud800-\udfff]/.test(v);
    if (Array.isArray(v)) return v.every(stringsFit);
    if (v && typeof v === "object") return Object.values(v).every(stringsFit);
    return true;
  };

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
  const str = (v) => (v === undefined ? "" : v);
  const isStrOrUndef = (v) => v === undefined || typeof v === "string";

  // Each returns null (not covered), {code} or {fields}.
  const ops = {
    calc_days_between(req) {
      if (!isObj(req) || !onlyKeys(req, ["startDate", "endDate", "includeEndDay"])) return null;
      if (!isStrOrUndef(req.startDate) || !isStrOrUndef(req.endDate)) return null;
      if (req.includeEndDay !== undefined && typeof req.includeEndDay !== "boolean") return null;
      const a = parseDate(str(req.startDate));
      if (a.code) return { code: a.code, field: "startDate" };
      const b = parseDate(str(req.endDate));
      if (b.code) return { code: b.code, field: "endDate" };
      const inc = req.includeEndDay === true;
      const lo = Math.min(a.z, b.z);
      const hi = Math.max(a.z, b.z);
      const hiX = hi + (inc ? 1 : 0);
      const total = hiX - lo;
      const dir = a.z === b.z ? "same" : a.z < b.z ? "forward" : "backward";
      const ymd = ymdBetween(lo, hiX, "feb28");
      return {
        fields: {
          startDate: a.iso,
          endDate: b.iso,
          direction: dir,
          totalDays: total,
          signedDays: dir === "backward" ? -total : total,
          years: ymd.years,
          months: ymd.months,
          days: ymd.days,
          totalMonths: ymd.totalMonths,
          weeks: Math.floor(total / 7),
          weekRemainderDays: total % 7,
          totalHours: total * 24,
          totalMinutes: total * 1440,
          totalSeconds: total * 86400,
          startWeekday: WEEKDAYS[weekday(a.z)],
          endWeekday: WEEKDAYS[weekday(b.z)]
        }
      };
    },

    calc_add_subtract(req) {
      const keys = ["date", "operation", "years", "months", "weeks", "days", "businessDays", "calendar"];
      if (!isObj(req) || !onlyKeys(req, keys)) return null;
      if (req.businessDays === true || (req.businessDays !== undefined && typeof req.businessDays !== "boolean")) return null;
      if (req.operation !== "add" && req.operation !== "subtract") return null;
      if (!["date", "years", "months", "weeks", "days"].every((k) => isStrOrUndef(req[k]))) return null;
      if (!stringsFit(req) || (req.calendar !== undefined && !isObj(req.calendar))) return null;
      // Only cover requests with at most one bad field (field order aside).
      const d = parseDate(str(req.date));
      const amounts = {};
      const bad = [];
      if (d.code) bad.push({ code: d.code, field: "date" });
      for (const f of ["years", "months", "weeks", "days"]) {
        const p = parseAmount(str(req[f]), f);
        if (p.code) bad.push({ code: p.code, field: f });
        else amounts[f] = p.v;
      }
      if (bad.length > 1) return null;
      if (bad.length === 1) return bad[0];
      const s = req.operation === "add" ? 1 : -1;
      const Y = s * amounts.years;
      const Mo = s * amounts.months;
      const W = s * amounts.weeks;
      const D = s * amounts.days;
      const c1 = addMonths(fromDays(d.z), Y * 12 + Mo, "feb28");
      const result = toDays(c1.y, c1.m, c1.d) + W * 7 + D;
      if (result < MIN_DAY || result > MAX_DAY) return { code: "result_out_of_range" };
      return {
        fields: {
          years: Y,
          months: Mo,
          weeks: W,
          days: D,
          resultDate: isoOfDay(result),
          resultWeekday: WEEKDAYS[weekday(result)],
          calendarDaysDelta: result - d.z,
          monthClamped: c1.clamped && Y * 12 + Mo !== 0,
          businessDayCount: null
        }
      };
    },

    calc_business_days(req) {
      if (!isObj(req) || !onlyKeys(req, ["startDate", "endDate", "includeEndDay", "calendar"])) return null;
      if (!isStrOrUndef(req.startDate) || !isStrOrUndef(req.endDate) || !stringsFit(req)) return null;
      if (req.includeEndDay !== undefined && typeof req.includeEndDay !== "boolean") return null;
      const cal = plain(req.calendar);
      if (!cal) return null;
      const a = parseDate(str(req.startDate));
      const b = parseDate(str(req.endDate));
      if (a.code || b.code) return null;
      const lo = Math.min(a.z, b.z);
      const hiX = Math.max(a.z, b.z) + (req.includeEndDay === true ? 1 : 0);
      if (hiX - lo > 4000) return null;
      let business = 0;
      let weekendDays = 0;
      for (let z = lo; z < hiX; z++) {
        if (cal.weekend.includes(weekday(z))) weekendDays++;
        else business++;
      }
      return {
        fields: {
          calendarDays: hiX - lo,
          businessDays: business,
          weekendDays,
          holidayDays: 0,
          signedBusinessDays: a.z > b.z ? -business : business,
          weekend: cal.weekend.slice().sort((x, y) => x - y)
        }
      };
    },

    calc_age(req) {
      if (!isObj(req) || !onlyKeys(req, ["birthDate", "asOfDate", "leapDayRule"])) return null;
      if (!isStrOrUndef(req.birthDate) || !isStrOrUndef(req.asOfDate) || !stringsFit(req)) return null;
      const rule = req.leapDayRule === undefined ? "feb28" : req.leapDayRule;
      if (rule !== "feb28" && rule !== "mar1") return null;
      const b = parseDate(str(req.birthDate));
      if (b.code) return { code: b.code, field: "birthDate" };
      const a = parseDate(str(req.asOfDate));
      if (a.code) return { code: a.code, field: "asOfDate" };
      if (b.z > a.z) return { code: "birth_after_as_of" };
      const ymd = ymdBetween(b.z, a.z, rule);
      const total = a.z - b.z;
      let next;
      if (ymd.years >= 1 && anniversary(b.z, 12 * ymd.years, rule) === a.z) {
        next = { date: isoOfDay(a.z), turningAge: ymd.years, daysUntil: 0, isToday: true };
      } else {
        const nb = anniversary(b.z, 12 * (ymd.years + 1), rule);
        next = nb > MAX_DAY ? null : { date: isoOfDay(nb), turningAge: ymd.years + 1, daysUntil: nb - a.z, isToday: false };
      }
      return {
        fields: {
          years: ymd.years,
          months: ymd.months,
          days: ymd.days,
          totalMonths: ymd.totalMonths,
          totalDays: total,
          totalWeeks: Math.floor(total / 7),
          weekRemainderDays: total % 7,
          totalSeconds: total * 86400,
          bornWeekday: WEEKDAYS[weekday(b.z)],
          "nextBirthday.date": next ? next.date : undefined,
          "nextBirthday.turningAge": next ? next.turningAge : undefined,
          "nextBirthday.daysUntil": next ? next.daysUntil : undefined,
          "nextBirthday.isToday": next ? next.isToday : undefined,
          nextBirthday: next ? undefined : null
        }
      };
    },

    calc_date_info(req) {
      if (!isObj(req) || !onlyKeys(req, ["date", "today"])) return null;
      if (!isStrOrUndef(req.date) || !stringsFit(req)) return null;
      if (req.today !== undefined && req.today !== null && typeof req.today !== "string") return null;
      const d = parseDate(str(req.date));
      if (d.code) return { code: d.code, field: "date" };
      let fromToday = null;
      if (typeof req.today === "string") {
        const t = parseDate(req.today);
        if (t.code) return null;
        fromToday = d.z - t.z;
      }
      const c = fromDays(d.z);
      const doy = d.z - toDays(c.y, 1, 1) + 1;
      const diy = isLeap(c.y) ? 366 : 365;
      const wk = isoWeek(d.z);
      return {
        fields: {
          weekday: WEEKDAYS[weekday(d.z)],
          isoWeekday: weekday(d.z),
          year: c.y,
          month: c.m,
          day: c.d,
          monthName: MONTHS[c.m],
          dayOfYear: doy,
          daysInYear: diy,
          daysRemainingInYear: diy - doy,
          daysInMonth: dim(c.y, c.m),
          daysRemainingInMonth: dim(c.y, c.m) - c.d,
          quarter: Math.ceil(c.m / 3),
          isLeapYear: isLeap(c.y),
          isoWeekYear: wk.year,
          isoWeek: wk.week,
          isoWeeksInYear: isoWeeksInYear(wk.year),
          isoWeekText: `${String(wk.year).padStart(4, "0")}-W${pad2(wk.week)}-${weekday(d.z)}`,
          ordinalText: `${String(c.y).padStart(4, "0")}-${String(doy).padStart(3, "0")}`,
          epochDay: d.z,
          unixTimestamp: d.z * 86400,
          julianDayNumber: d.z + 2440588,
          daysFromToday: fromToday
        }
      };
    },

    calc_countdown(req) {
      if (!isObj(req) || !onlyKeys(req, ["now", "target"])) return null;
      const moment = (m) => {
        if (m === undefined) return { date: "", time: "", off: 0 };
        if (!isObj(m) || !onlyKeys(m, ["date", "time", "utcOffsetMinutes"])) return null;
        if (!isStrOrUndef(m.date) || !isStrOrUndef(m.time)) return null;
        const off = m.utcOffsetMinutes === undefined ? 0 : m.utcOffsetMinutes;
        if (!Number.isSafeInteger(off)) return null;
        return { date: str(m.date), time: str(m.time), off };
      };
      const n = moment(req.now);
      const t = moment(req.target);
      if (!n || !t || !stringsFit(req)) return null;
      const nd = parseDate(n.date);
      const nt = parseTime(n.time, true);
      const td = parseDate(t.date);
      const tt = parseTime(t.time, false);
      const problems = [nd.code, nt.code, Math.abs(n.off) > 1080 ? "invalid_utc_offset" : null, td.code, tt.code,
        Math.abs(t.off) > 1080 ? "invalid_utc_offset" : null].filter(Boolean);
      if (problems.length > 1) return null;
      if (problems.length === 1) return { code: problems[0] };
      const N = nd.z * 86400 + nt.secs - n.off * 60;
      const T = td.z * 86400 + tt.secs - t.off * 60;
      const total = T - N;
      const A = Math.abs(total);
      return {
        fields: {
          targetTime: tt.text,
          nowTime: nt.text,
          targetWeekday: WEEKDAYS[weekday(td.z)],
          status: total > 0 ? "future" : total < 0 ? "past" : "now",
          totalSeconds: total,
          days: Math.floor(A / 86400),
          hours: Math.floor((A % 86400) / 3600),
          minutes: Math.floor((A % 3600) / 60),
          seconds: A % 60,
          totalHours: Math.floor(A / 3600),
          totalMinutes: Math.floor(A / 60)
        }
      };
    },

    month_grid(req) {
      if (!isObj(req) || !onlyKeys(req, ["year", "month", "firstDayOfWeek", "today", "calendar"])) return null;
      if (!Number.isSafeInteger(req.year) || !Number.isSafeInteger(req.month)) return null;
      if (req.year < 1 || req.year > 9999 || req.month < 1 || req.month > 12) return null;
      const fdw = req.firstDayOfWeek === undefined ? "monday" : req.firstDayOfWeek;
      if (fdw !== "monday" && fdw !== "sunday") return null;
      if (req.today !== undefined && req.today !== null) return null;
      const cal = plain(req.calendar);
      if (!cal) return null;
      const first = toDays(req.year, req.month, 1);
      const startWd = fdw === "sunday" ? 7 : 1;
      const start = first - ((weekday(first) - startWd + 7) % 7);
      return { grid: { start, dim: dim(req.year, req.month), weekend: cal.weekend, first } };
    }
  };

  return {
    isLeap,
    dim,
    toDays,
    fromDays,
    isoOfDay,
    weekday,
    isoWeek,
    easter,
    usHolidaysInYear,
    parseDate,
    WEEKDAYS,
    MIN_DAY,
    MAX_DAY,
    expect(op, req) {
      try {
        if (!stringsFit(req)) {
          return Oracle_oversized(req) ? { code: "invalid_request" } : null;
        }
        return ops[op] ? ops[op](req) : null;
      } catch {
        return null;
      }
    }
  };
})();

// A request carrying a string over the 1,024-byte cap (and no lone
// surrogate) is invalid_request whatever else it holds.
function Oracle_oversized(req) {
  let over = false;
  let surrogate = false;
  const walk = (v) => {
    if (typeof v === "string") {
      if (/[\ud800-\udfff]/.test(v.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) surrogate = true;
      if (utf8Bytes(v) > MAX_STRING_BYTES) over = true;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(req);
  return over && !surrogate;
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

// Compares one oracle expectation with a parsed envelope. Returns null when
// they agree, otherwise a short reason.
function compareOracle(exp, env) {
  if (exp.code) {
    if (env.ok !== "false") return `expected error ${exp.code}, got ok`;
    if (env.error.code !== exp.code) return `expected error ${exp.code}, got ${env.error.code}`;
    if (exp.field && env.error.field !== exp.field) return `expected field ${exp.field}, got ${env.error.field}`;
    return null;
  }
  if (env.ok !== "true") return `expected ok, got ${env.error && env.error.code}`;
  if (exp.grid) {
    const cells = env.result.cells;
    if (!Array.isArray(cells) || cells.length !== 42) return `grid has ${cells && cells.length} cells`;
    let inMonth = 0;
    for (let i = 0; i < 42; i++) {
      const z = exp.grid.start + i;
      const c = cells[i];
      if (c.date !== Oracle.isoOfDay(z)) return `cell ${i} is ${c.date}, expected ${Oracle.isoOfDay(z)}`;
      if (c.isoWeekday !== Oracle.weekday(z)) return `cell ${i} weekday ${c.isoWeekday}`;
      if (c.weekend !== exp.grid.weekend.includes(Oracle.weekday(z))) return `cell ${i} weekend flag`;
      if (c.inMonth) inMonth++;
    }
    if (inMonth !== exp.grid.dim) return `inMonth cells ${inMonth} != ${exp.grid.dim}`;
    return null;
  }
  for (const [path, want] of Object.entries(exp.fields)) {
    if (want === undefined) continue;
    const got = getPath(env.result, path);
    if (canonical(got) !== canonical(want)) return `${path}: expected ${canonical(want)}, got ${canonical(got)}`;
  }
  return null;
}

// ============================================================================
// 7. Seeded request generators
// ============================================================================

const EDGE_YEARS = [1, 2, 4, 99, 100, 399, 400, 1582, 1600, 1700, 1752, 1899, 1900, 1970, 1971, 1999, 2000,
  2020, 2024, 2025, 2026, 2027, 2100, 2199, 2200, 2400, 9998, 9999];
const BAD_DATES = ["", " ", "2024-02-30", "2023-02-29", "1900-02-29", "0000-01-01", "10000-01-01", "2024-13-01",
  "2024-00-10", "2024-01-00", "2024-01-32", "2024-1-05", "2024/01/05", "２０２４-01-01", "٢٠٢٤-٠١-٠١",
  "۲۰۲۴-01-01", " 2024-01-05 ", "\t2024-01-05\n", "\r\n2024-01-05", " 2024-01-05", "﻿2024-01-05",
  "2024-01-05　", "2024-01-05T00:00", "+2024-01-05", "-0001-01-01", "2024-01-5", "99999-01-01", "2024-01-05x",
  "24-01-05", "2024-01", "2024-01-05\u0000", "nan", "null", "2024—01—05", "2024-01-05 ", "\u00002024-01-05"];
const BAD_AMOUNTS = ["1.5", "1e3", "1,000", "+", "-", "--1", "+-1", "٣", "۳", "１", "0x10", " 12 ", " 12", "12 ",
  "9".repeat(16), "9".repeat(40), "-" + "9".repeat(16), "0".repeat(30) + "7", "1_000", "Infinity", "NaN", "\t-5\n",
  "+0", "-0", "007", "999999999999999"];
const HOSTILE_NAMES = ["<img src=x onerror=alert(1)>", "</script><script>alert(1)</script>", "<b>x</b>",
  "\"'><svg onload=alert(1)>", "عيد الفطر", "Company day", "a".repeat(60), "a".repeat(61), "", "   ", "x\u0000y",
  "line\nbreak", "🎉 party", "__proto__", "constructor"];
// Every rule id declared in crates/date-core/src/holidays/<preset>.rs, so the
// excludedHolidays generator can pick any of them (and a typo cannot creep in).
// D.holiday-id-parity checks the same declarations against the mobile engine.
function declaredHolidayIds() {
  const out = {};
  for (const preset of ["us", "uk", "eg"]) {
    const text = readText(`crates/date-core/src/holidays/${preset}.rs`);
    out[preset] = [...new Set([...text.matchAll(/\bid:\s*"([A-Za-z0-9]+)"/g)].map((m) => m[1]))];
  }
  return out;
}
const KNOWN_IDS = declaredHolidayIds();
const HIJRI_EVENT_NAMES = ["islamicNewYear", "mawlid", "eidAlFitr", "eidAlAdha"];

function makeGenerators(rng) {
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const chance = (p) => rng() < p;
  const civilIso = (c) => Oracle.isoOfDay(Oracle.toDays(c.y, c.m, c.d));

  function validCivil() {
    const r = rng();
    const y = r < 0.12 ? int(1, 9999) : r < 0.78 ? int(1900, 2199) : r < 0.93 ? pick(EDGE_YEARS) : int(1, 2200);
    const m = int(1, 12);
    const last = Oracle.dim(y, m);
    const d = chance(0.3) ? pick([1, last, Math.min(28, last), Math.min(29, last), Math.min(30, last)]) : int(1, last);
    return { y, m, d };
  }
  const validDate = () => civilIso(validCivil());
  function date() {
    if (chance(0.14)) return pick(BAD_DATES);
    const s = validDate();
    if (chance(0.04)) return pick([` ${s}`, `${s}\t`, `\n${s}\r`, `  ${s}  `]);
    return s;
  }
  // A second date near the first one most of the time.
  function dateNear(base) {
    const p = Oracle.parseDate(base);
    if (p.code || chance(0.2)) return date();
    const span = pick([7, 40, 400, 1500, 40000]);
    const z = Math.min(Oracle.MAX_DAY, Math.max(Oracle.MIN_DAY, p.z + int(-span, span)));
    return Oracle.isoOfDay(z);
  }
  function amount(field) {
    const r = rng();
    if (r < 0.25) return "";
    if (r < 0.62) return String(int(-40, 40));
    if (r < 0.75) return String(int(-2000, 2000));
    if (r < 0.85) {
      const max = { years: 9999, months: 119988, weeks: 521722, days: 3652058 }[field];
      return pick([String(max), String(max + 1), String(-max), String(-max - 1), String(int(0, max))]);
    }
    return pick(BAD_AMOUNTS);
  }
  function time(required) {
    const r = rng();
    if (!required && r < 0.3) return "";
    if (r < 0.88) {
      const base = `${pad2(int(0, 23))}:${pad2(int(0, 59))}`;
      return chance(0.5) ? `${base}:${pad2(int(0, 59))}` : base;
    }
    return pick(["24:00", "9:00", "12:60", "12:00:60", "12:00:00.5", "noon", " 08:30 ", "23:59:59", "00:00", "", "12-00",
      "１２:００"]);
  }
  function weekend() {
    const r = rng();
    if (r < 0.35) return [6, 7];
    if (r < 0.5) return [5, 6];
    if (r < 0.58) return [5];
    if (r < 0.63) return [];
    if (r < 0.66) return [1, 2, 3, 4, 5, 6, 7];
    if (r < 0.69) return pick([[6, 6], [0], [8], [7, 6, 5], [1, 7]]);
    const out = [];
    for (let d = 1; d <= 7; d++) if (chance(0.25)) out.push(d);
    return out.length === 7 ? [6, 7] : out;
  }
  function customHoliday() {
    const id = chance(0.95) ? `c-${int(0, 0xffffffff).toString(16).padStart(8, "0")}` : pick(["bad", "c-XYZ", ""]);
    const name = chance(0.6) ? pick(["Company day", "Founders", "Office closed"]) : pick(HOSTILE_NAMES);
    const enabled = chance(0.9);
    if (chance(0.6)) {
      return { id, name, kind: "date", date: chance(0.9) ? validDate() : pick(BAD_DATES), enabled };
    }
    const entry = { id, name, kind: "yearly", month: int(chance(0.95) ? 1 : 0, chance(0.95) ? 12 : 13), day: int(1, 31) };
    if (chance(0.5)) entry.fromYear = int(1890, 2210);
    if (chance(0.5)) entry.enabled = enabled;
    return entry;
  }
  function calendar(rich) {
    if (!rich) return chance(0.3) ? undefined : chance(0.4) ? {} : { weekend: weekend() };
    const cal = {};
    if (chance(0.7)) cal.weekend = weekend();
    if (chance(0.85)) cal.preset = chance(0.97) ? pick(["none", "us", "uk", "eg", "eg"]) : pick(["US", "xx"]);
    if (chance(0.25)) cal.hijriOffsetDays = int(-3, 3);
    if (chance(0.12)) {
      cal.hijriOverrides = [];
      const n = int(1, 2);
      for (let i = 0; i < n; i++) {
        const hy = int(1440, 1450);
        cal.hijriOverrides.push({ hijriYear: hy, event: pick(HIJRI_EVENT_NAMES), date: validDate() });
      }
    }
    if (chance(0.2)) {
      const ex = {};
      for (const p of ["us", "uk", "eg"]) {
        if (chance(0.5)) ex[p] = [pick(KNOWN_IDS[p]), ...(chance(0.15) ? ["nope"] : [])];
      }
      cal.excludedHolidays = ex;
    }
    if (chance(0.3)) {
      cal.customHolidays = [];
      const n = int(1, 3);
      for (let i = 0; i < n; i++) cal.customHolidays.push(customHoliday());
    }
    if (chance(0.2)) cal.observedMode = chance(0.95) ? pick(["observed", "actual", "both"]) : "Observed";
    if (chance(0.05)) cal.schemaVersion = pick([1, 2, 0]);
    return cal;
  }
  function moment(required) {
    const m = { date: date(), time: time(required) };
    const r = rng();
    if (r < 0.85) m.utcOffsetMinutes = pick([0, 60, 120, -300, -240, 330, 345, -210, 840, int(-1080, 1080)]);
    else if (r < 0.92) m.utcOffsetMinutes = pick([1081, -1081, 100000]);
    return m;
  }

  const build = {
    calc_days_between() {
      const s = date();
      const req = { startDate: s, endDate: dateNear(s) };
      if (chance(0.5)) req.includeEndDay = chance(0.5);
      return req;
    },
    calc_add_subtract() {
      const req = { date: date(), operation: pick(["add", "subtract"]) };
      for (const f of ["years", "months", "weeks", "days"]) if (chance(0.7)) req[f] = amount(f);
      if (chance(0.35)) {
        req.businessDays = true;
        req.calendar = calendar(chance(0.6));
        if (req.calendar === undefined) delete req.calendar;
        // Business mode on a huge span is slow and adds no coverage.
        if (chance(0.8)) {
          for (const f of ["years", "months", "weeks", "days"]) if (req[f] !== undefined && /^\s*[+-]?\d{4,}/.test(req[f])) req[f] = "3";
        }
      } else if (chance(0.1)) {
        req.businessDays = false;
      }
      return req;
    },
    calc_business_days() {
      const s = date();
      const req = { startDate: s, endDate: chance(0.03) ? pick(["0001-01-01", "9999-12-31"]) : dateNear(s) };
      if (chance(0.5)) req.includeEndDay = chance(0.5);
      const cal = calendar(chance(0.55));
      if (cal !== undefined) req.calendar = cal;
      return req;
    },
    calc_age() {
      const b = date();
      const req = { birthDate: chance(0.1) ? pick(["2000-02-29", "2004-02-29", "1996-02-29"]) : b, asOfDate: dateNear(b) };
      if (chance(0.5)) req.leapDayRule = pick(["feb28", "mar1"]);
      return req;
    },
    calc_date_info() {
      const req = { date: date() };
      const r = rng();
      if (r < 0.6) req.today = validDate();
      else if (r < 0.7) req.today = null;
      else if (r < 0.75) req.today = pick(BAD_DATES);
      return req;
    },
    calc_countdown() {
      const req = {};
      if (chance(0.97)) req.now = moment(true);
      if (chance(0.97)) req.target = moment(false);
      if (req.now && req.target && chance(0.6)) {
        const p = Oracle.parseDate(req.now.date);
        if (!p.code) req.target.date = Oracle.isoOfDay(Math.min(Oracle.MAX_DAY, Math.max(Oracle.MIN_DAY, p.z + int(-400, 400))));
      }
      return req;
    },
    holidays_in_range() {
      const s = chance(0.7) ? `${int(1890, 2210)}-${pad2(int(1, 12))}-01` : date();
      const req = { startDate: s, endDate: dateNear(s) };
      const cal = calendar(true);
      if (chance(0.6)) cal.preset = pick(["us", "uk", "eg"]);
      req.calendar = cal;
      return req;
    },
    month_grid() {
      const req = { year: chance(0.85) ? int(1890, 2210) : pick([0, 1, 9999, 10000, -1, int(1, 9999)]), month: chance(0.95) ? int(1, 12) : pick([0, 13, -1]) };
      if (chance(0.6)) req.firstDayOfWeek = pick(["monday", "sunday"]);
      if (chance(0.5)) req.today = chance(0.9) ? validDate() : pick(BAD_DATES);
      if (chance(0.3)) {
        req.rangeStart = validDate();
        req.rangeEnd = chance(0.8) ? dateNear(req.rangeStart) : pick(BAD_DATES);
      }
      const cal = calendar(chance(0.6));
      if (cal !== undefined) req.calendar = cal;
      return req;
    },
    validate_calendar() {
      return chance(0.95) ? { calendar: calendar(true) } : {};
    }
  };

  const WEIGHTS = [
    ["calc_days_between", 14],
    ["calc_add_subtract", 18],
    ["calc_business_days", 14],
    ["calc_age", 12],
    ["calc_date_info", 10],
    ["calc_countdown", 12],
    ["holidays_in_range", 8],
    ["month_grid", 6],
    ["validate_calendar", 6]
  ];
  const totalWeight = WEIGHTS.reduce((s, [, w]) => s + w, 0);
  function op() {
    let r = rng() * totalWeight;
    for (const [name, w] of WEIGHTS) {
      r -= w;
      if (r < 0) return name;
    }
    return WEIGHTS[0][0];
  }

  // Structural mutations that must all end in invalid_request.
  const ENUM_PATHS = {
    calc_add_subtract: [["operation"]],
    calc_age: [["leapDayRule"]],
    month_grid: [["firstDayOfWeek"]],
    validate_calendar: [["calendar", "preset"], ["calendar", "observedMode"]]
  };
  function mutate(opName, req) {
    const r = rng();
    const clone = JSON.parse(JSON.stringify(req));
    if (r < 0.2) {
      const key = pick(["extra", "__proto__", "constructor", "toString", "startdate", "Date"]);
      Object.defineProperty(clone, key, { value: pick([1, "x", null, true, {}]), enumerable: true, configurable: true, writable: true });
      return { req: clone, kind: `unknown top-level key ${key}` };
    }
    if (r < 0.4) {
      const keys = Object.keys(clone).filter((k) => !["calendar", "today", "rangeStart", "rangeEnd"].includes(k));
      if (keys.length === 0) return null;
      const k = pick(keys);
      const v = clone[k];
      clone[k] = typeof v === "string" ? pick([5, true, null, ["2024-01-01"], { v }])
        : typeof v === "boolean" ? pick(["true", 1, null])
          : typeof v === "number" ? pick(["5", true, null, 1.5, 1e21, [v]])
            : pick(["x", 5]);
      return { req: clone, kind: `wrong type for ${k}` };
    }
    if (r < 0.55) {
      const paths = ENUM_PATHS[opName];
      if (!paths) return null;
      const path = pick(paths);
      let obj = clone;
      for (const k of path.slice(0, -1)) {
        if (!obj[k] || typeof obj[k] !== "object") obj[k] = {};
        obj = obj[k];
      }
      const leaf = path[path.length - 1];
      const value = typeof obj[leaf] === "string" ? obj[leaf] : { operation: "add", leapDayRule: "mar1", firstDayOfWeek: "sunday", preset: "eg", observedMode: "both" }[leaf];
      obj[leaf] = pick([{ [value]: null }, [value], value.toUpperCase(), 0]);
      return { req: clone, kind: `enum ${path.join(".")} in a non-string form` };
    }
    if (r < 0.68) {
      if (opName === "calc_add_subtract") {
        delete clone.operation;
        return { req: clone, kind: "missing operation" };
      }
      if (opName === "month_grid") {
        delete clone[pick(["year", "month"])];
        return { req: clone, kind: "missing year/month" };
      }
      return null;
    }
    if (r < 0.82) {
      const container = clone.calendar && typeof clone.calendar === "object" && !Array.isArray(clone.calendar) ? clone.calendar
        : clone.now && typeof clone.now === "object" ? clone.now : null;
      if (!container) return null;
      container[pick(["presets", "weekends", "islamicAdjustDays", "tz", "Weekend"])] = 1;
      return { req: clone, kind: "unknown nested key" };
    }
    if (r < 0.9) {
      return { req: pick([[], null, "req", 5, [req]]), kind: "non-object request" };
    }
    const keys = Object.keys(clone).filter((k) => typeof clone[k] === "string");
    if (keys.length === 0) return null;
    const k = pick(keys);
    clone[k] = pick(["x".repeat(1025), "€".repeat(342), "2024-01-01" + " ".repeat(1015), "😀".repeat(256) + "x"]);
    return { req: clone, kind: `oversized string in ${k}` };
  }

  return {
    int,
    pick,
    chance,
    validDate,
    nextCase() {
      const name = op();
      const req = build[name]();
      if (chance(0.09)) {
        const m = mutate(name, req);
        if (m) return { op: name, req: m.req, mutated: m.kind };
      }
      return { op: name, req, mutated: null };
    }
  };
}

// ============================================================================
// 8. Slice A: engine parity (Rust bridge vs mobile engine vs oracle)
// ============================================================================

// Fixed adversarial catalogue: [op, req (JS value), expectInvalidRequest].
// `true` means the request must be invalid_request on both sides; `false`
// means any non-invalid_request envelope; `null` means parity only.
function adversarialCatalogue() {
  const proto = (key) => {
    const o = { startDate: "2024-01-01", endDate: "2024-01-02" };
    Object.defineProperty(o, key, { value: 1, enumerable: true, configurable: true, writable: true });
    return o;
  };
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  return [
    ["calc_days_between", { startDate: "2024-01-01", endDate: "2024-01-02", extra: 1 }, true],
    ["calc_days_between", proto("__proto__"), true],
    ["calc_days_between", proto("constructor"), true],
    ["calc_days_between", proto("hasOwnProperty"), true],
    ["calc_days_between", { startDate: null }, true],
    ["calc_days_between", { startDate: 20240101 }, true],
    ["calc_days_between", { includeEndDay: "true" }, true],
    ["calc_days_between", { includeEndDay: 1 }, true],
    ["calc_days_between", ["2024-01-01", "2024-01-02"], true],
    ["calc_days_between", null, true],
    ["calc_days_between", "2024-01-01", true],
    ["calc_days_between", {}, false],
    ["calc_days_between", { startDate: "\ud800", endDate: "2024-01-01" }, true],
    ["calc_days_between", { startDate: "\udfff2024-01-01" }, true],
    ["calc_days_between", { startDate: "😀".repeat(256), endDate: "2024-01-02" }, false],
    ["calc_days_between", { startDate: "😀".repeat(256) + "x", endDate: "2024-01-02" }, true],
    ["calc_days_between", { startDate: " ".repeat(1014) + "2024-01-01", endDate: "2024-01-02" }, false],
    ["calc_days_between", { startDate: " ".repeat(1015) + "2024-01-01", endDate: "2024-01-02" }, true],
    ["calc_days_between", { startDate: "0001-01-01", endDate: "9999-12-31", includeEndDay: true }, false],
    ["calc_days_between", { startDate: "9999-12-31", endDate: "0001-01-01", includeEndDay: true }, false],
    ["calc_days_between", { startDate: "٢٠٢٤-٠١-٠١", endDate: "2024-01-02" }, false],
    ["calc_days_between", { startDate: "２０２４-01-01", endDate: "2024-01-02" }, false],
    ["calc_add_subtract", { date: "2024-01-31", operation: { add: null }, months: "1" }, true],
    ["calc_add_subtract", { date: "2024-01-31", operation: ["add"], months: "1" }, true],
    ["calc_add_subtract", { date: "2024-01-31", operation: "ADD", months: "1" }, true],
    ["calc_add_subtract", { date: "2024-01-31", operation: 0, months: "1" }, true],
    ["calc_add_subtract", { date: "2024-01-31", months: "1" }, true],
    ["calc_add_subtract", { date: "2024-01-31", operation: "add", months: 1 }, true],
    ["calc_add_subtract", { date: "2024-01-31", operation: "add", months: "999999999999999999999" }, false],
    ["calc_add_subtract", { date: "2024-01-31", operation: "add", days: "9007199254740993" }, false],
    ["calc_add_subtract", { date: "2024-01-31", operation: "add", days: "-0" }, false],
    ["calc_add_subtract", { date: "2024-01-31", operation: "add", days: "٣" }, false],
    ["calc_add_subtract", { date: "9999-12-15", operation: "add", months: "1", days: "-30" }, false],
    ["calc_add_subtract", { date: "9999-12-31", operation: "add", days: "1" }, false],
    ["calc_add_subtract", { date: "0001-01-01", operation: "subtract", days: "1" }, false],
    ["calc_add_subtract", { date: "2024-01-31", operation: "add", years: "9999", months: "119988", weeks: "521722", days: "3652058" }, false],
    ["calc_add_subtract", { date: "2024-01-01", operation: "add", businessDays: true, days: "3652058" }, false],
    ["calc_add_subtract", { date: "2024-01-01", operation: "add", businessDays: true, days: "-3652058", calendar: { preset: "eg" } }, false],
    ["calc_add_subtract", { date: "2024-01-01", operation: "add", businessDays: true, days: "5", calendar: { weekend: [1, 2, 3, 4, 5, 6, 7] } }, false],
    ["calc_add_subtract", { date: "2024-01-01", operation: "add", businessDays: true, days: "5", calendar: { weekend: [6.5] } }, true],
    ["calc_add_subtract", { date: "2024-01-01", operation: "add", calendar: { weekends: [6] } }, true],
    ["calc_add_subtract", { date: "2024-01-01", operation: "add", businessDays: "true" }, true],
    ["calc_age", { birthDate: "2000-01-01", asOfDate: "2024-01-01", leapDayRule: "MAR1" }, true],
    ["calc_age", { birthDate: "2000-01-01", asOfDate: "2024-01-01", leapDayRule: { mar1: null } }, true],
    ["calc_age", { birthDate: "2024-02-29", asOfDate: "2025-02-28", leapDayRule: "mar1" }, false],
    ["calc_age", { birthDate: "9999-12-31", asOfDate: "9999-12-31" }, false],
    ["calc_age", { birthDate: "2025-01-02", asOfDate: "2025-01-01" }, false],
    ["calc_date_info", { date: "2024-01-01", today: null }, false],
    ["calc_date_info", { date: "2024-01-01", today: 5 }, true],
    ["calc_date_info", { date: "0001-01-01", today: "9999-12-31" }, false],
    ["calc_countdown", { now: { date: "2026-11-16", time: "10:00", tz: "x" } }, true],
    ["calc_countdown", { now: { date: "2026-11-16", time: "10:00", utcOffsetMinutes: 1.5 } }, true],
    ["calc_countdown", { now: { date: "2026-11-16", time: "10:00", utcOffsetMinutes: "60" } }, true],
    ["calc_countdown", { now: { date: "2026-11-16", time: "10:00", utcOffsetMinutes: null } }, true],
    ["calc_countdown", { now: { date: "2026-11-16", time: "10:00", utcOffsetMinutes: 1e21 } }, true],
    ["calc_countdown", { now: { date: "2026-11-16", time: "10:00", utcOffsetMinutes: 2 ** 60 } }, false],
    ["calc_countdown", { now: { date: "2026-11-16", time: "10:00", utcOffsetMinutes: -(2 ** 63) } }, true],
    ["calc_countdown", { now: { date: "2026-11-16", time: "10:00", utcOffsetMinutes: 2 ** 63 } }, true],
    ["calc_countdown", { now: { date: "2026-11-16", time: "10:00", utcOffsetMinutes: 2 ** 53 + 2 } }, false],
    ["calc_countdown", { now: null }, true],
    ["calc_countdown", { now: { date: "0001-01-01", time: "00:00", utcOffsetMinutes: 1080 }, target: { date: "9999-12-31", time: "23:59:59", utcOffsetMinutes: -1080 } }, false],
    ["calc_countdown", { now: { date: "2026-11-16", time: "24:00" }, target: { date: "2026-11-17" } }, false],
    ["month_grid", { year: 2026 }, true],
    ["month_grid", { year: 2026, month: 11, firstDayOfWeek: "Sunday" }, true],
    ["month_grid", { year: 2026, month: 11, firstDayOfWeek: { sunday: null } }, true],
    ["month_grid", { year: 9223372036854775807, month: 11 }, true],
    ["month_grid", { year: -9223372036854775808, month: 11 }, true],
    ["month_grid", { year: 1e3, month: 11 }, false],
    ["month_grid", { year: 2026.5, month: 11 }, true],
    ["month_grid", { year: "2026", month: 11 }, true],
    ["month_grid", { year: 10000, month: 1 }, false],
    ["month_grid", { year: 9999, month: 12, rangeStart: "9999-12-31", rangeEnd: "0001-01-01" }, false],
    ["validate_calendar", { calendar: null }, true],
    ["validate_calendar", { calendar: [[6, 7]] }, true],
    ["validate_calendar", { calendar: { weekend: [6.5] } }, true],
    ["validate_calendar", { calendar: { weekend: ["6"] } }, true],
    ["validate_calendar", { calendar: { preset: { us: null } } }, true],
    ["validate_calendar", { calendar: { preset: "US" } }, true],
    ["validate_calendar", { calendar: { schemaVersion: 1.0 } }, false],
    ["validate_calendar", { calendar: { schemaVersion: 2 } }, false],
    ["validate_calendar", { calendar: { weekend: [1, 2, 3, 4, 5, 6, 7] } }, false],
    ["validate_calendar", { calendar: { weekend: [6, 6] } }, false],
    ["validate_calendar", { calendar: { weekend: many(5000, () => 6) } }, false],
    ["validate_calendar", { calendar: { hijriOffsetDays: 3 } }, false],
    ["validate_calendar", { calendar: { hijriOffsetDays: 1.5 } }, true],
    ["validate_calendar", { calendar: { hijriOverrides: [{ hijriYear: 1446, event: "eidAlFitr" }] } }, true],
    ["validate_calendar", { calendar: { hijriOverrides: [{ hijriYear: 1446, event: { eidAlFitr: null }, date: "2025-03-30" }] } }, true],
    ["validate_calendar", { calendar: { hijriOverrides: [{ hijriYear: 1446, event: "eidAlFitr", date: "2025-03-30" }] } }, false],
    ["validate_calendar", { calendar: { hijriOverrides: [{ hijriYear: 1446, event: "eidAlFitr", date: "2025-06-30" }] } }, false],
    ["validate_calendar", { calendar: { hijriOverrides: many(51, (i) => ({ hijriYear: 1400 + i, event: "mawlid", date: "2000-01-01" })) } }, false],
    ["validate_calendar", { calendar: { excludedHolidays: { us: ["nope"] } } }, false],
    ["validate_calendar", { calendar: { excludedHolidays: { fr: [] } } }, true],
    ["validate_calendar", { calendar: { excludedHolidays: { us: ["x".repeat(1025)] } } }, true],
    ["validate_calendar", { calendar: { excludedHolidays: { us: many(3000, () => "mlkDay") } } }, false],
    ["validate_calendar", { calendar: { customHolidays: [{ id: "c-0123abcd", kind: "yearly", month: 5, day: 5 }] } }, true],
    ["validate_calendar", { calendar: { customHolidays: [{ id: "c-0123abcd", name: "X", kind: "weekly", month: 5, day: 5 }] } }, true],
    ["validate_calendar", { calendar: { customHolidays: [{ id: "c-0123abcd", name: "X", kind: "yearly", month: 5, day: 5, enabled: null }] } }, true],
    ["validate_calendar", { calendar: { customHolidays: [{ id: "c-0123abcd", name: "X", kind: "yearly", month: 2, day: 30 }] } }, false],
    ["validate_calendar", { calendar: { customHolidays: [{ id: "c-0123abcd", name: "X", kind: "yearly", month: 2, day: 29 }] } }, false],
    ["validate_calendar", { calendar: { customHolidays: [{ id: "c-0123abcd", name: "X", kind: "date", date: "2024-01-01", extra: 1 }] } }, true],
    ...HOSTILE_NAMES.map((name) => ["validate_calendar", { calendar: { customHolidays: [{ id: "c-0123abcd", name, kind: "date", date: "2026-12-02" }] } }, false]),
    ["validate_calendar", { calendar: { customHolidays: many(101, (i) => ({ id: `c-${String(i).padStart(8, "0")}`, name: "N", kind: "date", date: "2026-12-02" })) } }, false],
    ["validate_calendar", { calendar: { customHolidays: [{ id: "c-0123abcd", name: "A", kind: "date", date: "2026-12-02" }, { id: "c-0123abcd", name: "B", kind: "date", date: "2026-12-03" }] } }, false],
    ["validate_calendar", {}, false],
    ["validate_calendar", { calendar: {}, extra: 1 }, true],
    ["holidays_in_range", { startDate: "0001-01-01", endDate: "9999-12-31", calendar: { preset: "eg" } }, false],
    ["holidays_in_range", { startDate: "1899-12-01", endDate: "1900-01-31", calendar: { preset: "uk" } }, false],
    ["holidays_in_range", { startDate: "2199-12-01", endDate: "2200-01-31", calendar: { preset: "us" } }, false],
    ["holidays_in_range", { startDate: "2024-12-31", endDate: "2024-01-01", calendar: { preset: "us" } }, false],
    ["calc_business_days", { startDate: "0001-01-01", endDate: "9999-12-31", includeEndDay: true, calendar: { preset: "eg", hijriOffsetDays: -2 } }, false],
    ["calc_business_days", { startDate: "2024-01-01", endDate: "2024-12-31", calendar: { preset: "eg", customHolidays: [{ id: "c-0000beef", name: "<img src=x onerror=alert(1)>", kind: "yearly", month: 2, day: 29 }] } }, false],
    // Over the 64 KiB IPC cap (well above it, so the bridge line cap and the
    // UI's request cap agree).
    ["validate_calendar", { calendar: { excludedHolidays: { us: many(9000, () => "mlkDay") } } }, true],
    ["calc_days_between", { startDate: "2024-01-01", endDate: "2024-01-02", pad: "x".repeat(70000) }, true],
    ["unknown_op", {}, true],
    ["CALC_AGE", {}, true],
    ["", {}, true]
  ];
}

function envelopeProblems(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return "not JSON";
  }
  if (!v || typeof v !== "object") return "not an object";
  if (v.ok === "true") {
    if (!v.result || typeof v.result !== "object" || Object.keys(v).join(",") !== "ok,result") return "bad ok envelope";
  } else if (v.ok === "false") {
    const e = v.error;
    if (Object.keys(v).join(",") !== "ok,error" || !e || typeof e.code !== "string" || typeof e.message !== "string" ||
      !(e.field === null || typeof e.field === "string") || e.message.trim() === "") return "bad error envelope";
  } else {
    return `ok is ${JSON.stringify(v.ok)}`;
  }
  if (/\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]/.test(text)) return "NaN/undefined/Infinity/[object Object] in output";
  return null;
}

function goldenKeys() {
  const keys = new Set();
  const p = join(ROOT, "crates", "date-core", "tests", "fixtures", "golden.json");
  if (!existsSync(p)) return keys;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\{"op":("[a-z_]+"),"req":(.*),"res":/.exec(line);
    if (m) keys.add(`${JSON.parse(m[1])}|${m[2]}`);
  }
  return keys;
}

async function runSliceA(slice, ctx) {
  const { bridge, engine, opts } = ctx;

  // A.1 Framing: the bridge answers every malformed line with invalid_request.
  const framing = slice.criterion("bridge-framing", "eval_bridge answers malformed JSON, invalid UTF-8, over-64KiB lines, unknown ops and extra keys with the invalid_request envelope, echoes ids, and answers blank lines with nothing");
  await guard(framing, "framing", async () => {
    const cases = [
      ["{", INVALID_REQUEST],
      ["[]", INVALID_REQUEST],
      ["null", INVALID_REQUEST],
      ['{"op":"calc_age"}', INVALID_REQUEST],
      ['{"op":"calc_ages","req":{}}', INVALID_REQUEST],
      ['{"op":"calc_age","req":{},"extra":1}', INVALID_REQUEST],
      ['{"op":"calc_age","req":{"birthDate":"2000-01-01"}}\u0000', null],
      ['{"id":7,"op":"nope","req":{}}', `{"id":7,${INVALID_REQUEST.slice(1)}`],
      ['{"id":"a1","op":"calc_age","req":{"birthDate":"2025-01-02","asOfDate":"2025-01-01"}}', null]
    ];
    for (const [line, want] of cases) {
      const got = await bridge.line(line);
      if (want !== null) framing.check(got === want, () => `${excerpt(line, 80)} -> ${excerpt(got, 160)}`);
      else framing.check(envelopeProblems(got.replace(/^\{"id":"a1",/, "{")) === null, () => `${excerpt(line, 80)} -> ${excerpt(got, 160)}`);
    }
    // Duplicate keys: last one wins, exactly as JSON.parse does on the mobile side.
    const dupText = '{"birthDate":"2000-01-01","birthDate":"2000-01-02","asOfDate":"2024-01-01"}';
    const dup = await bridge.line(`{"op":"calc_age","req":${dupText}}`);
    framing.check(dup === engine.callText("calc_age", dupText) && JSON.parse(dup).result?.birthDate === "2000-01-02",
      () => `duplicate keys: ${excerpt(dup, 160)}`);
    const bad = Buffer.concat([Buffer.from([0xff, 0xfe, 0x7b]), Buffer.from("\n")]);
    framing.check((await bridge.send(bad)) === INVALID_REQUEST, "invalid UTF-8 line");
    const long = `{"op":"validate_calendar","req":{"calendar":{"excludedHolidays":{"us":[${'"mlkDay",'.repeat(9000)}"mlkDay"]}}}}\n`;
    framing.check((await bridge.send(long)) === INVALID_REQUEST, "over-long line");
    // A blank line gets no answer: the next answer must belong to the next request.
    const after = bridge.send(`   \r\n{"op":"calc_date_info","req":{"date":"2024-02-29"}}\n`);
    framing.check(JSON.parse(await after).result?.date === "2024-02-29", "blank line produced a response");
  });

  // A.2 Seeded random requests: Rust and mobile byte-identical.
  const parity = slice.criterion("parity-random", `${opts.cases} seeded random requests (disjoint from golden.json, ~9% structurally mutated) give byte-identical responses from the Rust bridge and the mobile engine`);
  const oracleAgree = slice.criterion("oracle-random", "the independent JS oracle agrees with Rust on every field it covers for the random requests (dates, Y/M/D walk, add/subtract clamp, age, ISO week, countdown, weekend-only business days, month grid, error codes)");
  const envelope = slice.criterion("envelope-shape", "every Rust and mobile response is a well-formed envelope (ok \"true\"/\"false\", error code/field/message) with no NaN, undefined, Infinity or [object Object]");
  const mutations = slice.criterion("mutations-invalid-request", "every structurally mutated request (unknown or prototype keys, wrong types, non-string enums, missing required fields, non-object requests, strings over 1,024 bytes) is invalid_request on both sides");
  const gen = makeGenerators(mulberry32(opts.seed));
  const golden = goldenKeys();
  const cases = [];
  let overlap = 0;
  while (cases.length < opts.cases) {
    const c = gen.nextCase();
    if (golden.has(`${c.op}|${canonical(c.req)}`)) {
      overlap++;
      continue;
    }
    cases.push(c);
  }
  parity.note(`golden.json overlap skipped: ${overlap}`);
  await guard(parity, "random parity", async () => {
    const rust = await Promise.all(cases.map((c) => bridge.call(c.op, c.req)));
    const byOp = {};
    let covered = 0;
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const mobile = engine.call(c.op, c.req);
      const tag = `${c.op} ${excerpt(JSON.stringify(c.req), 200)}`;
      byOp[c.op] = (byOp[c.op] || 0) + 1;
      parity.check(rust[i] === mobile, () => `${tag} ${firstDiff(rust[i], mobile)}`);
      const pr = envelopeProblems(rust[i]);
      envelope.check(pr === null, () => `rust ${tag}: ${pr}`);
      const pm = envelopeProblems(mobile);
      envelope.check(pm === null, () => `mobile ${tag}: ${pm}`);
      if (c.mutated) {
        mutations.check(rust[i] === INVALID_REQUEST && mobile === INVALID_REQUEST, () => `${c.mutated}: ${tag} -> ${excerpt(rust[i], 160)}`);
        continue;
      }
      const exp = Oracle.expect(c.op, c.req);
      if (!exp) continue;
      covered++;
      const why = compareOracle(exp, JSON.parse(rust[i]));
      oracleAgree.check(why === null, () => `${tag}: ${why}`);
    }
    parity.note(`cases per op: ${JSON.stringify(byOp)}`);
    oracleAgree.note(`oracle-covered random cases: ${covered} of ${cases.length}`);
  });

  // A.3 Fixed adversarial catalogue.
  const adv = slice.criterion("parity-adversarial", "a fixed adversarial catalogue (prototype keys, lone surrogates, Arabic-Indic/fullwidth digits, U+00A0/U+FEFF padding, 2^53..2^63 numbers, 1e21, map-form enums, over-cap strings and requests, 101 custom holidays, 51 overrides, hostile names, full 0001..9999 ranges) is byte-identical across Rust and mobile, with invalid_request exactly where expected");
  await guard(adv, "adversarial", async () => {
    const list = adversarialCatalogue();
    const rust = await Promise.all(list.map(([op, req]) => bridge.call(op, req)));
    list.forEach(([op, req, expectInvalid], i) => {
      const mobile = engine.call(op, req);
      const tag = `${op} ${excerpt(JSON.stringify(req) ?? String(req), 160)}`;
      adv.check(rust[i] === mobile, () => `${tag} ${firstDiff(rust[i], mobile)}`);
      if (expectInvalid !== null) {
        const isInvalid = rust[i] === INVALID_REQUEST;
        adv.check(isInvalid === expectInvalid, () => `${tag}: expected ${expectInvalid ? "invalid_request" : "a domain envelope"}, got ${excerpt(rust[i], 160)}`);
      }
      envelope.check(envelopeProblems(rust[i]) === null, () => `adversarial ${tag}: ${envelopeProblems(rust[i])}`);
    });
    adv.note(`catalogue size: ${list.length}`);
  });

  // A.4 Determinism: the same requests again give the same bytes.
  const determinism = slice.criterion("determinism", "re-sending 300 random requests gives identical bytes from Rust and from the mobile engine (no hidden state, no clock)");
  await guard(determinism, "determinism", async () => {
    const sample = cases.slice(0, 300);
    const first = await Promise.all(sample.map((c) => bridge.call(c.op, c.req)));
    const again = await Promise.all(sample.map((c) => bridge.call(c.op, c.req)));
    sample.forEach((c, i) => {
      determinism.check(first[i] === again[i], () => `rust ${c.op} differs on repeat`);
      determinism.check(engine.call(c.op, c.req) === engine.call(c.op, c.req), () => `mobile ${c.op} differs on repeat`);
    });
    determinism.check(engine.sandboxGlobals === "undefined/undefined", `mobile engine sandbox still has Date/Intl: ${engine.sandboxGlobals}`);
  });

  // A.5 Oracle sweeps.
  const sweepInfo = slice.criterion("oracle-date-info-sweep", "calc_date_info agrees with the oracle (weekday, ISO week/year, ordinal, leap year, quarter, epoch/JDN) on a stride sweep of 0001-01-01..9999-12-31 plus every day of 1999-12-20..2001-01-10 and every Dec 28..Jan 04 of 1990..2040");
  await guard(sweepInfo, "date info sweep", async () => {
    const days = new Set();
    for (let z = Oracle.MIN_DAY; z <= Oracle.MAX_DAY; z += 997) days.add(z);
    days.add(Oracle.MAX_DAY);
    for (let z = Oracle.toDays(1999, 12, 20); z <= Oracle.toDays(2001, 1, 10); z++) days.add(z);
    for (let y = 1990; y <= 2040; y++) for (let z = Oracle.toDays(y, 12, 28); z <= Oracle.toDays(y + 1, 1, 4); z++) days.add(z);
    const list = [...days].map((z) => ({ date: Oracle.isoOfDay(z), today: "2026-11-16" }));
    const rust = await Promise.all(list.map((req) => bridge.call("calc_date_info", req)));
    list.forEach((req, i) => {
      const why = compareOracle(Oracle.expect("calc_date_info", req), JSON.parse(rust[i]));
      sweepInfo.check(why === null, () => `${req.date}: ${why}`);
      sweepInfo.check(engine.call("calc_date_info", req) === rust[i], () => `${req.date}: mobile differs`);
    });
  });

  const easter = slice.criterion("oracle-easter", "UK Good Friday and Easter Monday (actual dates) match Gauss's Easter algorithm for every preset year 1978..2199, in Rust and mobile");
  const ukFixed = slice.criterion("oracle-uk-rules", "UK New Year, Christmas and Boxing Day keep their actual dates, and every UK observed date is a Monday-Friday on or after the actual date, for 1978..2199");
  const usRules = slice.criterion("oracle-us-federal", "US federal holidays (fixed dates, nth/last weekdays, era bounds for MLK 1986, Juneteenth 2021, Veterans Day 1971-77) with Sat->Fri / Sun->Mon observance, including New Year's Day observed on Dec 31 of the year before, match the oracle exactly for every year 1971..2199");
  await guard(easter, "holiday sweeps", async () => {
    const ukReqs = [];
    const usReqs = [];
    for (let y = 1978; y <= 2199; y++) ukReqs.push({ startDate: `${y}-01-01`, endDate: `${y}-12-31`, calendar: { preset: "uk" } });
    for (let y = 1971; y <= 2199; y++) usReqs.push({ startDate: `${y}-01-01`, endDate: `${y}-12-31`, calendar: { preset: "us" } });
    const ukRust = await Promise.all(ukReqs.map((r) => bridge.call("holidays_in_range", r)));
    const usRust = await Promise.all(usReqs.map((r) => bridge.call("holidays_in_range", r)));
    ukReqs.forEach((req, i) => {
      const y = 1978 + i;
      easter.check(engine.call("holidays_in_range", req) === ukRust[i], () => `${y} uk: mobile differs`);
      const hs = JSON.parse(ukRust[i]).result.holidays;
      const actual = (id) => hs.filter((h) => h.id === id).map((h) => h.actualDate);
      const e = Oracle.easter(y);
      easter.check(canonical(actual("goodFriday")) === canonical([Oracle.isoOfDay(e - 2)]), () => `${y} goodFriday ${actual("goodFriday")} vs ${Oracle.isoOfDay(e - 2)}`);
      easter.check(canonical(actual("easterMonday")) === canonical([Oracle.isoOfDay(e + 1)]), () => `${y} easterMonday ${actual("easterMonday")} vs ${Oracle.isoOfDay(e + 1)}`);
      ukFixed.check(canonical(actual("newYearsDay")) === canonical([`${y}-01-01`]), () => `${y} newYearsDay ${actual("newYearsDay")}`);
      ukFixed.check(canonical(actual("christmasDay")) === canonical([`${y}-12-25`]), () => `${y} christmasDay ${actual("christmasDay")}`);
      ukFixed.check(canonical(actual("boxingDay")) === canonical([`${y}-12-26`]), () => `${y} boxingDay ${actual("boxingDay")}`);
      for (const h of hs) {
        const d = Oracle.parseDate(h.date).z;
        const a = Oracle.parseDate(h.actualDate).z;
        ukFixed.check(Oracle.weekday(d) <= 5 && d >= a && d - a <= 3, () => `${y} ${h.id} observed ${h.date} (actual ${h.actualDate})`);
      }
    });
    usReqs.forEach((req, i) => {
      const y = 1971 + i;
      usRules.check(engine.call("holidays_in_range", req) === usRust[i], () => `${y} us: mobile differs`);
      const got = JSON.parse(usRust[i]).result.holidays.map((h) => `${h.id}|${h.date}|${h.actualDate}`).sort();
      const want = Oracle.usHolidaysInYear(y);
      usRules.check(canonical(got) === canonical(want), () => `${y}: got ${got.join(",")} want ${want.join(",")}`);
    });
  });

  const grid = slice.criterion("oracle-month-grid", "month_grid returns 42 consecutive cells starting on the chosen first weekday, with the right weekend flags and in-month count, for every month of 1900, 2000, 2024, 2100 and 9999 (both first days)");
  await guard(grid, "month grid", async () => {
    const reqs = [];
    for (const year of [1, 1900, 2000, 2024, 2100, 9999]) {
      for (let month = 1; month <= 12; month++) {
        for (const firstDayOfWeek of ["monday", "sunday"]) {
          reqs.push({ year, month, firstDayOfWeek, calendar: { weekend: year % 2 ? [5, 6] : [6, 7] } });
        }
      }
    }
    const rust = await Promise.all(reqs.map((r) => bridge.call("month_grid", r)));
    reqs.forEach((req, i) => {
      if (req.year === 9999 && req.month === 12) {
        // The grid runs past 9999-12-31; those cells are out of range.
        grid.check(engine.call("month_grid", req) === rust[i], "9999-12 mobile differs");
        return;
      }
      const why = compareOracle(Oracle.expect("month_grid", req), JSON.parse(rust[i]));
      grid.check(why === null, () => `${req.year}-${req.month} ${req.firstDayOfWeek}: ${why}`);
      grid.check(engine.call("month_grid", req) === rust[i], () => `${req.year}-${req.month}: mobile differs`);
    });
  });

  // A.6 Metamorphic relations (Rust).
  const meta = slice.criterion("metamorphic", "metamorphic relations hold in Rust: between(a,b) mirrors between(b,a); add(a, M months + D days) returns b for the Y/M/D breakdown of [a,b]; business(a,b)+business(b,c) = business(a,c); weekday(d+7) = weekday(d)");
  await guard(meta, "metamorphic", async () => {
    const g = makeGenerators(mulberry32(opts.seed ^ 0x5eed));
    for (let i = 0; i < 300; i++) {
      const a = g.validDate();
      const za = Oracle.parseDate(a).z;
      const zb = Math.min(Oracle.MAX_DAY, za + g.int(0, 3000));
      const zc = Math.min(Oracle.MAX_DAY, zb + g.int(0, 400));
      const b = Oracle.isoOfDay(zb);
      const c = Oracle.isoOfDay(zc);
      const [fw, bw, ab, bc, ac, w1, w2] = await Promise.all([
        bridge.result("calc_days_between", { startDate: a, endDate: b }),
        bridge.result("calc_days_between", { startDate: b, endDate: a }),
        bridge.result("calc_business_days", { startDate: a, endDate: b, calendar: { weekend: [5, 6] } }),
        bridge.result("calc_business_days", { startDate: b, endDate: c, calendar: { weekend: [5, 6] } }),
        bridge.result("calc_business_days", { startDate: a, endDate: c, calendar: { weekend: [5, 6] } }),
        bridge.result("calc_date_info", { date: a }),
        za + 7 <= Oracle.MAX_DAY ? bridge.result("calc_date_info", { date: Oracle.isoOfDay(za + 7) }) : bridge.result("calc_date_info", { date: a })
      ]);
      meta.check(fw.totalDays === bw.totalDays && fw.signedDays === -bw.signedDays && fw.breakdownText === bw.breakdownText,
        () => `between ${a} ${b} not symmetric`);
      const round = await bridge.result("calc_add_subtract", { date: a, operation: "add", months: String(fw.totalMonths), days: String(fw.days) });
      meta.check(round.resultDate === b, () => `${a} + ${fw.totalMonths}m ${fw.days}d = ${round.resultDate}, expected ${b}`);
      meta.check(ab.businessDays + bc.businessDays === ac.businessDays, () => `business ${a}..${b}..${c}`);
      meta.check(w1.weekday === w2.weekday, () => `weekday(${a}+7)`);
    }
  });
}

// ============================================================================
// 9. Mini-DOM (HTML-parsed, with date/time/checkbox/select semantics)
// ============================================================================

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
  "source", "track", "wbr"]);

class MockEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = init.cancelable !== false;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.target = null;
    this.currentTarget = null;
    this.key = init.key ?? "";
    this.code = init.code ?? "";
    this.ctrlKey = Boolean(init.ctrlKey);
    this.metaKey = Boolean(init.metaKey);
    this.shiftKey = Boolean(init.shiftKey);
    this.altKey = Boolean(init.altKey);
    this.clipboardData = init.clipboardData ?? null;
    this.storageArea = init.storageArea ?? null;
    this.persisted = Boolean(init.persisted);
    // MouseEvent / PointerEvent fields (v1.2.0 card drag). As in browsers,
    // an init without isPrimary makes a non-primary pointer.
    this.clientX = Number(init.clientX ?? 0);
    this.clientY = Number(init.clientY ?? 0);
    this.button = Number(init.button ?? 0);
    this.buttons = Number(init.buttons ?? 0);
    this.pointerId = Number(init.pointerId ?? 0);
    this.pointerType = String(init.pointerType ?? "");
    this.isPrimary = Boolean(init.isPrimary);
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
}

// HTML "valid date string" (year >= 1, 4+ digits, real calendar date) and
// "valid time string"; anything else makes the input's value "".
function sanitizeDateValue(v) {
  const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > Oracle.dim(y, mo)) return "";
  return v;
}
function sanitizeTimeValue(v) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(v) ? v : "";
}

class MockClassList {
  constructor(el) {
    this._el = el;
    this._set = new Set();
  }
  _sync(str) {
    this._set = new Set(String(str || "").split(/\s+/).filter(Boolean));
  }
  _write() {
    this._el._attrs.set("class", [...this._set].join(" "));
  }
  add(...t) {
    t.forEach((x) => this._set.add(String(x)));
    this._write();
  }
  remove(...t) {
    t.forEach((x) => this._set.delete(String(x)));
    this._write();
  }
  contains(t) {
    return this._set.has(String(t));
  }
  toggle(t, force) {
    const k = String(t);
    const on = force === undefined ? !this._set.has(k) : Boolean(force);
    if (on) this._set.add(k);
    else this._set.delete(k);
    this._write();
    return on;
  }
  get length() {
    return this._set.size;
  }
}

class MockText {
  constructor(text, doc) {
    this.nodeType = 3;
    this.nodeName = "#text";
    this._text = String(text ?? "");
    this.parentNode = null;
    this.ownerDocument = doc;
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v ?? "");
  }
  cloneNode(_deep, doc) {
    return new MockText(this._text, doc || this.ownerDocument);
  }
}

const dataKey = (prop) => `data-${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

class MockElement {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this._attrs = new Map();
    this._listeners = new Map();
    this._value = null;
    this._checked = false;
    // A native date/time input with a segment cleared reads "" and reports
    // validity.badInput (Chromium/WebView2); tests set this flag directly.
    this._badInput = false;
    this.classList = new MockClassList(this);
    this.selectionStart = null;
    this.selectionEnd = null;
    this.dataset = new Proxy({}, {
      get: (_, p) => (typeof p === "string" ? this._attrs.get(dataKey(p)) : undefined),
      set: (_, p, v) => {
        if (typeof p === "string") this._attrs.set(dataKey(p), String(v));
        return true;
      },
      has: (_, p) => typeof p === "string" && this._attrs.has(dataKey(p)),
      deleteProperty: (_, p) => this._attrs.delete(dataKey(String(p))),
      ownKeys: () => [...this._attrs.keys()].filter((k) => k.startsWith("data-")).map((k) => k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())),
      getOwnPropertyDescriptor: (_, p) => (this._attrs.has(dataKey(String(p))) ? { enumerable: true, configurable: true, value: this._attrs.get(dataKey(String(p))) } : undefined)
    });
    this._style = new Proxy({}, {
      get: (t, p) => (typeof p === "string" ? t[p] ?? "" : undefined),
      set: (t, p, v) => {
        t[p] = v;
        doc?._violation("style", `${this.tagName}#${this.id}.style.${String(p)}`);
        return true;
      }
    });
  }

  // --- Sinks: recorded, then refused.
  get style() {
    return this._style;
  }
  set style(v) {
    this.ownerDocument?._violation("style", `${this.tagName}#${this.id}.style=`);
    throw new Error("FORBIDDEN: style assignment");
  }
  get innerHTML() {
    this.ownerDocument?._violation("sink", "innerHTML read");
    throw new Error("FORBIDDEN: innerHTML");
  }
  set innerHTML(_) {
    this.ownerDocument?._violation("sink", "innerHTML write");
    throw new Error("FORBIDDEN: innerHTML");
  }
  get outerHTML() {
    this.ownerDocument?._violation("sink", "outerHTML read");
    throw new Error("FORBIDDEN: outerHTML");
  }
  set outerHTML(_) {
    this.ownerDocument?._violation("sink", "outerHTML write");
    throw new Error("FORBIDDEN: outerHTML");
  }
  insertAdjacentHTML() {
    this.ownerDocument?._violation("sink", "insertAdjacentHTML");
    throw new Error("FORBIDDEN: insertAdjacentHTML");
  }

  // --- Reflected attributes.
  get id() {
    return this._attrs.get("id") || "";
  }
  set id(v) {
    this._attrs.set("id", String(v ?? ""));
  }
  get className() {
    return this._attrs.get("class") || "";
  }
  set className(v) {
    this._attrs.set("class", String(v ?? ""));
    this.classList._sync(v);
  }
  get type() {
    return (this._attrs.get("type") || (this.tagName === "INPUT" ? "text" : this.tagName === "BUTTON" ? "submit" : "")).toLowerCase();
  }
  set type(v) {
    this._attrs.set("type", String(v).toLowerCase());
  }
  get href() {
    return this._attrs.get("href") || "";
  }
  set href(v) {
    this._attrs.set("href", String(v ?? ""));
  }
  get htmlFor() {
    return this._attrs.get("for") || "";
  }
  set htmlFor(v) {
    this._attrs.set("for", String(v ?? ""));
  }
  get title() {
    return this._attrs.get("title") || "";
  }
  set title(v) {
    this._attrs.set("title", String(v ?? ""));
  }
  get min() {
    return this._attrs.get("min") || "";
  }
  set min(v) {
    this._attrs.set("min", String(v));
  }
  get max() {
    return this._attrs.get("max") || "";
  }
  set max(v) {
    this._attrs.set("max", String(v));
  }
  get hidden() {
    return this._attrs.has("hidden");
  }
  set hidden(v) {
    if (v) this._attrs.set("hidden", "");
    else this._attrs.delete("hidden");
  }
  get disabled() {
    return this._attrs.has("disabled");
  }
  set disabled(v) {
    if (v) this._attrs.set("disabled", "");
    else this._attrs.delete("disabled");
  }
  get checked() {
    return this._checked;
  }
  set checked(v) {
    this._checked = Boolean(v);
  }
  get tabIndex() {
    const raw = this._attrs.get("tabindex");
    if (raw !== undefined && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
    return ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"].includes(this.tagName) ? 0 : -1;
  }
  set tabIndex(v) {
    this._attrs.set("tabindex", String(Math.trunc(Number(v) || 0)));
  }
  get validity() {
    return { badInput: this._badInput, valid: !this._badInput };
  }
  get offsetWidth() {
    return 0;
  }
  get isConnected() {
    return this.ownerDocument ? this.ownerDocument.contains(this) : false;
  }
  // null when the element is not rendered: itself or an ancestor hidden
  // (the `hidden` attribute or class), or inside the body of a collapsed
  // card (`.calc-section.card-collapsed .calc-card-body { display: none }`).
  get offsetParent() {
    if (!this.isConnected || this === this.ownerDocument?.body) return null;
    for (let cur = this; cur && cur.nodeType === 1; cur = cur.parentNode) {
      if (cur.hasAttribute("hidden") || cur.classList.contains("hidden")) return null;
      if (cur.classList.contains("calc-card-body") && cur.closest(".calc-section")?.classList.contains("card-collapsed")) return null;
    }
    return this.parentElement;
  }

  get value() {
    if (this.tagName === "SELECT") {
      const opts = this.querySelectorAll("option");
      if (this._value === null) return opts[0] ? opts[0].value : "";
      return this._value;
    }
    if (this.tagName === "OPTION") return this._attrs.has("value") ? this._attrs.get("value") : this.textContent;
    if (this._value === null) return this._attrs.get("value") || "";
    return this._value;
  }
  set value(v) {
    const s = String(v ?? "");
    this._badInput = false;
    if (this.tagName === "SELECT") {
      this._value = this.querySelectorAll("option").some((o) => o.value === s) ? s : "";
      return;
    }
    if (this.tagName === "INPUT" && this.type === "date") this._value = sanitizeDateValue(s);
    else if (this.tagName === "INPUT" && this.type === "time") this._value = sanitizeTimeValue(s);
    else this._value = s;
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  get lastElementChild() {
    const c = this.children;
    return c[c.length - 1] || null;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(v) {
    for (const c of this.childNodes) {
      focusFixup(this.ownerDocument, c);
      c.parentNode = null;
    }
    this.childNodes = [];
    const s = v === null || v === undefined ? "" : String(v);
    if (s) this._adopt(new MockText(s, this.ownerDocument));
  }

  setAttribute(name, val) {
    const k = String(name).toLowerCase();
    const v = String(val ?? "");
    if (k === "style") this.ownerDocument?._violation("style", `${this.tagName}#${this.id} setAttribute(style)`);
    if (/^on/.test(k)) this.ownerDocument?._violation("sink", `${this.tagName} setAttribute(${k})`);
    this._attrs.set(k, v);
    if (k === "class") this.classList._sync(v);
    if (k === "checked") this._checked = true;
  }
  getAttribute(name) {
    const k = String(name).toLowerCase();
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  hasAttribute(name) {
    return this._attrs.has(String(name).toLowerCase());
  }
  removeAttribute(name) {
    const k = String(name).toLowerCase();
    this._attrs.delete(k);
    if (k === "class") this.classList._sync("");
  }
  toggleAttribute(name, force) {
    const on = force === undefined ? !this.hasAttribute(name) : Boolean(force);
    if (on) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return on;
  }

  _adopt(node) {
    if (node.parentNode) node.parentNode._detach(node);
    node.parentNode = this;
    this.childNodes.push(node);
  }
  _detach(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    focusFixup(this.ownerDocument, node);
    node.parentNode = null;
  }
  _toNode(n) {
    return typeof n === "string" ? new MockText(n, this.ownerDocument) : n;
  }
  appendChild(node) {
    if (node.nodeType === 11) {
      [...node.childNodes].forEach((c) => this.appendChild(c));
      return node;
    }
    this._adopt(node);
    return node;
  }
  append(...nodes) {
    nodes.forEach((n) => n !== null && n !== undefined && this.appendChild(this._toNode(n)));
  }
  prepend(...nodes) {
    const ref = this.childNodes[0] || null;
    nodes.forEach((n) => this.insertBefore(this._toNode(n), ref));
  }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    if (node.parentNode) node.parentNode._detach(node);
    const i = this.childNodes.indexOf(ref);
    node.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
    return node;
  }
  removeChild(node) {
    if (!this.childNodes.includes(node)) throw new Error("removeChild: not a child");
    this._detach(node);
    return node;
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) {
      focusFixup(this.ownerDocument, c);
      c.parentNode = null;
    }
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode._detach(this);
  }
  contains(node) {
    for (let cur = node; cur; cur = cur.parentNode) if (cur === this) return true;
    return false;
  }

  addEventListener(type, fn) {
    if (typeof fn !== "function") return;
    const list = this._listeners.get(type) || [];
    if (!list.includes(fn)) list.push(fn);
    this._listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (list && list.includes(fn)) list.splice(list.indexOf(fn), 1);
  }
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    const doc = this.ownerDocument;
    let cur = this;
    while (cur) {
      ev.currentTarget = cur;
      for (const fn of [...(cur._listeners.get(ev.type) || [])]) {
        try {
          fn.call(cur, ev);
        } catch (err) {
          doc?._errors.push(`listener ${ev.type}: ${err && err.message}`);
        }
      }
      if (!ev.bubbles || ev.propagationStopped) break;
      cur = cur.parentNode || (cur === doc?.documentElement ? doc : cur === doc ? doc._window : null);
    }
    return !ev.defaultPrevented;
  }

  // Like a browser: a disabled control cannot take focus, and moving focus
  // fires blur/focusout on the old element and focus/focusin on the new one.
  focus() {
    const doc = this.ownerDocument;
    if (!doc || this.disabled) return;
    const prev = doc.activeElement;
    if (prev === this) return;
    if (prev && prev !== doc.body && prev.nodeType === 1) {
      prev.dispatchEvent(new MockEvent("blur", { bubbles: false }));
      prev.dispatchEvent(new MockEvent("focusout", { bubbles: true }));
    }
    doc.activeElement = this;
    this.dispatchEvent(new MockEvent("focus", { bubbles: false }));
    this.dispatchEvent(new MockEvent("focusin", { bubbles: true }));
  }
  blur() {
    const doc = this.ownerDocument;
    if (!doc || doc.activeElement !== this) return;
    doc.activeElement = doc.body;
    this.dispatchEvent(new MockEvent("blur", { bubbles: false }));
    this.dispatchEvent(new MockEvent("focusout", { bubbles: true }));
  }
  select() {
    this.focus();
  }
  setSelectionRange(a, b) {
    this.selectionStart = a;
    this.selectionEnd = b;
  }
  scrollIntoView() {}
  getBoundingClientRect() {
    return cardGeometryRect(this.ownerDocument, this) ?? { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
  }
  // Pointer capture (v1.2.0 card drag): one capturing element per pointer
  // id; a release by the capturing element fires lostpointercapture.
  setPointerCapture(id) {
    const doc = this.ownerDocument;
    if (!doc || !this.isConnected) throw new Error("InvalidStateError: element not connected");
    const prev = doc._captures.get(Number(id));
    doc._captures.set(Number(id), this);
    if (prev && prev !== this) prev.dispatchEvent(new MockEvent("lostpointercapture", { bubbles: true, pointerId: id, isPrimary: true }));
  }
  releasePointerCapture(id) {
    const doc = this.ownerDocument;
    if (!doc || doc._captures.get(Number(id)) !== this) return;
    doc._captures.delete(Number(id));
    this.dispatchEvent(new MockEvent("lostpointercapture", { bubbles: true, pointerId: id, isPrimary: true }));
  }
  hasPointerCapture(id) {
    return this.ownerDocument?._captures.get(Number(id)) === this;
  }

  click(init = {}) {
    if (this.disabled) return;
    if (this.tagName === "INPUT" && this.type === "radio") {
      // A radio click checks it and unchecks its group; an already checked
      // radio fires no input/change.
      const was = this._checked;
      const name = this.getAttribute("name");
      const group = name && this.ownerDocument ? this.ownerDocument.querySelectorAll("input").filter((r) => r !== this && r.type === "radio" && r.getAttribute("name") === name) : [];
      const before = group.map((r) => r._checked);
      this._checked = true;
      group.forEach((r) => (r._checked = false));
      const ok = this.dispatchEvent(new MockEvent("click", { bubbles: true, cancelable: true, ...init }));
      if (!ok) {
        this._checked = was;
        group.forEach((r, i) => (r._checked = before[i]));
        return;
      }
      if (!was) {
        this.dispatchEvent(new MockEvent("input", { bubbles: true }));
        this.dispatchEvent(new MockEvent("change", { bubbles: true }));
      }
      return;
    }
    const isCheck = this.tagName === "INPUT" && this.type === "checkbox";
    if (isCheck) this._checked = !this._checked;
    const ev = new MockEvent("click", { bubbles: true, cancelable: true, ...init });
    const notCancelled = this.dispatchEvent(ev);
    if (isCheck) {
      if (!notCancelled) {
        this._checked = !this._checked;
        return;
      }
      this.dispatchEvent(new MockEvent("input", { bubbles: true }));
      this.dispatchEvent(new MockEvent("change", { bubbles: true }));
      return;
    }
    if (notCancelled && this.tagName === "A") {
      const href = this.getAttribute("href") || "";
      const win = this.ownerDocument?._window;
      if (href.startsWith("#") && win) win.location.hash = href;
      else if (win) win.__navigations.push(href);
    }
  }

  closest(sel) {
    for (let cur = this; cur && cur.nodeType === 1; cur = cur.parentNode) if (matchesSelector(cur, sel)) return cur;
    return null;
  }
  matches(sel) {
    return matchesSelector(this, sel);
  }
  querySelectorAll(sel) {
    const out = [];
    const visit = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType !== 1) continue;
        if (matchesSelector(c, sel)) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  getElementsByTagName(tag) {
    return this.querySelectorAll(tag);
  }

  cloneNode(deep, doc) {
    const d = doc || this.ownerDocument;
    const copy = new MockElement(this.tagName, d);
    for (const [k, v] of this._attrs) copy._attrs.set(k, v);
    copy.classList._sync(copy._attrs.get("class"));
    copy._value = this._value;
    copy._checked = this._checked;
    if (deep) for (const c of this.childNodes) copy._adopt(c.cloneNode(true, d));
    return copy;
  }
}

// Browsers drop focus when the focused element (or an ancestor) leaves the
// tree, including a move by insertBefore/appendChild: focus goes back to the
// body with no blur event (the focus fixup rule). Code that moves a focused
// card must put focus back itself.
function focusFixup(doc, node) {
  if (!doc || !node || node.nodeType !== 1) return;
  const active = doc.activeElement;
  if (active && active !== doc.body && node.contains(active)) doc.activeElement = doc.body;
}

// --- Card geometry (v1.2.0). A fixed, deterministic layout for the six
// cards in #cardsContainer, in document order, so the drag code's
// getBoundingClientRect() reads have something real to measure: cards are
// stacked from y=120 with a 16 px gap, 480 px tall expanded and 62 px
// collapsed, 600 px wide at x=16; the header row's handle and collapse
// button are 44x44. Rects are viewport-relative (window.scrollY applies).
// Every other element keeps the all-zero rect.
const CARD_GEOMETRY = { top: 120, left: 16, width: 600, gap: 16, open: 480, collapsed: 62, header: 62, button: 44 };
function cardGeometryRect(doc, el) {
  const container = doc?.getElementById?.("cardsContainer");
  if (!container || !container.contains(el)) return null;
  const G = CARD_GEOMETRY;
  const rect = (top, left, width, height) => ({ top, left, width, height, right: left + width, bottom: top + height, x: left, y: top });
  const scrollY = Number(doc._window?.scrollY) || 0;
  let y = G.top - scrollY;
  const cards = container.children.filter((c) => c.classList.contains("calc-section"));
  if (el === container) {
    const total = cards.reduce((h, c) => h + (c.classList.contains("card-collapsed") ? G.collapsed : G.open), 0) + G.gap * Math.max(0, cards.length - 1);
    return rect(y, G.left, G.width, total);
  }
  for (const card of cards) {
    const h = card.classList.contains("card-collapsed") ? G.collapsed : G.open;
    if (card === el) return rect(y, G.left, G.width, h);
    if (card.contains(el)) {
      if (el.closest(".drag-handle")) return rect(y + (G.header - G.button) / 2, G.left + 12, G.button, G.button);
      if (el.closest(".collapse-btn")) return rect(y + (G.header - G.button) / 2, G.left + G.width - 12 - G.button, G.button, G.button);
      if (el.closest(".calc-card-header")) return rect(y, G.left, G.width, G.header);
      if (el.offsetParent === null) return rect(0, 0, 0, 0);
      return rect(y + G.header, G.left + 12, G.width - 24, Math.max(0, h - G.header));
    }
    y += h + G.gap;
  }
  return null;
}
// The scrollable height of the page in the geometry model.
function cardGeometryPageHeight(doc) {
  const r = cardGeometryRect(doc, doc.getElementById?.("cardsContainer"));
  return r ? r.height + CARD_GEOMETRY.top * 2 + 400 : 0;
}

function parseSimple(part) {
  const spec = { tag: null, id: null, classes: [], attrs: [] };
  let rest = part;
  for (const m of rest.matchAll(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)) {
    spec.attrs.push({ name: m[1].trim().toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? null });
  }
  rest = rest.replace(/\[[^\]]*\]/g, "");
  const idm = rest.match(/#([\w-]+)/);
  if (idm) spec.id = idm[1];
  rest = rest.replace(/#[\w-]+/g, "");
  for (const m of rest.matchAll(/\.([\w-]+)/g)) spec.classes.push(m[1]);
  rest = rest.replace(/\.[\w-]+/g, "").trim();
  if (rest && rest !== "*") spec.tag = rest.toUpperCase();
  return spec;
}
function matchesSimple(el, s) {
  if (!el || el.nodeType !== 1) return false;
  if (s.tag && el.tagName !== s.tag) return false;
  if (s.id && el.id !== s.id) return false;
  if (!s.classes.every((c) => el.classList.contains(c))) return false;
  return s.attrs.every((a) => el.hasAttribute(a.name) && (a.value === null || el.getAttribute(a.name) === a.value));
}
const selectorCache = new Map();
function compileChain(chain) {
  if (selectorCache.has(chain)) return selectorCache.get(chain);
  const tokens = chain.trim().replace(/\s*>\s*/g, " > ").match(/(?:[^\s"'[\]]+|\[[^\]]*\])+|>/g) || [];
  const parts = tokens.map((t) => (t === ">" ? { comb: ">" } : { spec: parseSimple(t) }));
  selectorCache.set(chain, parts);
  return parts;
}
function matchesChain(el, chain) {
  const parts = compileChain(chain);
  if (!parts.length || !matchesSimple(el, parts[parts.length - 1].spec)) return false;
  let cur = el;
  let i = parts.length - 2;
  while (i >= 0) {
    if (parts[i].comb === ">") {
      const s = parts[i - 1]?.spec;
      if (!s || !matchesSimple(cur.parentNode, s)) return false;
      cur = cur.parentNode;
      i -= 2;
    } else {
      let anc = cur.parentNode;
      while (anc && anc.nodeType === 1 && !matchesSimple(anc, parts[i].spec)) anc = anc.parentNode;
      if (!anc || anc.nodeType !== 1) return false;
      cur = anc;
      i -= 1;
    }
  }
  return true;
}
function matchesSelector(el, sel) {
  return String(sel).split(",").some((b) => b.trim() && matchesChain(el, b.trim()));
}

class MockDocument {
  constructor() {
    this._listeners = new Map();
    this._window = null;
    this._violations = [];
    this._errors = [];
    this._captures = new Map();
    this.execCalls = [];
    this.visibilityState = "visible";
    this.hidden = false;
    this.documentElement = new MockElement("html", this);
    this.head = new MockElement("head", this);
    this.body = new MockElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  _violation(kind, what) {
    if (this._violations.length < 50) this._violations.push(`${kind}: ${what}`);
  }
  createElement(tag) {
    return new MockElement(tag, this);
  }
  createTextNode(t) {
    return new MockText(t, this);
  }
  createDocumentFragment() {
    const f = new MockElement("#document-fragment", this);
    f.nodeType = 11;
    return f;
  }
  getElementById(id) {
    const want = String(id);
    const find = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType !== 1) continue;
        if (c._attrs.get("id") === want) return c;
        const hit = find(c);
        if (hit) return hit;
      }
      return null;
    };
    return find(this.documentElement);
  }
  querySelector(s) {
    return this.documentElement.querySelector(s);
  }
  querySelectorAll(s) {
    return this.documentElement.querySelectorAll(s);
  }
  getElementsByTagName(t) {
    return this.querySelectorAll(t);
  }
  contains(node) {
    return this.documentElement.contains(node);
  }
  addEventListener(type, fn) {
    const list = this._listeners.get(type) || [];
    list.push(fn);
    this._listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (list && list.includes(fn)) list.splice(list.indexOf(fn), 1);
  }
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    ev.currentTarget = this;
    for (const fn of [...(this._listeners.get(ev.type) || [])]) {
      try {
        fn.call(this, ev);
      } catch (err) {
        this._errors.push(`document listener ${ev.type}: ${err && err.message}`);
      }
    }
    if (ev.bubbles && !ev.propagationStopped && this._window) this._window.dispatchEvent(ev, true);
    return !ev.defaultPrevented;
  }
  execCommand(cmd) {
    const el = this.activeElement;
    this.execCalls.push({ cmd: String(cmd), text: el && typeof el.value === "string" ? el.value : "" });
    return true;
  }
  write() {
    this._violation("sink", "document.write");
    throw new Error("FORBIDDEN: document.write");
  }
  writeln() {
    this._violation("sink", "document.writeln");
    throw new Error("FORBIDDEN: document.writeln");
  }
}
// Element listeners map is `_listeners`; documents use the same name.
Object.defineProperty(MockDocument.prototype, "nodeType", { value: 9 });

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Parses the page markup once (scripts and styles emptied).
function parseHtmlTemplate(html) {
  const doc = new MockDocument();
  const src = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const re = /<(\/?)([A-Za-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  const stack = [doc.documentElement];
  let m;
  while ((m = re.exec(src)) !== null) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      if (m[5].length) top.appendChild(new MockText(decodeEntities(m[5]), doc));
      continue;
    }
    const tag = m[2].toLowerCase();
    if (tag === "html") continue;
    if (m[1] === "/") {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tagName.toLowerCase() === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const el = tag === "head" ? doc.head : tag === "body" ? doc.body : doc.createElement(tag);
    if (el !== doc.head && el !== doc.body) top.appendChild(el);
    for (const a of m[3].matchAll(/([A-Za-z_:][\w.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/=`]+)))?/g)) {
      el.setAttribute(a[1], decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""));
    }
    if (!(m[4] === "/" || VOID_TAGS.has(tag))) stack.push(el);
  }
  return doc;
}

function instantiate(template) {
  const doc = new MockDocument();
  doc.head = template.head.cloneNode(true, doc);
  doc.body = template.body.cloneNode(true, doc);
  doc.documentElement.replaceChildren(doc.head, doc.body);
  doc.activeElement = doc.body;
  return doc;
}

// ============================================================================
// 10. Virtual clock and timers
// ============================================================================

class VirtualTimers {
  constructor(startMs) {
    this.now = startMs;
    this.nextId = 1;
    this.timers = new Map();
    this.setTimeout = (fn, ms = 0, ...args) => this._add(fn, ms, args, false);
    this.setInterval = (fn, ms = 0, ...args) => this._add(fn, ms, args, true);
    this.clearTimeout = (id) => this.timers.delete(Number(id));
    this.clearInterval = this.clearTimeout;
  }
  _add(fn, ms, args, repeat) {
    const id = this.nextId++;
    const delay = Math.max(repeat ? 1 : 0, Number(ms) || 0);
    if (typeof fn === "function") this.timers.set(id, { id, fn, args, at: this.now + delay, every: repeat ? delay : null });
    return id;
  }
  nextDue() {
    let best = null;
    for (const t of this.timers.values()) if (!best || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    return best;
  }
  // Fires every timer due up to now+ms (each at its own virtual time).
  advance(ms, onError) {
    const target = this.now + Math.max(0, ms);
    for (let guardN = 0; guardN < 10000; guardN++) {
      const t = this.nextDue();
      if (!t || t.at > target) break;
      this.now = t.at;
      if (t.every !== null) t.at += t.every;
      else this.timers.delete(t.id);
      try {
        t.fn(...t.args);
      } catch (err) {
        onError?.(err);
      }
    }
    this.now = target;
  }
}

// A sandbox `Date`: real Date instances (so local getters follow TZ and its
// DST rules) whose "now" is the virtual clock.
function makeVirtualDate(timers) {
  const Host = Date;
  function VirtualDate(...args) {
    if (!new.target) return new Host(timers.now).toString();
    return Reflect.construct(Host, args.length === 0 ? [timers.now] : args, new.target);
  }
  VirtualDate.prototype = Host.prototype;
  VirtualDate.now = () => timers.now;
  VirtualDate.UTC = Host.UTC;
  VirtualDate.parse = Host.parse;
  return VirtualDate;
}

class MemoryStorage {
  constructor(initial = {}) {
    this._map = new Map(Object.entries(initial).map(([k, v]) => [String(k), String(v)]));
    this.writes = 0;
    // Every mutation the page makes, in order ({op, key}); clear() counted
    // separately (the page must never call it).
    this.log = [];
    this.clears = 0;
    // Keys whose setItem throws, like a full quota.
    this.refuse = new Set();
  }
  // Another tab's write: changes the shared area without counting as ours.
  external(k, v) {
    if (v === null) this._map.delete(String(k));
    else this._map.set(String(k), String(v));
  }
  writesTo(k) {
    return this.log.filter((e) => e.key === k).length;
  }
  get length() {
    return this._map.size;
  }
  key(i) {
    return [...this._map.keys()][i] ?? null;
  }
  getItem(k) {
    return this._map.has(String(k)) ? this._map.get(String(k)) : null;
  }
  setItem(k, v) {
    if (this.refuse.has(String(k))) throw new Error("QuotaExceededError: the quota has been exceeded");
    this.writes++;
    this.log.push({ op: "set", key: String(k) });
    this._map.set(String(k), String(v));
  }
  removeItem(k) {
    this.log.push({ op: "remove", key: String(k) });
    this._map.delete(String(k));
  }
  clear() {
    this.clears++;
    this._map.clear();
  }
  snapshot() {
    return Object.fromEntries(this._map);
  }
}

// ============================================================================
// 11. Sandboxes
// ============================================================================

function loadUiArtifacts() {
  const mobileHtml = readText("mobile/index.html");
  const script = mobileHtml.match(/<script>([\s\S]*?)<\/script>/);
  if (!script) throw new Error("mobile/index.html has no inline <script>");
  const uiHtml = readText("ui/index.html");
  const uiMain = readText("ui/main.js");
  return {
    mobileHtml,
    mobileTemplate: parseHtmlTemplate(mobileHtml),
    mobileScript: new vm.Script(script[1], { filename: "mobile/index.html:inline-script" }),
    uiHtml,
    uiMain,
    desktopTemplate: parseHtmlTemplate(uiHtml),
    desktopScript: new vm.Script(uiMain, { filename: "ui/main.js" })
  };
}

function makeWindow(doc, timers, extra) {
  const listeners = new Map();
  const win = {
    document: doc,
    __navigations: [],
    location: { protocol: "https:", hostname: "localhost", href: "https://localhost/", hash: "", pathname: "/", search: "", reload() {
      win.__reloads = (win.__reloads || 0) + 1;
    } },
    history: { replaceState(_s, _t, url) {
      win.location.hash = String(url ?? "").includes("#") ? String(url).slice(String(url).indexOf("#")) : "";
    } },
    isSecureContext: true,
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (list && list.includes(fn)) list.splice(list.indexOf(fn), 1);
    },
    dispatchEvent(ev) {
      if (!ev.target) ev.target = win;
      for (const fn of [...(listeners.get(ev.type) || [])]) {
        try {
          fn.call(win, ev);
        } catch (err) {
          doc._errors.push(`window listener ${ev.type}: ${err && err.message}`);
        }
      }
      return !ev.defaultPrevented;
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    // A phone-sized viewport over the card geometry model; scrolling moves
    // every card rect and is clamped to the page.
    innerWidth: 390,
    innerHeight: 800,
    scrollY: 0,
    __scrolls: 0,
    scrollTo(x, y) {
      const top = typeof x === "object" && x !== null ? x.top : y;
      win.scrollY = Math.max(0, Math.min(Number(top) || 0, Math.max(0, cardGeometryPageHeight(doc) - win.innerHeight)));
    },
    scrollBy(x, y) {
      const dy = typeof x === "object" && x !== null ? x.top : y;
      win.__scrolls++;
      win.scrollTo(0, win.scrollY + (Number(dy) || 0));
    },
    requestAnimationFrame: (fn) => timers.setTimeout(fn, 16),
    cancelAnimationFrame: (id) => timers.clearTimeout(id),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    ...extra
  };
  win.window = win;
  win.self = win;
  win._listeners = listeners;
  doc._window = win;
  return win;
}

function baseGlobals(win, timers, doc, errors) {
  return {
    window: win,
    self: win,
    document: doc,
    navigator: win.navigator,
    location: win.location,
    history: win.history,
    Date: makeVirtualDate(timers),
    Event: MockEvent,
    CustomEvent: MockEvent,
    KeyboardEvent: MockEvent,
    MouseEvent: MockEvent,
    PointerEvent: MockEvent,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    queueMicrotask,
    structuredClone,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    requestAnimationFrame: win.requestAnimationFrame,
    console: {
      log() {},
      info() {},
      debug() {},
      warn() {},
      error: (...a) => errors.push(a.map(String).join(" "))
    }
  };
}

function deterministicCrypto(seed) {
  const rnd = mulberry32(seed);
  return {
    getRandomValues(arr) {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(rnd() * 2 ** 32) % 2 ** (8 * (arr.BYTES_PER_ELEMENT || 4));
      return arr;
    }
  };
}

function releaseJson(tag, url) {
  return JSON.stringify({ tag_name: tag, draft: false, prerelease: false, html_url: url, published_at: "2026-11-01T00:00:00Z" });
}

// Page visibility as a browser reports it; fires visibilitychange.
function setPageVisible(sb, visible) {
  sb.doc.visibilityState = visible ? "visible" : "hidden";
  sb.doc.hidden = !visible;
  sb.doc.dispatchEvent(new MockEvent("visibilitychange", { bubbles: false }));
}

async function createMobileSandbox(art, opts = {}) {
  const timers = new VirtualTimers(opts.startMs);
  const doc = instantiate(art.mobileTemplate);
  if (opts.hidden) {
    doc.visibilityState = "hidden";
    doc.hidden = true;
  }
  const errors = [];
  const storage = new MemoryStorage(opts.storage || {});
  const fetchCalls = [];
  const clipboard = [];
  let fetchResponder = opts.fetch || (async () => ({
    ok: true,
    status: 200,
    url: GITHUB_API_LATEST,
    redirected: false,
    headers: { get: () => null },
    text: async () => releaseJson(`v${APP_VERSION}`, `${RELEASE_PREFIX}tag/v${APP_VERSION}`)
  }));
  const swRegs = [];
  const navigator = {
    clipboard: { writeText: async (t) => {
      clipboard.push(String(t));
    } },
    serviceWorker: {
      controller: null,
      addEventListener() {},
      register: async (url, o) => {
        swRegs.push({ url, scope: o?.scope });
        return { update: async () => {} };
      }
    },
    standalone: false,
    userAgent: "DateToolSafetyEval/1.0 (mobile sandbox)"
  };
  const win = makeWindow(doc, timers, {
    navigator,
    crypto: deterministicCrypto(opts.seed ?? 1),
    location: {
      protocol: "https:",
      hostname: "ciphervaults.github.io",
      href: "https://ciphervaults.github.io/Date-Calculator-Tool/",
      pathname: "/Date-Calculator-Tool/",
      hash: "",
      search: "",
      reload() {}
    }
  });
  if (opts.storageBlocked) {
    Object.defineProperty(win, "localStorage", { get() {
      throw new Error("SecurityError: storage blocked");
    } });
  } else {
    win.localStorage = storage;
  }
  const globals = baseGlobals(win, timers, doc, errors);
  globals.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return fetchResponder(url, init);
  };
  win.fetch = globals.fetch;
  globals.crypto = win.crypto;
  if (!opts.storageBlocked) globals.localStorage = storage;
  else Object.defineProperty(globals, "localStorage", { get() {
    throw new Error("SecurityError: storage blocked");
  }, enumerable: true });
  const ctx = vm.createContext(globals);
  try {
    art.mobileScript.runInContext(ctx);
  } catch (err) {
    errors.push(`script threw: ${err && err.stack}`);
  }
  const sb = {
    surface: "mobile",
    doc,
    win,
    timers,
    storage,
    fetchCalls,
    clipboard,
    swRegs,
    errors,
    setFetch(fn) {
      fetchResponder = fn;
    },
    async drain() {
      for (let i = 0; i < 6; i++) await tick();
    },
    async advance(ms, step = 1000) {
      let left = ms;
      while (left > 0) {
        const d = Math.min(step, left);
        timers.advance(d, (err) => errors.push(`timer: ${err && err.message}`));
        left -= d;
        await sb.drain();
      }
    }
  };
  await sb.drain();
  return sb;
}

// The Tauri backend for ui/main.js: engine commands go to the Rust bridge
// exactly as commands.rs::run_op sends them; history and settings follow
// commands.rs in memory (settings validated by the bridge's validate_calendar).
const HISTORY_INPUT_KEYS = {
  between: ["startDate", "endDate", "includeEndDay"],
  add: ["date", "operation", "years", "months", "weeks", "days", "businessDays"],
  business: ["startDate", "endDate", "includeEndDay"],
  age: ["birthDate", "asOfDate", "leapDayRule"],
  info: ["date"],
  countdown: ["targetDate", "targetTime"]
};
// v1.1.0 adds the history read-only commands (plan A3) and the countdown
// store (plan A2).
const NEW_COMMANDS_V110 = ["history_state", "history_retry", "history_reset", "countdown_load", "countdown_save", "countdown_clear"];
// v1.2.0 adds the card layout store (plan A8).
const NEW_COMMANDS_V120 = ["layout_load", "layout_save", "layout_reset"];
const DESKTOP_COMMANDS = new Set([...ENGINE_OPS, "history_list", "history_add", "history_delete", "history_clear",
  "get_settings", "set_settings", "check_for_updates", "open_release_page", "copy_text", "get_app_info",
  "is_smoke_test", "report_smoke_result", ...NEW_COMMANDS_V110, ...NEW_COMMANDS_V120]);

// commands.rs CountdownState + validate_countdown_state, for the stub:
// exactly these keys (finishedSeenAtMs may be absent: serde Option), schema
// 1, a real 0001..9999 date, a time of "" or exactly HH:MM, JS-safe u64s.
const CD_STATE_KEYS = ["schemaVersion", "targetDate", "targetTime", "savedAtMs", "finishedSeenAtMs"];
const CD_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const COUNTDOWN_MAX_BYTES = 1024;
const HISTORY_MAX_BYTES = 1024 * 1024;
const isU64 = (v) => Number.isSafeInteger(v) && v >= 0;
function strictCountdownState(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (!Object.keys(v).every((k) => CD_STATE_KEYS.includes(k))) return null;
  if (!CD_STATE_KEYS.slice(0, 4).every((k) => Object.hasOwn(v, k))) return null;
  const finished = Object.hasOwn(v, "finishedSeenAtMs") ? v.finishedSeenAtMs : null;
  if (!isU64(v.schemaVersion) || v.schemaVersion !== 1) return null;
  if (typeof v.targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.targetDate) || sanitizeDateValue(v.targetDate) !== v.targetDate) return null;
  if (typeof v.targetTime !== "string" || !(v.targetTime === "" || CD_TIME_RE.test(v.targetTime))) return null;
  if (!isU64(v.savedAtMs) || !(finished === null || isU64(finished))) return null;
  return { schemaVersion: 1, targetDate: v.targetDate, targetTime: v.targetTime, savedAtMs: v.savedAtMs, finishedSeenAtMs: finished };
}
// commands.rs declares_newer_schema: an object whose schemaVersion is an
// integer above `current`.
function declaresNewer(value, current) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Number.isSafeInteger(value.schemaVersion) && value.schemaVersion > current;
}
// commands.rs load_countdown_from_path over the stub disk (after the cap).
function parseCountdownFile(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { state: null, status: "corrupt" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: null, status: "corrupt" };
  if (declaresNewer(value, 1)) return { state: null, status: "newer" };
  const state = strictCountdownState(value);
  return state ? { state, status: "ok" } : { state: null, status: "corrupt" };
}

// commands.rs LayoutState + validate_layout_state (plan A8): exactly these
// three keys (deny_unknown_fields, none optional), schemaVersion 1,
// cardOrder a permutation of the six card keys, collapsedCards unique valid
// keys (so at most six).
const LAYOUT_CARD_KEYS = ["between", "add", "business", "age", "info", "countdown"];
const LAYOUT_STATE_KEYS = ["schemaVersion", "cardOrder", "collapsedCards"];
const LAYOUT_MAX_BYTES = 1024;
function strictLayoutState(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== LAYOUT_STATE_KEYS.length || !LAYOUT_STATE_KEYS.every((k) => Object.hasOwn(v, k))) return null;
  if (!isU64(v.schemaVersion) || v.schemaVersion !== 1) return null;
  const { cardOrder, collapsedCards } = v;
  if (!Array.isArray(cardOrder) || !Array.isArray(collapsedCards)) return null;
  if (![...cardOrder, ...collapsedCards].every((k) => typeof k === "string")) return null;
  if (cardOrder.length !== LAYOUT_CARD_KEYS.length || !cardOrder.every((k) => LAYOUT_CARD_KEYS.includes(k)) || new Set(cardOrder).size !== cardOrder.length) return null;
  if (collapsedCards.length > LAYOUT_CARD_KEYS.length || !collapsedCards.every((k) => LAYOUT_CARD_KEYS.includes(k)) || new Set(collapsedCards).size !== collapsedCards.length) return null;
  return { schemaVersion: 1, cardOrder: [...cardOrder], collapsedCards: [...collapsedCards] };
}
const defaultLayoutState = () => ({ schemaVersion: 1, cardOrder: [...LAYOUT_CARD_KEYS], collapsedCards: [] });
// commands.rs load_record_from_path for layout.json over the stub disk
// (after the cap): not JSON or not an object is corrupt; a newer
// schemaVersion is newer (read before the strict parse); else strict or
// corrupt.
function parseLayoutFile(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { state: null, status: "corrupt" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: null, status: "corrupt" };
  if (declaresNewer(value, 1)) return { state: null, status: "newer" };
  const state = strictLayoutState(value);
  return state ? { state, status: "ok" } : { state: null, status: "corrupt" };
}

async function createDesktopBackend(bridge, timers, opts = {}) {
  const defaultCalendar = (await bridge.result("validate_calendar", { calendar: {} })).calendar;
  let settings = { checkUpdatesOnStartup: true, firstDayOfWeek: "monday", calendar: defaultCalendar, schemaVersion: 1 };
  let history = [];
  let nextId = 1;
  // The app data directory as files (raw text or null). Smoke mode never
  // touches it: history and the countdown live in memory, as in commands.rs.
  const seed = opts.disk || {};
  const disk = {
    history: seed.history ?? null,
    historyBak: seed.historyBak ?? null,
    historyReadError: Boolean(seed.historyReadError),
    countdown: seed.countdown ?? null,
    countdownBak: seed.countdownBak ?? null,
    countdownUnreadable: Boolean(seed.countdownUnreadable),
    layout: seed.layout ?? null,
    layoutBak: seed.layoutBak ?? null,
    layoutUnreadable: Boolean(seed.layoutUnreadable),
    // Files renamed aside to a fresh `<name>.bak-<ms>` (commands.rs move_aside).
    historyExtraBaks: [...(seed.historyExtraBaks ?? [])],
    countdownExtraBaks: [...(seed.countdownExtraBaks ?? [])],
    layoutExtraBaks: [...(seed.layoutExtraBaks ?? [])]
  };
  let historyReadOnly = null; // null | "read_error" | "too_large" | "corrupt" | "newer_schema"
  let countdownMemory = null; // smoke mode only
  let layoutMemory = null; // smoke mode only
  const state = {
    calls: [],
    unknown: [],
    copied: [],
    opened: [],
    smoke: null,
    bridgeCalls: 0,
    failSetSettings: 0,
    holds: [],
    held: [],
    smokeDone: null,
    countdownWrites: 0,
    countdownLog: [],
    failCountdownSave: 0,
    historyWrites: 0,
    layoutWrites: 0,
    layoutLog: [],
    failLayoutSave: 0
  };
  let smokeResolve;
  state.smokeDone = new Promise((r) => (smokeResolve = r));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const line = (s) => typeof s === "string" && s.trim() !== "" && Buffer.byteLength(s) <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(s);
  const storedEntryOk = (e) => Boolean(e) && typeof e === "object" && !Array.isArray(e) &&
    Object.keys(e).sort().join() === "calculator,calculatorLabel,copyText,id,inputs,inputsText,resultText,timestampMs" &&
    isU64(e.id) && isU64(e.timestampMs) && Object.hasOwn(HISTORY_INPUT_KEYS, e.calculator) && line(e.calculatorLabel) &&
    line(e.inputsText) && line(e.resultText) && typeof e.copyText === "string" && Buffer.byteLength(e.copyText) <= 1024 &&
    Boolean(e.inputs) && typeof e.inputs === "object" && Object.keys(e.inputs).sort().join() === HISTORY_INPUT_KEYS[e.calculator].slice().sort().join() &&
    HISTORY_INPUT_KEYS[e.calculator].every((k) => typeof e.inputs[k] === "string" && Buffer.byteLength(e.inputs[k]) <= 256);
  // commands.rs load_history_from_path (plan A3) over the stub disk.
  function loadHistoryDisk() {
    if (disk.historyReadError) return { entries: [], readOnly: "read_error" };
    if (disk.history === null) return { entries: [], readOnly: null };
    if (Buffer.byteLength(disk.history) > HISTORY_MAX_BYTES) return { entries: [], readOnly: "too_large" };
    const corrupt = (entries) => {
      if (disk.historyBak === null) disk.historyBak = disk.history;
      return { entries, readOnly: "corrupt" };
    };
    let value;
    try {
      value = JSON.parse(disk.history);
    } catch {
      return corrupt([]);
    }
    if (declaresNewer(value, 1)) return { entries: [], readOnly: "newer_schema" };
    if (!Array.isArray(value)) return corrupt([]);
    const entries = value.filter(storedEntryOk).slice(0, 500);
    return entries.length === value.length ? { entries: clone(entries), readOnly: null } : corrupt(clone(entries));
  }
  function applyHistoryLoad(load) {
    history = load.entries;
    historyReadOnly = load.readOnly;
    // Ids never go backwards.
    nextId = Math.max(nextId, history.reduce((m, e) => Math.max(m, e.id + 1), 1));
  }
  function persistHistory() {
    if (opts.smoke) return;
    state.historyWrites++;
    disk.history = JSON.stringify(history);
  }
  const historyStatus = () => ({ readOnly: historyReadOnly !== null, reason: historyReadOnly });
  const refuseReadOnly = () => {
    if (historyReadOnly !== null) throw "history_read_only";
  };
  const countdownTextIsNewer = (text) => {
    try {
      return declaresNewer(JSON.parse(text), 1);
    } catch {
      return false;
    }
  };
  // commands.rs countdown_slot_replaceable: save and clear only replace a
  // missing file or a readable v1 record (valid or corrupt).
  const refuseCountdownSlot = () => {
    if (disk.countdown === null) return;
    if (disk.countdownUnreadable) throw "countdown_unreadable";
    if (Buffer.byteLength(disk.countdown) > COUNTDOWN_MAX_BYTES) {
      throw Buffer.byteLength(disk.countdown) <= 64 * 1024 && countdownTextIsNewer(disk.countdown) ? "countdown_newer_schema" : "countdown_unreadable";
    }
    if (countdownTextIsNewer(disk.countdown)) throw "countdown_newer_schema";
  };
  // commands.rs record_slot_replaceable for layout.json: a save or reset
  // replaces only a missing file or a readable v1 record (valid or corrupt).
  const layoutTextIsNewer = (text) => {
    try {
      return declaresNewer(JSON.parse(text), 1);
    } catch {
      return false;
    }
  };
  const refuseLayoutSlot = () => {
    if (disk.layout === null) return;
    if (disk.layoutUnreadable) throw "layout_unreadable";
    if (Buffer.byteLength(disk.layout) > LAYOUT_MAX_BYTES) {
      throw Buffer.byteLength(disk.layout) <= 64 * 1024 && layoutTextIsNewer(disk.layout) ? "layout_newer_schema" : "layout_unreadable";
    }
    if (layoutTextIsNewer(disk.layout)) throw "layout_newer_schema";
  };
  // commands.rs record_save_with_path: validate, refuse an unwritable slot,
  // write, and only then update the in-memory copy (smoke: memory only).
  const saveLayoutRecord = (st, op) => {
    const text = JSON.stringify(st);
    if (Buffer.byteLength(text) > LAYOUT_MAX_BYTES) throw "serialized layout exceeds max allowed file size";
    state.layoutLog.push({ op, state: clone(st), at: timers.now });
    if (opts.smoke) {
      layoutMemory = st;
      return null;
    }
    if (state.failLayoutSave > 0) {
      state.failLayoutSave--;
      throw "failed to commit file: injected failure";
    }
    refuseLayoutSlot();
    disk.layout = text;
    disk.layoutUnreadable = false;
    state.layoutWrites++;
    return null;
  };
  if (!opts.smoke) applyHistoryLoad(loadHistoryDisk());
  async function dispatch(cmd, args = {}) {
    if (ENGINE_OPS.includes(cmd)) {
      state.bridgeCalls++;
      const req = args ? args.req : undefined;
      const text = req === undefined ? undefined : JSON.stringify(req);
      if (text !== undefined && Buffer.byteLength(text) > MAX_REQUEST_BYTES) return JSON.parse(INVALID_REQUEST);
      return JSON.parse(await bridge.call(cmd, req));
    }
    switch (cmd) {
      case "is_smoke_test":
        return Boolean(opts.smoke);
      case "get_app_info":
        return {
          name: APP_NAME,
          version: APP_VERSION,
          engineVersion: ENGINE_VERSION,
          tagline: "offline · local · clean",
          creators: ["Mohamed Sayed", "Ahmed Emara"],
          aiBuilders: ["Claude (Anthropic)"],
          credits: "Mohamed Sayed · Ahmed Emara · built with Claude (Anthropic)",
          privacy: "All date calculations run 100% locally in Rust with zero telemetry. History and settings are stored only on this PC and can be cleared anytime. Optional GitHub Releases update checks can be toggled in Settings.",
          historyLimit: 500,
          holidayRulesRange: "1900–2199",
          repositoryUrl: "https://github.com/CipherVaults/Date-Calculator-Tool",
          webAppUrl: "https://ciphervaults.github.io/Date-Calculator-Tool/"
        };
      case "get_settings":
        return clone(settings);
      case "set_settings": {
        if (state.failSetSettings > 0) {
          state.failSetSettings--;
          throw "failed to write settings file: injected failure";
        }
        const v = args?.settings;
        if (!v || typeof v !== "object" || Array.isArray(v)) throw "settings must be a JSON object";
        let calendar = defaultCalendar;
        if (Object.hasOwn(v, "calendar")) {
          const res = await bridge.callValue("validate_calendar", { calendar: v.calendar });
          if (res.ok !== "true") throw `invalid calendar settings: ${res.error.code}${res.error.field ? ` (${res.error.field})` : ""}: ${res.error.message}`;
          calendar = res.result.calendar;
        }
        const keysOk = Object.keys(v).every((k) => ["checkUpdatesOnStartup", "firstDayOfWeek", "calendar", "schemaVersion"].includes(k));
        if (!keysOk || (v.checkUpdatesOnStartup !== undefined && typeof v.checkUpdatesOnStartup !== "boolean") ||
          (v.firstDayOfWeek !== undefined && !["monday", "sunday"].includes(v.firstDayOfWeek))) throw "invalid settings shape";
        if ((v.schemaVersion ?? 1) !== 1) throw "unsupported settings schemaVersion";
        settings = { checkUpdatesOnStartup: v.checkUpdatesOnStartup ?? true, firstDayOfWeek: v.firstDayOfWeek ?? "monday", calendar, schemaVersion: 1 };
        return clone(settings);
      }
      case "history_list":
        return clone(history);
      case "history_state":
        return historyStatus();
      case "history_retry":
        if (!opts.smoke) applyHistoryLoad(loadHistoryDisk());
        return historyStatus();
      case "history_reset":
        if (historyReadOnly === null) throw "history_not_read_only";
        if (!opts.smoke) {
          // commands.rs history_reset_with_path: the current bytes are kept
          // unless .bak already holds the same bytes; renamed to .bak when
          // free, else to a fresh .bak-<ms>. A file that cannot be read
          // (locked) cannot be renamed either, so read-only stays.
          if (disk.historyReadError) throw "failed to keep the old history: the file is in use";
          if (disk.history !== null && disk.history !== disk.historyBak) {
            if (disk.historyBak === null) disk.historyBak = disk.history;
            else disk.historyExtraBaks.push(disk.history);
          }
          disk.history = "[]";
          state.historyWrites++;
        }
        history = [];
        historyReadOnly = null;
        return null;
      case "countdown_load": {
        if (opts.smoke) return countdownMemory ? { state: clone(countdownMemory), status: "ok" } : { state: null, status: "empty" };
        if (disk.countdownUnreadable) return { state: null, status: "unreadable" };
        if (disk.countdown === null) return { state: null, status: "empty" };
        if (Buffer.byteLength(disk.countdown) > COUNTDOWN_MAX_BYTES) {
          // commands.rs load_oversize_countdown: a newer record is left
          // alone; anything else is renamed aside whole (never copied).
          if (Buffer.byteLength(disk.countdown) <= 64 * 1024 && countdownTextIsNewer(disk.countdown)) return { state: null, status: "newer" };
          if (disk.countdownBak === null) disk.countdownBak = disk.countdown;
          else disk.countdownExtraBaks.push(disk.countdown);
          disk.countdown = null;
          return { state: null, status: "corrupt" };
        }
        const load = parseCountdownFile(disk.countdown);
        if (load.status === "corrupt" && disk.countdownBak === null) disk.countdownBak = disk.countdown;
        return load;
      }
      case "countdown_save": {
        // Tauri deserializes `state` strictly, then validate_countdown_state.
        const st = strictCountdownState(args?.state);
        if (!st) throw "invalid args `state` for command `countdown_save`";
        const text = JSON.stringify(st);
        if (Buffer.byteLength(text) > COUNTDOWN_MAX_BYTES) throw "serialized countdown exceeds max allowed file size";
        state.countdownLog.push({ op: "save", state: clone(st), at: timers.now });
        if (opts.smoke) {
          countdownMemory = st;
          return null;
        }
        if (state.failCountdownSave > 0) {
          state.failCountdownSave--;
          throw "failed to commit file: injected failure";
        }
        refuseCountdownSlot();
        disk.countdown = text;
        disk.countdownUnreadable = false;
        state.countdownWrites++;
        return null;
      }
      case "countdown_clear":
        state.countdownLog.push({ op: "clear", at: timers.now });
        if (opts.smoke) {
          countdownMemory = null;
          return null;
        }
        // A newer-schema, over-cap or unreadable record is refused and left
        // in place; the .bak is never touched.
        refuseCountdownSlot();
        if (disk.countdown !== null) state.countdownWrites++;
        disk.countdown = null;
        return null;
      case "layout_load": {
        if (opts.smoke) return layoutMemory ? { state: clone(layoutMemory), status: "ok" } : { state: null, status: "empty" };
        if (disk.layoutUnreadable) return { state: null, status: "unreadable" };
        if (disk.layout === null) return { state: null, status: "empty" };
        if (Buffer.byteLength(disk.layout) > LAYOUT_MAX_BYTES) {
          // load_oversize_record: a newer record is left alone; anything
          // else is renamed aside whole (never copied).
          if (Buffer.byteLength(disk.layout) <= 64 * 1024 && layoutTextIsNewer(disk.layout)) return { state: null, status: "newer" };
          if (disk.layoutBak === null) disk.layoutBak = disk.layout;
          else disk.layoutExtraBaks.push(disk.layout);
          disk.layout = null;
          return { state: null, status: "corrupt" };
        }
        const load = parseLayoutFile(disk.layout);
        // backup_corrupt_file_once: written when .bak is missing, or holds
        // different bytes it can still read (at most the cap).
        if (load.status === "corrupt" && (disk.layoutBak === null || (disk.layoutBak !== disk.layout && Buffer.byteLength(disk.layoutBak) <= LAYOUT_MAX_BYTES))) disk.layoutBak = disk.layout;
        return load;
      }
      case "layout_save": {
        // Tauri deserializes `state` strictly (deny_unknown_fields), then
        // validate_layout_state.
        const st = strictLayoutState(args?.state);
        if (!st) throw "invalid args `state` for command `layout_save`";
        return saveLayoutRecord(st, "save");
      }
      case "layout_reset":
        // layout_reset_with_path is a save of the default layout, refused
        // the same way.
        return saveLayoutRecord(defaultLayoutState(), "reset");
      case "history_add": {
        const e = args?.entry;
        const keys = e && HISTORY_INPUT_KEYS[e.calculator];
        if (!e || !Object.hasOwn(HISTORY_INPUT_KEYS, e.calculator) || !line(e.calculatorLabel) || !line(e.inputsText) ||
          !line(e.resultText) || typeof e.copyText !== "string" || Buffer.byteLength(e.copyText) > 1024 ||
          !e.inputs || Object.keys(e.inputs).sort().join() !== keys.slice().sort().join() ||
          !keys.every((k) => typeof e.inputs[k] === "string" && Buffer.byteLength(e.inputs[k]) <= 256)) {
          throw "invalid history entry";
        }
        refuseReadOnly();
        const first = history[0];
        if (first && first.calculator === e.calculator && canonical(first.inputs) === canonical(e.inputs) && first.resultText === e.resultText) {
          first.timestampMs = timers.now;
          persistHistory();
          return clone(history);
        }
        history.unshift({ id: nextId++, timestampMs: timers.now, calculator: e.calculator, calculatorLabel: e.calculatorLabel,
          inputs: clone(e.inputs), inputsText: e.inputsText, resultText: e.resultText, copyText: e.copyText });
        history = history.slice(0, 500);
        persistHistory();
        return clone(history);
      }
      case "history_delete": {
        refuseReadOnly();
        const next = history.filter((h) => h.id !== args?.id);
        if (next.length !== history.length) {
          history = next;
          persistHistory();
        }
        return clone(history);
      }
      case "history_clear":
        refuseReadOnly();
        history = [];
        persistHistory();
        return [];
      case "check_for_updates":
        return { ok: true, updateAvailable: false, currentVersion: APP_VERSION, latestVersion: APP_VERSION,
          releaseUrl: `${RELEASE_PREFIX}tag/v${APP_VERSION}`, publishedAt: null, error: null };
      case "open_release_page":
        state.opened.push(RELEASE_URL);
        return null;
      case "copy_text": {
        const t = args?.text;
        if (typeof t !== "string" || t.trim() === "" || Buffer.byteLength(t) > 4096) throw "invalid copy text";
        state.copied.push(t);
        return null;
      }
      case "report_smoke_result":
        state.smoke = { passed: args?.passed, details: args?.details };
        smokeResolve(state.smoke);
        return null;
      default:
        state.unknown.push(cmd);
        throw `unknown command ${cmd}`;
    }
  }
  return {
    state,
    disk,
    getHistory: () => clone(history),
    getSettings: () => clone(settings),
    // Holds the next call matching `pred` until release() (IPC race tests).
    holdNext(pred) {
      state.holds.push(pred);
    },
    release(index = 0) {
      const [h] = state.held.splice(index, 1);
      if (h) h.go();
    },
    invoke(cmd, args) {
      state.calls.push(cmd);
      const i = state.holds.findIndex((p) => p(cmd, args));
      if (i >= 0) {
        state.holds.splice(i, 1);
        return new Promise((resolveCall, reject) => {
          state.held.push({ cmd, args, go: () => dispatch(cmd, args).then(resolveCall, reject) });
        });
      }
      return dispatch(cmd, args);
    }
  };
}

async function createDesktopSandbox(art, bridge, opts = {}) {
  const timers = new VirtualTimers(opts.startMs);
  const doc = instantiate(art.desktopTemplate);
  if (opts.hidden) {
    doc.visibilityState = "hidden";
    doc.hidden = true;
  }
  const errors = [];
  const backend = await createDesktopBackend(bridge, timers, opts);
  let inFlight = 0;
  const clipboard = [];
  const invoke = (cmd, args) => {
    inFlight++;
    return Promise.resolve()
      .then(() => backend.invoke(cmd, args))
      .finally(() => {
        inFlight--;
      });
  };
  const navigator = {
    clipboard: { writeText: async (t) => {
      clipboard.push(String(t));
    } },
    userAgent: "DateToolSafetyEval/1.0 (desktop sandbox)"
  };
  const win = makeWindow(doc, timers, {
    navigator,
    crypto: deterministicCrypto(opts.seed ?? 2),
    __TAURI__: { core: { invoke } },
    location: { protocol: "tauri:", hostname: "localhost", href: "tauri://localhost/", pathname: "/", hash: "", search: "", reload() {} }
  });
  const globals = baseGlobals(win, timers, doc, errors);
  globals.crypto = win.crypto;
  const ctx = vm.createContext(globals);
  try {
    art.desktopScript.runInContext(ctx);
  } catch (err) {
    errors.push(`script threw: ${err && err.stack}`);
  }
  const sb = {
    surface: "desktop",
    doc,
    win,
    timers,
    backend,
    clipboard,
    errors,
    inFlight: () => inFlight,
    // Waits until no IPC is pending (held calls excepted) for a few turns.
    async drain() {
      const deadline = Date.now() + 20000;
      let quiet = 0;
      while (quiet < 4) {
        await tick();
        quiet = inFlight - backend.state.held.length <= 0 ? quiet + 1 : 0;
        if (Date.now() > deadline) throw new Error("desktop drain timeout");
      }
    },
    async advance(ms, step = 1000) {
      let left = ms;
      while (left > 0) {
        const d = Math.min(step, left);
        timers.advance(d, (err) => errors.push(`timer: ${err && err.message}`));
        left -= d;
        await sb.drain();
      }
    },
    // Runs virtual time forward (timer by timer) until `promise` settles.
    async runUntil(promise, maxVirtualMs = 600000) {
      let settled = false;
      promise.then(() => (settled = true), () => (settled = true));
      const end = timers.now + maxVirtualMs;
      while (!settled) {
        await sb.drain();
        if (settled) break;
        const next = timers.nextDue();
        if (!next || next.at > end) throw new Error("runUntil: no timer left before the deadline");
        timers.advance(next.at - timers.now, (err) => errors.push(`timer: ${err && err.message}`));
      }
      return promise;
    }
  };
  await sb.drain();
  return sb;
}

// ============================================================================
// 12. UI driver shared by the mobile (B) and desktop (C) slices
// ============================================================================

const HISTORY_KEY = "date_tool_history_v1";
const SETTINGS_KEY = "date_tool_settings_v1";
const CARDS = {
  between: { result: "betweenResult", live: "betweenLiveResult", trace: "betweenTrace", card: "card-between" },
  add: { result: "addResult", live: "addLiveResult", trace: "addTrace", card: "card-add" },
  business: { result: "bizResult", live: "bizLiveResult", trace: "bizTrace", card: "card-business" },
  age: { result: "ageResult", live: "ageLiveResult", trace: "ageTrace", card: "card-age" },
  info: { result: "infoResult", live: "infoLiveResult", trace: "infoTrace", card: "card-info" },
  countdown: { result: "cdResult", live: "cdLiveResult", trace: "cdTrace", card: "card-countdown" }
};
const FORBIDDEN_TAGS = ["IMG", "SCRIPT", "IFRAME", "SVG", "B", "OBJECT", "EMBED", "STYLE", "LINK", "META"];
// Virtual clocks (TZ=America/New_York).
const T_MAIN = Date.UTC(2026, 10, 17, 15, 0, 0); // 2026-11-17 10:00:00 EST
const T_FALL_BACK = Date.UTC(2026, 10, 1, 5, 59, 50); // 2026-11-01 01:59:50 EDT
const T_SPRING_FORWARD = Date.UTC(2026, 2, 8, 6, 59, 50); // 2026-03-08 01:59:50 EST
const T_NEW_YEAR = Date.UTC(2027, 0, 1, 4, 59, 57); // 2026-12-31 23:59:57 EST

function groupInt(n) {
  return String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function clockText(totalSeconds) {
  const A = Math.abs(totalSeconds);
  return `${groupInt(Math.floor(A / 86400))}d ${pad2(Math.floor((A % 86400) / 3600))}h ${pad2(Math.floor((A % 3600) / 60))}m ${pad2(A % 60)}s`;
}
function localIso(ms) {
  const d = new Date(ms);
  return `${String(d.getFullYear()).padStart(4, "0")}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localMoment(ms) {
  const d = new Date(ms);
  return { date: localIso(ms), time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`, utcOffsetMinutes: -d.getTimezoneOffset() };
}
function expectedTrace(lines) {
  return lines.map((l) => (l.startsWith("  ") ? l.trim() : l));
}

function uiDriver(sb) {
  const $ = (id) => sb.doc.getElementById(id);
  const must = (id) => {
    const el = $(id);
    if (!el) throw new Error(`#${id} is missing`);
    return el;
  };
  const fire = (el, type, init = {}) => el.dispatchEvent(new MockEvent(type, { bubbles: true, ...init }));
  return {
    $,
    must,
    text: (id) => ($(id) ? $(id).textContent : ""),
    hidden: (id) => must(id).classList.contains("hidden"),
    // A picker or typed value: input then change (as browsers do for dates).
    async set(id, value) {
      const el = must(id);
      el.value = value;
      fire(el, "input");
      fire(el, "change");
      await sb.drain();
      return el.value;
    },
    async type(id, value) {
      const el = must(id);
      el.value = value;
      fire(el, "input");
      await sb.drain();
      return el.value;
    },
    async select(id, value) {
      const el = must(id);
      el.value = value;
      fire(el, "change");
      await sb.drain();
    },
    async click(id) {
      must(id).click();
      await sb.drain();
    },
    async clickEl(el) {
      el.click();
      await sb.drain();
    },
    async enter(id) {
      fire(must(id), "keydown", { key: "Enter", cancelable: true });
      await sb.drain();
    },
    trace(id) {
      return must(id).querySelectorAll("li").map((li) => li.textContent);
    },
    snapshot(key) {
      const c = CARDS[key];
      return { result: this.text(c.result), live: this.text(c.live), trace: this.trace(c.trace) };
    }
  };
}

function savedSettings(sb, defaults) {
  if (sb.surface === "desktop") return sb.backend.getSettings();
  const raw = sb.storage.getItem(SETTINGS_KEY);
  return raw === null ? defaults : JSON.parse(raw);
}
function savedHistory(sb) {
  if (sb.surface === "desktop") return sb.backend.getHistory();
  const raw = sb.storage.getItem(HISTORY_KEY);
  return raw === null ? [] : JSON.parse(raw);
}
function copiedTexts(sb) {
  return sb.surface === "desktop" ? sb.backend.state.copied : sb.clipboard;
}
function forbiddenTagCount(doc) {
  return FORBIDDEN_TAGS.reduce((n, t) => n + doc.querySelectorAll(t.toLowerCase()).length, 0);
}
function onAttributeCount(doc) {
  return doc.querySelectorAll("*").filter((el) => [...el._attrs.keys()].some((k) => /^on/.test(k))).length;
}

function checkCard(crit, u, key, r, live, label) {
  const c = CARDS[key];
  crit.check(u.text(c.live) === live, () => `${label}: live "${u.text(c.live)}" != "${live}"`);
  const want = expectedTrace(r.traceLines);
  const got = u.trace(c.trace);
  crit.check(canonical(got) === canonical(want), () => `${label}: trace ${excerpt(canonical(got), 200)} != ${excerpt(canonical(want), 200)}`);
}

// The main walk-through on one surface. Returns per-scenario snapshots so
// slice C can compare desktop and mobile text.
async function runUiSuite(slice, sb, ctx) {
  const { bridge } = ctx;
  const u = uiDriver(sb);
  const snaps = {};
  const tag = sb.surface;
  const defaults = { checkUpdatesOnStartup: true, firstDayOfWeek: "monday", calendar: ctx.defaultCalendar, schemaVersion: 1 };
  const cal = () => savedSettings(sb, defaults).calendar;
  const tagsAtBoot = forbiddenTagCount(sb.doc);

  const boot = slice.criterion("boot", `${tag} page boots with no script errors, idle cards ("=—", "→ —"), an empty history and the v${APP_VERSION} footer`);
  await guard(boot, "boot", async () => {
    boot.check(sb.errors.length === 0 && sb.doc._errors.length === 0, () => `errors: ${excerpt([...sb.errors, ...sb.doc._errors].join(" | "), 500)}`);
    for (const key of Object.keys(CARDS)) {
      boot.check(u.text(CARDS[key].result) === "=—", () => `${key} result "${u.text(CARDS[key].result)}"`);
      boot.check(u.text(CARDS[key].live) === "→ —", () => `${key} live "${u.text(CARDS[key].live)}"`);
    }
    boot.check(u.text("historyCount") === "(0 / 500)", () => `history count ${u.text("historyCount")}`);
    boot.check(u.text("appVersion").endsWith(`v${APP_VERSION}`), () => `footer ${u.text("appVersion")}`);
    boot.check(u.text("calendarStatusText").length > 0, "calendar status empty");
    boot.check(sb.doc.activeElement && sb.doc.activeElement.id === "betweenStart", "initial focus is not on betweenStart");
  });

  // ---- Live results on every card ------------------------------------------
  const live = slice.criterion("live-results", `${tag}: typing into each of the six cards renders the engine's live result, trace and result text (checked against the Rust bridge), including clamping, subtract, business mode, Arabic-Indic digits, leap-day rule, an invalid amount and a ticking countdown`);
  await guard(live, "live results", async () => {
    await u.set("betweenStart", "2024-01-31");
    live.check(u.text("betweenLiveResult") === "→ —", "one date alone must stay idle");
    await u.set("betweenEnd", "2025-03-01");
    let r = await bridge.result("calc_days_between", { startDate: "2024-01-31", endDate: "2025-03-01", includeEndDay: false });
    checkCard(live, u, "between", r, `→ ${r.summaryText}`, "between");
    live.check(u.text("betweenResult").startsWith(`=${r.breakdownText}`) && u.text("betweenResult").includes(r.weeksText), () => `between result ${u.text("betweenResult")}`);
    await u.click("betweenIncludeEnd");
    r = await bridge.result("calc_days_between", { startDate: "2024-01-31", endDate: "2025-03-01", includeEndDay: true });
    checkCard(live, u, "between", r, `→ ${r.summaryText}`, "between +1");
    snaps.between = u.snapshot("between");

    await u.set("addStart", "2024-01-31");
    await u.type("addMonths", "1");
    const addReq = (o) => ({ date: "2024-01-31", operation: "add", years: "", months: "1", weeks: "", days: "", businessDays: false, calendar: cal(), ...o });
    r = await bridge.result("calc_add_subtract", addReq({}));
    checkCard(live, u, "add", r, `→ ${r.resultDate} (${r.resultWeekday})`, "add clamp");
    live.check(r.resultDate === "2024-02-29" && u.text("addResult").includes("The day was moved to the last day of the month."), () => `clamp note missing: ${u.text("addResult")}`);
    await u.click("addModeSubtractBtn");
    r = await bridge.result("calc_add_subtract", addReq({ operation: "subtract" }));
    checkCard(live, u, "add", r, `→ ${r.resultDate} (${r.resultWeekday})`, "subtract");
    live.check(u.must("addModeSubtractBtn").getAttribute("aria-pressed") === "true", "subtract not pressed");
    await u.click("addModeAddBtn");
    const typed = await u.type("addDays", "١٢");
    live.check(typed === "12", () => `Arabic-Indic digits not normalised: "${typed}"`);
    r = await bridge.result("calc_add_subtract", addReq({ days: "12" }));
    checkCard(live, u, "add", r, `→ ${r.resultDate} (${r.resultWeekday})`, "add days 12");
    await u.click("addBusiness");
    live.check(!u.hidden("addBusinessNote") && u.text("addWeeksLabel") === "Business weeks", "business mode UI not shown");
    r = await bridge.result("calc_add_subtract", addReq({ days: "12", businessDays: true }));
    checkCard(live, u, "add", r, `→ ${r.resultDate} (${r.resultWeekday})`, "add business");
    await u.type("addYears", "1.5");
    const bad = await bridge.callValue("calc_add_subtract", addReq({ days: "12", businessDays: true, years: "1.5" }));
    live.check(bad.ok === "false" && u.text("addLiveResult") === "→ invalid" && u.must("addResult").querySelector(".error-text")?.textContent === bad.error.message,
      () => `invalid amount: live "${u.text("addLiveResult")}" result "${u.text("addResult")}"`);
    await u.type("addYears", "");
    await u.click("addBusiness");
    snaps.add = u.snapshot("add");

    await u.set("bizStart", "2024-12-23");
    await u.set("bizEnd", "2025-01-03");
    r = await bridge.result("calc_business_days", { startDate: "2024-12-23", endDate: "2025-01-03", includeEndDay: false, calendar: cal() });
    checkCard(live, u, "business", r, `→ ${r.summaryText}`, "business");
    live.check(u.must("bizCalGrid").children.length === 42, "business mini calendar is not 42 cells");
    snaps.business = u.snapshot("business");

    await u.set("ageBirth", "2000-02-29");
    r = await bridge.result("calc_age", { birthDate: "2000-02-29", asOfDate: localIso(sb.timers.now), leapDayRule: "feb28" });
    checkCard(live, u, "age", r, `→ ${r.ageText}`, "age (as of today)");
    live.check(u.text("ageAsOfHint") === `empty = today (${localIso(sb.timers.now)})`, () => `age hint ${u.text("ageAsOfHint")}`);
    await u.click("ageLeapMar1Btn");
    r = await bridge.result("calc_age", { birthDate: "2000-02-29", asOfDate: localIso(sb.timers.now), leapDayRule: "mar1" });
    checkCard(live, u, "age", r, `→ ${r.ageText}`, "age mar1");
    snaps.age = u.snapshot("age");

    await u.set("infoDate", "2024-12-30");
    r = await bridge.result("calc_date_info", { date: "2024-12-30", today: localIso(sb.timers.now) });
    checkCard(live, u, "info", r, `→ ${r.weekday} · ${r.isoWeekText}`, "info");
    live.check(u.text("infoResult").includes(r.relativeText), () => `relative text missing: ${r.relativeText}`);
    snaps.info = u.snapshot("info");

    await u.set("cdTarget", "2026-12-25");
    const target = { date: "2026-12-25", time: "", utcOffsetMinutes: -new Date(2026, 11, 25).getTimezoneOffset() };
    r = await bridge.result("calc_countdown", { now: localMoment(sb.timers.now), target });
    live.check(u.text("cdClock") === r.clockText, () => `countdown clock "${u.text("cdClock")}" != "${r.clockText}"`);
    checkCard(live, u, "countdown", r, `→ ${r.text}`, "countdown");
    snaps.countdown = u.snapshot("countdown");
    await sb.advance(3050);
    r = await bridge.result("calc_countdown", { now: localMoment(Math.floor(sb.timers.now / 1000) * 1000), target });
    live.check(u.text("cdClock") === r.clockText, () => `countdown after 3 s "${u.text("cdClock")}" != "${r.clockText}"`);
    await u.click("cdQuick30Btn");
    const plus30 = await bridge.result("calc_add_subtract", { date: localIso(sb.timers.now), operation: "add", days: "30" });
    live.check(u.must("cdTarget").value === plus30.resultDate, () => `+30d quick pill set ${u.must("cdTarget").value}`);
    await u.set("cdTarget", "2026-12-25");
  });

  // ---- History --------------------------------------------------------------
  const hist = slice.criterion("history-flows", `${tag}: Enter and Calculate save to history (newest first, consecutive duplicates merged), Copy copies the engine copyText and saves, the filter, per-entry delete and the two-step clear work, and storage holds exactly the restorable inputs`);
  await guard(hist, "history", async () => {
    await u.enter("betweenEnd");
    hist.check(u.text("historyCount") === "(1 / 500)", () => `after Enter: ${u.text("historyCount")}`);
    let h = savedHistory(sb);
    hist.check(h.length === 1 && h[0].calculator === "between" && canonical(h[0].inputs) === canonical({ startDate: "2024-01-31", endDate: "2025-03-01", includeEndDay: "true" }),
      () => `stored ${excerpt(JSON.stringify(h), 300)}`);
    await u.enter("betweenStart");
    hist.check(savedHistory(sb).length === 1, "duplicate Enter added an entry");
    await u.click("calcAddBtn");
    h = savedHistory(sb);
    hist.check(h.length === 2 && h[0].calculator === "add", () => `after Calculate: ${h.map((e) => e.calculator)}`);
    const before = copiedTexts(sb).length;
    await u.click("copyInfoBtn");
    const info = await bridge.result("calc_date_info", { date: "2024-12-30", today: localIso(sb.timers.now) });
    hist.check(copiedTexts(sb).length === before + 1 && copiedTexts(sb).at(-1) === info.copyText, "copy did not copy the engine copyText");
    hist.check(u.text("copyInfoBtn") === "copied", () => `copy feedback "${u.text("copyInfoBtn")}"`);
    hist.check(savedHistory(sb).length === 3 && u.text("historyCount") === "(3 / 500)", "copy did not record history");
    await sb.advance(1300);
    hist.check(u.text("copyInfoBtn") === "copy", () => `copy feedback did not reset: "${u.text("copyInfoBtn")}"`);
    await u.select("historyFilter", "age");
    hist.check(u.must("historyList").querySelectorAll(".history-item").length === 0 && u.text("historyList").includes("No matching"), "age filter");
    await u.select("historyFilter", "info");
    hist.check(u.must("historyList").querySelectorAll(".history-item").length === 1, "info filter");
    await u.select("historyFilter", "all");
    const items = u.must("historyList").querySelectorAll(".history-item");
    hist.check(items.length === 3 && items[0].textContent.includes("Date Info"), "newest first");
    await u.clickEl(items[0].querySelector(".history-delete-btn"));
    hist.check(savedHistory(sb).length === 2 && u.text("historyCount") === "(2 / 500)", "delete");
  });

  const restore = slice.criterion("restore-and-clear", `${tag}: clear empties a card, restore refills it from history and recomputes, clear all resets every card, and the clear-history confirm/cancel flow empties storage`);
  await guard(restore, "restore", async () => {
    const liveBefore = u.text("betweenLiveResult");
    await u.click("resetBetweenBtn");
    restore.check(u.must("betweenStart").value === "" && u.must("betweenEnd").value === "" && u.text("betweenResult") === "=—" && u.text("betweenLiveResult") === "→ —" && !u.must("betweenIncludeEnd").checked,
      "clear did not reset the between card");
    const item = u.must("historyList").querySelectorAll(".history-item").find((it) => it.textContent.includes("Days Between"));
    await u.clickEl(item.querySelector(".history-restore-btn"));
    restore.check(u.must("betweenStart").value === "2024-01-31" && u.must("betweenEnd").value === "2025-03-01" && u.must("betweenIncludeEnd").checked,
      "restore did not refill the inputs");
    restore.check(u.text("betweenLiveResult") === liveBefore, () => `restored live "${u.text("betweenLiveResult")}" != "${liveBefore}"`);
    restore.check(u.must("card-between").classList.contains("card-restored"), "restored card not flashed");
    await u.click("clearAllBtn");
    for (const id of ["betweenStart", "betweenEnd", "addStart", "addMonths", "addDays", "bizStart", "bizEnd", "ageBirth", "ageAsOf", "infoDate", "cdTarget", "cdTime"]) {
      restore.check(u.must(id).value === "", () => `clear all left ${id} = ${u.must(id).value}`);
    }
    for (const key of Object.keys(CARDS)) restore.check(u.text(CARDS[key].result) === "=—", () => `clear all left ${key} result`);
    restore.check(u.text("cdClock") === "—", "countdown clock not idle");
    await u.click("clearHistoryBtn");
    restore.check(!u.hidden("clearHistoryConfirm") && u.hidden("clearHistoryBtn"), "confirm not shown");
    await u.click("cancelClearHistoryBtn");
    restore.check(u.hidden("clearHistoryConfirm") && savedHistory(sb).length === 2, "cancel cleared history");
    await u.click("clearHistoryBtn");
    await u.click("confirmClearHistoryBtn");
    restore.check(savedHistory(sb).length === 0 && u.text("historyCount") === "(0 / 500)", "confirm did not clear history");
    if (sb.surface === "mobile") restore.check(sb.storage.getItem(HISTORY_KEY) === null, "history key still in storage");
  });

  // ---- Settings ---------------------------------------------------------------
  const weekend = slice.criterion("settings-weekend", `${tag}: weekend presets and custom days save (commit on success), drive the business card and summaries, and a seven-day weekend is refused with an error and nothing saved`);
  await guard(weekend, "weekend", async () => {
    await u.set("bizStart", "2024-12-23");
    await u.set("bizEnd", "2025-01-03");
    await u.click("settingsBtn");
    weekend.check(!u.hidden("settingsModal"), "settings modal did not open");
    await u.click("weekendFriSatBtn");
    weekend.check(canonical(cal().weekend) === "[5,6]", () => `saved weekend ${canonical(cal().weekend)}`);
    weekend.check(u.must("weekendFriSatBtn").getAttribute("aria-pressed") === "true" && u.text("bizCalendarSummaryText").startsWith("Fri/Sat"), () => `summary ${u.text("bizCalendarSummaryText")}`);
    let r = await bridge.result("calc_business_days", { startDate: "2024-12-23", endDate: "2025-01-03", includeEndDay: false, calendar: cal() });
    checkCard(weekend, u, "business", r, `→ ${r.summaryText}`, "Fri/Sat business");
    await u.click("weekendCustomBtn");
    weekend.check(!u.hidden("weekendCustomFieldset"), "custom fieldset hidden");
    await u.click("weekendDay1");
    weekend.check(canonical(cal().weekend) === "[1,5,6]", () => `custom weekend ${canonical(cal().weekend)}`);
    for (const d of [2, 3, 4]) await u.click(`weekendDay${d}`);
    weekend.check(canonical(cal().weekend) === "[1,2,3,4,5,6]" && u.text("weekendNote") === "1 working day per week.", () => `six-day weekend ${canonical(cal().weekend)} / ${u.text("weekendNote")}`);
    await u.click("weekendDay7");
    weekend.check(!u.hidden("weekendError") && u.text("weekendError") === "The weekend cannot cover all seven days.", "seven-day weekend not refused");
    weekend.check(canonical(cal().weekend) === "[1,2,3,4,5,6]" && !u.must("weekendDay7").checked, "seven-day weekend was saved");
    await u.click("weekendSatSunBtn");
    weekend.check(canonical(cal().weekend) === "[6,7]" && u.hidden("weekendError"), "back to Sat/Sun");
  });

  const preset = slice.criterion("settings-preset-egypt", `${tag}: the UK preset lists its holidays and changes the business count; choosing Egypt switches the weekend to Fri/Sat and shows the Hijri offset stepper; leaving Egypt keeps the weekend`);
  await guard(preset, "presets", async () => {
    await u.select("holidayPresetSelect", "uk");
    preset.check(cal().preset === "uk", "uk not saved");
    const year = Number(localIso(sb.timers.now).slice(0, 4));
    const listing = await bridge.result("holidays_in_range", { startDate: `${year}-01-01`, endDate: `${year}-12-31`, calendar: { ...cal(), excludedHolidays: { us: [], uk: [], eg: [] }, customHolidays: [] } });
    const rows = u.must("holidayPreviewList").querySelectorAll("li.holiday-row");
    preset.check(rows.length === listing.holidays.length && rows.length > 0, () => `preview rows ${rows.length} vs ${listing.holidays.length}`);
    const r = await bridge.result("calc_business_days", { startDate: "2024-12-23", endDate: "2025-01-03", includeEndDay: false, calendar: cal() });
    checkCard(preset, u, "business", r, `→ ${r.summaryText}`, "UK business");
    preset.check(!u.hidden("bizHolidayHits") && u.must("bizHolidayList").querySelectorAll("li").length === r.holidays.length, "holiday hits not listed");
    await u.select("holidayPresetSelect", "eg");
    preset.check(cal().preset === "eg" && canonical(cal().weekend) === "[5,6]", () => `Egypt saved ${cal().preset} ${canonical(cal().weekend)}`);
    preset.check(!u.hidden("egyptWeekendNote") && !u.hidden("hijriBlock") && u.must("weekendFriSatBtn").getAttribute("aria-pressed") === "true", "Egypt UI");
    await u.click("hijriOffsetPlusBtn");
    preset.check(cal().hijriOffsetDays === 1 && u.text("hijriOffsetValue") === "+1", () => `hijri offset ${cal().hijriOffsetDays} / ${u.text("hijriOffsetValue")}`);
    await u.click("hijriOffsetPlusBtn");
    await u.click("hijriOffsetPlusBtn");
    preset.check(cal().hijriOffsetDays === 2 && u.must("hijriOffsetPlusBtn").disabled, "hijri offset not capped at +2");
    await u.click("hijriOffsetMinusBtn");
    await u.click("hijriOffsetMinusBtn");
    await u.select("holidayPresetSelect", "none");
    preset.check(cal().preset === "none" && canonical(cal().weekend) === "[5,6]" && u.hidden("hijriBlock"), "leaving Egypt changed the weekend");
    await u.click("weekendSatSunBtn");
  });

  const hostile = slice.criterion("hostile-names-literal", `${tag}: custom holiday names such as <img src=x onerror=alert(1)> and </script> render as literal text in settings, business hits and date info, never as elements; summaries and history show only a count; blank and 61-character names are refused`);
  await guard(hostile, "hostile names", async () => {
    const names = ["<img src=x onerror=alert(1)>", "</script><script>alert(1)</script>", "<b>x</b>"];
    for (let i = 0; i < names.length; i++) {
      await u.type("customHolidayName", names[i]);
      await u.set("customHolidayDate", `2026-12-0${i + 2}`);
      await u.click("addCustomHolidayBtn");
    }
    const customs = cal().customHolidays;
    hostile.check(customs.length === 3 && customs.every((c, i) => c.name === names[i] && /^c-[0-9a-f]{8}$/.test(c.id)), () => `saved ${excerpt(JSON.stringify(customs), 300)}`);
    const shown = u.must("customHolidayList").querySelectorAll(".holiday-name").map((s) => s.textContent);
    hostile.check(canonical(shown) === canonical(names), () => `listed ${canonical(shown)}`);
    hostile.check(u.text("bizCalendarSummaryText").includes("3 custom holidays") && !u.text("bizCalendarSummaryText").includes("<"), () => `summary ${u.text("bizCalendarSummaryText")}`);
    await u.set("bizStart", "2026-12-01");
    await u.set("bizEnd", "2026-12-07");
    const hits = u.must("bizHolidayList").querySelectorAll(".holiday-hit-name").map((s) => s.firstChild?.textContent ?? s.textContent);
    hostile.check(canonical(hits) === canonical(names), () => `hits ${canonical(hits)}`);
    await u.set("infoDate", "2026-12-02");
    hostile.check(u.text("infoResult").includes(`holiday: ${names[0]}`), () => `info ${excerpt(u.text("infoResult"), 200)}`);
    await u.enter("bizEnd");
    const h = savedHistory(sb)[0];
    hostile.check(h && h.calculator === "business" && !/[<>]/.test(h.inputsText + h.resultText), () => `history leaks a name: ${h && h.inputsText}`);
    hostile.check(forbiddenTagCount(sb.doc) === tagsAtBoot && onAttributeCount(sb.doc) === 0, "an element or on* attribute was created from data");
    await u.type("customHolidayName", "   ");
    await u.set("customHolidayDate", "2026-12-09");
    await u.click("addCustomHolidayBtn");
    hostile.check(!u.hidden("customHolidayError") && cal().customHolidays.length === 3, "blank name accepted");
    await u.type("customHolidayName", "a".repeat(61));
    await u.click("addCustomHolidayBtn");
    hostile.check(!u.hidden("customHolidayError") && cal().customHolidays.length === 3, "61-character name accepted");
    for (const btn of u.must("customHolidayList").querySelectorAll("button")) await u.clickEl(btn);
    hostile.check(cal().customHolidays.length === 0, "custom holidays not deleted");
    await u.click("closeSettingsBtn");
    hostile.check(u.hidden("settingsModal"), "settings modal did not close");
  });

  const safety = slice.criterion("dom-safety", `${tag}: the whole walk-through never touched innerHTML/outerHTML/insertAdjacentHTML/document.write or element .style, created no on* attributes, and links stay on the allowed hosts`);
  await guard(safety, "dom safety", async () => {
    safety.check(sb.doc._violations.length === 0, () => `violations: ${sb.doc._violations.join(" | ")}`);
    safety.check(onAttributeCount(sb.doc) === 0, "on* attribute present");
    for (const a of sb.doc.querySelectorAll("a")) {
      const href = a.getAttribute("href") || "";
      safety.check(/^#[\w-]+$/.test(href) || href.startsWith("https://github.com/CipherVaults/Date-Calculator-Tool") || href.startsWith("https://ciphervaults.github.io/Date-Calculator-Tool/"),
        () => `unexpected link ${href}`);
    }
    safety.check(sb.errors.length === 0 && sb.doc._errors.length === 0, () => `errors: ${excerpt([...sb.errors, ...sb.doc._errors].join(" | "), 500)}`);
  });

  return snaps;
}

// Countdown across both DST changes and the New Year midnight rollover, in
// fresh sandboxes whose virtual clock starts at the given instants.
async function runClockSuite(slice, make, ctx) {
  const { bridge } = ctx;
  const dst = slice.criterion("countdown-dst", "the countdown ticks once per virtual second and always shows target - now in real elapsed seconds across the 2026-11-01 fall-back (01:59:50 EDT -> 01:00 EST) and the 2026-03-08 spring-forward (01:59:50 EST -> 03:00 EDT)");
  for (const [start, targetTime, label] of [[T_FALL_BACK, "03:00", "fall back"], [T_SPRING_FORWARD, "04:00", "spring forward"]]) {
    await guard(dst, label, async () => {
      const sb = await make(start);
      const u = uiDriver(sb);
      const targetDate = localIso(start);
      await u.set("cdTarget", targetDate);
      await u.set("cdTime", targetTime);
      const [hh, mm] = targetTime.split(":").map(Number);
      const tParts = targetDate.split("-").map(Number);
      const T = Math.floor(new Date(tParts[0], tParts[1] - 1, tParts[2], hh, mm).getTime() / 1000);
      dst.check(u.text("cdClock") === clockText(T - Math.floor(sb.timers.now / 1000)), () => `${label} start ${u.text("cdClock")}`);
      await sb.advance(50);
      let prev = null;
      for (let k = 1; k <= 25; k++) {
        await sb.advance(1000);
        const want = clockText(T - Math.floor(sb.timers.now / 1000));
        const got = u.text("cdClock");
        dst.check(got === want, () => `${label} tick ${k} at ${new Date(sb.timers.now).toISOString()}: "${got}" != "${want}"`);
        if (prev !== null) dst.check(got !== prev, () => `${label} tick ${k}: clock did not change`);
        prev = got;
      }
      const offsetsCrossed = new Date(start).getTimezoneOffset() !== new Date(sb.timers.now).getTimezoneOffset();
      dst.check(offsetsCrossed, `${label}: the virtual clock did not cross a UTC offset change (TZ is ${process.env.TZ})`);
      const r = await bridge.result("calc_countdown", { now: localMoment(Math.floor(sb.timers.now / 1000) * 1000), target: { date: targetDate, time: targetTime, utcOffsetMinutes: -new Date(tParts[0], tParts[1] - 1, tParts[2], hh, mm).getTimezoneOffset() } });
      dst.check(u.text("cdClock") === r.clockText, () => `${label}: clock vs Rust ${r.clockText}`);
      dst.check(sb.errors.length === 0 && sb.doc._errors.length === 0, () => `${label} errors: ${sb.errors.join(" | ")}`);
    });
  }

  const roll = slice.criterion("midnight-rollover", "at 2026-12-31 23:59:57 the countdown to 2027-01-01 runs 3, 2, 1, now, then 1 s past (is-past), with the status and the finished chip from 00:00:00 on (v1.1.0 wording), and on the 00:00 tick the date info relative text, the age hint and the empty-as-of age switch to the new day");
  await guard(roll, "rollover", async () => {
    const sb = await make(T_NEW_YEAR);
    const u = uiDriver(sb);
    await u.set("infoDate", "2027-01-01");
    await u.set("ageBirth", "2000-01-01");
    await u.set("cdTarget", "2027-01-01");
    const before = await bridge.result("calc_date_info", { date: "2027-01-01", today: "2026-12-31" });
    roll.check(u.text("infoResult").includes(before.relativeText) && u.text("ageAsOfHint") === "empty = today (2026-12-31)", () => `before: ${before.relativeText} / ${u.text("ageAsOfHint")}`);
    roll.check(u.text("cdClock") === "0d 00h 00m 03s" && u.text("cdStatus").startsWith("Counting down"), () => `start ${u.text("cdClock")} / ${u.text("cdStatus")}`);
    await sb.advance(50);
    // v1.1.0 (plan A2): `now` is already the finished signal, so the status
    // and the phase chip switch at 00:00:00, not one second later.
    const fin = "Finished: 2027-01-01 00:00:00 (Friday) has passed. Counting the time since.";
    const want = [["0d 00h 00m 02s", "Counting down to 2027-01-01 00:00:00", "counting down"], ["0d 00h 00m 01s", "Counting down to", "counting down"],
      ["0d 00h 00m 00s", fin, "finished"], ["0d 00h 00m 01s", fin, "finished"], ["0d 00h 00m 02s", fin, "finished"]];
    for (let k = 0; k < want.length; k++) {
      await sb.advance(1000);
      roll.check(u.text("cdClock") === want[k][0] && u.text("cdStatus").startsWith(want[k][1]) && u.text("cdPhase") === want[k][2],
        () => `step ${k + 1}: "${u.text("cdClock")}" / "${u.text("cdStatus")}" / chip "${u.text("cdPhase")}"`);
    }
    roll.check(u.must("cdPhase").classList.contains("is-finished"), "finished chip lacks is-finished");
    roll.check(u.must("cdClock").classList.contains("is-past"), "past clock lacks is-past");
    const after = await bridge.result("calc_date_info", { date: "2027-01-01", today: "2027-01-01" });
    roll.check(after.relativeText === "Today" && u.text("infoResult").includes("Today") && !u.text("infoResult").includes(before.relativeText), () => `info after midnight: ${excerpt(u.text("infoResult"), 200)}`);
    roll.check(u.text("ageAsOfHint") === "empty = today (2027-01-01)", () => `age hint ${u.text("ageAsOfHint")}`);
    const age = await bridge.result("calc_age", { birthDate: "2000-01-01", asOfDate: "2027-01-01", leapDayRule: "feb28" });
    roll.check(u.text("ageLiveResult") === `→ ${age.ageText}` && age.ageText === "27 years", () => `age after midnight ${u.text("ageLiveResult")}`);
    roll.check(sb.errors.length === 0 && sb.doc._errors.length === 0, () => `errors: ${sb.errors.join(" | ")}`);
  });
}

// ============================================================================
// 12b. v1.1.0 behaviour (plan A6), shared by slices B and C
// ============================================================================
//
// Each probe drives fresh sandboxes from `make(startMs, extra)` and reports
// through `c.check`. Slices B and C run them on the real pages as criteria;
// slice D runs the same probes on planted mutants of the pages, where at
// least one check must fail (a probe that cannot see its mutant is vacuous).

const COUNTDOWN_KEY = "date_tool_countdown_v1";
const LAYOUT_KEY = "date_tool_layout_v1";
// The shared wording (ui/main.js and mobile/index.html UI_TEXT, contract).
const CD_TEXT = {
  counting: (when) => `Counting down to ${when}.`,
  restored: (left, when) => `Countdown restored: ${left} left until ${when}.`,
  finished: (when) => `Finished: ${when} has passed. Counting the time since.`,
  finishedClosed: (when) => `Finished while the app was closed: ${when}. Counting the time since.`,
  chipCounting: "counting down",
  chipRestored: "restored",
  chipFinished: "finished",
  chipFinishedClosed: "finished while closed",
  saved: "Saved on this device. It resumes when you reopen the app.",
  forget: "Forget",
  newer: "Saved countdown is from a newer version.",
  unreadable: "The saved countdown could not be read, so it is left untouched.",
  writeFailed: "The countdown could not be saved on this device."
};
const CAL_TEXT = { start: ", start", end: ", end", selected: ", selected", hintStart: "Next click sets the start date.", hintEnd: "Next click sets the end date." };
const HISTORY_TEXT = {
  banner: "History could not be read safely. Nothing will be overwritten.",
  read_error: "The history file could not be read. Another program may be using it.",
  too_large: "The history file is larger than the size limit.",
  corrupt: "The history file is damaged or has entries that cannot be read.",
  newer_schema: "The history file is from a newer version of the app.",
  resetFailed: "A new history could not be started. Try again."
};
const GOOD_ENTRY = { id: 7, timestampMs: 1, calculator: "info", calculatorLabel: "Date Info", inputs: { date: "2024-01-01" }, inputsText: "2024-01-01", resultText: "Monday, January 1, 2024", copyText: "Monday, January 1, 2024" };

// Reports into a list instead of a criterion (mutant runs).
class Collector {
  constructor() {
    this.problems = [];
  }
  check(ok, detail) {
    if (!ok) this.problems.push(typeof detail === "function" ? detail() : String(detail ?? "failed"));
    return Boolean(ok);
  }
  fail(detail) {
    return this.check(false, detail);
  }
  note() {}
}

// The per-surface store: localStorage keys on mobile, files on desktop.
function cdRaw(sb) {
  return sb.surface === "mobile" ? sb.storage.getItem(COUNTDOWN_KEY) : sb.backend.disk.countdown;
}
function cdBak(sb) {
  return sb.surface === "mobile" ? sb.storage.getItem(`${COUNTDOWN_KEY}_bak`) : sb.backend.disk.countdownBak;
}
function cdRecord(sb) {
  const raw = cdRaw(sb);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
function cdWrites(sb) {
  return sb.surface === "mobile" ? sb.storage.writesTo(COUNTDOWN_KEY) : sb.backend.state.countdownWrites;
}
function historyRaw(sb) {
  return sb.surface === "mobile" ? sb.storage.getItem(HISTORY_KEY) : sb.backend.disk.history;
}
function historyBak(sb) {
  return sb.surface === "mobile" ? sb.storage.getItem(`${HISTORY_KEY}_bak`) : sb.backend.disk.historyBak;
}
// Values kept under a fresh backup name (desktop `<name>.bak-<ms>`, mobile
// `<key>_bak_<ms>`) because `.bak` already held something else.
function historyExtraBaks(sb) {
  if (sb.surface !== "mobile") return [...sb.backend.disk.historyExtraBaks];
  const snap = sb.storage.snapshot();
  return Object.keys(snap).filter((k) => k.startsWith(`${HISTORY_KEY}_bak_`)).map((k) => snap[k]);
}
function countdownExtraBaks(sb) {
  if (sb.surface !== "mobile") return [...sb.backend.disk.countdownExtraBaks];
  const snap = sb.storage.snapshot();
  return Object.keys(snap).filter((k) => k.startsWith(`${COUNTDOWN_KEY}_bak_`)).map((k) => snap[k]);
}
function setHistoryRaw(sb, raw) {
  if (sb.surface === "mobile") sb.storage.external(HISTORY_KEY, raw);
  else sb.backend.disk.history = raw;
}
function historyAddCalls(sb) {
  return sb.surface === "mobile" ? sb.storage.writesTo(HISTORY_KEY) : sb.backend.state.calls.filter((x) => x === "history_add").length;
}
// What survives a close and reopen.
function persisted(sb) {
  return sb.surface === "mobile" ? { storage: sb.storage.snapshot() } : { disk: { ...sb.backend.disk } };
}
function seedStore(surface, { countdown, countdownBak, countdownUnreadable, history, historyBak, historyReadError, layout, layoutBak, layoutUnreadable } = {}) {
  if (surface === "mobile") {
    const storage = {};
    if (countdown !== undefined) storage[COUNTDOWN_KEY] = countdown;
    if (countdownBak !== undefined) storage[`${COUNTDOWN_KEY}_bak`] = countdownBak;
    if (history !== undefined) storage[HISTORY_KEY] = history;
    if (historyBak !== undefined) storage[`${HISTORY_KEY}_bak`] = historyBak;
    if (layout !== undefined) storage[LAYOUT_KEY] = layout;
    if (layoutBak !== undefined) storage[`${LAYOUT_KEY}_bak`] = layoutBak;
    return { storage };
  }
  return { disk: { countdown, countdownBak, countdownUnreadable, history, historyBak, historyReadError, layout, layoutBak, layoutUnreadable } };
}

function cellOf(sb, gridId, iso) {
  const g = sb.doc.getElementById(gridId);
  return g ? g.children.find((c) => c.dataset.date === iso) || null : null;
}
function tabStops(sb, gridId) {
  const g = sb.doc.getElementById(gridId);
  return g ? g.children.filter((c) => c.getAttribute("tabindex") === "0") : [];
}
async function pressKey(sb, el, key, shiftKey = false) {
  const ev = new MockEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  await sb.drain();
  return ev;
}
function clearSegment(el) {
  el.value = "";
  el._badInput = true;
  el.dispatchEvent(new MockEvent("input", { bubbles: true }));
  el.dispatchEvent(new MockEvent("change", { bubbles: true }));
}
async function closePage(sb) {
  sb.win.dispatchEvent(new MockEvent("pagehide"));
  setPageVisible(sb, false);
  await sb.drain();
}
async function cdExpect(ctx, nowMs, date, time) {
  const now = localMoment(Math.floor(nowMs / 1000) * 1000);
  return ctx.bridge.result("calc_countdown", { now, target: { date, time, utcOffsetMinutes: offsetAtLocal(date, time, nowMs) } });
}
const whenText = (r) => `${r.targetDate} ${r.targetTime} (${r.targetWeekday})`;
function cleanRun(c, sb, label) {
  c.check(sb.errors.length === 0 && sb.doc._errors.length === 0, () => `${label}: errors ${excerpt([...sb.errors, ...sb.doc._errors].join(" | "), 400)}`);
  c.check(sb.doc._violations.length === 0, () => `${label}: DOM violations ${sb.doc._violations.join(" | ")}`);
  if (sb.surface === "mobile") c.check(sb.storage.clears === 0, `${label}: localStorage.clear() was called`);
}

// --- A1 calendars ------------------------------------------------------------

async function probeCalendarClickInfo({ make, ctx }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  const today = localIso(sb.timers.now);
  for (const g of ["bizCalGrid", "infoCalGrid", "cdCalGrid"]) {
    const cells = u.must(g).children;
    c.check(cells.length === 42 && cells.every((x) => x.tagName === "BUTTON" && x.type === "button"), () => `${g}: not 42 <button type=button> cells (${cells.length}, ${cells[0]?.tagName})`);
    c.check(tabStops(sb, g).length === 1, () => `${g}: ${tabStops(sb, g).length} tab stops at boot`);
    c.check(cells.every((x) => !x.hasAttribute("role") && (x.getAttribute("aria-label") || "").length > 0), () => `${g}: a cell lacks an aria-label or keeps role=img`);
  }
  c.check(cellOf(sb, "infoCalGrid", today)?.getAttribute("aria-current") === "date" && tabStops(sb, "infoCalGrid")[0]?.dataset.date === today, "today is not marked or not the tab stop");
  const writesBefore = historyAddCalls(sb);
  const hist = savedHistory(sb).length;
  const target = cellOf(sb, "infoCalGrid", "2026-11-20");
  if (!c.check(Boolean(target), "no 2026-11-20 cell in the Date Info calendar")) return;
  await u.clickEl(target);
  const r = await ctx.bridge.result("calc_date_info", { date: "2026-11-20", today });
  c.check(u.must("infoDate").value === "2026-11-20", () => `click set infoDate=${u.must("infoDate").value}`);
  c.check(u.text("infoLiveResult") === `→ ${r.weekday} · ${r.isoWeekText}`, () => `info live after click "${u.text("infoLiveResult")}"`);
  const sel = cellOf(sb, "infoCalGrid", "2026-11-20");
  c.check(sel?.classList.contains("selected") && sel.getAttribute("aria-pressed") === "true" && (sel.getAttribute("aria-label") || "").endsWith(CAL_TEXT.selected),
    () => `selected cell marks: ${sel?.className} / ${sel?.getAttribute("aria-label")}`);
  c.check(u.must("infoCalGrid").children.filter((x) => x.classList.contains("selected")).length === 1, "more than one selected cell");
  const out = cellOf(sb, "infoCalGrid", "2026-12-03");
  c.check(Boolean(out) && out.classList.contains("out") && !out.disabled, "2026-12-03 is not a clickable out-of-month cell");
  if (out) await u.clickEl(out);
  c.check(u.must("infoDate").value === "2026-12-03" && u.text("infoCalTitle") === "December 2026", () => `out-of-month click: ${u.must("infoDate").value} / ${u.text("infoCalTitle")}`);
  await u.click("infoCalTodayBtn");
  c.check(u.text("infoCalTitle") === "November 2026" && u.must("infoDate").value === "2026-12-03", () => `today button: ${u.text("infoCalTitle")} / ${u.must("infoDate").value}`);
  c.check(historyAddCalls(sb) === writesBefore && savedHistory(sb).length === hist, "a calendar click wrote history");
  cleanRun(c, sb, "calendar-click-info");
}

async function probeCalendarClickCountdown({ make, ctx }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  await u.set("cdTime", "09:30");
  c.check(cdWrites(sb) === 0, "a time without a date was saved");
  const hist = historyAddCalls(sb);
  await u.clickEl(cellOf(sb, "cdCalGrid", "2026-11-25"));
  let rec = cdRecord(sb);
  c.check(u.must("cdTarget").value === "2026-11-25" && u.must("cdTime").value === "09:30", () => `click set ${u.must("cdTarget").value} ${u.must("cdTime").value}`);
  c.check(canonical(rec) === canonical({ schemaVersion: 1, targetDate: "2026-11-25", targetTime: "09:30", savedAtMs: T_MAIN, finishedSeenAtMs: null }),
    () => `saved record ${JSON.stringify(rec)}`);
  let r = await cdExpect(ctx, sb.timers.now, "2026-11-25", "09:30");
  c.check(u.text("cdClock") === r.clockText && u.text("cdPhase") === CD_TEXT.chipCounting && u.text("cdStatus") === CD_TEXT.counting(whenText(r)),
    () => `after click: ${u.text("cdClock")} / ${u.text("cdPhase")} / ${u.text("cdStatus")}`);
  c.check(!u.hidden("cdSavedNote") && u.text("cdSavedNoteText") === CD_TEXT.saved && !u.hidden("cdForgetBtn") && u.text("cdForgetBtn") === CD_TEXT.forget, "saved note not shown");
  const sel = cellOf(sb, "cdCalGrid", "2026-11-25");
  c.check(sel?.classList.contains("selected") && sel.getAttribute("aria-pressed") === "true", "countdown target cell not selected");
  await u.clickEl(cellOf(sb, "cdCalGrid", "2026-11-10"));
  rec = cdRecord(sb);
  r = await cdExpect(ctx, sb.timers.now, "2026-11-10", "09:30");
  c.check(u.text("cdPhase") === CD_TEXT.chipFinished && u.must("cdPhase").classList.contains("is-finished") && u.text("cdStatus") === CD_TEXT.finished(whenText(r)),
    () => `past day: ${u.text("cdPhase")} / ${u.text("cdStatus")}`);
  c.check(rec?.targetDate === "2026-11-10" && rec?.targetTime === "09:30" && rec?.finishedSeenAtMs === sb.timers.now, () => `past day record ${JSON.stringify(rec)}`);
  c.check(historyAddCalls(sb) === hist, "a calendar click wrote history");
  cleanRun(c, sb, "calendar-click-countdown");
}

async function probeBizRangePick({ make, ctx }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  const pick = () => ({ start: u.must("bizPickStart").checked, end: u.must("bizPickEnd").checked, hint: u.text("bizCalHint") });
  const isStart = (p) => p.start && !p.end && p.hint === CAL_TEXT.hintStart;
  const isEnd = (p) => p.end && !p.start && p.hint === CAL_TEXT.hintEnd;
  const live = async (s, e, inc) => {
    const r = await ctx.bridge.result("calc_business_days", { startDate: s, endDate: e, includeEndDay: inc, calendar: ctx.defaultCalendar });
    return `→ ${r.summaryText}`;
  };
  const hist = historyAddCalls(sb);
  c.check(u.must("bizCalHint").getAttribute("role") === "status" && u.must("bizCalPick")?.tagName === "FIELDSET", "pick toggle markup");
  c.check(isStart(pick()), () => `initial target ${JSON.stringify(pick())}`);
  await u.clickEl(cellOf(sb, "bizCalGrid", "2026-11-03"));
  c.check(u.must("bizStart").value === "2026-11-03" && u.must("bizEnd").value === "" && isEnd(pick()), () => `first click: ${u.must("bizStart").value} ${JSON.stringify(pick())}`);
  await u.clickEl(cellOf(sb, "bizCalGrid", "2026-11-10"));
  c.check(u.must("bizEnd").value === "2026-11-10" && isStart(pick()), () => `second click: ${u.must("bizEnd").value} ${JSON.stringify(pick())}`);
  c.check(u.text("bizLiveResult") === (await live("2026-11-03", "2026-11-10", false)), () => `range live ${u.text("bizLiveResult")}`);
  // Marks come from the field values: without "include end date" the engine
  // range stops the day before, but the End mark stays on the End date.
  const s = cellOf(sb, "bizCalGrid", "2026-11-03");
  const e = cellOf(sb, "bizCalGrid", "2026-11-10");
  const d9 = cellOf(sb, "bizCalGrid", "2026-11-09");
  c.check(s?.classList.contains("pick-start") && (s.getAttribute("aria-label") || "").endsWith(CAL_TEXT.start) && s.getAttribute("aria-pressed") === "true", "start mark");
  c.check(e?.classList.contains("pick-end") && (e.getAttribute("aria-label") || "").endsWith(CAL_TEXT.end) && e.getAttribute("aria-pressed") === "true" && !e.classList.contains("in-range"),
    () => `end mark (includeEndDay=false): ${e?.className}`);
  c.check(d9?.classList.contains("in-range") && !d9.classList.contains("pick-end") && !d9.hasAttribute("aria-pressed"), () => `day before end: ${d9?.className}`);
  // The target is Start now; Shift+click still sets End.
  cellOf(sb, "bizCalGrid", "2026-11-26").click({ shiftKey: true });
  await sb.drain();
  c.check(u.must("bizEnd").value === "2026-11-26" && u.must("bizStart").value === "2026-11-03" && isStart(pick()), () => `shift-click: ${u.must("bizStart").value}..${u.must("bizEnd").value} ${JSON.stringify(pick())}`);
  await u.clickEl(cellOf(sb, "bizCalGrid", "2026-11-05"));
  c.check(u.must("bizStart").value === "2026-11-05" && u.must("bizEnd").value === "2026-11-26" && isEnd(pick()), () => `third click (start again): ${u.must("bizStart").value} ${JSON.stringify(pick())}`);
  u.must("bizEnd").focus();
  await sb.drain();
  c.check(isEnd(pick()), () => `focusing End: ${JSON.stringify(pick())}`);
  u.must("bizStart").focus();
  await sb.drain();
  c.check(isStart(pick()), () => `focusing Start: ${JSON.stringify(pick())}`);
  await u.click("bizPickEnd");
  c.check(isEnd(pick()), () => `End radio: ${JSON.stringify(pick())}`);
  await u.clickEl(cellOf(sb, "bizCalGrid", "2026-11-24"));
  c.check(u.must("bizEnd").value === "2026-11-24" && u.must("bizStart").value === "2026-11-05" && isStart(pick()), "End radio then click");
  await u.click("bizIncludeEnd");
  const e24 = cellOf(sb, "bizCalGrid", "2026-11-24");
  c.check(e24?.classList.contains("pick-end") && e24.classList.contains("in-range"), () => `includeEndDay=true end cell ${e24?.className}`);
  c.check(u.text("bizLiveResult") === (await live("2026-11-05", "2026-11-24", true)), () => `inclusive live ${u.text("bizLiveResult")}`);
  await u.click("bizIncludeEnd");
  await u.set("bizStart", "2026-11-25");
  await u.set("bizEnd", "2026-11-12");
  const bs = cellOf(sb, "bizCalGrid", "2026-11-25");
  const be = cellOf(sb, "bizCalGrid", "2026-11-12");
  c.check(bs?.classList.contains("pick-start") && !bs.classList.contains("pick-end") && be?.classList.contains("pick-end") && !be.classList.contains("pick-start"),
    () => `backward range marks: ${bs?.className} / ${be?.className}`);
  c.check(u.text("bizLiveResult") === (await live("2026-11-25", "2026-11-12", false)), () => `backward live ${u.text("bizLiveResult")}`);
  c.check(u.must("bizCalGrid").children.filter((x) => x.classList.contains("pick-start")).length === 1 &&
    u.must("bizCalGrid").children.filter((x) => x.classList.contains("pick-end")).length === 1, "more than one start or end mark");
  c.check(historyAddCalls(sb) === hist, "calendar picks wrote history");
  cleanRun(c, sb, "biz-range-pick");
}

async function probeCalendarViewFollowsClick({ make }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  await u.set("bizStart", "2026-11-03");
  c.check(u.text("bizCalTitle") === "November 2026", () => `typed start view ${u.text("bizCalTitle")}`);
  await u.click("bizPickEnd");
  const out = cellOf(sb, "bizCalGrid", "2026-12-03");
  c.check(Boolean(out) && out.classList.contains("out"), "2026-12-03 not shown as an out-of-month cell");
  if (out) await u.clickEl(out);
  // v1.0.0 anchoring (the earlier date) would stay on November.
  c.check(u.must("bizEnd").value === "2026-12-03" && u.text("bizCalTitle") === "December 2026", () => `view after click: ${u.must("bizEnd").value} / ${u.text("bizCalTitle")}`);
  await u.set("bizStart", "2026-11-04");
  c.check(u.text("bizCalTitle") === "November 2026", () => `typed input keeps the earlier-date anchoring: ${u.text("bizCalTitle")}`);
  await u.click("bizCalNextBtn");
  c.check(u.text("bizCalTitle") === "December 2026", "next month button");
  await u.click("bizCalTodayBtn");
  c.check(u.text("bizCalTitle") === "November 2026" && u.must("bizStart").value === "2026-11-04" && u.must("bizEnd").value === "2026-12-03", "today button changed the fields or not the view");
  await u.set("cdTarget", "2027-03-15");
  c.check(u.text("cdCalTitle") === "March 2027", () => `countdown view ${u.text("cdCalTitle")}`);
  await u.click("cdCalTodayBtn");
  c.check(u.text("cdCalTitle") === "November 2026" && u.must("cdTarget").value === "2027-03-15", "countdown today button");
  cleanRun(c, sb, "calendar-view-follows-click");
}

async function probeCalendarKeyboard({ make }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  const g = "infoCalGrid";
  const oneStop = (label) => {
    for (const id of ["bizCalGrid", "infoCalGrid", "cdCalGrid"]) c.check(tabStops(sb, id).length === 1, () => `${label}: ${id} has ${tabStops(sb, id).length} tab stops`);
    c.check(tabStops(sb, g)[0] === sb.doc.activeElement, () => `${label}: the tab stop is not the focused cell`);
  };
  const start = tabStops(sb, g)[0];
  if (!c.check(start?.dataset.date === "2026-11-17", "Date Info tab stop is not today")) return;
  start.focus();
  await sb.drain();
  const steps = [["ArrowRight", false, "2026-11-18", "November 2026"], ["ArrowDown", false, "2026-11-25", "November 2026"], ["ArrowUp", false, "2026-11-18", "November 2026"],
    ["ArrowLeft", false, "2026-11-17", "November 2026"], ["Home", false, "2026-11-16", "November 2026"], ["End", false, "2026-11-22", "November 2026"],
    ["PageDown", false, "2026-12-22", "December 2026"], ["PageUp", false, "2026-11-22", "November 2026"], ["PageDown", true, "2027-11-22", "November 2027"],
    ["PageUp", true, "2026-11-22", "November 2026"]];
  for (const [key, shift, want, title] of steps) {
    const ev = await pressKey(sb, sb.doc.activeElement, key, shift);
    const label = `${shift ? "Shift+" : ""}${key}`;
    c.check(ev.defaultPrevented, `${label} not prevented`);
    c.check(sb.doc.activeElement?.dataset?.date === want && u.text("infoCalTitle") === title, () => `${label}: focus ${sb.doc.activeElement?.dataset?.date} / ${u.text("infoCalTitle")}, want ${want} / ${title}`);
    c.check(u.must("infoDate").value === "", () => `${label} selected ${u.must("infoDate").value}`);
    oneStop(label);
  }
  await pressKey(sb, sb.doc.activeElement, "Enter");
  c.check(u.must("infoDate").value === "2026-11-22" && sb.doc.activeElement?.dataset?.date === "2026-11-22" && sb.doc.activeElement.classList.contains("selected"),
    () => `Enter: ${u.must("infoDate").value}, focus ${sb.doc.activeElement?.dataset?.date}`);
  oneStop("Enter");
  // Month ends clamp; Space selects.
  await u.set("infoDate", "2027-01-31");
  cellOf(sb, g, "2027-01-31")?.focus();
  await sb.drain();
  await pressKey(sb, sb.doc.activeElement, "PageDown");
  c.check(sb.doc.activeElement?.dataset?.date === "2027-02-28" && u.text("infoCalTitle") === "February 2027", () => `PageDown clamp: ${sb.doc.activeElement?.dataset?.date}`);
  await pressKey(sb, sb.doc.activeElement, " ");
  c.check(u.must("infoDate").value === "2027-02-28" && sb.doc.activeElement?.dataset?.date === "2027-02-28", () => `Space: ${u.must("infoDate").value}`);
  oneStop("Space");
  cleanRun(c, sb, "calendar-keyboard");
}

async function probeCalendarOutOfRange({ make }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  const g = "infoCalGrid";
  for (const [date, title, edge, key, btn] of [["9999-12-15", "December 9999", "9999-12-31", "ArrowRight", "infoCalNextBtn"], ["0001-01-15", "January 1", "0001-01-01", "ArrowLeft", "infoCalPrevBtn"]]) {
    await u.set("infoDate", date);
    const cells = u.must(g).children;
    const dis = cells.filter((x) => x.classList.contains("out-of-range"));
    // 0001-01-01 is a Monday, so a Monday-first January 1 has no cell before it.
    c.check((dis.length > 0 || date.startsWith("0001")) && dis.every((x) => x.disabled) && cells.filter((x) => x.disabled).every((x) => x.classList.contains("out-of-range")),
      () => `${date}: out-of-range cells ${dis.length}, disabled ${cells.filter((x) => x.disabled).length} (${u.text("infoCalTitle")})`);
    c.check(u.text("infoCalTitle").startsWith(title.split(" ")[0]) && u.must(btn).disabled, () => `${date}: ${btn} not disabled at the end of the range`);
    if (dis[0]) {
      await u.clickEl(dis[0]);
      dis[0].focus();
    }
    c.check(u.must("infoDate").value === date && sb.doc.activeElement !== dis[0], () => `${date}: a disabled cell was picked or focused`);
    const last = cellOf(sb, g, edge);
    last?.focus();
    await sb.drain();
    await pressKey(sb, sb.doc.activeElement, key);
    c.check(sb.doc.activeElement?.dataset?.date === edge && u.must("infoDate").value === date, () => `${date}: ${key} left the range (${sb.doc.activeElement?.dataset?.date})`);
    c.check(tabStops(sb, g).length === 1 && !tabStops(sb, g)[0].disabled, `${date}: tab stop on a disabled cell`);
  }
  cleanRun(c, sb, "calendar-out-of-range-disabled");
}

// --- A2 countdown ---------------------------------------------------------------

async function probeCountdownRestoreFuture({ make, ctx, surface }, c) {
  const rec = { schemaVersion: 1, targetDate: "2026-12-25", targetTime: "09:30", savedAtMs: T_MAIN - 86400000, finishedSeenAtMs: null };
  const raw = JSON.stringify(rec);
  const sb = await make(T_MAIN, seedStore(surface, { countdown: raw }));
  const u = uiDriver(sb);
  const r = await cdExpect(ctx, T_MAIN, "2026-12-25", "09:30");
  c.check(u.must("cdTarget").value === "2026-12-25" && u.must("cdTime").value === "09:30", () => `restored fields ${u.must("cdTarget").value} ${u.must("cdTime").value}`);
  c.check(u.text("cdClock") === r.clockText, () => `restored clock "${u.text("cdClock")}" != "${r.clockText}"`);
  c.check(u.text("cdPhase") === CD_TEXT.chipRestored && u.text("cdStatus") === CD_TEXT.restored(r.text, whenText(r)), () => `restored chip/status: ${u.text("cdPhase")} / ${u.text("cdStatus")}`);
  c.check(!u.hidden("cdSavedNote") && u.text("cdSavedNoteText") === CD_TEXT.saved && !u.hidden("cdForgetBtn"), "saved note after restore");
  c.check(cdWrites(sb) === 0 && cdRaw(sb) === raw, "restore wrote the record");
  await sb.advance(3050);
  const r3 = await cdExpect(ctx, sb.timers.now, "2026-12-25", "09:30");
  // "restored" is the first render only: the next tick says counting down,
  // so the polite status never repeats a stale time left.
  c.check(u.text("cdClock") === r3.clockText && u.text("cdPhase") === CD_TEXT.chipCounting && u.text("cdStatus") === CD_TEXT.counting(whenText(r3)) && cdWrites(sb) === 0,
    () => `after 3 s: ${u.text("cdClock")} / ${u.text("cdPhase")} / ${u.text("cdStatus")} / writes ${cdWrites(sb)}`);
  await u.set("cdTarget", "2026-12-26");
  const rec2 = cdRecord(sb);
  c.check(u.text("cdPhase") === CD_TEXT.chipCounting && u.text("cdStatus").startsWith(CD_TEXT.counting("2026-12-26 09:30:00").slice(0, -1)), () => `new target: ${u.text("cdPhase")} / ${u.text("cdStatus")}`);
  c.check(cdWrites(sb) === 1 && rec2?.targetDate === "2026-12-26" && rec2?.finishedSeenAtMs === null && rec2?.savedAtMs === sb.timers.now, () => `new target record ${JSON.stringify(rec2)}`);
  cleanRun(c, sb, "countdown-restore-future");
}

async function probeCountdownFinishedWhileClosed({ make, ctx, surface }, c) {
  const rec = { schemaVersion: 1, targetDate: "2026-11-16", targetTime: "09:58", savedAtMs: T_MAIN - 2 * 86400000, finishedSeenAtMs: null };
  const seed = seedStore(surface, { countdown: JSON.stringify(rec) });
  const r = await cdExpect(ctx, T_MAIN, "2026-11-16", "09:58");
  // Opened in a hidden window: nothing is "seen" (and written) until visible.
  const hid = await make(T_MAIN, { ...seed, hidden: true });
  const uh = uiDriver(hid);
  c.check(uh.text("cdPhase") === CD_TEXT.chipFinishedClosed && cdWrites(hid) === 0, () => `hidden launch: ${uh.text("cdPhase")} / writes ${cdWrites(hid)}`);
  await hid.advance(2000);
  c.check(cdWrites(hid) === 0, "a hidden page wrote finishedSeenAtMs");
  setPageVisible(hid, true);
  await hid.drain();
  c.check(cdWrites(hid) === 1 && cdRecord(hid)?.finishedSeenAtMs === hid.timers.now, () => `becoming visible: writes ${cdWrites(hid)} / ${JSON.stringify(cdRecord(hid))}`);

  const sb = await make(T_MAIN, seed);
  const u = uiDriver(sb);
  c.check(u.text("cdPhase") === CD_TEXT.chipFinishedClosed && u.must("cdPhase").classList.contains("is-finished") && u.text("cdStatus") === CD_TEXT.finishedClosed(whenText(r)),
    () => `launch after the target: ${u.text("cdPhase")} / ${u.text("cdStatus")}`);
  c.check(u.text("cdClock") === r.clockText && u.must("cdClock").classList.contains("is-past"), () => `count-up clock ${u.text("cdClock")}`);
  const seen = cdRecord(sb);
  c.check(cdWrites(sb) === 1 && canonical(seen) === canonical({ ...rec, finishedSeenAtMs: T_MAIN }), () => `the one finishedSeenAtMs write: ${cdWrites(sb)} / ${JSON.stringify(seen)}`);
  await sb.advance(5000);
  c.check(cdWrites(sb) === 1 && u.text("cdPhase") === CD_TEXT.chipFinishedClosed, () => `ticks: writes ${cdWrites(sb)} / ${u.text("cdPhase")}`);
  const again = await make(T_MAIN + 60000, persisted(sb));
  const ua = uiDriver(again);
  c.check(ua.text("cdPhase") === CD_TEXT.chipFinished && ua.text("cdStatus") === CD_TEXT.finished(whenText(r)) && cdWrites(again) === 0,
    () => `next launch: ${ua.text("cdPhase")} / ${ua.text("cdStatus")} / writes ${cdWrites(again)}`);
  cleanRun(c, sb, "countdown-finished-while-closed");
  cleanRun(c, again, "countdown-finished-while-closed (relaunch)");
}

async function probeCountdownFinishedOpenThenClosed({ make, ctx }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  await u.set("cdTime", "10:01");
  await u.set("cdTarget", localIso(T_MAIN));
  c.check(u.text("cdPhase") === CD_TEXT.chipCounting && cdWrites(sb) === 1, () => `before: ${u.text("cdPhase")} / writes ${cdWrites(sb)}`);
  await sb.advance(62000);
  const r = await cdExpect(ctx, sb.timers.now, localIso(T_MAIN), "10:01");
  const rec = cdRecord(sb);
  c.check(u.text("cdPhase") === CD_TEXT.chipFinished && u.text("cdStatus") === CD_TEXT.finished(whenText(r)), () => `finished while open: ${u.text("cdPhase")} / ${u.text("cdStatus")}`);
  c.check(cdWrites(sb) === 2 && rec?.finishedSeenAtMs >= T_MAIN + 60000 && rec?.finishedSeenAtMs <= T_MAIN + 62000, () => `seen write: ${cdWrites(sb)} / ${JSON.stringify(rec)}`);
  await sb.advance(5000);
  c.check(cdWrites(sb) === 2, "more writes after the finish");
  await closePage(sb);
  c.check(cdWrites(sb) === 2, "closing rewrote the record");
  const again = await make(T_MAIN + 3600000, persisted(sb));
  const ua = uiDriver(again);
  c.check(ua.text("cdPhase") === CD_TEXT.chipFinished && ua.text("cdStatus") === CD_TEXT.finished(whenText(r)) && cdWrites(again) === 0,
    () => `relaunch shows plain finished: ${ua.text("cdPhase")} / ${ua.text("cdStatus")} / writes ${cdWrites(again)}`);
  cleanRun(c, sb, "countdown-finished-while-open-then-closed");
}

async function probeCountdownEmptySegment({ make }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  await u.set("cdTarget", "2026-12-31");
  await u.set("cdTime", "09:00");
  const raw = cdRaw(sb);
  const w = cdWrites(sb);
  c.check(cdRecord(sb)?.targetTime === "09:00", "commit not saved");
  clearSegment(u.must("cdTarget"));
  await sb.drain();
  c.check(cdRaw(sb) === raw && cdWrites(sb) === w, "a cleared date segment changed the record");
  c.check(!u.hidden("cdSavedNote"), "a cleared segment hid the saved note");
  u.must("cdTarget").value = "2026-12-31";
  u.must("cdTarget").dispatchEvent(new MockEvent("input", { bubbles: true }));
  await sb.drain();
  clearSegment(u.must("cdTime"));
  await sb.drain();
  c.check(cdRaw(sb) === raw && cdWrites(sb) === w, "a cleared time segment saved a time-less target");
  await u.set("cdTarget", "");
  c.check(cdRaw(sb) === raw && cdWrites(sb) === w, "an emptied date field cleared or changed the record");
  await closePage(sb);
  c.check(cdRaw(sb) === raw && cdWrites(sb) === w, "the page-hide flush changed the record");
  const again = await make(T_MAIN + 1000, persisted(sb));
  const ua = uiDriver(again);
  c.check(ua.must("cdTarget").value === "2026-12-31" && ua.must("cdTime").value === "09:00" && ua.text("cdPhase") === CD_TEXT.chipRestored,
    () => `relaunch: ${ua.must("cdTarget").value} ${ua.must("cdTime").value} / ${ua.text("cdPhase")}`);
  cleanRun(c, sb, "countdown-empty-segment-keeps-record");
}

async function probeCountdownForget({ make, surface }, c) {
  const sb = await make(T_MAIN, seedStore(surface, { countdownBak: "older backup" }));
  const u = uiDriver(sb);
  await u.set("cdTarget", "2026-12-31");
  c.check(cdRecord(sb)?.targetDate === "2026-12-31" && !u.hidden("cdForgetBtn"), "commit not saved");
  await u.click("cdForgetBtn");
  c.check(cdRaw(sb) === null && cdBak(sb) === "older backup", () => `Forget: record ${cdRaw(sb)} / bak ${cdBak(sb)}`);
  c.check(u.hidden("cdSavedNote") && u.must("cdTarget").value === "2026-12-31", "Forget hid nothing or cleared the field");
  await closePage(sb);
  c.check(cdRaw(sb) === null, "the page-hide flush saved the forgotten countdown again");
  const again = await make(T_MAIN + 1000, persisted(sb));
  const ua = uiDriver(again);
  c.check(ua.must("cdTarget").value === "" && ua.text("cdPhase") === "" && ua.hidden("cdPhase"), "a forgotten countdown was restored");
  setPageVisible(sb, true);
  await u.set("cdTarget", "2026-12-31");
  c.check(cdRecord(sb)?.targetDate === "2026-12-31", "an explicit commit after Forget was not saved");
  cleanRun(c, sb, "countdown-forget-clears");
}

async function probeCountdownReset({ make }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  await u.set("cdTarget", "2026-12-31");
  await u.set("cdTime", "08:00");
  c.check(cdRecord(sb)?.targetTime === "08:00", "commit not saved");
  await u.click("resetCdBtn");
  c.check(cdRaw(sb) === null && u.must("cdTarget").value === "" && u.must("cdTime").value === "" && u.text("cdClock") === "—", "clear did not forget the countdown");
  c.check(u.hidden("cdPhase") && u.hidden("cdSavedNote"), "chip or note visible after clear");
  await u.set("cdTarget", "2027-03-01");
  c.check(cdRecord(sb)?.targetDate === "2027-03-01", "commit after clear not saved");
  // Clear all (one tap in the header row) only empties the fields: the
  // saved countdown, its note and Forget stay, and the next launch restores it.
  await u.click("clearAllBtn");
  await closePage(sb);
  c.check(cdRecord(sb)?.targetDate === "2027-03-01" && u.must("cdTarget").value === "" && u.text("cdClock") === "—", () => `clear all: record ${cdRaw(sb)}, field "${u.must("cdTarget").value}"`);
  c.check(!u.hidden("cdSavedNote") && u.text("cdSavedNoteText") === CD_TEXT.saved && !u.hidden("cdForgetBtn"), "clear all hid the saved note or Forget");
  const again = await make(T_MAIN + 1000, persisted(sb));
  c.check(uiDriver(again).must("cdTarget").value === "2027-03-01", "the countdown kept by clear all was not restored");
  cleanRun(c, sb, "countdown-reset-clears");
}

async function probeCountdownNoWriteOnTick({ make, ctx }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  await u.set("cdTarget", "2026-12-25");
  await u.set("cdTime", "09:30");
  const w = cdWrites(sb);
  const clock0 = u.text("cdClock");
  await sb.advance(15000);
  c.check(cdWrites(sb) === w && u.text("cdClock") !== clock0, () => `15 s of ticks: writes ${cdWrites(sb) - w}`);
  await sb.advance(61000);
  c.check(cdWrites(sb) === w, "the minute rollover check wrote");
  await u.type("cdTarget", "2026-12-26");
  const r = await cdExpect(ctx, sb.timers.now, "2026-12-26", "09:30");
  c.check(cdWrites(sb) === w && cdRecord(sb)?.targetDate === "2026-12-25", "an input event (no commit) saved");
  c.check(u.text("cdClock") === r.clockText, () => `input re-rendered ${u.text("cdClock")} vs ${r.clockText}`);
  u.must("cdTarget").dispatchEvent(new MockEvent("change", { bubbles: true }));
  await sb.drain();
  c.check(cdWrites(sb) === w + 1 && cdRecord(sb)?.targetDate === "2026-12-26", "the change commit was not saved");
  await u.set("cdTarget", "2026-11-01");
  c.check(cdWrites(sb) === w + 3 && Number.isSafeInteger(cdRecord(sb)?.finishedSeenAtMs), () => `past target: writes ${cdWrites(sb) - w} (want save + one seen write)`);
  await sb.advance(10000);
  c.check(cdWrites(sb) === w + 3, () => `ticks after the finish wrote ${cdWrites(sb) - w - 3} more`);
  cleanRun(c, sb, "countdown-no-write-on-tick");
}

async function probeCountdownBadRecords({ make, surface }, c) {
  const rec = (o = {}) => JSON.stringify({ schemaVersion: 1, targetDate: "2026-12-31", targetTime: "", savedAtMs: 1, finishedSeenAtMs: null, ...o });
  // Invalid records: backed up once, ignored, and the store stays writable.
  const bad = [rec({ targetDate: "2026-02-30" }), rec({ targetTime: "24:00" }), rec({ targetTime: "9:30" }), rec({ targetTime: "09:30:00" }), rec({ zone: "x" }),
    rec({ schemaVersion: "1" }), rec({ savedAtMs: -1 }), rec({ savedAtMs: 2 ** 53 }), rec({ finishedSeenAtMs: "1" }), '{"targetDate":"2026-12-31"}', "[1]", "{not json"];
  for (const v of bad) {
    const sb = await make(T_MAIN, seedStore(surface, { countdown: v }));
    const u = uiDriver(sb);
    c.check(u.must("cdTarget").value === "" && u.hidden("cdSavedNote") && cdBak(sb) === v && cdRaw(sb) === v && cdWrites(sb) === 0,
      () => `invalid ${excerpt(v, 70)}: target "${u.must("cdTarget").value}", bak ${cdBak(sb) === v}, writes ${cdWrites(sb)}`);
    if (v === bad[0]) {
      await u.set("cdTarget", "2027-01-05");
      c.check(cdRecord(sb)?.targetDate === "2027-01-05", "a commit after a corrupt record was not saved");
      const again = await make(T_MAIN, persisted(sb));
      c.check(uiDriver(again).must("cdTarget").value === "2027-01-05" && cdBak(again) === v, "the replacement was not restored, or the backup was rewritten");
    }
    cleanRun(c, sb, `invalid record ${excerpt(v, 40)}`);
  }
  // A newer-version record: ignored, never written, cleared or backed up.
  const newer = '{"schemaVersion":2,"targetDate":"2027-01-01","targetTime":"","savedAtMs":1,"finishedSeenAtMs":null,"zone":"Africa/Cairo"}';
  let sb = await make(T_MAIN, seedStore(surface, { countdown: newer }));
  let u = uiDriver(sb);
  c.check(u.must("cdTarget").value === "" && !u.hidden("cdSavedNote") && u.text("cdSavedNoteText") === CD_TEXT.newer && u.hidden("cdForgetBtn"),
    () => `newer record: target "${u.must("cdTarget").value}", note "${u.text("cdSavedNoteText")}"`);
  await u.set("cdTarget", "2026-12-31");
  await u.click("resetCdBtn");
  await u.set("cdTarget", "2026-12-30");
  await u.click("clearAllBtn");
  await closePage(sb);
  c.check(cdRaw(sb) === newer && cdBak(sb) === null && cdWrites(sb) === 0, "a newer-version record was written, cleared or backed up");
  cleanRun(c, sb, "newer record");
  // Over the 1 KiB cap: corrupt on both surfaces. The desktop renames the
  // file aside whole (it is too large to copy), mobile copies it to _bak;
  // either way the store is writable again, never blocked for good.
  const big = rec({ pad: "x".repeat(1100) });
  sb = await make(T_MAIN, seedStore(surface, { countdown: big }));
  u = uiDriver(sb);
  c.check(u.hidden("cdSavedNote"), () => `oversize: note "${u.text("cdSavedNoteText")}"`);
  await u.set("cdTarget", "2026-12-29");
  await closePage(sb);
  c.check(cdBak(sb) === big && cdRecord(sb)?.targetDate === "2026-12-29", () => `oversize on ${surface}: not backed up, or the store stayed blocked (note "${u.text("cdSavedNoteText")}")`);
  if (surface === "desktop") {
    // With .bak taken, the over-cap file goes to a fresh name, never over it.
    sb = await make(T_MAIN, seedStore(surface, { countdown: big, countdownBak: "older backup" }));
    u = uiDriver(sb);
    await u.set("cdTarget", "2026-12-27");
    c.check(cdBak(sb) === "older backup" && canonical(countdownExtraBaks(sb)) === canonical([big]) && cdRecord(sb)?.targetDate === "2026-12-27",
      () => `oversize with .bak taken: bak "${excerpt(String(cdBak(sb)), 30)}", extra ${countdownExtraBaks(sb).length}`);
    // The backend refuses an over-cap or newer file that appears after
    // launch, and the UI then blocks instead of claiming it saved.
    sb.backend.disk.countdown = big;
    await u.set("cdTarget", "2026-12-26");
    c.check(cdRaw(sb) === big && u.text("cdSavedNoteText") === CD_TEXT.unreadable && u.hidden("cdForgetBtn"), () => `late over-cap file: note "${u.text("cdSavedNoteText")}"`);
    sb = await make(T_MAIN);
    u = uiDriver(sb);
    const late = '{"schemaVersion":2,"targetDate":"2027-01-01"}';
    sb.backend.disk.countdown = late;
    await u.set("cdTarget", "2026-12-25");
    await u.click("resetCdBtn");
    c.check(cdRaw(sb) === late && u.text("cdSavedNoteText") === CD_TEXT.newer, () => `late newer file: note "${u.text("cdSavedNoteText")}"`);
  }
  // A failed save never shows the saved note, and the next commit retries.
  sb = await make(T_MAIN);
  u = uiDriver(sb);
  if (surface === "desktop") sb.backend.state.failCountdownSave = 1;
  else sb.storage.refuse.add(COUNTDOWN_KEY);
  await u.set("cdTarget", "2027-04-01");
  c.check(cdRaw(sb) === null && !u.hidden("cdSavedNote") && u.text("cdSavedNoteText") === CD_TEXT.writeFailed && !u.hidden("cdForgetBtn"),
    () => `failed save: record ${cdRaw(sb)}, note "${u.text("cdSavedNoteText")}"`);
  if (surface === "mobile") sb.storage.refuse.delete(COUNTDOWN_KEY);
  u.must("cdTarget").dispatchEvent(new MockEvent("change", { bubbles: true }));
  await sb.drain();
  c.check(cdRecord(sb)?.targetDate === "2027-04-01" && u.text("cdSavedNoteText") === CD_TEXT.saved, () => `retry after a failed save: record ${cdRaw(sb)}, note "${u.text("cdSavedNoteText")}"`);
  cleanRun(c, sb, "failed save");
  // Desktop: a file that exists but cannot be read (locked) is never touched.
  if (surface === "desktop") {
    sb = await make(T_MAIN, seedStore(surface, { countdown: rec(), countdownUnreadable: true }));
    u = uiDriver(sb);
    await u.set("cdTarget", "2026-12-28");
    await u.click("resetCdBtn");
    await closePage(sb);
    c.check(u.text("cdSavedNoteText") === CD_TEXT.unreadable && cdRaw(sb) === rec() && cdWrites(sb) === 0 && cdBak(sb) === null, () => `unreadable: note "${u.text("cdSavedNoteText")}", writes ${cdWrites(sb)}`);
  }
  // The page-hide flush saves a valid value that was typed but not committed.
  sb = await make(T_MAIN);
  u = uiDriver(sb);
  await u.type("cdTarget", "2027-02-14");
  c.check(cdWrites(sb) === 0, "input alone saved");
  await closePage(sb);
  c.check(cdRecord(sb)?.targetDate === "2027-02-14" && cdWrites(sb) === 1, "the page-hide flush did not save the typed target");
  setPageVisible(sb, true);
  await sb.drain();
  sb.win.dispatchEvent(new MockEvent("pagehide"));
  await sb.drain();
  c.check(cdWrites(sb) === 1, "a second flush of the same target wrote again");
  cleanRun(c, sb, "page-hide flush");
}

async function probeCountdownStorageEvent({ make }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  const otherTab = async (value, area = sb.storage) => {
    sb.storage.external(COUNTDOWN_KEY, value);
    sb.win.dispatchEvent(new MockEvent("storage", { key: COUNTDOWN_KEY, storageArea: area }));
    await sb.drain();
  };
  const rec = (date, time, at) => JSON.stringify({ schemaVersion: 1, targetDate: date, targetTime: time, savedAtMs: at, finishedSeenAtMs: null });
  c.check(!u.must("card-countdown").contains(sb.doc.activeElement), "focus starts inside the countdown card");
  await otherTab(rec("2027-01-10", "08:00", T_MAIN + 5));
  c.check(u.must("cdTarget").value === "2027-01-10" && u.must("cdTime").value === "08:00" && u.text("cdPhase") === CD_TEXT.chipCounting && !u.hidden("cdSavedNote"),
    () => `adopt: ${u.must("cdTarget").value} ${u.must("cdTime").value} / ${u.text("cdPhase")}`);
  c.check(cdWrites(sb) === 0, "adopting another tab's record wrote");
  u.must("cdTarget").focus();
  await otherTab(rec("2027-02-01", "", T_MAIN + 6));
  c.check(u.must("cdTarget").value === "2027-01-10", "an event arrived while editing the card was not ignored");
  u.must("betweenStart").focus();
  await otherTab(null);
  c.check(u.hidden("cdSavedNote") && u.must("cdTarget").value === "2027-01-10" && cdWrites(sb) === 0, "a clear in another tab was not adopted (or wrote)");
  await closePage(sb);
  c.check(cdRaw(sb) === null, "the page-hide flush re-saved a countdown cleared in another tab");
  setPageVisible(sb, true);
  const newer = '{"schemaVersion":2,"targetDate":"2027-05-05","extra":true}';
  await otherTab(newer);
  c.check(!u.hidden("cdSavedNote") && u.text("cdSavedNoteText") === CD_TEXT.newer && u.hidden("cdForgetBtn"), () => `newer record note: "${u.text("cdSavedNoteText")}"`);
  await u.set("cdTarget", "2027-03-03");
  await closePage(sb);
  c.check(cdRaw(sb) === newer && cdBak(sb) === null && cdWrites(sb) === 0, "a newer record was overwritten or backed up");
  setPageVisible(sb, true);
  await otherTab(rec("2027-04-04", "", T_MAIN + 7), new MemoryStorage());
  c.check(u.must("cdTarget").value === "2027-03-03", "an event from another storage area was applied");
  cleanRun(c, sb, "countdown-storage-event");
}

// --- A3 history read-only --------------------------------------------------------

async function probeHistoryReadOnly({ make, surface }, c) {
  const bannerShown = (u, reason) => !u.hidden("historyReadOnlyBanner") && u.text("historyReadOnlyText") === HISTORY_TEXT.banner && u.text("historyReadOnlyDetail") === HISTORY_TEXT[reason];
  const record = async (u) => {
    await u.set("infoDate", "2024-02-29");
    await u.enter("infoDate");
    await u.click("calcInfoBtn");
  };
  // 1. Corrupt (a dropped entry): backed up once, read-only, nothing written.
  const raw = JSON.stringify([GOOD_ENTRY, { ...GOOD_ENTRY, id: 9, calculator: "__proto__" }]);
  let sb = await make(T_MAIN, seedStore(surface, { history: raw }));
  let u = uiDriver(sb);
  c.check(bannerShown(u, "corrupt"), () => `corrupt banner: hidden=${u.hidden("historyReadOnlyBanner")} "${u.text("historyReadOnlyDetail")}"`);
  c.check(historyBak(sb) === raw && historyRaw(sb) === raw, "corrupt history not backed up once or changed");
  c.check(u.must("clearHistoryBtn").disabled && u.text("historyCount") === "(1 / 500)", "clear enabled or valid entries not listed");
  const del = u.must("historyList").querySelector(".history-delete-btn");
  c.check(Boolean(del) && del.disabled, "delete enabled while read-only");
  await record(u);
  if (del) await u.clickEl(del);
  await u.click("clearHistoryBtn");
  c.check(historyRaw(sb) === raw && u.text("historyCount") === "(1 / 500)", "a read-only history was written");
  await u.click("historyRetryBtn");
  c.check(bannerShown(u, "corrupt") && historyRaw(sb) === raw && historyBak(sb) === raw, "retry of a still-corrupt history");
  await u.click("historyResetBtn");
  c.check(!u.hidden("historyResetConfirm") && u.hidden("historyResetBtn"), "start-new-history confirm not shown");
  await u.click("cancelHistoryResetBtn");
  c.check(u.hidden("historyResetConfirm") && !u.hidden("historyResetBtn") && bannerShown(u, "corrupt") && historyRaw(sb) === raw, "cancel did not keep the read-only history");
  await u.click("historyResetBtn");
  await u.click("confirmHistoryResetBtn");
  c.check(u.hidden("historyReadOnlyBanner") && !u.must("clearHistoryBtn").disabled && u.text("historyCount") === "(0 / 500)", "start a new history did not make it writable");
  c.check(historyBak(sb) === raw && JSON.parse(historyRaw(sb) ?? "null")?.length === 0, () => `after reset: stored ${excerpt(String(historyRaw(sb)), 80)} / bak kept ${historyBak(sb) === raw}`);
  await record(u);
  const after = JSON.parse(historyRaw(sb) ?? "[]");
  c.check(after.length === 1 && after[0].id > GOOD_ENTRY.id, () => `history after reset: ${excerpt(JSON.stringify(after), 160)}`);
  cleanRun(c, sb, "history-read-only (corrupt)");

  // 2. Too large and 3. newer schema: read-only, never backed up.
  for (const [reason, value] of [["too_large", `[${" ".repeat(HISTORY_MAX_BYTES)}]`], ["newer_schema", '{"schemaVersion":2,"entries":[]}']]) {
    sb = await make(T_MAIN, seedStore(surface, { history: value }));
    u = uiDriver(sb);
    c.check(bannerShown(u, reason), () => `${reason} banner: "${u.text("historyReadOnlyDetail")}"`);
    await record(u);
    c.check(historyRaw(sb) === value && historyBak(sb) === null, () => `${reason}: written or backed up`);
    cleanRun(c, sb, `history-read-only (${reason})`);
  }

  // 3b. Start a new history while a different backup already exists (an
  // earlier corruption): the current value is not in any backup, so it is
  // kept under a fresh name; the old backup is never replaced.
  for (const [reason, value] of [["newer_schema", '{"schemaVersion":3,"entries":[1]}'], ["too_large", `[${"	".repeat(HISTORY_MAX_BYTES)}]`]]) {
    sb = await make(T_MAIN, seedStore(surface, { history: value, historyBak: "older backup" }));
    u = uiDriver(sb);
    c.check(bannerShown(u, reason), () => `${reason} with a backup: "${u.text("historyReadOnlyDetail")}"`);
    await u.click("historyResetBtn");
    await u.click("confirmHistoryResetBtn");
    const extra = historyExtraBaks(sb);
    c.check(historyBak(sb) === "older backup" && extra.length === 1 && extra[0] === value && JSON.parse(historyRaw(sb) ?? "null")?.length === 0,
      () => `${reason} reset with a backup: bak "${excerpt(String(historyBak(sb)), 20)}", extra ${extra.length}, kept ${extra[0] === value}`);
    c.check(u.hidden("historyReadOnlyBanner"), `${reason} reset with a backup did not make history writable`);
    cleanRun(c, sb, `history-read-only (${reason} reset with a backup)`);
  }

  // 4. Retry after the stored history was repaired: writable, ids continue.
  sb = await make(T_MAIN, seedStore(surface, { history: "{not json" }));
  u = uiDriver(sb);
  setHistoryRaw(sb, JSON.stringify([GOOD_ENTRY]));
  await u.click("historyRetryBtn");
  c.check(u.hidden("historyReadOnlyBanner") && u.text("historyCount") === "(1 / 500)", "retry after repair is not writable");
  await record(u);
  const repaired = JSON.parse(historyRaw(sb) ?? "[]");
  c.check(repaired.length === 2 && repaired[0].id === GOOD_ENTRY.id + 1, () => `after repair: ${excerpt(JSON.stringify(repaired.map((e) => e.id)), 80)}`);

  // 5. Desktop: a file that cannot be read (locked) is never touched, and a
  // reset that cannot keep it stays read-only.
  if (surface === "desktop") {
    const locked = JSON.stringify([GOOD_ENTRY]);
    sb = await make(T_MAIN, seedStore(surface, { history: locked, historyReadError: true }));
    u = uiDriver(sb);
    c.check(bannerShown(u, "read_error") && historyBak(sb) === null, "read error banner, or a .bak was attempted");
    await record(u);
    await u.click("historyResetBtn");
    await u.click("confirmHistoryResetBtn");
    c.check(!u.hidden("historyReadOnlyBanner") && u.text("historyReadOnlyDetail") === HISTORY_TEXT.resetFailed && historyRaw(sb) === locked, () => `failed reset: "${u.text("historyReadOnlyDetail")}"`);
    sb.backend.disk.historyReadError = false;
    await u.click("historyRetryBtn");
    c.check(u.hidden("historyReadOnlyBanner") && u.text("historyCount") === "(1 / 500)" && historyRaw(sb) === locked, "retry once readable");
    cleanRun(c, sb, "history-read-only (read_error)");
  }
}

const V110_PROBES = [
  ["calendar-click-info", "a Date Info calendar click (every day cell a <button>, one tab stop per grid, today marked) fills the date, recomputes, marks the cell selected (aria-pressed, \", selected\") and writes no history; an out-of-month cell moves the view; the header Today button changes the view only", probeCalendarClickInfo],
  ["calendar-click-countdown", "a Countdown calendar click keeps the time, saves {schemaVersion 1, date, time, savedAtMs, finishedSeenAtMs null}, shows counting down and the saved note; a past day shows finished and records finishedSeenAtMs once", probeCalendarClickCountdown],
  ["biz-range-pick", "Business Days picks go start → end → start, Shift+click sets End, focusing an input or a radio picks the target, and the start/end marks come from the field values (End marked even when includeEndDay=false stops the engine range a day earlier; a backward range marks both ends)", probeBizRangePick],
  ["calendar-view-follows-click", "a calendar click moves the view to the clicked month while typed input keeps the v1.0.0 earlier-date anchoring; the month and Today buttons change the view only", probeCalendarViewFollowsClick],
  ["calendar-keyboard", "arrows, Home/End, PageUp/PageDown (Shift = a year, month ends clamped) move focus without selecting, across months, with exactly one tabindex=0 per grid on the focused cell; Enter and Space select and keep focus", probeCalendarKeyboard],
  ["calendar-out-of-range-disabled", "cells outside 0001-01-01..9999-12-31 are disabled (and only they are): no click, no focus, no keyboard move onto them, and the month buttons stop at the ends", probeCalendarOutOfRange],
  ["countdown-restore-future", "a saved future countdown is restored at launch with the exact time left on the first render, the restored chip and \"Countdown restored: … left until …\" (then counting down from the next tick), without writing; a new commit saves and shows counting down", probeCountdownRestoreFuture],
  ["countdown-finished-while-closed", "a saved target that passed while closed (finishedSeenAtMs null, fixed clock) shows \"finished while closed\", writes finishedSeenAtMs once (only once visible), and the next launch shows plain finished", probeCountdownFinishedWhileClosed],
  ["countdown-finished-while-open-then-closed", "a countdown that finishes on screen records finishedSeenAtMs once; closing and reopening shows plain finished, not finished while closed", probeCountdownFinishedOpenThenClosed],
  ["countdown-empty-segment-keeps-record", "a cleared date or time segment (\"\" with badInput), an emptied field, page hide and close never change the saved record; the next launch restores it", probeCountdownEmptySegment],
  ["countdown-forget-clears", "Forget removes only the record (never its backup, never localStorage.clear()), the page-hide flush does not re-save it, the next launch starts empty, and an explicit commit saves again", probeCountdownForget],
  ["countdown-reset-clears", "the card's clear forgets the saved countdown and resets the chip, note and clock; clear all only empties the fields and keeps the saved countdown (restored at the next launch)", probeCountdownReset],
  ["countdown-no-write-on-tick", "ticks, the minute rollover check and input events never write; only a change commit saves, plus the single finishedSeenAtMs write when a target passes", probeCountdownNoWriteOnTick],
  ["countdown-bad-records", "invalid saved countdowns (bad date, 24:00, 9:30, seconds, unknown key, wrong types, unsafe timestamps, not JSON) are backed up once, ignored and then replaced by the next commit; a newer-version record is never written, cleared or backed up, even by Clear; an over-cap record is kept (desktop: renamed aside whole, to a fresh name when .bak is taken) and the store stays writable; a locked desktop file, or an over-cap or newer file that appears after launch, is refused by the backend and left untouched; a failed save never shows the saved note and the next commit retries; the page-hide flush saves a typed but uncommitted target once", probeCountdownBadRecords]
];

async function runV110Suite(slice, ctx, make, surface) {
  const P = { make, ctx, surface };
  for (const [id, desc, probe] of V110_PROBES) {
    const crit = slice.criterion(id, `${surface}: ${desc}`);
    await guard(crit, id, () => probe(P, crit));
  }
  if (surface === "mobile") {
    const crit = slice.criterion("countdown-storage-event", "mobile: another tab's countdown write, clear or newer-version record is adopted without writing when focus is outside the card, ignored while editing it, never re-saved by the page-hide flush, and events from another storage area are ignored");
    await guard(crit, "storage event", () => probeCountdownStorageEvent(P, crit));
  }
  const hist = slice.criterion("history-read-only-banner", `${surface}: unreadable stored history (corrupt → backed up once; too large, newer schema${surface === "desktop" ? ", read error" : ""} → no backup) shows the read-only banner with its reason, disables clear and delete, and is never written; Retry re-reads; the two-step "start a new history" keeps the old value (as the backup, or under a fresh backup name when a different backup already exists, never replacing it) and makes history writable with ids that never go backwards`);
  await guard(hist, "history read-only", () => probeHistoryReadOnly(P, hist));
}

// ============================================================================
// 12c. v1.2.0 card layout (plan A8), shared by slices B and C
// ============================================================================
//
// Same pattern as 12b: each probe drives fresh sandboxes and reports through
// `c.check`; slice D runs them again on planted mutants. Drags use pointer
// events on the handle over the card geometry model of the mini-DOM.

// The shared wording (ui/main.js and mobile/index.html UI_TEXT, contract).
const LAYOUT_TITLES = { between: "Days Between Two Dates", add: "Add / Subtract", business: "Business Days", age: "Age", info: "Date Info", countdown: "Countdown" };
const LAYOUT_TEXT = {
  moved: (title, position, total) => `Moved ${title} to position ${position} of ${total}.`,
  move: (title) => `Move ${title}`,
  collapse: (title) => `Collapse ${title}`,
  expand: (title) => `Expand ${title}`,
  collapseGlyph: "[ − ]",
  expandGlyph: "[ + ]",
  dragTitle: "Drag to reorder",
  hint: "Drag to move this card, or tap or press it for Move up and Move down buttons. Arrow Up and Arrow Down also move it.",
  moveUp: "Move up",
  moveDown: "Move down",
  moveDone: "Done",
  resetButton: "Reset card order & expand all",
  saved: "Card order and collapsed cards are saved on this device.",
  reset: "Card order reset and every card expanded.",
  corrupt: "The saved card layout was damaged, so the default layout is used.",
  newer: "The saved card layout is from a newer version, so it is left untouched. Changes last for this session only.",
  unreadable: "The saved card layout could not be read, so it is left untouched. Changes last for this session only.",
  writeFailed: "The card layout could not be saved on this device. Changes last for this session only.",
  session: "Kept for this session only. This browser is not saving site data."
};
const POINTER_ID = 11;
const layoutRecordText = (order = LAYOUT_CARD_KEYS, collapsed = []) => JSON.stringify({ schemaVersion: 1, cardOrder: order, collapsedCards: collapsed });
const sameJson = (a, b) => canonical(a) === canonical(b);

function layoutRaw(sb) {
  return sb.surface === "mobile" ? sb.storage.getItem(LAYOUT_KEY) : sb.backend.disk.layout;
}
function layoutBak(sb) {
  return sb.surface === "mobile" ? sb.storage.getItem(`${LAYOUT_KEY}_bak`) : sb.backend.disk.layoutBak;
}
function layoutRecord(sb) {
  const raw = layoutRaw(sb);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
function layoutWrites(sb) {
  return sb.surface === "mobile" ? sb.storage.writesTo(LAYOUT_KEY) : sb.backend.state.layoutWrites;
}
// Save/reset attempts that reached the store (desktop: layout_save and
// layout_reset IPC calls; mobile: accepted setItem calls).
function layoutSaveAttempts(sb) {
  if (sb.surface === "mobile") return sb.storage.writesTo(LAYOUT_KEY);
  return sb.backend.state.calls.filter((x) => x === "layout_save" || x === "layout_reset").length;
}
function layoutCard(sb, key) {
  return sb.doc.getElementById(`card-${key}`);
}
function handleOf(sb, key) {
  return layoutCard(sb, key)?.querySelector(".drag-handle") ?? null;
}
function collapseOf(sb, key) {
  return layoutCard(sb, key)?.querySelector(".collapse-btn") ?? null;
}
function domCardOrder(sb) {
  const container = sb.doc.getElementById("cardsContainer");
  return container ? container.children.filter((x) => x.classList.contains("calc-section")).map((x) => x.getAttribute("data-calc")) : [];
}
function navCardOrder(sb) {
  return sb.doc.querySelectorAll(".quick-nav .quick-link[data-calc]").map((l) => l.getAttribute("data-calc"));
}
// Every pill still points at its own card, and History stays the last pill.
function navProblems(sb) {
  const nav = sb.doc.querySelector(".quick-nav");
  if (!nav) return ["no .quick-nav"];
  const problems = [];
  const links = nav.children.filter((x) => x.classList.contains("quick-link"));
  if (links.length !== 7) problems.push(`${links.length} pills`);
  if (links[links.length - 1]?.getAttribute("href") !== "#historySection") problems.push("History is not the last pill");
  for (const l of links.slice(0, -1)) {
    if (l.getAttribute("href") !== `#card-${l.getAttribute("data-calc")}`) problems.push(`pill ${l.getAttribute("data-calc")} → ${l.getAttribute("href")}`);
  }
  if (!sameJson(navCardOrder(sb), domCardOrder(sb))) problems.push(`pills ${navCardOrder(sb)} != cards ${domCardOrder(sb)}`);
  return problems;
}
function collapsedKeys(sb) {
  return LAYOUT_CARD_KEYS.filter((k) => layoutCard(sb, k)?.classList.contains("card-collapsed"));
}
function dragMarks(sb) {
  return sb.doc.querySelectorAll(".card-dragging, .card-drop-before, .card-drop-after").length;
}
// The header row contract, for every card in its current state.
function headerProblems(sb) {
  const problems = [];
  const hint = sb.doc.getElementById("cardMoveHint");
  for (const key of LAYOUT_CARD_KEYS) {
    const card = layoutCard(sb, key);
    if (!card) {
      problems.push(`#card-${key} missing`);
      continue;
    }
    const title = LAYOUT_TITLES[key];
    const collapsed = card.classList.contains("card-collapsed");
    const handle = handleOf(sb, key);
    const btn = collapseOf(sb, key);
    const body = sb.doc.getElementById(`card-${key}-body`);
    if (!handle || handle.tagName !== "BUTTON" || handle.type !== "button") problems.push(`${key}: no <button type=button> drag handle`);
    else {
      if (handle.getAttribute("aria-label") !== LAYOUT_TEXT.move(title)) problems.push(`${key}: handle label "${handle.getAttribute("aria-label")}"`);
      if (handle.getAttribute("aria-describedby") !== "cardMoveHint" || !hint) problems.push(`${key}: handle not described by #cardMoveHint`);
      if (handle.textContent.trim() !== "⠿") problems.push(`${key}: handle glyph "${handle.textContent}"`);
    }
    if (!btn || btn.tagName !== "BUTTON" || btn.type !== "button") {
      problems.push(`${key}: no <button type=button> collapse button`);
      continue;
    }
    if (btn.getAttribute("aria-expanded") !== String(!collapsed)) problems.push(`${key}: aria-expanded ${btn.getAttribute("aria-expanded")} while collapsed=${collapsed}`);
    if (btn.getAttribute("aria-controls") !== `card-${key}-body` || !body || !card.contains(body)) problems.push(`${key}: aria-controls does not name the card body`);
    if (btn.getAttribute("aria-label") !== (collapsed ? LAYOUT_TEXT.expand(title) : LAYOUT_TEXT.collapse(title))) problems.push(`${key}: collapse label "${btn.getAttribute("aria-label")}"`);
    if (btn.textContent !== (collapsed ? LAYOUT_TEXT.expandGlyph : LAYOUT_TEXT.collapseGlyph)) problems.push(`${key}: collapse glyph "${btn.textContent}"`);
    if (body && (body.offsetParent === null) !== collapsed) problems.push(`${key}: body rendered=${body.offsetParent !== null} while collapsed=${collapsed}`);
    if (handle && handle.offsetParent === null) problems.push(`${key}: the handle is not rendered`);
  }
  return problems;
}
function layoutSummary(sb) {
  return `cards ${domCardOrder(sb)} / pills ${navCardOrder(sb)} / collapsed ${collapsedKeys(sb)} / stored ${excerpt(String(layoutRaw(sb)), 160)} / writes ${layoutWrites(sb)} / note "${sb.doc.getElementById("layoutStatusText")?.textContent}"`;
}

function firePointer(el, type, x, y, init = {}) {
  const ev = new MockEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: POINTER_ID,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
    clientX: x,
    clientY: y,
    ...init
  });
  el.dispatchEvent(ev);
  return ev;
}
// Scrolls so the target card sits well inside the 800 px viewport (clear of
// the 60 px auto-scroll edges at the drop point).
function bringCardIntoView(sb, key, where) {
  const r = layoutCard(sb, key).getBoundingClientRect();
  const want = where === "after" ? 520 - r.height : 300;
  sb.win.scrollTo(0, sb.win.scrollY + r.top - want);
}
// A touch drag of `key`'s handle to just before / after `targetKey`. Returns
// what was visible mid-drag; `finish: "none"` leaves the pointer down.
async function pointerDrag(sb, key, targetKey, where, { finish = "up", pointerType = "touch" } = {}) {
  bringCardIntoView(sb, targetKey, where);
  const handle = handleOf(sb, key);
  const hr = handle.getBoundingClientRect();
  const sx = hr.left + hr.width / 2;
  const sy = hr.top + hr.height / 2;
  const down = firePointer(handle, "pointerdown", sx, sy, { pointerType });
  const captured = handle.hasPointerCapture(POINTER_ID);
  firePointer(handle, "pointermove", sx + 1, sy + 2, { pointerType });
  const startedEarly = layoutCard(sb, key).classList.contains("card-dragging");
  const tr = layoutCard(sb, targetKey).getBoundingClientRect();
  const x = tr.left + tr.width / 2;
  const y = where === "before" ? tr.top + 6 : tr.bottom - 6;
  const move = firePointer(handle, "pointermove", x, y, { pointerType });
  const during = {
    captured,
    startedEarly,
    dragging: layoutCard(sb, key).classList.contains("card-dragging"),
    line: layoutCard(sb, targetKey).classList.contains(where === "before" ? "card-drop-before" : "card-drop-after"),
    lines: sb.doc.querySelectorAll(".card-drop-before, .card-drop-after").length,
    downPrevented: down.defaultPrevented,
    movePrevented: move.defaultPrevented
  };
  if (finish === "up") firePointer(handle, "pointerup", x, y, { pointerType });
  await sb.drain();
  return { ...during, handle, x, y };
}
const duringOk = (d) => d.captured && !d.startedEarly && d.dragging && d.line && d.lines === 1 && d.downPrevented && d.movePrevented;

async function probeLayoutCollapsePersist({ make, ctx }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  c.check(sameJson(domCardOrder(sb), LAYOUT_CARD_KEYS) && collapsedKeys(sb).length === 0 && navProblems(sb).length === 0, () => `launch: ${layoutSummary(sb)} ${navProblems(sb)}`);
  c.check(headerProblems(sb).length === 0, () => `launch headers: ${headerProblems(sb).join(" | ")}`);
  c.check(u.text("cardMoveHint") === LAYOUT_TEXT.hint && u.text("layoutStatusText") === LAYOUT_TEXT.saved && u.text("resetLayoutBtn") === LAYOUT_TEXT.resetButton,
    () => `hint "${u.text("cardMoveHint")}" / note "${u.text("layoutStatusText")}" / reset "${u.text("resetLayoutBtn")}"`);
  const live = u.must("layoutLiveStatus");
  c.check(live.getAttribute("role") === "status" && live.getAttribute("aria-live") === "polite" && u.text("layoutLiveStatus") === "", "#layoutLiveStatus is not an empty polite status");
  c.check(LAYOUT_CARD_KEYS.every((k) => handleOf(sb, k).getAttribute("title") === LAYOUT_TEXT.dragTitle), "a handle lacks the drag tooltip");
  c.check(layoutRaw(sb) === null && layoutWrites(sb) === 0, "the launch wrote a layout record");

  // Collapse Business Days: its inputs keep their values and its live result
  // keeps updating while hidden.
  await u.set("bizStart", "2024-01-01");
  await u.clickEl(collapseOf(sb, "business"));
  c.check(sameJson(collapsedKeys(sb), ["business"]) && headerProblems(sb).length === 0, () => `after collapsing: ${collapsedKeys(sb)} ${headerProblems(sb).join(" | ")}`);
  c.check(sameJson(layoutRecord(sb), { schemaVersion: 1, cardOrder: LAYOUT_CARD_KEYS, collapsedCards: ["business"] }) && layoutWrites(sb) === 1, () => `collapse not saved: ${layoutSummary(sb)}`);
  await u.set("bizEnd", "2024-01-05");
  const biz = await ctx.bridge.result("calc_business_days", { startDate: "2024-01-01", endDate: "2024-01-05", includeEndDay: false, calendar: ctx.defaultCalendar });
  c.check(u.must("bizStart").value === "2024-01-01" && u.text("bizLiveResult") === `→ ${biz.summaryText}`, () => `hidden card: start "${u.must("bizStart").value}", live "${u.text("bizLiveResult")}"`);

  // The countdown ticks on while collapsed: expanding shows the exact value.
  await u.set("cdTarget", "2026-12-25");
  await u.clickEl(collapseOf(sb, "countdown"));
  await sb.advance(7000);
  await u.clickEl(collapseOf(sb, "countdown"));
  const r = await cdExpect(ctx, sb.timers.now, "2026-12-25", u.must("cdTime").value);
  c.check(u.text("cdClock") === r.clockText, () => `expanded countdown "${u.text("cdClock")}" != "${r.clockText}"`);
  c.check(sameJson(layoutRecord(sb)?.collapsedCards, ["business"]) && layoutWrites(sb) === 3, () => `expand not saved: ${layoutSummary(sb)}`);
  await u.clickEl(collapseOf(sb, "countdown"));
  c.check(sameJson(layoutRecord(sb)?.collapsedCards, ["business", "countdown"]), () => `second collapse: ${layoutSummary(sb)}`);
  cleanRun(c, sb, "layout-collapse-persist");

  // Both stay collapsed at the next launch, which writes nothing.
  const again = await make(T_MAIN, persisted(sb));
  c.check(sameJson(collapsedKeys(again), ["business", "countdown"]) && headerProblems(again).length === 0 && layoutWrites(again) === 0,
    () => `relaunch: ${layoutSummary(again)} ${headerProblems(again).join(" | ")}`);
  await uiDriver(again).clickEl(collapseOf(again, "business"));
  c.check(sameJson(layoutRecord(again)?.collapsedCards, ["countdown"]), () => `expand after relaunch: ${layoutSummary(again)}`);
  const third = await make(T_MAIN, persisted(again));
  c.check(sameJson(collapsedKeys(third), ["countdown"]) && headerProblems(third).length === 0, () => `third launch: ${layoutSummary(third)}`);
  cleanRun(c, again, "layout-collapse-persist (relaunch)");
  cleanRun(c, third, "layout-collapse-persist (third launch)");
}

async function probeLayoutPointerReorder({ make, surface }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  const order = (...keys) => keys;
  // 1. Countdown onto the top of the first card.
  const d1 = await pointerDrag(sb, "countdown", "between", "before");
  const o1 = order("countdown", "between", "add", "business", "age", "info");
  c.check(duringOk(d1), () => `mid-drag (capture, 4 px threshold, dragging class, one gold drop line, default prevented): ${JSON.stringify({ ...d1, handle: undefined })}`);
  c.check(sameJson(domCardOrder(sb), o1) && navProblems(sb).length === 0 && sameJson(layoutRecord(sb), { schemaVersion: 1, cardOrder: o1, collapsedCards: [] }) && layoutWrites(sb) === 1,
    () => `drop before the first card: ${layoutSummary(sb)} ${navProblems(sb)}`);
  c.check(dragMarks(sb) === 0 && !d1.handle.hasPointerCapture(POINTER_ID), "drag classes or the pointer capture were left behind");
  c.check(u.text("layoutLiveStatus") === LAYOUT_TEXT.moved("Countdown", 1, 6), () => `announcement "${u.text("layoutLiveStatus")}"`);
  // 2. Add / Subtract after the last card (a mouse this time).
  const d2 = await pointerDrag(sb, "add", "info", "after", { pointerType: "mouse" });
  const o2 = order("countdown", "between", "business", "age", "info", "add");
  c.check(duringOk(d2) && sameJson(domCardOrder(sb), o2) && navProblems(sb).length === 0 && sameJson(layoutRecord(sb)?.cardOrder, o2) && layoutWrites(sb) === 2,
    () => `drop after the last card: ${layoutSummary(sb)}`);
  c.check(u.text("layoutLiveStatus") === LAYOUT_TEXT.moved("Add / Subtract", 6, 6), () => `announcement "${u.text("layoutLiveStatus")}"`);
  // 3. Onto a collapsed card: the collapsed set is kept.
  await u.clickEl(collapseOf(sb, "age"));
  const d3 = await pointerDrag(sb, "between", "age", "after", { pointerType: "pen" });
  const o3 = order("countdown", "business", "age", "between", "info", "add");
  c.check(duringOk(d3) && sameJson(domCardOrder(sb), o3) && sameJson(layoutRecord(sb), { schemaVersion: 1, cardOrder: o3, collapsedCards: ["age"] }) && layoutWrites(sb) === 4,
    () => `drop after a collapsed card: ${layoutSummary(sb)}`);

  // 4. Nothing moves or saves: a tap under the 4 px threshold, Escape,
  // pointercancel, a lost capture, the window losing focus, a non-primary
  // pointer and a secondary button.
  const w = layoutWrites(sb);
  const h = handleOf(sb, "info");
  const hr = h.getBoundingClientRect();
  firePointer(h, "pointerdown", hr.left + 5, hr.top + 5);
  firePointer(h, "pointermove", hr.left + 7, hr.top + 7);
  firePointer(h, "pointerup", hr.left + 7, hr.top + 7);
  await sb.drain();
  c.check(sameJson(domCardOrder(sb), o3) && layoutWrites(sb) === w && dragMarks(sb) === 0, () => `a tap moved the card: ${layoutSummary(sb)}`);
  const cancels = {
    escape: () => sb.doc.dispatchEvent(new MockEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
    pointercancel: (d) => firePointer(d.handle, "pointercancel", d.x, d.y),
    lostpointercapture: (d) => d.handle.dispatchEvent(new MockEvent("lostpointercapture", { bubbles: true, pointerId: POINTER_ID, isPrimary: true })),
    "window blur": () => sb.win.dispatchEvent(new MockEvent("blur"))
  };
  for (const [how, cancel] of Object.entries(cancels)) {
    const d = await pointerDrag(sb, "info", "countdown", "before", { finish: "none" });
    c.check(d.dragging && d.line, `${how}: the drag did not start`);
    cancel(d);
    firePointer(d.handle, "pointerup", d.x, d.y);
    await sb.drain();
    c.check(sameJson(domCardOrder(sb), o3) && layoutWrites(sb) === w && dragMarks(sb) === 0, () => `${how} did not cancel the drag: ${layoutSummary(sb)}`);
  }
  for (const [how, init] of [["non-primary pointer", { isPrimary: false }], ["secondary button", { button: 2, pointerType: "mouse" }]]) {
    const t = layoutCard(sb, "countdown").getBoundingClientRect();
    firePointer(h, "pointerdown", hr.left + 5, hr.top + 5, init);
    firePointer(h, "pointermove", t.left + 50, t.top + 6, init);
    c.check(!layoutCard(sb, "info").classList.contains("card-dragging"), `${how} started a drag`);
    firePointer(h, "pointerup", t.left + 50, t.top + 6, init);
    await sb.drain();
    c.check(sameJson(domCardOrder(sb), o3) && layoutWrites(sb) === w, () => `${how} moved a card: ${layoutSummary(sb)}`);
  }
  // A second finger's events never steer or end the drag; the first finger drops.
  const d4 = await pointerDrag(sb, "info", "countdown", "before", { finish: "none" });
  firePointer(handleOf(sb, "add"), "pointerdown", d4.x, d4.y, { pointerId: 12, isPrimary: false });
  firePointer(d4.handle, "pointerup", d4.x, d4.y + 900, { pointerId: 12 });
  c.check(layoutCard(sb, "info").classList.contains("card-dragging") && !layoutCard(sb, "add").classList.contains("card-dragging"), "a second pointer ended or took over the drag");
  firePointer(d4.handle, "pointerup", d4.x, d4.y);
  await sb.drain();
  const o4 = order("info", "countdown", "business", "age", "between", "add");
  c.check(sameJson(domCardOrder(sb), o4) && sameJson(layoutRecord(sb)?.cardOrder, o4) && layoutWrites(sb) === w + 1, () => `two pointers: ${layoutSummary(sb)}`);

  // 5. Holding near the bottom or top edge scrolls the page while dragging.
  sb.win.scrollTo(0, 400);
  const top0 = sb.win.scrollY;
  const eh = handleOf(sb, "business");
  const er = eh.getBoundingClientRect();
  firePointer(eh, "pointerdown", er.left + 5, er.top + 5);
  firePointer(eh, "pointermove", er.left + 5, sb.win.innerHeight - 10);
  await sb.advance(200, 50);
  const down = sb.win.scrollY;
  firePointer(eh, "pointermove", er.left + 5, 10);
  await sb.advance(400, 50);
  const up = sb.win.scrollY;
  sb.doc.dispatchEvent(new MockEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sb.advance(200, 50);
  const settled = sb.win.scrollY;
  await sb.advance(200, 50);
  c.check(down > top0 && up < down && sb.win.scrollY === settled, () => `edge auto-scroll: ${top0} → ${down} → ${up}, then ${settled} → ${sb.win.scrollY} after Escape`);
  c.check(sameJson(domCardOrder(sb), o4) && dragMarks(sb) === 0, () => `edge scroll moved a card: ${layoutSummary(sb)}`);
  cleanRun(c, sb, `layout-pointer-reorder (${surface})`);

  // 6. The order is restored at the next launch, pills included.
  const again = await make(T_MAIN, persisted(sb));
  c.check(sameJson(domCardOrder(again), o4) && navProblems(again).length === 0 && sameJson(collapsedKeys(again), ["age"]) && layoutWrites(again) === 0, () => `relaunch: ${layoutSummary(again)}`);
  cleanRun(c, again, "layout-pointer-reorder (relaunch)");
}

async function probeLayoutKeyboardReorder({ make }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  const focusName = () => {
    const a = sb.doc.activeElement;
    return a?.id || a?.getAttribute?.("aria-label") || a?.tagName;
  };
  const h = handleOf(sb, "business");
  h.focus();
  let ev = await pressKey(sb, h, "ArrowUp");
  const o1 = ["between", "business", "add", "age", "info", "countdown"];
  c.check(ev.defaultPrevented && sameJson(domCardOrder(sb), o1) && navProblems(sb).length === 0 && sameJson(layoutRecord(sb)?.cardOrder, o1) && layoutWrites(sb) === 1,
    () => `ArrowUp: ${layoutSummary(sb)}`);
  c.check(sb.doc.activeElement === h, () => `focus after ArrowUp is on ${focusName()}, not the Business Days handle`);
  c.check(u.text("layoutLiveStatus") === LAYOUT_TEXT.moved("Business Days", 2, 6), () => `announcement "${u.text("layoutLiveStatus")}"`);
  await pressKey(sb, h, "ArrowDown");
  ev = await pressKey(sb, h, "ArrowDown");
  const o2 = ["between", "add", "age", "business", "info", "countdown"];
  c.check(ev.defaultPrevented && sameJson(domCardOrder(sb), o2) && navProblems(sb).length === 0 && sameJson(layoutRecord(sb)?.cardOrder, o2) && layoutWrites(sb) === 3,
    () => `ArrowDown twice: ${layoutSummary(sb)}`);
  c.check(sb.doc.activeElement === h && u.text("layoutLiveStatus") === LAYOUT_TEXT.moved("Business Days", 4, 6), () => `after ArrowDown: focus ${focusName()}, "${u.text("layoutLiveStatus")}"`);
  // At the ends: no move and no write; the position is announced again,
  // even when the same text repeats.
  const top = handleOf(sb, "between");
  top.focus();
  await pressKey(sb, top, "ArrowUp");
  c.check(sameJson(domCardOrder(sb), o2) && layoutWrites(sb) === 3 && sb.doc.activeElement === top && u.text("layoutLiveStatus") === LAYOUT_TEXT.moved(LAYOUT_TITLES.between, 1, 6),
    () => `ArrowUp at the top: ${layoutSummary(sb)} / "${u.text("layoutLiveStatus")}"`);
  await pressKey(sb, top, "ArrowUp");
  await sb.advance(200, 50);
  c.check(u.text("layoutLiveStatus") === LAYOUT_TEXT.moved(LAYOUT_TITLES.between, 1, 6) && layoutWrites(sb) === 3, () => `repeated announcement "${u.text("layoutLiveStatus")}"`);
  const bottom = handleOf(sb, "countdown");
  bottom.focus();
  await pressKey(sb, bottom, "ArrowDown");
  c.check(sameJson(domCardOrder(sb), o2) && layoutWrites(sb) === 3 && sb.doc.activeElement === bottom && u.text("layoutLiveStatus") === LAYOUT_TEXT.moved("Countdown", 6, 6),
    () => `ArrowDown at the bottom: ${layoutSummary(sb)} / "${u.text("layoutLiveStatus")}"`);
  // A move to the front keeps focus on the moved handle too.
  for (let i = 0; i < 5; i++) await pressKey(sb, bottom, "ArrowUp");
  c.check(domCardOrder(sb)[0] === "countdown" && sb.doc.activeElement === bottom && u.text("layoutLiveStatus") === LAYOUT_TEXT.moved("Countdown", 1, 6) && layoutWrites(sb) === 8,
    () => `Countdown to the front: ${layoutSummary(sb)} / focus ${focusName()}`);
  // Modified arrows and other keys do nothing.
  const before = domCardOrder(sb);
  for (const [key, shift] of [["ArrowUp", true], ["ArrowDown", true], ["ArrowLeft", false], ["ArrowRight", false]]) {
    const e = await pressKey(sb, h, key, shift);
    c.check(sameJson(domCardOrder(sb), before) && layoutWrites(sb) === 8 && !e.defaultPrevented, () => `${shift ? "Shift+" : ""}${key} on a handle: ${layoutSummary(sb)}`);
  }
  cleanRun(c, sb, "layout-keyboard-reorder");
  const again = await make(T_MAIN, persisted(sb));
  c.check(sameJson(domCardOrder(again), before) && navProblems(again).length === 0, () => `relaunch: ${layoutSummary(again)}`);
}

async function probeLayoutNavFollowsOrder({ make, surface }, c) {
  const order = ["info", "countdown", "age", "business", "add", "between"];
  const raw = layoutRecordText(order, ["age"]);
  const sb = await make(T_MAIN, seedStore(surface, { layout: raw }));
  const u = uiDriver(sb);
  c.check(sameJson(domCardOrder(sb), order) && sameJson(navCardOrder(sb), order) && navProblems(sb).length === 0, () => `stored order at launch: ${layoutSummary(sb)} ${navProblems(sb)}`);
  c.check(sameJson(collapsedKeys(sb), ["age"]) && headerProblems(sb).length === 0, () => `stored collapsed set at launch: ${collapsedKeys(sb)} ${headerProblems(sb).join(" | ")}`);
  c.check(layoutRaw(sb) === raw && layoutWrites(sb) === 0 && u.text("layoutStatusText") === LAYOUT_TEXT.saved, () => `launch wrote or noted: ${layoutSummary(sb)}`);
  c.check(sb.doc.activeElement?.id === "infoDate", () => `launch focus on ${sb.doc.activeElement?.id}, not the first card's first input`);
  u.must("betweenStart").focus();
  await u.click("clearAllBtn");
  c.check(sb.doc.activeElement?.id === "infoDate", () => `clear-all focus on ${sb.doc.activeElement?.id}`);
  // The pills follow every keyboard move; History stays last.
  const h = handleOf(sb, "between");
  for (let i = 0; i < 5; i++) {
    await pressKey(sb, h, "ArrowUp");
    c.check(navProblems(sb).length === 0, () => `after move ${i + 1}: ${navProblems(sb).join(" | ")}`);
  }
  const moved = ["between", "info", "countdown", "age", "business", "add"];
  c.check(sameJson(domCardOrder(sb), moved) && sameJson(navCardOrder(sb), moved) && sameJson(layoutRecord(sb)?.cardOrder, moved), () => `after the moves: ${layoutSummary(sb)}`);
  await u.click("clearAllBtn");
  c.check(sb.doc.activeElement?.id === "betweenStart", () => `clear-all focus after the move: ${sb.doc.activeElement?.id}`);
  // A pointer drop moves the pill too.
  await pointerDrag(sb, "add", "info", "before");
  const dropped = ["between", "add", "info", "countdown", "age", "business"];
  c.check(sameJson(navCardOrder(sb), dropped) && navProblems(sb).length === 0, () => `pills after a drop: ${navCardOrder(sb)}`);
  cleanRun(c, sb, "layout-nav-follows-order");
  // Every card collapsed: launch focus goes to the first card's collapse button.
  const all = await make(T_MAIN, seedStore(surface, { layout: layoutRecordText(order, LAYOUT_CARD_KEYS) }));
  c.check(all.doc.activeElement === collapseOf(all, "info") && sameJson(navCardOrder(all), order), () => `all collapsed: focus ${all.doc.activeElement?.getAttribute?.("aria-label")}, pills ${navCardOrder(all)}`);
  cleanRun(c, all, "layout-nav-follows-order (all collapsed)");
}

async function probeLayoutOpenExpands({ make, surface }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  const pill = (k) => sb.doc.querySelector(`.quick-nav .quick-link[data-calc="${k}"]`);
  // 1. Its quick-nav pill opens a collapsed card (and saves that).
  await u.clickEl(collapseOf(sb, "info"));
  await u.clickEl(pill("info"));
  c.check(collapsedKeys(sb).length === 0 && sb.win.location.hash === "#card-info" && sameJson(layoutRecord(sb)?.collapsedCards, []) && headerProblems(sb).length === 0,
    () => `quick-nav: hash ${sb.win.location.hash} / ${layoutSummary(sb)}`);
  const w = layoutWrites(sb);
  await u.clickEl(pill("age"));
  c.check(layoutWrites(sb) === w && collapsedKeys(sb).length === 0, "the pill of an expanded card wrote the layout");
  // 2. A history restore opens its collapsed card.
  await u.set("infoDate", "2024-02-29");
  await u.enter("infoDate");
  await u.set("infoDate", "2024-03-01");
  await u.clickEl(collapseOf(sb, "info"));
  const restore = u.must("historyList").querySelector(".history-restore-btn");
  c.check(Boolean(restore), "no history entry to restore");
  if (restore) await u.clickEl(restore);
  c.check(collapsedKeys(sb).length === 0 && u.must("infoDate").value === "2024-02-29" && sameJson(layoutRecord(sb)?.collapsedCards, []) && headerProblems(sb).length === 0,
    () => `history restore: date ${u.must("infoDate").value} / ${layoutSummary(sb)}`);
  // 3. Focus returning from Settings to an Edit-calendar link opens its card.
  for (const [btnId, key] of [["bizCalendarEditBtn", "business"], ["addCalendarEditBtn", "add"]]) {
    const btn = u.must(btnId);
    await u.clickEl(btn);
    c.check(!u.hidden("settingsModal"), `${btnId} did not open Settings`);
    // Collapsed while Settings is open (another tab, or a layout reset).
    await u.clickEl(collapseOf(sb, key));
    c.check(sameJson(collapsedKeys(sb), [key]), `${key} did not collapse behind Settings`);
    await u.click("closeSettingsBtn");
    c.check(collapsedKeys(sb).length === 0 && sb.doc.activeElement === btn && sameJson(layoutRecord(sb)?.collapsedCards, []),
      () => `${btnId} focus return: focus ${sb.doc.activeElement?.id} / ${layoutSummary(sb)}`);
  }
  cleanRun(c, sb, `layout-open-expands (${surface})`);
}

async function probeLayoutReset({ make, surface }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  await pressKey(sb, handleOf(sb, "countdown"), "ArrowUp");
  await pressKey(sb, handleOf(sb, "age"), "ArrowUp");
  await u.clickEl(collapseOf(sb, "business"));
  await u.clickEl(collapseOf(sb, "countdown"));
  await u.set("cdTarget", "2026-12-25");
  c.check(!sameJson(domCardOrder(sb), LAYOUT_CARD_KEYS) && collapsedKeys(sb).length === 2, () => `setup: ${layoutSummary(sb)}`);
  await u.click("settingsBtn");
  await u.click("resetLayoutBtn");
  c.check(sameJson(domCardOrder(sb), LAYOUT_CARD_KEYS) && navProblems(sb).length === 0 && collapsedKeys(sb).length === 0 && headerProblems(sb).length === 0,
    () => `after reset: ${layoutSummary(sb)} ${headerProblems(sb).join(" | ")}`);
  c.check(sameJson(layoutRecord(sb), defaultLayoutState()), () => `reset record: ${layoutRaw(sb)}`);
  c.check(u.text("layoutStatusText") === LAYOUT_TEXT.reset && !u.must("layoutStatusText").classList.contains("is-error"), () => `reset note "${u.text("layoutStatusText")}"`);
  c.check(u.must("cdTarget").value === "2026-12-25" && u.must("bizStart").value === "", "reset changed a card's inputs");
  if (surface === "desktop") c.check(sb.backend.state.layoutLog.at(-1)?.op === "reset", "reset did not go through layout_reset");
  // The next change replaces the reset note.
  await u.click("closeSettingsBtn");
  await u.clickEl(collapseOf(sb, "age"));
  c.check(u.text("layoutStatusText") === LAYOUT_TEXT.saved && sameJson(layoutRecord(sb)?.collapsedCards, ["age"]), () => `after the next change: ${layoutSummary(sb)}`);
  await u.click("resetLayoutBtn");
  cleanRun(c, sb, `layout-reset (${surface})`);
  const again = await make(T_MAIN, persisted(sb));
  const ua = uiDriver(again);
  c.check(sameJson(domCardOrder(again), LAYOUT_CARD_KEYS) && collapsedKeys(again).length === 0 && ua.text("layoutStatusText") === LAYOUT_TEXT.saved && layoutWrites(again) === 0,
    () => `relaunch after reset: ${layoutSummary(again)}`);
  // A reset with nothing saved yet still writes the default record.
  const fresh = await make(T_MAIN);
  await uiDriver(fresh).click("resetLayoutBtn");
  c.check(sameJson(layoutRecord(fresh), defaultLayoutState()) && layoutWrites(fresh) === 1, () => `reset on an empty store: ${layoutSummary(fresh)}`);
  cleanRun(c, fresh, "layout-reset (empty store)");
}

async function probeLayoutBadRecords({ make, surface }, c) {
  const rec = (o = {}) => JSON.stringify({ schemaVersion: 1, cardOrder: [...LAYOUT_CARD_KEYS], collapsedCards: [], ...o });
  const defaultsShown = (sb) => sameJson(domCardOrder(sb), LAYOUT_CARD_KEYS) && sameJson(navCardOrder(sb), LAYOUT_CARD_KEYS) && collapsedKeys(sb).length === 0;
  const isError = (sb) => sb.doc.getElementById("layoutStatusText").classList.contains("is-error");
  // Invalid records: backed up once, the default layout, writable again.
  const bad = [
    rec({ cardOrder: LAYOUT_CARD_KEYS.slice(0, 5) }),
    rec({ cardOrder: ["between", "between", "business", "age", "info", "countdown"] }),
    rec({ cardOrder: ["between", "add", "business", "age", "info", "history"] }),
    rec({ cardOrder: [...LAYOUT_CARD_KEYS, "percent"] }),
    rec({ cardOrder: [1, 2, 3, 4, 5, 6] }),
    rec({ cardOrder: "between,add,business,age,info,countdown" }),
    rec({ collapsedCards: ["history"] }),
    rec({ collapsedCards: ["age", "age"] }),
    rec({ collapsedCards: ["__proto__"] }),
    rec({ collapsedCards: null }),
    rec({ pinned: ["age"] }),
    rec({ schemaVersion: "1" }),
    rec({ schemaVersion: 0 }),
    JSON.stringify({ schemaVersion: 1, cardOrder: [...LAYOUT_CARD_KEYS] }),
    JSON.stringify({ cardOrder: [...LAYOUT_CARD_KEYS], collapsedCards: [] }),
    "[1]",
    "null",
    "{not json"
  ];
  for (const v of bad) {
    const sb = await make(T_MAIN, seedStore(surface, { layout: v }));
    const u = uiDriver(sb);
    c.check(defaultsShown(sb) && headerProblems(sb).length === 0 && navProblems(sb).length === 0, () => `invalid ${excerpt(v, 70)}: ${layoutSummary(sb)}`);
    c.check(layoutBak(sb) === v && layoutRaw(sb) === v && layoutWrites(sb) === 0, () => `invalid ${excerpt(v, 70)}: bak ${layoutBak(sb) === v}, raw kept ${layoutRaw(sb) === v}, writes ${layoutWrites(sb)}`);
    c.check(u.text("layoutStatusText") === LAYOUT_TEXT.corrupt && !isError(sb), () => `invalid ${excerpt(v, 40)}: note "${u.text("layoutStatusText")}"`);
    if (v === bad[1]) {
      await u.clickEl(collapseOf(sb, "age"));
      c.check(sameJson(layoutRecord(sb), { schemaVersion: 1, cardOrder: LAYOUT_CARD_KEYS, collapsedCards: ["age"] }) && layoutBak(sb) === v && u.text("layoutStatusText") === LAYOUT_TEXT.saved,
        () => `a change after a corrupt record: ${layoutSummary(sb)}`);
      const again = await make(T_MAIN, persisted(sb));
      c.check(sameJson(collapsedKeys(again), ["age"]) && layoutBak(again) === v, "the replacement was not restored, or the backup was rewritten");
    }
    cleanRun(c, sb, `invalid layout ${excerpt(v, 40)}`);
  }
  // A valid record is never backed up.
  let sb = await make(T_MAIN, seedStore(surface, { layout: rec() }));
  c.check(layoutBak(sb) === null && uiDriver(sb).text("layoutStatusText") === LAYOUT_TEXT.saved, "a valid record was backed up or flagged");

  // Over the 1 KiB cap: corrupt on both surfaces (desktop renames it aside
  // whole, mobile copies it to _bak), and the store stays writable.
  const big = rec({ pad: "x".repeat(1100) });
  sb = await make(T_MAIN, seedStore(surface, { layout: big }));
  let u = uiDriver(sb);
  c.check(defaultsShown(sb) && u.text("layoutStatusText") === LAYOUT_TEXT.corrupt && layoutBak(sb) === big, () => `oversize: ${layoutSummary(sb)} / bak ${layoutBak(sb) === big}`);
  await u.clickEl(collapseOf(sb, "info"));
  c.check(sameJson(layoutRecord(sb)?.collapsedCards, ["info"]) && layoutBak(sb) === big, () => `oversize then a change: ${layoutSummary(sb)}`);

  // A newer-version record (also one over the cap): the default layout for
  // the session, never written, reset or backed up.
  const newer = '{"schemaVersion":2,"cardOrder":["countdown","info"],"collapsedCards":[],"pinned":["age"]}';
  const newerBig = JSON.stringify({ schemaVersion: 3, cardOrder: [], collapsedCards: [], pad: "y".repeat(2000) });
  for (const v of [newer, newerBig]) {
    sb = await make(T_MAIN, seedStore(surface, { layout: v }));
    u = uiDriver(sb);
    c.check(defaultsShown(sb) && u.text("layoutStatusText") === LAYOUT_TEXT.newer && isError(sb), () => `newer ${excerpt(v, 40)}: ${layoutSummary(sb)}`);
    await u.clickEl(collapseOf(sb, "age"));
    c.check(u.text("layoutLiveStatus") === "", () => `newer: a blocked change announced "${u.text("layoutLiveStatus")}"`);
    await pressKey(sb, handleOf(sb, "info"), "ArrowUp");
    await pointerDrag(sb, "between", "countdown", "after");
    await u.click("resetLayoutBtn");
    await u.clickEl(collapseOf(sb, "business"));
    c.check(sameJson(collapsedKeys(sb), ["business"]) && u.text("layoutStatusText") === LAYOUT_TEXT.newer, () => `newer: the session layout ${layoutSummary(sb)}`);
    c.check(layoutRaw(sb) === v && layoutBak(sb) === null && layoutWrites(sb) === 0 && layoutSaveAttempts(sb) === 0,
      () => `newer ${excerpt(v, 40)}: raw kept ${layoutRaw(sb) === v}, bak ${layoutBak(sb)}, writes ${layoutWrites(sb)}, attempts ${layoutSaveAttempts(sb)}`);
    const again = await make(T_MAIN, persisted(sb));
    c.check(defaultsShown(again) && uiDriver(again).text("layoutStatusText") === LAYOUT_TEXT.newer, () => `newer, relaunch: ${layoutSummary(again)}`);
    cleanRun(c, sb, `newer layout ${excerpt(v, 30)}`);
  }

  // A newer record that appears after launch: the store refuses the save,
  // the UI says so once and stops writing.
  sb = await make(T_MAIN);
  u = uiDriver(sb);
  if (surface === "mobile") sb.storage.external(LAYOUT_KEY, newer);
  else sb.backend.disk.layout = newer;
  await u.clickEl(collapseOf(sb, "age"));
  c.check(layoutRaw(sb) === newer && u.text("layoutStatusText") === LAYOUT_TEXT.newer && isError(sb) && u.text("layoutLiveStatus") === LAYOUT_TEXT.newer,
    () => `late newer record: ${layoutSummary(sb)} / live "${u.text("layoutLiveStatus")}"`);
  const attempts = layoutSaveAttempts(sb);
  await u.clickEl(collapseOf(sb, "age"));
  await u.click("resetLayoutBtn");
  c.check(layoutRaw(sb) === newer && layoutSaveAttempts(sb) === attempts && layoutBak(sb) === null, () => `after the refusal: ${layoutSummary(sb)}, attempts ${layoutSaveAttempts(sb) - attempts}`);
  cleanRun(c, sb, "late newer layout");

  // Desktop: a file that cannot be read (locked) is never touched; one that
  // turns unreadable after launch is refused.
  if (surface === "desktop") {
    sb = await make(T_MAIN, seedStore(surface, { layout: rec({ collapsedCards: ["age"] }), layoutUnreadable: true }));
    u = uiDriver(sb);
    c.check(defaultsShown(sb) && u.text("layoutStatusText") === LAYOUT_TEXT.unreadable && isError(sb), () => `unreadable: ${layoutSummary(sb)}`);
    await u.clickEl(collapseOf(sb, "info"));
    await u.click("resetLayoutBtn");
    c.check(layoutRaw(sb) === rec({ collapsedCards: ["age"] }) && layoutBak(sb) === null && layoutSaveAttempts(sb) === 0, () => `unreadable: ${layoutSummary(sb)}`);
    sb = await make(T_MAIN);
    u = uiDriver(sb);
    sb.backend.disk.layout = rec();
    sb.backend.disk.layoutUnreadable = true;
    await u.clickEl(collapseOf(sb, "info"));
    c.check(u.text("layoutStatusText") === LAYOUT_TEXT.unreadable && layoutRaw(sb) === rec(), () => `late unreadable: ${layoutSummary(sb)}`);
    // An over-cap file with .bak taken goes to a fresh name, never over it.
    sb = await make(T_MAIN, seedStore(surface, { layout: big, layoutBak: "older backup" }));
    c.check(layoutBak(sb) === "older backup" && sameJson(sb.backend.disk.layoutExtraBaks, [big]) && layoutRaw(sb) === null, () => `oversize with .bak taken: extra ${sb.backend.disk.layoutExtraBaks.length}`);
  }

  // A failed save: the layout stays applied, the note and one announcement
  // say it was not saved, and the next change retries.
  sb = await make(T_MAIN);
  u = uiDriver(sb);
  if (surface === "desktop") sb.backend.state.failLayoutSave = 1;
  else sb.storage.refuse.add(LAYOUT_KEY);
  await u.clickEl(collapseOf(sb, "age"));
  c.check(sameJson(collapsedKeys(sb), ["age"]) && layoutRaw(sb) === null && u.text("layoutStatusText") === LAYOUT_TEXT.writeFailed && isError(sb) && u.text("layoutLiveStatus") === LAYOUT_TEXT.writeFailed,
    () => `failed save: ${layoutSummary(sb)} / live "${u.text("layoutLiveStatus")}"`);
  if (surface === "mobile") sb.storage.refuse.delete(LAYOUT_KEY);
  await u.clickEl(collapseOf(sb, "info"));
  c.check(sameJson(layoutRecord(sb)?.collapsedCards, ["age", "info"]) && u.text("layoutStatusText") === LAYOUT_TEXT.saved && !isError(sb), () => `retry after a failed save: ${layoutSummary(sb)}`);
  cleanRun(c, sb, "failed layout save");

  // Mobile with site data blocked: the layout works for the session and the
  // note says it is not kept.
  if (surface === "mobile") {
    sb = await make(T_MAIN, { storageBlocked: true });
    u = uiDriver(sb);
    c.check(u.text("layoutStatusText") === LAYOUT_TEXT.session, () => `blocked storage note "${u.text("layoutStatusText")}"`);
    await u.clickEl(collapseOf(sb, "age"));
    await pressKey(sb, handleOf(sb, "info"), "ArrowUp");
    c.check(sameJson(collapsedKeys(sb), ["age"]) && domCardOrder(sb)[3] === "info" && u.text("layoutStatusText") === LAYOUT_TEXT.session, () => `blocked storage: ${layoutSummary(sb)}`);
    c.check(sb.errors.length === 0 && sb.doc._errors.length === 0, () => `blocked storage errors: ${[...sb.errors, ...sb.doc._errors].join(" | ")}`);
  }
}

async function probeLayoutStorageEvent({ make }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  const otherTab = async (value, area = sb.storage) => {
    sb.storage.external(LAYOUT_KEY, value);
    sb.win.dispatchEvent(new MockEvent("storage", { key: LAYOUT_KEY, storageArea: area }));
    await sb.drain();
  };
  // Another tab's order and collapsed set are adopted without writing, and
  // focus stays where it was even though its card moved.
  u.must("addStart").focus();
  const o1 = ["countdown", "add", "between", "business", "age", "info"];
  await otherTab(layoutRecordText(o1, ["age"]));
  c.check(sameJson(domCardOrder(sb), o1) && navProblems(sb).length === 0 && sameJson(collapsedKeys(sb), ["age"]) && headerProblems(sb).length === 0, () => `adopt: ${layoutSummary(sb)}`);
  c.check(sb.doc.activeElement === u.must("addStart"), () => `focus after another tab's move: ${sb.doc.activeElement?.id}`);
  c.check(layoutWrites(sb) === 0, "adopting another tab's layout wrote");
  // Focus inside a card another tab collapses moves to its collapse button.
  u.must("bizStart").focus();
  await otherTab(layoutRecordText(o1, ["age", "business"]));
  c.check(sameJson(collapsedKeys(sb), ["business", "age"]) && sb.doc.activeElement === collapseOf(sb, "business"), () => `another tab collapsed the focused card: collapsed ${collapsedKeys(sb)}, focus on ${sb.doc.activeElement?.getAttribute?.("aria-label") || sb.doc.activeElement?.id}`);
  // Mid-drag the event is ignored; the drop saves this tab's order.
  const d = await pointerDrag(sb, "info", "countdown", "before", { finish: "none" });
  await otherTab(layoutRecordText(LAYOUT_CARD_KEYS, []));
  c.check(sameJson(domCardOrder(sb), o1) && layoutCard(sb, "info").classList.contains("card-dragging"), () => `an event mid-drag was applied: ${layoutSummary(sb)}`);
  firePointer(d.handle, "pointerup", d.x, d.y);
  await sb.drain();
  const o2 = ["info", "countdown", "add", "between", "business", "age"];
  c.check(sameJson(domCardOrder(sb), o2) && sameJson(layoutRecord(sb), { schemaVersion: 1, cardOrder: o2, collapsedCards: ["age", "business"] }) && layoutWrites(sb) === 1,
    () => `the drop after an ignored event: ${layoutSummary(sb)}`);
  // A clear in another tab: the defaults, nothing written.
  await otherTab(null);
  c.check(sameJson(domCardOrder(sb), LAYOUT_CARD_KEYS) && collapsedKeys(sb).length === 0 && layoutRaw(sb) === null && layoutWrites(sb) === 1, () => `clear in another tab: ${layoutSummary(sb)}`);
  // A newer-version record from another tab blocks writes here too.
  const newer = '{"schemaVersion":2,"cardOrder":[],"collapsedCards":[]}';
  await otherTab(newer);
  c.check(u.text("layoutStatusText") === LAYOUT_TEXT.newer, () => `newer from another tab: note "${u.text("layoutStatusText")}"`);
  await u.clickEl(collapseOf(sb, "age"));
  c.check(layoutRaw(sb) === newer && layoutWrites(sb) === 1 && layoutBak(sb) === null, () => `newer from another tab was overwritten: ${layoutSummary(sb)}`);
  // A valid record again: adopted, and writable again.
  await otherTab(layoutRecordText(LAYOUT_CARD_KEYS, ["info"]));
  c.check(sameJson(collapsedKeys(sb), ["info"]) && u.text("layoutStatusText") === LAYOUT_TEXT.saved, () => `valid again: ${layoutSummary(sb)}`);
  await u.clickEl(collapseOf(sb, "info"));
  c.check(sameJson(layoutRecord(sb)?.collapsedCards, []) && layoutWrites(sb) === 2, () => `write after valid again: ${layoutSummary(sb)}`);
  // An event from another storage area is ignored.
  await otherTab(layoutRecordText(o1, ["between"]), new MemoryStorage());
  c.check(sameJson(domCardOrder(sb), LAYOUT_CARD_KEYS) && collapsedKeys(sb).length === 0, () => `another storage area: ${layoutSummary(sb)}`);
  cleanRun(c, sb, "layout-storage-event");
}

// Phone-first touch safety (v1.2.0 review): a wobbly tap on a handle near a
// screen edge never starts a drag, scrolls the page or moves a card; a touch
// drag needs 10 px (a mouse 4 px); edge auto-scroll arms only after 24 px of
// travel or a 300 ms hold; and a drop keeps focus that was inside the card.
async function probeLayoutTouchSafety({ make, surface }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  const announced0 = u.text("layoutLiveStatus");
  // Date Info's handle about 52 px from the top: inside the 60 px edge zone.
  const placeNearTop = () => {
    const r = handleOf(sb, "info").getBoundingClientRect();
    sb.win.scrollTo(0, sb.win.scrollY + r.top - 30);
    const h = handleOf(sb, "info").getBoundingClientRect();
    return { x: h.left + h.width / 2, y: h.top + h.height / 2 };
  };
  const unchanged = () => sameJson(domCardOrder(sb), LAYOUT_CARD_KEYS) && layoutWrites(sb) === 0 && dragMarks(sb) === 0 && u.text("layoutLiveStatus") === announced0;
  const h = handleOf(sb, "info");
  for (const [label, dx, dy] of [["a 4 px wobble", 3, 3], ["an 8 px wobble", 6, -5]]) {
    const p = placeNearTop();
    const y0 = sb.win.scrollY;
    firePointer(h, "pointerdown", p.x, p.y);
    firePointer(h, "pointermove", p.x + dx, p.y + dy);
    const dragging = layoutCard(sb, "info").classList.contains("card-dragging");
    await sb.advance(150, 16);
    firePointer(h, "pointerup", p.x + dx, p.y + dy);
    await sb.drain();
    c.check(!dragging && sb.win.scrollY === y0 && unchanged(), () => `touch tap with ${label} near the top edge: dragging=${dragging}, scroll ${y0} → ${sb.win.scrollY}, ${layoutSummary(sb)}`);
  }
  // A quick 12 px touch drag near the edge starts, but neither scrolls nor moves.
  {
    const p = placeNearTop();
    const y0 = sb.win.scrollY;
    firePointer(h, "pointerdown", p.x, p.y);
    firePointer(h, "pointermove", p.x + 12, p.y);
    const dragging = layoutCard(sb, "info").classList.contains("card-dragging");
    await sb.advance(200, 16);
    firePointer(h, "pointerup", p.x + 12, p.y);
    await sb.drain();
    c.check(dragging && sb.win.scrollY === y0 && unchanged(), () => `a quick 12 px touch drag near the edge: dragging=${dragging}, scroll ${y0} → ${sb.win.scrollY}, ${layoutSummary(sb)}`);
  }
  // A mouse starts at 4 px; a touch at 6 px does not.
  for (const [pointerType, want] of [["touch", false], ["pen", false], ["mouse", true]]) {
    const r = handleOf(sb, "business").getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = 300;
    sb.win.scrollTo(0, sb.win.scrollY + r.top + r.height / 2 - y);
    const hb = handleOf(sb, "business");
    firePointer(hb, "pointerdown", x, y, { pointerType });
    firePointer(hb, "pointermove", x + 6, y, { pointerType });
    const dragging = layoutCard(sb, "business").classList.contains("card-dragging");
    sb.doc.dispatchEvent(new MockEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    firePointer(hb, "pointerup", x + 6, y, { pointerType });
    await sb.drain();
    c.check(dragging === want && unchanged(), () => `${pointerType} 6 px: dragging=${dragging} (want ${want}), ${layoutSummary(sb)}`);
  }
  // Holding a started drag at the edge for 300 ms arms the auto-scroll.
  {
    const p = placeNearTop();
    const y0 = sb.win.scrollY;
    firePointer(h, "pointerdown", p.x, p.y);
    firePointer(h, "pointermove", p.x + 12, p.y - 20);
    await sb.advance(200, 16);
    const early = sb.win.scrollY;
    await sb.advance(300, 16);
    const held = sb.win.scrollY;
    sb.doc.dispatchEvent(new MockEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    firePointer(h, "pointerup", p.x + 12, p.y - 20);
    await sb.drain();
    c.check(early === y0 && held < y0 && unchanged(), () => `hold at the top edge: ${y0} → ${early} (200 ms) → ${held} (500 ms), ${layoutSummary(sb)}`);
  }
  // A drop keeps focus that was inside the dragged card: an input, or its
  // collapse button.
  u.must("ageBirth").focus();
  await pointerDrag(sb, "age", "business", "before");
  const o1 = ["between", "add", "age", "business", "info", "countdown"];
  c.check(sameJson(domCardOrder(sb), o1) && sb.doc.activeElement?.id === "ageBirth", () => `drop with ageBirth focused: focus on ${sb.doc.activeElement?.id || sb.doc.activeElement?.tagName}, ${layoutSummary(sb)}`);
  collapseOf(sb, "countdown").focus();
  await pointerDrag(sb, "countdown", "between", "before");
  c.check(domCardOrder(sb)[0] === "countdown" && sb.doc.activeElement === collapseOf(sb, "countdown"), () => `drop with the collapse button focused: focus on ${sb.doc.activeElement?.getAttribute?.("aria-label") || sb.doc.activeElement?.tagName}`);
  cleanRun(c, sb, `layout-touch-safety (${surface})`);
}

// The move menu (WCAG 2.5.7): a tap, click or Enter on a handle opens Move up
// / Move down / Done under the card's title row, so a phone screen-reader user
// can reorder cards with single taps; the click that ends a real drag does not.
async function probeLayoutMoveMenu({ make, surface }, c) {
  const sb = await make(T_MAIN);
  const u = uiDriver(sb);
  const menu = () => sb.doc.getElementById("cardMoveMenu");
  const isOpen = () => Boolean(menu()) && menu().offsetParent !== null;
  const btn = (action) => menu()?.querySelector(`.card-move-btn[data-move="${action}"]`) ?? null;
  const focusName = () => sb.doc.activeElement?.textContent?.trim() || sb.doc.activeElement?.getAttribute?.("aria-label") || sb.doc.activeElement?.id || sb.doc.activeElement?.tagName;
  c.check(Boolean(menu()) && !isOpen() && sb.doc.querySelectorAll(".card-move-menu").length === 1, "the move menu is missing, open at launch or duplicated");
  const hb = handleOf(sb, "business");
  await u.clickEl(hb);
  const buttons = menu()?.querySelectorAll(".card-move-btn") ?? [];
  c.check(isOpen() && layoutCard(sb, "business").contains(menu()) && menu().getAttribute("role") === "group" && menu().getAttribute("aria-label") === LAYOUT_TEXT.move("Business Days"),
    () => `open: ${isOpen()} in business=${layoutCard(sb, "business").contains(menu())} role ${menu()?.getAttribute("role")} label "${menu()?.getAttribute("aria-label")}"`);
  c.check(buttons.length === 3 && buttons.every((b) => b.tagName === "BUTTON" && b.type === "button") && sameJson(buttons.map((b) => b.textContent), [LAYOUT_TEXT.moveUp, LAYOUT_TEXT.moveDown, LAYOUT_TEXT.moveDone]),
    () => `buttons: ${buttons.map((b) => `${b.tagName}/${b.type}/"${b.textContent}"`).join(", ")}`);
  c.check(sb.doc.activeElement === btn("up") && layoutWrites(sb) === 0, () => `focus after opening is on ${focusName()}, writes ${layoutWrites(sb)}`);
  // Move up, then down twice: each saves, announces and keeps focus.
  await u.clickEl(btn("up"));
  const o1 = ["between", "business", "add", "age", "info", "countdown"];
  c.check(sameJson(domCardOrder(sb), o1) && navProblems(sb).length === 0 && sameJson(layoutRecord(sb)?.cardOrder, o1) && layoutWrites(sb) === 1 && u.text("layoutLiveStatus") === LAYOUT_TEXT.moved("Business Days", 2, 6),
    () => `Move up: ${layoutSummary(sb)} / "${u.text("layoutLiveStatus")}"`);
  c.check(sb.doc.activeElement === btn("up") && isOpen() && layoutCard(sb, "business").contains(menu()), () => `after Move up: focus ${focusName()}, open ${isOpen()}`);
  await u.clickEl(btn("down"));
  await u.clickEl(btn("down"));
  const o2 = ["between", "add", "age", "business", "info", "countdown"];
  c.check(sameJson(domCardOrder(sb), o2) && sameJson(layoutRecord(sb)?.cardOrder, o2) && layoutWrites(sb) === 3 && u.text("layoutLiveStatus") === LAYOUT_TEXT.moved("Business Days", 4, 6) && sb.doc.activeElement === btn("down"),
    () => `Move down twice: ${layoutSummary(sb)} / focus ${focusName()}`);
  // Done closes and returns focus to the handle.
  await u.clickEl(btn("done"));
  c.check(!isOpen() && sb.doc.activeElement === hb && layoutWrites(sb) === 3, () => `Done: open ${isOpen()}, focus ${focusName()}`);
  // The handle toggles; Escape in the menu closes it onto the handle.
  await u.clickEl(hb);
  await u.clickEl(hb);
  c.check(!isOpen() && sb.doc.activeElement === hb, () => `second handle click: open ${isOpen()}, focus ${focusName()}`);
  await u.clickEl(hb);
  const esc = await pressKey(sb, btn("down"), "Escape");
  c.check(!isOpen() && sb.doc.activeElement === hb && esc.defaultPrevented, () => `Escape: open ${isOpen()}, focus ${focusName()}`);
  // Another card's handle moves the one menu there; a pointer elsewhere closes it.
  await u.clickEl(hb);
  const ha = handleOf(sb, "age");
  const ar = ha.getBoundingClientRect();
  firePointer(ha, "pointerdown", ar.left + 5, ar.top + 5);
  firePointer(ha, "pointerup", ar.left + 5, ar.top + 5);
  await u.clickEl(ha);
  c.check(isOpen() && layoutCard(sb, "age").contains(menu()) && sb.doc.querySelectorAll(".card-move-menu").length === 1 && menu().getAttribute("aria-label") === LAYOUT_TEXT.move("Age"),
    () => `menu on Age: open ${isOpen()}, in age=${layoutCard(sb, "age").contains(menu())}, label "${menu()?.getAttribute("aria-label")}"`);
  firePointer(u.must("betweenStart"), "pointerdown", 100, 100, { pointerType: "mouse" });
  c.check(!isOpen(), "a pointer outside did not close the menu");
  // It works on a collapsed card too, and the collapsed set is kept.
  await u.clickEl(collapseOf(sb, "info"));
  await u.clickEl(handleOf(sb, "info"));
  await u.clickEl(btn("up"));
  const o3 = ["between", "add", "age", "info", "business", "countdown"];
  c.check(sameJson(layoutRecord(sb), { schemaVersion: 1, cardOrder: o3, collapsedCards: ["info"] }) && sb.doc.activeElement === btn("up") && headerProblems(sb).length === 0,
    () => `collapsed card: ${layoutSummary(sb)} ${headerProblems(sb).join(" | ")}`);
  await u.clickEl(btn("done"));
  // The click that ends a real drag opens nothing; the next tap does.
  const w = layoutWrites(sb);
  const d = await pointerDrag(sb, "countdown", "between", "before");
  await u.clickEl(d.handle);
  c.check(!isOpen() && domCardOrder(sb)[0] === "countdown" && layoutWrites(sb) === w + 1, () => `click after a drag: open ${isOpen()}, ${layoutSummary(sb)}`);
  const cr = d.handle.getBoundingClientRect();
  firePointer(d.handle, "pointerdown", cr.left + 5, cr.top + 5);
  firePointer(d.handle, "pointerup", cr.left + 6, cr.top + 6);
  await u.clickEl(d.handle);
  c.check(isOpen() && layoutCard(sb, "countdown").contains(menu()), () => `tap after the drag: open ${isOpen()}`);
  // At the top, Move up is marked unavailable (aria-disabled, so focus stays);
  // moving down makes it available again.
  c.check(btn("up")?.getAttribute("aria-disabled") === "true" && btn("down")?.getAttribute("aria-disabled") === null && btn("up")?.disabled !== true,
    () => `edges at the top: up=${btn("up")?.getAttribute("aria-disabled")} down=${btn("down")?.getAttribute("aria-disabled")}`);
  await u.clickEl(btn("down"));
  c.check(btn("up")?.getAttribute("aria-disabled") === null && domCardOrder(sb)[1] === "countdown",
    () => `after moving off the top: up=${btn("up")?.getAttribute("aria-disabled")} ${layoutSummary(sb)}`);
  // Settings reset closes it.
  await u.click("resetLayoutBtn");
  c.check(!isOpen() && sameJson(domCardOrder(sb), LAYOUT_CARD_KEYS), () => `after reset: open ${isOpen()}, ${layoutSummary(sb)}`);
  cleanRun(c, sb, `layout-move-menu (${surface})`);
}

const V120_PROBES = [
  ["layout-collapse-persist", "every card header has a ⠿ <button> handle (\"Move <title>\", described by #cardMoveHint) and a [ − ]/[ + ] collapse <button> (aria-expanded, aria-controls=card-<key>-body, \"Collapse/Expand <title>\"); collapsing hides only the body (inputs keep their values, live results keep updating, the countdown shows the exact value on expand), each change saves {schemaVersion 1, cardOrder, collapsedCards}, the launch writes nothing and restores the collapsed set", probeLayoutCollapsePersist],
  ["layout-pointer-reorder", "a touch, mouse or pen drag on the handle (pointer capture, a 4 px mouse / 10 px touch and pen start threshold, the dragging class and one gold drop line, default prevented) reorders the cards, the quick-nav pills and the store, announces \"Moved <title> to position N of 6.\", and leaves no class or capture behind; a tap, Escape, pointercancel, a lost capture, window blur, a non-primary pointer, a secondary button and a second finger never move anything; holding near an edge auto-scrolls; no inline style is ever set; the order is restored at the next launch", probeLayoutPointerReorder],
  ["layout-touch-safety", "phone first: a touch tap that wobbles 4 or 8 px on a handle 52 px from the top edge starts no drag, scrolls nothing and moves nothing; a quick 12 px touch drag there neither scrolls nor moves; a 6 px move starts a drag with a mouse only (touch and pen need 10 px); edge auto-scroll arms only after 24 px of travel or a 300 ms hold; a drop keeps focus that was inside the dragged card (an input, its collapse button)", probeLayoutTouchSafety],
  ["layout-move-menu", "WCAG 2.5.7 single-pointer alternative: a tap, click or Enter on a handle opens one Move up / Move down / Done group (role group, \"Move <title>\") under that card's title row with focus on Move up; each move saves, announces \"Moved <title> to position N of 6.\" and keeps focus on the pressed button; Done, a second handle tap and Escape close it onto the handle; another handle moves it there; a pointer elsewhere and the Settings reset close it; it works on a collapsed card; the click that ends a real drag opens nothing", probeLayoutMoveMenu],
  ["layout-keyboard-reorder", "ArrowUp/ArrowDown on a focused handle move its card one place, save, keep focus on that handle (also when the move takes it out of the tree) and announce the position; at either end nothing moves or saves and the position is announced again; modified arrows and other keys do nothing", probeLayoutKeyboardReorder],
  ["layout-nav-follows-order", "a stored order and collapsed set apply at launch before the first render (cards and pills, History last, every pill still pointing at its card, nothing written); launch and clear-all focus go to the first input of the first expanded card in that order, or to the first card's collapse button when all are collapsed; every move keeps the pills in step", probeLayoutNavFollowsOrder],
  ["layout-open-expands", "opening a collapsed card expands it and saves that: from its quick-nav pill, from a history restore, and when focus returns from Settings to an Edit-calendar link inside it; a pill of an expanded card writes nothing", probeLayoutOpenExpands],
  ["layout-reset", "Settings → Layout → \"Reset card order & expand all\" restores the default order and expands every card (pills and headers too) without touching any input, writes the default record (through layout_reset on desktop), shows the reset note until the next change, and the next launch reads the defaults; a reset on an empty store also writes the default record; localStorage.clear() is never used", probeLayoutReset],
  ["layout-bad-records", "invalid layout records (a missing, repeated or unknown card, seven cards, non-string or non-array fields, unknown or repeated collapsed keys, an extra field, a missing field, schemaVersion \"1\" or 0, not an object, not JSON) are backed up once, show the default layout with the damaged note and are replaced by the next change; an over-cap record is backed up (desktop: renamed aside whole, to a fresh name when .bak is taken) and the store stays writable; a newer-version record (also over the cap) shows the defaults with the newer note and is never written, reset or backed up; one that appears after launch is refused, announced once and never retried; a locked desktop file is never touched; a failed save keeps the layout, says so once and the next change retries; blocked site data keeps the layout for the session with the session note", probeLayoutBadRecords]
];

async function runV120Suite(slice, ctx, make, surface) {
  const P = { make, ctx, surface };
  for (const [id, desc, probe] of V120_PROBES) {
    const crit = slice.criterion(id, `${surface}: ${desc}`);
    await guard(crit, id, () => probe(P, crit));
  }
  if (surface === "mobile") {
    const crit = slice.criterion("layout-storage-event", "mobile: another tab's layout write, clear or newer-version record is adopted without writing (focus kept, or moved to the collapse button of a card collapsed under it), ignored mid-drag (the drop then saves this tab's order), and events from another storage area are ignored");
    await guard(crit, "layout storage event", () => probeLayoutStorageEvent(P, crit));
  }
}

// ============================================================================
// 13. Slice B: mobile UI
// ============================================================================

async function runSliceB(slice, ctx) {
  const { art } = ctx;
  const make = (startMs, extra = {}) => createMobileSandbox(art, { startMs, seed: ctx.opts.seed, ...extra });
  const sb = await make(T_MAIN);
  ctx.mobileSnaps = await runUiSuite(slice, sb, ctx);
  await runClockSuite(slice, make, ctx);
  await runV110Suite(slice, ctx, make, "mobile");
  await runV120Suite(slice, ctx, make, "mobile");

  // v1.1.0 (plan A3): corrupt stored history is no longer replaced by an
  // empty, writable one. It is copied to _bak and history turns read-only
  // (the read-only flows themselves are in history-read-only-banner).
  const corrupt = slice.criterion("corrupt-storage", "corrupt or invalid stored history/settings are copied once to <key>_bak; settings fall back to defaults (startup update check off, so no network); corrupt history (bad JSON, wrong shape, any dropped or prototype-named entry) turns read-only with the stored value untouched and the valid entries listed; the calculators still work");
  await guard(corrupt, "corrupt storage", async () => {
    const variants = [
      { [HISTORY_KEY]: "{not json", [SETTINGS_KEY]: "[1,2" },
      { [HISTORY_KEY]: '{"entries":[]}', [SETTINGS_KEY]: JSON.stringify({ checkUpdatesOnStartup: true, calendar: { weekend: [1, 2, 3, 4, 5, 6, 7] } }) },
      { [SETTINGS_KEY]: JSON.stringify({ checkUpdatesOnStartup: true, calendar: {}, pad: "x".repeat(70000) }) },
      { [SETTINGS_KEY]: JSON.stringify({ checkUpdatesOnStartup: true, schemaVersion: 2 }) }
    ];
    for (const storage of variants) {
      const m = await make(T_MAIN, { storage: { ...storage } });
      const u = uiDriver(m);
      for (const [k, v] of Object.entries(storage)) {
        corrupt.check(m.storage.getItem(`${k}_bak`) === v, () => `${k}_bak not written for ${excerpt(v, 60)}`);
      }
      corrupt.check(u.text("historyCount") === "(0 / 500)" && !u.must("autoUpdateToggle").checked && m.fetchCalls.length === 0, () => `defaults not fail-closed (fetch ${m.fetchCalls.length})`);
      corrupt.check(u.must("weekendSatSunBtn").getAttribute("aria-pressed") === "true", "default weekend not shown");
      const historyCorrupt = Object.hasOwn(storage, HISTORY_KEY);
      corrupt.check(u.hidden("historyReadOnlyBanner") === !historyCorrupt, () => `read-only banner shown=${!u.hidden("historyReadOnlyBanner")} for corrupt history=${historyCorrupt}`);
      await u.set("infoDate", "2024-02-29");
      corrupt.check(u.text("infoLiveResult").startsWith("→ Thursday"), () => `calculators broken: ${u.text("infoLiveResult")}`);
      await u.enter("infoDate");
      if (historyCorrupt) {
        corrupt.check(m.storage.getItem(HISTORY_KEY) === storage[HISTORY_KEY] && u.text("historyCount") === "(0 / 500)", "a read-only history was written");
      } else {
        corrupt.check(JSON.parse(m.storage.getItem(HISTORY_KEY)).length === 1, "history unusable after corrupt settings");
      }
      corrupt.check(m.errors.length === 0 && m.doc._errors.length === 0, () => `errors: ${m.errors.join(" | ")}`);
    }
    const good = { id: 7, timestampMs: 1, calculator: "info", calculatorLabel: "Date Info", inputs: { date: "2024-01-01" }, inputsText: "2024-01-01", resultText: "Monday, January 1, 2024", copyText: "Monday, January 1, 2024" };
    const entries = [
      good,
      { ...good, id: 8, calculator: "__proto__" },
      { ...good, id: 9, calculator: "constructor" },
      { ...good, id: 10, calculator: "toString" },
      { ...good, id: 11, copyText: "x".repeat(5000) },
      { ...good, id: 12, extra: 1 },
      { ...good, id: 13, inputs: { date: "2024-01-01", __proto__x: "1" } },
      { ...good, id: 14, inputs: { date: "2024-02-30" } },
      { ...good, id: -1 },
      { ...good, id: 15, resultText: "line\nbreak" }
    ];
    const raw = JSON.stringify(entries);
    const m = await make(T_MAIN, { storage: { [HISTORY_KEY]: raw } });
    const items = m.doc.querySelectorAll(".history-item");
    corrupt.check(items.length === 1 && uiDriver(m).text("historyCount") === "(1 / 500)", () => `kept ${items.length} entries`);
    corrupt.check(m.storage.getItem(`${HISTORY_KEY}_bak`) === raw && m.storage.getItem(HISTORY_KEY) === raw, "dropped entries must be backed up once and the stored value left untouched");
    corrupt.check(!uiDriver(m).hidden("historyReadOnlyBanner") && items.every((it) => it.querySelector(".history-delete-btn").disabled), "dropped entries did not make history read-only");
    const valid = await make(T_MAIN, { storage: { [HISTORY_KEY]: JSON.stringify([good]) } });
    corrupt.check(valid.storage.getItem(`${HISTORY_KEY}_bak`) === null && uiDriver(valid).hidden("historyReadOnlyBanner"), "a valid array must not be backed up or read-only");
    const proto = await make(T_MAIN, { storage: { [HISTORY_KEY]: '[{"__proto__":{"polluted":1},"id":1}]' } });
    corrupt.check(({}).polluted === undefined && uiDriver(proto).text("historyCount") === "(0 / 500)" && !uiDriver(proto).hidden("historyReadOnlyBanner"), "prototype pollution through stored history");
  });

  const blocked = slice.criterion("storage-blocked", "with localStorage throwing (blocked site data) the page boots, calculates and keeps history for the session without errors");
  await guard(blocked, "blocked storage", async () => {
    const m = await make(T_MAIN, { storageBlocked: true });
    const u = uiDriver(m);
    await u.set("infoDate", "2024-02-29");
    await u.enter("infoDate");
    blocked.check(u.text("historyCount") === "(1 / 500)" && u.text("infoLiveResult").startsWith("→ Thursday"), () => `${u.text("historyCount")} / ${u.text("infoLiveResult")}`);
    blocked.check(m.errors.length === 0 && m.doc._errors.length === 0, () => `errors: ${m.errors.join(" | ")}`);
  });

  const update = slice.criterion("update-check", "the startup update check calls only the GitHub Releases API without credentials; a newer release shows the banner with its link sanitised to the official releases URL; redirects, other origins and bad JSON show no banner");
  await guard(update, "update check", async () => {
    const respond = (body, extra = {}) => async () => ({ ok: true, status: 200, url: GITHUB_API_LATEST, redirected: false, headers: { get: () => null }, text: async () => body, ...extra });
    const cases = [
      [respond(releaseJson("v9.9.9", "https://evil.example/phish")), true, RELEASE_URL],
      [respond(releaseJson("v9.9.9", `${RELEASE_PREFIX}tag/v9.9.9`)), true, `${RELEASE_PREFIX}tag/v9.9.9`],
      [respond(releaseJson("v9.9.9", `${RELEASE_PREFIX}../../evil`)), true, RELEASE_URL],
      [respond(releaseJson("v9.9.9", "javascript:alert(1)")), true, RELEASE_URL],
      [respond(releaseJson(`v${APP_VERSION}`, `${RELEASE_PREFIX}tag/v${APP_VERSION}`)), false, null],
      [respond(releaseJson("v9.9.9", `${RELEASE_PREFIX}tag/v9.9.9`), { redirected: true }), false, null],
      [respond(releaseJson("v9.9.9", `${RELEASE_PREFIX}tag/v9.9.9`), { url: "https://evil.example/api" }), false, null],
      [respond("{not json"), false, null],
      [respond(JSON.stringify({ tag_name: "v9.9.9", draft: false, prerelease: true, html_url: RELEASE_URL })), false, null]
    ];
    for (const [fetchFn, banner, href] of cases) {
      const m = await make(T_MAIN, { fetch: fetchFn });
      const u = uiDriver(m);
      update.check(m.fetchCalls.length === 1 && m.fetchCalls[0].url === GITHUB_API_LATEST && m.fetchCalls[0].init?.credentials === "omit", () => `fetch calls ${excerpt(JSON.stringify(m.fetchCalls), 200)}`);
      update.check(u.hidden("updateBanner") === !banner, () => `banner shown=${!u.hidden("updateBanner")}, expected ${banner}`);
      if (href) {
        update.check(u.must("openUpdateBannerBtn").getAttribute("href") === href && u.must("openReleasePageBtn").getAttribute("href") === href,
          () => `banner href ${u.must("openUpdateBannerBtn").getAttribute("href")} expected ${href}`);
      }
    }
  });

  const paste = slice.criterion("paste-and-sw", "pasting \"1,000\" into an amount gives 1000, a non-number paste is blocked, and the service worker registers ./sw.js with scope ./");
  await guard(paste, "paste", async () => {
    const m = await make(T_MAIN);
    const u = uiDriver(m);
    const pasteInto = async (id, text) => {
      const el = u.must(id);
      const ev = new MockEvent("paste", { bubbles: true, cancelable: true, clipboardData: { getData: () => text } });
      el.dispatchEvent(ev);
      if (!ev.defaultPrevented) {
        el.value = text;
        el.dispatchEvent(new MockEvent("input", { bubbles: true }));
      }
      await m.drain();
      return el.value;
    };
    await u.set("addStart", "2024-01-01");
    paste.check((await pasteInto("addDays", "1,000")) === "1000", "1,000 not sanitised");
    paste.check((await pasteInto("addDays", "abc")) === "1000", "non-number paste not blocked");
    paste.check((await pasteInto("addMonths", "٣")) === "3", "Arabic-Indic paste not normalised");
    paste.check(m.swRegs.length === 1 && m.swRegs[0].url === "./sw.js" && m.swRegs[0].scope === "./", () => `sw ${JSON.stringify(m.swRegs)}`);
  });
}

// ============================================================================
// 14. Slice C: desktop UI over the Rust bridge
// ============================================================================

// Same algorithm as offsetAt() in ui/main.js and mobile/index.html (the
// local offset at the target's wall time), run in this process's TZ.
function offsetAtLocal(dateIso, timeText, nowMs) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!dm) return -new Date(nowMs).getTimezoneOffset();
  const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeText || "");
  const d = new Date(2000, 0, 1, 0, 0, 0, 0);
  d.setFullYear(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
  d.setHours(tm ? Number(tm[1]) : 0, tm ? Number(tm[2]) : 0, tm && tm[3] ? Number(tm[3]) : 0, 0);
  return Math.max(-1080, Math.min(1080, Math.round(-d.getTimezoneOffset())));
}

// BUILD_PLAN §10 slice B at UI level: seeded random inputs per card, typed
// identically into a fresh desktop sandbox (Rust over IPC) and a fresh
// mobile sandbox (JS mirror) at the same virtual clock, compared four ways:
// Rust bridge bytes, mobile raw engine bytes, desktop UI text, mobile UI text.
async function runSeededUiParity(slice, ctx, makeDesktop) {
  const { art, bridge } = ctx;
  const n = ctx.opts.uiCases;
  const crit = slice.criterion("ui-parity-seeded", `${n} seeded random inputs per card (${n * 6} items) entered identically on fresh desktop and mobile sandboxes at the same virtual clock: the Rust bridge and the mobile raw engine answer byte-identically, both UIs render the engine's live and trace text (or the idle/invalid state), and the two UIs render identical result, live and trace text; paired McNemar/Newcombe statistics in stats`);
  await guard(crit, "seeded ui parity", async () => {
    const rng = mulberry32((ctx.opts.seed ^ 0x2545f491) >>> 0);
    const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const chance = (p) => rng() < p;
    const iso = (y, m, d) => `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
    const date = () => {
      const r = rng();
      if (r < 0.03) return pick(["10000-01-01", "0000-01-01", "2023-02-29"]);
      const y = r < 0.75 ? int(1900, 2199) : r < 0.9 ? pick(EDGE_YEARS) : int(1, 9999);
      const m = int(1, 12);
      const last = Oracle.dim(y, m);
      return iso(y, m, chance(0.25) ? pick([1, last, Math.min(29, last)]) : int(1, last));
    };
    const near = (base) => {
      const p = Oracle.parseDate(base);
      if (p.code || chance(0.15)) return date();
      const span = pick([7, 45, 400, 3000, 40000]);
      return Oracle.isoOfDay(Math.min(Oracle.MAX_DAY, Math.max(Oracle.MIN_DAY, p.z + int(-span, span))));
    };
    const amount = () => {
      const r = rng();
      if (r < 0.35) return "";
      if (r < 0.7) return String(int(-40, 40));
      if (r < 0.85) return String(int(-3000, 3000));
      if (r < 0.92) return pick(["9999", "10000", "119988", "-3652058", "3652059", "0"]);
      return pick(["1.5", "1e3", "99999999999999999", "--1", "١٢", "۳"]);
    };
    const time = () => (chance(0.4) ? "" : `${pad2(int(0, 23))}:${pad2(int(0, 59))}${chance(0.3) ? `:${pad2(int(0, 59))}` : ""}`);

    const d = await makeDesktop(T_MAIN);
    const m = await createMobileSandbox(art, { startMs: T_MAIN, seed: ctx.opts.seed });
    const ud = uiDriver(d);
    const um = uiDriver(m);
    const calendar = d.backend.getSettings().calendar;
    const val = (id) => ud.must(id).value.trim();
    const setBox = async (u, id, want) => {
      if (u.must(id).checked !== want) await u.click(id);
    };
    const nowMs = () => Math.floor(d.timers.now / 1000) * 1000;
    const plans = {
      between: {
        gen: () => {
          const a = date();
          return { a, b: near(a), inc: chance(0.3) };
        },
        apply: async (u, x) => {
          await u.set("betweenStart", x.a);
          await u.set("betweenEnd", x.b);
          await setBox(u, "betweenIncludeEnd", x.inc);
        },
        request: (x) => (val("betweenStart") && val("betweenEnd") ? ["calc_days_between", { startDate: val("betweenStart"), endDate: val("betweenEnd"), includeEndDay: x.inc }] : null),
        live: (r) => `→ ${r.summaryText}`
      },
      add: {
        gen: () => ({ date: date(), years: amount(), months: amount(), weeks: amount(), days: amount(), sub: chance(0.35), biz: chance(0.3) }),
        apply: async (u, x) => {
          await u.set("addStart", x.date);
          for (const f of ["years", "months", "weeks", "days"]) await u.type(`add${f[0].toUpperCase()}${f.slice(1)}`, x[f]);
          await u.click(x.sub ? "addModeSubtractBtn" : "addModeAddBtn");
          await setBox(u, "addBusiness", x.biz);
        },
        request: (x) => (val("addStart")
          ? ["calc_add_subtract", { date: val("addStart"), operation: x.sub ? "subtract" : "add", years: val("addYears"), months: val("addMonths"), weeks: val("addWeeks"), days: val("addDays"), businessDays: x.biz, calendar }]
          : null),
        live: (r) => `→ ${r.resultDate} (${r.resultWeekday})`
      },
      business: {
        gen: () => {
          const a = date();
          return { a, b: near(a), inc: chance(0.4) };
        },
        apply: async (u, x) => {
          await u.set("bizStart", x.a);
          await u.set("bizEnd", x.b);
          await setBox(u, "bizIncludeEnd", x.inc);
        },
        request: (x) => (val("bizStart") && val("bizEnd") ? ["calc_business_days", { startDate: val("bizStart"), endDate: val("bizEnd"), includeEndDay: x.inc, calendar }] : null),
        live: (r) => `→ ${r.summaryText}`
      },
      age: {
        gen: () => {
          const birth = chance(0.1) ? iso(int(1904, 2024) & ~3, 2, 29) : date();
          return { birth, asOf: chance(0.35) ? "" : near(birth), mar1: chance(0.4) };
        },
        apply: async (u, x) => {
          await u.set("ageBirth", x.birth);
          await u.set("ageAsOf", x.asOf);
          await u.click(x.mar1 ? "ageLeapMar1Btn" : "ageLeapFeb28Btn");
        },
        request: (x) => (val("ageBirth")
          ? ["calc_age", { birthDate: val("ageBirth"), asOfDate: val("ageAsOf") || localIso(nowMs()), leapDayRule: x.mar1 ? "mar1" : "feb28" }]
          : null),
        live: (r) => `→ ${r.ageText}`
      },
      info: {
        gen: () => ({ date: chance(0.3) ? near(localIso(T_MAIN)) : date() }),
        apply: async (u, x) => {
          await u.set("infoDate", x.date);
        },
        request: () => (val("infoDate") ? ["calc_date_info", { date: val("infoDate"), today: localIso(nowMs()) }] : null),
        live: (r) => `→ ${r.weekday} · ${r.isoWeekText}`
      },
      countdown: {
        gen: () => ({ date: chance(0.6) ? near(localIso(T_MAIN)) : date(), time: time() }),
        apply: async (u, x) => {
          await u.set("cdTarget", x.date);
          await u.set("cdTime", x.time);
        },
        request: () => {
          const target = val("cdTarget");
          if (!target) return null;
          const t = val("cdTime");
          return ["calc_countdown", { now: localMoment(nowMs()), target: { date: target, time: t, utcOffsetMinutes: offsetAtLocal(target, t, nowMs()) } }];
        },
        live: (r) => `→ ${r.text}`
      }
    };

    // [both match, desktop only, mobile only, neither] per comparison.
    const desktopVsMobile = [0, 0, 0, 0];
    const rawVsMobileUi = [0, 0, 0, 0];
    const tally = (cell, baseOk, candOk) => {
      cell[baseOk && candOk ? 0 : baseOk ? 1 : candOk ? 2 : 3]++;
    };
    const perCard = {};
    let idle = 0;
    let invalid = 0;
    for (const [key, plan] of Object.entries(plans)) {
      perCard[key] = 0;
      for (let i = 0; i < n; i++) {
        const x = plan.gen();
        await plan.apply(ud, x);
        await plan.apply(um, x);
        perCard[key]++;
        const label = `${key}#${i} ${excerpt(JSON.stringify(x), 160)}`;
        const sd = ud.snapshot(key);
        const sm = um.snapshot(key);
        crit.check(canonical(sd) === canonical(sm), () => `${label}: desktop ${excerpt(canonical(sd), 200)} | mobile ${excerpt(canonical(sm), 200)}`);
        const call = plan.request(x);
        if (!call) {
          idle++;
          const dOk = sd.live === "→ —";
          const mOk = sm.live === "→ —";
          crit.check(dOk && mOk, () => `${label}: idle expected, desktop "${sd.live}" mobile "${sm.live}"`);
          tally(desktopVsMobile, dOk, mOk);
          tally(rawVsMobileUi, true, mOk);
          continue;
        }
        const [op, req] = call;
        const rust = await bridge.call(op, req);
        const raw = ctx.engine.call(op, req);
        const rawOk = rust === raw;
        crit.check(rawOk, () => `${label}: raw ${firstDiff(rust, raw)}`);
        const v = JSON.parse(rust);
        const want = v.ok === "true" ? { live: plan.live(v.result), trace: expectedTrace(v.result.traceLines) } : { live: "→ invalid", trace: null };
        if (v.ok !== "true") invalid++;
        const match = (s) => s.live === want.live && (want.trace === null || canonical(s.trace) === canonical(want.trace));
        const dOk = match(sd);
        const mOk = match(sm);
        crit.check(dOk, () => `${label}: desktop live "${sd.live}" != "${want.live}" or trace differs (${excerpt(rust, 160)})`);
        crit.check(mOk, () => `${label}: mobile live "${sm.live}" != "${want.live}" or trace differs (${excerpt(raw, 160)})`);
        tally(desktopVsMobile, dOk, mOk);
        tally(rawVsMobileUi, rawOk, mOk);
      }
    }
    crit.check(d.timers.now === T_MAIN && m.timers.now === T_MAIN, () => `virtual clocks moved: desktop ${d.timers.now}, mobile ${m.timers.now}`);
    crit.check(d.errors.length === 0 && d.doc._errors.length === 0 && m.errors.length === 0 && m.doc._errors.length === 0,
      () => `errors: ${excerpt([...d.errors, ...d.doc._errors, ...m.errors, ...m.doc._errors].join(" | "), 400)}`);
    crit.check(d.doc._violations.length === 0 && m.doc._violations.length === 0, () => `violations: ${[...d.doc._violations, ...m.doc._violations].join(" | ")}`);
    const p1 = newcombePairedCi(...desktopVsMobile);
    const p2 = newcombePairedCi(...rawVsMobileUi);
    const [h1, h2] = holmBonferroni([p1.mcnemar_p, p2.mcnemar_p]);
    crit.stats = {
      items: perCard,
      idleItems: idle,
      invalidItems: invalid,
      paired: {
        desktopUiVsMobileUi: { ...p1, holm_p: h1, base: "desktop UI matches Rust", candidate: "mobile UI matches Rust" },
        mobileRawVsMobileUi: { ...p2, holm_p: h2, base: "mobile raw engine bytes equal Rust", candidate: "mobile UI matches Rust" }
      }
    };
    crit.note(`items per card: ${JSON.stringify(perCard)}; idle ${idle}, engine errors rendered as invalid ${invalid}; McNemar p (Holm): desktop vs mobile UI ${h1}, mobile raw vs mobile UI ${h2}`);
  });
}

async function runSliceC(slice, ctx) {
  const { art, bridge } = ctx;
  const make = (startMs, extra = {}) => createDesktopSandbox(art, bridge, { startMs, seed: ctx.opts.seed, ...extra });
  const sb = await make(T_MAIN);
  const snaps = await runUiSuite(slice, sb, ctx);
  await runClockSuite(slice, make, ctx);
  await runV110Suite(slice, ctx, make, "desktop");
  await runV120Suite(slice, ctx, make, "desktop");

  const ipc = slice.criterion("ipc-routing", "every invoke is a registered Tauri command, every engine command reached the Rust bridge as {req}, and nothing fell back to JS math");
  await guard(ipc, "ipc", async () => {
    const st = sb.backend.state;
    ipc.check(st.unknown.length === 0, () => `unknown commands: ${st.unknown}`);
    ipc.check(st.calls.every((c) => DESKTOP_COMMANDS.has(c)), "unregistered command");
    ipc.check(st.bridgeCalls > 20, () => `only ${st.bridgeCalls} engine calls`);
    ipc.check(st.calls.includes("check_for_updates"), "startup update check not requested via IPC");
    ipc.check(st.calls.includes("countdown_load") && st.calls.includes("history_state"), "the launch did not ask for the saved countdown and the history state over IPC");
    ipc.check(st.calls.includes("layout_load"), "the launch did not ask for the saved card layout over IPC");
  });

  const cross = slice.criterion("cross-surface-text", "for the same inputs and virtual clock, the desktop (Rust over IPC) and mobile (JS mirror) cards render identical result, live and trace text");
  await guard(cross, "cross surface", async () => {
    const mobile = ctx.mobileSnaps || {};
    cross.check(Object.keys(snaps).length === 6, () => `desktop snapshots: ${Object.keys(snaps)}`);
    for (const [key, d] of Object.entries(snaps)) {
      const m = mobile[key];
      cross.check(Boolean(m), `${key}: no mobile snapshot`);
      if (!m) continue;
      cross.check(d.result === m.result, () => `${key} result: desktop "${excerpt(d.result, 160)}" mobile "${excerpt(m.result, 160)}"`);
      cross.check(d.live === m.live, () => `${key} live: ${d.live} / ${m.live}`);
      cross.check(canonical(d.trace) === canonical(m.trace), () => `${key} trace differs`);
    }
  });

  await runSeededUiParity(slice, ctx, make);

  const race = slice.criterion("ipc-race", "a slow engine reply for an older keystroke never overwrites the newer result (per-card sequence guard), and a slow reply after clear leaves the card idle");
  await guard(race, "race", async () => {
    const d = await make(T_MAIN);
    const u = uiDriver(d);
    await u.type("betweenStart", "2024-01-01");
    d.backend.holdNext((cmd, args) => cmd === "calc_days_between" && args?.req?.endDate === "2024-02-01");
    await u.type("betweenEnd", "2024-02-01");
    race.check(d.backend.state.held.length === 1, "first reply was not held");
    await u.type("betweenEnd", "2024-03-01");
    race.check(u.text("betweenLiveResult") === "→ 60 days", () => `newer result ${u.text("betweenLiveResult")}`);
    d.backend.release(0);
    await d.drain();
    race.check(u.text("betweenLiveResult") === "→ 60 days", () => `stale reply overwrote: ${u.text("betweenLiveResult")}`);
    d.backend.holdNext((cmd, args) => cmd === "calc_days_between" && args?.req?.endDate === "2024-04-01");
    await u.type("betweenEnd", "2024-04-01");
    await u.click("resetBetweenBtn");
    d.backend.release(0);
    await d.drain();
    race.check(u.text("betweenLiveResult") === "→ —" && u.text("betweenResult") === "=—", () => `reply after clear: ${u.text("betweenLiveResult")}`);
  });

  const revert = slice.criterion("settings-failure-revert", "a failed set_settings shows the error, keeps the previously saved weekend selected and saved, and the next attempt succeeds; a later history restore recomputes with the new calendar");
  await guard(revert, "revert", async () => {
    const d = await make(T_MAIN);
    const u = uiDriver(d);
    await u.set("bizStart", "2024-12-23");
    await u.set("bizEnd", "2025-01-03");
    await u.enter("bizEnd");
    d.backend.state.failSetSettings = 1;
    await u.click("weekendFriSatBtn");
    revert.check(!u.hidden("weekendError") && u.text("weekendError").includes("injected failure"), () => `error "${u.text("weekendError")}"`);
    revert.check(canonical(d.backend.getSettings().calendar.weekend) === "[6,7]" && u.must("weekendSatSunBtn").getAttribute("aria-pressed") === "true", "failed save changed the weekend");
    await u.click("weekendFriSatBtn");
    revert.check(canonical(d.backend.getSettings().calendar.weekend) === "[5,6]" && u.hidden("weekendError"), "retry did not save");
    await u.click("resetBizBtn");
    await u.clickEl(u.must("historyList").querySelector(".history-restore-btn"));
    const r = await bridge.result("calc_business_days", { startDate: "2024-12-23", endDate: "2025-01-03", includeEndDay: false, calendar: d.backend.getSettings().calendar });
    revert.check(u.text("bizLiveResult") === `→ ${r.summaryText}`, () => `restored with new calendar: ${u.text("bizLiveResult")} vs ${r.summaryText}`);
  });

  const smoke = slice.criterion("desktop-smoke-test", "the desktop's own in-page smoke test (ui/main.js, fixed clock 2026-11-16 10:00 UTC+2, in-memory history/settings) passes inside the sandbox against the Rust bridge");
  await guard(smoke, "smoke", async () => {
    const d = await make(Date.UTC(2026, 10, 16, 8, 0, 0), { smoke: true });
    const result = await withTimeout(d.runUntil(d.backend.state.smokeDone), 120000, "desktop smoke test");
    smoke.check(result.passed === true, () => `smoke failures: ${result.details}`);
    smoke.check(d.doc._violations.length === 0, () => `violations: ${d.doc._violations.join(" | ")}`);
    smoke.check(d.backend.state.copied.includes("date-tool-smoke-test"), "smoke copy_text not seen");
  });
}

// ============================================================================
// 15. Slice D: static hygiene
// ============================================================================

// --- Workflow hygiene (FROZEN §14). A line-based reading of the workflow
// YAML, with no dependency: enough structure (steps, jobs, top-level keys) to
// check pins, checkouts, the inline node blocks and the release gate. Every
// check is pure (files in, problems out) so it can also be run on planted
// mutants of the real files, which must each produce a problem.

const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const REQUIRED_WORKFLOWS = ["build.yml", "pages.yml"];
const RELEASE_GATE = "github.event_name == 'push' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v'))";
const MIN_NODE_BLOCKS = 3;

function loadWorkflows(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8").replace(/\r\n?/g, "\n") }));
}

const yamlIndent = (line) => line.length - line.trimStart().length;
// Blank or comment-only lines carry no structure.
const yamlBlank = (line) => /^\s*(?:#.*)?$/.test(line);

// Every item of every `steps:` sequence, with its source lines dedented to
// the item's dash (block-scalar bodies included verbatim).
function workflowSteps(file) {
  const lines = file.text.split("\n");
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)steps:\s*(?:#.*)?$/);
    if (!m) continue;
    const base = m[1].length;
    let dashIndent = -1;
    let cur = null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (yamlBlank(line)) {
        if (cur) cur.lines.push(line);
        continue;
      }
      const ind = yamlIndent(line);
      const dash = /^\s*-(?:\s|$)/.test(line);
      if (ind < base || (ind === base && !dash)) break;
      if (dash && (dashIndent < 0 || ind === dashIndent)) {
        if (dashIndent < 0) dashIndent = ind;
        cur = { file: file.name, line: j + 1, indent: ind, lines: [line] };
        steps.push(cur);
      } else if (cur) {
        cur.lines.push(line);
      } else {
        break;
      }
    }
    i = j - 1;
  }
  for (const s of steps) {
    while (s.lines.length > 1 && yamlBlank(s.lines[s.lines.length - 1])) s.lines.pop();
    s.text = s.lines.map((l) => l.slice(Math.min(s.indent, yamlIndent(l)))).join("\n");
  }
  return steps;
}

// The scalar value or the indented child block of a `key:` at `indent`.
function yamlEntry(lines, key, indent) {
  const re = new RegExp(`^ {${indent}}${key}:(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const value = m[1].replace(/\s+#.*$/, "").trim();
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (yamlBlank(lines[j])) continue;
      if (yamlIndent(lines[j]) <= indent) break;
      block.push(lines[j].trim());
    }
    return { value, block };
  }
  return null;
}

// Jobs under the top-level `jobs:` key, with their own property indent.
function workflowJobs(file) {
  const lines = file.text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*(?:#.*)?$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  let jobIndent = -1;
  let cur = null;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    if (yamlBlank(line)) {
      if (cur) cur.lines.push(line);
      continue;
    }
    const ind = yamlIndent(line);
    if (ind === 0) break;
    if (jobIndent < 0) jobIndent = ind;
    const key = ind === jobIndent ? line.match(/^\s*([A-Za-z0-9_-]+):\s*(?:#.*)?$/) : null;
    if (key) {
      cur = { file: file.name, id: key[1], line: j + 1, lines: [] };
      jobs.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  for (const job of jobs) {
    const first = job.lines.find((l) => !yamlBlank(l));
    job.propIndent = first ? yamlIndent(first) : jobIndent + 2;
    job.text = job.lines.join("\n");
  }
  return jobs;
}

function normalizeIf(value) {
  let v = String(value ?? "").trim();
  if (/^(["']).*\1$/.test(v) && v.length >= 2) v = v.slice(1, -1);
  const expr = v.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (expr) v = expr[1];
  return v.replace(/\s+/g, " ").trim();
}

// D.workflow-pins: every `uses:` is owner/repo[/path]@<40-hex SHA> # comment.
function checkWorkflowPins(files) {
  const problems = [];
  let count = 0;
  for (const f of files) {
    f.text.split("\n").forEach((line, i) => {
      const m = line.match(/^\s*(?:-\s+)?uses:\s*(.*)$/);
      if (!m) return;
      count++;
      const where = `${f.name}:${i + 1}`;
      const parts = m[1].match(/^(["']?)([^\s"'#]+)\1(?:\s+#\s*(\S.*?))?\s*$/);
      if (!parts) {
        problems.push(`${where}: unparsable uses: ${m[1]}`);
        return;
      }
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(parts[2])) {
        problems.push(`${where}: ${parts[2]} is not pinned to a full 40-hex commit SHA`);
      }
      if (!parts[3]) problems.push(`${where}: ${parts[2]} has no version comment`);
    });
  }
  if (count === 0) problems.push("no uses: lines found");
  return { problems, count };
}

// D.workflow-persist-credentials: every actions/checkout step sets
// `persist-credentials: false` under `with:`, and no other value.
function checkWorkflowCheckouts(files) {
  const problems = [];
  let count = 0;
  let raw = 0;
  for (const f of files) {
    raw += (f.text.match(/^\s*(?:-\s+)?uses:\s*["']?actions\/checkout@/gim) || []).length;
    for (const s of workflowSteps(f)) {
      const uses = s.text.match(/^(?:-\s+|\s*)uses:\s*["']?([^\s"'#@]+)@/m);
      if (!uses || uses[1].toLowerCase() !== "actions/checkout") continue;
      count++;
      const where = `${s.file}:${s.line}`;
      const withLine = s.text.match(/^( *)with:\s*(?:#.*)?$/m);
      const settings = [...s.text.matchAll(/^( *)persist-credentials:\s*(.*?)\s*(?:#.*)?$/gm)];
      if (!withLine || settings.length !== 1) {
        problems.push(`${where}: actions/checkout needs exactly one persist-credentials under with: (found ${settings.length})`);
        continue;
      }
      if (!/^(?:false|'false'|"false")$/.test(settings[0][2])) {
        problems.push(`${where}: actions/checkout has persist-credentials: ${settings[0][2]}`);
      }
      if (settings[0][1].length <= withLine[1].length) problems.push(`${where}: persist-credentials is not under with:`);
    }
  }
  if (raw !== count) problems.push(`found ${raw} actions/checkout uses: lines but ${count} inside parsed steps`);
  if (count === 0) problems.push("no actions/checkout steps found");
  return { problems, count };
}

// D.workflow-node-block-identical: every step that runs inline node code
// (`node -`, `node -e`, `node -p`) is byte-identical, name and shell included,
// and the block appears in build.yml and pages.yml.
function checkNodeBlocks(files) {
  const problems = [];
  const blocks = [];
  for (const f of files) {
    for (const s of workflowSteps(f)) {
      if (/^\s*node\s+(?:-|-e|--eval|-p|--print)(?:\s|$)/m.test(s.text)) blocks.push(s);
    }
  }
  for (const name of REQUIRED_WORKFLOWS) {
    if (!blocks.some((b) => b.file === name)) problems.push(`${name} has no inline node block`);
  }
  if (blocks.length < MIN_NODE_BLOCKS) problems.push(`expected at least ${MIN_NODE_BLOCKS} copies of the inline node block, found ${blocks.length}`);
  const ref = blocks[0];
  for (const b of blocks.slice(1)) {
    if (b.text === ref.text) continue;
    const a = ref.text.split("\n");
    const c = b.text.split("\n");
    let k = 0;
    while (k < a.length && k < c.length && a[k] === c[k]) k++;
    problems.push(`${b.file}:${b.line + k} differs from ${ref.file}:${ref.line + k}: ${JSON.stringify((c[k] ?? "<end>").trimStart()).slice(0, 160)} vs ${JSON.stringify((a[k] ?? "<end>").trimStart()).slice(0, 160)}`);
  }
  return { problems, count: blocks.length, sha256: ref ? sha256Text(ref.text) : null, places: blocks.map((b) => `${b.file}:${b.line}`) };
}

// D.workflow-release-gate: only a job gated on push to main or a v* tag may
// write contents or run `gh release`; workflow-level permissions never grant
// contents: write; build.yml has exactly such a release job.
function checkReleaseGate(files) {
  const problems = [];
  let gated = 0;
  for (const f of files) {
    const top = f.text.split("\n");
    const wfPerm = yamlEntry(top, "permissions", 0);
    if (wfPerm === null) problems.push(`${f.name}: no workflow-level permissions block`);
    else if (/write/.test(wfPerm.value) || wfPerm.block.some((l) => /^contents:\s*write\b/.test(l))) {
      problems.push(`${f.name}: workflow-level permissions grant ${wfPerm.value || wfPerm.block.join(", ")}`);
    }
    for (const job of workflowJobs(f)) {
      const perm = yamlEntry(job.lines, "permissions", job.propIndent);
      const releases = /\bgh\s+release\s+(?:create|upload|edit|delete)\b/.test(job.text);
      const writes = (perm !== null && (/write/.test(perm.value) || perm.block.some((l) => /^contents:\s*write\b/.test(l)))) || releases;
      if (!writes) continue;
      const cond = yamlEntry(job.lines, "if", job.propIndent);
      const where = `${f.name}:${job.line} (${job.id})`;
      if (cond === null) problems.push(`${where}: writes contents or publishes releases without an if: gate`);
      else if (normalizeIf(cond.value) !== RELEASE_GATE) problems.push(`${where}: if: ${cond.value} is not the push-to-main / v* tag gate`);
      else if (f.name === "build.yml") gated++;
    }
  }
  if (gated !== 1) problems.push(`build.yml should have exactly one gated release job, found ${gated}`);
  return { problems, gated };
}

// Replaces the first match in one workflow; a mutant that does not apply is
// itself a failure (the self-test would otherwise be vacuous).
function plantMutant(files, name, from, to) {
  const target = files.find((f) => f.name === name);
  if (!target) return null;
  const text = target.text.replace(from, to);
  if (text === target.text) return null;
  return files.map((f) => (f === target ? { name: f.name, text } : f));
}

function workflowCriterion(crit, files, check, mutants) {
  for (const name of REQUIRED_WORKFLOWS) crit.check(files.some((f) => f.name === name), `.github/workflows/${name} is missing`);
  const real = check(files);
  crit.check(real.problems.length === 0, () => real.problems.slice(0, 6).join(" | "));
  for (const p of real.problems.slice(6)) crit.note(p);
  let caught = 0;
  for (const [label, file, from, to] of mutants) {
    const planted = plantMutant(files, file, from, to);
    if (!crit.check(planted !== null, `planted mutant "${label}" did not apply to ${file}`)) continue;
    if (crit.check(check(planted).problems.length > 0, `planted mutant "${label}" in ${file} was not detected`)) caught++;
  }
  crit.note(`planted mutants detected: ${caught}/${mutants.length}`);
  return real;
}

// Same as workflowCriterion, over a {name: text} map of any files.
function textCriterion(crit, files, check, mutants) {
  const real = check(files);
  crit.check(real.problems.length === 0, () => real.problems.slice(0, 6).join(" | "));
  let caught = 0;
  for (const [label, name, from, to] of mutants) {
    const text = files[name];
    const planted = typeof text === "string" ? text.replace(from, to) : text;
    if (!crit.check(typeof text === "string" && planted !== text, `planted mutant "${label}" did not apply to ${name}`)) continue;
    if (crit.check(check({ ...files, [name]: planted }).problems.length > 0, `planted mutant "${label}" in ${name} was not detected`)) caught++;
  }
  crit.note(`planted mutants detected: ${caught}/${mutants.length}`);
  return real;
}

// --- Plan A4: the app and the engine are versioned separately. The app
// version is locked across every app file; the engine version (date-core,
// ENGINE_VERSION, the golden header, the mobile marker) stays put.
function readHead(rel, bytes = 4096) {
  const fd = openSync(join(ROOT, rel), "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function versionSplitProblems(f) {
  const problems = [];
  const want = (ok, msg) => {
    if (!ok) problems.push(msg);
  };
  let conf = null;
  try {
    conf = JSON.parse(f.tauriConf);
  } catch {
    conf = null;
  }
  const pkgVer = (toml) => /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  const lockVer = (name) => new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`).exec(f.cargoLock)?.[1];
  want(conf?.version === APP_VERSION, `tauri.conf.json version ${conf?.version} != app ${APP_VERSION}`);
  want(pkgVer(f.appCargo) === APP_VERSION, `src-tauri/Cargo.toml version ${pkgVer(f.appCargo)} != app ${APP_VERSION}`);
  want(lockVer("date-calculator-tool") === APP_VERSION, `Cargo.lock date-calculator-tool ${lockVer("date-calculator-tool")} != app ${APP_VERSION}`);
  want(/const APP_VERSION = "([^"]+)";/.exec(f.mobileHtml)?.[1] === APP_VERSION, "mobile APP_VERSION is not the app version");
  want(f.mobileHtml.includes(`<span id="appVersion">Mobile &amp; Web v${APP_VERSION}</span>`), "mobile footer is not the app version");
  want(/const CACHE_NAME = "date-tool-v([^"]+?)-mobile-\d+";/.exec(f.swJs)?.[1] === APP_VERSION, "sw.js CACHE_NAME is not the app version");
  want(f.uiHtml.includes(`<span id="appVersion">Desktop v${APP_VERSION}</span>`), "desktop footer is not the app version");
  want(pkgVer(f.engineCargo) === ENGINE_VERSION, `crates/date-core/Cargo.toml version ${pkgVer(f.engineCargo)} != engine ${ENGINE_VERSION}`);
  want(lockVer("date-core") === ENGINE_VERSION, `Cargo.lock date-core ${lockVer("date-core")} != engine ${ENGINE_VERSION}`);
  want(/pub const ENGINE_VERSION: &str = "([^"]+)";/.exec(f.libRs)?.[1] === ENGINE_VERSION, "lib.rs ENGINE_VERSION is not the engine version");
  want(/"engine":"([^"]+)"/.exec(f.goldenHead)?.[1] === ENGINE_VERSION, "golden.json header engine is not the engine version");
  want(f.mobileHtml.split(`/* date-core:begin v${ENGINE_VERSION} */`).length === 2, "the mobile engine marker does not name the engine version exactly once");
  want(/const EXPECTED_ENGINE_VERSION: &str = "([^"]+)";/.exec(f.commandsRs)?.[1] === ENGINE_VERSION, "commands.rs EXPECTED_ENGINE_VERSION is not the engine version");
  want(/assert_eq!\(date_core::ENGINE_VERSION, EXPECTED_ENGINE_VERSION\)/.test(f.commandsRs), "commands.rs does not assert ENGINE_VERSION == EXPECTED_ENGINE_VERSION");
  want(!/assert_eq!\(\s*date_core::ENGINE_VERSION\s*,\s*env!\("CARGO_PKG_VERSION"\)\s*\)/.test(f.commandsRs), "commands.rs still locks the engine to the app's CARGO_PKG_VERSION");
  return { problems };
}

// --- Plan A1: out-of-month cells stay readable (WCAG AA 4.5:1); only
// disabled (out-of-range) cells keep the dim look.
function hexRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function relLuminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a, b) {
  const [x, y] = [relLuminance(a), relLuminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function cssRules(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(",").map((s) => s.trim()), body: m[2] }));
}
function outCellProblems(files) {
  const problems = [];
  for (const [name, css] of Object.entries(files)) {
    const rules = cssRules(css);
    const out = rules.find((r) => r.selectors.includes(".mini-cal-cell.out"));
    if (!out) {
      problems.push(`${name}: no .mini-cal-cell.out rule`);
      continue;
    }
    const color = /(?:^|;|\s)color\s*:\s*(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)\b/.exec(out.body)?.[1];
    if (!color) {
      problems.push(`${name}: .mini-cal-cell.out sets no hex color`);
      continue;
    }
    const section = rules.find((r) => r.selectors.includes(".calc-section"))?.body.match(/background\s*:\s*(#[0-9a-fA-F]{6})/)?.[1] || "#161822";
    const restored = rules.find((r) => r.selectors.includes(".calc-section.card-restored"))?.body.match(/background\s*:\s*(#[0-9a-fA-F]{6})/)?.[1] || "#1b202d";
    const backs = [["page #0E0F12", hexRgb("#0E0F12")], [`card ${section}`, hexRgb(section)], [`restored card ${restored}`, hexRgb(restored)]];
    const tint = rules.find((r) => r.selectors.includes(".mini-cal-cell.out.in-range"))?.body.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
    if (tint) {
      const a = Number(tint[4]);
      const base = hexRgb(section);
      backs.push([`in-range tint on ${section}`, [1, 2, 3].map((i, k) => Math.round(Number(tint[i]) * a + base[k] * (1 - a)))]);
    }
    for (const [label, bg] of backs) {
      const ratio = contrastRatio(hexRgb(color), bg);
      if (ratio < 4.5) problems.push(`${name}: out-of-month ${color} on ${label} is ${ratio.toFixed(2)}:1 (< 4.5:1)`);
    }
    for (const r of rules) {
      if (r.selectors.some((s) => /\.out(?![\w-])/.test(s)) && /(?:^|;|\s)opacity\s*:/.test(r.body)) problems.push(`${name}: ${r.selectors.join(", ")} dims out-of-month cells with opacity`);
    }
    const dim = rules.find((r) => r.selectors.includes(".mini-cal-cell:disabled"));
    if (!dim || !/opacity\s*:\s*0?\.25\b/.test(dim.body)) problems.push(`${name}: disabled cells lost the dim look`);
  }
  return { problems };
}

// --- Phone first: on a coarse pointer every v1.1.0 control is at least
// 44 px tall (day cells, the pick toggle, the month/Today buttons, Forget,
// and the history banner's retry / start-a-new-history buttons).
// v1.2.0 (plan A8) adds the card handle and collapse button.
const TOUCH_SELECTORS = [".mini-cal-cell", ".cal-pick-opt", ".mini-cal-nav", ".link-btn", ".calc-btn", ".reset-btn", ".drag-handle", ".collapse-btn", ".card-move-btn"];
function mediaBlock(css, query) {
  const start = css.indexOf(`@media ${query} {`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  return null;
}
function touchTargetProblems(files) {
  const problems = [];
  for (const [name, css] of Object.entries(files)) {
    const block = mediaBlock(css.replace(/\/\*[\s\S]*?\*\//g, ""), "(pointer: coarse)");
    if (block === null) {
      problems.push(`${name}: no @media (pointer: coarse) block`);
      continue;
    }
    const rules = cssRules(block);
    for (const sel of TOUCH_SELECTORS) {
      const ok = rules.some((r) => r.selectors.includes(sel) && /min-height\s*:\s*(?:4[4-9]|[5-9]\d)px/.test(r.body));
      if (!ok) problems.push(`${name}: ${sel} has no min-height of at least 44px on a coarse pointer`);
    }
  }
  return { problems };
}

// --- Plan A8, phone first: the card layout is CSS classes only, so its
// look lives in the stylesheets. The handle alone has touch-action: none
// (the page still scrolls everywhere else), a collapsed card hides only its
// body, the drop line is gold before or after the card, the handle and the
// collapse button are 44x44 on a coarse pointer, and reduced motion turns
// their transitions off.
function layoutCssProblems(files) {
  const problems = [];
  for (const [name, raw] of Object.entries(files)) {
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const top = cssRules(css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ""));
    const has = (rules, sel, re) => rules.some((r) => r.selectors.includes(sel) && re.test(r.body));
    if (!has(top, ".drag-handle", /touch-action\s*:\s*none/)) problems.push(`${name}: .drag-handle lacks touch-action: none`);
    const touchNone = top.filter((r) => /touch-action\s*:\s*none/.test(r.body)).flatMap((r) => r.selectors);
    if (touchNone.some((s) => s !== ".drag-handle")) problems.push(`${name}: touch-action: none outside the handle (${touchNone.join(", ")})`);
    if (!has(top, ".calc-section.card-collapsed .calc-card-body", /display\s*:\s*none/)) problems.push(`${name}: a collapsed card does not hide its body`);
    if (top.some((r) => r.selectors.some((s) => /\.card-collapsed(?![\w-])/.test(s) && !/\.calc-card-body|\.calc-card-header|\.section-(?:title|subtitle)/.test(s)) && /display\s*:\s*none/.test(r.body))) problems.push(`${name}: a collapsed card hides more than its body`);
    for (const sel of [".calc-section.card-drop-before", ".calc-section.card-drop-after"]) {
      if (!has(top, sel, /#E9A715/i)) problems.push(`${name}: ${sel} is not a gold line`);
    }
    if (!top.some((r) => r.selectors.includes(".calc-section.card-dragging"))) problems.push(`${name}: no .card-dragging look`);
    const coarse = mediaBlock(css, "(pointer: coarse)");
    const coarseRules = coarse === null ? [] : cssRules(coarse);
    for (const sel of [".drag-handle", ".collapse-btn"]) {
      if (!has(coarseRules, sel, /min-width\s*:\s*(?:4[4-9]|[5-9]\d)px/) || !has(coarseRules, sel, /min-height\s*:\s*(?:4[4-9]|[5-9]\d)px/)) problems.push(`${name}: ${sel} is not 44x44 on a coarse pointer`);
    }
    const reduced = mediaBlock(css, "(prefers-reduced-motion: reduce)");
    const reducedRules = reduced === null ? [] : cssRules(reduced);
    for (const sel of [".drag-handle", ".collapse-btn"]) {
      if (!has(reducedRules, sel, /transition\s*:\s*none/)) problems.push(`${name}: ${sel} keeps its transition under reduced motion`);
    }
  }
  return { problems };
}

// --- Plan A6 slice D: the v1.1.0 probes must catch planted page mutants.
function mutantArtifacts(art, surface, from, to) {
  if (surface === "mobile") {
    const script = art.mobileHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
    const text = script.replace(from, to);
    return text === script ? null : { ...art, mobileScript: new vm.Script(text, { filename: "mobile/index.html:inline-script (mutant)" }) };
  }
  const text = art.uiMain.replace(from, to);
  return text === art.uiMain ? null : { ...art, desktopScript: new vm.Script(text, { filename: "ui/main.js (mutant)" }) };
}
const BOTH = ["mobile", "desktop"];
const UI_MUTANTS = [
  ["calendar cells as <span>", BOTH, 'const el = document.createElement("button");', 'const el = document.createElement("span");', probeCalendarClickInfo],
  ["every cell a tab stop", BOTH, 'n.setAttribute("tabindex", n === node ? "0" : "-1");', 'n.setAttribute("tabindex", "0");', probeCalendarKeyboard],
  ["launch restore call deleted", BOTH, /(await refreshCalendarInfo\(\);[\s\S]*?)await restoreSavedCountdown\(\);/, "$1", probeCountdownRestoreFuture],
  ["countdown saved on input", BOTH, 'addEventListener("change", () => persistCountdown());', 'addEventListener("input", () => persistCountdown());', probeCountdownNoWriteOnTick],
  ["an empty field clears the record", BOTH, "if (!pair) return cdWriteChain;", "if (!pair) return forgetCountdown();", probeCountdownEmptySegment],
  ["savedAtMs used as the finished signal", BOTH, "cdStored.finishedSeenAtMs === null;", "cdStored.savedAtMs < Date.now();", probeCountdownFinishedOpenThenClosed],
  ["finishedSeenAtMs written on every tick", BOTH, "if (cdStoreBlocked || !cdStored || cdStored.finishedSeenAtMs !== null) return;", "if (cdStoreBlocked || !cdStored) return;", probeCountdownNoWriteOnTick],
  ["Forget does not clear the store", BOTH, /return queueCountdownWrite\(\(\) => (?:invoke\("countdown_clear"\)|countdownClear\(\))\)\.then\(/, "return cdWriteChain.then(", probeCountdownForget],
  ["Business Days pick never toggles", BOTH, 'setBizPickTarget(target === "end" ? "start" : "end");', "setBizPickTarget(target);", probeBizRangePick],
  ["unreadable history loads as empty and writable", ["mobile"], "historyReadOnlyState = readOnly;", "historyReadOnlyState = null;", probeHistoryReadOnly],
  ["read-only banner never shown", BOTH, 'banner?.classList.toggle("hidden", !historyReadOnly);', 'banner?.classList.toggle("hidden", true);', probeHistoryReadOnly],
  ["other-tab countdown sync removed", ["mobile"], /\n\s*syncCountdownFromStorage\(\);\n/, "\n", probeCountdownStorageEvent],
  ["restored chip kept on every tick", BOTH, 'else if (restoreRender) phase = "restored";', 'else if (restoredNow) phase = "restored";', probeCountdownRestoreFuture],
  ["saved note shown even when the save fails", BOTH, /if \(cdStored === state\) \{\n\s*cdStored = previous\.stored;\n\s*cdLoadStatus = previous\.status;\n\s*\}\n\s*onCountdownWriteFailed\(err\);/, "renderCountdownNote();", probeCountdownBadRecords],
  ["clear all forgets the saved countdown", BOTH, "resetCard(key, { forget: false })", "resetCard(key)", probeCountdownReset],
  ["new-history reset drops a value that is not backed up", ["mobile"], "if (kept !== raw) {", "if (kept === null) {", probeHistoryReadOnly],
  // v1.2.0 card layout (plan A8).
  ["collapse not saved", BOTH, "  if (!collapsed) onCardExpanded(key);\n  if (save) saveLayout();\n", "  if (!collapsed) onCardExpanded(key);\n", probeLayoutCollapsePersist],
  ["quick-nav not synced with the card order", BOTH, "  syncQuickNav(state.cardOrder);\n", "", probeLayoutNavFollowsOrder],
  ["reset leaves a card collapsed", BOTH, /(finishCardDrag\(true\);\n\s*)layoutState = defaultLayout\(\);/, "$1layoutState = { ...defaultLayout(), collapsedCards: layoutState.collapsedCards.slice(0, 1) };", probeLayoutReset],
  [".style set during a drag", ["mobile"], 'cardDrag.card.classList.add("card-dragging");', 'cardDrag.card.classList.add("card-dragging");\n      cardDrag.card.style.opacity = "0.55";', probeLayoutPointerReorder],
  ["localStorage.clear() used by the layout reset", ["mobile"], "function layoutReset() {\n", "function layoutReset() {\n  storageArea()?.clear();\n", probeLayoutReset],
  ["keyboard move drops focus", BOTH, "  if (handle && document.activeElement !== handle) handle.focus({ preventScroll: true });\n", "", probeLayoutKeyboardReorder],
  ["history restore keeps its card collapsed", BOTH, "  // A collapsed card opens for the restore (and that is saved).\n  expandCard(key);\n", "", probeLayoutOpenExpands],
  ["drop target ignores the after half", BOTH, "cardDrag.after = y >= (target.rect.top + target.rect.bottom) / 2;", "cardDrag.after = false;", probeLayoutPointerReorder],
  ["a newer layout record is not blocked at launch", ["desktop"], /(if \(status === "newer" \|\| status === "unreadable"\) \{\n\s*layoutLoadStatus = status;\n\s*)layoutStoreBlocked = true;/, "$1layoutStoreBlocked = false;", probeLayoutBadRecords],
  ["mobile layout store writes over a newer record", ["mobile"], '  if (storedLayoutIsNewer()) throw new Error("layout_newer_schema");\n', "", probeLayoutBadRecords],
  ["other-tab layout sync removed", ["mobile"], /\n\s*syncLayoutFromStorage\(\);\n/, "\n", probeLayoutStorageEvent],
  ["other-tab layout applied mid-drag", ["mobile"], "function syncLayoutFromStorage() {\n  if (cardDrag) return;\n", "function syncLayoutFromStorage() {\n", probeLayoutStorageEvent],
  // v1.2.0 review fixes: touch safety, drop focus, the move menu.
  ["a touch drag starts at 4 px", BOTH, 'const threshold = cardDrag.pointerType === "mouse" ? DRAG_START_PX : DRAG_START_TOUCH_PX;', "const threshold = DRAG_START_PX;", probeLayoutTouchSafety],
  ["edge auto-scroll armed at once", BOTH, "const DRAG_EDGE_ARM_PX = 24;", "const DRAG_EDGE_ARM_PX = 0;", probeLayoutTouchSafety],
  ["a pointer drop drops focus", BOTH, "  if (hadFocus) {\n", "  if (false) {\n", probeLayoutTouchSafety],
  ["a handle tap opens no move menu", BOTH, "else openCardMoveMenu(key);", "else return;", probeLayoutMoveMenu],
  ["the click ending a drag opens the move menu", BOTH, "  if (drag.moved) cardDragClickGuard = drag.handle;\n", "", probeLayoutMoveMenu],
  ["a menu move drops focus", BOTH, "  if (focusEl?.isConnected && document.activeElement !== focusEl) focusEl.focus({ preventScroll: true });\n", "", probeLayoutMoveMenu]
];

async function runUiMutants(crit, ctx) {
  if (!ctx.defaultCalendar) {
    crit.fail("the Rust bridge is needed for the probes' expected values");
    return;
  }
  let caught = 0;
  let planted = 0;
  const seen = [];
  for (const [label, surfaces, from, to, probe] of UI_MUTANTS) {
    for (const surface of surfaces) {
      const art = mutantArtifacts(ctx.art, surface, from, to);
      if (!crit.check(art !== null, `planted mutant "${label}" did not apply to the ${surface} page`)) continue;
      planted++;
      const make = surface === "mobile"
        ? (startMs, extra = {}) => createMobileSandbox(art, { startMs, seed: ctx.opts.seed, ...extra })
        : (startMs, extra = {}) => createDesktopSandbox(art, ctx.bridge, { startMs, seed: ctx.opts.seed, ...extra });
      const col = new Collector();
      try {
        await probe({ make, ctx, surface }, col);
      } catch (err) {
        col.fail(`threw ${err && err.message}`);
      }
      if (crit.check(col.problems.length > 0, `planted mutant "${label}" on ${surface} was not detected by ${probe.name}`)) {
        caught++;
        seen.push(`${surface} "${label}" → ${probe.name}: ${excerpt(col.problems[0], 100)}`);
      }
    }
  }
  crit.note(`planted page mutants detected: ${caught}/${planted}`);
  crit.note(seen.join(" ; "));
}

async function runSliceD(slice, ctx) {
  const cm = slice.criterion("check-mobile", "scripts/check-mobile.mjs passes: engine Date/Intl/clock bans, CSP hashes and directives (no frame-ancestors), LF/no BOM, no DOM/eval sinks, no .style in the mobile script, local-only mobile markup, manifest/icons/precache, one version everywhere, golden + vectors + boundary replay in three time zones");
  const dir = mkdtempSync(join(tmpdir(), "date-tool-safety-"));
  try {
    const out = join(dir, "check-mobile.json");
    const child = spawnSync(process.execPath, [join(ROOT, "scripts", "check-mobile.mjs"), "--json", out], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env } });
    cm.check(child.status === 0, () => `check-mobile exited ${child.status}: ${excerpt(child.stderr || child.stdout, 500)}`);
    if (existsSync(out)) {
      const rep = JSON.parse(readFileSync(out, "utf8"));
      cm.check(rep.staticProblems.length === 0, () => `static: ${rep.staticProblems.join(" | ")}`);
      cm.check(rep.cspProblems.length === 0, () => `csp: ${rep.cspProblems.join(" | ")}`);
      for (const h of rep.hygiene) cm.check(h.problems.length === 0, () => `${h.check}: ${h.problems.slice(0, 3).join(" | ")}`);
      for (const z of rep.zones) {
        cm.check(z.ok === true, () => `TZ=${z.tz}: ${excerpt(JSON.stringify(z), 300)}`);
        if (z.golden) cm.note(`TZ=${z.tz}: golden ${z.golden.passed}/${z.golden.total}, vectors ${z.vectors.passed}/${z.vectors.total}, boundary ${z.boundary.passed}/${z.boundary.total}`);
      }
      cm.check(rep.zones.length === 3, "expected three time zones");
    } else {
      cm.fail("check-mobile wrote no JSON report");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const desk = slice.criterion("desktop-csp-markup", "tauri.conf.json CSP is self-only (no unsafe-*, connect-src 'none', object-src 'none', frame-ancestors 'none'); ui/index.html loads only ./main.js and ./styles.css with no inline script, style= or on* attributes; styles.css imports nothing");
  {
    const conf = JSON.parse(readText("src-tauri/tauri.conf.json"));
    const csp = conf?.app?.security?.csp || "";
    for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      desk.check(csp.split(";").map((s) => s.trim()).includes(d), () => `CSP lacks ${d}`);
    }
    desk.check(!/unsafe-|\*|http:|https:/.test(csp), () => `CSP too broad: ${csp}`);
    desk.check(conf.version === APP_VERSION && conf.identifier === "com.datecalculator.tool" && conf.productName === APP_NAME, "tauri identity");
    const html = readText("ui/index.html");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    desk.check(scripts.length === 1 && /src="\.\/main\.js"/.test(scripts[0][1]) && scripts[0][2].trim() === "", "ui/index.html scripts");
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    desk.check(links.every((l) => /href="\.\/[\w.-]+"/.test(l)), () => `non-local link: ${links.join(" ")}`);
    const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
    desk.check(!/\sstyle\s*=/i.test(markup) && !/\son[a-z]+\s*=/i.test(markup), "style= or on* attribute in ui/index.html");
    desk.check(!/<(?:img|iframe|object|embed)\b[^>]*\ssrc="https?:/i.test(markup), "remote media in ui/index.html");
    desk.check(!/@import|url\(\s*["']?https?:/i.test(readText("ui/styles.css")), "styles.css loads remote resources");
    const main = readText("ui/main.js");
    desk.check(!/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(main.replace(/\/\/.*$/gm, "")), "ui/main.js does network I/O directly");
  }

  const cmds = slice.criterion("command-allowlist", "every invoke(\"…\") and engine(\"…\") name in ui/main.js is a command registered in src-tauri/src/main.rs, engine() only names the nine date-core ops, the v1.1.0 history_state/retry/reset and countdown_load/save/clear and the v1.2.0 layout_load/save/reset commands are registered, invoked and defined as #[tauri::command] (with the layout_newer_schema / layout_unreadable refusals and the 1024-byte cap the UI and this evaluation expect), and the mobile script fetches only the GitHub Releases API");
  {
    const main = readText("ui/main.js");
    const rs = readText("src-tauri/src/main.rs");
    const commandsRs = readText("src-tauri/src/commands.rs");
    const registered = new Set([...(rs.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/commands::(\w+)/g)].map((m) => m[1]));
    const invoked = new Set([...main.matchAll(/\binvoke\(\s*"([\w]+)"/g)].map((m) => m[1]));
    const engined = new Set([...main.matchAll(/\bengine\(\s*"([\w]+)"/g)].map((m) => m[1]));
    cmds.check(registered.size >= 26, () => `only ${registered.size} registered commands parsed`);
    for (const c of NEW_COMMANDS_V110) {
      cmds.check(registered.has(c) && invoked.has(c), () => `v1.1.0 command ${c}: registered=${registered.has(c)} invoked=${invoked.has(c)}`);
      cmds.check(new RegExp(`#\\[tauri::command\\]\\s*pub fn ${c}\\(`).test(commandsRs), () => `commands.rs has no #[tauri::command] pub fn ${c}`);
    }
    for (const c of NEW_COMMANDS_V120) {
      cmds.check(registered.has(c) && invoked.has(c) && DESKTOP_COMMANDS.has(c), () => `v1.2.0 command ${c}: registered=${registered.has(c)} invoked=${invoked.has(c)}`);
      cmds.check(new RegExp(`#\\[tauri::command\\]\\s*pub fn ${c}\\(`).test(commandsRs), () => `commands.rs has no #[tauri::command] pub fn ${c}`);
    }
    // The refusals the UI keys on are the ones commands.rs returns.
    cmds.check(/pub const LAYOUT_NEWER_SCHEMA: &str = "layout_newer_schema";/.test(commandsRs) && /pub const LAYOUT_UNREADABLE: &str = "layout_unreadable";/.test(commandsRs),
      "commands.rs layout refusal strings differ from layout_newer_schema / layout_unreadable");
    cmds.check(main.includes('reason.includes("layout_newer_schema")') && main.includes('reason.includes("layout_unreadable")'), "ui/main.js does not key the layout refusals on layout_newer_schema / layout_unreadable");
    cmds.check(/const LAYOUT_MAX_FILE_BYTES: usize = 1024;/.test(commandsRs) && LAYOUT_MAX_BYTES === 1024, "layout.json cap is not 1024 bytes in commands.rs and this evaluation");
    for (const c of invoked) cmds.check(registered.has(c) && DESKTOP_COMMANDS.has(c), () => `invoke("${c}") is not registered`);
    for (const c of engined) cmds.check(ENGINE_OPS.includes(c) && registered.has(c), () => `engine("${c}") is not an engine command`);
    for (const c of registered) cmds.check(DESKTOP_COMMANDS.has(c), () => `registered command ${c} is unknown to this evaluation`);
    const mscript = ctx.art.mobileHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
    const fetches = [...mscript.matchAll(/\bfetch\(\s*([\w.]+)/g)].map((m) => m[1]);
    cmds.check(fetches.length === 1 && fetches[0] === "GITHUB_LATEST_RELEASE_API", () => `mobile fetch calls: ${fetches}`);
    cmds.check(mscript.includes(`const GITHUB_LATEST_RELEASE_API =\n  "${GITHUB_API_LATEST}"`), "mobile API URL constant changed");
  }

  const ids = slice.criterion("holiday-id-parity", "the preset holiday ids declared in crates/date-core/src/holidays/*.rs equal the ids declared in the mobile engine slice, and every id the engines emit for 1900..2199 is declared");
  {
    const rustIds = new Set(Object.values(KNOWN_IDS).flat());
    for (const [preset, list] of Object.entries(KNOWN_IDS)) ids.check(list.length >= 9, () => `${preset}: only ${list.length} declared ids parsed`);
    const slice2 = extractEngineSlice(ctx.art.mobileHtml);
    const jsIds = new Set([...slice2.matchAll(/\brule\(\s*"([A-Za-z0-9]+)"/g), ...slice2.matchAll(/\bid:\s*"([A-Za-z0-9]+)"/g)].map((m) => m[1]));
    ids.check(rustIds.size > 30, () => `parsed only ${rustIds.size} Rust ids`);
    const onlyRust = [...rustIds].filter((x) => !jsIds.has(x));
    const onlyJs = [...jsIds].filter((x) => !rustIds.has(x));
    ids.check(onlyRust.length === 0 && onlyJs.length === 0, () => `Rust-only: ${onlyRust} / mobile-only: ${onlyJs}`);
    const emitted = new Set();
    for (const preset of ["us", "uk", "eg"]) {
      const res = JSON.parse(ctx.engine.call("holidays_in_range", { startDate: "1900-01-01", endDate: "2199-12-31", calendar: { preset } }));
      for (const h of res.result.holidays) emitted.add(h.id);
      ids.check(res.result.truncated === false || res.result.holidays.length > 0, `${preset}: no holidays listed`);
    }
    for (const id of emitted) ids.check(rustIds.has(id), () => `emitted id ${id} not declared`);
    ids.note(`declared ids: ${rustIds.size}, emitted (first page per preset): ${emitted.size}; the slice A excludedHolidays generator draws from all declared ids per preset`);
  }

  const wfDir = ctx.opts.workflowsDir || WORKFLOW_DIR;
  const workflows = loadWorkflows(wfDir);
  const SHA_PIN = /@[0-9a-f]{40}( #)/;
  const pins = slice.criterion("workflow-pins", "every uses: in .github/workflows is owner/repo@<40-hex commit SHA> with a version comment (planted tag-pin, short-SHA and comment-less mutants are detected)");
  {
    const r = workflowCriterion(pins, workflows, checkWorkflowPins, [
      ["tag pin", "build.yml", SHA_PIN, "@v4$1"],
      ["short SHA", "pages.yml", /@([0-9a-f]{7})[0-9a-f]{33}/, "@$1"],
      ["no version comment", "pages.yml", /(uses: actions\/deploy-pages@[0-9a-f]{40}) #[^\n]*/, "$1"]
    ]);
    pins.note(`uses: lines checked: ${r.count} in ${workflows.map((f) => f.name).join(", ") || "(none)"} from ${wfDir}`);
  }

  const creds = slice.criterion("workflow-persist-credentials", "every actions/checkout step in .github/workflows sets persist-credentials: false under with: (planted true, missing and moved mutants are detected)");
  {
    const r = workflowCriterion(creds, workflows, checkWorkflowCheckouts, [
      ["persist-credentials: true", "build.yml", /persist-credentials: false/, "persist-credentials: true"],
      ["persist-credentials removed", "pages.yml", /\n\s+with:\n\s+persist-credentials: false/, ""],
      ["checkout step without with:", "build.yml", /(\n(\s+)- uses: actions\/checkout@[0-9a-f]{40} # [^\n]*)\n\s+with:\n\s+persist-credentials: false/, "$1"]
    ]);
    creds.note(`actions/checkout steps checked: ${r.count}`);
  }

  const nodeBlocks = slice.criterion("workflow-node-block-identical", `the inline node check block appears in build.yml and pages.yml (at least ${MIN_NODE_BLOCKS} copies) and every copy is byte-identical, step name and shell included (planted one-character drift and a dropped copy are detected)`);
  {
    const r = workflowCriterion(nodeBlocks, workflows, checkNodeBlocks, [
      ["one-character drift", "pages.yml", "assert.strictEqual(between(false), 365);", "assert.strictEqual(between(false), 364);"],
      ["renamed step", "build.yml", /(- name: [^\n]*)\(inline node block\)/, "$1(inline node check)"],
      ["copy dropped", "pages.yml", /\n\s+node - <<'NODE'[\s\S]*?\n\s+NODE(?=\n)/, ""]
    ]);
    nodeBlocks.note(`copies: ${r.count} at ${r.places.join(", ")}; sha256 ${r.sha256}`);
  }

  const gate = slice.criterion("workflow-release-gate", `only build.yml's release job may write contents or run gh release, and its if: is exactly \`${RELEASE_GATE}\`; workflow-level permissions never grant contents: write (planted loosened, removed and workflow-wide write mutants are detected)`);
  {
    const r = workflowCriterion(gate, workflows, checkReleaseGate, [
      ["gate loosened to every push", "build.yml", RELEASE_GATE, "github.event_name == 'push'"],
      ["gate allows dev", "build.yml", "github.ref == 'refs/heads/main'", "startsWith(github.ref, 'refs/heads/')"],
      ["gate removed", "build.yml", /\n\s+if: github\.event_name == 'push' && \(github\.ref[^\n]*/, ""],
      ["workflow-wide contents: write", "build.yml", /^permissions:\n {2}contents: read/m, "permissions:\n  contents: write"]
    ]);
    gate.note(`gated release jobs in build.yml: ${r.gated}`);
  }

  const vsplit = slice.criterion("versions-app-engine-split", `the app version ${APP_VERSION} is locked across tauri.conf.json, src-tauri/Cargo.toml and its Cargo.lock entry, mobile APP_VERSION, the sw.js CACHE_NAME and both footers, while the engine stays ${ENGINE_VERSION} in date-core's Cargo.toml and Cargo.lock entry, ENGINE_VERSION, the golden.json header, the mobile marker and commands.rs EXPECTED_ENGINE_VERSION (planted lockstep and missed-bump mutants are detected)`);
  await guard(vsplit, "version split", async () => {
    const files = {
      tauriConf: readText("src-tauri/tauri.conf.json"),
      appCargo: readText("src-tauri/Cargo.toml"),
      engineCargo: readText("crates/date-core/Cargo.toml"),
      cargoLock: readText("Cargo.lock").replace(/\r\n/g, "\n"),
      libRs: readText("crates/date-core/src/lib.rs"),
      commandsRs: readText("src-tauri/src/commands.rs"),
      goldenHead: readHead("crates/date-core/tests/fixtures/golden.json"),
      mobileHtml: ctx.art.mobileHtml,
      swJs: readText("mobile/sw.js"),
      uiHtml: ctx.art.uiHtml
    };
    vsplit.check(APP_VERSION !== ENGINE_VERSION, "app and engine versions are equal, so the split mutants prove nothing");
    textCriterion(vsplit, files, versionSplitProblems, [
      ["date-core bumped with the app", "engineCargo", /^version = "[^"]+"/m, `version = "${APP_VERSION}"`],
      ["golden.json engine set to the app version", "goldenHead", `"engine":"${ENGINE_VERSION}"`, `"engine":"${APP_VERSION}"`],
      ["mobile engine marker bumped", "mobileHtml", BEGIN_MARKER, `/* date-core:begin v${APP_VERSION} */`],
      ["engine pinned to CARGO_PKG_VERSION again", "commandsRs", "assert_eq!(date_core::ENGINE_VERSION, EXPECTED_ENGINE_VERSION);", 'assert_eq!(date_core::ENGINE_VERSION, env!("CARGO_PKG_VERSION"));'],
      ["tauri.conf.json not bumped", "tauriConf", `"version": "${APP_VERSION}"`, `"version": "${ENGINE_VERSION}"`],
      ["Cargo.lock app entry not bumped", "cargoLock", `name = "date-calculator-tool"\nversion = "${APP_VERSION}"`, `name = "date-calculator-tool"\nversion = "${ENGINE_VERSION}"`],
      ["mobile APP_VERSION not bumped", "mobileHtml", `const APP_VERSION = "${APP_VERSION}";`, `const APP_VERSION = "${ENGINE_VERSION}";`],
      ["sw.js CACHE_NAME not bumped", "swJs", `date-tool-v${APP_VERSION}-`, `date-tool-v${ENGINE_VERSION}-`],
      ["desktop footer not bumped", "uiHtml", `Desktop v${APP_VERSION}</span>`, `Desktop v${ENGINE_VERSION}</span>`]
    ]);
  });

  const contrast = slice.criterion("css-contrast-out-cells", "the out-of-month calendar text (.mini-cal-cell.out) in ui/styles.css and the mobile inline style has at least 4.5:1 contrast on the page, the card, the restored card and the in-range tint, no .out rule dims it with opacity, and only disabled cells keep opacity .25 (planted old-colour and opacity mutants are detected)");
  await guard(contrast, "out-cell contrast", async () => {
    const mobileCss = ctx.art.mobileHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const files = { "ui/styles.css": readText("ui/styles.css"), "mobile/index.html <style>": mobileCss };
    const real = textCriterion(contrast, files, outCellProblems, [
      ["desktop v1.0.0 dim colour", "ui/styles.css", /(\.mini-cal-cell\.out \{[^}]*?color:\s*)#[0-9a-fA-F]{3,6}/, "$1#454c5e"],
      ["mobile v1.0.0 dim colour", "mobile/index.html <style>", /(\.mini-cal-cell\.out \{[^}]*?color:\s*)#[0-9a-fA-F]{3,6}/, "$1#454c5e"],
      ["desktop out cells dimmed with opacity", "ui/styles.css", ".mini-cal-cell.out {", ".mini-cal-cell.out {\n  opacity: 0.5;"],
      ["mobile disabled cells no longer dim", "mobile/index.html <style>", /(\.mini-cal-cell:disabled \{[^}]*?)opacity:\s*0?\.25;/, "$1opacity: 1;"]
    ]);
    for (const [name, css] of Object.entries(files)) {
      const out = cssRules(css).find((r) => r.selectors.includes(".mini-cal-cell.out"));
      const color = out && /color\s*:\s*(#[0-9a-fA-F]{3,6})/.exec(out.body)?.[1];
      if (color) contrast.note(`${name}: .out ${color} is ${contrastRatio(hexRgb(color), hexRgb("#0E0F12")).toFixed(2)}:1 on #0E0F12, ${contrastRatio(hexRgb(color), hexRgb("#161822")).toFixed(2)}:1 on #161822`);
    }
    return real;
  });

  const touch = slice.criterion("touch-targets-44px", `phone first: in ui/styles.css and the mobile inline style, @media (pointer: coarse) gives ${TOUCH_SELECTORS.join(", ")} a min-height of at least 44px (planted shrink mutants are detected)`);
  await guard(touch, "touch targets", async () => {
    const mobileCss = ctx.art.mobileHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    textCriterion(touch, { "ui/styles.css": readText("ui/styles.css"), "mobile/index.html <style>": mobileCss }, touchTargetProblems, [
      ["mobile pick toggle shrunk", "mobile/index.html <style>", /(?<=\.cal-pick-opt \{\s*min-height:\s*)44px/, "30px"],
      ["desktop day cells shrunk", "ui/styles.css", /(?<=\.mini-cal-cell,[^{]*\{\s*min-height:\s*)44px/, "32px"]
    ]);
  });

  const layoutCss = slice.criterion("layout-css-phone-first", "plan A8 in ui/styles.css and the mobile inline style: touch-action: none on the drag handle only, a collapsed card hides only its body, a gold drop line before/after and a dragging look, the handle and collapse button 44x44 on a coarse pointer, no transitions on them under reduced motion (planted mutants are detected)");
  await guard(layoutCss, "layout css", async () => {
    const mobileCss = ctx.art.mobileHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    textCriterion(layoutCss, { "ui/styles.css": readText("ui/styles.css"), "mobile/index.html <style>": mobileCss }, layoutCssProblems, [
      ["touch-action on every card", "ui/styles.css", /\.calc-section \{/, ".calc-section {\n  touch-action: none;"],
      ["mobile handle scrolls the page", "mobile/index.html <style>", /(\.drag-handle \{[^}]*?)touch-action:\s*none;/, "$1touch-action: manipulation;"],
      ["collapse hides the whole card", "ui/styles.css", ".calc-section.card-collapsed .calc-card-body {", ".calc-section.card-collapsed,\n.calc-section.card-collapsed .calc-card-body {"],
      ["mobile drop line not gold", "mobile/index.html <style>", /(\.calc-section\.card-drop-after \{[^}]*?)#E9A715/i, "$1#3a3f4c"],
      ["mobile collapse button 32px on touch", "mobile/index.html <style>", /(@media \(pointer: coarse\) \{[\s\S]*?\.collapse-btn \{[^}]*?min-width:\s*)44px/, "$132px"],
      ["desktop transitions kept under reduced motion", "ui/styles.css", /(@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?)\.drag-handle,\n\s*\.collapse-btn \{\n\s*transition: none;/, "$1.reset-btn {\n    transition: none;"]
    ]);
  });

  const mutants = slice.criterion("ui-mutant-proofs", "the v1.1.0 calendar, countdown and history probes and the v1.2.0 layout probes of slices B and C each detect a planted mutant of the page they guard: span cells, every cell a tab stop, the launch restore call deleted, save on input, clear on an empty field, savedAtMs as the finished signal, a per-tick write, a Forget that keeps the record, a pick that never toggles, unreadable history loaded as empty and writable, the read-only banner never shown, the other-tab sync removed, the restored chip kept on every tick, the saved note shown after a failed save, clear all forgetting the saved countdown, a new-history reset that drops a value not in any backup; and for the layout: a collapse that is not saved, quick-nav not synced, a reset that leaves a card collapsed, .style set during a drag (mobile), localStorage.clear() in the reset (mobile), a keyboard move that drops focus, a history restore that keeps its card collapsed, a drop that ignores the after half, a touch drag that starts at 4 px, edge auto-scroll armed at once, a pointer drop that drops focus, a handle tap that opens no move menu, the click ending a drag that opens it, a menu move that drops focus, a newer record not blocked at launch (desktop) or written over by the mobile store, the other-tab layout sync removed or applied mid-drag (mobile)");
  await guard(mutants, "ui mutants", () => runUiMutants(mutants, ctx));

  const git = slice.criterion("clean-git", "with --require-clean-git, the git working tree has no uncommitted or untracked changes (recorded but not gating without the flag)");
  {
    const meta = ctx.git;
    const dirty = meta.dirtyFiles === null ? null : meta.dirtyFiles;
    if (ctx.opts.requireCleanGit) {
      git.check(dirty === 0, () => (dirty === null ? "git status unavailable" : `${dirty} dirty entries: ${meta.dirtyList.slice(0, 10).join(" | ")}`));
    } else {
      git.check(true);
    }
    git.note(`dirty entries: ${dirty}; enforced: ${ctx.opts.requireCleanGit}`);
  }
}

// ============================================================================
// 16. Main
// ============================================================================

async function main() {
  reexecInEvalTimeZone();
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const card = {
    schema: CARD_SCHEMA,
    schemaVersion: CARD_SCHEMA_VERSION,
    evalVersion: EVAL_VERSION,
    generatedAt: opts.stamp || new Date().toISOString(),
    app: { name: APP_NAME, version: APP_VERSION, engineVersion: ENGINE_VERSION, repository: "https://github.com/CipherVaults/Date-Calculator-Tool" },
    run: {
      seed: opts.seed,
      randomCases: opts.cases,
      uiCasesPerCard: opts.uiCases,
      requireCleanGit: opts.requireCleanGit,
      node: process.version,
      platform: process.platform,
      timeZone: process.env.TZ,
      git: gitMetadata()
    },
    artifacts: Object.fromEntries(["mobile/index.html", "mobile/sw.js", "ui/index.html", "ui/main.js", "src-tauri/tauri.conf.json",
      "crates/date-core/tests/fixtures/golden.json", "crates/date-core/tests/fixtures/vectors.json", "scripts/check-mobile.mjs", "scripts/safety-eval.mjs",
      ".github/workflows/build.yml", ".github/workflows/pages.yml"]
      .map((p) => [p, sha256File(p)])),
    policy: {
      brokenItemTolerance: 0,
      note: "Stricter than the reference's broken-rate thresholds (warn at 2%, abort above 5%): every exception, timeout or unreadable result is a recorded criterion failure, and any failure fails the run. A missing Rust bridge aborts (exit 2) unless --allow-missing-rust-bridge, which is never a pass."
    },
    notRun: [],
    slices: [],
    totals: null,
    verdict: "fail"
  };
  const tzOk = new Date(2026, 6, 1).getTimezoneOffset() === 240 && new Date(2026, 0, 1).getTimezoneOffset() === 300;
  if (!tzOk) {
    console.error(`[ABORT] the evaluation needs TZ=${EVAL_TZ} with DST data; got offsets ${new Date(2026, 6, 1).getTimezoneOffset()}/${new Date(2026, 0, 1).getTimezoneOffset()}`);
    process.exit(2);
  }

  const bridge = new RustBridge(opts);
  let bridgeOk = false;
  try {
    bridgeOk = await bridge.start();
  } catch (err) {
    if (!opts.allowMissingBridge) {
      console.error(`[ABORT] Rust bridge unavailable (${bridge.command}): ${err.message}`);
      console.error("Build it first (PowerShell): cargo build -p date-core --release --example eval_bridge --locked");
      process.exit(2);
    }
    card.notRun.push(`Slices A and C: Rust bridge unavailable (${err.message})`);
  }
  card.run.bridge = bridge.command;
  card.run.bridgeSource = bridge.source;
  const engine = loadMobileEngine(extractEngineSlice(readText("mobile/index.html")));
  const art = loadUiArtifacts();
  const ctx = { opts, bridge, engine, art, git: card.run.git, defaultCalendar: null, mobileSnaps: null };

  const slices = [
    [new Slice("A", "Engine parity", "Rust eval_bridge vs the mobile engine slice (byte-identical) vs an independent JS oracle, over seeded random and adversarial requests"), runSliceA, true],
    [new Slice("B", "Mobile UI behaviour", "mobile/index.html in a mini-DOM with a virtual clock (TZ America/New_York), in-memory localStorage and stubbed fetch/clipboard/service worker"), runSliceB, true],
    [new Slice("C", "Desktop UI behaviour", "ui/index.html + ui/main.js in the mini-DOM with window.__TAURI__.core.invoke routed to the Rust bridge and in-memory history/settings/countdown files"), runSliceC, true],
    [new Slice("D", "Static hygiene", "check-mobile.mjs, desktop CSP and markup, Tauri command allowlist, holiday-id parity, .github/workflows hygiene (SHA pins, persist-credentials, identical inline node blocks, release gate), app/engine version split, calendar contrast and touch targets, planted page mutants"), runSliceD, false]
  ];
  if (bridgeOk) ctx.defaultCalendar = (await bridge.result("validate_calendar", { calendar: {} })).calendar;
  for (const [slice, run, needsBridge] of slices) {
    if (needsBridge && !bridgeOk) {
      // Slice B only needs the bridge for its expected values.
      card.notRun.push(`Slice ${slice.key}: needs the Rust bridge`);
      card.slices.push(slice);
      continue;
    }
    const t0 = Date.now();
    process.stdout.write(`safety-eval: slice ${slice.key} (${slice.name}) … `);
    try {
      await run(slice, ctx);
    } catch (err) {
      slice.criterion("slice-completed", "the slice ran to completion").fail(`aborted: ${err && err.stack}`);
    }
    slice.ms = Date.now() - t0;
    const failed = slice.criteria.filter((c) => !c.ok).length;
    console.log(`${slice.criteria.length - failed}/${slice.criteria.length} criteria ok (${slice.ms} ms)`);
    for (const c of slice.criteria) {
      const mark = c.ok ? "ok  " : "FAIL";
      console.log(`  ${mark} ${c.id}  ${c.passed}/${c.passed + c.failed}`);
      if (!c.ok) for (const d of c.details.slice(0, 4)) console.log(`         - ${excerpt(d, 300)}`);
    }
    card.slices.push(slice);
  }
  await bridge.close();

  const all = card.slices.flatMap((s) => s.criteria);
  const assertions = all.reduce((n, c) => n + c.passed + c.failed, 0);
  const assertionsFailed = all.reduce((n, c) => n + c.failed, 0);
  card.totals = {
    slices: card.slices.length,
    criteria: all.length,
    criteriaPassed: all.filter((c) => c.ok).length,
    criteriaFailed: all.filter((c) => !c.ok).length,
    assertions,
    assertionsPassed: assertions - assertionsFailed,
    assertionsFailed,
    bridgeLines: bridge.lines,
    ms: Date.now() - started
  };
  const pass = bridgeOk && card.totals.criteriaFailed === 0 && all.length > 0;
  card.verdict = pass ? "pass" : "fail";
  card.slices = card.slices.map((s) => s.toJSON());
  if (opts.json) {
    const out = resolve(opts.json);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(card, null, 2)}\n`);
    console.log(`safety-eval: System Card written to ${opts.json}`);
  }
  console.log(`safety-eval: ${card.totals.criteriaPassed}/${card.totals.criteria} criteria, ${card.totals.assertionsPassed}/${assertions} assertions, ${card.totals.ms} ms — ${pass ? "PASS" : "FAIL"}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => {
  console.error(`[ABORT] ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
