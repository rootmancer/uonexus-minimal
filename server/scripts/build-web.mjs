// build-web.mjs — FAST web-only rebuild (operator 2026-06-11).
//
// A change to the JS LOADER / web layer (shared-www/main.js, rail.js, rail.css,
// or the pass-through static files) does NOT change the WASM at all — the
// dotnet.native.wasm is byte-identical. But the normal flow runs build.bat →
// `dotnet publish` which force-cold-rebuilds the WASM (~25 min) just to
// re-fingerprint a JS file. This script skips that: it reuses the EXISTING
// _framework (WASM) from the last full build and only re-derives the web assets
// in client/<bundle>/, reproducing exactly the post-publish tail of build.bat:
//   • main.js  → overwrite the deployed main.<hash>.js + run strip-dev-blocks
//                (.ps1 on Windows / .sh on Linux) → re-fingerprint + SRI patch.
//   • rail.js  → content-hash re-fingerprint + SRI patch (no dev-strip).
//   • rail.css → content-hash re-fingerprint (no SRI; plain-named link).
//   • static   → faq/privacy/lib/fonts/bg copied verbatim (no fingerprint).
//   • brotli the changed web files; verify-sri as the hard guardrail.
//
//   • index.html → RE-HOSTED from source (2026-07-26): the page body, its inline
//                <style>/<script>, everything — with the SDK's boot block (dotnet
//                preload + importmap + fingerprinted script srcs) carried over from
//                the previous full build. Landing/CSS edits no longer need build.bat.
//
// SCOPE / LIMITATION: it does NOT re-run the SDK's fingerprinting pass, so a NEW
// <script src="x#[.{fingerprint}].js"> in the source page has no twin to point at —
// that still needs a full build.bat. rehostIndex() detects exactly this case and
// leaves the page untouched with a WARN rather than shipping a dead ref.
//
// Reuses the SAME scripts as build.bat (strip-dev-blocks, brotli-framework,
// verify-sri) so output is identical to a full build's web layer — verify-sri
// refuses to let a wrong SRI ship.
//
// Usage:  node build-web.mjs [--prod] [--client cuo|tuo|both]
//   --prod    strip dev blocks from main.js (matches build.bat prod). Default on.
//   --client  which bundle(s) to refresh. Default: both.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mayReplaceVersion } from './_versionRank.mjs';
import { applyContentNames } from './framework-names.mjs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const SHARED = path.join(REPO, 'source', 'webclient', 'shared-www');
// mini's OWN divergent web (operator 2026-06-27): main.js/index.html (+ tbh-music) live here, NOT shared-www.
// rail.js stays SHARED (one rail — the mini inherits CUO's rail via the __MINI__-gated arm in shared-www/rail.js).
const MINI_OVERRIDES = path.join(REPO, 'source', 'webclient', 'mini-overrides');
// The MINIMAL bundle (self-hostable client) carries its OWN hand-trimmed web layer: no server
// picker, no minigames, no scripting sandbox, no portal. It is a separate tree ON PURPOSE -
// generating it from shared-www would include every future portal block nobody remembered to
// mark, which is exactly what this repo must not ship to self-hosters.
const MINIMAL_WWW = path.join(REPO, 'source', 'webclient', 'minimal-www');
/** Which web tree a bundle builds its main/rail/index from. */
const isMinimal = (b) => b === 'minimal' || b === 'minimal-tuo';
/**
 * Which tree a bundle takes its PAGE from. The mini has its own index.html and nothing else.
 */
const pageSrcFor = (bundle) => (isMinimal(bundle) ? MINIMAL_WWW
  : bundle === 'mini' ? MINI_OVERRIDES : SHARED);
/**
 * Which tree a bundle takes main.js / rail.js / rail.css from.
 *
 * 🚨 NOT the same answer as pageSrcFor, and conflating them broke the mini build outright. The mini
 * overrides ONLY index.html: its main.js was deleted on 2026-07-30 when the fork collapsed back onto
 * the shared loader, so resolving these three through the page tree made `--client mini` die with
 * ENOENT on mini-overrides/main.js. A bundle that cannot be rebuilt silently stops receiving every
 * web-layer fix, which is exactly what a shared loader was meant to prevent.
 */
const appSrcFor = (bundle) => (isMinimal(bundle) ? MINIMAL_WWW : SHARED);
const isWin = process.platform === 'win32';

const argv = process.argv.slice(2);
const PROD = !argv.includes('--no-prod'); // prod (strip) by default
let which = 'both';
for (let i = 0; i < argv.length; i++) if (argv[i] === '--client') which = (argv[i + 1] || 'both').toLowerCase();
// 🚨 `--client minimal` REFRESHES EVERY INSTALLED MINIMAL BUNDLE, not just client/minimal.
//
// Both minimal bundles are built from the SAME hand-written source (source/webclient/minimal-www),
// so an edit there belongs in both — but this line used to build one of them, and nothing tied the
// two together. The result, reported 2026-08-26: the Play panel added to minimal-www reached
// client/minimal and never reached client/minimal-tuo, so enabling TazUO auto-booted straight into
// the game with no landing at all. Nothing errored; the TUO bundle simply stopped receiving fixes.
// Same shape as `build-web --client mini` sitting broken for weeks — a bundle that is not rebuilt
// is invisible, because nothing renders wrong and nothing 500s.
//
// Targeting one on purpose is still possible with `--client minimal-tuo`.
const minimalFamily = () => ['minimal', 'minimal-tuo']
  .filter((b) => fs.existsSync(path.join(REPO, 'client', b)));
const BUNDLES = which === 'cuo' ? ['cuo'] : which === 'tuo' ? ['tuo'] : which === 'mini' ? ['mini']
  : which === 'minimal' ? minimalFamily() : which === 'minimal-tuo' ? ['minimal-tuo'] : ['cuo', 'tuo']; // mini only via explicit --client mini (operator 2026-06-27); default 'both' stays cuo/tuo
// --web-tree: build ONLY the shared client/web/ portal (buildWebTree), skipping all
// per-client work + verify-sri. The web portal is DECOUPLED from the game clients and
// has its own deploy (tools/deploy-web.*), so it rebuilds independently (operator 2026-06-28).
const WEB_TREE_ONLY = argv.includes('--web-tree');

const sha256b64 = (buf) => crypto.createHash('sha256').update(buf).digest('base64');
const token10 = (buf) => sha256b64(buf).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 10);
const brotli = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const log = (m) => console.log(`[build-web] ${m}`);


