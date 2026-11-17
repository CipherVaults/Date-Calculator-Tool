#!/usr/bin/env node
// Zero-dependency local server for the Mobile & Web PWA.
//
// Serves mobile/ at http://127.0.0.1:8787/Date-Calculator-Tool/ so the
// service-worker scope, manifest scope and install flow behave as they do on
// GitHub Pages (https://ciphervaults.github.io/Date-Calculator-Tool/).
// Binds to 127.0.0.1 only. Read-only: GET and HEAD, regular files inside
// mobile/ only, no directory listings, no symlinks out of the folder.
//
//   node scripts/serve-mobile.mjs [--port N]

import { createServer } from "node:http";
import { realpathSync, statSync, createReadStream } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOBILE_DIR = realpathSync(join(ROOT, "mobile"));
const HOST = "127.0.0.1";
const BASE = "/Date-Calculator-Tool/";

function parsePort(argv) {
  const i = argv.indexOf("--port");
  if (i < 0) return 8787;
  const n = Number.parseInt(argv[i + 1], 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error("--port needs a number between 1 and 65535");
  }
  return n;
}

const PORT = parsePort(process.argv.slice(2));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function send(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  res.end(text);
}

// Maps a request path to a regular file inside mobile/, or null.
function resolveFile(pathname) {
  if (!pathname.startsWith(BASE)) return null;
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(BASE.length));
  } catch {
    return null;
  }
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  if (rel.includes("\0") || rel.includes("\\")) return null;
  const candidate = resolve(MOBILE_DIR, rel);
  if (!candidate.startsWith(MOBILE_DIR + sep)) return null;
  try {
    const real = realpathSync(candidate);
    if (!real.startsWith(MOBILE_DIR + sep)) return null;
    const st = statSync(real);
    return st.isFile() ? { path: real, size: st.size } : null;
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method Not Allowed\n", { Allow: "GET, HEAD" });
    return;
  }
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    send(res, 400, "Bad Request\n");
    return;
  }
  if (url.pathname === "/" || url.pathname === BASE.slice(0, -1)) {
    send(res, 302, `Found: ${BASE}\n`, { Location: BASE });
    return;
  }
  const file = resolveFile(url.pathname);
  if (!file) {
    send(res, 404, "Not Found\n");
    return;
  }
  const type = MIME[extname(file.path).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": String(file.size),
    // Revalidate every load, like a fresh deploy: the service worker owns caching.
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file.path);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${MOBILE_DIR} at http://${HOST}:${PORT}${BASE}`);
  console.log("Press Ctrl+C to stop.");
});
