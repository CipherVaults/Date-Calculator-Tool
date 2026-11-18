#!/usr/bin/env node
// Mobile engine parity gate (FROZEN §13/§14). Zero dependencies.
//
// 1. Extracts the engine slice between `/* date-core:begin v1.0.0 */` and
//    `/* date-core:end */` from mobile/index.html.
// 2. Statically bans clock, time-zone, locale, randomness, storage, network,
//    DOM and dynamic-code identifiers in the slice.
// 3. Checks the meta CSP: the one inline <style> and the one inline <script>
//    are pinned by their exact SHA-256, the reference directive set is
//    present, and there is no frame-ancestors or unsafe-* source.
// 4. Repository hygiene (the reference CI node block, adapted): no CR bytes
//    or BOM in mobile/, ui/ and scripts/ text files; no innerHTML/outerHTML/
//    insertAdjacentHTML/document.write/eval/Function sinks in ui/main.js, the
//    mobile script or sw.js; no .style in the mobile script; local-only
//    resources in the mobile markup; manifest fields, icons and sw precache
//    files exist; the app version agrees across tauri.conf.json,
//    src-tauri/Cargo.toml, mobile APP_VERSION, the sw CACHE_NAME and both
//    footers/About pills; the engine version agrees across date-core's
//    Cargo.toml, ENGINE_VERSION, the golden header and the marker, and the
//    engine slice bytes match their pinned SHA-256.
// 5. In one child process per time zone (UTC, America/St_Johns,
//    Pacific/Kiritimati), runs the slice in node:vm with `Date` and `Intl`
//    deleted, replays every case of crates/date-core/tests/fixtures/golden.json
//    comparing raw JSON bytes, and replays the hand-verified vectors in
//    crates/date-core/tests/fixtures/vectors.json (partial matches).
//
// Usage: node scripts/check-mobile.mjs [--max-diffs N] [--json PATH] [--html PATH]
// Exits non-zero with a diff of the first N mismatches on any failure.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let MOBILE_HTML = join(ROOT, "mobile", "index.html");
const GOLDEN = join(ROOT, "crates", "date-core", "tests", "fixtures", "golden.json");
const VECTORS = join(ROOT, "crates", "date-core", "tests", "fixtures", "vectors.json");
const BEGIN_MARKER = "/* date-core:begin v1.0.0 */";
const END_MARKER = "/* date-core:end */";
const ENGINE_VERSION = "1.0.0";
// SHA-256 (hex) of the exact bytes between the markers for engine v1.0.0
// (103,653 bytes, identical to the v1.0.0 release tag). The app version can
// move on while the engine stays 1.0.0, so any edit to the slice must come
// with an intentional engine bump: new ENGINE_VERSION, marker, golden header
// and this pin, all in one commit.
const ENGINE_SLICE_SHA256 = "29203081a922c9f77248127123914de6ac2e8173be6ebe7c508da73481b41945";
const EXPECTED_GOLDEN_CASES = 13965;
const TIME_ZONES = ["UTC", "America/St_Johns", "Pacific/Kiritimati"];

function parseArgs(argv) {
  const opts = { maxDiffs: 10, json: null, child: false, html: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-diffs") {
      opts.maxDiffs = Math.max(1, Number.parseInt(argv[++i], 10) || 10);
    } else if (a === "--json") {
      opts.json = argv[++i];
    } else if (a === "--child") {
      opts.child = true;
    } else if (a === "--html") {
      // Alternative page to check (used to prove the gate fails on mutants).
      opts.html = resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Slice extraction and static checks
// ---------------------------------------------------------------------------

function countOccurrences(text, needle) {
  let n = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

function extractSlice(html) {
  if (html.includes("\r")) {
    throw new Error("mobile/index.html must use LF line endings (CSP hashes are byte-exact)");
  }
  const nBegin = countOccurrences(html, BEGIN_MARKER);
  const nEnd = countOccurrences(html, END_MARKER);
  if (nBegin !== 1 || nEnd !== 1) {
    throw new Error(`expected exactly one begin and one end marker, found ${nBegin} and ${nEnd}`);
  }
  const start = html.indexOf(BEGIN_MARKER) + BEGIN_MARKER.length;
  const end = html.indexOf(END_MARKER);
  if (end <= start) throw new Error("engine end marker precedes the begin marker");
  return html.slice(start, end);
}

// Removes comments and string literals so identifiers can be scanned without
// tripping on message text such as "Date of birth". The engine slice is
// written without template literals or regex literals, so those are rejected
// outright (a scanner that cannot see through them could miss a banned name).
function stripCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close < 0) throw new Error("unterminated block comment in engine slice");
      i = close + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        if (src[i] === "\n") throw new Error("unterminated string literal in engine slice");
        i++;
      }
      if (i >= src.length) throw new Error("unterminated string literal in engine slice");
      i++;
      out += '""';
      continue;
    }
    if (c === "`") {
      throw new Error("template literals are not allowed in the engine slice");
    }
    out += c;
    i++;
  }
  return out;
}

