#!/usr/bin/env node
// verify-sri.mjs — fail-fast guardrail against the v0.3.16-incident class
// of bug. Reads the inline integrity manifest from `client/index.html`,
// then for every entry:
//
//   1. Computes SHA-256 of the on-disk file.
//      Aborts if it doesn't match the manifest hash.
//   2. If a `.br` twin exists alongside, brotli-decompresses it and
//      checks the bytes equal the raw file (= the same SHA-256).
//      Aborts if they diverge.
//
// Why both checks: nginx with `brotli_static on` will serve the .br when
// the browser advertises Accept-Encoding: br. The browser auto-decompresses
// and hashes the result against the integrity attribute. If the .br holds
// stale content (build-pipeline kept a previous twin while regenerating
// the .js), the hash mismatch surfaces only at the user's browser as
// "Failed to find a valid digest" — a downstream "Mounting the world…"
// freeze that requires CF cache purges to recover. Fail HERE instead.
//
// Run from build.bat after the brotli-framework regen step. Exits 0 on
// pass, 1 on any mismatch (with a per-file diagnostic).
//
// Usage:
//   node server/scripts/verify-sri.mjs --root client
//
// History: 2026-05-04 incident — `.NET wasm publish` regenerated
// `dotnet.native.g92dlpqo7d.js` with the same fingerprint hash as a prior
// build but different content; the `.br` twin from the old build was
// preserved by `robocopy /XF *.br` and went stale; the integrity
// manifest in `index.html` matched the new .js but nginx kept serving the
// old .br. Browser SRI block, Cloudflare cached the bad .br for 1 year
// (immutable header), full Purge Everything required to recover.

import { readFileSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { createBrotliDecompress } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--root') a.root = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv);
if (!args.root) {
  console.error('usage: verify-sri.mjs --root <client-dir>');
  process.exit(2);
}
const root = resolve(args.root);

// ── 1. Extract the integrity manifest from index.html ─────────────────
// The .NET wasm publish injects a JSON object literal inside <script
// type="importmap-shim"> (or similar) in index.html. We don't try to
// parse the full HTML; we just locate the `"integrity": { ... }` block
// and feed it to JSON.parse. Robust against re-formatting because we
// extract by literal anchor.
const indexPath = join(root, 'index.html');
const html = readFileSync(indexPath, 'utf8');

// v0.3.20: brace-balanced extractor instead of `(\{[\s\S]*?\n\s*\})` regex.
// The regex assumed the closing `}` is preceded by a newline + indent; if
// .NET wasm publish ever emits a single-line minified manifest, the regex
// fails and aborts the build with "no integrity manifest". Walk the chars
// and track depth instead — robust against any whitespace layout.
function extractIntegrityManifest(src) {
  const anchor = '"integrity"';
  const ai = src.indexOf(anchor);
  if (ai < 0) return null;
  // Find the `{` after the anchor (allowing whitespace + colon).
  let i = ai + anchor.length;
  while (i < src.length && /[\s:]/.test(src[i])) i++;
  if (src[i] !== '{') return null;
  // Brace-balanced scan from i. Naively respects strings (so `}` inside
  // a string literal doesn't decrement depth). The integrity values are
  // SHA-256 base64 so don't contain unescaped `}`, but be defensive.
  let depth = 0;
  let inStr = false;
  let escape = false;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const manifestRaw = extractIntegrityManifest(html);
if (!manifestRaw) {
  console.error(`[verify-sri] FATAL: no integrity manifest in ${indexPath}`);
  process.exit(1);
}
let manifest;
try {
  manifest = JSON.parse(manifestRaw);
} catch (e) {
  console.error(`[verify-sri] FATAL: integrity manifest is not valid JSON: ${e.message}`);
  process.exit(1);
}
const entryCount = Object.keys(manifest).length;
console.log(`[verify-sri] manifest from ${indexPath} (${entryCount} entries)`);

// ── 1b. THE SECOND MANIFEST, which this script used to be blind to ────
//
// 🚨 THIS IS THE GAP THAT TOOK PRODUCTION DOWN ON 2026-09-02. There are TWO integrity manifests in
// a bundle, not one: the ~51 entries inlined in index.html, and ~186 more inside the dotnet
// bootstrap (`_framework/dotnet.<fp>.js`, an embedded JSON config between /*json-start*/ and
// /*json-end*/). strip-build-paths rewrote framework bytes, neither manifest was regenerated, and
// the browser blocked all twelve modules with "SRI's integrity checks failed" — canvas black, CUO
// down for everyone. This script printed "all good — matches every on-disk file" while it happened,
// because it had verified the corpus that had not changed.
//
// A verifier reporting success over the wrong corpus is worse than no verifier: it converts "I did
// not check" into "I checked and it is fine". So the framework manifest is read here, from the file
// itself rather than a list, and its entries are verified by the same code path as index.html's.
function extractFrameworkManifest(fwDir, pinned) {
  if (!statSync(fwDir, { throwIfNoEntry: false })?.isDirectory()) return null;
  // The bootstrap is the dotnet.<fp>.js that carries the config — NOT dotnet.native.* or
  // dotnet.runtime.*, which are siblings with confusingly similar names. Identify it by CONTENT
  // (the json-start marker), never by guessing the filename: the fingerprint changes every build.
  // 🚨 AND THE ONE THE PAGE PINS COMES FIRST (audit 2026-09-15). In directory order, an orphan loader left by
  // an interrupted rename was read instead of the live one: "verified 1 raw files … all good" while the
  // live loader's pins went unchecked.
  const names = readdirSync(fwDir);
  if (pinned && names.includes(pinned)) names.sort((a, b) => Number(b === pinned) - Number(a === pinned));
  for (const name of names) {
    if (!/^dotnet\.[^.]+\.js$/.test(name)) continue;
    const src = readFileSync(join(fwDir, name), 'utf8');
    const a = src.indexOf('/*json-start*/');
    const b = src.indexOf('/*json-end*/');
    if (a < 0 || b < a) continue;
    let cfg;
    try {
      cfg = JSON.parse(src.slice(a + '/*json-start*/'.length, b));
    } catch (e) {
      console.error(`[verify-sri] FATAL: ${name} config is not valid JSON: ${e.message}`);
      process.exit(1);
    }
    const out = {};
    for (const group of Object.values(cfg.resources || {})) {
      // `resources.hash` is a plain string (a digest OF the manifest), not a file. Only the list
      // groups hold entries, and only some of those carry a digest — jsModule* deliberately do not.
      if (!Array.isArray(group)) continue;
      for (const r of group) {
        // 🚨 TWO KEY NAMES, AND ASSUMING ONE VERIFIES NOTHING ON THE OTHER BUNDLE. The ClassicUO
        // bundle writes `"hash"`, the TazUO bundle writes `"integrity"` — different SDK versions,
        // same meaning. The first version of this reader looked only for `hash` and returned ZERO
        // entries for tuo while its file held 199 digests. The floor below is what turned that into
        // a loud refusal instead of a silent "verified 50 files, all good", which is precisely the
        // shape of the 2026-09-02 failure it exists to prevent. Read both, and let the floor keep
        // watching: the next SDK bump may rename it again.
        const digest = r && (r.hash || r.integrity);
        if (r && r.name && digest) out[`_framework/${r.name}`] = digest;
      }
    }
    return { file: name, map: out };
  }
  return null;
}

const pinnedLoader = (() => {
  try {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const m = html.match(/_framework\/(dotnet\.[a-z0-9]+\.js)/);
    return m ? m[1] : null;
  } catch { return null; }
})();
const fw = extractFrameworkManifest(join(root, '_framework'), pinnedLoader);
if (fw) {
  const n = Object.keys(fw.map).length;
  console.log(`[verify-sri] manifest from _framework/${fw.file} (${n} entries)`);
  // 🚨 THE FLOOR IS THE POINT, not decoration. This whole extension exists because the script once
  // reported success over a corpus that had not changed; an extractor that quietly returns two
  // entries instead of 185 would reproduce that exactly, with the reassuring line still printed.
  // 185 measured on 2026-09-06 (181 coreAssembly + 3 icu + 1 wasmNative). A real bundle cannot be
  // near-empty, so a collapse is a broken reader, never a small build.
  if (n < 100) {
    console.error(`[verify-sri] FATAL: only ${n} framework entries — the reader is broken, not the `
      + 'bundle. Refusing to report a clean build over a corpus this small.');
    process.exit(1);
  }
} else if (statSync(join(root, '_framework'), { throwIfNoEntry: false })?.isDirectory()) {
  // A _framework directory with no readable bootstrap manifest is a broken bundle, not a web tree.
  // Distinguishing the two is what stops "skipped" from covering a real failure.
  console.error('[verify-sri] FATAL: _framework/ exists but no dotnet bootstrap manifest could be '
    + 'read from it. 185 framework hashes would go unverified.');
  process.exit(1);
} else {
  console.log('[verify-sri] no _framework/ in this tree (portal/web-only) — no framework manifest '
    + 'to verify, and saying so rather than counting it as verified.');
}

// One list, one loop, so a framework entry cannot be verified more weakly than an index one.
const entries = [
  ...Object.entries(manifest).map(([logicalPath, expected]) => ({ src: 'index.html', logicalPath, expected })),
  ...Object.entries(fw?.map ?? {}).map(([logicalPath, expected]) => ({ src: 'framework', logicalPath, expected })),
];

// ── 2. For every (path, sha256) pair, verify on-disk + .br twin ───────
let fails = 0;
let raws = 0;
let twins = 0;
let twinsMatched = 0;
const seen = new Set(); // dedupe via both filename forms (./_framework/... vs ./_framework/<hash>...)

for (const { src: mSrc, logicalPath, expected } of entries) {
  const m = expected.match(/^sha256-([A-Za-z0-9+/=]+)$/);
  if (!m) {
    console.error(`[verify-sri] FAIL [${mSrc}] ${logicalPath}: integrity '${expected}' is not sha256-base64`);
    fails++;
    continue;
  }
  const expectedB64 = m[1];

  // Manifest paths are like "./_framework/dotnet.native.g92dlpqo7d.js" or
  // "./_framework/dotnet.native.js" (the importmap target). The PHYSICAL
  // file only exists at the fingerprinted path — the unsuffixed key is
  // an importmap alias to the same file. Same expected hash either way,
  // so we resolve and dedupe.
  const rel = logicalPath.replace(/^\.\//, '');
  const fsPath = join(root, rel);
  if (!statSync(fsPath, { throwIfNoEntry: false })?.isFile()) {
    // Importmap alias — skip; the fingerprinted path will cover it. Only the PAGE has aliases: a file the
    // loader pins and the bundle lacks is a module that fails at boot (audit 2026-09-15).
    if (mSrc === 'framework') {
      console.error(`[verify-sri] FAIL [framework] ${logicalPath}: pinned by the loader but not in the bundle`);
      fails++;
    }
    continue;
  }
  if (seen.has(fsPath)) continue;
  seen.add(fsPath);
  raws++;

  const raw = readFileSync(fsPath);
  const rawSha = createHash('sha256').update(raw).digest('base64');
  if (rawSha !== expectedB64) {
    console.error(
      `[verify-sri] FAIL [${mSrc}] ${rel}: raw sha256 mismatch ` +
      `(expected sha256-${expectedB64}, got sha256-${rawSha})`
    );
    fails++;
  }

  // Brotli twin check.
  const brPath = fsPath + '.br';
  if (statSync(brPath, { throwIfNoEntry: false })?.isFile()) {
    twins++;
    // v0.3.21 audit fix: stream-decompress + hash incrementally instead
    // of `brotliDecompressSync(readFileSync(brPath))`. Pre-fix held the
    // full 90 MB inflated wasm in RAM at once + the raw .br read on top
    // — fine on a 32 GB dev box but right at the OOM edge of the
    // NAS DSM build worker (256-512 MB). Streaming caps memory at
    // a couple of brotli window buffers (~16 MB).
    let decompSha;
    try {
      const decompHash = createHash('sha256');
      await pipeline(
        createReadStream(brPath),
        createBrotliDecompress(),
        async function* (source) {
          for await (const chunk of source) {
            decompHash.update(chunk);
            yield chunk;
          }
        },
        // Sink: discard decompressed bytes; we only need the hash.
        async (source) => { for await (const _ of source) { /* drain */ } },
      );
      decompSha = decompHash.digest('base64');
    } catch (e) {
      console.error(`[verify-sri] FAIL ${rel}.br: brotli decompress error: ${e.message}`);
      fails++;
      continue;
    }
    if (decompSha !== expectedB64) {
      console.error(
        `[verify-sri] FAIL [${mSrc}] ${rel}.br: decomp sha256 mismatch ` +
        `(expected sha256-${expectedB64}, got sha256-${decompSha}). ` +
        `The .br twin is stale relative to the .js. ` +
        `Run 'node server/scripts/brotli-framework.mjs --in ${dirname(fsPath)}' to regenerate.`
      );
      fails++;
    } else {
      twinsMatched++;
    }
  }
}

// v0.3.20 audit fix: previous logic only verified .br twins that
// HAPPENED to exist, never asserting coverage. If the brotli regen step
// silently failed (e.g. one of the workers crashed mid-pass), a `.js` /
// `.wasm` shipped without its `.br` would pass verify-sri because the
// twin check is `if exists`. Nginx then has no `.br` to serve and falls
// back to raw bytes — a perf regression that's invisible until users
// hit the page on slow connections. Assert that EVERY .js + .wasm under
// _framework/ that's referenced by the manifest has a matching .br twin.
const missingTwins = [];
for (const { logicalPath } of entries) {
  const rel = logicalPath.replace(/^\.\//, '');
  if (!/^_framework\/.*\.(js|wasm)$/.test(rel)) continue;
  const fsPath = join(root, rel);
  if (!statSync(fsPath, { throwIfNoEntry: false })?.isFile()) continue; // alias
  const brPath = fsPath + '.br';
  if (!statSync(brPath, { throwIfNoEntry: false })?.isFile()) {
    missingTwins.push(rel);
  }
}
if (missingTwins.length > 0) {
  console.error(`[verify-sri] FAIL: ${missingTwins.length} _framework asset(s) missing .br twin:`);
  for (const p of missingTwins.slice(0, 10)) console.error(`  ${p}`);
  if (missingTwins.length > 10) console.error(`  ...+${missingTwins.length - 10} more`);
  console.error(`[verify-sri] Re-run 'node server/scripts/brotli-framework.mjs --in <_framework>' to regenerate.`);
  fails++;
}

console.log(`[verify-sri] verified ${raws} raw files, ${twinsMatched}/${twins} matching .br twins`);
if (fails > 0) {
  console.error(`[verify-sri] ${fails} failure(s) — refusing to declare build clean.`);
  process.exit(1);
}
console.log(`[verify-sri] all good — BOTH integrity manifests (index.html + `
  + `${fw ? '_framework/' + fw.file : 'no framework'}) match every on-disk file and .br twin.`);