// -- inline <script> syntax check ---------------------------------------------
// admin.html shipped BROKEN for three releases (v0.9.525-527): a literal newline
// inside a double-quoted JS string killed the whole first <script> block, so every
// button in the console was dead. Nothing caught it -- `node --check` does not accept
// .html, and the audit that looked at this file counted <script> tags and balanced
// <div>s, which is not syntax checking. Extract each inline block and check it for
// real; a failure aborts the build rather than reaching production.
function checkInlineScripts(file) {
  if (!fs.existsSync(file)) return;
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let js = 0, json = 0;
  const jsBodies = [];
  for (const [i, m] of [...html.matchAll(re)].entries()) {
    const attrs = m[1] || '';
    const body = m[2];
    const type = (attrs.match(/type\s*=\s*["']?([^"'\s>]+)/i) || [, ''])[1].toLowerCase();
    // Not every inline <script> is JavaScript. index.html carries a `type="importmap"`,
    // which is JSON -- checking that as JS reports a bogus "Unexpected token ':'" and
    // would fail every build. Validate each block as what it actually is.
    if (type.includes('json') || type === 'importmap' || type === 'speculationrules') {
      try { JSON.parse(body); json++; } catch (e) {
        throw new Error('inline <script type="' + type + '"> #' + i + ' in '
          + path.basename(file) + ' is not valid JSON: ' + e.message);
      }
      continue;
    }
    if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') continue;
    const tmp = path.join(os.tmpdir(), 'bw-inline-' + process.pid + '-' + i + '.js');
    fs.writeFileSync(tmp, body);
    try {
      // A module body may legally use import/export, which the default CommonJS parse
      // rejects. Tell node which grammar to apply.
      const args = type === 'module' ? ['--check', '--input-type=module'] : ['--check'];
      execFileSync(process.execPath, [...args, tmp], { stdio: 'pipe' });
      js++;
      jsBodies.push(body);
    } catch (e) {
      const detail = (e.stderr ? e.stderr.toString() : String(e)).split('\n').slice(0, 6).join('\n');
      throw new Error('inline <script> #' + i + ' in ' + path.basename(file) + ' does not parse:\n' + detail);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  }
  if (js || json) log('verified ' + js + ' inline script(s) + ' + json + ' json block(s) in ' + path.basename(file));
  // Syntax was only half the story. An inline block can parse perfectly and still reference
  // a name nothing declares — the same class that took the achievements list down, and just
  // as invisible, since the page still loads and the error goes to a silenced console. Run
  // the scope analyser over the concatenated JS blocks. The temp file is named after the
  // page so check-js-scope's per-file KNOWN list can carry the cross-script globals these
  // pages legitimately rely on (window.CardUI from cards-ui.js).
  if (jsBodies.length) {
    const tmp = path.join(os.tmpdir(), 'inline-' + path.basename(file) + '.js');
    fs.writeFileSync(tmp, jsBodies.join(String.fromCharCode(10)));
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'check-js-scope.mjs'), tmp],
                   { stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      if (e.stdout) process.stdout.write(e.stdout);
      if (e.stderr) process.stderr.write(e.stderr);
      throw new Error('inline <script> in ' + path.basename(file)
        + ' references a name that nothing declares (see above).');
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  }
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: REPO });
}

// Re-fingerprint a plain SDK-fingerprinted JS asset (rail.js): write
// <base>.<newhash>.js (+.br), patch index.html refs + the on-disk integrity
// entry, drop the old fingerprinted file. Mirrors strip-dev-blocks's index.html
// edits (verify-sri only checks physically-present fingerprinted files; the
// "./<base>.js" plain alias entry is skipped, so leaving it stale is safe —
// the browser resolves via the importmap to the fingerprinted target).
function refingerprintJs(clientDir, base, newRaw) {
  const indexPath = path.join(clientDir, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const re = new RegExp(`${base}\\.[a-z0-9]+\\.js`);
  const m = html.match(re);
  if (!m) { log(`  WARN: no ${base}.<hash>.js ref in index.html — skipping ${base}.js`); return false; }
  const oldName = m[0];
  const oldBuf = (() => { try { return fs.readFileSync(path.join(clientDir, oldName)); } catch { return null; } })();
  if (oldBuf && oldBuf.equals(newRaw)) { log(`  ${base}.js unchanged — skip`); return false; }
  const newName = `${base}.${token10(newRaw)}.js`;
  const integrity = `sha256-${sha256b64(newRaw)}`;
  // Write new file + brotli twin.
  fs.writeFileSync(path.join(clientDir, newName), newRaw);
  fs.writeFileSync(path.join(clientDir, newName + '.br'), brotli(newRaw));
  // Patch index.html: update the fingerprinted-name integrity VALUE, then rename
  // every occurrence old→new (importmap value, integrity key, <script src>).
  const rxEntry = new RegExp(`"\\./${oldName.replace(/\./g, '\\.')}":\\s*"sha256-[A-Za-z0-9+/=]+"`);
  html = html.replace(rxEntry, `"./${oldName}": "${integrity}"`);
  html = html.split(oldName).join(newName);
  fs.writeFileSync(indexPath, html);
  // Drop the stale fingerprinted file + twin.
  for (const f of [oldName, oldName + '.br']) { try { fs.unlinkSync(path.join(clientDir, f)); } catch { /* gone */ } }
  log(`  ${base}.js → ${newName} (+.br); index.html refs + integrity updated`);
  return true;
}

// Fingerprint rail.css (no SRI — plain <link href>). cuo/tuo arrive here already
// carrying rail.<oldhash>.css (build.bat ran fingerprint-rail-css.mjs in the full
// build) → this re-fingerprints on a content change. The MINI arrives with a PLAIN
// `rail.css` because its build path exits before that step — so we ALSO do the
// INITIAL fingerprint here, else the mini ships rail.css un-fingerprinted → served
// 1-year-immutable → stale CSS after any shared-www/rail.css edit (audit A3).
function refingerprintCss(clientDir, newRaw) {
  const indexPath = path.join(clientDir, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const fp = html.match(/rail\.[0-9a-f]+\.css/);   // already fingerprinted (cuo/tuo / re-fingerprint)
  const m = fp || html.match(/\brail\.css\b/);      // else the mini's plain initial ref
  if (!m) { log('  WARN: no rail.css <link> in index.html — skipping rail.css'); return false; }
  const oldName = m[0];
  const oldBuf = (() => { try { return fs.readFileSync(path.join(clientDir, oldName)); } catch { return null; } })();
  // Skip only when an ALREADY-fingerprinted file is byte-identical; a plain rail.css
  // must always be promoted to a hashed name even when its bytes are unchanged.
  if (fp && oldBuf && oldBuf.equals(newRaw)) { log('  rail.css unchanged — skip'); return false; }
  const newName = `rail.${crypto.createHash('sha256').update(newRaw).digest('hex').slice(0, 10)}.css`;
  fs.writeFileSync(path.join(clientDir, newName), newRaw);
  fs.writeFileSync(path.join(clientDir, newName + '.br'), brotli(newRaw));
  html = html.split(oldName).join(newName);
  fs.writeFileSync(indexPath, html);
  for (const f of [oldName, oldName + '.br']) { try { fs.unlinkSync(path.join(clientDir, f)); } catch { /* gone */ } }
  log(`  rail.css → ${newName} (+.br); index.html <link> updated`);
  return true;
}

// ── WEB PORTAL ── the community web layer (pages + shared assets). It is now built
// into a SINGLE shared client/web/ tree (buildWebTree) which nginx serves as the
// CANONICAL, client-decoupled location (operator 2026-06-28: "la parte web no tenga
// nada que ver con los clientes desktop … así no tenemos que triplicar cada
// funcionalidad"). Pages reference everything ROOT-ABSOLUTE (/cards-ui.js, /ui.css,
// …) and the in-game host links /ui.css + imports /cards-ui.js absolute → all resolve
// to web/. nginx NEVER serves these from a client bundle (the regex/page locations
// root at web/), so the copies the clients still carry (see STATIC_FILES note below)
// are harmless dead weight. Deploy web/ with tools/deploy-web.* — independent of the
// client release.bat, so the decoupling extends to the deploy pipeline too.
const WEB_FILES = ['faq.html', 'privacy.html', 'macros.html', 'profile.html', 'shop.html', 'cards.html', 'notifications.html',
  'admin.html',
  'cards-ui.js', 'portal-rail.js', 'paperdoll.js', 'itemart.js', 'dialog.js', 'ui.css', 'aura.css', 'profile-fx.css', 'RobotoMono-Regular.ttf',
  'tbh-preview.webp']; // Minigames card live preview (operator 2026-07-04) — alpha animated capture
// admin.html: a PORTAL page (shards, economy, flags, minigames), moved here 2026-07-31 from
// the CUO bundle root. Being in this list is what purges it from every game bundle, so the
// copies that used to leak out as /tuo/admin.html cannot come back. 🚨 It is served ONLY
// through the auth_request gate at /admin and /admin.html — putting it in the portal does not
// make it public, and nginx must keep both of those locations gated.
// itemart.js: draws a UO item from /ui/art and tints it through the shard's hue palettes,
// so the portal can show the backpack /api/gear reports. Web-only — the game client draws
// its own items in WASM and has no use for it.
const WEB_DIRS = ['webidentity', 'cosmetics', 'ui', 'macros'];

// Per-client pass-through (not fingerprinted). Web DE-DUP (2026-06-28 "higiene"):
// the portal web is single-served from client/web/ (nginx + deploy-web), so the
// game client bundles must NOT carry a copy. STATIC_FILES/STATIC_DIRS now hold ONLY
// the assets the game host genuinely needs in its own bundle — LegionScript
// (legion-*.js + lib/ + pyodide/), the macros/ scripts the rail imports, and the
// game fonts/background. The pure-web files (pages, cards-ui.js, portal-rail.js,
// ui/aura/profile-fx css, RobotoMono) + dirs (webidentity, cosmetics, ui) live only
// in web/ — they are listed in WEB_FILES/WEB_DIRS above and purged from each bundle
// by purgeWebFromClient(). Kept IN PARITY with the build.bat/build.sh pre-publish
// strip. NOTE: macros/ is in WEB_DIRS (copied to web/ for macros.html) but is NOT
// purged from the bundle — the in-game rail imports macros/*.js (game-host).
const STATIC_FILES = ['uo-background.jpg', 'uofont.ttf', 'Fondamento-Regular.ttf',
  'legion-engine.js', 'legion-worker.js'];
const STATIC_DIRS = ['lib', 'macros', 'pyodide'];
// Copy passes below MIRROR a canonical shared-www subdir, so they must also PRUNE.
// Without it a built tree only grows: rename or drop an asset and the old file
// stays. That matters twice over -- tools/deploy-web.bat mirrors client/web with
// robocopy /MIR, so a portal orphan then survives on the NAS and is served
// forever, and a bundle orphan gets zipped into the release. Caught 2026-07-27
// with 12 dead paperdoll layers from items swapped out mid-session.
let _pruned = 0;
// Dirs to purge from each client bundle = WEB_DIRS minus macros/ (game-host keeps it).
const DEDUP_DIRS = ['webidentity', 'cosmetics', 'ui'];
// Remove the FLAT pure-web files/dirs a previous (pre-de-dup) build left in this client
// bundle. Only flat names + DEDUP_DIRS — NOT the fingerprinted cards-ui.<hash>.js, which
// the bundle index.html importmap may still reference (removing it would break verify-sri
// on the fast path). The full build.bat regenerates index.html WITHOUT the cards-ui entry
// and /MIR removes the hashed twin; after that first full de-dup build no hashed cards-ui
// exists, so the fast path stays clean. The flat cards-ui.js is never in the integrity
// manifest (only the hashed value is), so dropping it here is safe.
function purgeWebFromClient(clientDir) {
  let removed = 0;
  const rm = (p) => { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed++; } };
  // ⚠️ admin.html is IN WEB_FILES, so this generic purge runs BEFORE the specific copy below and
  // was silently deleting the minimal bundle's own admin page right after it was copied — the build
  // logged "admin.html -> minimal/" and the file was gone.
  //
  // 🚨 IT HAPPENED AGAIN, TWICE MORE, and the per-name exemption is why. faq.html, privacy.html and
  // RobotoMono-Regular.ttf are all in WEB_FILES as portal artifacts, so adding minimal-owned
  // versions of them produced a build that copied all three, deleted all three, and reported
  // success — the copy is logged and the deletion is not. Naming the exemption `admin.html` fixed
  // one instance of a class.
  //
  // The rule instead: a file the MINIMAL LAYER ships is that layer's own, whatever the portal
  // happens to call its file of the same name. So the exemption is derived from what is on disk in
  // minimal-www, and the next minimal-owned page needs no edit here at all.
  const _bn = path.basename(clientDir);
  const _minimalOwn = isMinimal(_bn) && fs.existsSync(MINIMAL_WWW)
    ? new Set(fs.readdirSync(MINIMAL_WWW))
    : new Set();
  for (const f of WEB_FILES) {
    if (_minimalOwn.has(f)) continue;
    rm(path.join(clientDir, f)); rm(path.join(clientDir, f + '.br'));
  }
  // admin.html belongs to the CUO bundle alone -- nginx serves /admin from there.
  // Copies had accumulated in tuo and mini and were reachable as /tuo/admin.html and
  // /mini/admin.html: stale (they still carried the broken build), publicly readable,
  // and a way around the /admin gate, which only covers /admin and /admin.html.
  // ⚠️ 'minimal' is exempt, and it is NOT the same page. A self-hosted install has its own tiny
  // read-only admin (source/webclient/minimal-www/admin.html) reporting the shard it resolved and
  // whether its services are healthy — there are no shards to register, no economy and no users to
  // administer there. It is gated the same way, by auth_request in nginx.minimal.conf, failing
  // closed to a bare 404; purging it here would delete the page that gate points at.
  if (_bn !== 'cuo' && !isMinimal(_bn)) {
    rm(path.join(clientDir, 'admin.html'));
    rm(path.join(clientDir, 'admin.html.br'));
  }
  // ⚠️ THE SAME TRAP AS admin.html ABOVE, ONE DIRECTORY OVER. 'ui' is a DEDUP_DIR, so this purge
  // deleted client/minimal/ui right after the minimal block copied the admin skin's button
  // textures into it: the build logged "ui/btn-stone.webp -> minimal/" and the directory did not
  // exist afterwards. Exactly the failure the comment above describes, and it caught me anyway
  // because the copy is logged and the deletion is not — the log reads like proof.
  //
  // The minimal bundle's ui/ holds only what its own admin.html references, derived from that
  // stylesheet at copy time; it is not a copy of the portal's ui/ tree.
  for (const d of DEDUP_DIRS) {
    if (isMinimal(_bn) && d === 'ui') continue;
    rm(path.join(clientDir, d));
  }
  if (removed) log(`  web de-dup: purged ${removed} pure-web artifact(s) from ${path.basename(clientDir)}`);
  return removed;
}
function copyStatic(clientDir) {
  let n = 0;
  purgeWebFromClient(clientDir);
  for (const f of STATIC_FILES) {
    const src = path.join(SHARED, f);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(clientDir, f);
    const sBuf = fs.readFileSync(src);
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(sBuf)) continue;
    fs.writeFileSync(dst, sBuf);
    // Refresh the .br twin alongside every text asset we just rewrote — a
    // stale twin would win at nginx (brotli_static) and serve OLD bytes.
    // Covers legion-*.js too (plain-named, loaded with ?v= by rail.js).
    if (/\.(html|js|css)$/.test(f)) fs.writeFileSync(dst + '.br', brotli(sBuf));
    n++;
  }
  // static dirs (lib/*.mjs, macros/*.js, webidentity/**) — copied RECURSIVELY so
  // nested layouts (webidentity/modernuo/, /sphere/) come across intact.
  //
  // `oDir` is an OVERLAY root: names present there are copied too and count as wanted.
  // The mini needs it for lib/. Without it the wanted set was shared-www/lib alone, and
  // since the loop below DELETES anything in the destination that is not wanted, the
  // mini's own lib/mg-music.mjs + lib/mg-music/*.mid were pruned out of client/mini/
  // right after the WASM build put them there. mini-runtime.js imports that module with
  // a `.catch()` that only console.warns, and the console is silenced for players, so
  // the minigame music was dead in production with nothing to see. It cost two rounds of
  // ?v= cache-busting aimed at the wrong layer (operator 2026-07-05 "los midis siguen sin
  // escucharse") — the file was never published at all.
  const copyTree = (sDir, dDir, oDir) => {
    fs.mkdirSync(dDir, { recursive: true });
    // name → source path. Overlay wins on a name collision (that is what an override is).
    const want = new Map();
    if (fs.existsSync(sDir)) for (const f of fs.readdirSync(sDir)) want.set(f, path.join(sDir, f));
    if (oDir && fs.existsSync(oDir)) for (const f of fs.readdirSync(oDir)) want.set(f, path.join(oDir, f));
    for (const [f, sp] of want) {
      const dp = path.join(dDir, f);
      if (fs.statSync(sp).isDirectory()) {
        // A subdirectory can exist in both roots — keep the union one level down too.
        const sSub = path.join(sDir, f);
        const oSub = oDir ? path.join(oDir, f) : null;
        copyTree(fs.existsSync(sSub) ? sSub : sp,
                 dp,
                 (oSub && fs.existsSync(oSub)) ? oSub : null);
        continue;
      }
      const sBuf = fs.readFileSync(sp);
      if (fs.existsSync(dp) && fs.readFileSync(dp).equals(sBuf)) continue;
      fs.writeFileSync(dp, sBuf); n++;
    }
    for (const f of fs.readdirSync(dDir)) {
      // a .br twin stays as long as the file it compresses is still wanted
      if (want.has(f) || (f.endsWith('.br') && want.has(f.slice(0, -3)))) continue;
      fs.rmSync(path.join(dDir, f), { recursive: true, force: true });
      _pruned++;
    }
  };
  const isMini = path.basename(clientDir) === 'mini';
  for (const dir of STATIC_DIRS) {
    const dSrc = path.join(SHARED, dir);
    const dOvr = isMini ? path.join(MINI_OVERRIDES, dir) : null;
    if (fs.existsSync(dSrc) || (dOvr && fs.existsSync(dOvr))) {
      copyTree(dSrc, path.join(clientDir, dir), dOvr);
    }
  }
  if (n) log(`  copied ${n} static web file(s)`);
  return n;
}

// Build the SINGLE shared web portal at client/web/ — the community pages + their
// assets, served once by nginx (web/ root) instead of triplicated into every client
// bundle. Plain files (no fingerprint/SRI); brotli twins for the text assets so the
// nginx brotli_static path serves them. Idempotent (skips byte-identical files).
// 🚨 GATE: building a portal asset is NOT the same as serving it.
//
// nginx routes root-level portal JS through ENUMERATED locations, never an open
// `^/.*\.js$` glob (an open glob would serve any name out of web/). So a new module under
// shared-www/ has to be added in TWO places -- WEB_FILES here AND that alternation in
// server/deploy/nginx.conf -- and feeding only this one is how itemart.js shipped 404ing.
//
// What made that cost a round trip instead of a second is that the miss is INVISIBLE by
// status code: an unrouted path falls through to the SPA index, so the browser gets 200
// with an HTML body and the module simply never evaluates. Nothing looks broken until a
// feature quietly does nothing.
//
// A comment saying "remember both" is passive and already failed once, so this is the
// executable form: fail the BUILD, before deploy-web can copy anything, listing exactly
// what to add and where. Best-effort on reading nginx.conf -- if the file is absent
// (someone building outside a full checkout) we skip rather than block the build.
// GATE: `node --check` validates SYNTAX, not SCOPE.
//
// Deleting a block of dead code from mini-runtime.js left names referenced with nothing
// declaring them, and node --check called the file fine; only a real scope analyser could
// see it. (The same session had py_compile accept a dispatch table pointing at deleted
// functions.) A ReferenceError does not surface at build time, and it does not surface in a
// console that is silenced for players either -- a feature simply stops working.
//
// check-js-scope.mjs harvests tsc's "Cannot find name" for the hand-written browser JS and
// fails on anything not already known. Best-effort: it skips itself when typescript is not
// installed under server/, so a partial checkout still builds.
function assertHandWrittenJsResolves() {
  const files = ['main.js', 'rail.js', 'portal-rail.js', 'paperdoll.js', 'itemart.js', 'dialog.js',
    'cards-ui.js', 'legion-engine.js', 'legion-worker.js']
    .map((f) => path.join(SHARED, f))
    .concat([path.join(MINI_OVERRIDES, 'mini-runtime.js')])
    // 🚨 minimal-www TOO. It was missing here and that blindness cost real breakage twice while the
    // tree was being hand-trimmed: removing EXAMPLES left activeExamples() calling a name nothing
    // declared, and a re-inserted var landed inside a multi-line ternary. Both are VALID SYNTAX, so
    // node --check passes and the failure only appears as a ReferenceError when that path runs —
    // in a console that is silenced for players. This checker is the only thing that sees them, and
    // it has to cover the newest tree, not just the oldest.
    .concat(['main.js', 'rail.js', 'minimal-boot.js'].map((f) => path.join(MINIMAL_WWW, f)))
    .filter((f) => fs.existsSync(f));
  try {
    const out = execFileSync(process.execPath,
      [path.join(__dirname, 'check-js-scope.mjs'), ...files], { encoding: 'utf8' });
    if (out) process.stdout.write(out);
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    log('ERROR: hand-written JS references names that nothing declares (see above).');
    process.exit(1);
  }
}


function assertWebJsIsRouted() {
  const conf = path.join(REPO, 'server', 'deploy', 'nginx.conf');
  if (!fs.existsSync(conf)) return;
  const txt = fs.readFileSync(conf, 'utf8');
  // Resolve each `location` pattern to the concrete paths it can serve. The alternation
  // group has to be EXPANDED, not pattern-matched: in `^/(portal-rail|paperdoll)\.js$`
  // only the last alternative is adjacent to the `.js`, so a naive "name followed by .js"
  // scan sees none of the others and reports every file as unrouted. (It did, on the
  // first draft -- caught by running the check against a tree that was already correct.)
  const routed = new Set();
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*location\s+(?:(?:~\*?|=|\^~)\s*)?(\S+)\s*\{/.exec(line);
    if (!m) continue;
    const pat = m[1].replace(/^\^/, '').replace(/\$$/, '').replace(/\\/g, '');
    const g = /\(([^)]*)\)/.exec(pat);
    const forms = g
      ? g[1].split('|').map((alt) => pat.slice(0, g.index) + alt + pat.slice(g.index + g[0].length))
      : [pat];
    for (const f of forms) {
      const base = f.slice(f.lastIndexOf('/') + 1);
      if (base.endsWith('.js')) routed.add(base);
    }
  }
  const missing = WEB_FILES.filter((f) => f.endsWith('.js') && !routed.has(f));
  if (!missing.length) return;
  log('');
  log(`ERROR: ${missing.length} portal JS file(s) are built into client/web/ but nginx has no route for them:`);
  for (const f of missing) log(`  - ${f}`);
  log('  They would be served as the SPA index (200 + text/html), not as JavaScript.');
  log('  Fix: add the name to the portal-JS alternation in server/deploy/nginx.conf');
  log('       (location ~ ^/(portal-rail|paperdoll|...)\\.js$), then restart the nginx');
  log('       container -- nginx.conf is bind-mounted by inode, so a git sync is not enough.');
  process.exit(1);
}

