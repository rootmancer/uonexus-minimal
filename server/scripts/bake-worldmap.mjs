#!/usr/bin/env node
// bake-worldmap.mjs — server-side pre-render of the UO radar map.
//
// Reads the shard's map<N>.mul + statics<N>.mul + staidx<N>.mul + radarcol.mul
// and writes /<gamefiles>/MapsCache/map<N>_sz_<mapLen>_<staticLen>.png.
//
// The on-disk PNG is the same fingerprint shape the client computes in
// WorldMapGump.LoadMap (v0.4.70+: `mapLen + staticLen` from FileReader.Length).
// When the client hits the WorldMap button, it builds the same filename + tries
// fetch '/server-<N>/maps/<filename>' BEFORE falling back to the local 30-90 s
// rebuild. So this script is what closes the cold-cache cost — the client only
// rebuilds when the server hasn't baked, NEVER as the primary path.
//
// Algorithm parity: ported line-for-line from WorldMapGump.LoadMap C# logic
// (lines 1186-1327 at v0.4.98). Differences documented inline.
//
// One concession: GameObject.CanBeDrawn() static filter is NOT replicated.
// That filter hides "nodraw" statics (e.g. spawn markers) from the radar map.
// A pre-baked PNG may include a few of those; visually a non-issue for
// 99% of shards. Replicating it would require parsing tiledata.mul +
// hardcoded special-case graphic IDs — punted as future work if any shard
// complains.
//
// Usage:
//   node bake-worldmap.mjs --gamefiles <dir> --out <dir> --map <0..5>
//   node bake-worldmap.mjs --gamefiles <dir> --out <dir> --all
//
//   --gamefiles    directory containing map<N>.mul, statics<N>.mul,
//                  staidx<N>.mul, radarcol.mul (lowercase, the
//                  feedback_gamefiles_lowercase_symlinks rule)
//   --out          output directory (created if missing). PNGs written
//                  as map<N>_sz_<mapLen>_<staticLen>.png
//   --map <N>      bake one specific map (0..5)
//   --all          bake all maps that have map<N>.mul present
//   --force        re-bake even if a PNG with the matching fingerprint
//                  already exists (default: skip up-to-date PNGs)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

// ── Map size table ────────────────────────────────────────────────────────────
// Default sizes per MapLoader.cs MapsDefaultSize (v0.4.98). The script falls
// back to inferring width × height from the file size for shards that use
// non-standard maps — see resolveMapSize().
const DEFAULT_MAP_SIZES = [
  [7168, 4096],  // 0 — Felucca
  [7168, 4096],  // 1 — Trammel
  [2304, 1600],  // 2 — Ilshenar
  [2560, 2048],  // 3 — Malas
  [1448, 1448],  // 4 — Tokuno
  [1280, 4096],  // 5 — Ter Mur
];

// MapLoader.cs line 230: older clients use 6144x4096 for maps 0+1. If
// the .mul file size matches that, we use the legacy size.
const LEGACY_MAP_01_SIZE = [6144, 4096];

const MAP_BLOCK_BYTES = 196;   // 4-byte header + 64 cells × 3 bytes
const STAIDX_ENTRY_BYTES = 12; // offset (u32) + length (i32) + extra (u32)
const STATIC_BYTES = 7;        // graphic (u16) + X (u8) + Y (u8) + Z (i8) + hue (u16)

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { gamefiles: null, out: null, map: null, all: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gamefiles') args.gamefiles = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--map') args.map = parseInt(argv[++i], 10);
    else if (a === '--all') args.all = true;
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`bake-worldmap.mjs — pre-render UO radar maps to PNG`);
  console.log(``);
  console.log(`Usage:`);
  console.log(`  node bake-worldmap.mjs --gamefiles <dir> --out <dir> --map <0..5>`);
  console.log(`  node bake-worldmap.mjs --gamefiles <dir> --out <dir> --all`);
  console.log(``);
  console.log(`Flags:`);
  console.log(`  --gamefiles <dir>   .mul tree (lowercase filenames)`);
  console.log(`  --out <dir>         output PNG directory`);
  console.log(`  --map <0..5>        single map`);
  console.log(`  --all               every map<N>.mul present in --gamefiles`);
  console.log(`  --force             re-bake even if up-to-date PNG exists`);
}

