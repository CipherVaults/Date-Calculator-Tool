#!/usr/bin/env node
// Zero-dependency icon generator for Date Calculator Tool.
// Draws a square-cornered calendar glyph in the shared CipherVaults "dark terminal"
// palette and writes PNG files with a hand-rolled encoder (zlib from Node core only).
//
//   node scripts/generate-icons.mjs            -> writes every icon file
//   node scripts/generate-icons.mjs --favicon  -> also prints a 64px PNG data URI
//
// After running, generate the Tauri set with:
//   cargo tauri icon assets/icon-source-1024.png -o src-tauri/icons
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PALETTE = {
  bg: [0x0e, 0x0f, 0x12],
  surface: [0x16, 0x18, 0x22],
  cell: [0x2a, 0x2d, 0x35],
  gold: [0xe9, 0xa7, 0x15],
  green: [0x94, 0xc5, 0x9a],
  ring: [0xcb, 0xd5, 0xe6],
};

// Glyph geometry in a 1024-unit design space (square corners everywhere).
// Each entry: [x0, y0, x1, y1, color]. Later entries paint over earlier ones.
function glyphRects() {
  const r = [];
  // Calendar body with a gold outline (outline drawn as a filled rect, body inset).
  r.push([176, 232, 848, 848, PALETTE.gold]);
  r.push([212, 268, 812, 812, PALETTE.surface]);
  // Gold header bar.
  r.push([212, 268, 812, 404, PALETTE.gold]);
  // Ring tabs rising above the header.
  r.push([318, 168, 370, 320, PALETTE.ring]);
  r.push([654, 168, 706, 320, PALETTE.ring]);
  // 4 x 3 day-cell grid; one highlighted cell in the secondary green.
  const gx0 = 260, gx1 = 764, gy0 = 452, gy1 = 764, gap = 24;
  const cw = (gx1 - gx0 - gap * 3) / 4;
  const ch = (gy1 - gy0 - gap * 2) / 3;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const x0 = gx0 + col * (cw + gap);
      const y0 = gy0 + row * (ch + gap);
      const color = row === 1 && col === 2 ? PALETTE.green : PALETTE.cell;
      r.push([x0, y0, x0 + cw, y0 + ch, color]);
    }
  }
  return r;
}

// Render at `size` px. `scale` is the glyph size relative to the canvas (1 = 1024 design
// units mapped onto the full canvas). The glyph is centred. 4x4 supersampling.
function render(size, scale) {
  const SS = 4;
  const big = size * SS;
  const buf = new Float64Array(big * big * 3);
  for (let i = 0; i < big * big; i++) {
    buf[i * 3] = PALETTE.bg[0];
    buf[i * 3 + 1] = PALETTE.bg[1];
    buf[i * 3 + 2] = PALETTE.bg[2];
  }
  const unit = (big * scale) / 1024;
  const offset = (big - big * scale) / 2;
  for (const [x0, y0, x1, y1, c] of glyphRects()) {
    const px0 = Math.max(0, Math.round(offset + x0 * unit));
    const py0 = Math.max(0, Math.round(offset + y0 * unit));
    const px1 = Math.min(big, Math.round(offset + x1 * unit));
    const py1 = Math.min(big, Math.round(offset + y1 * unit));
    for (let y = py0; y < py1; y++) {
      for (let x = px0; x < px1; x++) {
        const k = (y * big + x) * 3;
        buf[k] = c[0];
        buf[k + 1] = c[1];
        buf[k + 2] = c[2];
      }
    }
  }
  // Box-filter downsample to RGBA (fully opaque).
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const k = ((y * SS + sy) * big + (x * SS + sx)) * 3;
          r += buf[k];
          g += buf[k + 1];
          b += buf[k + 2];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function write(rel, size, scale) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  const png = encodePng(size, render(size, scale));
  writeFileSync(path, png);
  console.log(`${rel}  ${size}x${size}  ${png.length} bytes`);
  return png;
}

write("assets/icon-source-1024.png", 1024, 0.92);
write("assets/icon.png", 256, 0.92);
write("mobile/icons/icon-192.png", 192, 0.86);
write("mobile/icons/icon-512.png", 512, 0.86);
write("mobile/icons/icon-maskable-512.png", 512, 0.62);
write("mobile/icons/apple-touch-icon.png", 180, 0.8);

if (process.argv.includes("--favicon")) {
  const fav = encodePng(64, render(64, 0.96));
  console.log(`\nfavicon data URI (64px):\ndata:image/png;base64,${fav.toString("base64")}`);
}
