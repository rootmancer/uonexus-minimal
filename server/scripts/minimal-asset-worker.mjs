#!/usr/bin/env node
/**
 * minimal-asset-worker.mjs — keep a self-hosted install's game files servable.
 *
 * A self-hoster drops their .mul files into gamefiles/<slug>/ and expects the client to work. Two
 * things have to happen to those bytes afterwards, and neither is obvious from the outside:
 *
 *   1. BROTLI TWINS. nginx serves <file>.br when it exists. Without them everything still works —
 *      brotli_static falls back to the raw file — but a ~2 GB fileset goes over the wire uncompressed
 *      at roughly twice the size. Optional for correctness, large for bandwidth.
 *
 *   2. THE WORLD MAP CACHE. This one is NOT optional. The client's WorldMapGump requests
 *      <base>/MapsCache/map<N>_sz_<mapBytes>_<staticBytes>.png — a name it derives from the sizes of
 *      the player's own map files. Nothing serves that unless someone bakes it, and the symptom is a
 *      world map that never appears, with no error anywhere.
 *
 * 🚨 THIS IS NOT A PORT OF asset-worker.mjs, deliberately. That daemon is 1681 lines because it
 * maintains the content-addressed POOL, the per-shard -web twins, the manifest hashes and a
 * Cloudflare purge — a hosted deployment's asset pipeline. A minimal install has none of that: one
 * directory, served straight off disk. Copying the daemon would drag the pool concept into a build
 * whose entire premise is not to carry it.
 *
 * Idempotent and interruptible: every pass compares mtime/size before doing work, so a container
 * restart mid-run costs one repeated file, never a corrupt one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createBrotliCompress, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { bakeMap, pruneOtherGenerations } from './bake-worldmap.mjs';

const ROOT = process.env.GAMEFILES_ROOT || '/gamefiles-root';
const SLUG = process.env.SHARD_SLUG || '';
const INTERVAL_MS = Math.max(30, Number(process.env.WORKER_INTERVAL_SECS || 120)) * 1000;
// Quality 9, not 11. On a full fileset q11 costs hours and buys a few percent; a self-hoster who
// just dropped in new files wants them served, not a perfect ratio. Measured on the 1.6 GB Pre-AoS
// set: q9 saved 49% and finished in minutes.
const QUALITY = Math.min(11, Math.max(0, Number(process.env.BROTLI_QUALITY || 9)));

/** Extensions worth compressing. Anything already compressed is skipped: .br of a .png is bigger. */
const COMPRESSIBLE = /\.(mul|uop|idx|def|txt|json|xml|csv|enu)$/i;

/** The worker's own sidecar inside the served tree. A dotfile, so nginx 404s it. */
const HASH_STATE = '.gamefile-hashes.json';

const log = (m) => console.log(`[minimal-worker] ${m}`);

function gamefilesDir() {
  if (SLUG) return path.join(ROOT, SLUG);
  // No slug configured: if exactly one directory sits under the root, that is unambiguously it.
  // More than one is a real ambiguity and guessing would compress the wrong shard's files silently.
  const dirs = fs.existsSync(ROOT)
    ? fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  if (dirs.length === 1) return path.join(ROOT, dirs[0]);
  return null;
}

/**
 * Directories that are never game files, skipped by EVERY pass.
 *
 * MapsCache is our own output — walking into it would brotli the PNGs we just baked. @eaDir is the
 * metadata sidecar some NAS filesystems create beside every directory, and it is not hypothetical:
 * on a real fileset it put 360 junk entries into a 720-entry hash map, so HALF of a 70 KB response
 * served on every client boot described thumbnails the client will never request.
 */
const SKIP_DIRS = new Set(['MapsCache', '@eaDir']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); continue; }
    // 🚨 isDirectory() is FALSE for a symlink to a directory, and reading one throws EISDIR — which
    // is exactly what a @eaDir entry did on the live fileset. Only regular files go downstream.
    try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
    out.push(p);
  }
  return out;
}

async function compressPass(dir) {
  let made = 0;
  for (const src of walk(dir)) {
    if (src.endsWith('.br') || !COMPRESSIBLE.test(src)) continue;
    if (path.basename(src) === HASH_STATE) continue;   // ours, not an asset
    const dst = `${src}.br`;
    const s = fs.statSync(src);
    // Stale = missing, or older than the source. mtime alone is enough here: these files are
    // replaced wholesale by an upload, never edited in place.
    let stale = true;
    try { stale = fs.statSync(dst).mtimeMs < s.mtimeMs; } catch { /* missing */ }
    if (!stale) continue;
    // Write to a temp name and rename: nginx may be serving the old twin RIGHT NOW, and a partially
    // written .br is worse than none — it is served with a 200 and fails to decode in the browser.
    const tmp = `${dst}.tmp`;
    try {
      await pipeline(
        fs.createReadStream(src),
        createBrotliCompress({ params: {
          [constants.BROTLI_PARAM_QUALITY]: QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: s.size,
        } }),
        fs.createWriteStream(tmp),
      );
      fs.renameSync(tmp, dst);
      made++;
      log(`br ${path.basename(src)} ${(s.size / 1048576).toFixed(1)}MB -> ${(fs.statSync(dst).size / 1048576).toFixed(1)}MB`);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      log(`br FAILED ${path.basename(src)}: ${e && e.message}`);
    }
  }
  return made;
}

