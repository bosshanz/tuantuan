/**
 * App icons from the Tuantuan mark (docs/brand/tuantuan-mark.svg): build/icon.png (1024),
 * build/icon.icns (macOS, PNG-chunk icns) and build/icon.ico (Windows, PNG-embedded ico).
 * Rendered with headless Chrome so it matches the SVG exactly. Run: bun desktop/scripts/icons.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const root = join(import.meta.dir, "..", "..");
const out = join(root, "desktop", "build");
mkdirSync(out, { recursive: true });
const svg = readFileSync(join(root, "docs", "brand", "tuantuan-mark.svg"), "utf8");
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
const page = await browser.newPage();

async function render(size: number): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  // macOS-style squircle tile (Big Sur grid: 824/1024 body, centered), warm paper background.
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;display:grid;place-items:center">
      <div style="width:${size * 0.805}px;height:${size * 0.805}px;border-radius:${size * 0.18}px;
        background:linear-gradient(180deg,#fffdf9,#f1ede6);box-shadow:0 ${size * 0.01}px ${size * 0.03}px rgba(0,0,0,.22);
        display:grid;place-items:center">
        <div style="width:${size * 0.6}px;height:${size * 0.6}px">${svg.replace("<svg ", '<svg width="100%" height="100%" ')}</div>
      </div>
    </div></body></html>`);
  return page.screenshot({ omitBackground: true, type: "png" });
}

const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const png: Record<number, Buffer> = {};
for (const s of sizes) png[s] = await render(s);
await browser.close();
writeFileSync(join(out, "icon.png"), png[1024]);
writeFileSync(join(out, "tray.png"), png[64]);

// icns: 'icns' + total length, then [type, length, png] chunks.
const chunks: [string, number][] = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
];
const parts = chunks.map(([t, s]) => {
  const h = Buffer.alloc(8);
  h.write(t, 0, "ascii");
  h.writeUInt32BE(png[s].length + 8, 4);
  return Buffer.concat([h, png[s]]);
});
const body = Buffer.concat(parts);
const head = Buffer.alloc(8);
head.write("icns", 0, "ascii");
head.writeUInt32BE(body.length + 8, 4);
writeFileSync(join(out, "icon.icns"), Buffer.concat([head, body]));

// ico: ICONDIR + entries + PNG blobs (Vista+ reads PNG entries).
const icoSizes = [16, 32, 48, 64, 128, 256];
const dir = Buffer.alloc(6 + 16 * icoSizes.length);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(icoSizes.length, 4);
let offset = dir.length;
icoSizes.forEach((s, i) => {
  const e = 6 + i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, e);
  dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(png[s].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += png[s].length;
});
writeFileSync(join(out, "icon.ico"), Buffer.concat([dir, ...icoSizes.map((s) => png[s])]));
console.log("icons written to", out);