function buildWebTree() {
  assertWebJsIsRouted();
  assertHandWrittenJsResolves();
  const webDir = path.join(REPO, 'client', 'web');
  fs.mkdirSync(webDir, { recursive: true });
  let n = 0;
  for (const f of WEB_FILES) {
    const src = path.join(SHARED, f);
    if (!fs.existsSync(src)) continue;
    const sBuf = fs.readFileSync(src);
    const dst = path.join(webDir, f);
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(sBuf)) continue;
    fs.writeFileSync(dst, sBuf);
    if (/\.(html|css|js)$/.test(f)) fs.writeFileSync(dst + '.br', brotli(sBuf));
    n++;
  }
  const copyTree = (sDir, dDir) => {
    fs.mkdirSync(dDir, { recursive: true });
    const want = new Set(fs.readdirSync(sDir));
    for (const f of want) {
      const sp = path.join(sDir, f);
      const dp = path.join(dDir, f);
      if (fs.statSync(sp).isDirectory()) { copyTree(sp, dp); continue; }
      const sBuf = fs.readFileSync(sp);
      if (fs.existsSync(dp) && fs.readFileSync(dp).equals(sBuf)) continue;
      fs.writeFileSync(dp, sBuf); n++;
    }
    for (const f of fs.readdirSync(dDir)) {
      // a .br twin stays as long as the file it compresses is still wanted
      if (want.has(f) || (f.endsWith('.br') && want.has(f.slice(0, -3)))) continue;
      fs.rmSync(path.join(dDir, f), { recursive: true, force: true });
      _pruned++;
    }
  };
  for (const dir of WEB_DIRS) {
    const dSrc = path.join(SHARED, dir);
    if (fs.existsSync(dSrc)) copyTree(dSrc, path.join(webDir, dir));
  }
  log(`web/ portal tree: ${n} file(s) synced${_pruned ? `, ${_pruned} orphan(s) pruned` : ''} (single shared serve — decoupled from the game clients)`);
  return n;
}