async function mapPass(dir) {
  const out = path.join(dir, 'MapsCache');
  fs.mkdirSync(out, { recursive: true });
  let baked = 0;
  // Facets 0..5. bakeMap resolves the map/statics files itself and no-ops when the PNG whose name
  // encodes the current sizes already exists, so this is cheap once warm and self-healing when a
  // fileset is replaced: new sizes mean a new name, which means a new bake.
  for (let i = 0; i <= 5; i++) {
    try {
      // bakeMap answers {skipped:true} when the PNG is already current or the facet is absent, and
      // resolves the baked result otherwise. BOTH are truthy — counting the return value would have
      // this log claim six bakes on every idle pass, which is worse than no log at all.
      const r = await bakeMap(i, dir, out, false);
      if (r && !r.skipped) baked++;
      // 🚨 DROP THIS FACET'S EARLIER GENERATIONS — and only when the facet RESOLVED.
      //
      // The PNG name encodes the map+static byte sizes, so replacing a fileset produces a new name
      // and leaves the old file behind, unreachable, forever. Measured on dev-minimal 2026-09-06:
      // 64 MB of MapsCache with map0 and map1 each carrying two generations — ~29 MB, 44 %, that
      // nothing can ever serve. It grows once per fileset change and never shrinks, on the
      // self-hoster's disk.
      //
      // Safe HERE and nowhere else: gamefilesDir() resolves exactly ONE directory, so this cache
      // belongs to one fileset. The same prune inside bakeMap would also hit the POOL cache, which
      // is shared across hosted shards — there another generation is usually another shard's
      // fileset, live (measured: 27 PNGs, 5 manifests). That is why the helper is exported and
      // called from here rather than wired into the bake.
      //
      // `r.outPath` is present both when the PNG was just written and when it was already current;
      // a facet the fileset does not carry returns neither, and then nothing is swept for it — a
      // transient read failure must not cost the player a cache.
      if (r && r.outPath) {
        const gone = pruneOtherGenerations(out, i, path.basename(r.outPath));
        if (gone.length) log(`map${i}: dropped ${gone.length} stale PNG(s): ${gone.join(', ')}`);
      }
    } catch (e) { /* a fileset legitimately may not carry every facet */ }
  }
  return baked;
}

/**
 * The SHA-256 map the client's background cache audit checks its cached copies against.
 *
 * Served as /api/servers/<slug>/hashes. Without it the audit skips entirely and a game file that
 * got corrupted in the browser's storage stays corrupted until the player clears it — the symptom
 * being artwork that is wrong for one specific thing and right everywhere else.
 *
 * 🚨 INCREMENTAL, because hashing ~1.6 GB every pass would burn a core forever on a box that is also
 * running a live game proxy. A file is re-hashed only when its size or mtime moved; these files are
 * replaced wholesale by an upload and never edited in place, so that is sufficient here.
 *
 * Written as a DOTFILE on purpose: it sits inside the tree nginx serves, and the /gamefiles/ block
 * 404s dotfiles. The map is not secret — it describes public files — but it is ours, not an asset.
 */

function hashPass(dir) {
  const statePath = path.join(dir, HASH_STATE);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run or corrupt */ }

  const next = {};
  let hashed = 0;
  for (const abs of walk(dir)) {
    // .br twins are derived; the client verifies the RAW bytes it decompressed to. Hashing the
    // compressed form would hand it a value that can never match.
    if (abs.endsWith('.br') || path.basename(abs) === HASH_STATE) continue;
    const st = fs.statSync(abs);
    // The key is the path the CLIENT asks for: relative, forward slashes, lowercased — the same
    // shape it looks up with (hashes[src.toLowerCase()]). Nested paths like music/digital/config.txt
    // are real, so basename alone would silently miss them.
    const key = path.relative(dir, abs).split(path.sep).join('/').toLowerCase();
    const was = prev[key];
    if (was && was.size === st.size && was.mtime === st.mtimeMs) { next[key] = was; continue; }
    try {
      const h = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      next[key] = { h, size: st.size, mtime: st.mtimeMs };
      hashed++;
    } catch (e) {
      log(`hash FAILED ${key}: ${e && e.message}`);
    }
  }

  if (hashed || Object.keys(next).length !== Object.keys(prev).length) {
    // Same atomic write as the brotli twins: the backend may be reading this exact file, and a
    // half-written JSON is served as a parse error rather than as a missing map.
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, statePath);
  }
  return hashed;
}

async function tick() {
  const dir = gamefilesDir();
  if (!dir || !fs.existsSync(dir)) {
    log(`no gamefiles directory yet (root=${ROOT} slug=${SLUG || '(unset)'}) — waiting`);
    return;
  }
  const baked = await mapPass(dir);
  const hashed = hashPass(dir);
  const made = await compressPass(dir);
  if (baked || made || hashed) {
    log(`pass done: ${baked} map(s) baked, ${hashed} file(s) hashed, ${made} brotli twin(s) written`);
  }
}

log(`watching ${ROOT}${SLUG ? `/${SLUG}` : ''} every ${INTERVAL_MS / 1000}s (brotli q${QUALITY})`);
await tick();
setInterval(() => { tick().catch((e) => log(`pass failed: ${e && e.message}`)); }, INTERVAL_MS);