// ── File resolution (lowercase + .mul extension; per feedback memory) ─────────
export function findFile(dir, basename) {
  const candidates = [basename, basename.toLowerCase()];
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (existsSync(p)) return p;
  }
  return null;
}

// ── Map dimensions ────────────────────────────────────────────────────────────
// Infer (width, height) from the .mul file size when it matches a known
// layout. Returns null if unknown — operator must override (future flag).
function resolveMapSize(mapIndex, mapMulSize) {
  // Candidate (width,height) layouts, tried in priority order against the .mul
  // size. For UltimaLive ultra-custom shards (Ultima Adventures map33-36) the
  // index is beyond DEFAULT_MAP_SIZES, so guard the lookup (a raw
  // DEFAULT_MAP_SIZES[33] destructure THREW and silently failed the bake) and
  // fall through to the common layouts. The legacy 6144×4096 is tried for ANY
  // map now (was gated to 0/1) because custom continents are frequently
  // 6144×4096 — e.g. Adventures map33-35 are exactly 768×512 blocks.
  const candidates = [];
  if (mapIndex >= 0 && mapIndex < DEFAULT_MAP_SIZES.length) {
    candidates.push(DEFAULT_MAP_SIZES[mapIndex]);
  }
  candidates.push([7168, 4096], LEGACY_MAP_01_SIZE);
  for (const [w, h] of candidates) {
    if ((w >> 3) * (h >> 3) * MAP_BLOCK_BYTES === mapMulSize) {
      return { width: w, height: h };
    }
  }
  // Last resort: assume a standard width and derive height. Most shard
  // operators only resize Trammel/Felucca height for runUO-style cropped
  // facets — width stays at 7168 (or the legacy 6144). If neither divides
  // evenly, return null and let the caller punt.
  const blocks = mapMulSize / MAP_BLOCK_BYTES;
  if (!Number.isInteger(blocks)) return null;
  for (const w of [7168, 6144]) {
    const widthBlocks = w >> 3;
    if (blocks % widthBlocks === 0) {
      return { width: w, height: (blocks / widthBlocks) * 8 };
    }
  }
  return null;
}

// ── radarcol.mul ──────────────────────────────────────────────────────────────
// Flat array of uint16 LE entries, one per tileID. Entries 0..0x3FFF =
// land tiles; 0x4000..0xFFFF = statics (the 0x4000 offset is added at
// lookup time in the static branch below).
//
// Files smaller than 0x10000*2 are normal — undefined tiles default to 0,
// which CanBeDrawn rejects upstream (Color != 0 gate).
function loadRadarCol(filePath) {
  const buf = readFileSync(filePath);
  const colors = new Uint16Array(0x10000);
  const count = Math.min(buf.length >> 1, 0x10000);
  for (let i = 0; i < count; i++) {
    colors[i] = buf.readUInt16LE(i * 2);
  }
  return colors;
}

// ── Truncated-PNG detection ───────────────────────────────────────────────────
// Validates that a PNG file on disk is a complete, well-formed image by
// checking both the 8-byte signature at the head and the 12-byte IEND
// chunk at the tail. Either of those missing/wrong = the file is a
// partial write (process killed mid-`writeFileSync`, disk full,
// container SIGKILL during shutdown, etc.) and the caller should
// re-bake instead of trusting the existsSync gate.
//
// PNG signature:           89 50 4E 47 0D 0A 1A 0A     (8 bytes)
// IEND chunk (final 12B):  00 00 00 00 49 45 4E 44 AE 42 60 82
//   - length=0, type="IEND", CRC32 of "IEND" = 0xAE426082
//
// Cheap: two seek+read syscalls per existing PNG per tick. Skips full
// file reads or decode. False-positive rate ~zero — a partial PNG
// almost never lands the exact IEND bytes by chance.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
function isValidPng(filePath) {
  let fd = -1;
  try {
    const st = statSync(filePath);
    if (st.size < PNG_SIG.length + PNG_IEND.length) return false;
    fd = openSync(filePath, 'r');
    const head = Buffer.alloc(PNG_SIG.length);
    readSync(fd, head, 0, PNG_SIG.length, 0);
    if (!head.equals(PNG_SIG)) return false;
    const tail = Buffer.alloc(PNG_IEND.length);
    readSync(fd, tail, 0, PNG_IEND.length, st.size - PNG_IEND.length);
    return tail.equals(PNG_IEND);
  } catch {
    return false;
  } finally {
    if (fd !== -1) try { closeSync(fd); } catch { /* ignore */ }
  }
}