// shared-www/index.html links ui.css, but build-web does NOT re-run the SDK's
// index.html injection (it only patches fingerprint/SRI refs), so a NEW <link>
// added to the SOURCE index.html never reaches the built bundle's index.html.
// The web PAGES (profile/shop/cards/...) are STATIC_FILES that each carry their
// own ui.css link, but index.html is the built WASM host page for BOTH the
// landing AND the in-game client overlays — without this the shared design
// system (.navlink/.pts/.coin/...) is unstyled in-game (operator 2026-06-24:
// "Your balance: 934.806" rendered as plain text in the marketplace). Inject /
// version-sync the link here so every web-only build self-heals it.
function ensureUiCss(clientDir) {
  const indexPath = path.join(clientDir, 'index.html');
  if (!fs.existsSync(indexPath)) return;
  const srcIdx = fs.readFileSync(path.join(SHARED, 'index.html'), 'utf8');
  const m = srcIdx.match(/<link\b[^>]*href="\/ui\.css\?v=\d+"[^>]*>/);
  const link = m ? m[0] : '<link rel="stylesheet" href="/ui.css?v=3">';
  let html = fs.readFileSync(indexPath, 'utf8');
  if (/<link\b[^>]*href="\/ui\.css(\?v=\d+)?"[^>]*>/.test(html)) {
    const next = html.replace(/<link\b[^>]*href="\/ui\.css(\?v=\d+)?"[^>]*>/, link);
    if (next === html) return;
    html = next;
  } else {
    html = html.replace('</head>', '  ' + link + '\n</head>');
  }
  fs.writeFileSync(indexPath, html);
  log(`  ui.css <link> ensured in index.html (${(link.match(/v=\d+/) || [''])[0]})`);
}