// Banned in code (comments and strings removed).
const CODE_BANS = [
  ["Date", /\bDate\b/],
  ["Intl", /\bIntl\b/],
  ["toISOString", /toISOString/],
  ["getTimezoneOffset", /getTimezoneOffset/],
  ["toLocale*", /\btoLocale\w*/],
  ["localeCompare", /\blocaleCompare\b/],
  ["Math.random", /\bMath\s*\.\s*random\b/],
  ["crypto", /\bcrypto\b/],
  ["performance", /\bperformance\b/],
  ["localStorage", /\blocalStorage\b/],
  ["sessionStorage", /\bsessionStorage\b/],
  ["indexedDB", /\bindexedDB\b/],
  ["caches", /\bcaches\b/],
  ["document", /\bdocument\b/],
  ["window", /\bwindow\b/],
  ["navigator", /\bnavigator\b/],
  ["location", /\blocation\b/],
  ["globalThis", /\bglobalThis\b/],
  ["self", /\bself\b/],
  ["fetch", /\bfetch\b/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["setTimeout", /\bsetTimeout\b/],
  ["setInterval", /\bsetInterval\b/],
  ["eval", /\beval\b/],
  ["Function", /\bFunction\b/],
  ["import", /\bimport\b/],
  ["require", /\brequire\b/],
  ["process", /\bprocess\b/],
  ["innerHTML/outerHTML", /\b(?:inner|outer)HTML\b/],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  [".style", /\.style\b/],
];

// Banned anywhere in the raw slice, strings and comments included.
const RAW_BANS = [
  ["new Date", /\bnew\s+Date\b/],
  ["Date.", /\bDate\s*\./],
  ["Date(", /\bDate\s*\(/],
  ["Intl.", /\bIntl\s*\./],
  ["toISOString", /toISOString/],
  ["getTimezoneOffset", /getTimezoneOffset/],
  ["Math.random", /Math\s*\.\s*random/],
  ["localStorage", /localStorage/],
];

function staticChecks(slice) {
  const problems = [];
  const code = stripCommentsAndStrings(slice);
  for (const [name, re] of CODE_BANS) {
    if (re.test(code)) problems.push(`engine slice references banned identifier: ${name}`);
  }
  for (const [name, re] of RAW_BANS) {
    if (re.test(slice)) problems.push(`engine slice contains banned text: ${name}`);
  }
  if (!/\bconst\s+DateCore\s*=/.test(code)) problems.push("engine slice does not declare `const DateCore`");
  return problems;
}

// The reference directive set (BUILD_PLAN §3 mobile), hashes aside.
const REQUIRED_CSP = [
  "default-src 'none'",
  "worker-src 'self'",
  "child-src 'self'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "connect-src 'self' https://api.github.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

function sha256b64(text) {
  return createHash("sha256").update(text, "utf8").digest("base64");
}

// Every inline <style> and <script> must be pinned by its exact SHA-256 in
// the meta CSP (byte-exact, so LF line endings matter), and the CSP must
// keep the reference directives without frame-ancestors or unsafe-*.
function cspChecks(html) {
  const problems = [];
  const metas = html.match(/<meta\s+http-equiv="Content-Security-Policy"/gi) || [];
  if (metas.length !== 1) problems.push(`expected exactly one CSP <meta>, found ${metas.length}`);
  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
  if (!meta) return [...problems, "mobile/index.html has no CSP <meta>"];
  const csp = meta[1];
  const directives = csp
    .split(";")
    .map((d) => d.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (/frame-ancestors/i.test(csp)) problems.push("CSP <meta> must not contain frame-ancestors");
  if (/unsafe-(?:inline|eval|hashes)|wasm-unsafe-eval|strict-dynamic|\*/i.test(csp)) {
    problems.push("CSP <meta> must not allow unsafe-*, strict-dynamic or wildcards");
  }
  for (const d of REQUIRED_CSP) {
    if (!directives.includes(d)) problems.push(`CSP <meta> is missing the directive "${d}"`);
  }
  const directiveOf = (name) => directives.find((d) => d.startsWith(`${name} `)) || "";
  for (const [tag, directiveName] of [
    ["style", "style-src"],
    ["script", "script-src"],
  ]) {
    const directive = directiveOf(directiveName);
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
    const blocks = [...html.matchAll(re)].map((m) => m[1]);
    if (blocks.length !== 1) {
      problems.push(`expected exactly one inline <${tag}>, found ${blocks.length}`);
    }
    const wanted = blocks.map((b) => `'sha256-${sha256b64(b)}'`);
    blocks.forEach((b, i) => {
      if (!directive.split(" ").includes(wanted[i])) {
        problems.push(`inline <${tag}> #${i + 1} hash ${wanted[i]} is not in the CSP ${directiveName}`);
      }
    });
    const listed = directive.split(" ").slice(1);
    if (listed.length !== wanted.length || listed.some((h) => !wanted.includes(h))) {
      problems.push(`CSP ${directiveName} must list exactly the inline <${tag}> hash (has: ${listed.join(" ") || "nothing"})`);
    }
  }
  if (/<(?:script|style)\s[^>]*>/i.test(html)) {
    problems.push("<script>/<style> tags must be plain inline blocks (no src, type or nonce attributes)");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Repository hygiene (the reference CI node block, adapted)
// ---------------------------------------------------------------------------

const TEXT_EXT = /\.(?:html|css|js|mjs|cjs|json|webmanifest|md|txt)$/i;

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function rel(p) {
  return relative(ROOT, p).split(sep).join("/");
}

// No CR bytes (and no UTF-8 BOM) in the web, script and mobile text files.
function lineEndingChecks() {
  const problems = [];
  const files = ["mobile", "ui", "scripts"].flatMap((d) => listFiles(join(ROOT, d))).filter((f) => TEXT_EXT.test(f));
  for (const f of files) {
    const bytes = readFileSync(f);
    if (bytes.includes(13)) problems.push(`CR byte in ${rel(f)} (LF only: CSP hashes are byte-exact)`);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) problems.push(`UTF-8 BOM in ${rel(f)}`);
  }
  if (files.length < 8) problems.push(`expected the mobile, ui and scripts text files, found only ${files.length}`);
  return { problems, count: files.length };
}

const SINKS = [
  ["innerHTML", /\binnerHTML\b/],
  ["outerHTML", /\bouterHTML\b/],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["document.write", /\bdocument\s*\.\s*write(?:ln)?\b/],
  ["eval(", /\beval\s*\(/],
  ["new Function", /\bnew\s+Function\b/],
  ["Function(", /(?<![\w.$])Function\s*\(/],
  ["setTimeout/setInterval with a string", /\bset(?:Timeout|Interval)\s*\(\s*["'`]/],
  ["srcdoc", /\bsrcdoc\b/],
];

// DOM-safety rules: textContent/createElement/replaceChildren only, and the
// mobile script toggles classes but never touches inline styles.
function sinkChecks(mobileScript) {
  const problems = [];
  const sources = [
    ["ui/main.js", readFileSync(join(ROOT, "ui", "main.js"), "utf8")],
    ["mobile/index.html <script>", mobileScript],
    ["mobile/sw.js", readFileSync(join(ROOT, "mobile", "sw.js"), "utf8")],
  ];
  for (const [name, src] of sources) {
    // Raw text, comments included (the reference CI form): even a comment
    // may not name a sink.
    for (const [label, re] of SINKS) {
      if (re.test(src)) problems.push(`${name}: forbidden sink ${label}`);
    }
  }
  if (/\.style\b/.test(mobileScript)) problems.push("mobile script: .style access (toggle classes instead)");
  if (/\bcssText\b/.test(mobileScript)) problems.push("mobile script: cssText access");
  if (/setAttribute\s*\(\s*["'`]style["'`]/.test(mobileScript)) problems.push('mobile script: setAttribute("style", …)');
  return problems;
}

// The page loads nothing from the network: no external scripts, styles,
// fonts or images, no inline style attributes or event-handler attributes.
function markupChecks(html, style) {
  const problems = [];
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
  if (/\sstyle\s*=/i.test(markup)) problems.push("mobile markup has a style= attribute (blocked by the CSP)");
  if (/\son[a-z]+\s*=/i.test(markup)) problems.push("mobile markup has an inline on*= event handler");
  for (const m of markup.matchAll(/<(link|img|source|iframe|embed|object|audio|video)\b[^>]*>/gi)) {
    const tag = m[0];
    if (/^<(iframe|embed|object)/i.test(tag)) problems.push(`mobile markup embeds ${m[1]}`);
    const url = (tag.match(/\s(?:href|src)="([^"]*)"/i) || [, ""])[1];
    if (!/^(?:\.\/[\w./-]+|data:image\/png;base64,[A-Za-z0-9+/=]+)$/.test(url)) {
      problems.push(`mobile <${m[1]}> loads a non-local resource: ${url.slice(0, 80)}`);
    }
    if (/rel="stylesheet"/i.test(tag)) problems.push("mobile page links an external stylesheet");
  }
  if (/@import|url\(\s*["']?(?!data:)/i.test(style)) problems.push("mobile CSS imports or loads an external resource");
  for (const m of markup.matchAll(/<a\b[^>]*>/gi)) {
    const a = m[0];
    const href = (a.match(/\shref="([^"]*)"/i) || [, ""])[1];
    if (/^https?:/i.test(href)) {
      if (!/^https:\/\/(?:github\.com\/CipherVaults\/Date-Calculator-Tool\/|ciphervaults\.github\.io\/Date-Calculator-Tool\/)/.test(href)) {
        problems.push(`mobile link to an unexpected site: ${href}`);
      }
      if (!/target="_blank"/.test(a) || !/rel="noopener noreferrer"/.test(a)) {
        problems.push(`external link without target=_blank rel="noopener noreferrer": ${href}`);
      }
    } else if (!/^#[\w-]+$/.test(href)) {
      problems.push(`mobile link with an unexpected href: ${href}`);
    }
  }
  return problems;
}

// PNG width/height from the IHDR chunk.
function pngSize(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) return null;
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function mobileFile(src, problems, what) {
  if (typeof src !== "string" || src.length === 0) {
    problems.push(`${what}: missing path`);
    return null;
  }
  const mobileRoot = resolve(ROOT, "mobile");
  const resolved = resolve(mobileRoot, src.replace(/^\.\//, ""));
  if (!resolved.startsWith(mobileRoot + sep)) {
    problems.push(`${what} escapes mobile/: ${src}`);
    return null;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile() || statSync(resolved).size === 0) {
    problems.push(`${what} missing or empty: ${src}`);
    return null;
  }
  return resolved;
}

function manifestChecks(html, swCode) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(ROOT, "mobile", "manifest.webmanifest"), "utf8"));
  } catch (e) {
    return [`mobile/manifest.webmanifest: ${e.message}`];
  }
  for (const k of ["name", "short_name", "description", "start_url", "scope", "id"]) {
    if (typeof manifest[k] !== "string" || manifest[k].trim() === "") problems.push(`manifest field missing: ${k}`);
  }
  if (manifest.start_url !== "./" || manifest.scope !== "./") problems.push('manifest start_url and scope must be "./"');
  if (manifest.display !== "standalone") problems.push('manifest display must be "standalone"');
  for (const k of ["background_color", "theme_color"]) {
    if (String(manifest[k]).toUpperCase() !== "#0E0F12") problems.push(`manifest ${k} must be #0E0F12`);
  }
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  if (icons.length === 0) problems.push("manifest has no icons");
  if (!icons.some((i) => String(i.purpose).split(" ").includes("maskable"))) problems.push("manifest has no maskable icon");
  for (const icon of icons) {
    const file = mobileFile(icon.src, problems, "manifest icon");
    if (!file) continue;
    const size = pngSize(readFileSync(file));
    if (!size) problems.push(`manifest icon is not a PNG: ${icon.src}`);
    else if (icon.sizes !== `${size[0]}x${size[1]}`) problems.push(`manifest icon ${icon.src} is ${size.join("x")}, declared ${icon.sizes}`);
  }
  for (const m of html.matchAll(/<link\s+rel="(?:manifest|apple-touch-icon)"[^>]*href="([^"]+)"/g)) {
    mobileFile(m[1], problems, "head link");
  }
  const precache = swCode.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/);
  if (!precache) problems.push("mobile/sw.js has no PRECACHE_URLS list");
  else {
    for (const m of precache[1].matchAll(/"([^"]+)"/g)) {
      if (m[1] !== "./") mobileFile(m[1], problems, "sw.js precache entry");
    }
  }
  return problems;
}

function packageVersion(cargoToml) {
  const pkg = cargoToml.split(/^\[/m).find((s) => s.startsWith("package]"));
  const m = pkg && pkg.match(/^version\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

// Two version lines (AGENTS.md "Version"): the app version from
// tauri.conf.json must match src-tauri, mobile APP_VERSION, the sw cache name
// and the footers/About pills; the engine version from date-core's Cargo.toml
// must match ENGINE_VERSION in lib.rs, the golden header, the mobile marker
// and this gate's pin, and the engine slice bytes must hash to the pin.
function versionChecks(html, mobileScript, swCode) {
  const problems = [];
  const found = [];
  const add = (where, v) => found.push([where, v ?? "(not found)"]);
  const semver = /^\d+\.\d+\.\d+$/;
  const tauri = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  if (!semver.test(String(tauri.version))) problems.push(`tauri.conf.json version ${JSON.stringify(tauri.version)} must be x.y.z`);
  add("src-tauri/tauri.conf.json", tauri.version);
  add("src-tauri/Cargo.toml", packageVersion(readFileSync(join(ROOT, "src-tauri", "Cargo.toml"), "utf8")));
  add("mobile APP_VERSION", (mobileScript.match(/\bconst APP_VERSION = "([^"]+)";/) || [])[1]);
  const cache = (swCode.match(/\bconst CACHE_NAME = "([^"]+)";/) || [])[1];
  const cacheMatch = cache && cache.match(/^date-tool-v(\d+\.\d+\.\d+)-mobile-\d+$/);
  if (!cacheMatch) problems.push(`mobile/sw.js CACHE_NAME ${JSON.stringify(cache)} must match date-tool-v<version>-mobile-<n>`);
  add("mobile/sw.js CACHE_NAME", cacheMatch && cacheMatch[1]);
  add("mobile footer", (html.match(/<span id="appVersion">Mobile &amp; Web v([^<]+)<\/span>/) || [])[1]);
  add("mobile About pill", (html.match(/id="aboutVersionPill">Mobile &amp; Web v([^ <]+) /) || [])[1]);
  const desktop = readFileSync(join(ROOT, "ui", "index.html"), "utf8");
  add("ui footer", (desktop.match(/<span id="appVersion">Desktop v([^<]+)<\/span>/) || [])[1]);
  add("ui About pill", (desktop.match(/id="aboutVersionPill">Desktop v([^ <]+) /) || [])[1]);
  const want = found[0][1];
  for (const [where, v] of found) {
    if (v !== want) problems.push(`app version mismatch: ${where} has ${v}, tauri.conf.json has ${want}`);
  }

  const engine = [];
  const addEngine = (where, v) => engine.push([where, v ?? "(not found)"]);
  const engineVersion = packageVersion(readFileSync(join(ROOT, "crates", "date-core", "Cargo.toml"), "utf8"));
  addEngine("crates/date-core/Cargo.toml", engineVersion);
  addEngine("check-mobile ENGINE_VERSION pin", ENGINE_VERSION);
  addEngine(
    "date-core ENGINE_VERSION (lib.rs)",
    (readFileSync(join(ROOT, "crates", "date-core", "src", "lib.rs"), "utf8").match(/^pub const ENGINE_VERSION: &str = "([^"]+)";/m) || [])[1],
  );
  addEngine("golden.json header engine", (readFileSync(GOLDEN, "utf8").slice(0, 512).match(/"engine":"([^"]+)"/) || [])[1]);
  const markers = [...html.matchAll(/\/\* date-core:begin v(\S+) \*\//g)].map((m) => m[1]);
  if (markers.length !== 1) problems.push(`expected exactly one date-core begin marker, found ${markers.length}`);
  addEngine("mobile date-core marker", markers[0]);
  const engineWant = engine[0][1];
  if (!semver.test(String(engineWant))) problems.push(`date-core Cargo.toml version ${JSON.stringify(engineWant)} must be x.y.z`);
  for (const [where, v] of engine) {
    if (v !== engineWant) problems.push(`engine version mismatch: ${where} has ${v}, date-core Cargo.toml has ${engineWant}`);
  }
  let sliceHash = null;
  try {
    sliceHash = createHash("sha256").update(extractSlice(html), "utf8").digest("hex");
  } catch (e) {
    problems.push(`engine slice: ${e.message}`);
  }
  if (sliceHash !== null && sliceHash !== ENGINE_SLICE_SHA256) {
    problems.push(
      `engine slice SHA-256 ${sliceHash} != pinned ${ENGINE_SLICE_SHA256} for engine v${ENGINE_VERSION}; ` +
        "the mobile engine changed without an engine version bump",
    );
  }
  return { problems, version: want, engineVersion: engineWant, places: found.length + engine.length + 1 };
}

function hygieneChecks(html) {
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ""])[1];
  const mobileScript = (html.match(/<script>([\s\S]*?)<\/script>/) || [, ""])[1];
  const swCode = readFileSync(join(ROOT, "mobile", "sw.js"), "utf8");
  const lf = lineEndingChecks();
  const versions = versionChecks(html, mobileScript, swCode);
  return [
    [`LF only, no BOM (${lf.count} text files in mobile/, ui/, scripts/)`, lf.problems],
    ["no DOM/eval sinks in ui/main.js, the mobile script and sw.js; no .style in the mobile script", sinkChecks(mobileScript)],
    ["mobile markup loads only local resources; no style/on* attributes", markupChecks(html, style)],
    ["manifest fields, icons (PNG sizes) and sw precache files exist", manifestChecks(html, swCode)],
    [`versions agree (app ${versions.version}, engine ${versions.engineVersion}, ${versions.places} checks, engine slice hash pinned)`, versions.problems],
  ];
}

// ---------------------------------------------------------------------------
// VM replay (child process)
// ---------------------------------------------------------------------------

function loadEngine(slice) {
  const ctx = vm.createContext({});
  vm.runInContext("delete globalThis.Date; delete globalThis.Intl;", ctx);
  const leftovers = vm.runInContext("[typeof Date, typeof Intl]", ctx);
  if (leftovers[0] !== "undefined" || leftovers[1] !== "undefined") {
    throw new Error(`could not remove Date/Intl from the VM context (${leftovers.join(", ")})`);
  }
  vm.runInContext(slice, ctx, { filename: "mobile/index.html:date-core", timeout: 10_000 });
  // Helpers live in the same context so every object the engine sees and
  // returns belongs to the engine's realm.
  vm.runInContext(
    `const __parity = Object.freeze({
       call: function (op, reqText) { return JSON.stringify(DateCore.call(op, JSON.parse(reqText))); },
       callValue: function (op, reqText) { return JSON.parse(JSON.stringify(DateCore.call(op, JSON.parse(reqText)))); },
       internal: function (name, argsText) {
         const args = JSON.parse(argsText);
         return JSON.parse(JSON.stringify(DateCore.internal[name].apply(null, args)));
       },
       version: function () { return DateCore.ENGINE_VERSION; }
     });`,
    ctx,
  );
  return vm.runInContext("__parity", ctx);
}

// Compact JSON with object keys sorted recursively (the generator's form).
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function firstDiff(want, got) {
  let i = 0;
  while (i < want.length && i < got.length && want[i] === got[i]) i++;
  const from = Math.max(0, i - 60);
  return {
    offset: i,
    want: (from > 0 ? "…" : "") + want.slice(from, i + 140),
    got: (from > 0 ? "…" : "") + got.slice(from, i + 140),
  };
}

function excerpt(s, n = 300) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function replayGolden(engine, maxDiffs) {
  const text = readFileSync(GOLDEN, "utf8");
  const failures = [];
  const layout = [];
  if (text.includes("\r")) layout.push("golden.json must be LF-only");
  const lines = text.split("\n");
  const header = JSON.parse(`${lines[0]}]}`);
  if (header.version !== 1) layout.push(`golden.json version ${header.version} != 1`);
  if (header.engine !== ENGINE_VERSION) layout.push(`golden.json engine ${header.engine} != ${ENGINE_VERSION}`);
  const count = header.count;
  if (lines.length !== count + 3 || lines[count + 1] !== "]}" || lines[count + 2] !== "") {
    layout.push(`golden.json layout: expected ${count} case lines between the header and "]}"`);
  }
  const perOp = new Map();
  let passed = 0;
  let total = 0;
  for (let idx = 0; idx < count; idx++) {
    let body = lines[idx + 1] ?? "";
    if (idx + 1 < count) {
      if (!body.endsWith(",")) {
        layout.push(`case #${idx}: line does not end with a comma`);
        continue;
      }
      body = body.slice(0, -1);
    }
    total++;
    let c;
    try {
      c = JSON.parse(body);
    } catch (e) {
      layout.push(`case #${idx}: invalid JSON (${e.message})`);
      continue;
    }
    const prefix = `{"op":${JSON.stringify(c.op)},"req":${canonical(c.req)},"res":`;
    if (!body.startsWith(prefix) || !body.endsWith("}")) {
      layout.push(`case #${idx}: line layout or non-canonical req`);
      continue;
    }
    const want = body.slice(prefix.length, -1);
    let got;
    try {
      got = engine.call(c.op, JSON.stringify(c.req));
    } catch (e) {
      got = `<<threw ${e && e.stack ? e.stack : e}>>`;
    }
    const stat = perOp.get(c.op) ?? { cases: 0, passed: 0 };
    stat.cases++;
    if (got === want) {
      passed++;
      stat.passed++;
    } else if (failures.length < maxDiffs) {
      failures.push({ idx, op: c.op, req: excerpt(JSON.stringify(c.req)), ...firstDiff(want, got) });
    }
    perOp.set(c.op, stat);
  }
  return { total, passed, expected: count, layout: layout.slice(0, maxDiffs), layoutCount: layout.length, failures, perOp: Object.fromEntries(perOp) };
}

// vectors.rs: every listed field must match exactly; `endsWith` checks suffixes.
function partialMatch(path, expected, actual, out) {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      out.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    for (const key of Object.keys(expected)) {
      if (!Object.prototype.hasOwnProperty.call(actual, key)) {
        out.push(`${path}.${key}: missing (expected ${JSON.stringify(expected[key])})`);
      } else {
        partialMatch(`${path}.${key}`, expected[key], actual[key], out);
      }
    }
    return;
  }
  if (canonical(expected) !== canonical(actual)) {
    out.push(`${path}: expected ${excerpt(JSON.stringify(expected), 200)}, got ${excerpt(JSON.stringify(actual), 200)}`);
  }
}

function runVector(engine, op, req) {
  switch (op) {
    case "parse_date":
      return engine.internal("parseDate", JSON.stringify([req.raw ?? "", req.field]));
    case "parse_amount":
      return engine.internal("parseAmount", JSON.stringify([req.raw ?? "", req.field]));
    case "parse_time":
      return engine.internal("parseTime", JSON.stringify([req.raw ?? "", req.field, req.required === true]));
    case "format_int":
      return { ok: "true", result: engine.internal("formatInt", JSON.stringify([req.n])) };
    case "parse_weekend":
      return engine.internal("parseWeekend", JSON.stringify([req.weekend]));
    default:
      return engine.callValue(op, JSON.stringify(req));
  }
}

function replayVectors(engine, maxDiffs) {
  const doc = JSON.parse(readFileSync(VECTORS, "utf8"));
  const failures = [];
  let passed = 0;
  let mismatched = 0;
  for (const c of doc.cases) {
    const out = [];
    let actual;
    try {
      actual = runVector(engine, c.op, c.req);
    } catch (e) {
      out.push(`threw ${e && e.message ? e.message : e}`);
    }
    if (actual !== undefined) {
      partialMatch(c.id, c.expect, actual, out);
      for (const [key, suffix] of Object.entries(c.endsWith ?? {})) {
        const got = actual?.result?.[key];
        if (typeof got !== "string" || !got.endsWith(suffix)) {
          out.push(`${c.id}.result.${key}: ${excerpt(JSON.stringify(got), 200)} does not end with ${JSON.stringify(suffix)}`);
        }
      }
    }
    if (out.length === 0) {
      passed++;
    } else {
      mismatched++;
      if (failures.length < maxDiffs) failures.push({ id: c.id, op: c.op, problems: out.slice(0, 5) });
    }
  }
  return { total: doc.cases.length, passed, mismatched, failures };
}

// Request-boundary cases (golden.json holds no invalid_request case by design).
// Each outcome was taken from the Rust bridge fed JSON.stringify(req), which is
// the JS mirror's contract. true = expect invalid_request, false = expect any
// other envelope.
const BOUNDARY = [
  ["calc_days_between", '{"startDate":"2024-01-01","endDate":"2024-01-02","extra":1}', true],
  ["calc_days_between", '{"startDate":"2024-01-01","endDate":"2024-01-02","extra":null}', true],
  ["calc_days_between", '["2024-01-01"]', true],
  ["calc_days_between", "null", true],
  ["calc_days_between", "{}", false],
  ["calc_days_between", '{"startDate":null}', true],
  ["calc_days_between", '{"startDate":1}', true],
  ["calc_days_between", '{"includeEndDay":"true"}', true],
  ["calc_days_between", '{"startDate":"\\ud800"}', true],
  ["calc_days_between", `{"startDate":"${" ".repeat(1014)}2024-01-01","endDate":"2024-01-02"}`, false],
  ["calc_days_between", `{"startDate":"${" ".repeat(1015)}2024-01-01","endDate":"2024-01-02"}`, true],
  ["calc_days_between", `{"startDate":"${"\\u00e9".repeat(512)}","endDate":"2024-01-02"}`, false],
  ["calc_days_between", `{"startDate":"${"\\u00e9".repeat(512)}x","endDate":"2024-01-02"}`, true],
  ["calc_days_between", `{"startDate":"${"\\ud83d\\ude00".repeat(256)}x","endDate":"2024-01-02"}`, true],
  ["calc_add_subtract", '{"date":"2024-01-01"}', true],
  ["calc_add_subtract", '{"date":"2024-01-01","operation":"ADD"}', true],
  ["calc_add_subtract", '{"date":"2024-01-01","operation":{"add":null}}', true],
  ["calc_add_subtract", '{"date":"2024-01-01","operation":"add","calendar":{"weekends":[6]}}', true],
  ["calc_add_subtract", `{"date":"2024-01-01","operation":"add","calendar":{"excludedHolidays":{"eg":["${"x".repeat(1025)}"]}}}`, true],
  ["calc_add_subtract", `{"date":"2024-01-01","operation":"add","calendar":{"excludedHolidays":{"eg":["${"x".repeat(1024)}"]}}}`, false],
  ["calc_age", '{"birthDate":"2000-01-01","asOfDate":"2024-01-01","leapDayRule":"MAR1"}', true],
  ["calc_date_info", '{"date":"2024-01-01","today":null}', false],
  ["calc_date_info", '{"date":"2024-01-01","today":5}', true],
  ["calc_countdown", '{"now":{"date":"2026-11-16","time":"10:00","tz":"x"}}', true],
  ["calc_countdown", '{"now":{"date":"2026-11-16","time":"10:00","utcOffsetMinutes":-0}}', false],
  ["calc_countdown", '{"now":{"date":"2026-11-16","time":"10:00","utcOffsetMinutes":1.5}}', true],
  ["calc_countdown", '{"now":null}', true],
  ["month_grid", '{"year":2026}', true],
  ["month_grid", '{"year":2026,"month":11,"firstDayOfWeek":"Sunday"}', true],
  ["month_grid", '{"year":9223372036854775807,"month":11}', true],
  ["month_grid", '{"year":-9223372036854775808,"month":11}', true],
  ["month_grid", '{"year":1e3,"month":11}', false],
  ["validate_calendar", '{"calendar":null}', true],
  ["validate_calendar", '{"calendar":[[6,7]]}', true],
  ["validate_calendar", '{"calendar":{"weekend":[6.5]}}', true],
  ["validate_calendar", '{"calendar":{"preset":{"us":null}}}', true],
  ["validate_calendar", '{"calendar":{"schemaVersion":1.0}}', false],
  ["validate_calendar", '{"calendar":{"hijriOverrides":[{"hijriYear":1446,"event":"eidAlFitr"}]}}', true],
  ["validate_calendar", '{"calendar":{"customHolidays":[{"id":"c-0123abcd","kind":"yearly","month":5,"day":5}]}}', true],
  ["validate_calendar", '{"calendar":{"customHolidays":[{"id":"c-0123abcd","name":"X","kind":"yearly","month":5,"day":5,"enabled":null}]}}', true],
  ["validate_calendar", '{"calendar":{"customHolidays":[{"id":"c-0123abcd","name":"X","kind":"weekly","month":5,"day":5}]}}', true],
  ["unknown_op", "{}", true],
];

function replayBoundary(engine, maxDiffs) {
  const failures = [];
  let passed = 0;
  for (const [op, reqText, expectInvalid] of BOUNDARY) {
    let res;
    try {
      res = engine.callValue(op, reqText);
    } catch (e) {
      res = { threw: String(e) };
    }
    const isInvalid = res.ok === "false" && res.error && res.error.code === "invalid_request";
    if (isInvalid === expectInvalid && (res.ok === "true" || res.ok === "false")) {
      passed++;
    } else if (failures.length < maxDiffs) {
      failures.push({ op, req: excerpt(reqText, 160), expectInvalid, got: excerpt(JSON.stringify(res), 200) });
    }
  }
  return { total: BOUNDARY.length, passed, failures };
}

function childMain(opts) {
  const html = readFileSync(MOBILE_HTML, "utf8");
  const slice = extractSlice(html);
  const engine = loadEngine(slice);
  const started = process.hrtime.bigint();
  const golden = replayGolden(engine, opts.maxDiffs);
  const vectors = replayVectors(engine, opts.maxDiffs);
  const boundary = replayBoundary(engine, opts.maxDiffs);
  const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
  const tzProbe = new Date(Date.UTC(2024, 0, 1)).getTimezoneOffset();
  process.stdout.write(
    JSON.stringify({ tz: process.env.TZ ?? null, tzOffsetJan2024: tzProbe, version: engine.version(), ms, golden, vectors, boundary }),
  );
}

// ---------------------------------------------------------------------------
// Parent: static checks + one child per time zone
// ---------------------------------------------------------------------------

function printFailures(report, maxDiffs) {
  const g = report.golden;
  for (const msg of g.layout) console.error(`    layout: ${msg}`);
  if (g.layoutCount > g.layout.length) console.error(`    … and ${g.layoutCount - g.layout.length} more layout problems`);
  for (const f of g.failures.slice(0, maxDiffs)) {
    console.error(`    golden case #${f.idx} ${f.op} (first difference at byte ${f.offset})`);
    console.error(`      req : ${f.req}`);
    console.error(`      want: ${f.want}`);
    console.error(`      got : ${f.got}`);
  }
  for (const f of report.vectors.failures.slice(0, maxDiffs)) {
    console.error(`    vector ${f.id} (${f.op})`);
    for (const p of f.problems) console.error(`      ${p}`);
  }
  for (const f of report.boundary.failures.slice(0, maxDiffs)) {
    console.error(`    boundary ${f.op} ${f.req}`);
    console.error(`      expected ${f.expectInvalid ? "invalid_request" : "a non-invalid_request envelope"}, got ${f.got}`);
  }
}

function parentMain(opts) {
  const html = readFileSync(MOBILE_HTML, "utf8");
  const slice = extractSlice(html);
  const summary = { ok: true, staticProblems: [], cspProblems: [], zones: [] };

  summary.staticProblems = staticChecks(slice);
  summary.cspProblems = cspChecks(html);
  console.log(`check-mobile: engine slice ${Buffer.byteLength(slice, "utf8").toLocaleString("en-US")} bytes`);
  if (summary.staticProblems.length === 0) {
    console.log("  static bans: ok (no Date/Intl/clock/locale/random/storage/DOM/dynamic code)");
  } else {
    summary.ok = false;
    for (const p of summary.staticProblems) console.error(`  static: ${p}`);
  }
  if (summary.cspProblems.length === 0) {
    console.log("  CSP: inline <style> and <script> hashes pinned, reference directives, no frame-ancestors: ok");
  } else {
    summary.ok = false;
    for (const p of summary.cspProblems) console.error(`  csp: ${p}`);
  }
  summary.hygiene = [];
  for (const [label, problems] of hygieneChecks(html)) {
    summary.hygiene.push({ check: label, problems });
    if (problems.length === 0) {
      console.log(`  ${label}: ok`);
    } else {
      summary.ok = false;
      console.error(`  ${label}: FAIL`);
      for (const p of problems.slice(0, opts.maxDiffs)) console.error(`    ${p}`);
      if (problems.length > opts.maxDiffs) console.error(`    … and ${problems.length - opts.maxDiffs} more`);
    }
  }

  for (const tz of TIME_ZONES) {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--child", "--max-diffs", String(opts.maxDiffs), "--html", MOBILE_HTML],
      { env: { ...process.env, TZ: tz }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (child.status !== 0 || child.error) {
      summary.ok = false;
      console.error(`  TZ=${tz}: child failed (status ${child.status})`);
      console.error(child.error ? String(child.error) : child.stderr);
      summary.zones.push({ tz, error: child.error ? String(child.error) : child.stderr });
      continue;
    }
    const report = JSON.parse(child.stdout);
    const g = report.golden;
    const v = report.vectors;
    const bd = report.boundary;
    const zoneOk =
      g.passed === g.total &&
      g.total === g.expected &&
      g.expected === EXPECTED_GOLDEN_CASES &&
      g.layoutCount === 0 &&
      v.mismatched === 0 &&
      bd.passed === bd.total &&
      report.version === ENGINE_VERSION;
    console.log(
      `  TZ=${tz} (host offset ${report.tzOffsetJan2024} min): golden ${g.passed.toLocaleString("en-US")}/${g.expected.toLocaleString("en-US")}, ` +
        `vectors ${v.passed}/${v.total}, boundary ${bd.passed}/${bd.total}, ${report.ms} ms — ${zoneOk ? "ok" : "FAIL"}`,
    );
    if (!zoneOk) {
      summary.ok = false;
      if (g.expected !== EXPECTED_GOLDEN_CASES) {
        console.error(`    golden.json has ${g.expected} cases; this gate expects ${EXPECTED_GOLDEN_CASES}`);
      }
      if (report.version !== ENGINE_VERSION) console.error(`    DateCore.ENGINE_VERSION is ${report.version}`);
      printFailures(report, opts.maxDiffs);
    }
    summary.zones.push({
      tz,
      ok: zoneOk,
      golden: { passed: g.passed, total: g.expected, perOp: g.perOp },
      vectors: { passed: v.passed, total: v.total },
      boundary: { passed: bd.passed, total: bd.total },
      ms: report.ms,
    });
  }

  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(summary.ok ? "check-mobile: PASS" : "check-mobile: FAIL");
  process.exitCode = summary.ok ? 0 : 1;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.html) MOBILE_HTML = opts.html;
if (opts.child) childMain(opts);
else parentMain(opts);
