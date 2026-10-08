// Renders build/icon.svg to build/icon.ico for Windows packaging.
// sharp rasterizes the SVG at each size; the ICO container packs the PNGs
// (PNG-compressed entries are supported by Windows Vista+ and by electron-packager).
import fs from 'node:fs';
import sharp from 'sharp';

const svg = fs.readFileSync(new URL('./icon.svg', import.meta.url));
const sizes = [256, 64, 48, 32, 16];

const pngs = [];
for (const s of sizes) {
  pngs.push(await sharp(svg, { density: 300 }).resize(s, s).png().toBuffer());
}

// ---- ICO container (ICONDIR + ICONDIRENTRY[] + payloads) ----
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);            // reserved
header.writeUInt16LE(1, 2);            // type = icon
header.writeUInt16LE(count, 4);        // image count

let offset = 6 + 16 * count;
const entries = [];
for (let i = 0; i < count; i++) {
  const e = Buffer.alloc(16);
  const s = sizes[i];
  e.writeUInt8(s >= 256 ? 0 : s, 0);   // width (0 = 256)
  e.writeUInt8(s >= 256 ? 0 : s, 1);   // height (0 = 256)
  e.writeUInt8(0, 2);                  // colour palette
  e.writeUInt8(0, 3);                  // reserved
  e.writeUInt16LE(1, 4);               // colour planes
  e.writeUInt16LE(32, 6);              // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8);  // payload size
  e.writeUInt32LE(offset, 12);         // payload offset
  offset += pngs[i].length;
  entries.push(e);
}

const ico = Buffer.concat([header, ...entries, ...pngs]);
fs.writeFileSync(new URL('./icon.ico', import.meta.url), ico);
console.log(`wrote build/icon.ico (${ico.length} bytes, ${count} sizes: ${sizes.join('/')})`);