// index.html RE-HOST (operator 2026-07-26: "por qué hay que rehacer builds para algo
// que es de la web y debería ser shared?"). Until now this script only patched
// fingerprint refs on the ALREADY-BUILT page, so any edit to the SOURCE index.html —
// markup, inline <script>, a rule in its <style> — silently needed a full cold
// build.bat per client (~10 min each) and, worse, gave no warning when it was missed.
//
// The delta between source and built page is small and entirely mechanical: the SDK
// expands three placeholders into (a) the fingerprinted dotnet preload link,
// (b) the importmap + its integrity table, (c) <name>.<hash>.js script srcs; plus it
// rewrites the plain rail.css href. So rebuild the page the other way round: take the
// SOURCE as the body of truth and re-inject the SDK's output for exactly those
// placeholders, read back off the previous build.
//
// Anything the SDK would need to newly fingerprint (a brand-new <script src>) is NOT
// covered — that still needs build.bat. We detect it and say so instead of shipping a
// page with a dead ref.
/**
 * Remove from a carried-over importmap every entry for a file that now lives ONLY in the portal,
 * plus its integrity row and the orphan the map was pointing at.
 *
 * Conservative by construction: it only ever DELETES keys named in WEB_FILES, so a map it does
 * not understand comes back unchanged rather than mangled, and a parse failure leaves the
 * original block exactly as it was. Getting this wrong breaks the boot of the whole client, so
 * the failure mode is "change nothing".
 */
function dropWebEntriesFromImportmap(block) {
  const m = /^(<script type="importmap">)([\s\S]*?)(<\/script>)$/.exec(block);
  if (!m) return block;
  let map;
  try { map = JSON.parse(m[2]); } catch { return block; }
  if (!map || typeof map !== 'object' || !map.imports) return block;
  const webJs = WEB_FILES.filter((f) => f.endsWith('.js'));
  let dropped = 0;
  for (const name of webJs) {
    const key = './' + name;
    const target = map.imports[key];
    // 🚨 THE INTEGRITY ROW IS CLEANED WHETHER OR NOT THE IMPORT MAPPING IS STILL THERE. The
    // first version bailed out on `if (!target) continue`, so once a run had removed the
    // mapping the orphaned integrity row became unreachable and survived every later build —
    // pinning a dead hash on the portal's live file, which is the one failure that would break
    // a page that currently works. The two are separate rows and have to be treated separately.
    if (map.integrity) {
      if (target && target in map.integrity) { delete map.integrity[target]; dropped++; }
      if (key in map.integrity) { delete map.integrity[key]; dropped++; }
    }
    if (!target) continue;
    delete map.imports[key];
    // BOTH integrity keys. The table carries a row for the fingerprinted target AND one for the
    // bare specifier, and leaving the bare one behind is worse than doing nothing: it pins the
    // OLD hash onto the portal's fresh /paperdoll.js, so the browser refuses to execute it and
    // the page that was working stops working. Caught by reading the rewritten index.html
    // instead of trusting that "3 entries dropped" meant the right three things were gone.
    if (map.integrity) {
      if (target in map.integrity) delete map.integrity[target];
      if (key in map.integrity) delete map.integrity[key];
    }
    dropped++;
    _orphanTargets.push(String(target).replace(/^\.\//, ''));
  }
  if (!dropped) return block;
  log(`  importmap: ${dropped} pure-web entr${dropped === 1 ? 'y' : 'ies'} dropped — they resolve to the portal now`);
  return m[1] + JSON.stringify(map) + m[3];
}
const _orphanTargets = [];

function rehostIndex(clientDir, bundle) {
  const srcPath = path.join(pageSrcFor(bundle), 'index.html');
  const indexPath = path.join(clientDir, 'index.html');
  if (!fs.existsSync(srcPath)) return false;
  const src = fs.readFileSync(srcPath, 'utf8');
  const built = fs.readFileSync(indexPath, 'utf8');

  // (a) every fingerprinted _framework preload the SDK emitted for id="webassembly"
  const preloads = (built.match(/<link[^>]*rel="preload"[^>]*>/g) || [])
    .filter((t) => t.includes('_framework/'));
  // (b) the importmap, integrity table included
  let importmap = (built.match(/<script type="importmap">[\s\S]*?<\/script>/) || [])[0];
  // 🚨 AND WITH THE PURE-WEB ENTRIES DROPPED. This block is carried over VERBATIM from the
  // previous build, so any mapping in it outlives the file it points at. purgeWebFromClient
  // deletes the flat pure-web copies from the bundle but deliberately leaves the FINGERPRINTED
  // twins, because this map still names them — which means a file moved into WEB_FILES keeps a
  // frozen copy in every bundle until somebody runs a full build.bat.
  //
  // That is not theoretical: paperdoll.js and itemart.js moved to WEB_FILES after the last full
  // build, so /backpack?view=items inside the bundle went on importing paperdoll.<hash>.js from
  // 2026-08-01 while /id/<nick> loaded the portal's fresh /paperdoll.js. One source, two build
  // outputs, two deploy tracks — the operator saw one page dressed and the other naked, and
  // every "verified" curl of /paperdoll.js was checking a URL the broken page never requests.
  //
  // Dropping the entry here makes the bare specifier resolve to the portal copy, which is the
  // single served location for these files. Done on the FAST path on purpose: waiting for a
  // full build is what let this sit for a day, and the next file moved to the web layer would
  // repeat it.
  if (importmap) importmap = dropWebEntriesFromImportmap(importmap);
  if (!preloads.length || !importmap) {
    log('  WARN: index.html re-host skipped — no SDK boot block in the built page');
    return false;
  }

  let out = src
    .replace(/[ \t]*<link rel="preload" id="webassembly"\s*\/>/, preloads.map((p) => '  ' + p).join('\n'))
    .replace(/<script type="importmap"><\/script>/, importmap);

  // (c) <name>#[.{fingerprint}].js  →  the name this build actually shipped
  let missing = null;
  out = out.replace(/([A-Za-z0-9_-]+)#\[\.\{fingerprint\}\]\.js/g, (ph, base) => {
    const hit = new RegExp(`\\b${base}\\.[a-z0-9]+\\.js\\b`).exec(built);
    if (!hit) { missing = missing || base; return ph; }
    return hit[0];
  });
  const cssHit = /\brail\.[a-z0-9]+\.css\b/.exec(built);
  if (cssHit) out = out.replace('href="rail.css"', `href="${cssHit[0]}"`);

  if (missing) {
    log(`  WARN: index.html re-host skipped — "${missing}" has no fingerprinted twin in this build.`);
    log('        A NEW <script src> in the source page needs a full build.bat first.');
    return false;
  }
  if (out === built) return false;
  fs.writeFileSync(indexPath, out);
  log('  index.html re-hosted from source (body + inline CSS/JS now live)');
  // The fingerprinted twins the dropped entries pointed at. Removed only AFTER the page that
  // named them has been written, so an interrupted run can never leave an index.html referencing
  // a file that is already gone — the one ordering that would break the client's boot.
  while (_orphanTargets.length) {
    const name = _orphanTargets.pop();
    if (!/^[A-Za-z0-9_.-]+\.js$/.test(name)) continue;   // never let a path out of the bundle dir
    for (const p of [path.join(clientDir, name), path.join(clientDir, name + '.br')]) {
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); log(`  removed bundle orphan ${path.basename(p)}`); }
    }
  }
  return true;
}