// ── Color conversion: ARGB1555 → RGBA8888 ─────────────────────────────────────
// Replicates HuesHelper.Color16To32 expansion. The client ORs 0xFF000000
// over the result to force alpha=255; we bake that in by writing 0xFF
// directly into the alpha byte.
//
// 5-bit channel scaling to 8-bit: c8 = (c5 << 3) | (c5 >> 2). Matches the
// canonical truncation-free expansion the rest of UO clients use.
function color16To32(color16) {
  const r5 = (color16 >> 10) & 0x1F;
  const g5 = (color16 >> 5)  & 0x1F;
  const b5 = (color16     )  & 0x1F;
  const r8 = (r5 << 3) | (r5 >> 2);
  const g8 = (g5 << 3) | (g5 >> 2);
  const b8 = (b5 << 3) | (b5 >> 2);
  return { r: r8, g: g8, b: b8 };
}

// ── The bake itself ───────────────────────────────────────────────────────────
export function bakeMap(mapIndex, gamefilesDir, outDir, force) {
  const mapPath     = findFile(gamefilesDir, `map${mapIndex}.mul`);
  const staticsPath = findFile(gamefilesDir, `statics${mapIndex}.mul`);
  const staidxPath  = findFile(gamefilesDir, `staidx${mapIndex}.mul`);
  const radarPath   = findFile(gamefilesDir, `radarcol.mul`);

  if (!mapPath || !staticsPath || !staidxPath || !radarPath) {
    console.warn(`[bake] map${mapIndex}: missing one of map/statics/staidx/radarcol — skipping`);
    return { skipped: true };
  }

  const mapStat = statSync(mapPath);
  const staticsStat = statSync(staticsPath);
  const mapLen = mapStat.size;
  const staticLen = staticsStat.size;

  // Fingerprint matches the client's: see WorldMapGump.cs:1142.
  const fileName = `map${mapIndex}_sz_${mapLen}_${staticLen}.png`;
  const outPath = path.join(outDir, fileName);

  // v0.5.2: validate the PNG sig + IEND before trusting existsSync.
  // A previous run killed mid-`writeFileSync` leaves a partial file;
  // existsSync alone would skip it forever even though it's broken.
  // The check is two seek+reads, sub-millisecond; the false-positive
  // rate is effectively zero. If invalid, unlink and re-bake.
  if (!force && existsSync(outPath)) {
    if (isValidPng(outPath)) {
      console.log(`[bake] map${mapIndex}: up-to-date (${fileName})`);
      return { skipped: true, outPath };
    }
    console.warn(`[bake] map${mapIndex}: existing PNG ${fileName} is truncated/invalid, re-baking`);
    try { unlinkSync(outPath); } catch { /* ignore — rename below overwrites */ }
  }

  const size = resolveMapSize(mapIndex, mapLen);
  if (!size) {
    console.warn(`[bake] map${mapIndex}: non-standard size (${mapLen} bytes), can't infer dimensions — skipping`);
    return { skipped: true };
  }
  const { width: realWidth, height: realHeight } = size;
  const fixedWidth = realWidth >> 3;
  const fixedHeight = realHeight >> 3;

  console.log(`[bake] map${mapIndex}: ${realWidth}x${realHeight} (${fixedWidth}x${fixedHeight} blocks), mapLen=${mapLen} staticLen=${staticLen}`);
  const startMs = Date.now();

  const radarColors = loadRadarCol(radarPath);
  const mapBuf = readFileSync(mapPath);
  const staidxBuf = readFileSync(staidxPath);
  const staticsBuf = readFileSync(staticsPath);

  // Output image: (realWidth + 2) × (realHeight + 2). The +1 border on
  // each side matches OFFSET_PIX_HALF in the C# algorithm — keeps the
  // map content centered with a 1px black ring for the shading-pass
  // edge handling.
  const OFFSET_PIX = 2;
  const OFFSET_PIX_HALF = 1;
  const imgW = realWidth + OFFSET_PIX;
  const imgH = realHeight + OFFSET_PIX;
  const png = new PNG({ width: imgW, height: imgH, colorType: 6 }); // 6 = RGBA
  png.data.fill(0);

  // Z-buffer (one entry per pixel). sbyte range; we use Int8Array.
  const allZ = new Int8Array(imgW * imgH);

  // ── Land + statics pass ─────────────────────────────────────────────────
  let invalidBlocks = 0;
  for (let bx = 0; bx < fixedWidth; bx++) {
    const mapX = bx << 3;
    for (let by = 0; by < fixedHeight; by++) {
      const mapY = by << 3;
      // map block index uses (bx * fixedHeight + by) ordering — column-
      // major. Both the map.mul and staidx.mul use the same indexing.
      const blockIndex = bx * fixedHeight + by;
      const mapOffset = blockIndex * MAP_BLOCK_BYTES;
      if (mapOffset + MAP_BLOCK_BYTES > mapBuf.length) {
        invalidBlocks++;
        continue;
      }

      // Skip the 4-byte header, read 64 cells of 3 bytes each.
      const cellsOffset = mapOffset + 4;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const cellOffset = cellsOffset + (y * 8 + x) * 3;
          const tileId = mapBuf.readUInt16LE(cellOffset);
          const z = mapBuf.readInt8(cellOffset + 2);

          const pxX = mapX + x + OFFSET_PIX_HALF;
          const pxY = mapY + y + OFFSET_PIX_HALF;
          const pxIdx = pxY * imgW + pxX;

          // Land radar color: lookup at tileId & 0x3FFF, then OR 0x8000.
          const color16 = 0x8000 | radarColors[tileId & 0x3FFF];
          const { r, g, b } = color16To32(color16);

          const dst = pxIdx * 4;
          png.data[dst    ] = r;
          png.data[dst + 1] = g;
          png.data[dst + 2] = b;
          png.data[dst + 3] = 0xFF;
          allZ[pxIdx] = z;
        }
      }

      // Statics for this block.
      const staidxOffset = blockIndex * STAIDX_ENTRY_BYTES;
      if (staidxOffset + STAIDX_ENTRY_BYTES > staidxBuf.length) continue;
      const staticOff = staidxBuf.readUInt32LE(staidxOffset);
      const staticLenBlk = staidxBuf.readInt32LE(staidxOffset + 4);
      // No statics in this block (0xFFFFFFFF offset or zero/neg length).
      if (staticOff === 0xFFFFFFFF || staticLenBlk <= 0) continue;
      if (staticOff + staticLenBlk > staticsBuf.length) continue;
      const numStatics = (staticLenBlk / STATIC_BYTES) | 0;

      for (let s = 0; s < numStatics; s++) {
        const sOff = staticOff + s * STATIC_BYTES;
        const sColor = staticsBuf.readUInt16LE(sOff);
        const sX     = staticsBuf.readUInt8(sOff + 2);
        const sY     = staticsBuf.readUInt8(sOff + 3);
        const sZ     = staticsBuf.readInt8 (sOff + 4);
        const sHue   = staticsBuf.readUInt16LE(sOff + 5);

        // Match C# gates: skip 0 and 0xFFFF. (CanBeDrawn is not replicated
        // — see top-of-file note.)
        if (sColor === 0 || sColor === 0xFFFF) continue;
        // Defensive: sX/sY should always be 0..7 but a malformed shard
        // could ship out-of-bounds values; clamp by skipping.
        if (sX >= 8 || sY >= 8) continue;

        const pxX = mapX + sX + OFFSET_PIX_HALF;
        const pxY = mapY + sY + OFFSET_PIX_HALF;
        const pxIdx = pxY * imgW + pxX;

        if (sZ >= allZ[pxIdx]) {
          // Hue lookup path is rare in practice (static.Hue ≈ 0 for the
          // vast majority of tiles) and would need hues.mul; we approximate
          // by treating hued statics as un-hued — same radar color. The
          // visible difference is sub-pixel for radar-zoom rendering.
          // Operators who need exact parity can post-process the PNG.
          const color16 = 0x8000 | radarColors[(sColor + 0x4000) & 0xFFFF];
          const { r, g, b } = color16To32(color16);

          const dst = pxIdx * 4;
          png.data[dst    ] = r;
          png.data[dst + 1] = g;
          png.data[dst + 2] = b;
          png.data[dst + 3] = 0xFF;
          allZ[pxIdx] = sZ;
        }
      }
    }
  }

  if (invalidBlocks > 0) {
    console.warn(`[bake] map${mapIndex}: ${invalidBlocks} map blocks out of bounds (truncated file?)`);
  }

  // ── Shading pass ────────────────────────────────────────────────────────
  // Per WorldMapGump.cs:1283-1327: compare each pixel's Z with the one
  // below (next row); darken if current is lower, brighten if higher.
  // Black pixels (rgb all zero) skip entirely.
  const MAG_0 = 0.8;   // current pixel lower → darken
  const MAG_1 = 1.25;  // current pixel higher → brighten
  for (let mapY = 1; mapY < realHeight - 1; mapY++) {
    let blockCurrent = (mapY + OFFSET_PIX_HALF) * imgW + OFFSET_PIX_HALF;
    let blockNext    = (mapY + 1 + OFFSET_PIX_HALF) * imgW + OFFSET_PIX_HALF;
    for (let mapX = 1; mapX < realWidth - 1; mapX++) {
      ++blockCurrent;
      const z0 = allZ[blockCurrent];
      const z1 = allZ[blockNext++];
      if (z0 === z1) continue;

      const dst = blockCurrent * 4;
      let r = png.data[dst];
      let g = png.data[dst + 1];
      let b = png.data[dst + 2];
      if (r === 0 && g === 0 && b === 0) continue;

      const mag = z0 < z1 ? MAG_0 : MAG_1;
      png.data[dst    ] = Math.min(0xFF, Math.floor(r * mag));
      png.data[dst + 1] = Math.min(0xFF, Math.floor(g * mag));
      png.data[dst + 2] = Math.min(0xFF, Math.floor(b * mag));
    }
  }

  // ── PNG encode ──────────────────────────────────────────────────────────
  // PNG.pack() returns a Readable stream; collect into a Buffer.
  //
  // v0.5.2: write to <outPath>.tmp, then renameSync to <outPath>. The
  // POSIX rename(2) is atomic — readers either see the old file
  // (existsSync skip if validated) or the fully-written new file,
  // never a partial. Combined with isValidPng()'s sig+IEND check on
  // existing files, a SIGKILL mid-write can no longer leave a
  // permanently broken PNG: any partial .tmp that survives is a
  // FILENAME the existsSync(outPath) check ignores, and the next
  // tick re-bakes the .tmp into a fresh attempt.
  const chunks = [];
  png.pack();
  png.on('data', (c) => chunks.push(c));
  return new Promise((resolve, reject) => {
    png.on('end', () => {
      const buf = Buffer.concat(chunks);
      mkdirSync(outDir, { recursive: true });
      const tmpPath = outPath + '.tmp';
      try {
        writeFileSync(tmpPath, buf);
        renameSync(tmpPath, outPath);
      } catch (e) {
        // Clean up the partial .tmp if writeFileSync failed mid-flight.
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        reject(e);
        return;
      }
      const elapsedMs = Date.now() - startMs;
      console.log(`[bake] map${mapIndex}: wrote ${outPath} (${(buf.length/1024/1024).toFixed(2)} MB) in ${(elapsedMs/1000).toFixed(1)}s`);
      resolve({ written: true, outPath, bytes: buf.length, elapsedMs });
    });
    png.on('error', reject);
  });
}

