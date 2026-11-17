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
//      localStorage -> `_bak` + defaults, update-link sanitising.
//   C  Desktop UI. ui/index.html + ui/main.js in the same mini-DOM with a
//      mocked window.__TAURI__.core.invoke: calc_* and the other engine
//      commands go to the Rust bridge, history and settings live in memory
//      (settings validated through the bridge's validate_calendar). Also runs
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
//      gate), each workflow check also proven to fail on planted mutants.
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const EVAL_VERSION = "1.0.0";
const CARD_SCHEMA = "date-calculator-tool/safety-eval-system-card";
const CARD_SCHEMA_VERSION = "1.0.0";
const APP_NAME = "Date Calculator Tool";
const APP_VERSION = "1.0.0";
const DEFAULT_SEED = 20261116;
const DEFAULT_CASES = 4000;
const DEFAULT_UI_CASES = 180;
const EVAL_TZ = "America/New_York";
const CHILD_ENV = "DATE_TOOL_SAFETY_EVAL_CHILD";
const MAX_DETAILS = 8;
const Z_95 = 1.959963984540054;
const MAX_STRING_BYTES = 1024;
const MAX_REQUEST_BYTES = 65536;
const BEGIN_MARKER = "/* date-core:begin v1.0.0 */";
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
  get offsetWidth() {
    return 0;
  }
  get isConnected() {
    return this.ownerDocument ? this.ownerDocument.contains(this) : false;
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
    for (const c of this.childNodes) c.parentNode = null;
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
    for (const c of this.childNodes) c.parentNode = null;
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

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
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
    return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }

  click() {
    if (this.disabled) return;
    const isCheck = this.tagName === "INPUT" && (this.type === "checkbox" || this.type === "radio");
    if (isCheck) this._checked = !this._checked;
    const ev = new MockEvent("click", { bubbles: true, cancelable: true });
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
    this.writes++;
    this._map.set(String(k), String(v));
  }
  removeItem(k) {
    this._map.delete(String(k));
  }
  clear() {
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
    scrollTo() {},
    scrollBy() {},
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

async function createMobileSandbox(art, opts = {}) {
  const timers = new VirtualTimers(opts.startMs);
  const doc = instantiate(art.mobileTemplate);
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
const DESKTOP_COMMANDS = new Set([...ENGINE_OPS, "history_list", "history_add", "history_delete", "history_clear",
  "get_settings", "set_settings", "check_for_updates", "open_release_page", "copy_text", "get_app_info",
  "is_smoke_test", "report_smoke_result"]);

async function createDesktopBackend(bridge, timers, opts = {}) {
  const defaultCalendar = (await bridge.result("validate_calendar", { calendar: {} })).calendar;
  let settings = { checkUpdatesOnStartup: true, firstDayOfWeek: "monday", calendar: defaultCalendar, schemaVersion: 1 };
  let history = [];
  let nextId = 1;
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
    smokeDone: null
  };
  let smokeResolve;
  state.smokeDone = new Promise((r) => (smokeResolve = r));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const line = (s) => typeof s === "string" && s.trim() !== "" && Buffer.byteLength(s) <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(s);
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
          engineVersion: "1.0.0",
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
      case "history_add": {
        const e = args?.entry;
        const keys = e && HISTORY_INPUT_KEYS[e.calculator];
        if (!e || !Object.hasOwn(HISTORY_INPUT_KEYS, e.calculator) || !line(e.calculatorLabel) || !line(e.inputsText) ||
          !line(e.resultText) || typeof e.copyText !== "string" || Buffer.byteLength(e.copyText) > 1024 ||
          !e.inputs || Object.keys(e.inputs).sort().join() !== keys.slice().sort().join() ||
          !keys.every((k) => typeof e.inputs[k] === "string" && Buffer.byteLength(e.inputs[k]) <= 256)) {
          throw "invalid history entry";
        }
        const first = history[0];
        if (first && first.calculator === e.calculator && canonical(first.inputs) === canonical(e.inputs) && first.resultText === e.resultText) {
          first.timestampMs = timers.now;
          return clone(history);
        }
        history.unshift({ id: nextId++, timestampMs: timers.now, calculator: e.calculator, calculatorLabel: e.calculatorLabel,
          inputs: clone(e.inputs), inputsText: e.inputsText, resultText: e.resultText, copyText: e.copyText });
        history = history.slice(0, 500);
        return clone(history);
      }
      case "history_delete":
        history = history.filter((h) => h.id !== args?.id);
        return clone(history);
      case "history_clear":
        history = [];
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

  const roll = slice.criterion("midnight-rollover", "at 2026-12-31 23:59:57 the countdown to 2027-01-01 runs 3, 2, 1, now, then 1 s past (is-past), and on the 00:00 tick the date info relative text, the age hint and the empty-as-of age switch to the new day");
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
    const want = [["0d 00h 00m 02s", "Counting down"], ["0d 00h 00m 01s", "Counting down"], ["0d 00h 00m 00s", "The target time is now"], ["0d 00h 00m 01s", "Target passed"], ["0d 00h 00m 02s", "Target passed"]];
    for (let k = 0; k < want.length; k++) {
      await sb.advance(1000);
      roll.check(u.text("cdClock") === want[k][0] && u.text("cdStatus").startsWith(want[k][1]), () => `step ${k + 1}: "${u.text("cdClock")}" / "${u.text("cdStatus")}"`);
    }
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
// 13. Slice B: mobile UI
// ============================================================================

async function runSliceB(slice, ctx) {
  const { art } = ctx;
  const make = (startMs, extra = {}) => createMobileSandbox(art, { startMs, seed: ctx.opts.seed, ...extra });
  const sb = await make(T_MAIN);
  ctx.mobileSnaps = await runUiSuite(slice, sb, ctx);
  await runClockSuite(slice, make, ctx);

  const corrupt = slice.criterion("corrupt-storage", "corrupt or invalid stored history/settings are copied once to <key>_bak, defaults load (startup update check off, so no network), invalid or prototype-named history entries are dropped, and the app still works");
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
      await u.set("infoDate", "2024-02-29");
      await u.enter("infoDate");
      corrupt.check(JSON.parse(m.storage.getItem(HISTORY_KEY)).length === 1, "history unusable after corrupt storage");
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
    const m = await make(T_MAIN, { storage: { [HISTORY_KEY]: JSON.stringify(entries) } });
    const items = m.doc.querySelectorAll(".history-item");
    corrupt.check(items.length === 1 && uiDriver(m).text("historyCount") === "(1 / 500)", () => `kept ${items.length} entries`);
    corrupt.check(m.storage.getItem(`${HISTORY_KEY}_bak`) === null, "a valid array must not be backed up");
    const proto = await make(T_MAIN, { storage: { [HISTORY_KEY]: '[{"__proto__":{"polluted":1},"id":1}]' } });
    corrupt.check(({}).polluted === undefined && uiDriver(proto).text("historyCount") === "(0 / 500)", "prototype pollution through stored history");
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

  const ipc = slice.criterion("ipc-routing", "every invoke is a registered Tauri command, every engine command reached the Rust bridge as {req}, and nothing fell back to JS math");
  await guard(ipc, "ipc", async () => {
    const st = sb.backend.state;
    ipc.check(st.unknown.length === 0, () => `unknown commands: ${st.unknown}`);
    ipc.check(st.calls.every((c) => DESKTOP_COMMANDS.has(c)), "unregistered command");
    ipc.check(st.bridgeCalls > 20, () => `only ${st.bridgeCalls} engine calls`);
    ipc.check(st.calls.includes("check_for_updates"), "startup update check not requested via IPC");
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

function runSliceD(slice, ctx) {
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

  const cmds = slice.criterion("command-allowlist", "every invoke(\"…\") and engine(\"…\") name in ui/main.js is a command registered in src-tauri/src/main.rs, engine() only names the nine date-core ops, and the mobile script fetches only the GitHub Releases API");
  {
    const main = readText("ui/main.js");
    const rs = readText("src-tauri/src/main.rs");
    const registered = new Set([...(rs.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/commands::(\w+)/g)].map((m) => m[1]));
    const invoked = new Set([...main.matchAll(/\binvoke\(\s*"([\w]+)"/g)].map((m) => m[1]));
    const engined = new Set([...main.matchAll(/\bengine\(\s*"([\w]+)"/g)].map((m) => m[1]));
    cmds.check(registered.size >= 20, () => `only ${registered.size} registered commands parsed`);
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
    app: { name: APP_NAME, version: APP_VERSION, repository: "https://github.com/CipherVaults/Date-Calculator-Tool" },
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
    [new Slice("C", "Desktop UI behaviour", "ui/index.html + ui/main.js in the mini-DOM with window.__TAURI__.core.invoke routed to the Rust bridge and in-memory history/settings"), runSliceC, true],
    [new Slice("D", "Static hygiene", "check-mobile.mjs, desktop CSP and markup, Tauri command allowlist, holiday-id parity, .github/workflows hygiene (SHA pins, persist-credentials, identical inline node blocks, release gate)"), runSliceD, false]
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