let total = 0;
for (const bundle of (WEB_TREE_ONLY ? [] : BUNDLES)) {
  const clientDir = path.join(REPO, 'client', bundle);
  const indexPath = path.join(clientDir, 'index.html');
  if (!fs.existsSync(indexPath) || !fs.existsSync(path.join(clientDir, '_framework'))) {
    console.error(`[build-web] ERROR: ${clientDir} has no prior full build (index.html/_framework missing). Run build.bat first.`);
    process.exit(1);
  }
  log(`bundle=${bundle} dir=client/${bundle}`);

  // 0. index.html FIRST — it re-hosts the page from source, so the fingerprint
  //    patching below must run afterwards to land on the re-hosted refs.
  if (rehostIndex(clientDir, bundle)) total++;

  // 1. main.js — overwrite the deployed fingerprinted file with the fresh RAW
  //    source, then run strip-dev-blocks (prod) which strips + re-fingerprints +
  //    patches index.html (identical to build.bat). For a dev (no-strip) build
  //    we re-fingerprint inline like rail.js.
  const mainRaw = fs.readFileSync(path.join(appSrcFor(bundle), 'main.js')); // ALL clients (incl mini) build from the one shared main.js — fase3 fork collapse 2026-06-28; mini-only subsystems live in mini-overrides/mini-runtime.js loaded by the mini index.html
  const curMain = fs.readdirSync(clientDir).find((f) => /^main\.[a-z0-9]+\.js$/.test(f));
  if (PROD && curMain) {
    fs.writeFileSync(path.join(clientDir, curMain), mainRaw); // place RAW; strip-dev-blocks re-derives
    if (isWin) {
      run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'strip-dev-blocks.ps1'), '-ClientDir', clientDir]);
    } else {
      run('bash', [path.join(__dirname, 'strip-dev-blocks.sh'), clientDir]);
    }
    // strip-dev-blocks renamed main.<hash>.js + wrote no .br; refresh the twin.
    const newMain = fs.readdirSync(clientDir).find((f) => /^main\.[a-z0-9]+\.js$/.test(f));
    if (newMain) fs.writeFileSync(path.join(clientDir, newMain + '.br'), brotli(fs.readFileSync(path.join(clientDir, newMain))));
    log(`  main.js: stripped + re-fingerprinted → ${newMain}`);
    total++;
  } else {
    if (refingerprintJs(clientDir, 'main', mainRaw)) total++;
  }

  // 2. rail.js (no strip), 3. rail.css, 4. static pass-through.
  if (refingerprintJs(clientDir, 'rail', fs.readFileSync(path.join(appSrcFor(bundle), 'rail.js')))) total++;
  if (refingerprintCss(clientDir, fs.readFileSync(path.join(appSrcFor(bundle), 'rail.css')))) total++;
  // MINIMAL: two plain, UN-fingerprinted files. minimal-boot.js must keep a stable name because
  // index.html loads it by that name before the module graph exists, and config.json is the one
  // file a self-hoster is told to edit — a content hash in either turns "edit config.json" into
  // a lie. They are copied, not fingerprinted, for exactly that reason.
  if (isMinimal(bundle)) {
    // admin.html joins them: nginx serves it BY NAME behind an auth_request, so a content hash
    // would break the very location that gates it.
    // 🚨 config.json is shipped as config.example.json, NOT as config.json.
    // It is USER DATA: the shard a self-hoster configured. Shipping it under its live name means
    // every client upgrade silently overwrites their settings — which is precisely what happened
    // when this bundle was redeployed to the test host and the shard reverted to the placeholder.
    // The install copies the example once; upgrades never touch the real file.
    for (const f of ['minimal-boot.js', 'admin.html', 'privacy.html', '_pageshell.css', 'RobotoMono-Regular.ttf']) {
      const src = path.join(MINIMAL_WWW, f);
      if (!fs.existsSync(src)) { log(`ERROR: minimal bundle is missing ${f}`); process.exit(1); }
      const dst = path.join(clientDir, f);
      const next = fs.readFileSync(src);
      if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(next)) {
        fs.writeFileSync(dst, next); total++; log(`  ${f} -> ${path.basename(clientDir)}/`);
      }
    }
    // 🚨 THE ADMIN SKIN'S BUTTON TEXTURES, AND A CHECK THAT THEY ARRIVED.
    //
    // admin.html was restyled to the hosted console's design system, which paints buttons with
    // ui/btn-*.webp. This loop copied a fixed list of two FILES and no directories, so the CSS
    // shipped referencing textures the bundle did not contain — nothing errors, nothing 404s
    // visibly, the buttons simply lose their stone and nobody notices until they are looked at.
    // Same shape as every other silent-degradation bug in this build.
    //
    // So the copy is derived from what the SOURCES ask for, and a missing one fails the build.
    // A visual dependency that only shows up by eye is exactly the kind that needs a loud check.
    //
    // ⚠️ THIS CHECK USED TO READ ONLY admin.html, AND NARROW IS HOW IT MISSED THINGS. It found the
    // button textures and was blind to everything else in the layer, which let three real gaps
    // ship: rail.css asked for a mono font the bundle did not carry (the browser silently
    // substituted one), and index.html linked /faq.html and /privacy.html, which nginx answered
    // with a clean 404 — a Help button that did nothing. A check scoped to one file cannot see a
    // second file's references, so it is scoped to the layer.
    {
      const localRefs = new Set();
      for (const f of fs.readdirSync(MINIMAL_WWW)) {
        if (!/\.(html|css|js)$/.test(f)) continue;
        const text = fs.readFileSync(path.join(MINIMAL_WWW, f), 'utf8');
        for (const m of text.matchAll(/url\(["']?([^)"']+)["']?\)/g)) localRefs.add(m[1]);
        for (const m of text.matchAll(/(?:src|href)="([^"]+)"/g)) localRefs.add(m[1]);
      }
      const missing = [];
      for (const raw of localRefs) {
        // Absolute-root links are served by nginx from the bundle root, so '/faq.html' and
        // 'faq.html' are the same file to look for.
        const rel = raw.replace(/^\//, '');
        // Off-tree, generated, or not a file reference at all.
        if (!rel || /^(https?:|data:|mailto:|javascript:|#|\$\{|api\/|auth\/)/.test(rel)) continue;
        if (rel.includes('${') || rel.includes("' +") || rel.includes('#[.{')) continue;
        if (rel === '' || rel === 'tuo/') continue;
        // Present in the hand-written layer? Copy it. Present only in the bundle (the fork's own
        // wwwroot assets — uofont.ttf, the background)? Leave it; it is already there.
        const src = path.join(MINIMAL_WWW, rel);
        if (fs.existsSync(src)) {
          const dst = path.join(clientDir, rel);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          const next = fs.readFileSync(src);
          if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(next)) {
            fs.writeFileSync(dst, next); total++; log(`  ${rel} -> ${path.basename(clientDir)}/`);
          }
          continue;
        }
        if (!fs.existsSync(path.join(clientDir, rel))) missing.push(rel);
      }
      if (missing.length) {
        log(`ERROR: minimal-www references ${missing.length} asset(s) that no source and no bundle provides:`);
        for (const m of missing) log(`  missing: ${m}`);
        process.exit(1);
      }
    }

    // 🚨 KEEP version.txt IN STEP WITH THE FORK THIS BUNDLE WAS SEEDED FROM.
    //
    // Nothing wrote it: build-minimal-bundle copies client/cuo wholesale when seeding, so the file
    // arrives carrying whatever release the game bundle happened to be on that day and then never
    // moves again. The minimal client FETCHES /version.txt and puts it in the landing title, so a
    // frozen value is not a cosmetic detail — every visitor was shown v1.0.17 while the WASM in the
    // bundle came from the v1.0.20 build, and the operator read the stale number as "the deploy did
    // not go out". A version that does not track its artefact is worse than none: it answers the
    // question wrongly instead of not answering it.
    //
    // The WASM is the fork's, so the fork's version is the honest answer. Absent (a self-hoster who
    // built from source and has no release), the file is simply left alone.
    //
    // 🚨 BUT IT MAY ONLY EVER MOVE FORWARD, BECAUSE THE MINIMAL NOW HAS A RELEASE TRACK OF ITS OWN.
    // The reasoning above was right when it was written and stopped being right the day
    // uonexus-minimal started cutting its own releases: its numbering runs AHEAD of the fork's
    // (v1.0.46 against the client's v1.0.36 on 2026-09-03), so copying the fork's number over it is
    // not a resync, it is a ten-release regression. It happened: a web-layer rebuild stamped v1.0.36
    // over v1.0.46, and the publisher accepted it because its only check is that the two minimal
    // bundles AGREE — and they had both regressed together. The release went out numbered older than
    // the bytes it contained.
    //
    // Refusing to go backwards keeps the original fix (a frozen version.txt is worse than none)
    // while making the destructive direction impossible. When the fork legitimately overtakes the
    // minimal again, the copy resumes on its own.
    {
      const seed = bundle === 'minimal-tuo' ? 'tuo' : 'cuo';
      const src = path.join(REPO, 'client', seed, 'version.txt');
      if (fs.existsSync(src)) {
        const dst = path.join(clientDir, 'version.txt');
        const next = fs.readFileSync(src);
        // The decision lives in its own module so it can be exercised with real values; see the
        // note there on why a gate reading this file could not do the job.
        const current = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
        if (!mayReplaceVersion(current, next)) {
          log(`  version.txt kept at ${String(fs.readFileSync(dst)).trim()} in ${path.basename(clientDir)}/`
            + ` — ${seed} is on ${String(next).trim()}, which is older; this bundle releases on its own track`);
        } else if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(next)) {
          fs.writeFileSync(dst, next); total++;
          log(`  version.txt -> ${path.basename(clientDir)}/ (${String(next).trim()}, from ${seed})`);
        }
      }
    }

    // The template, under a name that can never collide with the operator's live config.
    {
      const src = path.join(MINIMAL_WWW, 'config.json');
      const dst = path.join(clientDir, 'config.example.json');
      if (fs.existsSync(src)) {
        const next = fs.readFileSync(src);
        if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(next)) {
          fs.writeFileSync(dst, next); total++; log(`  config.example.json -> ${path.basename(clientDir)}/`);
        }
      }
      // Seed the live file ONLY when absent, so a fresh checkout still boots and an upgrade does not
      // clobber a configured install.
      const live = path.join(clientDir, 'config.json');
      if (!fs.existsSync(live) && fs.existsSync(src)) {
        fs.copyFileSync(src, live); total++; log(`  config.json seeded (first install) -> ${path.basename(clientDir)}/`);
      }
    }
  }
  // 2b. mini-runtime.js (mini only): it had NO refingerprint discipline — every web build shipped its NEW
  // content under the SAME fingerprinted name the last full build minted (e.g. mini-runtime.c47yuezr2g.js),
  // and nginx serves fingerprints immutable/1y → RETURNING browsers never refetched it and stayed pinned to
  // stale mini UI code forever ("no veo cambios" incidents 2026-07-02: buttons/death-fix invisible to the
  // operator while fresh contexts saw them). Re-fingerprint from content exactly like main/rail so any
  // change gets a NEW name + index refs + SRI, and old browsers pick it up via the no-cache index.html.
  if (bundle === 'mini') {
    // 🚨 ASSEMBLE FIRST. The runtime's source is `mini-overrides/src/**`; the single file below is
    // an artifact. Building from a stale artifact would ship yesterday's parts while every gate
    // reads the same stale bytes and agrees with itself — the exact shape of "a bundle that is not
    // rebuilt is invisible", which this project has already paid for once.
    //
    // It ASSEMBLES rather than merely checking, so a forgotten command can never produce a wrong
    // build; the committed artifact drifting from the parts is caught separately, at test time, by
    // `MiniRuntimeIsAssembledFromParts`. A build that fails over something forgettable gets worked
    // around; a build that is simply correct does not.
    const mrSrc = path.join(REPO, 'source', 'webclient', 'mini-overrides', 'mini-runtime.js');
    try {
      execFileSync(process.execPath,
        [path.join(REPO, 'server', 'scripts', 'assemble-mini-runtime.mjs')],
        { stdio: 'inherit' });
    } catch {
      throw new Error('[build-web] mini-runtime could not be assembled from mini-overrides/src/ — see above');
    }
    if (fs.existsSync(mrSrc) && refingerprintJs(clientDir, 'mini-runtime', fs.readFileSync(mrSrc))) total++;
  }
  total += copyStatic(clientDir);
  // 🚨 NOT for minimal. ui.css is the PORTAL design system — profile, shop, cards, marketplace —
  // and a minimal install ships none of that; its rail carries its own rail.css. Injecting the link
  // anyway pointed the page at a file the bundle deliberately does not contain, and the symptom was
  // not a clean 404: the SPA fallback answered with index.html, so the browser reported "refused to
  // apply style ... MIME type ('text/html')" and a reader chases a MIME problem that is really a
  // missing file. Found on the first boot of the isolated deployment.
  if (!isMinimal(bundle)) ensureUiCss(clientDir);

  // admin.html used to be copied into the CUO bundle root and served from there. It is a
  // PORTAL page — it manages shards, the points economy, flags and minigames, and nothing
  // about it is a game-client concern — so it now ships with the rest of the portal
  // (operator 2026-07-31: "el admin debería vivir en el portal, no en el bundle de cuo").
  //
  // The cost of the old placement was a deploy track: a typo in the admin panel needed a
  // GitHub release plus a fetcher restart, instead of the robocopy every other portal page
  // uses. It also kept leaking — copies accumulated in the tuo and mini bundles and were
  // publicly readable as /tuo/admin.html, which is why nginx still carries a defensive 404
  // for any nested admin.html.
  //
  // It is in WEB_FILES now, so the per-bundle purge above removes it from EVERY bundle and
  // the portal copy below is the only one. nginx roots /admin at html/web to match.

  // MINI embed snippet (operator 2026-06-27): lives in source/webclient/ (NOT shared-www) and is served at
  // the bundle root under a de-prefixed name. Part of the build so it deploys reproducibly. The two demo
  // HTMLs (launch-demo.html + embed-demo.html) were RETIRED 2026-07-09 — the smoke suite now boots minigames
  // through the REAL portal (uonexus.com/?play=<gid>, portal-rail.js auto-open) and nginx 410s the stale
  // on-disk copies. Only embed.js (the live third-party embeddable snippet) remains.
  if (bundle === 'mini') {
    const MINI_STATIC = {
      'mini-embed.js': 'embed.js',                  // the embeddable snippet (third-party, live)
    };
    for (const [srcName, dstName] of Object.entries(MINI_STATIC)) {
      const src = path.join(REPO, 'source', 'webclient', srcName);
      if (!fs.existsSync(src)) continue;
      const sBuf = fs.readFileSync(src);
      const dst = path.join(clientDir, dstName);
      if (fs.existsSync(dst) && fs.readFileSync(dst).equals(sBuf)) continue;
      fs.writeFileSync(dst, sBuf);
      if (/\.html$/.test(dstName) && fs.existsSync(dst + '.br')) fs.writeFileSync(dst + '.br', brotli(sBuf));
      log(`  copied ${srcName} → ${dstName} (mini)`);
      total++;
    }
  }

  // Drop importmap entries whose TARGET is not in the bundle.
  //
  // The SDK writes a fingerprinted target for assets it treats as fingerprintable,
  // including the ones under lib/ and macros/. Those directories are deliberately shipped
  // UNfingerprinted (served immutable-1y, cache-busted with ?v=), and copyStatic mirrors
  // shared-www into them and prunes whatever it does not recognise — so the fingerprinted
  // twins never survive into client/<bundle>/. The map was left pointing at them.
  //
  // A mapping to a file that does not exist can only ever break a load, so removing it is
  // strictly a repair: the specifier then resolves to the plain name, which IS shipped
  // (asserted below before touching anything). What it repairs is not cosmetic —
  // midi-fallback.mjs does `import ... from './spessasynth_lib.js'` and mg-music.mjs
  // imports it in turn, so every MIDI music path in all three clients was dying on a
  // remapped 404. Invisible, of course: module load failures land in a console that is
  // silenced for players, and mg-music's caller swallows its rejection.
  {
    const idxP = path.join(clientDir, 'index.html');
    if (fs.existsSync(idxP)) {
      const html = fs.readFileSync(idxP, 'utf8');
      const m = /(<script type="importmap">)(.*?)(<\/script>)/s.exec(html);
      if (m) {
        let map;
        try { map = JSON.parse(m[2]); } catch { map = null; }
        if (map && map.imports) {
          const dead = [];
          for (const [spec, target] of Object.entries(map.imports)) {
            const tgt = path.join(clientDir, target.replace(/^\.\//, ''));
            if (fs.existsSync(tgt)) continue;
            // Only drop it if the bare specifier resolves to a file we DO ship; otherwise
            // the mapping is the only thing pointing anywhere and removing it would turn a
            // broken import into a differently-broken import with no trail.
            const plain = path.join(clientDir, spec.replace(/^\.\//, ''));
            if (!fs.existsSync(plain)) {
              log(`  WARNING: importmap ${spec} → ${target}: neither is in the bundle. Left alone.`);
              continue;
            }
            dead.push(spec);
          }
          if (dead.length) {
            for (const spec of dead) delete map.imports[spec];
            const out = html.slice(0, m.index) + m[1] + JSON.stringify(map) + m[3]
                      + html.slice(m.index + m[0].length);
            fs.writeFileSync(idxP, out);
            log(`  importmap: dropped ${dead.length} mapping(s) whose target is not in this bundle `
                + `(now resolving to the shipped plain name): ${dead.join(', ')}`);
            total++;
          }
        }
      }
    }
  }

  // CRITICAL: refingerprintJs/Css patched index.html (raw) but each only rewrites
  // ITS fingerprinted twin — NOT index.html.br. nginx serves index.html.br to
  // brotli clients (incl. Cloudflare), so a stale twin makes returning visitors
  // (and the CDN) fetch an index.html pointing at a main.<oldhash>.js that
  // refingerprintJs just DELETED → 404 → blank page / "a veces no carga". Always
  // regenerate index.html.br from the final index.html. (operator bug, 2026-06-12)
  const idx = path.join(clientDir, 'index.html');
  if (fs.existsSync(idx)) {
    // MINI runtime identity (operator 2026-06-27): served from uonexus.com at /mini/, but the bundle is a
    // CUO build, so inject a tiny inline flag that runs BEFORE the deferred main.js/rail.js → they branch on
    // the mini (rail.js's CLIENT='mini' arm + the mini asset namespace, etc.). Idempotent.
    if (bundle === 'mini') {
      let html = fs.readFileSync(idx, 'utf8');
      // Detect the SET (window.__MINI__ = true), NOT just any reference — the mini
      // index.html has `window.__MINI__ === true` CHECKS that fooled the old
      // includes() guard into skipping the injection, leaving __MINI__ undefined →
      // __bundle fell back to 'cuo' and every mini gate was bypassed (collapse bug
      // 2026-06-29). The source index.html now carries the SET itself, but keep the
      // robust guard so this can never silently regress.
      if (!/window\.__MINI__\s*=\s*(?:true|!0)\b/.test(html)) {
        html = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n  <script>window.__MINI__=true;</script>`);
        fs.writeFileSync(idx, html);
        log('  injected window.__MINI__ (mini identity)');
      }
    }
    fs.writeFileSync(idx + '.br', brotli(fs.readFileSync(idx)));
    log(`  index.html.br regenerated (${bundle})`);
  }
}

// Single shared web portal (client/web/) — built ONCE, decoupled from the game
// clients so a web feature is no longer triplicated into cuo/tuo/mini.
buildWebTree();

// 5. Hard guardrail: SRI must verify for every bundle, or we DON'T ship.
for (const bundle of (WEB_TREE_ONLY ? [] : BUNDLES)) {
  // Framework files named by their bytes before anything is verified or deployed. A cold build.bat
  // hands this the SDK's source-hash names, and a bundle deployed with those can change bytes under a
  // URL served `immutable` — the year-long black screen of 2026-09-02. Idempotent on a bundle already
  // named this way. See framework-names.mjs.
  applyContentNames(path.join(REPO, 'client', bundle), { log });
  log(`verify-sri client/${bundle} ...`);
  run(process.execPath, [path.join(__dirname, 'verify-sri.mjs'), '--root', path.join(REPO, 'client', bundle)]);
  // build-id.txt cache-buster: build-web is BOTH the mini's full-build finisher
  // (build.bat dispatches CLIENT_NAME=mini here and exits before its own build-id
  // stamp at ~line 486) AND the WEB_ONLY rebuild path. Neither otherwise stamps
  // build-id.txt, so release.bat SKIP_BUILD refused the mini bundle (missing
  // build-id) on v0.9.210 until a manual stamp. Written AFTER verify-sri so a bundle
  // that fails SRI never gets a fresh id. Compact YYYYMMDDHHMMSS matches build.bat.
  const buildId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.writeFileSync(path.join(REPO, 'client', bundle, 'build-id.txt'), buildId + '\n');
  log(`build-id ${buildId} stamped to client/${bundle}/build-id.txt`);
}
  // Guard the BUILT artefacts, not the sources: a broken publish step would be
  // invisible in shared-www and fatal in client/.
  for (const bundle of BUNDLES) {
    checkInlineScripts(path.join(REPO, 'client', bundle, 'index.html'));
  }
  // admin.html is checked where it now LANDS. Left pointed at the bundles it would have
  // silently checked nothing: checkInlineScripts skips a file that does not exist, so the
  // guard would have gone quiet at exactly the moment the page moved.
  checkInlineScripts(path.join(REPO, 'client', 'web', 'admin.html'));
log(`done — ${total} web asset(s) refreshed across ${BUNDLES.join(', ')}. WASM untouched (reused from last full build).`);