/**
 * Remove the PNGs a facet baked for a PREVIOUS fileset, in a SINGLE-INSTALL cache.
 *
 * 🚨 EXPORTED BUT DELIBERATELY NOT CALLED BY `bakeMap`, and that restraint is the whole design.
 * `bakeMap` also bakes the POOL cache, which is shared by every hosted shard: there, another
 * generation of the same facet is usually ANOTHER SHARD'S FILESET, live. Measured on production
 * 2026-09-06: map0 with four generations and map1 with five, 27 PNGs against 5 manifests (30 the
 * maximum possible) — tenants, not residue. A prune inside `bakeMap` would have deleted other
 * shards' worldmaps, and I had it written, with a green gate and four caught mutations, before the
 * measurement stopped it. A green gate proves the prune does what it says, not that saying it is
 * correct.
 *
 * The minimal's worker is the caller that CAN use this: `gamefilesDir()` resolves exactly one
 * directory, so that MapsCache belongs to one fileset and nobody else can be holding its old
 * generations. Measured there: 64 MB, of which ~29 (44 %) unreachable.
 *
 * ⚠️ The matcher takes no escapes on purpose. The first version was
 * `new RegExp(\`^map${mapIndex}_sz_\d+_\d+\.png$\`)`, and inside a template literal `\d` is
 * just `d`, so the live pattern was `^map0_sz_d+_d+.png$` and matched NOTHING — it deleted nothing
 * and read exactly like a clean directory. Caught by running it, not by reading it.
 *
 * Returns the names removed, so the caller can say what happened instead of doing it silently.
 */
export function pruneOtherGenerations(outDir, mapIndex, keepName) {
  const prefix = `map${mapIndex}_sz_`;
  const DIGITS = /^[0-9]+$/;
  const isSameFacet = (name) => {
    if (!name.startsWith(prefix) || !name.endsWith('.png')) return false;
    const parts = name.slice(prefix.length, -'.png'.length).split('_');
    return parts.length === 2 && parts.every((p) => DIGITS.test(p));
  };
  const removed = [];
  let names;
  try { names = readdirSync(outDir); } catch { return removed; }
  for (const name of names) {
    if (name === keepName || !isSameFacet(name)) continue;
    try {
      unlinkSync(path.join(outDir, name));
      removed.push(name);
    } catch { /* a cache we cannot tidy is not a reason to fail anything */ }
  }
  return removed;
}

// ── Discovery for --all mode ──────────────────────────────────────────────────
function discoverMaps(gamefilesDir) {
  const found = [];
  for (let i = 0; i < 6; i++) {
    if (findFile(gamefilesDir, `map${i}.mul`)) found.push(i);
  }
  return found;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (!args.gamefiles || !args.out) {
    console.error('--gamefiles and --out are required');
    printHelp();
    process.exit(1);
  }
  if (!args.all && args.map === null) {
    console.error('--map <N> or --all is required');
    printHelp();
    process.exit(1);
  }
  if (!existsSync(args.gamefiles)) {
    console.error(`gamefiles dir does not exist: ${args.gamefiles}`);
    process.exit(1);
  }

  const indices = args.all ? discoverMaps(args.gamefiles) : [args.map];
  if (indices.length === 0) {
    console.error(`no map<N>.mul found under ${args.gamefiles}`);
    process.exit(1);
  }

  let total = 0;
  for (const idx of indices) {
    try {
      const r = await bakeMap(idx, args.gamefiles, args.out, args.force);
      if (r.written) total++;
    } catch (e) {
      console.error(`[bake] map${idx}: ${e?.message ?? e}`);
    }
  }
  console.log(`[bake] done. ${total} PNG(s) written.`);
}

// Only run main() when invoked directly (not when imported by another
// module like asset-worker.mjs). Without this guard, importing
// bakeMap/findFile triggers main(), which immediately exits with
// "--gamefiles and --out are required" and crashes the importing
// process. Bit me in the asset-worker integration round 1.
const __thisFile = fileURLToPath(import.meta.url);
const __entryFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__thisFile === __entryFile) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
