// cards-ui.js (window.CardUI) is imported by web/portal-rail.js (its only consumer = the Trading Cards tab), NOT here -- the game host carries no web code. See portal-rail.js header.
window.__uoBuild = 'v0.9.50'; // build marker — bumps the bundle content hash so all clients re-pull a fresh copy
// v0.7.0 multi-client bundle routing.
//
// Runs BEFORE anything else (above the console silencer) so the
// redirect fires before any of the boot machinery starts. The
// contract:
//   /?client=tuo        → redirect to /tuo/ (TazUO bundle)
//   /?client=cuo        → no redirect (CUO is served at /)
//   /tuo/?client=cuo    → redirect back to /
//   /tuo/?client=tuo    → no redirect (already on TUO)
//   /  no client param  → CUO loads, picker may offer to switch to TUO
//   /tuo/ no client param → TUO loads, picker may offer to switch to CUO
// The query param is preserved on redirect so deep-links + smoke
// scenarios keep their context.
(() => {
  try {
    if (typeof location === 'undefined') return;
    if (window.__MINI__ === true) return; // mini = single-client: no cross-bundle ?client= routing
    const params = new URLSearchParams(location.search);
    const client = params.get('client');
    if (!client) return;
    const onTuo = location.pathname.startsWith('/tuo/');
    if (client === 'tuo' && !onTuo) {
      location.replace('/tuo/' + location.search + location.hash);
      return;
    }
    if (client === 'cuo' && onTuo) {
      // Strip /tuo prefix; keep query + hash.
      const newPath = location.pathname.replace(/^\/tuo\//, '/');
      location.replace(newPath + location.search + location.hash);
      return;
    }
  } catch { /* never block boot on routing */ }
})();

// v0.7.7 transparent bundle path. After the router IIFE settles
// (no further client= redirect pending), detect which bundle is
// loaded and IMMEDIATELY strip /tuo/ from the URL bar. nginx
// already served the right bytes from the right directory; the
// /tuo/ prefix was nginx-routing metadata, not user-facing state.
//
// The operator's call: "no salieran los path /cuo y /tuo en el
// navegador, que fuera todo transparente para el usuario".
//
// Trade-offs:
//   - URL bar always shows uonexus.com/ regardless of bundle.
//   - On F5, browser re-fetches the URL bar URL (uonexus.com/) →
//     CUO loads. If forceClient pins the chosen shard to TUO,
//     the picker click handler re-runs the /tuo/ navigation +
//     this IIFE replaceState — round trip but invisible to the
//     user (sub-second since the TUO bundle is OPFS-cached after
//     first load).
//   - All `location.pathname.startsWith('/tuo/')` checks in the
//     rest of main.js MUST be replaced with `window.__bundle`
//     because replaceState clobbers location.pathname. Done
//     throughout this file in v0.7.7.
(() => {
  try {
    if (typeof location === 'undefined' || typeof window === 'undefined') return;
    // mini = single-client embeddable: __bundle='mini', and NO URL-bar path-strip
    // (it mounts at /mini/ on uonexus.com or / on dev; its real mount must survive
    // in location.pathname — used by boot_recoverIfMismatch). Set before main.js by
    // the mini index.html (window.__MINI__ = true).
    if (window.__MINI__ === true) { window.__bundle = 'mini'; return; }
    window.__bundle = location.pathname.startsWith('/tuo/') ? 'tuo' : 'cuo';
    // Both /tuo/ and /cuo/ are nginx routing entry points (operator added /cuo/
    // 2026-06-08, symmetric with /tuo/). Strip EITHER so the URL bar always
    // shows / — "que no salieran los path /cuo y /tuo en el navegador". __bundle
    // was set above from the pre-strip pathname (/cuo/ → 'cuo') so it stays right.
    const onSubPath = location.pathname.startsWith('/tuo/') || location.pathname.startsWith('/cuo/');
    if (onSubPath && typeof history !== 'undefined' && history.replaceState) {
      history.replaceState(null, '', '/' + location.search + location.hash);
    }
  } catch { /* never block boot on routing */ }
})();

// GPU acceleration probe (2026-07-25). When a browser silently falls back to a
// SOFTWARE rasterizer (SwiftShader / llvmpipe / "Microsoft Basic Render Driver"),
// every frame is drawn on the CPU: the client still boots and still works, but it
// crawls — even on the login screen — and the player has no way to know why.
// Cheap: a 1x1 context, read the renderer string, drop the context.
// FAILS OPEN: if the string is unavailable (Firefox resistFingerprinting, privacy
// extensions) or is the useless generic "WebKit WebGL", we stay quiet rather than
// cry wolf. The renderer is ALWAYS logged — it is the first thing to ask for in a
// "the client is slow" report. Lives here, not in index.html, so it ships with a
// web-only build (build-web does NOT pick up index.html body changes).
(() => {
  const probe = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { known: true, software: true, renderer: 'no-webgl' };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
                              || gl.getParameter(gl.RENDERER) || '');
      try { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch {}
      // Chrome's masked RENDERER is the literal "WebKit WebGL" — it tells us nothing.
      if (!renderer || /^(webkit )?webgl$/i.test(renderer)) return { known: false, software: false, renderer };
      return {
        known: true,
        software: /swiftshader|llvmpipe|software|basic render|mesa offscreen|generic renderer/i.test(renderer),
        renderer,
      };
    } catch { return { known: false, software: false, renderer: '' }; }
  };
  try {
    const r = probe();
    // ?showgpu=1 forces the notice on a healthy machine so the warning itself can be
    // verified (same escape hatch as ?showcompat=1 for the browser notice).
    let forced = false;
    try { forced = new URLSearchParams(location.search).get('showgpu') === '1'; } catch {}
    if (forced) { r.known = true; r.software = true; r.renderer = r.renderer || 'forced-test'; }
    window.__uoRenderer = r;
    console.log('[compat] gpu renderer=' + (r.renderer || 'unknown') + ' software=' + r.software +
                (forced ? ' (FORCED by ?showgpu=1)' : ''));
          // Weak-machine signal. EVIDENCE FIRST: the rail already has a Performance preset that
      // measured ~8% off renderer CPU, but it is opt-in and buried in a tab, so the players
      // who need it most will never find it. Before designing that offer we need to know how
      // many players are on such a machine at all -- and every boot-hang number so far came
      // from 16 cores / 32 GB, which says nothing about the ten-year-old PCs where it is
      // actually reported. Both figures are coarse and browser-rounded (deviceMemory is
      // Chromium-only and caps at 8), so this is a SIGNAL, not a benchmark.
      var _cores = navigator.hardwareConcurrency || 0;
      var _mem = navigator.deviceMemory || 0;
      var _weak = (_cores > 0 && _cores <= 4) || (_mem > 0 && _mem <= 4) || r.software;
      console.log('[compat] machine cores=' + _cores + ' mem=' + _mem + ' weak=' + _weak
                  + (r.software ? ' (software renderer)' : ''));
      try { window.__uoWeakMachine = _weak; } catch (e) { /* never break a boot over a hint */ }
      
// Only the full clients warn. The mini is embedded in the portal (bar/window):
    // a modal inside that iframe would be wrong, and the player already got this
    // warning on the landing page before launching a minigame.
    if (!r.known || !r.software || window.__MINI__ === true) return;
    const KEY = 'cuo.gpuWarnDismissed';
    try { if (sessionStorage.getItem(KEY) === '1') return; } catch {}
    const show = () => {
      const modal = document.getElementById('browser-warn');
      const box = modal && modal.querySelector('.warn-box');
      if (!modal || !box) return;
      // textContent for the renderer string — it is browser-supplied, never trusted as HTML.
      box.innerHTML = '<div class="warn-title">Hardware acceleration looks disabled</div>' +
        '<p>Your browser is rendering with a <strong>software rasterizer</strong>, so every frame is ' +
        'drawn on the CPU. The client will run, but it will be <strong>very slow</strong> — even on ' +
        'the login screen.</p><p class="gpu-renderer"></p>' +
        '<p>Turn on <strong>Settings → System → Use graphics acceleration when available</strong> in ' +
        'Chrome/Edge and restart the browser. On a laptop, also check that a battery-saving mode is ' +
        'not forcing software rendering.</p>' +
        '<button class="warn-dismiss" id="browser-warn-ok">I Understand — Continue</button>';
      const rendererLine = box.querySelector('.gpu-renderer');
      if (rendererLine) rendererLine.textContent = 'Detected renderer: ' + r.renderer;
      modal.classList.remove('hidden');
      const btn = document.getElementById('browser-warn-ok');
      if (btn) btn.addEventListener('click', () => {
        try { sessionStorage.setItem(KEY, '1'); } catch {}
        modal.classList.add('hidden');
      }, { once: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
    else show();
  } catch { /* never block boot on a diagnostics probe */ }
})();

// Console silencer.
(() => {
  try {
    if (typeof location === 'undefined') return;
    const rawDev = new URLSearchParams(location.search).get('dev');
    const devGated = (() => {
      try {
        const m = document?.querySelector?.('meta[name="cuo-dev-mode"]');
        return !!(m && m.content === 'disabled-by-operator');
      } catch { return false; }
    })();
    const dev = devGated ? null : rawDev;
    if (dev === null) {
      const noop = () => {};
      for (const k of ['log', 'error', 'warn', 'info', 'debug', 'trace']) {
        if (typeof console !== 'undefined' && typeof console[k] === 'function') {
          console[k] = noop;
        }
      }
      return;
    }
    if (dev === '2') return;
    if (typeof console === 'undefined') return;
    const baseLog = console.log.bind(console);
    const NOISE_PATTERNS = [
      /WebGL: INVALID_ENUM: getInternalformatParameter: invalid internalformat/,
      // CUO upstream warns when globalprofile.json is absent (the file is
      // optional — only created on first explicit save of global settings).
      // Logged at every boot for users who never opened global settings.
      /\/Data\/Profiles\/globalprofile\.json not found/,
    ];
    const isNoise = (args) => {
      if (!args.length) return false;
      const first = args[0];
      if (typeof first !== 'string') return false;
      for (const rx of NOISE_PATTERNS) if (rx.test(first)) return true;
      return false;
    };
    const tag = (k) => (...args) => {
      if (isNoise(args)) return;
      baseLog(`[${k}]`, ...args);
    };
    for (const k of ['warn', 'error', 'trace']) {
      if (typeof console[k] === 'function') console[k] = tag(k);
    }
    // v0.4.41: also filter console.log via NOISE_PATTERNS. CUO upstream
    // routes "/Data/Profiles/globalprofile.json not found" through
    // Console.WriteLine (= console.log on JS side) — without wrapping log
    // too the regex in NOISE_PATTERNS is unreachable for that warning.
    console.log = (...args) => {
      if (isNoise(args)) return;
      baseLog(...args);
    };
  } catch {}
})();

// --- Corrupt-asset self-heal (operator 2026-06-17; surgical re-download 2026-06-18) ---
// A compressed gamefile (.uop/.mul) that arrives truncated/corrupt fails its ZLib CRC
// check inside a CUO Loader (e.g. StringDictionaryLoader.Load → "CRC mismatch"), which
// throws out of GameController.LoadContent and KILLS the boot — the client sits dead
// (loader hides at its 15s timeout, blank screen). A plain reload re-reads the SAME
// corrupt bytes from the cache and crashes identically. The C# exception is fatal to the
// WASM runtime, so the load can't be retried in place — a reload is required. But we do it
// SURGICALLY (operator 2026-06-18: "que reintente borrando y descargando ESE fichero de
// nuevo, no que vaya al dominio principal"): delete ONLY the offending file (identified
// from the last "Loading file: /uo/X" trace — the CRC message carries no name) so the
// reload re-downloads JUST that one, cache-busted past the CDN edge, and keeps everything
// else warm; then reload to the SAME shard (?slug=), never the picker/main domain. If a
// clean per-file re-download STILL fails, the pool blob is bad at the source — stop and
// show an actionable message instead of looping.
var _assetCorruptSeen = false; // var: hoisted, referenced from the console hook below
var _lastGamefile = '';        // last "/uo/X" the engine reported loading — a "CRC mismatch" carries no filename, so this tells us which ONE file to re-download
function _recoverFromCorruptAsset(detail) {
  if (_assetCorruptSeen) return;
  _assetCorruptSeen = true;
  const KEY = 'uo-asset-corrupt-recover';
  let stage = 0;
  try { stage = parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0; } catch { /* */ }
  try { window.__uoCrashSave && window.__uoCrashSave('asset-corrupt', detail); } catch { /* */ }
  // Recovery = FULL gamefile-cache WIPE + reload (operator 2026-06-18). The earlier
  // "surgical" per-file skip only bypassed the bad file for the RECOVERY boot — it left the
  // poisoned bytes ON DISK (pool responses often carry no ETag, so cachePut never overwrote
  // them), so the very NEXT normal boot read the corrupt copy again → "CRC mismatch" loop,
  // exactly what the operator saw ("no borra la caché solo"). A full wipe deletes the bad
  // entry for good; the reload re-downloads every file fresh from the public content-
  // addressed pool. stage 0 = wipe+reload; stage 1 = give up (bytes are bad at the source).
  if (stage >= 1) {
    try { sessionStorage.removeItem(KEY); sessionStorage.removeItem('uo-recover-file'); } catch { /* */ }
    try { _bootWd.done = true; } catch { /* */ }
    try { uiStatus('A game file failed its integrity check and a clean re-download did not fix it (server-side). Please report it.'); } catch { /* */ }
    return;
  }
  try { sessionStorage.setItem(KEY, String(stage + 1)); } catch { /* */ }
  try { sessionStorage.removeItem('uo-recover-file'); } catch { /* */ } // retire the old surgical flag
  try { _bootWd.done = true; } catch { /* */ } // stop the boot-watchdog racing this reload
  try { uiStatus('A game file failed its integrity check — clearing the cache and re-downloading…'); } catch { /* */ }
  // Preserve the shard so the recovery boot retries the SAME server (?slug=), not the picker.
  let _slug = '';
  try { _slug = sessionStorage.getItem('chosenServerSlug') || (typeof window !== 'undefined' && window.__chosenServerSlug) || ''; } catch { /* */ }
  (async () => {
    // Wipe BOTH cache backends so the reload can't read the poisoned copy from either.
    try { if (navigator.storage && navigator.storage.getDirectory) { const root = await navigator.storage.getDirectory(); await root.removeEntry('cuo-assets', { recursive: true }).catch(() => {}); } } catch { /* */ }
    try { await new Promise((r) => { const rq = indexedDB.deleteDatabase('cuo-assets'); rq.onsuccess = rq.onerror = rq.onblocked = () => r(); }); } catch { /* */ }
    setTimeout(() => {
      try {
        const u = new URL(location.href);
        if (_slug) u.searchParams.set('slug', _slug); // auto-reselect the shard → no picker detour
        u.searchParams.set('nocache', '1');           // belt-and-suspenders: boot also re-clears OPFS+IDB
        location.replace(u.href);
      } catch { try { location.reload(); } catch { /* */ } }
    }, 400);
  })();
}

// --- Crash black-box (v0.8.90) -------------------------------------
// Operator hit the "type fast right as the LoginGump appears → client
// freezes/crashes" bug twice in a row but couldn't capture a log (no
// DevTools open; console silenced for non-?dev sessions). This recorder
// runs unconditionally and AFTER the silencer, wrapping whatever the
// console methods currently are (noop for silenced users) — so it
// captures the engine's output into a rolling in-memory buffer even
// when nothing is printed. On a crash (window.onerror /
// unhandledrejection — wasm aborts surface as RuntimeError through
// these) it persists the tail + JS-heap stats to localStorage. A 2 s
// heartbeat also records "page alive" + the engine's last
// draw-heartbeat, so a FROZEN tab (no JS error at all — e.g. deputy
// worker deadlock) is detected on the NEXT boot as a dirty end with
// "engine stopped N s before the page died". The next page load prints
// the whole report as [crash-report] lines — just reload and copy.
(() => {
  try {
    if (typeof localStorage === 'undefined') return;
    const MAX_LINES = 200;
    const buf = [];
    const t0 = performance.now();
    const push = (kind, args) => {
      try {
        let s = '';
        for (const a of args) {
          s += (typeof a === 'string' ? a
               : (a && a.message) ? a.message
               : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()) + ' ';
          if (s.length > 400) break;
        }
        buf.push(`T+${(performance.now() - t0).toFixed(0)} [${kind}] ${s.slice(0, 400)}`);
        if (buf.length > MAX_LINES) buf.shift();
        // v0.8.98 audit fix: every non-error console line is a liveness
        // signal for the boot watchdog — the C# engine boot (runtime-ready →
        // LoginGump) logs continuously but emits no JS-side progress events,
        // so heavy shards (Memento cold) could exceed the 45 s net while
        // perfectly healthy. kind!=='error' keeps the watchdog's own
        // [boot-watchdog] console.error from resetting its own timer.
        if (kind !== 'error') { try { _bootProgress(); } catch { /* pre-wire TDZ */ } }
        // Corrupt-asset self-heal: a ZLib CRC failure decompressing a gamefile
        // (e.g. "CRC mismatch" in StringDictionaryLoader.Load) is a fatal boot
        // crash. Purge the cache + reload once so the bad bytes can't persist.
        // Track the gamefile the engine is currently loading; a "CRC mismatch" carries
        // no filename, so the last "Loading file: /uo/X" trace tells us which ONE to re-pull.
        { const _lf = /Loading file:\s*\/uo\/([^\s]+)/i.exec(s); if (_lf) _lastGamefile = _lf[1]; }
        try { if (!_assetCorruptSeen && /CRC mismatch|ZLibManaged\.Decompress/i.test(s)) _recoverFromCorruptAsset(s.slice(0, 200)); } catch { /* never break the console */ }
      } catch { /* never break the console */ }
    };
    for (const k of ['log', 'error', 'warn', 'info']) {
      const prev = (typeof console[k] === 'function') ? console[k].bind(console) : null;
      console[k] = (...args) => { push(k, args); if (prev) prev(...args); };
    }
    const memStr = () => {
      try {
        const m = performance.memory;
        return m ? `jsHeap=${(m.usedJSHeapSize / 1048576) | 0}/${(m.totalJSHeapSize / 1048576) | 0}MB limit=${(m.jsHeapSizeLimit / 1048576) | 0}MB` : 'jsHeap=n/a';
      } catch { return 'jsHeap=n/a'; }
    };
    const save = (reason, extra) => {
      try {
        localStorage.setItem('uo-crash-report', JSON.stringify({
          when: new Date().toISOString(),
          reason,
          extra: String(extra || '').slice(0, 1000),
          mem: memStr(),
          url: location.href.split('#')[0].slice(0, 200),
          tail: buf.slice(-120),
        }));
      } catch { /* storage full/blocked — nothing else to do */ }
    };
    window.__uoCrashSave = save;

    // OUT-OF-MEMORY gets NAMED, instead of looking like a stall (operator goal
    // "que funcione en PCs antiguos"). This client takes a FIXED wasm heap with
    // -sINITIAL_MEMORY and ALLOW_MEMORY_GROWTH=0, so the whole thing is COMMITTED
    // at boot and a machine without the RAM fails at allocation — an error, not
    // silence.
    //
    // 🚨 THE SIZE DIFFERS PER BUNDLE, and the first version of this message got it
    // wrong: it said "about 3 GB" for everybody, taken from a comment in
    // classicuo-wasm.csproj that read "3 GiB" while the value beside it read
    // 2147483648. The mini asks for 1 GiB. Telling somebody with 2.5 GB free that
    // they need 3 sends them away from a client that would have run — an error
    // message has to be TRUE for the machine reading it, so it is derived from
    // the bundle rather than hardcoded once. Keep these in step with
    // UoWasmMemBytes in the three .csproj files; there is no build-time channel
    // that carries the number into this shared file. Pre-fix that
    // error was only SAVED here; on screen the loader just sat there until the
    // boot-watchdog fired 25-45 s later, reloaded once, failed identically, and
    // then advised "reload, or clear the cache" — advice that CANNOT work when
    // the cause is RAM. A wrong reason is worse than no reason: it sends the
    // player to do the one thing guaranteed not to help.
    //
    // Deliberately NOT a preflight:
    //   - Allocating 3 GiB to test for 3 GiB can itself CAUSE the failure it
    //     probes — shared wasm memory reserves the whole maximum up front, and
    //     the engine reclaims that address space at GC, i.e. possibly AFTER the
    //     real allocation is attempted.
    //   - navigator.deviceMemory rounds DOWN to a power of two (a 6 GB machine
    //     reports 4), so a threshold on it warns machines that work fine.
    // Waiting for the real failure costs the player the boot they were going to
    // lose anyway, and is never wrong.
    let _oomShown = false;
    const flagOom = (detail) => {
      if (_oomShown) return;
      if (!/out of memory|could not allocate|array buffer allocation failed|cannot enlarge memory|memory allocation failed|\bOOM\b/i.test(String(detail || ''))) return;
      _oomShown = true;
      // Guarded individually: this listener can fire before the module-scope
      // consts below are initialised, and a ReferenceError inside an error
      // handler would swallow the whole message.
      try { _bootWd.done = true; } catch { /* pre-wire TDZ */ }   // stop the reload that repeats it
      try { sessionStorage.removeItem('uo-boot-autoreload'); } catch {}
      try {
        // Kept to roughly the length of the watchdog's own line — the status
        // strip is one row and a paragraph here would overflow it.
        const needGb = (typeof window !== 'undefined' && window.__bundle === 'mini') ? '1 GB' : '2 GB';
        uiStatus(`Not enough memory — the game needs about ${needGb} free. Close other `
          + 'tabs and programs and try again; a 64-bit browser is required.');
      } catch { /* loader UI not wired yet */ }
    };

    window.addEventListener('error', (e) => {
      save('window.onerror', `${e.message} @${e.filename}:${e.lineno}`);
      flagOom(e.message);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const why = e.reason && (e.reason.message || String(e.reason));
      save('unhandledrejection', why);
      flagOom(why);
    });
    // Engine liveness: the wasm draw loop dispatches cuo:draw-heartbeat;
    // record its last timestamp inside the 2 s page-alive beacon so a
    // frozen engine under a live page is visible post-mortem.
    let engineT = 0;
    window.addEventListener('cuo:draw-heartbeat', () => { engineT = Date.now(); });
    // TYPING TRACE (operator 2026-07-09: random freeze when typing FAST right as the LoginGump appears —
    // unreproducible, so arm the trap): count keydowns per ~1s bucket into the black-box buffer for the
    // first 3 minutes of a session. The next dirty-end/crash report then shows exactly how much typing
    // happened and WHEN relative to the boot lines around it. PRIVACY: counts only — never key identities
    // (the LoginGump takes a password). Stops itself once the window passes (in-world sessions type a lot).
    try {
      let _kt0 = 0, _ktN = 0;
      const _ktFlush = () => { if (_ktN > 0) { push('keys', [`n=${_ktN}/s`]); _ktN = 0; } };
      const _ktOn = (e) => {
        if (performance.now() - t0 > 180000) { window.removeEventListener('keydown', _ktOn, true); _ktFlush(); return; }
        const now = performance.now();
        if (now - _kt0 > 1000) { _ktFlush(); _kt0 = now; }
        _ktN++;
      };
      window.addEventListener('keydown', _ktOn, true);
    } catch { /* trace is best-effort */ }
    setInterval(() => {
      try { localStorage.setItem('uo-alive', JSON.stringify({ t: Date.now(), e: engineT, m: memStr(), a: window.__uoArm || null })); } catch {}
      // HARD-FREEZE tail (operator 2026-07-10 "esa pestaña se bloquea y se congela, tengo que cerrar el
      // navegador"): save() only fires on a JS exception, so a wedged main thread (no error event, no
      // pagehide) used to lose the console tail — the one place the [opfs-snap] SLOW evidence lives.
      // Persist the last ~40 lines with every 2 s beat; the tab may die at any instant and the freshest
      // beat still holds the final seconds. Read back on the NEXT boot (any tab, same origin).
      try { localStorage.setItem('uo-alive-tail', JSON.stringify(buf.slice(-40))); } catch { /* storage full — beat stays */ }
    }, 2000);
    window.addEventListener('pagehide', () => {
      try { localStorage.setItem('uo-clean-exit', String(Date.now())); } catch {}
      // 🚨 A SESSION THAT RECOVERED IS NOT A CRASH. `save()` records every window error and
      // every unhandled rejection, and the next boot announced all of them as "PREVIOUS CRASH"
      // — including ones the page shrugged off and played through. That already happened once
      // for real: a transient ERR_HTTP2_PROTOCOL_ERROR on anim5.mul that the retry loop
      // RECOVERED from still produced "reason=unhandledrejection" telemetry for a healthy boot
      // (smoke, 2026-07-26). Reaching pagehide means the tab closed the normal way, so whatever
      // was recorded did not end the session.
      //
      // MARKED, NOT DELETED: the error did happen and its console tail is the useful part. Only
      // the claim changes. Any record still here was written by THIS session — the post-mortem
      // removes it after reading, so nothing older survives to be mislabelled.
      try {
        const pending = localStorage.getItem('uo-crash-report');
        if (pending) {
          const r = JSON.parse(pending);
          r.recovered = true;
          localStorage.setItem('uo-crash-report', JSON.stringify(r));
        }
      } catch { /* unreadable or storage full — the next boot still reports what it can */ }
      // 🚨 SAME MARK FOR THE BOOT RECEIPT, and here it decides a NUMBER rather than a sentence.
      // A receipt left behind is read as "the previous boot never finished" and POSTed to
      // /api/boot-failure — the count that exists to answer "one boot in five, or one in five
      // hundred?". But a player who gets bored during a WASM load and closes the tab leaves the
      // same receipt, and the long stages (asset download, world mount, runtime instantiation)
      // are exactly where boredom lives. The earliest stage was already excluded for this reason
      // ("a page they left, not a hang"); the expensive ones were not, so the rate was inflated
      // by the very behaviour a slow boot encourages.
      //
      // pagehide is the discriminator BECAUSE of what cannot run it: a wedged main thread never
      // reaches this line, so an unmarked receipt still means a hang or a hard kill. Marked, not
      // cleared — the stage they left at is worth counting separately, not throwing away.
      try {
        const boot = localStorage.getItem('uo-boot-receipt');
        if (boot) {
          const br = JSON.parse(boot);
          br.left = true;
          localStorage.setItem('uo-boot-receipt', JSON.stringify(br));
        }
      } catch { /* best effort — a diagnostic must never be what breaks an exit */ }
    });
    // Boot-time post-mortem of the PREVIOUS session.
    //
    // 🚨 TOP-LEVEL ONLY. localStorage is shared by every document on the origin, and a minigame
    // boots this same loader INSIDE AN IFRAME while the real client is still running in the parent.
    // From in there, the parent's live heartbeat looks exactly like a session that ended without a
    // clean exit — because it has not ended — so opening Minigames accused the player's own running
    // game of having frozen. Reported by the operator on 2026-09-03: "es muy molesto, no viene a
    // cuento porque precisamente ha cargado".
    //
    // A framed boot cannot tell a dead session from its own parent, so it does not get to judge:
    // the post-mortem belongs to the tab that owns the keys. The heartbeat below is left alone; only
    // the verdict is withheld.
    const _isTopLevel = (() => { try { return window.top === window.self; } catch { return false; } })();
    try {
      const alive = _isTopLevel ? JSON.parse(localStorage.getItem('uo-alive') || 'null') : null;
      const clean = Number(localStorage.getItem('uo-clean-exit') || 0);
      if (alive && (!clean || clean < alive.t - 4000)) {
        // 🚨 SAY WHICH OF THE TWO THIS WAS. Both cases used to print "PREVIOUS SESSION ENDED
        // DIRTY (frozen or killed)", and only one of them is the thing this black box exists to
        // catch. A session whose engine NEVER BEAT was not frozen: it never started. That is
        // every portal page — the shop, a profile, the backpack — because none of them boot the
        // game, so simply closing one of those tabs without a pagehide printed the loudest line
        // in the file. Found on 2026-08-02 by reading it back and discovering the "frozen
        // session" was a tab a probe had opened and closed minutes earlier.
        //
        // Burying the real signal under routine noise is how a black box stops being read at
        // all, so the two are now different sentences and only one of them says "frozen".
        const ranEngine = !!alive.e;
        const engGap = ranEngine
          ? ` engineLastBeat=${((alive.t - alive.e) / 1000).toFixed(0)}s-before-end`
          : ' engine=never-beat';
        // 🚨 WHICH SIGNAL OPENED THE INPUT GATE, on the session that then died. The gate exists to
        // keep keystrokes out until the boot work drains, and it has a 3 s fallback that opens
        // ANYWAY so a machine that never settles stays playable. Those are opposite stories about a
        // freeze-while-typing, and the frozen tab cannot be asked which one it was. Persisted with
        // the heartbeat, so it is here to read now.
        if (alive.a && alive.a.why) {
          console.error(`[crash-report] input gate had ARMED: why=${alive.a.why} at=${alive.a.ms}ms`
            + (/fallback/.test(alive.a.why)
              ? ' — the 3 s escape hatch, NOT real quiescence: the thread had not settled when typing was allowed'
              : ' — real quiescence, so the gate is not the explanation for this one'));
        }
        console.error(ranEngine
          ? `[crash-report] PREVIOUS GAME SESSION ENDED DIRTY (frozen or killed, no pagehide) — the engine WAS running. lastAlive=${new Date(alive.t).toISOString()}${engGap} ${alive.m}`
          : `[crash-report] previous session ended without a clean exit, but its engine never started — a page that does not run the game, or a tab closed during load. Not a freeze. lastAlive=${new Date(alive.t).toISOString()}${engGap} ${alive.m}`);
        // Console tail persisted by the 2 s heartbeat — the frozen tab itself was unreachable (operator
        // 2026-07-10), so this is the ONLY record of what the session printed in its final seconds.
        try {
          const dtail = JSON.parse(localStorage.getItem('uo-alive-tail') || 'null');
          if (dtail && dtail.length) {
            console.error(`[crash-report] console tail of the ${ranEngine ? 'frozen' : 'previous'} session (last heartbeat):\n` + dtail.join('\n'));
            // The REASON travels too: anything reading this programmatically was told "dirty-end"
            // for both cases and could not tell them apart either.
            window.__uoLastCrash = window.__uoLastCrash
              || { reason: ranEngine ? 'dirty-end-engine-running' : 'dirty-end-engine-never-started', tail: dtail };
          }
        } catch { /* tail unreadable — the line above still fires */ }
      }
      const rep = localStorage.getItem('uo-crash-report');
      if (rep) {
        const r = JSON.parse(rep);
        // `recovered` is stamped at pagehide: the session hit this error and then closed
        // normally, so it is a fault worth reading, not a crash. Saying CRASH for both is how
        // the loud line stops meaning anything.
        console.error(r.recovered
          ? `[crash-report] the previous session hit an error and then exited normally — NOT a crash. @${r.when} reason=${r.reason} ${r.mem} :: ${r.extra}`
          : `[crash-report] PREVIOUS CRASH @${r.when} reason=${r.reason} ${r.mem} :: ${r.extra}`);
        console.error(`[crash-report] console tail of the ${r.recovered ? 'previous' : 'crashed'} session:\n` + (r.tail || []).join('\n'));
        window.__uoLastCrash = r;       // programmatic access for bots
        localStorage.removeItem('uo-crash-report');
      }
      localStorage.removeItem('uo-clean-exit');
      localStorage.removeItem('uo-alive');
      localStorage.removeItem('uo-alive-tail');
    } catch {}
  } catch { /* recorder must never break boot */ }
})();

// Host page.


import { dotnet } from './_framework/dotnet.js';

let _perfLoginMarked = false;
function perfMark(label) {
  console.log(`[perf] T+${performance.now().toFixed(0)}ms ${label}`);
  // v0.8.97: every boot checkpoint feeds the boot watchdog, so legit
  // silent stretches between marks shrink to the unhookable parts only
  // (dotnet runtime instantiation), covered by the 45 s threshold.
  try { _bootProgress(); } catch { /* watchdog not wired yet at module eval */ }
}
perfMark('main.js module eval (page load)');

// --- Publish mismatch auto-recovery -------------------------------
// v0.7.8: per-bundle storage keys so cross-bundle navigation (CUO →
// TUO via forceClient pin) doesn't fire the stale-shell recovery and
// force a nocache reload back to /. Pre-v0.7.8 both bundles wrote to
// the same `cuo.lastBootFingerprint` key, so the TUO bundle would
// always see a "fingerprint changed" event on first load post-CUO,
// trigger location.replace(?nocache=1), and the user ended up back
// on CUO with the slug auto-select silently picking a TUO-pinned
// shard on the wrong bundle.
const _BUNDLE_KEY_PREFIX = (typeof window !== 'undefined' && window.__bundle === 'mini') ? 'mini'
  : (typeof window !== 'undefined' && window.__bundle === 'tuo') ? 'tuo' : 'cuo';
const BOOT_FP_KEY = `${_BUNDLE_KEY_PREFIX}.lastBootFingerprint`;
const BOOT_OK_KEY = `${_BUNDLE_KEY_PREFIX}.lastBootCompleted`;
function boot_currentFingerprint() {
  try { return new URL(import.meta.url).pathname; } catch { return null; }
}
function boot_recoverIfMismatch() {
  if (new URLSearchParams(location.search).get('nocache') === '1') return;
  let prev = null, lastOK = null;
  try { prev = localStorage.getItem(BOOT_FP_KEY); } catch {}
  try { lastOK = localStorage.getItem(BOOT_OK_KEY); } catch {}
  const cur = boot_currentFingerprint();
  if (prev && cur && prev !== cur && lastOK !== '1') {
    console.warn(`[boot] fingerprint changed (${prev} -> ${cur}) AND previous boot did not complete; assuming stale-shell mismatch, wiping IndexedDB and reloading.`);
    try {
      indexedDB.deleteDatabase('cuo-assets');
      indexedDB.deleteDatabase('cuo-files-v1');
    } catch {}
    // Mark the new fingerprint so we don't loop reload-forever.
    try { localStorage.setItem(BOOT_FP_KEY, cur); } catch {}
    try { localStorage.setItem(BOOT_OK_KEY, '0'); } catch {}
    // Rebuild the reload URL on THIS bundle's real nginx path, not
    // location.href: the transparent-path IIFE above already rewrote the
    // URL bar to '/' (history.replaceState), so location.href has lost the
    // /tuo/ prefix by the time we run. Reloading location.href from the TUO
    // bundle landed the user on the CUO bundle with the slug still in the
    // query — the "picker click on a TUO shard sticks at /?slug=… until a
    // manual refresh" bug (operator report 2026-06-11).
    const bundlePath = (typeof window !== 'undefined' && window.__bundle === 'mini')
      ? (location.pathname.replace(/[^/]*$/, '') || '/')   // mini: reload its real mount (/mini/ or /), it has no path-strip
      : (typeof window !== 'undefined' && window.__bundle === 'tuo') ? '/tuo/' : '/';
    const url = new URL(bundlePath + location.search + location.hash, location.origin);
    url.searchParams.set('nocache', '1');
    location.replace(url.toString());
  } else if (cur) {
    try { localStorage.setItem(BOOT_FP_KEY, cur); } catch {}
    try { localStorage.setItem(BOOT_OK_KEY, '0'); } catch {}
  }
}
boot_recoverIfMismatch();

// --- Poisoned HTTP cache: NOT auto-recovered, and this is the honest state ---------
//
// 🚨 THIS RECOVERY WAS BUILT, TESTED FOUR TIMES, NEVER WORKED, AND HAS BEEN REMOVED. Shipping code
// that looks like a safety net and is not one is worse than shipping nothing: the next person
// reading it would believe the failure below is handled, and would not add the guard that matters.
//
// THE FAILURE. `_framework/*` is served `Cache-Control: immutable, max-age=1y`, promising the bytes
// at a URL never change, while the fingerprint in those filenames hashes the SOURCE rather than the
// final bytes. Any post-build rewrite — the build-path strip — therefore changes content under a
// URL that promised not to, and every browser holding the old bytes blocks a dozen modules for a
// year. A normal reload does not even request an immutable asset, and `?nocache=1` clears OPFS and
// IndexedDB rather than the HTTP cache, so nothing the player can do from inside the page fixes it.
// On 2026-09-02 this presented as "the minigames have no arena" and cost most of a day.
//
// WHY IT COULD NOT BE DETECTED FROM PAGE SCRIPT, measured rather than assumed. The blocked resource
// is the LOADER itself, fetched by the browser's own module machinery through the importmap. The
// browser logs "Failed to find a valid digest in the integrity attribute" to the console and the
// import never settles: no `error` event, no `unhandledrejection`, nothing observable. Four attempts
// died on that, each plausibly:
//   1. matching the word "integrity" — it is in the console text, never in the rejected TypeError,
//      whose message is only "Failed to fetch";
//   2. guarding on a canvas wider than 100px — index.html ships `<canvas width="640">`, true from
//      the first paint;
//   3. guarding on `window.__booted` — nothing in this codebase sets it;
//   4. guarding on `window.UORailBridge` — main.js assigns that itself, not the WASM.
// A fifth version measured the cached loader against the pinned digest with `only-if-cached` and
// still never fired. Each failure was silent, and each looked like a working fix in review.
//
// WHAT ACTUALLY PREVENTS IT, and where those guards live:
//   · never strip a bundle that has already been served (standing warning in strip-build-paths.mjs);
//   · deploy, then purge, then prove by fetching (finish-deploy.mjs);
//   · verify BOTH integrity manifests against the served bytes (verify-served-sri.mjs).
// The real cure is for the fingerprint to hash the final bytes, which would make `immutable` honest.
// Until then, a player already poisoned must clear site data — and the deploy path is built so that
// nobody gets poisoned in the first place.


// --- Required files ------------------------------------------------
const REQUIRED_FILES = [
  ['tiledata.mul', 'tiledata.mul'],
  ['hues.mul',     'hues.mul'],
  ['radarcol.mul', 'radarcol.mul'],
  ['fonts.mul',    'fonts.mul'],
  ['gumpart.mul',  'gumpart.mul'],
  ['gumpidx.mul',  'gumpidx.mul'],
  ['art.mul',      'art.mul'],
  ['artidx.mul',   'artidx.mul'],
  ['multi.mul',    'multi.mul'],
  ['multi.idx',    'multi.idx'],
  ['skills.mul',   'skills.mul'],
  ['skills.idx',   'skills.idx'],
  ['texmaps.mul',  'texmaps.mul'],
  ['texidx.mul',   'texidx.mul'],
  ['map0.mul',     'map0.mul'],
  ['map1.mul',     'map1.mul'],
  ['map2.mul',     'map2.mul'],
  ['map3.mul',     'map3.mul'],
  ['map4.mul',     'map4.mul'],
  ['map5.mul',     'map5.mul'],
  ['staidx0.mul',  'staidx0.mul'],
  ['staidx1.mul',  'staidx1.mul'],
  ['staidx2.mul',  'staidx2.mul'],
  ['staidx3.mul',  'staidx3.mul'],
  ['staidx4.mul',  'staidx4.mul'],
  ['staidx5.mul',  'staidx5.mul'],
  ['statics0.mul', 'statics0.mul'],
  ['statics1.mul', 'statics1.mul'],
  ['statics2.mul', 'statics2.mul'],
  ['statics3.mul', 'statics3.mul'],
  ['statics4.mul', 'statics4.mul'],
  ['statics5.mul', 'statics5.mul'],
  ['cliloc.enu',   'cliloc.enu'],
  ['citytext.enu', 'citytext.enu'],
  ['light.mul',    'light.mul'],
  ['lightidx.mul', 'lightidx.mul'],
  ['anim.mul',     'anim.mul'],
  ['anim.idx',     'anim.idx'],
  ['anim2.mul',    'anim2.mul'],
  ['anim2.idx',    'anim2.idx'],
  ['anim3.mul',    'anim3.mul'],
  ['anim3.idx',    'anim3.idx'],
  ['anim4.mul',    'anim4.mul'],
  ['anim4.idx',    'anim4.idx'],
  ['anim5.mul',    'anim5.mul'],
  ['anim5.idx',    'anim5.idx'],
  ['animationframe1.uop', 'animationframe1.uop'],
  ['animationframe2.uop', 'animationframe2.uop'],
  ['animationframe3.uop', 'animationframe3.uop'],
  ['animationframe4.uop', 'animationframe4.uop'],
  ['animationsequence.uop', 'animationsequence.uop'],
  ['mainmisc.uop', 'mainmisc.uop'],
  ['tileart.uop',  'tileart.uop'],
  ['animdata.mul', 'animdata.mul'],
  ['sound.mul',    'sound.mul'],
  ['soundidx.mul', 'soundidx.mul'],
  ['speech.mul',   'speech.mul'],
  ['body.def',     'body.def'],
  ['bodyconv.def', 'bodyconv.def'],
  ['unifont.mul',   'unifont.mul'],
  ['unifont1.mul',  'unifont1.mul'],
  ['unifont2.mul',  'unifont2.mul'],
  ['unifont3.mul',  'unifont3.mul'],
  ['unifont4.mul',  'unifont4.mul'],
  ['unifont5.mul',  'unifont5.mul'],
  ['unifont6.mul',  'unifont6.mul'],
  ['unifont7.mul',  'unifont7.mul'],
  ['unifont8.mul',  'unifont8.mul'],
  ['unifont9.mul',  'unifont9.mul'],
  ['unifont10.mul', 'unifont10.mul'],
  ['unifont11.mul', 'unifont11.mul'],
  ['unifont12.mul', 'unifont12.mul'],
  ['music/digital/config.txt', 'music/digital/config.txt'],
  ['mobtypes.txt', 'mobtypes.txt'],
  ['anim1.def',     'anim1.def'],
  ['anim2.def',     'anim2.def'],
  ['anim3.def',     'anim3.def'],
  ['anim4.def',     'anim4.def'],
  ['equipconv.def', 'equipconv.def'],
  ['body.def',      'body.def'],
  ['bodyconv.def',  'bodyconv.def'],
  ['corpse.def',    'corpse.def'],
  ['gump.def',      'gump.def'],
  ['art.def',       'art.def'],
  ['sound.def',     'sound.def'],
  ['stitchin.def',  'stitchin.def'],
  ['texterr.def',   'texterr.def'],
  ['walls.txt',     'walls.txt'],
  ['floors.txt',    'floors.txt'],
  ['doors.txt',     'doors.txt'],
  ['misc.txt',      'misc.txt'],
  ['stairs.txt',    'stairs.txt'],
  ['teleprts.txt',  'teleprts.txt'],
  ['roof.txt',      'roof.txt'],
  ['suppinfo.txt',  'suppinfo.txt'],

  ['prof.txt',      'prof.txt'],
  ['multimap.rle',  'multimap.rle'],
  ['skillgrp.mul',  'skillgrp.mul'],
  ['animinfo.mul',  'animinfo.mul'],
];

// --- Loader UI -----------------------------------------------------

const loaderEl   = document.getElementById('loader');
const fillEl     = document.getElementById('loader-fill');
const statusEl   = document.getElementById('loader-status');
const detailEl   = document.getElementById('loader-detail');

// --- Game Mode (fullscreen + keyboard.lock) -----------------------
const KEY_LOCK_SET = [
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'Numpad0','Numpad1','Numpad2','Numpad3','Numpad4',
  'Numpad5','Numpad6','Numpad7','Numpad8','Numpad9',
  'NumpadAdd','NumpadSubtract','NumpadMultiply','NumpadDivide',
  'NumpadEnter','NumpadDecimal','NumLock',
  'Digit0','Digit1','Digit2','Digit3','Digit4',
  'Digit5','Digit6','Digit7','Digit8','Digit9',
  'Escape','Tab',
  'ControlLeft','ControlRight',
  'AltLeft','AltRight',
  'MetaLeft','MetaRight',
  'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
  'Home','End','PageUp','PageDown','Insert','Delete',
  'KeyR','KeyT','KeyW','KeyN','KeyL','KeyJ','KeyI','KeyH','KeyD','KeyF','KeyS',
  'Backspace',
  // Gameview screenshot (operator 2026-06-23): in fullscreen game-mode, locking
  // PrintScreen lets the in-client capture run without the OS PrtScn->clipboard
  // grab. (Outside fullscreen the OS shot can't be suppressed; the C# capture
  // fires regardless — see the keydown handler + window.UONexusScreenshot.)
  'PrintScreen',
];

async function enterGameMode(stageEl) {
  try {
    if (!document.fullscreenElement && stageEl.requestFullscreen) {
      await stageEl.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch (e) {
    console.warn('[input] fullscreen request failed:', e?.message ?? e);
  }
  try {
    if (navigator.keyboard?.lock) {
      await navigator.keyboard.lock(KEY_LOCK_SET);
      console.log(`[input] game-mode: keyboard lock engaged (${KEY_LOCK_SET.length} keys)`);
    } else {
      console.warn('[input] navigator.keyboard.lock not supported (Firefox/Safari); F-keys + Ctrl-combos will still hit browser UI.');
    }
  } catch (e) {
    console.warn('[input] keyboard.lock failed:', e?.message ?? e);
  }
}

function exitGameMode() {
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen();
    }
  } catch {}
  try {
    if (navigator.keyboard?.unlock) {
      navigator.keyboard.unlock();
    }
  } catch {}
}

function wireGameMode(stageEl, canvas) {
  const btn = document.getElementById('gamemode-toggle');
  if (!btn) return;
  const qs = new URLSearchParams(location.search);
  const autoDisabled = qs.get('autofullscreen') === '0';

  const refreshLabel = () => {
    if (document.fullscreenElement) {
      btn.setAttribute('aria-pressed', 'true');
      btn.title = 'Exit Game Mode';
    } else {
      btn.setAttribute('aria-pressed', 'false');
      btn.title = 'Game Mode — fullscreen + capture F1-F24 / numpad / Ctrl+combos';
    }
  };

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (document.fullscreenElement) {
      exitGameMode();
    } else {
      enterGameMode(stageEl);
    }
  });

  document.addEventListener('fullscreenchange', () => {
    refreshLabel();
    if (!document.fullscreenElement) {
      try { navigator.keyboard?.unlock?.(); } catch {}
    }
  });

  // The rail's own bottom fullscreen button drives this SAME game-mode path
  // (fullscreen + keyboard.lock), so there is no separate floating button to
  // duplicate/overlap it — rail.js hides #gamemode-toggle once it mounts.
  window.UORailGameMode = {
    toggle: () => { if (document.fullscreenElement) { exitGameMode(); } else { enterGameMode(stageEl); } },
    active: () => !!document.fullscreenElement,
  };

  refreshLabel();
  void autoDisabled;
}

// --- Encryption ---------------------------------------------------
// 🚨 THE DROPDOWN IS NOT IN THIS BUILD, so the picker that drove it was 35 lines that returned on
// their first statement: `document.getElementById('encryption-select')` is null here and always
// will be. It came across with the hand-trim because it lives in main.js rather than in the picker
// markup that was deleted.
//
// Encryption is per-install in this build: `encrypt` in config.json, read by minimal-boot. A player
// does not choose it, because there is one shard and its cipher is not a preference.
//
// The names survive: ?encrypt= and the stored byte are still read below when a settings payload is
// assembled, and both round-trip through these ids.
const BYTE_TO_NAME = ['none', 'old', '1_25_36', 'blowfish', '2_0_3', 'twofish'];

function uiStatus(msg)  { if (statusEl) statusEl.textContent = msg; }
function uiDetail(msg)  { if (detailEl) detailEl.textContent = msg || '\u00A0'; }
let _lastUiProgress = 0;
function uiProgress(f)  { _lastUiProgress = f; if (fillEl)   fillEl.style.width = Math.max(0, Math.min(100, f * 100)).toFixed(1) + '%';
  // mini overlay relays load progress to its host page (embed.js task-bar). No-op for cuo/tuo.
  if (window.__miniHooks && window.__miniHooks.progress) { try { window.__miniHooks.progress(f); } catch {} }
}

// --- Per-file download panel (last 5 in-flight files) --------------
// Shows one row per file actively downloading, each with its own bar +
// live MB/s rate. Only network downloads reach here \u2014 cached files take
// the fetchFileCached fast path and never call _dlStart. The panel keeps
// the 5 most-recently-started files visible (active + just-finished) and
// rolls older ones out. The progress bar is asymptotic (we can't know the
// decompressed total of a brotli .br up front), but the MB + MB/s figures
// are real, measured off the byte stream.
//
// The container + CSS are created here (not in index.html) so the whole
// feature lives in the JS loader layer and ships via the FAST web-only
// rebuild (build-web.mjs doesn't re-inject index.html body/styles).
let dlPanelEl = null;
function _dlEnsurePanel() {
  if (dlPanelEl) return dlPanelEl;
  // Inject the stylesheet once.
  if (!document.getElementById('loader-downloads-style')) {
    const st = document.createElement('style');
    st.id = 'loader-downloads-style';
    st.textContent = `
      #loader-downloads { width: 420px; max-width: 80vw; margin-top: 12px;
        display: flex; flex-direction: column; gap: 6px; }
      #loader-downloads .dl-row { opacity: 0; transform: translateY(4px);
        transition: opacity 200ms ease-out, transform 200ms ease-out; }
      #loader-downloads .dl-row.dl-in { opacity: 1; transform: none; }
      #loader-downloads .dl-head { display: flex; justify-content: space-between;
        align-items: baseline; font-size: 11px; line-height: 1.3;
        font-family: ui-monospace, Menlo, Consolas, monospace; margin-bottom: 2px; }
      #loader-downloads .dl-name { color: #c8ba96; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
      #loader-downloads .dl-row.dl-done .dl-name { color: #9a8a64; }
      #loader-downloads .dl-rate { color: #9a8a64;
        font-variant-numeric: tabular-nums; white-space: nowrap; }
      #loader-downloads .dl-row.dl-done .dl-rate { color: #7a8a5a; }
      #loader-downloads .dl-bar { height: 4px; background: #1d1912;
        border-radius: 999px; overflow: hidden; }
      #loader-downloads .dl-fill { height: 100%; width: 0%;
        background: linear-gradient(90deg, #5a4319 0%, #d8b97a 100%);
        transition: width 140ms linear; }
      #loader-downloads .dl-row.dl-done .dl-fill {
        background: linear-gradient(90deg, #4a5a2a 0%, #9ab86a 100%); }`;
    (document.head || document.documentElement).appendChild(st);
  }
  // Mount the container inside the loading section (or fall back to #loader).
  let el = document.getElementById('loader-downloads');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loader-downloads';
    el.setAttribute('aria-hidden', 'true');
    const host = document.getElementById('loading-section') || loaderEl;
    if (host) host.appendChild(el);
  }
  dlPanelEl = el;
  return el;
}
const _dlEntries = new Map();   // src -> entry
let _dlOrder = 0;
let _dlRaf = 0;
const _DL_HALF = 1.5 * 1048576; // half-fill point for the asymptotic bar
const _DL_WINDOW = 5;

function _dlFmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024)    return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
function _dlFmtRate(bps) {
  if (!(bps > 0)) return '';
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  return (bps / 1024).toFixed(0) + ' KB/s';
}
function _dlStart(src) {
  if (!_dlEnsurePanel()) return null;
  let e = _dlEntries.get(src);
  if (!e) {
    e = { src, name: String(src).split('/').pop() || src, loaded: 0,
          rate: 0, done: false, t0: performance.now(), order: 0 };
    _dlEntries.set(src, e);
  } else {
    e.loaded = 0; e.rate = 0; e.done = false; e.t0 = performance.now();
  }
  e.order = ++_dlOrder;
  _dlScheduleRender();
  return e;
}
function _dlUpdate(e, loaded) {
  if (!e) return;
  e.loaded = loaded;
  const dt = (performance.now() - e.t0) / 1000;
  if (dt > 0.05) e.rate = loaded / dt;
  _dlScheduleRender();
}
function _dlDone(e) {
  if (!e) return;
  e.done = true;
  const dt = (performance.now() - e.t0) / 1000;
  if (dt > 0.05 && e.loaded > 0) e.rate = e.loaded / dt;
  _dlScheduleRender();
}
function _dlBarPct(e) {
  if (e.done) return 100;
  // Asymptotic toward ~95%: monotonic, smooth, never stalls at a hard wall.
  return 95 * (1 - 1 / (1 + e.loaded / _DL_HALF));
}
function _dlScheduleRender() {
  if (_dlRaf || !dlPanelEl) return;
  _dlRaf = requestAnimationFrame(() => { _dlRaf = 0; _dlRender(); });
}
function _dlRender() {
  if (!dlPanelEl) return;
  // (dlPanelEl is guaranteed set: _dlScheduleRender only fires after _dlStart.)
  // v0.8.95: ACTIVE downloads always win a slot. The old "5 most recently
  // STARTED" criterion let the tail-of-queue small files (skillgrp, roof.txt…)
  // start last, finish instantly and evict the big file still in flight —
  // operator saw 5 green ✓ rows while sound.mul downloaded invisibly. Now:
  // in-flight entries first (newest first), completed ones only fill the
  // remaining slots.
  const _all = [..._dlEntries.values()];
  const _active = _all.filter((e) => !e.done).sort((a, b) => b.order - a.order);
  const _finished = _all.filter((e) => e.done).sort((a, b) => b.order - a.order);
  const rows = _active.concat(_finished).slice(0, _DL_WINDOW);
  const keep = new Set(rows.map((e) => e.src));
  // Bound memory: drop finished entries that fell out of the window.
  if (_dlEntries.size > 50) {
    for (const [k, v] of _dlEntries) if (!keep.has(k) && v.done) _dlEntries.delete(k);
  }
  // Reconcile DOM by src key (data-src) so bars animate smoothly between frames.
  const seen = new Set();
  for (const e of rows) {
    let row = dlPanelEl.querySelector(`[data-src="${CSS.escape(e.src)}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'dl-row';
      row.dataset.src = e.src;
      row.innerHTML = '<div class="dl-head"><span class="dl-name"></span>'
                    + '<span class="dl-rate"></span></div>'
                    + '<div class="dl-bar"><div class="dl-fill"></div></div>';
      dlPanelEl.appendChild(row);
      // next frame \u2192 fade/slide in
      requestAnimationFrame(() => row.classList.add('dl-in'));
    }
    seen.add(row);
    row.classList.toggle('dl-done', e.done);
    row.querySelector('.dl-name').textContent = e.name;
    const rate = _dlFmtRate(e.rate);
    const size = _dlFmtBytes(e.loaded);
    row.querySelector('.dl-rate').textContent =
      e.done ? `${size} \u2713` : (rate ? `${size} \u00B7 ${rate}` : size);
    row.querySelector('.dl-fill').style.width = _dlBarPct(e).toFixed(1) + '%';
    // Keep rows ordered newest-first to match the sort.
    dlPanelEl.appendChild(row);
  }
  // Remove DOM rows no longer in the window.
  for (const row of [...dlPanelEl.children]) {
    if (!seen.has(row)) row.remove();
  }
}
// Stream a response body, reporting progress to the download panel. Falls
// back to arrayBuffer() when the body isn't a readable stream (older paths,
// 304s already handled by the caller). Returns a Uint8Array.
//
// v0.8.96 stall watchdog (operator hit it: a ~15 MB file froze mid-download
// with the connection alive — no error, no progress, no retry, boot wedged
// until a manual refresh): every chunk read races a 30 s timer. If no bytes
// arrive within the window, the reader is cancelled and we THROW, which
// lands in fetchFileCached's body-read retry loop → fresh re-fetch with
// backoff. Slow-but-moving links never trip it (the timer resets per chunk).
// v0.8.97: 30 s -> 10 s (operator call). Not lower: an abort restarts the
// file FROM ZERO (no HTTP resume) and ~5 s pauses can legitimately recover
// (TCP retransmission, cloudflared tunnel reconnect, NAS CPU spike from the
// asset-worker brotli pass). 10 s of true silence after headers arrived is
// almost certainly a dead stream; the retry loop absorbs rare survivors.
const _BODY_STALL_MS = 10_000;
async function _readBodyWithProgress(res, src) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    return new Uint8Array(await res.arrayBuffer());
  }
  const entry = _dlStart(src);
  const reader = body.getReader();
  const chunks = [];
  let loaded = 0;
  try {
    for (;;) {
      let stallTimer;
      // The race LOSER must be neutralised or it becomes an unhandled rejection: when
      // the stall timer wins we cancel the reader, and the still-pending read then
      // rejects with nobody listening.
      const readP = reader.read();
      readP.catch(() => { /* the stall path handles it */ });
      const result = await Promise.race([
        readP,
        new Promise((_, reject) => {
          stallTimer = setTimeout(() => reject(new Error(`body stalled ${_BODY_STALL_MS / 1000}s (no bytes) for ${src}`)), _BODY_STALL_MS);
        }),
      ]).finally(() => clearTimeout(stallTimer));
      const { done, value } = result;
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (entry) _dlUpdate(entry, loaded);
      _bootProgress();   // feed the boot watchdog: bytes are flowing
    }
  } catch (e) {
    // cancel() RETURNS A PROMISE, and on an already-errored stream it rejects with the
    // same error — try/catch only stops a synchronous throw, so that rejection escaped
    // to window.onunhandledrejection. Caught by the smoke 2026-07-26: a transient
    // ERR_HTTP2_PROTOCOL_ERROR on anim5.mul that the retry loop RECOVERED from still
    // produced a pageerror AND a bogus "[crash-report] PREVIOUS CRASH
    // reason=unhandledrejection" entry, i.e. false crash telemetry for a healthy boot.
    try { const c = reader.cancel(); if (c && typeof c.catch === 'function') c.catch(() => {}); }
    catch { /* already dead */ }
    throw e;            // body-read retry loop re-fetches with backoff
  } finally {
    if (entry) _dlDone(entry);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// --- Boot watchdog (v0.8.96) ----------------------------------------
// Operator hit TWO wedges in one session: a stalled download (handled
// above) and a hang at "Mounting the world into memory…" that only a
// manual refresh fixed. Defensive net for EVERY boot phase: each stage
// change / progress tick resets a timer; if a stage makes no progress
// for 45 s (v0.8.97, was 120 — operator: nobody waits 2 minutes; NOT
// lower because a COLD dotnet runtime instantiation on a modest machine
// runs 20-30 s with no observable sub-progress, and firing mid-
// instantiation would reload-loop those users), persist a post-mortem
// via the crash black-box and
// auto-reload ONCE (sessionStorage flag prevents reload loops — the
// second wedge shows an actionable message instead). The flag clears on
// reaching the login gump, so a later session gets its retry back.
const _bootWd = {
  stage: 'boot',
  last: performance.now(),
  done: false,
  reloadedOnce: (() => { try { return sessionStorage.getItem('uo-boot-autoreload') === '1'; } catch { return false; } })(),
};
// A stage change is the ONLY liveness signal the host gets once downloads finish:
// uiProgress stops firing at 100%, so an embedded mini went silent through the whole
// .NET boot + login. The minigame bar read that silence as a hang and showed
// "couldn't connect" on a client that was still starting (operator 2026-07-26).
// Relay the stage as a progress ping so the host's stall watchdog keeps its deadline
// alive while real work is happening.
function _bootStage(stage) {
  _bootWd.stage = stage; _bootWd.last = performance.now();
  _bootReceiptWrite(stage);
  if (window.__miniHooks && window.__miniHooks.progress) {
    try { window.__miniHooks.progress(_lastUiProgress, stage); } catch { /* never break boot */ }
  }
}
function _bootProgress() { _bootWd.last = performance.now(); }

// ── boot receipt ──────────────────────────────────────────────────────────────
// A boot that wedges the MAIN THREAD cannot be rescued from inside the page: the
// existing watchdog is a setInterval on that same thread, a Worker cannot navigate,
// and adding a ServiceWorker to force a reload from outside would risk serving stale
// fingerprinted releases -- too high a price for a bug whose FREQUENCY we do not know.
//
// So measure it instead. Drop a receipt when a real boot phase begins and clear it once
// the client is up; a receipt still present on the NEXT load means the previous boot
// never finished. That turns a silent hang into one datum per occurrence, carrying the
// stage it died at and the machine it died on -- which is what tells us whether this is
// one boot in five or one in five hundred, and whether it tracks core count or memory.
// Best-effort throughout: storage may be blocked, and a diagnostic must never be the
// thing that breaks a boot.
const BOOT_RECEIPT = 'uo-boot-receipt';
function _bootReceiptWrite(stage) {
  try {
    localStorage.setItem(BOOT_RECEIPT, JSON.stringify({
      t: Date.now(),
      stage: stage,
      cores: navigator.hardwareConcurrency || 0,
      mem: navigator.deviceMemory || 0,
      // __bundle, NOT location.pathname: the transparent-path IIFE at the top of this
      // file replaceState()s /tuo/ and /cuo/ away, so by the time a boot stage is
      // written the path is always '/' and every TUO boot failure was filed as 'cuo'
      // — silently corrupting the one dataset that says WHICH client hangs. Same trap
      // v0.7.7 fixed everywhere else in this file; this call site was missed.
      client: (window.__bundle || (window.__MINI__ ? 'mini' : 'cuo')),
    }));
  } catch (e) { /* private mode / storage denied */ }
}
function _bootReceiptClear() { try { localStorage.removeItem(BOOT_RECEIPT); } catch (e) {} }
// Written at the END of fetchAll (see the receipt block there), read here on the NEXT
// boot — including a boot of a DIFFERENT bundle, which is the whole point: it is the
// only way to see whether the asset cache a CUO load filled was reused by the TUO load
// that followed. Deliberately NOT cleared on read: the Storage panel shows the same
// record, and one boot must not erase the evidence the next boot is compared against.
const CACHE_RECEIPT = 'uo-cache-receipt';
function _cacheReceiptRead() {
  try { return JSON.parse(localStorage.getItem(CACHE_RECEIPT) || 'null'); } catch (e) { return null; }
}
function _cacheReceiptReport() {
  const r = _cacheReceiptRead();
  if (!r || typeof r.files !== 'number') return;
  const age = Math.round((Date.now() - r.t) / 1000);
  const gib = (n) => (n > 0 ? (n / 1073741824).toFixed(2) + ' GiB' : '?');
  console.log(`[cache-receipt] previous asset load ${age}s ago: bundle=${r.bundle} base=${r.base}`
    + ` backend=${r.backend} cached=${r.cached} downloaded=${r.downloaded} (${r.mib} MiB)`
    + ` storage=${gib(r.usage)}/${gib(r.quota)} persisted=${r.persisted} writesOff=${r.writesOff}`);
}
function _bootReceiptReport() {
  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(BOOT_RECEIPT) || 'null'); } catch (e) { return; }
  if (!prev || !prev.stage) return;
  _bootReceiptClear();
  // 'boot' just means the user was still on the picker — a page they left, not a hang.
  if (prev.stage === 'boot') return;
  const age = Math.round((Date.now() - prev.t) / 1000);
  // `left` is stamped at pagehide, which a wedged main thread cannot reach. Unmarked is the
  // datum this exists to collect; marked is a player who closed the tab mid-load, and saying
  // "never finished" about that is true in the useless sense — it inflates the rate with the
  // behaviour a slow boot causes.
  console.warn(prev.left
    ? '[boot-receipt] previous load was left by the player before it finished: stage=' + prev.stage
      + ' age=' + age + 's cores=' + prev.cores + ' mem=' + prev.mem + ' client=' + prev.client
    : '[boot-receipt] previous boot never finished: stage=' + prev.stage
      + ' age=' + age + 's cores=' + prev.cores + ' mem=' + prev.mem + ' client=' + prev.client);
  try {
    fetch('/api/boot-failure', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      // `left` travels: the server counts these, and a count that cannot separate "wedged" from
      // "closed the tab" answers the frequency question with the wrong number. Still SENT rather
      // than suppressed — the abandonment rate per stage is worth knowing on its own, and
      // dropping data to protect a metric is how a metric stops describing anything.
      body: JSON.stringify({ stage: prev.stage, ageSecs: age, cores: prev.cores,
                             mem: prev.mem, client: prev.client, left: !!prev.left }),
    }).catch(function () { /* telemetry must never surface to the player */ });
  } catch (e) { /* ignore */ }
}
window.addEventListener('cuo:login-gump-added', () => {
  _bootWd.done = true;
  _bootReceiptClear();   // LoginGump reached = the WASM boot completed
  try { sessionStorage.removeItem('uo-boot-autoreload'); } catch {}
  try { sessionStorage.removeItem('uo-asset-corrupt-recover'); } catch {} // boot reached LoginGump → reset the corrupt-asset retry
  try { sessionStorage.removeItem('uo-recover-file'); } catch {} // recovery succeeded → stop cache-busting that file
});
window.addEventListener('cuo:gamescene-active', () => { _bootWd.done = true; _bootReceiptClear(); });
setInterval(() => {
  try {
    if (_bootWd.done) return;
    // v0.8.98 audit fix: stage 'boot' = the user hasn't started loading yet
    // (SSO gate / shard picker / client picker). Idling there is NORMAL —
    // pre-fix the watchdog auto-reloaded the page under a user reading the
    // picker for 45 s. The net only arms once _bootStage() marks a real
    // boot phase (loading-assets onwards).
    if (_bootWd.stage === 'boot') { _bootWd.last = performance.now(); return; }
    const idleMs = performance.now() - _bootWd.last;
    // v0.8.99 (operator review): per-phase thresholds. Every phase except
    // mounting-world has DENSE pulses (per-file completion/bytes, perf
    // checkpoints, every engine console line) so 25 s of true silence is
    // already pathological. mounting-world keeps 45 s because it contains
    // the ONE un-instrumented stretch: the dotnet runtime download (~16 MB)
    // + wasm compile on a FIRST visit — 20-35 s of legitimate total silence
    // on a modest line; firing inside it would reload-loop exactly the
    // first-time visitors. (Tightening path: hook withResourceLoader so the
    // runtime fetch pulses too, then this can drop to ~20-25 s.)
    const limitMs = _bootWd.stage === 'mounting-world' ? 45_000 : 25_000;
    if (idleMs < limitMs) return;
    console.error(`[boot-watchdog] stage '${_bootWd.stage}' made no progress for ${Math.round(idleMs / 1000)}s`);
    try { window.__uoCrashSave?.('boot-watchdog', `stage=${_bootWd.stage} idleMs=${Math.round(idleMs)}`); } catch {}
    if (!_bootWd.reloadedOnce) {
      try { sessionStorage.setItem('uo-boot-autoreload', '1'); } catch {}
      location.reload();
    } else {
      _bootWd.done = true;   // stop nagging; leave the message up
      try {
        uiStatus(`Boot stalled at "${_bootWd.stage}" twice — reload (Ctrl+Shift+R), or clear the cache from Manage storage`);
      } catch { /* loader UI may be gone */ }
    }
  } catch { /* watchdog must never throw */ }
}, 5_000);
function uiHide() {
  if (loaderEl) loaderEl.classList.add('hidden');
  setTimeout(() => { if (loaderEl) loaderEl.style.display = 'none'; }, 600);
}

// --- Server config ------------------------------------------------
async function applyServerConfig() {
  // Every panel inside #loader that participates in the shared brand
  // header carries a data-base attribute (#sso-panel, #sso-user,
  // #client-picker). We update all of them so the version suffix shows
  // up regardless of which panel the user is looking at — the logged-in
  // welcome panel used to silently drop the version because we only
  // touched the first match.
  const titleEls = document.querySelectorAll('#loader .title[data-base]');
  const firstTitle = titleEls[0];
  const base = firstTitle?.dataset?.base || firstTitle?.textContent || 'UO Nexus';
  let serverName = base;
  let version = '';
  let devMode = false;
  try {
    const r = await fetch('/api/config');
    if (r.ok) {
      const cfg = await r.json();
      // The site title is admin-editable: the admin panel writes serverName
      // into runtime_config and /api/config returns it via getServerName(),
      // which falls back to the bundled default ('UO Nexus') when unset. So
      // cfg.serverName is authoritative for the brand shown here; data-base is
      // only the in-bundle fallback if /api/config is unreachable.
      if (cfg.serverName) serverName = cfg.serverName;
      if (cfg.devMode === true) devMode = true;
      // Panel-toggled disable-dev (SQLite runtime flag, no restart). Mirrors the
      // legacy nginx <meta cuo-dev-mode> gate: re-apply the console silencer (the
      // primary leak vector) + force dev features off. Effective on this load.
      // (The earliest parse-time silencer is meta-based; this catches the case
      // where the panel set the flag but the legacy meta file wasn't touched.)
      if (cfg.disableDev === true) {
        devMode = false;
        try {
          const noop = () => {};
          for (const k of ['log', 'error', 'warn', 'info', 'debug', 'trace']) {
            if (typeof console !== 'undefined' && typeof console[k] === 'function') console[k] = noop;
          }
        } catch {}
      }
    }
  } catch {}
  // ⚠️ NO DEV-LOGIN BUTTON HERE, and its absence is deliberate. The full client injects one under
  // ?dev, pointing at /auth/dev-login — a route uonexus serves and this backend does not. Carried
  // over unchanged, it rendered a button that answered 404: an affordance that does nothing is
  // worse than no affordance, because it reads as a broken install. The equivalent already exists
  // and works: the guest sign-in, which is exactly "get in without Discord".
  try {
    const r = await fetch('/version.txt', { cache: 'no-cache' });
    if (r.ok) {
      const txt = (await r.text()).trim();
      if (txt) version = txt;
    }
  } catch {}
  const final = version ? `${serverName} ${version}` : serverName;
  titleEls.forEach((el) => { el.textContent = final; });
}

// --- Discord SSO --------------------------------------------------

let _discordUser = null;
let _serverProfileBytes = null;
let _capturedFS = null;
let _lastProfileUploadAt = 0;
// How many macros the SERVER copy held when this session started, or -1 when we never saw one.
// Used by uploadProfileBlob to refuse the one write that destroys work silently: replacing a
// profile that has macros with one that has none. See the guard there for why.
let _serverMacroCount = -1;
// Did the PLAYER change something this session, as opposed to the client writing defaults?
// This is what separates "I deleted my macros" from "this session never had them" — two states
// that look identical on disk and need opposite handling. Set by the bridge wrapper below, which
// only fires on a mutating verb the player drove and only when the client accepted it.
let _userEditedThisSession = false;
const PROFILE_UPLOAD_THROTTLE_MS = 30_000;
const PROFILE_KEEPALIVE_LIMIT = 60 * 1024;

// ── tar + gzip helpers ──────────────────────────────────────────────

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function _tarPad512(n) { return (512 - (n % 512)) % 512; }

function _tarWriteOctal(h, off, len, value) {
  const s = value.toString(8).padStart(len - 1, '0');
  for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i);
  h[off + s.length] = 0;
}

function _tarMakeHeader(fullPath, size, mtime) {
  // ustar splits long paths into prefix[155] + name[100] joined by '/'.
  let prefix = '';
  let name = fullPath;
  if (name.length > 100) {
    let i = name.length - 100;
    while (i < name.length && name[i] !== '/') i++;
    if (i >= name.length || i > 155) throw new Error(`tar path too long: ${fullPath}`);
    prefix = name.substring(0, i);
    name = name.substring(i + 1);
  }
  const h = new Uint8Array(512);
  const nameBytes = TEXT_ENCODER.encode(name);
  h.set(nameBytes.subarray(0, 100), 0);
  for (let i = 0; i < '0000644'.length; i++) h[100 + i] = '0000644'.charCodeAt(i);
  for (let i = 0; i < '0000000'.length; i++) h[108 + i] = '0000000'.charCodeAt(i);
  for (let i = 0; i < '0000000'.length; i++) h[116 + i] = '0000000'.charCodeAt(i);
  _tarWriteOctal(h, 124, 12, size);
  _tarWriteOctal(h, 136, 12, Math.floor(mtime / 1000));
  for (let i = 148; i < 156; i++) h[i] = 0x20; // chksum placeholder = spaces
  h[156] = 0x30; // typeflag '0' = regular file
  const ustar = 'ustar\x00';
  for (let i = 0; i < ustar.length; i++) h[257 + i] = ustar.charCodeAt(i);
  h[263] = 0x30; h[264] = 0x30; // version '00'
  if (prefix) {
    const prefBytes = TEXT_ENCODER.encode(prefix);
    h.set(prefBytes.subarray(0, 155), 345);
  }
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  const cs = sum.toString(8).padStart(6, '0');
  for (let i = 0; i < cs.length; i++) h[148 + i] = cs.charCodeAt(i);
  h[148 + cs.length] = 0;
  h[148 + cs.length + 1] = 0x20;
  return h;
}

function tarPack(files) {
  let total = 1024; // trailing two empty 512-byte blocks
  for (const f of files) total += 512 + f.content.length + _tarPad512(f.content.length);
  const out = new Uint8Array(total);
  const now = Date.now();
  let off = 0;
  for (const f of files) {
    out.set(_tarMakeHeader(f.path, f.content.length, now), off);
    off += 512;
    out.set(f.content, off);
    off += f.content.length + _tarPad512(f.content.length);
  }
  return out;
}

function _tarReadString(buf, off, len) {
  let end = off;
  while (end < off + len && buf[end] !== 0) end++;
  return TEXT_DECODER.decode(buf.subarray(off, end));
}

function tarUnpack(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) break; // EOF block
    const name = _tarReadString(buf, 0 + off, 100);
    const prefix = _tarReadString(buf, 345 + off, 155);
    const sizeStr = _tarReadString(buf, 124 + off, 12).trim();
    const size = parseInt(sizeStr, 8);
    if (!Number.isFinite(size) || size < 0) break;
    const typeflag = buf[off + 156];
    const fullName = prefix ? `${prefix}/${name}` : name;
    off += 512;
    if ((typeflag === 0x30 || typeflag === 0) && fullName) {
      out.push({ path: fullName, content: buf.subarray(off, off + size) });
    }
    off += size + _tarPad512(size);
  }
  return out;
}

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}


/**
 * Keep a profile from growing forever, evicting whole CHARACTER folders least-recently-touched.
 *
 * 🚨 The problem, measured 2026-08-12: the upload walks /Data and sends everything it finds, so a
 * profile accumulates a folder for every account and character that browser ever logged into and
 * re-uploads them for good. One test profile carried four accounts, including one that had nothing
 * to do with its owner. Nothing ever pruned it.
 *
 * The unit is the character folder (`Profiles/<account>/<shard>/<character>/`), never the file:
 * dropping half a character's config would leave it in a state the client never wrote.
 *
 * ⚠️ THE CAP IS DELIBERATELY FAR ABOVE REAL USE, because eviction here DELETES the cloud copy.
 * A player with a couple of shards and a handful of characters is nowhere near 50; anything past
 * that is the residue of testing or of logins that are not theirs. Order is by newest mtime, so
 * what goes is always the thing untouched the longest — never something in use. And it is logged,
 * because a silent eviction is the same shape as the data loss this whole area just came out of.
 */
const MAX_PROFILE_DIRS = 50;

function profileDirOf(relPath) {
  // `Profiles/<account>/<shard>/<character>/<file>` — anything shallower is not a character folder.
  const p = relPath.split('/');
  return p.length >= 5 && p[0] === 'Profiles' ? p.slice(0, 4).join('/') : null;
}

function capProfileDirs(files, log = true) {
  const groups = new Map();
  for (const f of files) {
    const dir = profileDirOf(f.path);
    if (!dir) continue;
    const g = groups.get(dir) ?? { dir, newest: 0, files: [] };
    g.files.push(f);
    if (typeof f.mtime === 'number' && f.mtime > g.newest) g.newest = f.mtime;
    groups.set(dir, g);
  }
  if (groups.size <= MAX_PROFILE_DIRS) return files;

  const ordered = [...groups.values()].sort((a, b) => b.newest - a.newest);
  const dropped = new Set(ordered.slice(MAX_PROFILE_DIRS).map((g) => g.dir));
  if (log) {
    console.warn(`[discord] profile has ${groups.size} character folders; keeping the `
      + `${MAX_PROFILE_DIRS} most recently used and dropping ${dropped.size} from the upload: `
      + [...dropped].join(', '));
  }
  return files.filter((f) => { const d = profileDirOf(f.path); return !d || !dropped.has(d); });
}

function fsWalk(FS, root, basePath = '') {
  const out = [];
  let entries;
  try { entries = FS.readdir(root); } catch { return out; }
  for (const name of entries) {
    if (name === '.' || name === '..') continue;
    const full = `${root}/${name}`;
    const rel = basePath ? `${basePath}/${name}` : name;
    let stat;
    try { stat = FS.stat(full); } catch { continue; }
    if (FS.isDir(stat.mode)) {
      out.push(...fsWalk(FS, full, rel));
    } else if (FS.isFile(stat.mode)) {
      try {
        // mtime rides along so the caller can evict by least-recently-used without a second stat
        // pass over the whole tree. Missing/odd stats fall back to 0, which sorts them oldest —
        // safe, because "unknown" should never outrank a file we know is fresh.
        let mtime = 0;
        try { mtime = stat.mtime instanceof Date ? stat.mtime.getTime() : 0; } catch { mtime = 0; }
        out.push({ path: rel, content: FS.readFile(full), mtime });
      } catch { /* skip unreadable */ }
    }
  }
  return out;
}

function fsMkdirP(FS, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    try { FS.mkdir(cur); } catch { /* EEXIST ok */ }
  }
}

function fsWriteAll(FS, root, files) {
  let written = 0;
  for (const f of files) {
    const full = `${root}/${f.path}`;
    const slash = full.lastIndexOf('/');
    if (slash > 0) fsMkdirP(FS, full.substring(0, slash));
    try {
      FS.writeFile(full, f.content);
      written++;
    } catch (e) {
      console.warn(`[discord] profile write failed for ${full}:`, e?.message ?? e);
    }
  }
  return written;
}



async function _discordApplySettings() {
  try {
    const sr = await fetch('/api/settings', { credentials: 'same-origin' });
    if (!sr.ok) return;
    const settings = await sr.json();
    if (typeof settings !== 'object' || settings === null) return;
    console.log('[discord] loaded saved settings:', settings);
    const params = new URLSearchParams(location.search);
    let changed = false;
    // SECURITY: 'wsHost' intentionally NOT restored — the WS host is locked to
    // location.hostname (see WASM_UO_WS_URL). Restoring a saved wsHost would
    // re-introduce the stored-MITM vector (crafted ?wsHost=evil.com link).
    for (const key of ['wsPort', 'wsPath', 'encrypt']) {
      if (typeof settings[key] === 'string' && settings[key] && !params.has(key)) {
        params.set(key, settings[key]);
        changed = true;
      }
    }
    if (changed) {
      // from the address bar. localStorage + dropdown still carry the
      // value forward.
      const visible = new URLSearchParams(params.toString());
      visible.delete('dev');
      visible.delete('encrypt');
      const tail = visible.toString();
      history.replaceState(null, '', location.pathname + (tail ? '?' + tail : '') + (location.hash || ''));
    }
    // Sync the encryption <select> if the picker already initialized.
    // ⚠️ The encryption value used to be reflected back into a dropdown here, and the comment that
    // stood in this place explained a race between the URL and the server's stored value. Both are
    // gone with the picker: this build has one shard, its cipher comes from config.json, and there
    // is no control to keep in sync. The read was removed rather than left computing a value
    // nothing consumed.
  } catch (e) { console.warn('[discord] applySettings error:', e); }
}

// ── the account widget (top-right) ─────────────────────────────────────────────────────────
// 🚨 ALL OF THIS MARKUP SHIPPED DEAD. #discord-widget, its menu and #storage-modal are in
// index.html with styles and ids, and NOTHING in this build referenced a single one of them --
// grep for 'dm-storage' in this file before this change and you get zero hits. Upstream the
// wiring lives in portal-rail.js, which this build deliberately does not ship. Third time in
// this fork that removing a surface removed what another surface was quietly leaning on (the
// picker was also the login page; portal-rail was also the identity bridge).
//
// So a signed-in player had no route to storage, to account deletion, or to /admin -- the panel
// existed and was reachable only by typing the URL.
//
// Only what this reduced backend can actually honour is wired. Nothing here stubs a feature it
// cannot deliver: an honest missing item beats a button that lies.

// The Help & FAQ tab down the left edge.
//
// 🚨 THE MARKUP HAS ALWAYS BEEN THERE AND NOTHING SHOWED IT. #faq-toggle ships with
// `display:none` and the full client reveals it from wireFaqLauncher(), which did not survive the
// hand-trim of this layer — so the tab existed in every build and appeared in none. Same shape as
// the account widget: dead markup reads as a missing feature, and nothing errors.
//
// It points at uonexus.com/faq, in the markup rather than through config. Operator, 2026-08-27:
// the FAQ this build used to carry was too thin to be worth sending anyone to, and the hosted one
// answers the questions players actually have about the client. A configurable route was written
// first and reverted: it put the destination behind an unfingerprinted script the CDN caches, so a
// change took an edge purge to land, and there was nothing for it to choose between.
//
// `display = 'block'`, not `''`: the inline style is display:none, and clearing it to the empty
// string leaves the element exactly as hidden — an already-paid-for lesson in this file.
/**
 * The ClassicUO / TazUO selector, on the landing menu.
 *
 * 🚨 IT WAS ON THE LOADING SCREEN, WHICH IS UNUSABLE. That surface exists while the gamefiles
 * download and then goes away: by the time it is on screen the client has already committed to a
 * fork, and switching would throw away a download in progress. It belongs where a player decides
 * anything — the landing — and there are TWO of those, both live in this build: #sso-panel for a
 * visitor and #sso-user for a returning player. Either can be the last screen before the world,
 * so the choice goes on both.
 *
 * 🚨 And it was not a selector: one button whose label said what it would DO, so the reader had to
 * work out the current client from a sentence about the other one. Two options, current one
 * marked.
 *
 * Shown only when the operator enabled it AND the other bundle answers. The server refuses the
 * setting without both bundles, but a stale setting plus a removed bundle would still offer a
 * button leading to a 404, so the destination is checked here too.
 */
async function _wireClientSwitch() {
  // Asked for directly rather than taken from a global minimal-boot sets inside an async
  // callback that only runs at "/": that made the control appear or not depending on which
  // resolved first, and never at all on /tuo/.
  let allowed = false;
  try {
    const r = await fetch('/api/config', { cache: 'no-store', credentials: 'same-origin' });
    if (r.ok) allowed = (await r.json()).allowClientSwitch === true;
  } catch (e) { return; }
  if (!allowed) return;

  // 🚨 window.__bundle, NEVER location.pathname. The routing IIFE at the top of this file strips
  // /tuo/ and /cuo/ from the URL bar with replaceState — the operator asked for that — and its own
  // comment says every pathname check in this file must use __bundle instead. I used the pathname
  // and the selector marked ClassicUO as current while running TazUO. It also made the switch look
  // like it had not navigated at all: the URL bar says "/" on both bundles by design.
  const here = window.__bundle === 'tuo' ? 'tuo' : 'cuo';
  const other = here === 'tuo' ? 'cuo' : 'tuo';
  // Is the destination actually installed? /tuo/ from the ClassicUO page, / from the TazUO one.
  try {
    const r = await fetch(other === 'tuo' ? '/tuo/config.json' : '/config.json',
                          { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) { console.warn('[minimal] client selector hidden — the other bundle is not installed'); return; }
  } catch (e) { return; }

  const NAMES = { cuo: 'ClassicUO', tuo: 'TazUO' };

  // What is HIGHLIGHTED is the player's pick, not the bundle currently running — those are the same
  // thing until they choose the other one, and the whole point of the change is that choosing no
  // longer navigates. Both options stay clickable so the choice can be taken back.
  // Read through minimal-boot's accessor, never by naming the key here: this file used its own
  // string ('uoweb:clientPick') which nothing ever wrote, so the highlight always fell back to the
  // running bundle and a player's saved choice was invisible.
  let picked = here;
  try {
    const stored = window.__minimalGetClient && window.__minimalGetClient();
    if (stored === 'cuo' || stored === 'tuo') picked = stored;
  } catch (e) { /* no storage: the running bundle is the pick */ }

  const rows = [];
  const paint = () => {
    for (const row of rows) {
      for (const el of row.querySelectorAll('.client-choice-opt')) {
        const isPick = el.dataset.client === picked;
        el.classList.toggle('is-current', isPick);
        el.setAttribute('aria-pressed', isPick ? 'true' : 'false');
      }
    }
  };

  // Records the choice and repaints. It does NOT navigate — see the note on CLIENT_HANDOFF_KEY.
  // This used to set `location.href` on click, so picking a client reloaded the page under a player
  // who was still deciding, for a control that is a preference rather than an action.
  const go = (which) => {
    picked = which;
    try { window.__minimalSetClient(which); } catch (e) {}
    paint();
  };

  // One implementation, inserted into each landing panel. Duplicating the markup would mean two
  // ids to collide and two places to keep in step.
  for (const panelId of ['sso-panel', 'sso-user']) {
    const panel = document.getElementById(panelId);
    if (!panel || panel.querySelector('.client-choice')) continue;

    const row = document.createElement('div');
    row.className = 'client-choice';
    const lab = document.createElement('span');
    lab.className = 'client-choice-label';
    lab.textContent = 'Client';
    row.appendChild(lab);

    const opts = document.createElement('div');
    opts.className = 'client-choice-opts';
    for (const which of ['cuo', 'tuo']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'client-choice-opt';
      b.textContent = NAMES[which];
      b.setAttribute('data-client', which);
      // Neither option is disabled any more. Disabling the running one made sense while clicking
      // meant "go there now"; as a preference, a choice you cannot take back is a trap.
      b.addEventListener('click', () => go(which));
      opts.appendChild(b);
    }
    row.appendChild(opts);
    rows.push(row);

    // Above the action buttons: the player picks the client, then plays. Anchored on the
    // panel's own first button so it does not depend on a fixed child index.
    const firstAction = panel.querySelector('.discord-btn, #play-game');
    if (firstAction) panel.insertBefore(row, firstAction);
    else panel.appendChild(row);
  }
  paint();   // both panels exist now; one pass sets the initial highlight in each
}
function _wireFaqLauncher() {
  const tab = document.getElementById('faq-toggle');
  if (tab) tab.style.display = 'block';
}


// The landing ships three community-invite icons as `href="#"` placeholders and nothing ever
// rewrote them, so clicking one just re-anchored the page — indistinguishable from "the link points
// at this site". The real invite is per-install (a published repo must not carry one community's
// link), so it comes from /api/config. Unset: the icon is REMOVED, because an affordance that goes
// nowhere is worse than no affordance.
async function _wireDiscordInvite() {
  const links = document.querySelectorAll('a[data-selfhost="set-your-discord-invite"]');
  if (!links.length) return;
  let invite = '';
  try {
    const r = await fetch('/api/config', { credentials: 'same-origin' });
    if (r.ok) invite = String((await r.json()).discordInvite || '').trim();
  } catch { /* offline: fall through to removing the icons */ }

  // Only http(s). The href comes from this install's own configuration, but a scheme check costs
  // nothing and keeps a mistyped `javascript:` out of a link the page renders.
  let ok = false;
  if (invite) {
    try { const u = new URL(invite); ok = (u.protocol === 'https:' || u.protocol === 'http:'); }
    catch { ok = false; }
  }
  for (const a of links) {
    if (ok) a.href = invite;
    else a.remove();
  }
}

function _accountMenuEl() { return document.getElementById('discord-menu'); }

function _accountCloseMenu() {
  const m = _accountMenuEl();
  if (m) m.classList.add('hidden');
}

// Two-click arming for an irreversible action. This build bans native confirm() dialogs, and a
// destructive button still needs a deliberate second act. Re-disarms itself after 5s so an armed
// button never sits waiting to catch a later, unrelated click.
function _armOnce(btn, armedLabel, run) {
  const idle = btn.textContent;
  let timer = 0;
  btn.addEventListener('click', () => {
    if (btn.dataset.state !== '1') {
      btn.dataset.state = '1';
      btn.textContent = armedLabel;
      clearTimeout(timer);
      timer = setTimeout(() => {
        btn.dataset.state = '0';
        btn.textContent = idle;
      }, 5000);
      return;                          // first click only arms; it never acts
    }
    clearTimeout(timer);
    btn.dataset.state = '0';
    void run(btn, idle);
  });
}

async function _accountSignOut() {
  try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); }
  catch (e) { console.warn('[account] logout request failed:', e); }
  // Reload regardless: the cookie is gone or never existed, and either way the page must stop
  // presenting a session it can no longer prove.
  location.reload();
}

// ── storage modal ──────────────────────────────────────────────────────────────────────────
async function _storageRender() {
  const listEl = document.getElementById('sm-list');
  const totalEl = document.getElementById('sm-total');
  if (!listEl || !totalEl) return;
  listEl.textContent = '';
  totalEl.textContent = 'Measuring…';

  let cache = null;
  try { cache = await openCache(); } catch (e) { console.warn('[storage] cache open failed:', e); }
  if (!cache) { totalEl.textContent = 'Cached data could not be read in this browser.'; return; }

  let usage;
  try { usage = await cacheUsageByShard(cache); }
  catch (e) { console.warn('[storage] usage failed:', e); totalEl.textContent = 'Cached data could not be measured.'; return; }

  totalEl.textContent = usage.total > 0
    ? `${_dlFmtBytes(usage.total)} of game data cached in this browser`
    : 'Nothing cached in this browser yet';

  if (!usage.shards.length) {
    const empty = document.createElement('div');
    empty.className = 'sm-empty';
    empty.textContent = 'No cached game files.';
    listEl.appendChild(empty);
    return;
  }

  for (const s of usage.shards) {
    // Built with createElement + textContent throughout: `base` comes from cache keys, and this
    // build's standing rule is textContent over innerHTML for anything not authored here.
    const row = document.createElement('div');
    row.className = 'sm-row';

    const name = document.createElement('div');
    name.className = 'sm-row-name';
    const n1 = document.createElement('div');
    n1.textContent = s.base;
    const n2 = document.createElement('div');
    n2.className = 'sm-row-sub';
    n2.textContent = `${s.files} file${s.files === 1 ? '' : 's'}`;
    name.appendChild(n1); name.appendChild(n2);

    const size = document.createElement('div');
    size.className = 'sm-row-size';
    size.textContent = _dlFmtBytes(s.bytes);

    const del = document.createElement('button');
    del.className = 'sm-del';
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      del.disabled = true;
      del.textContent = 'Deleting…';
      try { await cacheDeleteShard(cache, s.base); }
      catch (e) { console.warn('[storage] delete failed:', e); }
      await _storageRender();
    });

    row.appendChild(name); row.appendChild(size); row.appendChild(del);
    listEl.appendChild(row);
  }
}

function _storageWire() {
  const modal = document.getElementById('storage-modal');
  if (!modal || modal.dataset.wired === '1') return;
  modal.dataset.wired = '1';

  const close = () => modal.classList.add('hidden');
  const x = document.getElementById('sm-close');
  if (x) x.addEventListener('click', close);
  // Click the backdrop (but not the box) to dismiss.
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });

  const all = document.getElementById('sm-delete-all');
  if (all) {
    _armOnce(all, 'Click again to delete all', async (btn, idle) => {
      btn.disabled = true;
      btn.textContent = 'Deleting…';
      try {
        const cache = await openCache();
        if (cache) await cacheClear(cache);
      } catch (e) { console.warn('[storage] delete-all failed:', e); }
      btn.disabled = false;
      btn.textContent = idle;
      await _storageRender();
    });
  }

  // Full reset: cached game files AND this browser's local settings. The settings come back from
  // the server on the next sign-in, which is why this is offered separately from the cache-only
  // delete rather than folded into it -- for a guest there is nothing to come back from.
  const reset = document.getElementById('sm-full-reset');
  if (reset) {
    _armOnce(reset, 'Click again to reset the client', async (btn) => {
      btn.disabled = true;
      btn.textContent = 'Resetting…';
      try {
        const cache = await openCache();
        if (cache) await cacheClear(cache);
      } catch (e) { console.warn('[storage] reset: cache clear failed:', e); }
      try { localStorage.clear(); } catch (e) { console.warn('[storage] reset: localStorage failed:', e); }
      try { sessionStorage.clear(); } catch { /* nothing worth reporting */ }
      location.reload();
    });
  }

  // GDPR erasure. Revealed only for a signed-in account, because that is the only case where the
  // server holds anything to erase -- offering it to a guest would promise an action with no
  // subject. 🚨 NOT the same thing as clearing the cache above: this asks the SERVER to forget
  // the account, and presenting local file deletion as account deletion would be a false promise.
  const acct = document.getElementById('sm-account');
  const delAcct = document.getElementById('sm-delete-account');
  if (acct && delAcct) {
    if (_discordUser) acct.style.display = '';
    _armOnce(delAcct, 'Click again to permanently delete', async (btn) => {
      btn.disabled = true;
      btn.textContent = 'Deleting…';
      try {
        const r = await fetch('/api/me/delete', { method: 'POST', credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // The account is gone; the cookie referencing it must not survive the reload.
        try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); }
        catch { /* session already invalid */ }
        location.reload();
      } catch (e) {
        console.warn('[account] delete failed:', e);
        btn.disabled = false;
        btn.textContent = 'Delete failed — try again';
      }
    });
  }
}

function _storageOpen() {
  const modal = document.getElementById('storage-modal');
  if (!modal) return;
  _storageWire();
  modal.classList.remove('hidden');
  void _storageRender();
}

// Populate + wire the top-right widget. Safe to call more than once.
/**
 * A Discord identity -> the URL of its avatar.
 *
 * 🚨 `avatar` on the user object is a HASH. Assigning it to img.src asks THIS origin for a file
 * named after the hash — a 404 and a broken image. That was found once and fixed in the account
 * menu alone, while window.UORailAccount kept handing the raw hash to the rail, which puts it
 * straight into <img src>: the User panel showed a broken circle. One function, both callers.
 *
 * The embed fallback keeps a face on accounts with no custom avatar rather than showing nothing.
 */
function discordAvatarUrl(u) {
  if (!u) return null;
  let defaultIdx = 0;
  try { if (u.id) defaultIdx = Number(BigInt(u.id) % 6n); } catch { defaultIdx = 0; }
  return (u.id && u.avatar)
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${defaultIdx}.png`;
}
function _wireAccountWidget() {
  const widget = document.getElementById('discord-widget');
  if (!widget || !_discordUser) return;
  widget.style.display = '';

  const name = _discordUser.name || 'Account';
  const initial = (name.trim()[0] || 'D').toUpperCase();

  // 🚨 /api/me RETURNS THE AVATAR **HASH**, NOT A URL. auth.ts stores what Discord's user object
  // carries ("Stored Discord avatar hash for `sub`"), so assigning it to img.src asks this origin
  // for a file named after the hash -- a 404, a broken image, and a menu with no face on it. The
  // main client hit this too; portal-rail.js builds the CDN URL, and this build does not ship
  // portal-rail.js. Same root cause as the dead widget itself.
  //
  // The embed fallback keeps a face on accounts with no custom avatar rather than showing nothing.
  const avatar = discordAvatarUrl(_discordUser);

  const setFace = (imgId, initId) => {
    const img = document.getElementById(imgId);
    const ini = document.getElementById(initId);
    if (ini) ini.textContent = initial;
    if (!img) { if (ini) ini.style.display = ''; return; }
    // onerror BEFORE src, or a cached failure can fire before the handler is attached. The initial
    // is the honest fallback: a broken-image icon says "this site is broken", a letter does not.
    img.onerror = () => { img.style.display = 'none'; if (ini) ini.style.display = ''; };
    img.crossOrigin = 'anonymous';
    img.alt = name;
    img.src = avatar;
    img.style.display = '';
    if (ini) ini.style.display = 'none';
  };
  setFace('dw-avatar-img', 'dw-initial');
  setFace('dm-avatar-img-lg', 'dm-initial-lg');

  const uname = document.getElementById('dm-username');
  if (uname) uname.textContent = name;

  // 🚨 A GUEST IS NOT A DISCORD ACCOUNT, and the markup is written as though every session were
  // one. /api/me answers 200 for a guest too (sub `guest-<hex>`), so this whole widget shows for
  // them -- correctly, since storage and data deletion are exactly what a guest may want and this
  // is their only route to either. What is NOT correct is the labelling: measured on a real guest
  // session, the menu read "Discord" and offered "Sign out of Discord" to somebody who had just
  // clicked "Continue as guest". Wiring a surface for a new case means re-reading what it CLAIMS,
  // not only whether it functions.
  const isGuest = typeof _discordUser.id === 'string' && _discordUser.id.startsWith('guest-');
  const sub = widget.querySelector('.dm-user-sub');
  if (sub) sub.textContent = isGuest ? 'Guest session' : 'Discord';
  const logoutLabel = document.getElementById('dm-logout');
  if (logoutLabel) logoutLabel.textContent = isGuest ? 'End guest session' : 'Sign out of Discord';

  if (widget.dataset.wired === '1') return;
  widget.dataset.wired = '1';

  const btn = document.getElementById('discord-widget-btn');
  const menu = _accountMenuEl();
  if (btn && menu) {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (menu.classList.contains('hidden')) menu.classList.remove('hidden');
      else _accountCloseMenu();
    });
    document.addEventListener('click', (ev) => {
      if (!widget.contains(ev.target)) _accountCloseMenu();
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') _accountCloseMenu(); });
  }

  // 🚨 THE FOOTER LINK, WHICH WAS DEAD IN THIS BUILD ONLY. "Stuck on loading? Clear the cache from
  // Manage storage" sits at the bottom of every page, and it is the one link a player who IS stuck
  // will click. In the full client portal-rail.js wires it; the minimal does not ship portal-rail,
  // so the markup came across and the handler did not — the same shape as the picker taking the
  // sign-in panel with it. `href="#"` means a click scrolls to the top and nothing else happens.
  const footerStorage = document.getElementById('footer-storage-link');
  if (footerStorage) footerStorage.addEventListener('click', (e) => { e.preventDefault(); _storageOpen(); });

  const storage = document.getElementById('dm-storage');
  if (storage) storage.addEventListener('click', () => { _accountCloseMenu(); _storageOpen(); });

  const logout = document.getElementById('dm-logout');
  if (logout) logout.addEventListener('click', () => { void _accountSignOut(); });

  // Admin entry: asked, never assumed. /api/admin/gate is the same check nginx puts in front of
  // /admin, so this can only reveal an entry that will actually open.
  const admin = document.getElementById('dm-admin');
  if (admin) {
    admin.addEventListener('click', () => { window.open('/admin', '_blank', 'noopener'); });
    fetch('/api/admin/gate', { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => { if (r.ok) admin.style.display = ''; })
      .catch(() => { /* not an admin, or offline: the entry stays hidden */ });
  }
}

// 🚨 THE CLIENT SELECTOR MUST NOT NAVIGATE ON CLICK, and this is how the switch is carried instead.
//
// It used to set `location.href` the moment a player picked a client, so choosing between ClassicUO
// and TazUO reloaded the page under them — for a control that is a PREFERENCE, not an action.
// Upstream does not do that: its toggle only flips its own state and stores the pick, and the
// navigation happens later, when the player clicks a shard to play.
//
// This build has no shard picker, so the equivalent moment is the start button. The pick is recorded
// on click, and the ONE navigation happens when the player presses Play (or Continue as guest).
//
// ⚠️ The hand-off is a one-shot in sessionStorage, NOT a query parameter. A parameter would be
// linkable, and a link that skips the landing would auto-boot the client — precisely the behaviour
// removed on 2026-08-25 at the operator's request. Only a navigation this page started can set this,
// it lives in one tab, and it is consumed on arrival.
const CLIENT_HANDOFF_KEY = 'uoweb:minimal:startNow';

/** The bundle the player has chosen, when it is not the one already running. */
function _pendingClientSwitch() {
  try {
    // Same accessor as the highlight above. Naming the key here is what broke this: the read
    // returned null every time, so a pending switch was never detected and Play started the bundle
    // already loaded — the player pressed a client, watched nothing happen, and had to reload.
    const pick = window.__minimalGetClient && window.__minimalGetClient();
    if (pick !== 'cuo' && pick !== 'tuo') return null;
    const here = window.__bundle === 'tuo' ? 'tuo' : 'cuo';
    return pick === here ? null : pick;
  } catch (e) { return null; }
}

/**
 * Hand off to the other bundle, already started.
 *
 * Carries the query and hash across: every diagnostic this project hands out is a query parameter,
 * and dropping them makes the remedy look like it did nothing.
 */
function _handOffToClient(which) {
  try { sessionStorage.setItem(CLIENT_HANDOFF_KEY, '1'); } catch (e) { /* gate shows again; harmless */ }
  location.href = (which === 'tuo' ? '/tuo/' : '/') + location.search + location.hash;
}

/** True once, on the load that a start button navigated into. */
function _consumeClientHandoff() {
  try {
    if (sessionStorage.getItem(CLIENT_HANDOFF_KEY) !== '1') return false;
    sessionStorage.removeItem(CLIENT_HANDOFF_KEY);
    return true;
  } catch (e) { return false; }
}

async function discordInit() {
  // Both landing panels (#sso-panel for a visitor, #sso-user for a returning player) carry the
  // invite icon, so this runs before the branch rather than inside one of them. Not awaited: a
  // slow /api/config must never delay the gate the player is waiting on.
  void _wireDiscordInvite();
  _wireFaqLauncher();
  void _wireClientSwitch();

  // Arrived here because the player already pressed Play on the other bundle. Showing the gate again
  // would make switching client cost two clicks on two screens, which is the thing being fixed.
  if (_consumeClientHandoff()) return;

  // Check active session. HARD TIMEOUT (6s): the shard picker is gated on this
  // resolving, so a slow/stalled /api/me (operator caught it "pending" in the
  // Network tab while the page showed no picker — a momentary proxy event-loop
  // stall stalls every in-flight request) must NOT strand the whole landing. On
  // timeout we abort and fall through as "not signed in" → the picker shows in
  // guest mode, exactly as for an anonymous visitor. A real session re-appears on
  // the next load. (operator-reported intermittent "no carga ni el picker", 2026-06-11)
  let me = null;
  const _meCtrl = new AbortController();
  const _meTimer = setTimeout(() => _meCtrl.abort(), 6000);
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', signal: _meCtrl.signal });
    if (res.ok) me = await res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') console.warn('[discord] /api/me timed out (6s) — showing picker as guest');
  } finally { clearTimeout(_meTimer); }

  if (me) {
    _discordUser = me;
    await _discordApplySettings();
    await _discordFetchProfile();
    // ⚠️ THIS USED TO SAY the post-login account menu lives in /portal-rail.js. It does upstream,
    // and this build does not ship that file — which is exactly why the rail rendered "Guest" to a
    // signed-in player until window.UORailAccount was provided here instead. Kept as a note rather
    // than deleted: it is the reason the bridge further down exists.
    void discordSaveSettings();
    _wireAccountWidget();

    // 🚨 THIS BUILD MUST NOT AUTO-BOOT A SIGNED-IN PLAYER, and the reason is the same shape as
    // every other bug in this fork: a line copied from a build that had somewhere else to go.
    //
    // Upstream, v0.7.5 removed the "Welcome back @user — [Play]" panel for logged-in users as
    // "one click too many", because there the gate handed off to the SHARD PICKER — still a
    // screen, still a decision. This build deleted the picker (one fixed shard is the point),
    // so the same `return` hands off to nothing and the WASM client starts on page load. The
    // player lands on a shard with no chance to reach storage, account deletion or /admin
    // first, and no way back short of killing the tab. Operator, 2026-08-25: "no te debería
    // auto-arrancar el cliente como sucede ahora, sino mostrarte esa misma pantalla con un
    // mensaje de play".
    //
    // The markup was here the whole time and unused, exactly like #sso-panel was.
    const userPanel = document.getElementById('sso-user');
    const playBtn = document.getElementById('play-game');
    if (!userPanel || !playBtn) return;   // markup changed shape: boot rather than strand the player

    const nameEl = document.getElementById('discord-username');
    if (nameEl) nameEl.textContent = _discordUser.name || 'friend';   // textContent: never innerHTML

    // 'flex', not '': the stylesheet hides this with `display:none` on the rule itself, so
    // clearing the inline value hands the decision back to a rule that keeps it hidden — the
    // panel would sit invisible with its content correctly filled in, which reads as "the
    // wiring never ran". Same trap the #sso-panel gate hit on its first deploy.
    userPanel.style.display = 'flex';

    const signOut = document.getElementById('discord-logout');
    if (signOut) {
      signOut.addEventListener('click', (ev) => {
        ev.preventDefault();
        void _accountSignOut();
      });
    }

    await new Promise((resolve) => {
      let done = false;
      playBtn.addEventListener('click', () => {
        if (done) return;             // double-click must not start two boots
        done = true;
        playBtn.disabled = true;
        // The client selector only recorded a preference. This is where it is acted on, so the
        // player pays one navigation for the whole choice instead of one per click on the toggle.
        const switchTo = _pendingClientSwitch();
        if (switchTo) { _handOffToClient(switchTo); return; }   // deliberately never resolves
        userPanel.style.display = 'none';
        resolve();
      });
    });
    return; // gate passed — the player chose to start
  }

  // Not signed in. 🚨 THIS BUILD SHOWS THE GATE; the full client deliberately does not.
  //
  // Upstream (operator 2026-06-10) there is no blocking SSO gate because the SHARD PICKER carries
  // the affordances: a 'Login with Discord' button for anonymous visitors, and a guest-mode confirm
  // on shard click that mints /auth/guest before the game boots. This build has no picker — one
  // fixed shard is the point — so deleting it took the ONLY surface offering either choice with it.
  // The result was a client that silently booted as a guest: no way to sign in, no way to say you
  // meant to be a guest, and /admin (behind auth_request) unreachable because nothing could ever
  // mint a session. Copying the upstream "just hide the panel" line into a build with no picker is
  // how that happened; the markup for the gate was here the whole time, unused.
  const panel = document.getElementById('sso-panel');
  if (!panel) return;            // no gate markup: boot rather than strand the player on a blank page

  // Discord is OPTIONAL for a self-hoster. /api/config already reports whether this install has an
  // app configured; without one, /auth/discord answers 503 and the button would be a dead end, so it
  // is removed rather than shown broken. Never let this decide the gate itself: a failed probe must
  // still leave a usable "continue as guest".
  let discordEnabled = false;
  try {
    const cfg = await fetch('/api/config', { credentials: 'same-origin' });
    if (cfg.ok) discordEnabled = !!(await cfg.json()).discordEnabled;
  } catch (e) { /* offline or 503 — treat as not configured */ }

  const btn = panel.querySelector('.discord-btn');
  const desc = panel.querySelector('.sso-desc');
  const divider = panel.querySelector('.sso-divider');
  if (!discordEnabled) {
    if (btn) btn.remove();
    if (divider) divider.remove();
    if (desc) desc.textContent = 'This install has no Discord application configured, so settings are '
      + 'kept in this browser only. See README.md to enable sign-in.';
  }

  // 'flex', not '': the stylesheet's own rule is `display:none; flex-direction:column`, so clearing
  // the inline value hands the decision back to a rule that hides it. The panel then stays invisible
  // while its CONTENT updates correctly — which is what it did on the first deploy, and reads like
  // the wiring never ran at all.
  panel.style.display = 'flex';
  const cont = document.getElementById('sso-continue');
  if (!cont) return;             // markup changed shape: do not trap the player behind a gate

  await new Promise((resolve) => {
    let done = false;
    cont.addEventListener('click', async () => {
      if (done) return;          // double-click must not mint two sessions
      done = true;
      cont.disabled = true;
      // Mint the guest session BEFORE the WASM boot: the client fetches game files and opens the WS
      // with whatever cookie exists at that moment, so minting afterwards races its own login.
      try {
        await fetch('/auth/guest', { method: 'POST', credentials: 'same-origin' });
      } catch (e) {
        // Play anyway. A guest session is a convenience — it carries settings — and refusing to
        // start the game because a cookie could not be minted would be the wrong trade.
        console.warn('[sso] guest session could not be minted; continuing anonymously', e);
      }
      // Same hand-off as the signed-in path, and AFTER minting on purpose: the cookie has to exist
      // before the other bundle boots, or it opens its WebSocket with no session and the guest's
      // settings have nowhere to live.
      const switchTo = _pendingClientSwitch();
      if (switchTo) { _handOffToClient(switchTo); return; }   // deliberately never resolves
      panel.style.display = 'none';
      resolve();
    });
  });
}

async function discordSaveSettings() {
  if (!_discordUser) return;
  try {
    const qs = new URLSearchParams(location.search);
    const payload = {};
    // SECURITY: do NOT persist 'wsHost' from the URL — that auto-save (on
    // pagehide) is what turned a crafted ?wsHost=evil.com link into a STORED
    // game-WS MITM. The host is locked to location.hostname anyway.
    for (const key of ['wsPort', 'wsPath']) {
      const v = qs.get(key);
      if (v) payload[key] = v;
    }
    // Always save as string ID ("none", "old", ...) so the picker can
    // round-trip it via its <option value="..."> attributes.
    // No dropdown here, so the URL is the only place a caller can express this.
    let encVal = qs.get('encrypt');
    if (!encVal && typeof localStorage !== 'undefined') {
      const byteStr = localStorage.getItem('uo:encryption');
      const idx = byteStr ? parseInt(byteStr, 10) : NaN;
      if (idx >= 0 && idx < BYTE_TO_NAME.length) encVal = BYTE_TO_NAME[idx];
    }
    if (encVal) payload['encrypt'] = String(encVal);
    await fetch('/api/settings', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch { /* fire-and-forget */ }
}

//
// Cross-device sync of CUO's per-account UI state: profile.json
// (Options menu), gumps.xml (window positions), macros.xml,
// skills.xml, cooldowns.xml. Stored opaque on the server as one
// gzipped tar per Discord ID.
//
// Server is authoritative on login: whatever's on the server overlays
// write-wins on subsequent uploads. This trades multi-tab edit
// merging for a simple, predictable mental model.
//
// persists locally, just not cross-device.

async function _discordFetchProfile() {
  if (!_discordUser) return;
  try {
    const r = await fetch(`/api/profile?client=${_bundleId()}`, { credentials: 'same-origin' });
    if (r.status === 404) {
      console.log('[discord] no server profile yet — local IDBFS will be used as-is');
      return;
    }
    if (!r.ok) {
      console.warn(`[discord] fetchProfile HTTP ${r.status}`);
      return;
    }
    _serverProfileBytes = new Uint8Array(await r.arrayBuffer());
    console.log(`[discord] fetched profile blob: ${_serverProfileBytes.length} bytes (gzipped)`);
  } catch (e) { console.warn('[discord] fetchProfile error:', e); }
}

// top — server wins on per-file basis. Returns a promise resolved
//
// Hardening (audit H-1): the overlay path is the symmetric twin of the
// upload path, so it MUST apply the same _isAllowedProfileFile filter
// PLUS path-traversal guards. A compromised or misbehaving server that
// returned a tar with `name = "../../../uo/cliloc.enu"` would otherwise
// rules as server validateTar(): basename in ALLOWED_PROFILE_FILES, path
// starts with `Profiles/`, no `..` segments, no leading `/`, no NUL byte,
// per-file size ≤ PROFILE_PER_FILE_MAX_BYTES.
const PROFILE_OVERLAY_MAX_BYTES = 12 * 1024 * 1024; // decompressed cap

async function _discordOverlayProfile(FS) {
  if (!_serverProfileBytes || !FS) return;
  try {
    const tarBytes = await gunzipBytes(_serverProfileBytes);
    if (tarBytes.length > PROFILE_OVERLAY_MAX_BYTES) {
      console.warn(`[discord] server profile too large (${tarBytes.length} B) — refusing overlay`);
      return;
    }
    const all = tarUnpack(tarBytes);
    const files = all.filter(f => {
      if (!f.path) return false;
      if (f.path.includes('..') || f.path.startsWith('/') || f.path.includes('\0')) return false;
      return _isAllowedProfileFile(f.path, f.content.length);
    });
    const dropped = all.length - files.length;
    if (dropped > 0) console.warn(`[discord] dropped ${dropped} unsafe entry(ies) from server profile`);
    if (files.length === 0) return;
    // Remember how many macros the server copy carried, BEFORE the client can touch them.
    // This is the only moment that number is knowable: the blob is freed right after.
    _serverMacroCount = countMacrosIn(files);
    const written = fsWriteAll(FS, '/Data', files);
    console.log(`[discord] overlaid ${written}/${files.length} files from server profile`);
    await new Promise((resolve) => {
      FS.syncfs(false, (e) => {
        if (e) console.warn('[discord] post-overlay syncfs error:', e);
        resolve();
      });
    });
  } catch (e) {
    console.warn('[discord] overlayProfile failed:', e?.message ?? e);
  } finally {
    _serverProfileBytes = null; // free the buffer; we won't need it again
  }
}

// Strict per-basename whitelist: these are the ONLY files that ever
// disco son: gumps.xml infobar.xml macros.xml profile.json
// skillsgroups.xml. El resto en memoria del navegador, no a disco".
//
//          syncfs(false) — anything not in the set is unlinked from
// Layer 2: uploadProfileBlob() filters again before tar packing,
//          so even if a leak slipped past Layer 1, the server
//          never sees it.
// Layer 3: server validateTar() rejects anything not in the set,
//          handling a custom-crafted PUT from a hijacked client.
const ALLOWED_PROFILE_FILES = new Set([
  'gumps.xml',
  'infobar.xml',
  'macros.xml',
  'profile.json',
  'skillsgroups.xml',
]);
const PROFILE_PER_FILE_MAX_BYTES = 256 * 1024;

/**
 * How many `<macro …>` entries a set of profile files holds, summed across every character.
 *
 * Counts the OPENING TAG rather than parsing XML: the file is CUO's own `macros.xml`, the shape is
 * fixed, and a parser here would be a second thing to keep in step with the client. Returns 0 when
 * there is no macros.xml at all, which is the same thing as far as the caller is concerned.
 */
function countMacrosIn(files) {
  let n = 0;
  for (const f of files) {
    if (!/(^|\/)macros\.xml$/.test(f.path)) continue;
    try {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(f.content);
      n += (text.match(/<macro\b/gi) || []).length;
    } catch { /* unreadable: treat as no macros rather than guessing high */ }
  }
  return n;
}

function _isAllowedProfileFile(path, sizeBytes) {
  if (sizeBytes > PROFILE_PER_FILE_MAX_BYTES) return false;
  // Must live under Profiles/ AND be one of the whitelisted basenames; the
  // server enforces the same shape (validateTar in auth.ts).
  if (!path.startsWith('Profiles/')) return false;
  const slash = path.lastIndexOf('/');
  const base = slash >= 0 ? path.substring(slash + 1) : path;
  return ALLOWED_PROFILE_FILES.has(base);
}

// Walk /Data and unlink any file whose basename is not in
// ALLOWED_PROFILE_FILES. Empty dirs left behind get rmdir'd so the
// syncfs(false) so the in-memory junk never persists. Tradeoff:
// CUO can't reliably re-read its own pruned files mid-session,
// which is exactly what the user asked for ("memoria del navegador,
// no a disco" — those files exist for the duration of a write but
// not as durable state).
function pruneDataExceptWhitelist(FS) {
  if (!FS) return;
  let removed = 0;
  let hot = 0;
  // FREEZE-HUNT root fix (operator 2026-07-10, runs 0001+0077): this prune runs on
  // the JS MAIN thread inside every IDBFS flush, unlinking/rmdir'ing /Data entries
  // WHILE the C# game pthread may be mid-write in the same tree (first-run default
  // files at world entry, then the 5 s autosave forever after). When the prune ate
  // a file/dir the writer had in flight, the worker took an uncaught IOException and
  // Mercury MT's policy killed the whole runtime (mono_exit -> RuntimeError:
  // unreachable) — or wedged the tab when a shared lock was held. Both hunt crashes
  // died on the exact same line ("No macros.xml file. Creating a default file.")
  // with the prune logged 3 lines earlier; every PASS run had the prune AFTER the
  // writes. Fix: only COLD entries (mtime older than PRUNE_AGE_MS) are eligible —
  // an in-flight write is milliseconds old and untouchable; real junk simply falls
  // to the next flush cycle (~30 s later), trading "never persists" for "persists
  // at most one cycle", which can never crash the writer.
  const PRUNE_AGE_MS = 30000;
  const nowMs = Date.now();
  const isCold = (stat) => {
    try { return (nowMs - stat.mtime.getTime()) > PRUNE_AGE_MS; } catch { return false; }
  };
  const walk = (dir) => {
    // v0.4.69: skip the WorldMap PNG cache subtree. CUO writes the
    // pre-rendered map PNGs to /Data/Client/MapsCache/. Pruning them
    // forces a 30-90 s rebuild (146 MB MD5 + 458 K tile iteration)
    // on every subsequent WorldMap open — the user reported "tarda
    // muchísimo y a veces ni siquiera carga" 2026-05-12. The PNGs
    // are content-addressed by file size (v0.4.69 fingerprint) so
    // stale entries auto-invalidate on shard upgrade.
    if (dir === '/Data/Client/MapsCache' || dir === '/Data/Client') {
      return;
    }
    let entries;
    try { entries = FS.readdir(dir); } catch { return; }
    for (const name of entries) {
      if (name === '.' || name === '..') continue;
      const full = `${dir}/${name}`;
      let stat;
      try { stat = FS.stat(full); } catch { continue; }
      if (FS.isDir(stat.mode)) {
        walk(full);
        try {
          const left = FS.readdir(full).filter(n => n !== '.' && n !== '..');
          // Age-gate the rmdir too: a freshly created still-empty dir is the
          // writer ABOUT to place its first file — deleting it under the C#
          // thread turns the next create into ENOENT (same crash family).
          if (left.length === 0 && isCold(FS.stat(full))) FS.rmdir(full);
        } catch { /* ignore */ }
      } else if (FS.isFile(stat.mode) && !ALLOWED_PROFILE_FILES.has(name)) {
        if (isCold(stat)) {
          try { FS.unlink(full); removed++; } catch { /* ignore */ }
        } else {
          hot++; // in-flight or just-written — next cycle's problem, never this one's
        }
      }
    }
  };
  walk('/Data');
  if (removed > 0) console.log(`[discord] prune: removed ${removed} non-whitelisted file(s) from /Data`);
  if (hot > 0) console.log(`[discord] prune: skipped ${hot} hot file(s) (<${PRUNE_AGE_MS / 1000}s old) — race guard`);
}

// don't hammer the server during the 5-s C# autosave cadence — only
// uploads if at least PROFILE_UPLOAD_THROTTLE_MS has passed since
// the last successful PUT. Pagehide passes `force=true` to bypass
// the throttle and additionally use `keepalive` so the request
// survives the unload (subject to the browser's 64 KiB keepalive
// body cap — large profiles fall back to a regular fetch which may
// be cancelled mid-flight; the throttled interval upload covers
// that loss window).
async function uploadProfileBlob(force = false) {
  // Anti-resurrection: once the user asks to delete their cloud profile we MUST
  // stop re-pushing the in-memory copy (auto, forced 'Sync now', or pagehide),
  // or the just-deleted blob comes straight back. Set by the delete-profile flow.
  if (window.__uoNoProfileSync) return false;
  if (!_discordUser || !_capturedFS) return false;
  const now = performance.now();
  if (!force && now - _lastProfileUploadAt < PROFILE_UPLOAD_THROTTLE_MS) return false;
  try {
    // `Profiles/<server>/<acc>/<char>/<file>` — the server's validateTar
    // requires that prefix. The basename whitelist + Profiles/ prefix
    // filter drops everything else.
    const all = fsWalk(_capturedFS, '/Data');
    const allowed = all.filter(f => _isAllowedProfileFile(f.path, f.content.length));
    const dropped = all.length - allowed.length;
    if (dropped > 0) console.log(`[discord] dropped ${dropped} non-config file(s) from upload`);
    // Bound the number of character folders so a profile cannot grow forever. Applied AFTER the
    // whitelist, so the cap counts only what would actually have been stored.
    const files = capProfileDirs(allowed);
    if (files.length === 0) return false; // nothing to upload yet

    // 🚨 Never replace a profile that HAS macros with one that has none.
    //
    // This is write-wins sync, so one bad upload is permanent: the server copy is the only thing
    // that survives clearing the browser, and nothing else can put it back. The dangerous path is
    // a session that starts WITHOUT the player's macros — an overlay that did not land, storage
    // that came back empty — because the client then writes its defaults and the very next
    // autosave uploads that emptiness over the good copy. The player sees macros vanish and
    // stay vanished, which is exactly the report this guard exists for (2026-08-11, twice).
    //
    // Deliberately narrow: it blocks ONLY going from some macros to zero. Deleting a few is
    // normal editing and still syncs; deleting every last one is rare enough that costing that
    // person one manual re-save is a fair trade for never silently eating someone's work.
    // A skip is loud, because a quiet skip is its own kind of lie.
    if (_serverMacroCount > 0 && countMacrosIn(files) === 0 && !_userEditedThisSession) {
      // Name the cap as a possible cause. It runs BEFORE this check, so evicting folders can be
      // what emptied the set — and blaming "this session never got them" would send whoever reads
      // the log looking in the wrong place. Only ever relevant past 50 character folders.
      const capped = allowed.length !== files.length;
      console.warn(`[discord] REFUSING to upload a profile with no macros over one that had `
        + `${_serverMacroCount} — overwriting would lose them for good. `
        + (capped
          ? `NOTE: the character-folder cap dropped ${allowed.length - files.length} file(s) from `
            + `this upload, so the cap may be why no macros are left in it.`
          : `This session never got them; reload while signed in to pull your macros back.`));
      return false;
    }

    const tarBytes = tarPack(files);
    const gz = await gzipBytes(tarBytes);
    const useKeepalive = force && gz.length <= PROFILE_KEEPALIVE_LIMIT;
    const init = {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: gz,
    };
    if (useKeepalive) init.keepalive = true;
    const r = await fetch(`/api/profile?client=${_bundleId()}`, init);
    if (r.ok) {
      _lastProfileUploadAt = now;
      console.log(`[discord] uploaded profile blob: ${files.length} files / ${gz.length} bytes${useKeepalive ? ' (keepalive)' : ''}`);
      return true;
    } else {
      console.warn(`[discord] uploadProfile HTTP ${r.status}`);
      return false;
    }
  } catch (e) {
    console.warn('[discord] uploadProfile error:', e?.message ?? e);
    return false;
  }
}

// ── Import / Export the LOCAL profile via a browser file picker ───────────────
// These operate on THIS client's real /Data/Profiles tree (profile.json +
// gumps/macros/skills/cooldowns XML) — so they are inherently client-specific:
// the CUO bundle reads/writes ClassicUO profiles, the TUO bundle TazUO profiles.
// Export packs the tree to a .tar.gz download; Import reads a picked .tar.gz
// (the same format), overlays it into /Data, syncs to IDBFS, and reloads so the
// client re-reads the imported settings. Mirrors the official client's
// file-picker "Import/Export State", scoped to the real on-disk profile files.
// MUST read window.__bundle, NOT location.pathname: the v0.7.7 transparent-
// routing IIFE replaceState's /tuo/ (and /cuo/) → / at boot, so by the time
// this runs location.pathname is always '/'. Using pathname here returned 'cuo'
// for EVERY bundle, which silently merged TUO's profiles into CUO's — both the
// local IDBFS DB ('/Data' vs '/Data-tuo') and the cloud blob (?client=cuo|tuo).
// __bundle is captured from the PRE-strip pathname (line ~58) so it stays correct.
const _bundleId = () => ((typeof window !== 'undefined' && window.__bundle === 'mini') ? 'mini'
  : (typeof window !== 'undefined' && window.__bundle === 'tuo') ? 'tuo' : 'cuo');

// Returns { ok, count } — count = files exported. Triggers a download.
async function exportProfileArchive() {
  if (!_capturedFS) return { ok: false, count: 0 };
  try {
    const all = fsWalk(_capturedFS, '/Data');
    const files = all.filter(f => _isAllowedProfileFile(f.path, f.content.length));
    if (files.length === 0) return { ok: false, count: 0 };
    const gz = await gzipBytes(tarPack(files));
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([gz], { type: 'application/gzip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${_bundleId()}-profile-${stamp}.tar.gz`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return { ok: true, count: files.length };
  } catch (e) {
    console.warn('[profile] export error:', e?.message ?? e);
    return { ok: false, count: 0 };
  }
}

// Opens a file picker, imports a previously-exported .tar.gz into /Data, syncs,
// and (on success) reloads so the client re-reads it. Resolves { ok, count,
// reload } — reload=true means a reload was scheduled.
function importProfileArchive() {
  return new Promise((resolve) => {
    if (!_capturedFS) { resolve({ ok: false, count: 0 }); return; }
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.gz,.tgz,.tar';
    inp.style.display = 'none';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (!f) { resolve({ ok: false, count: 0 }); return; }
      try {
        const raw = new Uint8Array(await f.arrayBuffer());
        // .tar = uncompressed; otherwise gunzip first.
        const tar = /\.tar$/i.test(f.name) ? raw : await gunzipBytes(raw);
        if (tar.length > PROFILE_OVERLAY_MAX_BYTES) {
          resolve({ ok: false, count: 0, error: 'too large' }); return;
        }
        const entries = tarUnpack(tar).filter(e =>
          e.path && !e.path.includes('..') && !e.path.startsWith('/') &&
          !e.path.includes('\0') && _isAllowedProfileFile(e.path, e.content.length));
        if (entries.length === 0) { resolve({ ok: false, count: 0, error: 'no valid profile files' }); return; }
        const n = fsWriteAll(_capturedFS, '/Data', entries);
        await new Promise((r) => _capturedFS.syncfs(false, () => r()));
        resolve({ ok: n > 0, count: n, reload: n > 0 });
        if (n > 0) setTimeout(() => location.reload(), 1200);
      } catch (e) {
        console.warn('[profile] import error:', e?.message ?? e);
        resolve({ ok: false, count: 0, error: 'unreadable archive' });
      }
    }, { once: true });
    document.body.appendChild(inp);
    inp.click();
  });
}

//
//   IDB serialises writes to one object store, so the 16 fetch workers
//   queue behind a ~50 MB/s transaction rate. For our 1.4 GB cold load
//   that's ~28 s of write time interleaved with the fetch pipeline.
//   system — no transaction queue, no key-value deserialisation —
//   benchmarks ~3-5× faster on large blob writes.
//
//   wasm CUO already requires SharedArrayBuffer + COOP/COEP +
//   WebAssembly + WebGL2 (all post-2017), so every browser that runs
//   safety net for when getDirectory() is missing or rejects (e.g.
//   private window quota, sandboxed iframe).
//
//   /cuo-assets/<filename>   each file's bytes + a 4-byte etag-length
//                            prefix + the etag string. Inline header
//                            separate manifest to keep in sync.
//
// Cache shape returned by cacheGet / accepted by cachePut:
//   { etag: string, bytes: Uint8Array }

const DB_NAME  = 'cuo-assets';
const DB_VER   = 1;
const DB_STORE = 'files';
const OPFS_DIR = 'cuo-assets';

// v0.5.26 F2: OPFS bridge for cross-session chunk snapshot cache.
// Separate directory from `cuo-assets` so the existing IDB-fallback path
// for gamefile cache doesn't conflict with snapshot persistence.
// Snapshots are accessed by C# via [JSImport] declarations against the
// globalThis.cuoOpfsSnapshot* functions defined below.
const OPFS_SNAPSHOTS_DIR = 'cuo-snapshots';
// v0.9.371: snapshots are namespaced PER FILESET inside cuo-snapshots/.
// Pre-fix, every shard on the origin shared one flat pool keyed only by
// (mapIndex, chunkX, chunkY) — playing eternal and then a shard with a
// different fileset hydrated the other world's terrain wherever the two
// blocks' staidx counts coincided (0 == 0 above all: ocean vs void).
// The namespace derives from __chosenGamefilesUrlBase — the exact same
// discriminator the gamefile asset cache already uses so "two shards
// with different bytes for the same filename don't collide". Shards that
// share a fileset share a namespace (correct: identical muls).
function _opfsSnapshotsNs() {
  const base = String(window.__chosenGamefilesUrlBase || 'gamefiles');
  // FNV-1a 32-bit → 8 hex chars: stable, sync, collision-safe at this scale.
  let h = 0x811c9dc5;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'ns-' + (h >>> 0).toString(16).padStart(8, '0');
}
let _opfsSnapshotsDir = null;
async function _opfsSnapshotsGetDir() {
  if (_opfsSnapshotsDir) return _opfsSnapshotsDir;
  if (!navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle(OPFS_SNAPSHOTS_DIR, { create: true });
    // One-time migration sweep: delete legacy UN-namespaced *.bin files at
    // the dir root (pre-v0.9.371, shared across shards — potentially cross-
    // shard-poisoned; the C# schema bump v2→v3 would reject them anyway).
    try {
      const stale = [];
      for await (const [name, handle] of parent.entries()) {
        if (handle.kind === 'file' && name.endsWith('.bin')) stale.push(name);
      }
      for (const name of stale) await parent.removeEntry(name).catch(() => {});
      if (stale.length) console.log(`[opfs-snap] migrated: removed ${stale.length} legacy un-namespaced snapshot(s)`);
    } catch { /* best-effort */ }
    _opfsSnapshotsDir = await parent.getDirectoryHandle(_opfsSnapshotsNs(), { create: true });
    return _opfsSnapshotsDir;
  } catch (e) {
    console.warn('[opfs-snap] dir handle failed:', e?.message ?? e);
    return null;
  }
}
// v0.9.371: serialize snapshot writes. Two rapid captures of the SAME chunk
// used to race their createWritable() streams — last close wins, which could
// be the OLDER payload. A single promise chain keeps write order = call order
// (writes are a few KB each; bursts were already sequential in effect).
let _opfsSnapWriteChain = Promise.resolve(false);

// List all snapshot file names in the dir. Returns NEWLINE-JOINED string
// (Mercury MT JSImport source-gen doesn't support Task<string[]> directly;
// C# splits the joined output on \n). Empty string if dir empty.
globalThis.cuoOpfsSnapshotListJoined = async function() {
  const dir = await _opfsSnapshotsGetDir();
  if (!dir) return '';
  const names = [];
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && name.endsWith('.bin')) names.push(name);
    }
  } catch (e) {
    console.warn('[opfs-snap] list failed:', e?.message ?? e);
  }
  return names.join('\n');
};

// Read a single snapshot file. Returns base64 string of bytes or '' if not
// found. Base64 over Task<byte[]> because JSImport source-gen doesn't
// support Task<byte[]> in Mercury MT.
globalThis.cuoOpfsSnapshotReadB64 = async function(key) {
  const _t0 = performance.now();   // freeze-trap timing (see the write fn note below)
  const dir = await _opfsSnapshotsGetDir();
  if (!dir) return '';
  try {
    const fh = await dir.getFileHandle(key);
    const file = await fh.getFile();
    const buf = new Uint8Array(await file.arrayBuffer());
    // Convert to base64 in chunks to avoid call-stack issues on large buffers.
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    const out = btoa(bin);
    const _ms = performance.now() - _t0;
    if (_ms > 40) console.warn(`[opfs-snap] SLOW read ${_ms | 0}ms ${key} ${(buf.length / 1024) | 0}KB`);
    return out;
  } catch (e) {
    if (e?.name !== 'NotFoundError') {
      console.warn('[opfs-snap] read failed:', key, e?.message ?? e);
    }
    return '';
  }
};

// Write a snapshot file (creates or overwrites). Takes base64 string.
// FREEZE TRAP (operator 2026-07-10 "el navegador se congela aleatoriamente en CUO y mini, en TUO no"):
// these OPFS bridge fns run ON THE MAIN THREAD and the base64 decode below is a synchronous per-byte
// loop over potentially multi-MB snapshots — the prime suspect for the random freezes (the snapshot
// system is CUO/mini-only; TUO has none, matching the pattern exactly). Every call now logs its
// duration+size when it exceeds 40ms, so the black-box tail of the NEXT freeze shows whether a
// snapshot write burst preceded it. Evidence first; the decode rewrite comes after confirmation.
globalThis.cuoOpfsSnapshotWriteB64 = async function(key, b64) {
  // Chained (see _opfsSnapWriteChain note): keeps concurrent writes to the
  // same key in call order so an older payload can never finish last.
  // Stays an async function — Mercury MT JSImport marshalling requires it.
  const run = async () => {
    const _t0 = performance.now();
    const dir = await _opfsSnapshotsGetDir();
    if (!dir) return false;
    try {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const fh = await dir.getFileHandle(key, { create: true });
      const w = await fh.createWritable();
      await w.write(buf);
      await w.close();
      const _ms = performance.now() - _t0;
      if (_ms > 40) console.warn(`[opfs-snap] SLOW write ${_ms | 0}ms ${key} ${(buf.length / 1024) | 0}KB`);
      return true;
    } catch (e) {
      console.warn('[opfs-snap] write failed:', key, e?.message ?? e);
      return false;
    }
  };
  _opfsSnapWriteChain = _opfsSnapWriteChain.then(run, run);
  return await _opfsSnapWriteChain;
};

globalThis.cuoOpfsSnapshotDelete = async function(key) {
  const dir = await _opfsSnapshotsGetDir();
  if (!dir) return false;
  try {
    await dir.removeEntry(key);
    return true;
  } catch (e) {
    return false;
  }
};

// ⚠️ THE SCREENSHOT RING-BUFFER IS GONE. Upstream keeps the last five captures in OPFS so the
// portal can offer a "publish from your profile" flow. There is no portal here, so those files were
// written where nothing could ever display them — spending the player's storage quota on images
// only a developer could find. The Screenshot button now hands the PNG straight to the browser's
// downloads and keeps no copy (operator, 2026-08-27).
//
// Anything left in cuo-screenshots from an older build is orphaned rather than cleaned up: this
// build never opens that directory again, and Manage storage clears the origin wholesale.

// Encode `{ etag, bytes }` into a single Uint8Array with a 4-byte LE
// header carrying the etag length, followed by the UTF-8 etag bytes,
// then the raw payload. Reverse in opfsDecode.
function opfsEncode(etag, bytes) {
  const etagBuf = new TextEncoder().encode(etag ?? '');
  const out = new Uint8Array(4 + etagBuf.length + bytes.length);
  new DataView(out.buffer).setUint32(0, etagBuf.length, true);
  out.set(etagBuf, 4);
  out.set(bytes, 4 + etagBuf.length);
  return out;
}
function opfsDecode(buf) {
  if (buf.length < 4) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, 4);
  const etagLen = dv.getUint32(0, true);
  if (buf.length < 4 + etagLen) return null;
  const etag = new TextDecoder().decode(buf.subarray(4, 4 + etagLen));
  const bytes = buf.subarray(4 + etagLen);
  return { etag, bytes };
}

async function openCache() {
  try {
    if (navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
      // Probe write — some browsers expose getDirectory() but reject
      // writes inside private/incognito or storage-pressure scenarios.
      const probe = await dir.getFileHandle('.probe', { create: true });
      const w = await probe.createWritable();
      await w.write(new Uint8Array([1, 2, 3]));
      await w.close();
      await dir.removeEntry('.probe').catch(() => {});
      console.log('[loader] asset cache: OPFS');
      return { type: 'opfs', dir };
    }
  } catch (e) {
    console.warn('[loader] OPFS unavailable, falling back to IndexedDB:', e?.message ?? e);
  }
  // Fallback to IDB.
  try {
    const db = await new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    console.log('[loader] asset cache: IndexedDB');
    return { type: 'idb', db };
  } catch (e) {
    console.warn('[loader] no asset cache available:', e);
    return null;
  }
}

// "Name is not allowed" because the API treats the slash as path
// traversal and wants nested directories instead. Some REQUIRED_FILES
// entries (e.g. Music/Digital/Config.txt) include subpaths, so we
// flatten them by replacing '/' with '__'. The IDB code path is
// unaffected — IDB keys are arbitrary strings.
function opfsKey(key) {
  return key.replace(/\//g, '__');
}

async function cacheGet(cache, key) {
  if (!cache) return null;
  if (cache.type === 'opfs') {
    try {
      const fh = await cache.dir.getFileHandle(opfsKey(key));
      const file = await fh.getFile();
      return opfsDecode(new Uint8Array(await file.arrayBuffer()));
    } catch {
      return null;  // not found
    }
  }
  // IDB
  return new Promise((resolve, reject) => {
    const tx = cache.db.transaction(DB_STORE, 'readonly');
    const r = tx.objectStore(DB_STORE).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror   = () => reject(r.error);
  });
}

// Set when the origin's storage quota rejected an asset write. Purely an optimisation
// gate: reads still hit whatever is already cached, and a miss just refetches.
let _assetCacheWritesOff = false;

async function cachePut(cache, key, value) {
  if (!cache) return;
  if (cache.type === 'opfs') {
    const fh = await cache.dir.getFileHandle(opfsKey(key), { create: true });
    const w = await fh.createWritable();
    await w.write(opfsEncode(value.etag, value.bytes));
    await w.close();
    return;
  }
  // IDB
  return new Promise((resolve, reject) => {
    const tx = cache.db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function cacheClear(cache) {
  if (!cache) return;
  if (cache.type === 'opfs') {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(OPFS_DIR, { recursive: true }).catch(() => {});
    return;
  }
  return new Promise((r) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    // `blocked` fires instead of `success` when another tab of the same origin still
    // holds the database open -- the normal case, since players keep the portal open
    // next to the game. Without settling on it too, this promise never resolves and
    // the boot hangs for good.
    req.onsuccess = req.onerror = req.onblocked = () => r();
  });
}

// --- Cache integrity audit + auto-repair (v0.8.91) ------------------
// Evidence trail (operator, 2026-06-12): random statics render as solid
// MAGENTA rectangles / go missing, persisting across reloads, only on
// machines with an old OPFS cache. The v0.8.89 engine telemetry ruled
// out catchup starvation (pendingAfter=0 always) and snapshot poisoning
// (snapSUSPECT=0). Remaining suspect: raw gamefile bytes (art.mul etc.)
// cached BEFORE the SHA-256 download verification existed — the cache
// fast-path (etag+bytes hit) returns them forever without re-hashing.
// This audit re-hashes every cached file against the shard's /hashes
// map in the background (~20 s after the LoginGump, throttled with
// yields), logs any mismatch as [cache-audit] MISMATCH, and AUTO-REPAIRS
// by re-downloading the verified bytes and overwriting the poisoned
// entry. The running session keeps its already-mounted bytes — the
// repair takes effect on the next boot. Runs once per session.
// v0.9.630 — the audit READS AND HASHES in a worker, so its 1.4 GB never touch the main
// thread's heap.
//
// Measured on a 2017 i5-7300U (CPU throttled 4x, 12 files / 900 MiB of the real cache):
//   read+hash on MAIN   : worst main-thread stall 2639 ms, 9 stalls >300 ms, 23.9 s total
//   read+hash in WORKER : worst main-thread stall  235 ms, 0 stalls >300 ms, 17.7 s total
// The 2639 ms matches the 2561 ms worst frame measured while running through Britain with
// the audit live — same thing, reached by two independent paths. A/B with the audit off:
// worst frame 2561 -> 103 ms, spikes >300 ms 14 -> 0.
//
// WHAT IT IS NOT: `crypto.subtle.digest` is async and blocks the main thread 0 ms; moving
// only the hash to a worker was tried, measured and REVERTED (it fixed nothing and added
// ~44 ms of transfer). And a single read is only ~21 ms. The cost is the ACCUMULATION:
// 1.4 GB of 100-185 MiB buffers allocated and dropped in sequence forces major GC pauses,
// and under Mercury MT every proxied-to-main call from the deputy stalls behind them —
// which is why this surfaced as `upd` spikes rather than as slow JS.
//
// The line below used to claim the 25 ms yield stopped the jank. It never could: the yield
// sits BETWEEN files while the pressure builds ACROSS them.
//
// The guarantee is UNCHANGED: same files, same SHA-256 (verified byte-identical against the
// main-thread hash, 5/5 over 300 MiB), same comparison, same repair. Only WHERE the bytes
// are read and hashed changed. Falls back to the main thread if the worker cannot start.
// v0.9.631: the worker is a FILE (lib/audit-worker.mjs), not a blob.
//
// v0.9.630 built it with URL.createObjectURL(new Blob([...])) and it was DEAD ON ARRIVAL
// in production: index.html carries a meta CSP whose `default-src 'self'` (no worker-src,
// no child-src to fall back to) does not allow blob:, so the worker was blocked before
// running a line and every session silently took the main-thread fallback. The failure is
// invisible by nature — worker.onerror fires with message/filename/lineno ALL NULL, which
// reads like a mystery instead of a policy decision.
//
// Two things made this avoidable and both were already in this file: the meta CSP is in
// index.html (checking only the nginx headers, which carry just frame-ancestors, says
// nothing), and js-poll-worker.mjs below already resolves its worker with
// `new URL('./lib/...', import.meta.url)` under a comment that names "a CSP block" as one
// of the failed attempts. Same-origin satisfies 'self'; the CSP needs no relaxing.

// Hash every cached key in a worker. Resolves to Map(key -> {hex,len}), or null when the
// worker is unavailable, so the caller can fall back to the (slower) main-thread path.
function _auditHashInWorker(keys) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL('./lib/audit-worker.mjs', import.meta.url),
                          { type: 'module' });
    } catch (e) {
      console.warn('[cache-audit] no worker available, auditing on main:', e?.message ?? e);
      return resolve(null);
    }
    const done = (v) => { try { worker.terminate(); } catch {} resolve(v); };
    worker.onerror = (e) => {
      console.warn('[cache-audit] worker error, auditing on main:', e?.message ?? e);
      done(null);
    };
    worker.onmessage = (e) => {
      if (e.data.fatal) {
        console.warn('[cache-audit] worker failed, auditing on main:', e.data.fatal);
        return done(null);
      }
      done(new Map(e.data.done.map(([k, h, len]) => [k, { hex: h, len }])));
    };
    worker.postMessage({ dirName: OPFS_DIR, keys });
  });
}

async function auditCachedGamefiles() {
  try {
    if (window.__cacheAuditRan) return;
    window.__cacheAuditRan = true;
    const hashes = (expectedRawHashes && typeof expectedRawHashes === 'object'
                    && Object.keys(expectedRawHashes).length > 0) ? expectedRawHashes : null;
    if (!hashes) { console.log('[cache-audit] no raw-hash map for this shard — skip'); return; }
    const cache = await openCache();
    if (!cache) return;
    const base = (window.__chosenGamefilesUrlBase || 'gamefiles');
    const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    let okN = 0, notCached = 0, noRef = 0;
    const bad = [];

    // Files this shard actually publishes a reference hash for.
    const targets = [];
    for (const [src] of REQUIRED_FILES) {
      const want = hashes[src.toLowerCase()];
      if (!want) { noRef++; continue; }
      targets.push({ src, want: String(want).toLowerCase() });
    }

    // Fast path: the worker reads + hashes straight out of OPFS, so none of the 1.4 GB
    // is ever allocated on the main thread. Only for the OPFS backend — the worker has
    // no access to the IndexedDB fallback's records.
    let fromWorker = null;
    if (cache.type === 'opfs' && targets.length) {
      fromWorker = await _auditHashInWorker(targets.map((t) => opfsKey(`${base}/${t.src}`)));
    }

    if (fromWorker) {
      for (const t of targets) {
        const r = fromWorker.get(opfsKey(`${base}/${t.src}`));
        if (!r || !r.hex) { notCached++; continue; }
        if (r.hex === t.want) okN++;
        else {
          bad.push(t.src);
          console.error(`[cache-audit] MISMATCH ${t.src}: cached=${r.hex.slice(0, 12)} want=${t.want.slice(0, 12)} (${(r.len / 1048576).toFixed(1)} MB)`);
        }
      }
    } else {
      // Fallback: IndexedDB backend, or the worker could not start. Same checks on the
      // main thread — slower and janky, but the audit still runs rather than silently
      // not happening, which would leave corrupt gamefiles undetected.
      for (const t of targets) {
        let entry = null;
        try { entry = await cacheGet(cache, `${base}/${t.src}`); } catch { entry = null; }
        if (!entry || !entry.bytes) { notCached++; continue; }
        const got = hex(await crypto.subtle.digest('SHA-256', entry.bytes));
        if (got === t.want) okN++;
        else {
          bad.push(t.src);
          console.error(`[cache-audit] MISMATCH ${t.src}: cached=${got.slice(0, 12)} want=${t.want.slice(0, 12)} (${(entry.bytes.length / 1048576).toFixed(1)} MB)`);
        }
        // Yield between files. This never prevented the jank on its own (the pressure
        // builds ACROSS files, not within one) — it only paces the reads.
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    console.log(`[cache-audit] done: ok=${okN} corrupt=${bad.length} notCached=${notCached} noRefHash=${noRef}`);
    for (const src of bad) {
      try {
        const rw = window.__rewriteGamefileUrl;
        if (typeof rw !== 'function') break;
        const url = rw(src.toLowerCase());
        if (!url) { console.warn(`[cache-audit] no URL for ${src} — cannot repair`); continue; }
        const r = await fetch(url, { cache: 'reload' });
        if (!r.ok) { console.warn(`[cache-audit] repair fetch HTTP ${r.status} for ${src}`); continue; }
        const bytes = new Uint8Array(await r.arrayBuffer());
        const got = hex(await crypto.subtle.digest('SHA-256', bytes));
        if (got !== String(hashes[src.toLowerCase()]).toLowerCase()) {
          console.error(`[cache-audit] repair download ALSO mismatched for ${src} — server-side issue, NOT repairing`);
          continue;
        }
        const etag = r.headers.get('ETag') || `"sha256-${got.slice(0, 16)}"`;
        await cachePut(cache, `${base}/${src}`, { etag, bytes });
        console.log(`[cache-audit] REPAIRED ${src} (${(bytes.length / 1048576).toFixed(1)} MB) — clean bytes will load on the next boot`);
      } catch (e) {
        console.warn(`[cache-audit] repair failed ${src}:`, e?.message ?? e);
      }
    }
    if (bad.length) {
      try {
        localStorage.setItem('uo-cache-audit', JSON.stringify({ when: new Date().toISOString(), corrupt: bad }));
      } catch {}
      console.error(`[cache-audit] ${bad.length} corrupt cached file(s) found+repaired: ${bad.join(', ')} — RELOAD to boot from clean bytes`);
    }
  } catch (e) {
    console.warn('[cache-audit] failed:', e?.message ?? e);
  }
}
window.__auditCachedGamefiles = auditCachedGamefiles;   // manual trigger from DevTools
window.addEventListener('cuo:login-gump-added', () => { setTimeout(auditCachedGamefiles, 20000); }, { once: true });

// MEMORY HEADROOM AT A SUCCESSFUL BOOT — the missing half of "que funcione en PCs antiguos".
//
// The black box already records jsHeap on a crash, which covers the machine that FAILS. It
// says nothing about the one that succeeds with nothing to spare, and that is the case the
// decision needs: measured here on a healthy desktop the tab sits at ~3.5 GB against a
// 4 GB per-tab limit — 86 % — with the fixed 2 GiB wasm heap inside it. If a weaker machine
// gets a SMALLER limit (Chrome scales it with system RAM), the client cannot run there no
// matter what the wasm heap is set to, and lowering UoWasmMemBytes would be the wrong lever
// entirely. That is a decision to make on numbers from real machines, not on one desktop.
//
// One console line, so it lands in the black-box buffer that a later [crash-report] prints.
// NOT sent anywhere: no endpoint, no telemetry, nothing leaves the browser. performance.memory
// is Chrome-only and deliberately coarse — treat it as an order of magnitude, never a
// measurement, which is exactly why this records it rather than acting on it.
window.addEventListener('cuo:login-gump-added', () => {
  try {
    const m = performance.memory;
    if (!m) { console.log('[mem] boot ok — no performance.memory on this browser'); return; }
    const mb = (b) => (b / 1048576) | 0;
    const used = mb(m.usedJSHeapSize), limit = mb(m.jsHeapSizeLimit);
    console.log(`[mem] boot ok — used=${used}MB limit=${limit}MB headroom=${limit - used}MB`
      + ` (${limit ? Math.round((used / limit) * 100) : 0}% of the tab budget)`);
  } catch { /* a diagnostic must never be the reason a boot is spoiled */ }
}, { once: true });

// ── Per-shard cache enumeration (avatar-dropdown Storage Management) ──────
// Cached gamefiles are keyed `<base>/<src>` (base = the shard's
// gamefilesUrlBase). OPFS flattens that to `<base>__<src>` (opfsKey: '/'→'__');
// IDB keeps the raw `<base>/<src>` key. A base is strictly [a-z0-9-] (no '__',
// no '/'), so the FIRST separator unambiguously splits base from the rest —
// letting us group, size and delete per shard with no risk of matching the
// wrong shard. Returns { total, shards: [{ base, files, bytes }] } desc by bytes.
async function cacheUsageByShard(cache) {
  const map = new Map();
  const add = (base, bytes) => {
    const e = map.get(base) || { files: 0, bytes: 0 };
    e.files++; e.bytes += bytes; map.set(base, e);
  };
  if (cache && cache.type === 'opfs') {
    for await (const [name, handle] of cache.dir.entries()) {
      if (handle.kind !== 'file' || name.startsWith('.')) continue;
      const sep = name.indexOf('__');
      const base = sep > 0 ? name.slice(0, sep) : name;
      let size = 0;
      try { size = (await handle.getFile()).size; } catch { /* unreadable — skip size */ }
      add(base, size);
    }
  } else if (cache && cache.type === 'idb') {
    const rows = await new Promise((resolve) => {
      const out = [];
      const tx = cache.db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(out); return; }
        const v = cur.value;
        out.push([String(cur.key), (v && v.bytes && v.bytes.length) ? v.bytes.length : 0]);
        cur.continue();
      };
      req.onerror = () => resolve(out);
    });
    for (const [k, bytes] of rows) {
      const sep = k.indexOf('/');
      add(sep > 0 ? k.slice(0, sep) : k, bytes);
    }
  }
  let total = 0;
  const shards = [];
  for (const [base, e] of map) { total += e.bytes; shards.push({ base, files: e.files, bytes: e.bytes }); }
  shards.sort((a, b) => b.bytes - a.bytes);
  return { total, shards };
}

// Delete every cached entry for ONE shard base. Exact prefix match (`base` or
// `base` + separator) so a base can never collide with another. Returns count.
async function cacheDeleteShard(cache, base) {
  if (!cache || !base) return 0;
  let removed = 0;
  if (cache.type === 'opfs') {
    const prefix = base + '__';
    const names = [];
    for await (const [name, handle] of cache.dir.entries()) {
      if (handle.kind === 'file' && (name === base || name.startsWith(prefix))) names.push(name);
    }
    for (const name of names) {
      try { await cache.dir.removeEntry(name); removed++; } catch { /* skip */ }
    }
  } else if (cache.type === 'idb') {
    const prefix = base + '/';
    await new Promise((resolve) => {
      const tx = cache.db.transaction(DB_STORE, 'readwrite');
      const req = tx.objectStore(DB_STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const k = String(cur.key);
        if (k === base || k.startsWith(prefix)) { cur.delete(); removed++; }
        cur.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
  return removed;
}

// --- Per-file fetch with cache revalidation -----------------------

// SHA-256 → lowercase hex. Used for cold-load integrity verification of a
// freshly-downloaded gamefile against the server's raw-content hash (the
// asset-worker .br.sha256/.nowin sidecars, exposed via /api/servers/<slug>/
// hashes). crypto.subtle is only present in a secure context (HTTPS) — the
// caller guards on it so a plain-HTTP LAN load just skips verification.
async function sha256Hex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
  return hex;
}

// Cap for the warm-cache integrity guard (see the fast path below): only re-hash a
// cached file ≤ this size on a hit. Covers the crash-prone compressed loaders
// (string_dictionary.uop ~228 KB, tileart, tiledata, cliloc, .idx/.def) while skipping
// the multi-MB art/anim .mul so warm boots stay fast (crypto.subtle digest is fast, but
// reading + hashing every giant file each boot is needless when corruption there is rare
// and still caught by the crash→recovery path).
const WARM_VERIFY_MAX = 8 * 1024 * 1024;
async function fetchFileCached(cache, src) {
  // base so two shards with different bytes for the same filename
  // (`art.mul`, `map0.mul`, etc) don't collide. Pre-fix, the cache key
  // was just `src`, and switching from shard A to shard B served A's
  const cacheBase = (window.__chosenGamefilesUrlBase || 'gamefiles');
  const cacheKey = `${cacheBase}/${src}`;
  let cached = null;
  // On a corrupt-asset RECOVERY boot, do NOT read the cache for the file being recovered —
  // the cached copy IS the corrupt one. Skipping the read forces a fresh (cache-busted via
  // rewriteGamefileUrl) re-fetch whose bytes then overwrite the bad entry — healing it
  // uniformly across the OPFS and IDB backends with no racy per-key delete in the recovery
  // path (operator 2026-06-18: re-download just that one file).
  const _skipCache = _recoverFile && src && String(src).toLowerCase() === _recoverFile;
  if (cache && !_skipCache) {
    try { cached = await cacheGet(cache, cacheKey); } catch { cached = null; }
  }

  // Fast path: if we have both an etag and bytes cached, skip the network
  // entirely. `npx serve` + the gamefiles junction don't honor
  // If-None-Match cleanly — the request aborts (ERR_ABORTED, ~70 ms each
  // × 28 files = ~2 s of boot latency) and we fall back to cached bytes
  // anyway. Trade-off: stale .mul on the server won't be picked up until
  if (cached?.etag && cached?.bytes) {
    // Warm-cache integrity guard (operator 2026-06-18): a file cached CORRUPT by an
    // earlier bug — e.g. the manifest-gate fallback that fetched the 403 raw-path error
    // page — would otherwise be served from the warm cache forever (the fetch-path verify
    // below never runs on a hit), crashing the engine with "CRC mismatch" on every boot,
    // even after the server side was fixed. So when we have an expected raw hash AND the
    // file is small enough to hash cheaply, verify the CACHED bytes too; on mismatch, drop
    // the poisoned entry and fall through to a fresh (content-addressed pool) re-fetch,
    // whose cachePut overwrites it. Bounded by WARM_VERIFY_MAX so warm boots stay fast
    // (the crash-causing loaders — string_dictionary.uop etc. — are all small).
    const _lc = src.toLowerCase();
    const expWarm = (expectedRawHashes && typeof expectedRawHashes === 'object') ? expectedRawHashes[_lc] : undefined;
    if (expWarm && cached.bytes.length <= WARM_VERIFY_MAX && typeof crypto !== 'undefined' && crypto.subtle) {
      try {
        const actualWarm = await sha256Hex(cached.bytes);
        if (actualWarm !== expWarm) {
          console.warn(`[loader] cached ${src} failed its integrity check (${actualWarm.slice(0, 8)} != ${expWarm.slice(0, 8)}) — dropping the poisoned copy + re-fetching fresh`);
          cached = null; // fall through to the fetch path; its cachePut overwrites the bad entry
        }
      } catch { /* hashing unavailable → trust the cache (pre-existing behaviour) */ }
    }
    if (cached) return { bytes: cached.bytes, fromCache: true };
  }

  // cold vs. server-changed bytes.
  let _cacheMissReason;
  if (!cached) _cacheMissReason = 'noEntry';
  else if (!cached.etag) _cacheMissReason = 'noEtag';
  else if (!cached.bytes) _cacheMissReason = 'noBytes';

  const headers = {};
  if (cached?.etag) headers['If-None-Match'] = cached.etag;

  // Case-insensitive fallback. Bidirectional defense in depth:
  //
  //   - Legacy: REQUIRED_FILES used Windows-style mixed-case names
  //     ("Texmaps.mul"); v0.3.19+ flipped this to all-lowercase end-
  //     to-end. So `src` ALMOST ALWAYS arrives lowercase already.
  //   - Server-side contract (v0.3.19+): operator runs gamefiles-
  //     lowercase.sh apply (or asset-worker.mjs's lowercaseGamefiles
  //     Tree auto-runs the same logic at every tick) so the disk
  //     matches. With both ends lowercase, the first fetch succeeds.
  //   - Defense in depth (v0.5.1): if the disk somehow has mixed-case
  //     (operator uploaded a fresh shard, brotli-worker tick hasn't
  //     fired yet), try Title-Case as fallback so the client still
  //     boots instead of crashing on `cliloc.enu` 404.
  //
  // Builds up to 3 candidates (often 1 when src is already lowercase
  // AND disk is lowercase — fast path costs nothing):
  //   [0] src verbatim
  //   [1] lower(src) — if different from [0]
  //   [2] Title-Case(lower(src)) — if different from both, e.g.
  //       "cliloc.enu" → "Cliloc.enu". Conservative single-word cap;
  //       multi-word names like "MainMisc.uop" are NOT generated, the
  //       brotli-worker's lowercase pass handles those forward.
  const lower = src.toLowerCase();
  const titleCase = lower.replace(/^([a-z])/, (m) => m.toUpperCase());
  const candidates = [src];
  if (lower !== src) candidates.push(lower);
  if (titleCase !== src && titleCase !== lower) candidates.push(titleCase);

  let res = null;
  let netErr = null;
  for (const candidate of candidates) {
    try {
      // cache: 'default' lets the browser HTTP cache participate.
      // (24 h browser TTL, configured at the CF cache rule level), so:
      //   - cuo-assets IDB hit → fast-path returns above, no fetch
      //   - IDB miss + browser cache hit (within 24 h) → fetch
      //     resolves from disk, no network round-trip
      //   - IDB miss + browser cache miss → fetch hits CF (HIT for
      //     edge-cached files, otherwise origin pull)
      // those bugs don't apply — and 'default' lets us reclaim a free
      // ~1-3 s on cold-IDB-but-warm-browser-cache scenarios (e.g.
      // the HTTP cache).
      // is loaded. window.__rewriteGamefileUrl returns either the legacy
      // gamefiles/<name> path (when manifest is empty or doesn't list the
      // file) or the content-addressed pool URL gamefiles/pool/<hash>.<ext>.br
      const rewriteFn = window.__rewriteGamefileUrl;
      // the rewriter's new contract.
      const targetUrl = typeof rewriteFn === 'function' ? rewriteFn(candidate) : `/gamefiles/${candidate}`;
      // is non-empty and the file isn't listed — file is known to
      // not exist for this shard, skip without a network round-trip.
      if (targetUrl === null) {
        netErr = new Error(`not in shard manifest`);
        continue;
      }
      // v0.4.92: when Chrome's HTTP disk-cache write fails (disk full,
      // antivirus lock, AppData ACL issue) fetch() rejects with
      // TypeError("Failed to fetch") + an ERR_CACHE_WRITE_FAILURE in the
      // network panel — even though the response was 200 OK with bytes
      // in memory. Retry once with cache: 'no-store' so the response
      // bypasses the HTTP cache entirely. The IDB/OPFS layer below is
      // our authoritative cache anyway; the HTTP cache is just a free
      // 1-3 s on cold-IDB-warm-browser-cache scenarios, not load-bearing.
      let r;
      try {
        r = await fetch(targetUrl, { headers, cache: 'default' });
      } catch (cacheErr) {
        console.warn(`[loader] http-cache retry (no-store): ${candidate} — ${cacheErr?.message ?? cacheErr}`);
        r = await fetch(targetUrl, { headers, cache: 'no-store' });
      }
      // Pool 404 → fall through to legacy path (covers the partial-rollout
      // case where the manifest was published but a particular blob hasn't
      // leading-slash form and the legacy no-slash form for
      // back-compat with any caller that still emits the old shape.
      if (r.status === 404 && (targetUrl.startsWith('/gamefiles/pool/') || targetUrl.startsWith('gamefiles/pool/'))) {
        let legacy;
        try {
          legacy = await fetch(`/gamefiles/${candidate}`, { headers, cache: 'default' });
        } catch (cacheErr) {
          console.warn(`[loader] http-cache retry legacy (no-store): ${candidate} — ${cacheErr?.message ?? cacheErr}`);
          legacy = await fetch(`/gamefiles/${candidate}`, { headers, cache: 'no-store' });
        }
        if (legacy.ok || legacy.status === 304) r = legacy;
      }
      // v0.8.43 self-service fallback: an owner-hosted shard serves gamefiles
      // UNCOMPRESSED by name (no .br needed). But if they DID compress, fall
      // back to `<url>.br` on a 404 — the browser auto-decompresses when their
      // host sends `Content-Encoding: br` (and the SHA-256 check below still
      // validates the decompressed bytes). Only fires for the external base.
      const extBase = window.__chosenExternalGamefilesUrl;
      if (r.status === 404 && extBase && targetUrl.indexOf(extBase) === 0 && !targetUrl.endsWith('.br')) {
        try {
          const br = await fetch(`${targetUrl}.br`, { headers, cache: 'default' });
          if (br.ok || br.status === 304) r = br;
        } catch (e) { /* keep the 404 */ }
      }
      if (r.ok || r.status === 304) { res = r; break; }
      // Non-OK: keep the last response so we can return its status if every
      // candidate fails.
      res = r;
    } catch (e) {
      netErr = e;
    }
  }

  if (!res) {
    // Pure network failure across all candidates.
    if (cached?.bytes) return { bytes: cached.bytes, fromCache: true };
    throw netErr ?? new Error(`fetch failed for ${src}`);
  }

  if (res.status === 304 && cached?.bytes) {
    // (no payload transferred, just a header round-trip).
    return { bytes: cached.bytes, fromCache: true };
  }
  if (!res.ok) {
    // Transient server errors (5xx / 408 / 425 / 429) MUST be retried, not
    // skipped. The /server-N/ gamefile gate (nginx auth_request → proxy) can
    // momentarily 500 a handful of files under the cold-load concurrent burst
    // (95 files @ MAX_INFLIGHT). The old code threw immediately → the worker
    // marked the file skipped; when a CRITICAL file (e.g. map0.mul) was hit,
    // CUO crashed at boot (GameController.LoadContent NRE on the missing map).
    // Mirror the body-read retry below + the /api/servers 5xx retry: re-fetch
    // the same URL with exponential backoff before giving up. (403/404 are
    // deterministic — never retried.)
    const transient = res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429;
    if (transient) {
      const retryUrl = res.url || src;
      for (let attempt = 0; attempt < 4 && !res.ok; attempt++) {
        const backoff = 300 * Math.pow(2, attempt); // 300, 600, 1200, 2400 ms
        console.warn(`[loader] http ${res.status} retry ${attempt + 1}/4 for ${src} in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        try { res = await fetch(retryUrl, { cache: 'reload' }); }
        catch (e) { /* keep last res; loop continues until attempts exhausted */ }
      }
    }
    if (!res.ok) {
      if (cached?.bytes) return { bytes: cached.bytes, fromCache: true };
      throw new Error(`HTTP ${res.status} for ${src}`);
    }
  }

  // changed (or first request had no etag). Promote the existing
  // miss reason to net200 so the diagnostic distinguishes "cache
  // was valid but server moved on" from "cache had nothing to send".
  if (cached?.etag && headers['If-None-Match']) {
    _cacheMissReason = 'net200';
  }

  // HTTP/2 stream errors (ERR_HTTP2_PROTOCOL_ERROR) frequently strike DURING
  // the body transfer of large gamefiles: fetch() resolves (status 200/206,
  // headers already arrived) but res.arrayBuffer() rejects mid-stream. The
  // old code did NOT retry that path — a single transient mid-download error
  // failed the whole file and could stall the entire boot (operator-reported
  // "a veces no carga", with 206/200 + ERR_HTTP2_PROTOCOL_ERROR in console).
  // Retry the body read by re-fetching the same URL with exponential backoff;
  // cache:'reload' + no If-None-Match forces a fresh full 200 (never a 304 or
  // a partial) so arrayBuffer() can complete. Falls back to cached bytes if
  // every attempt fails. The fast cached path + the fetch() header-phase retry
  // (cache:'no-store', above) are unchanged.
  let bytes = null;
  {
    let bodyErr = null;
    const reloadUrl = res.url;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // Stream the body so the per-file download panel can report live
        // MB/s. Falls back to arrayBuffer() internally when res.body isn't a
        // readable stream. (A retry re-streams the fresh response below.)
        bytes = await _readBodyWithProgress(res, src);
        bodyErr = null;
        break;
      } catch (e) {
        bodyErr = e;
        const backoff = 250 * Math.pow(2, attempt); // 250, 500, 1000, 2000 ms
        console.warn(`[loader] body-read retry ${attempt + 1}/4 for ${src} in ${backoff}ms — ${e?.message ?? e}`);
        await new Promise((r) => setTimeout(r, backoff));
        try {
          res = await fetch(reloadUrl, { cache: 'reload' });
          if (!res.ok) { bodyErr = new Error(`HTTP ${res.status} on body retry`); continue; }
        } catch (refetchErr) {
          bodyErr = refetchErr; // keep looping until attempts exhausted
        }
      }
    }
    if (bytes === null) {
      if (cached?.bytes) return { bytes: cached.bytes, fromCache: true };
      throw bodyErr ?? new Error(`body read failed for ${src}`);
    }
  }

  // Cold-load integrity verification (operator req 2026-06-09). On a heavy
  // shard (Ultima Adventures) a file occasionally lands corrupt/truncated even
  // after the 5xx + body-read retries above (200 OK, full arrayBuffer(), wrong
  // bytes), the bad copy gets cached, and the world shows missing/garbled
  // statics until the operator reopens the browser. expectedRawHashes[name] is
  // the SHA-256 of the RAW file (asset-worker sidecars via /api/servers/<slug>/
  // hashes); the browser hands us the Content-Encoding:br auto-decompressed RAW
  // bytes, so the hashes must match. On mismatch: re-download once
  // (cache:'reload') + re-check; a second mismatch THROWS so fetchAll treats it
  // as a genuine failure (no silent skip → no incomplete world). Only large
  // EXT_MATCH files (.mul/.uop/.def/.txt) have sidecars; others are absent from
  // the map and skip verification. Verify on this cache-MISS path only — warm
  // OPFS hits returned far above, so there is no per-boot re-hash cost.
  const expectedHash = (expectedRawHashes && typeof expectedRawHashes === 'object')
    ? expectedRawHashes[lower] : undefined;
  if (expectedHash && typeof crypto !== 'undefined' && crypto.subtle) {
    let actual = await sha256Hex(bytes);
    if (actual !== expectedHash) {
      console.warn(`[loader] integrity MISMATCH ${src}: got ${actual.slice(0, 8)} want ${expectedHash.slice(0, 8)} — re-downloading (cache-busted)`);
      try {
        // Cache-BUST the re-download so Cloudflare treats it as a NEW URL and
        // re-fetches from ORIGIN. `cache:'reload'` alone only bypasses the BROWSER
        // cache — a truncated/garbled copy cached at the CDN EDGE (the real failure
        // mode after a full-zone purge floods the edge with cold misses) would be
        // handed back unchanged, the re-check would mismatch again, and the
        // fail-safe below would feed the bad bytes to the engine → the "CRC
        // mismatch" boot crash. The pool is content-addressed + immutable, so origin
        // always holds the correct bytes — the only thing wrong is a stale edge copy.
        const reUrl0 = res.url || `/${cacheBase}/${src}`;
        const reUrl = reUrl0 + (reUrl0.includes('?') ? '&' : '?') + '__cb=' + Date.now();
        const rr = await fetch(reUrl, { cache: 'reload' });
        if (rr.ok) {
          const rb = new Uint8Array(await rr.arrayBuffer());
          const reActual = await sha256Hex(rb);
          if (reActual === expectedHash) { bytes = rb; actual = reActual; }
        }
      } catch (e) {
        console.warn(`[loader] integrity re-download failed ${src}: ${e?.message ?? e}`);
      }
      if (actual !== expectedHash) {
        // Fail-SAFE (do NOT throw/drop the file). The re-download still didn't
        // match. Throwing here would drop the file (→ fetchAll genuine-fail);
        // if the hash source were ever SYSTEMATICALLY wrong (a stale /hashes
        // snapshot vs a freshly re-baked .br, an nginx encoding edge, etc.)
        // EVERY file would mismatch → the whole boot bricks. That blast radius
        // is unacceptable for a verify path that fails-closed by default. So we
        // accept the bytes + LOG: a single truly-corrupt file is rare and the
        // re-download already gave it a second chance; using the bytes is
        // strictly safer than bricking and still strictly better than the
        // pre-Part-2 path (which used bad bytes with no warning at all).
        console.warn(`[loader] integrity STILL mismatched after re-download ${src} (got ${actual.slice(0, 8)}, want ${expectedHash.slice(0, 8)}) — using bytes anyway`);
      } else {
        console.log(`[loader] integrity recovered ${src} on re-download`);
      }
    }
  }

  const etag = res.headers.get('ETag');
  if (cache && etag) {
    // Fire-and-forget cache persistence — return bytes to the caller
    // serialised cache writes for a 1.4 GB cold-cache load.
    //
    // queue), so 16 fetch workers can write concurrently with no
    // serialisation. On the IDB fallback path Chrome still serialises
    // — fire-and-forget keeps both backends off the critical path.
    //
    // If a write fails, we log and lose the cache entry for this src;
    // next visit refetches from network.
    if (!_assetCacheWritesOff) {
      cachePut(cache, cacheKey, { etag, bytes }).catch((e) => {
        const msg = String(e?.name || e?.message || e);
        console.warn(`[loader] cache write failed for ${cacheKey}:`, e?.message ?? e);
        // Out of origin storage: every remaining write will fail the same way, and each
        // one still encodes the payload first. Measured 2026-07-26 with a full client +
        // an embedded minigame in one tab (1748 MiB + 571 MiB of filesets): 8 identical
        // quota failures in one boot. Stop writing; the download itself is unaffected
        // (bytes go straight to MEMFS) and the next visit simply refetches.
        if (/quota/i.test(msg)) {
          _assetCacheWritesOff = true;
          console.warn('[loader] origin storage is full — asset cache writes disabled for this session (downloads unaffected)');
        }
      });
    }
  }
  return { bytes, fromCache: false, cacheMissReason: _cacheMissReason };
}

// UltimaLive ultra-customized shards ship extra full .mul map facets beyond the
// standard 0-5 (e.g. Ultima Adventures map33-36 = the "dark continent" + extra
// continents). These are NOT live-streamed — the native client loads them from
// disk, so the web client must fetch them too, and EAGERLY (operator directive
// 2026-06-03: no deferral, the world must be complete from frame 1). Keyed by
// shard slug and fetched ONLY for the selected shard, so other shards never
// 404-spam the skip diagnostic. For each index N we pull map{N}/staidx{N}/
// statics{N}.mul; UltimaLive's ULMapLoader.CheckForShardMapFile then seeds them
// from /uo/ into the shard shadow dir (v0.8.23) so the custom continents render
// on entry instead of falling back to a blank (black) facet.
const SHARD_CUSTOM_MAP_IDS = {
  adventures: [33, 34, 35, 36],
};
function shardCustomMapFiles() {
  const ids = SHARD_CUSTOM_MAP_IDS[window.__chosenServerSlug || ''] || [];
  const files = [];
  for (const n of ids) {
    files.push([`map${n}.mul`,     `map${n}.mul`]);
    files.push([`staidx${n}.mul`,  `staidx${n}.mul`]);
    files.push([`statics${n}.mul`, `statics${n}.mul`]);
  }
  return files;
}

// UO ETERNAL: expose the asset cache so the rail's "Export from cache" can bundle
// the gamefiles already pulled by playing — 100% client-side, zero server load.
window.__uoGamefilesCache = {
  open: openCache,
  fetch: fetchFileCached,
  // REQUIRED_FILES already absorbs shardCustomMapFiles() at boot (dup-guarded push),
  // so concat + dedup by name — otherwise the custom maps get listed twice.
  list: function () {
    var seen = {}, out = [];
    REQUIRED_FILES.concat(shardCustomMapFiles()).forEach(function (e) {
      if (!seen[e[0]]) { seen[e[0]] = 1; out.push(e); }
    });
    return out;
  },
  // Storage Management (avatar-dropdown). Each opens the cache itself so the UI
  // never holds a handle. usageByShard → { total, shards:[{base,files,bytes}] };
  // deleteShard(base) → count removed; clearAll → wipe OPFS dir + IDB fallback.
  usageByShard: async function () {
    let c = null; try { c = await openCache(); } catch { c = null; }
    return cacheUsageByShard(c);
  },
  deleteShard: async function (base) {
    let c = null; try { c = await openCache(); } catch { c = null; }
    return cacheDeleteShard(c, base);
  },
  clearAll: async function () {
    let c = null; try { c = await openCache(); } catch { c = null; }
    await cacheClear(c);
    // cacheClear only nukes the ACTIVE backend; also drop the other so a wipe
    // is total regardless of which backend this browser is using.
    try { if (navigator.storage?.getDirectory) { const r = await navigator.storage.getDirectory(); await r.removeEntry(OPFS_DIR, { recursive: true }).catch(() => {}); } } catch {}
    try { await new Promise((res) => { const req = indexedDB.deleteDatabase(DB_NAME); req.onsuccess = req.onerror = req.onblocked = () => res(); }); } catch {}
  }
};

async function fetchAll() {
  // database) so the next boot fetches fresh .mul bytes. Used when
  // the cache gets corrupt or after a gamefile-tree update where the
  // server-side bytes changed.
  // ── Client data epoch ───────────────────────────────────────────────────────
  // The server-side "everyone reset, now" lever. Before this, forcing every browser
  // to drop local state meant adding a one-shot marker in C#, cold-building all three
  // WASM clients and cutting a release — 27 minutes to reach only what someone thought
  // to mark. Here the server publishes a counter; a browser whose stored value differs
  // applies the scope ONCE and records it, so a bump wipes on the next boot and never
  // again. Failure is silent and non-destructive by design: if the fetch fails we do
  // nothing, because eating a player's macros over a flaky request would be far worse
  // than a reset arriving late.
  try {
    const er = await fetch('/api/client-epoch', { cache: 'no-store', credentials: 'same-origin' });
    if (er.ok) {
      const ep = await er.json();
      const seen = Number(localStorage.getItem('uoClientEpoch') || '0');
      if (Number.isFinite(ep?.n) && ep.n > 0 && ep.n !== seen) {
        console.log(`[epoch] server epoch ${ep.n} (scope=${ep.scope}), this browser had ${seen} — applying`);
        if (ep.scope === 'assets') {
          // ~1.75 GB of re-download for this player. Deliberate, never a default.
          if (navigator.storage?.getDirectory) {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry(OPFS_DIR, { recursive: true }).catch(() => {});
          }
          await new Promise((r) => { const rq = indexedDB.deleteDatabase(DB_NAME); rq.onsuccess = rq.onerror = rq.onblocked = () => r(); });
        } else if (ep.scope === 'config') {
          // /Data wholesale: takes macros, hotkeys, gump layouts and map markers with it.
          await new Promise((r) => { const rq = indexedDB.deleteDatabase('/Data'); rq.onsuccess = rq.onerror = rq.onblocked = () => r(); });
        } else {
          // 'settings' — the cheap one: drop settings.json only, so the client rebuilds
          // it from defaults and keeps everything the player actually authored. Done by
          // deleting the single IDBFS entry rather than the database.
          //
          // Only open /Data if it ALREADY exists: indexedDB.open() creates the database
          // when it does not, which on a first-ever visit would leave an empty one for
          // IDBFS to upgrade around. Nothing to reset there anyway.
          let hasData = true;
          try {
            if (indexedDB.databases) {
              const dbs = await indexedDB.databases();
              hasData = dbs.some((d) => d && d.name === '/Data');
            }
          } catch { hasData = true; }   // no databases() → fall through and open
          if (hasData) await new Promise((r) => {
            const o = indexedDB.open('/Data');
            o.onerror = () => r();
            o.onsuccess = () => {
              try {
                const db2 = o.result;
                if (!db2.objectStoreNames.contains('FILE_DATA')) return r();
                const st = db2.transaction('FILE_DATA', 'readwrite').objectStore('FILE_DATA');
                const ks = st.getAllKeys();
                ks.onerror = () => r();
                ks.onsuccess = () => {
                  const hit = ks.result.find((k) => String(k).endsWith('/settings.json'));
                  if (!hit) return r();
                  const del = db2.transaction('FILE_DATA', 'readwrite').objectStore('FILE_DATA').delete(hit);
                  del.onsuccess = del.onerror = () => r();
                };
              } catch { r(); }
            };
          });
        }
        localStorage.setItem('uoClientEpoch', String(ep.n));
        console.log(`[epoch] applied scope=${ep.scope}; this browser is now at epoch ${ep.n}`);
      }
    }
  } catch (e) {
    console.warn('[epoch] check skipped:', e && e.message ? e.message : e);
  }

  const qs = new URLSearchParams(location.search);
  if (qs.get('nocache') === '1') {
    try {
      if (navigator.storage?.getDirectory) {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(OPFS_DIR, { recursive: true }).catch(() => {});
      }
      // Clear IDB regardless (covers users who were on the IDB code path).
      await new Promise((r) => { const req = indexedDB.deleteDatabase(DB_NAME); req.onsuccess = req.onerror = req.onblocked = () => r(); });
      console.log('[loader] nocache=1 — cleared OPFS + IndexedDB caches');
    } catch {}
  }

  let cache = null;
  try { cache = await openCache(); } catch (e) {
    console.warn('[loader] no asset cache available, fetching uncached:', e);
  }

  // Parallel fetch with concurrency cap.
  //
  // gated the next file. On a cold cache the 98-file / ~600 MiB
  // download took 30-60 s end-to-end at residential bandwidth even
  // though browsers willingly run 6 connections to the same host
  // in parallel. New scheme: keep up to MAX_INFLIGHT requests in
  // flight at once. Cached entries hit the IDB-fast-path inside
  // fetchFileCached and skip network entirely, so the parallelism
  // matters most on the cold-cache (post-publish) boot.
  //
  //   HTTP/1.1 → 6 (Chrome's per-host TCP ceiling)
  //   HTTP/2 / HTTP/3 → 16 (multiplexed; per-connection stream limit
  //                          is ~100 concurrent streams in Chrome)
  // bump from 6 → 16 cuts cold-cache load time by ~60 % when proxied
  // conservative 6 to avoid kernel-queue churn.
  // Override via ?inflight=N for benchmarking.
  let MAX_INFLIGHT = 4;
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    const proto = nav?.nextHopProtocol;
    if (proto === 'h2' || proto === 'h3' || proto === 'h3-29') {
      // v0.8.95: 4 (was 8, was 16) — operator call 2026-06-12: 8-wide
      // cold bursts still saturate the NAS (every gamefile pays the nginx
      // auth_request → proxy JWT verify round-trip plus the cloudflared
      // tunnel's bandwidth-delay product) and the load would visibly wedge
      // on some asset. 4 trades a somewhat slower cold load for never
      // stalling the origin; the 5xx/body-read retries remain as the
      // safety net and ?inflight=N still overrides for benchmarking.
      MAX_INFLIGHT = 4;
    }
    // Legacy / un-pooled shards (empty manifest, e.g. RunUO 2.x like
    // Ultima Memento) serve MONOLITHIC .mul files — anim2-5.mul are
    // 340-520 MB each, brotli'd to tens of MB, and are CF-uncacheable
    // (CDN-Cache-Control: no-store), so a cold visitor pulls every one
    // straight from the NAS origin through the cloudflared tunnel. At
    // MAX_INFLIGHT=16 the tunnel's bandwidth-delay product is swamped by
    // a dozen huge concurrent HTTP/2 streams; cloudflare resets streams
    // mid-body → net::ERR_HTTP2_PROTOCOL_ERROR → the loader wedges at
    // "Loading assets 94/99". Capping concurrency to 4 in legacy mode
    // keeps each big stream alive to completion. Pooled shards keep 16 —
    // their blobs are small and a reset retries one tiny unit, not 500 MB.
    const manifestEmpty = !assetsManifest || Object.keys(assetsManifest).length === 0;
    if (manifestEmpty) {
      MAX_INFLIGHT = Math.min(MAX_INFLIGHT, 4);
    }
    const override = parseInt(qs.get('inflight') ?? '', 10);
    if (Number.isFinite(override) && override >= 1 && override <= 64) {
      MAX_INFLIGHT = override;
    }
    console.log(`[loader] MAX_INFLIGHT=${MAX_INFLIGHT} (proto=${proto ?? 'unknown'} legacy=${manifestEmpty})`);
  } catch { /* keep default 6 */ }

  // ── Background-defer of the giant anim files (big-file legacy shards) ──
  // anim2-5.mul are 340-520 MB raw each (≈900 MB brotli'd combined). On a
  // cold visit they alone push the boot-blocking download past 1.2 GB →
  // the client can't reach LoginGump before the smoke timeout (and a real
  // first-time visitor stares at "Loading assets…" for minutes). A native
  // UO client memory-maps these and reads ranges on demand; the WASM port
  // fetches them whole. So on legacy/un-pooled shards (empty manifest, e.g.
  // RunUO 2.x like Ultima Memento) we DON'T boot-block on anim2-5.mul —
  // boot completes on anim.mul + the tiny .idx files, then these stream in
  // afterwards (see _deferredBgFiles consumer at mount time). The C#
  // AnimationsLoader opens each .mul lazily once its bytes land in /uo
  // (EnsureMulFile), so bodies whose graphics live in anim2-5 simply pop in
  // a few seconds after world-entry instead of blocking the whole boot.
  // Pooled shards keep the current behaviour (their blobs are small +
  // content-addressed + cacheable). Only the heavy .mul are deferred; the
  // .idx stay boot-blocking so the lazy open finds a complete pair.
  const _legacyBigFile = (!assetsManifest || Object.keys(assetsManifest).length === 0);
  const DEFER_BG_NAMES = new Set(['anim2.mul', 'anim3.mul', 'anim4.mul', 'anim5.mul']);
  // EAGER ANIM (operator directive 2026-06-03: NO deferral — the world,
  // including the player's clothes/equipment which live in anim5.mul, must be
  // complete from frame 1; the deferral made "las ropas se cargaban al minuto").
  // deferBg=false makes anim2-5.mul boot-blocking like every other REQUIRED file
  // instead of background-streamed after world-entry. This adds the (brotli-
  // compressed, ~half size) anim2-5 weight to the COLD boot — MAX_INFLIGHT stays
  // capped at 4 in legacy mode (above) so the big streams still complete, and
  // warm/OPFS-cached boots are unaffected. The C# deferred-anim self-heal
  // (EnsureMulFile lazy-open + FilesGeneration reclear) simply goes inert
  // because the files are present at Load. _legacyBigFile is kept for the
  // MAX_INFLIGHT cap; only the defer behaviour is turned off.
  const deferBg = false;
  const deferredBg = [];

  // Eager custom-map facets for UltimaLive ultra-custom shards (see
  // SHARD_CUSTOM_MAP_IDS). Appended once, dup-guarded so a second fetchAll()
  // in the same page can't double-add. Only the selected shard's maps are
  // added, so non-custom shards never attempt (and skip-warn on) these files.
  for (const e of shardCustomMapFiles()) {
    if (!REQUIRED_FILES.some((r) => r[0] === e[0])) REQUIRED_FILES.push(e);
  }

  // Honest file count, driven by the shard's MANIFEST (not the hardcoded list).
  // REQUIRED_FILES is a fixed cross-client-era list of exactly 99 known UO files
  // — that is why the loader always read "X / 99". The shard manifest is the real
  // source of truth: it lists exactly the gamefiles THIS shard publishes, which
  // can be FEWER than 99 (a slim shard) or MORE than 99 (custom content / extra
  // maps). So when a manifest exists, build the download list FROM it: every
  // REQUIRED_FILES entry maps name->name (verified: 0 entries differ), so a
  // manifest-only file safely defaults to [name, name] and a known file keeps its
  // REQUIRED_FILES entry. Empty manifest (legacy / un-pooled shard, e.g. RunUO
  // 2.x) has no file list, so fall back to the known-file superset attempt.
  const _planManifestEmpty = !assetsManifest || Object.keys(assetsManifest).length === 0;
  let PLANNED;
  if (_planManifestEmpty) {
    PLANNED = REQUIRED_FILES;
  } else {
    const _reqByName = new Map(REQUIRED_FILES.map((e) => [String(e[0]).toLowerCase(), e]));
    PLANNED = Object.keys(assetsManifest).map((name) => _reqByName.get(name) || [name, name]);
  }

  // MINI: apply the resolved asset-profile SKIP set to the boot-blocking list
  // (lighter boot for medium/ultra profiles). No-op for cuo/tuo. The runtime's
  // filter only applies `skip`; any `defer` entries just load eagerly (correct,
  // shared has no background-streamer yet) — flagged in FASE3 doc.
  if (window.__bundle === 'mini' && window.__miniHooks && window.__miniHooks.profileFilter) {
    try { PLANNED = window.__miniHooks.profileFilter(PLANNED); } catch (e) { /* keep full list on error */ }
  }

  // the [loader] log is more readable when files appear in file-list
  // order rather than completion-order.
  const out = new Array(PLANNED.length);
  let cachedCount = 0, fetchedCount = 0, totalBytes = 0;
  // hit rate the operator captured on warm sessions. Updated by
  // fetchFileCached via the cacheMissReason it returns.
  const missReasons = { noEntry: 0, noEtag: 0, noBytes: 0, net200: 0, net304: 0, other: 0 };
  let completed = 0;
  let nextIndex = 0;
  // surface a hard-error banner if anything mandatory failed. Pre-
  // fix the warning was console-only — a missing art.mul produced a
  // silent skip and the user only saw the symptom 30 s later when
  // CUO crashed deep inside ArtLoader.Load with an opaque
  // "file not found".
  const skipped = [];
  // Genuine (non-benign) failures collected during the concurrent pass for a
  // serial retry below. Kept separate from `skipped` (benign 404/403/manifest)
  // so the eager-completeness guarantee only fails the boot on files the
  // server actually HAS but that didn't arrive.
  const genuineFailures = [];
  // A failure is BENIGN iff the shard genuinely lacks the file: a deterministic
  // 404/403 (REQUIRED_FILES is a cross-client-era superset) or the manifest
  // marker. Everything else (5xx after retries, network, body-read, integrity
  // mismatch) is a genuine failure that must NOT be silently skipped.
  const isBenignSkip = (msg) =>
    msg === 'not in shard manifest' || /^HTTP (404|403)\b/.test(msg);

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= PLANNED.length) return;
      const [src, dst] = PLANNED[i];
      // Deferred big-file: don't boot-block; queue for post-mount streaming.
      if (deferBg && DEFER_BG_NAMES.has(src)) {
        out[i] = null;
        deferredBg.push([src, dst]);
        completed++;
        uiProgress(completed / PLANNED.length);
        uiStatus(`Loading assets… ${completed} / ${PLANNED.length}`);
        continue;
      }
      try {
        const { bytes, fromCache, cacheMissReason } = await fetchFileCached(cache, src);
        out[i] = [dst, bytes];
        totalBytes += bytes.length;
        if (fromCache) cachedCount++;
        else {
          fetchedCount++;
          if (cacheMissReason && missReasons.hasOwnProperty(cacheMissReason)) {
            missReasons[cacheMissReason]++;
          } else {
            missReasons.other++;
          }
        }
      } catch (e) {
        // Classify the failure. BENIGN (tolerate, as before): "not in shard
        // manifest" or a deterministic 404/403 — REQUIRED_FILES is a cross-era
        // superset, so a shard legitimately lacks some files. GENUINE (do NOT
        // skip): transient / network / body-read / integrity-mismatch — a file
        // the server HAS failed to arrive (the operator's "cold load, statics
        // missing, reopen fixes it" bug). Genuine failures are collected for a
        // serial retry pass below; if any still fail, boot throws rather than
        // entering an incomplete world.
        const msg = e?.message ?? String(e);
        out[i] = null;
        if (isBenignSkip(msg)) {
          console.log(`[loader] skip ${src}: ${msg}`);
          skipped.push({ src, message: String(msg) });
        } else {
          console.warn(`[loader] FAIL ${src}: ${msg}`);
          genuineFailures.push({ i, src, dst, message: String(msg) });
        }
      }
      completed++;
      uiProgress(completed / PLANNED.length);
      uiStatus(`Loading assets… ${completed} / ${PLANNED.length}`);
      uiDetail(src);
      _bootProgress();   // boot watchdog: a file completed
    }
  }

  const workers = [];
  for (let k = 0; k < MAX_INFLIGHT; k++) workers.push(worker());
  await Promise.all(workers);

  // tree is partial and CUO will crash later.
  if (skipped.length > 2) {
    console.warn(`[loader] ${skipped.length} files skipped — CUO may crash on missing assets:`,
                 skipped.map((s) => s.src));
    try {
      uiStatus(`Loading assets… ${completed} / ${PLANNED.length} (${skipped.length} skipped — see console)`);
    } catch { /* uiStatus may be a no-op once the loader hides */ }
  }

  // Genuine failures must NOT leave the world incomplete (operator req
  // 2026-06-09; directive: world complete from frame 1). Benign skips above
  // are still tolerated. Retry each genuine failure serially — the cold
  // concurrent burst (REQUIRED_FILES @ MAX_INFLIGHT) eases on a 2nd,
  // low-concurrency pass, which is the automatic equivalent of the operator's
  // "close + reopen the browser". If any file still fails after retries, THROW
  // so boot fails honestly instead of entering a broken world.
  if (genuineFailures.length > 0) {
    console.warn(`[loader] ${genuineFailures.length} file(s) failed (non-benign) — serial retry:`,
                 genuineFailures.map((f) => f.src));
    try { uiStatus(`Re-fetching ${genuineFailures.length} file(s)…`); } catch { /* loader may be hidden */ }
    const stillFailed = [];
    for (const f of genuineFailures) {
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
        try {
          const { bytes } = await fetchFileCached(cache, f.src);
          out[f.i] = [f.dst, bytes];
          totalBytes += bytes.length;
          fetchedCount++;
          ok = true;
        } catch (e) {
          const m = e?.message ?? String(e);
          if (isBenignSkip(m)) { ok = true; out[f.i] = null; } // became a benign 404 — tolerate
          else f.lastError = m;
        }
      }
      if (!ok) stillFailed.push(f);
    }
    if (stillFailed.length > 0) {
      const names = stillFailed.map((f) => `${f.src} (${f.lastError})`).join(', ');
      try { uiStatus(`Asset load failed: ${stillFailed.length} file(s) — reload to retry`); } catch { /* loader may be hidden */ }
      throw new Error(`[loader] ${stillFailed.length} required file(s) failed after retries: ${names}`);
    }
    console.log(`[loader] serial retry recovered all ${genuineFailures.length} file(s)`);
  }

  // Compact null slots (skipped files) before handing back to CUO.
  const filtered = out.filter(Boolean);
  out.length = 0;
  for (const e of filtered) out.push(e);

  uiProgress(1);
  const mib = (totalBytes / 1024 / 1024).toFixed(1);
  uiStatus(`${out.length} files ready — ${mib} MiB`);
  uiDetail(fetchedCount === 0
    ? `All from cache — no network transfer.`
    : `${cachedCount} cached, ${fetchedCount} downloaded.`);
  console.log(`[loader] ${out.length} files (${mib} MiB) — cached=${cachedCount}, downloaded=${fetchedCount}`);
  //   noEtag   = entry existed but no etag stored (older write before fix)
  //   noBytes  = entry existed but bytes missing (write torn / corrupted)
  //   net200   = etag sent, server returned full body (file changed)
  //   net304   = etag sent, server confirmed unchanged (counts as cached)
  //   other    = unclassified miss
  if (fetchedCount > 0) {
    console.log(`[loader] cache misses by reason: ` +
      `noEntry=${missReasons.noEntry} noEtag=${missReasons.noEtag} ` +
      `noBytes=${missReasons.noBytes} net200=${missReasons.net200} ` +
      `net304=${missReasons.net304} other=${missReasons.other}`);
  }
  // Asset-load RECEIPT (operator 2026-07-30: "si cargo el mismo server con CUO y TUO,
  // en lugar de re-usar la caché vuelve a descargarlos la segunda vez"). Everything
  // above goes to a console that is SILENCED for anyone without ?dev, and the on-screen
  // line is gone a second later — so the one report that would settle this question
  // could never be produced by the person seeing the bug. The receipt is written under
  // ONE shared key on purpose: the cache is per-ORIGIN, so the interesting comparison
  // is exactly the cross-bundle one (cuo wrote it, tuo reads it back). Stored, not sent:
  // no new endpoint, no proxy rebuild. Read it from the avatar menu → Storage.
  try {
    let usage = 0, quota = 0, persisted = null;
    if (navigator.storage?.estimate) {
      try { const e = await navigator.storage.estimate(); usage = e.usage || 0; quota = e.quota || 0; } catch { /* denied */ }
    }
    if (navigator.storage?.persisted) {
      try { persisted = await navigator.storage.persisted(); } catch { /* denied */ }
    }
    localStorage.setItem(CACHE_RECEIPT, JSON.stringify({
      t: Date.now(), bundle: _bundleId(), base: (window.__chosenGamefilesUrlBase || 'gamefiles'),
      backend: cache ? cache.type : 'none', files: out.length, cached: cachedCount,
      downloaded: fetchedCount, mib: Number(mib), miss: missReasons,
      usage, quota, persisted, writesOff: _assetCacheWritesOff,
    }));
  } catch { /* private mode / storage denied — a diagnostic never breaks a boot */ }
  // Hand the deferred big-file queue to the post-mount background streamer.
  _deferredBgFiles = deferredBg;
  _deferredBgCache = cache;
  if (deferredBg.length) {
    console.log(`[loader] deferred ${deferredBg.length} big anim file(s) to background: ` +
      deferredBg.map(([s]) => s).join(', '));
  }
  return out;
}

// Populated by fetchAll() when it defers giant anim files on a big-file
// legacy shard; consumed once after the boot-blocking files are mounted
// into /uo (see the background streamer at FS-mount time).
let _deferredBgFiles = [];
let _deferredBgCache = null;


const KMOD_LSHIFT = 0x0001;
const KMOD_RSHIFT = 0x0002;
const KMOD_LCTRL  = 0x0040;
const KMOD_RCTRL  = 0x0080;
const KMOD_LALT   = 0x0100;
const KMOD_RALT   = 0x0200;
const KMOD_LGUI   = 0x0400;
const KMOD_RGUI   = 0x0800;
const KMOD_NUM    = 0x1000;
const KMOD_CAPS   = 0x2000;

// single-character keys fall through to charCodeAt(0) (which
// "Scancode | 0x40000000" keycodes for function keys, etc.
const KEY_TO_SDL3 = Object.freeze({
  'Backspace':  0x08,
  'Tab':        0x09,
  'Enter':      0x0D,
  'Escape':     0x1B,
  ' ':          0x20,
  'Delete':     0x7F,
  'CapsLock':       0x40000039,
  'F1':             0x4000003A,
  'F2':             0x4000003B,
  'F3':             0x4000003C,
  'F4':             0x4000003D,
  'F5':             0x4000003E,
  'F6':             0x4000003F,
  'F7':             0x40000040,
  'F8':             0x40000041,
  'F9':             0x40000042,
  'F10':            0x40000043,
  'F11':            0x40000044,
  'F12':            0x40000045,
  'PrintScreen':    0x40000046,
  'ScrollLock':     0x40000047,
  'Pause':          0x40000048,
  'Insert':         0x40000049,
  'Home':           0x4000004A,
  'PageUp':         0x4000004B,
  'End':            0x4000004D,
  'PageDown':       0x4000004E,
  'ArrowRight':     0x4000004F,
  'ArrowLeft':      0x40000050,
  'ArrowDown':      0x40000051,
  'ArrowUp':        0x40000052,
  'NumLock':        0x40000053,
  'Control':        0x400000E0,
  'Shift':          0x400000E1,
  'Alt':            0x400000E2,
  'Meta':           0x400000E3,
});

const KEY_TO_SCANCODE = Object.freeze({
  'Backspace': 42,
  'Tab':       43,
  'Enter':     40,
  'Escape':    41,
  ' ':         44,
});

// Modifier state as WITNESSED BY THE PAGE, not as reported by the browser.
// ev.altKey/ctrlKey/... go STALE after Alt+Tab: the modifier keydown reaches
// the page but its keyup goes to the OS switcher, so Chrome keeps reporting
// altKey=true on every later event until the user physically re-presses Alt.
// That stale flag re-poisoned Keyboard.Alt in the engine on the first key
// after refocus (player report 2026-07-18: Alt+click teed a TazUO bulk move
// long after Alt was released). We track modifier keydown/keyup ourselves and
// hard-reset on window blur AND focus, so a modifier is only ever "held" while
// this page actually saw it go down and not yet up.
const _domMods = { alt: false, ctrl: false, shift: false, meta: false, altGraph: false };
function trackDomModifier(ev, down) {
  switch (ev.key) {
    case 'Alt':     _domMods.alt   = down; break;
    // AltGr is its OWN ev.key, not 'Alt'. Windows also synthesises a Control
    // keydown alongside it, so without this case the tracker recorded a bare
    // Ctrl and computeKeymod's AltGr guard -- which sits inside `if (_domMods.alt)`
    // -- could never run. Result: every AltGr character on a European layout
    // (`[ ] { } @ #  ~`) reached the engine as a Ctrl chord and was swallowed as a
    // hotkey instead of typed. That takes the GM command prefix `[` with it.
    case 'AltGraph': _domMods.altGraph = down; break;
    case 'Control': _domMods.ctrl  = down; break;
    case 'Shift':   _domMods.shift = down; break;
    case 'Meta':    _domMods.meta  = down; break;
  }
}
function resetDomModifiers() {
  _domMods.alt = _domMods.ctrl = _domMods.shift = _domMods.meta = false;
  _domMods.altGraph = false;
}
// Read-only view for the rail: the Hotkeys binding capture must record the
// modifiers the PAGE actually saw held, not ev.altKey/ctrlKey/shiftKey — those
// go stale after Alt+Tab (Chrome keeps altKey=true until Alt is re-pressed), so
// a capture would bind a phantom Alt+X. Same root cause as the war-mode bug.
try {
  window.__uoDomMods = {
    get alt()   { return _domMods.alt;   },
    get ctrl()  { return _domMods.ctrl;  },
    get shift() { return _domMods.shift; },
    get meta()  { return _domMods.meta;  },
  };
} catch (e) { /* window unavailable (SSR/tests) */ }

// Is this event an AltGr composition rather than a real Ctrl+Alt chord?
//
// 🚨 ONE definition, used by BOTH the modifier calculation and the text emission. They
// used to each decide for themselves and only computeKeymod knew about AltGr, which is
// how `[ ] { } @ # ~ \ | €` became untypeable on European layouts: the character was
// correctly not treated as a hotkey, and also never typed (operator 2026-07-30).
//
// Windows fires a SYNTHETIC Ctrl_L + Alt_R pair for AltGr, so the raw modifier flags say
// "Ctrl and Alt are held" when the user is simply typing a character.
// getModifierState('AltGraph') alone is not enough: it reads false on the Control keydown
// Windows sends FIRST, which is the event that poisons the tracked state -- hence the
// tracked _domMods.altGraph as well.
function isAltGr(ev) {
  return _domMods.altGraph
         || !!(ev && ev.getModifierState && ev.getModifierState('AltGraph'));
}

function computeKeymod(ev) {
  let mod = 0;
  if (_domMods.shift) mod |= KMOD_LSHIFT;
  // AltGr arrives on Windows as a SYNTHETIC Ctrl_L + Alt_R pair. Neither is a chord
  // the user pressed -- they are typing `[ ] { } @  ~ #`. Report neither, so the
  // character falls through to SDL_TEXTINPUT instead of matching a Ctrl/Alt hotkey.
  // getModifierState('AltGraph') alone is not enough: it is false on the Control
  // keydown that Windows fires FIRST, which is the event that was poisoning the state.
  const _altGr = isAltGr(ev);
  if (_domMods.ctrl && !_altGr) mod |= KMOD_LCTRL;
  // AltGr detection. On European keyboards AltGr produces chars like
  // `@ [ ] { } €`. The DOM fires both ev.ctrlKey=true AND ev.altKey=
  // true in that case (Windows + Linux), with ev.code still the
  // physical key. Distinguish AltGr from a real Ctrl+Alt chord by
  // looking at the `AltGraph` modifier state. When detected, flag
  // clears both the key and the fake Ctrl+Alt mods, letting
  // SDL_TEXTINPUT own the character. Fixes bug O46 (AltGr chars
  // firing phantom Ctrl+Alt macros on European layouts).
  if (_domMods.alt && !_altGr) {
    mod |= KMOD_LALT;
  }
  if (_domMods.meta)  mod |= KMOD_LGUI;
  if (ev.getModifierState && ev.getModifierState('CapsLock'))   mod |= KMOD_CAPS;
  if (ev.getModifierState && ev.getModifierState('NumLock'))    mod |= KMOD_NUM;
  return mod;
}

// DOM `ev.key` already carries the SHIFTED character — Shift+1 ->
// '!', Shift+; -> ':', Shift+[ -> '{'. Desktop SDL delivers the
// UNSHIFTED keycode with mod=SHIFT so CUO macros bound to Shift+1
// can pattern-match on `case SDLK_1 when Keyboard.Shift`. Without
// correcting for this on wasm, every shift-modified digit /
// punctuation hotkey is permanently broken (bug O45). Use `ev.code`
// as the source of truth for the base character whenever it's a
// Digit<N> or a punctuation key; fall back to ev.key for letters
// (where the ev.key casing is already stable with shift).
const CODE_TO_UNSHIFTED_ASCII = {
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  // US QWERTY layout punctuation — the most-used macro-target set.
  Minus: 0x2D, Equal: 0x3D, BracketLeft: 0x5B, BracketRight: 0x5D,
  Backslash: 0x5C, Semicolon: 0x3B, Quote: 0x27, Comma: 0x2C,
  Period: 0x2E, Slash: 0x2F, Backquote: 0x60,
};

function translateKey(ev) {
  // Recover the un-shifted codepoint via ev.code for digit / punct.
  // Keeps letters routed through ev.key (they already match SDL).
  if (ev.code && CODE_TO_UNSHIFTED_ASCII[ev.code] !== undefined) {
    return CODE_TO_UNSHIFTED_ASCII[ev.code];
  }
  const k = ev.key;
  if (KEY_TO_SDL3[k] !== undefined) return KEY_TO_SDL3[k];
  if (k && k.length === 1) {
    const code = k.charCodeAt(0);
    if (code >= 0x41 && code <= 0x5A) return code + 0x20;
    return code;
  }
  return 0;
}

function translateScancode(ev) {
  if (KEY_TO_SCANCODE[ev.key] !== undefined) return KEY_TO_SCANCODE[ev.key];
  const c = ev.code || '';
  if (c.startsWith('Key') && c.length === 4) return 4 + (c.charCodeAt(3) - 0x41);
  if (c.startsWith('Digit') && c.length === 6) {
    const d = c.charCodeAt(5) - 0x30;
    return d === 0 ? 39 : 29 + d;
  }
  return 0;
}

function installInputBridge(canvas, Module) {
  const wasm_push_key          = Module._wasm_push_key;
  const wasm_push_text         = Module._wasm_push_text;
  const wasm_push_mouse_motion = Module._wasm_push_mouse_motion;
  const wasm_push_mouse_button = Module._wasm_push_mouse_button;
  const wasm_push_mouse_wheel  = Module._wasm_push_mouse_wheel;
  const wasm_push_mouse_io     = Module._wasm_push_mouse_in_window;
  const wasm_push_win_focus    = Module._wasm_push_window_focus;
  const _malloc                = Module._malloc;

  if (!wasm_push_key || !wasm_push_text || !_malloc) {
    console.error('[p4d7] wasm exports missing — input bridge disabled');
    return;
  }

  const TEXT_CAP  = 64;
  const textPtr   = _malloc(TEXT_CAP);
  const enc       = new TextEncoder();

  function pushText(str) {
    if (!str) return;
    const b = enc.encode(str);
    const n = Math.min(b.length, TEXT_CAP - 1);
    Module.HEAPU8.set(b.subarray(0, n), textPtr);
    Module.HEAPU8[textPtr + n] = 0;
    wasm_push_text(textPtr);
  }

  if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');

  // ── Boot-ready input gate (bug: "typing / moving the mouse right as the
  //    login gump appears HANGS, feels like OOM at startup") ──────────────
  // installInputBridge() is called at runtime-create time — BEFORE the
  // ~105 s asset download + MEMFS mount + IDBFS restore and BEFORE
  // runMain() starts the game loop. The C ring buffer that wasm_push_*
  // writes into is only DRAINED once GameController.Update → PumpWasmInput
  // runs (i.e. once the loop is alive). So any key/mouse the user generates
  // during the long boot is pointless work on the fragile, near-full-heap
  // main thread for events the engine cannot consume yet. We hard-gate every
  // DOM handler until the engine emits its first real signal. Before that,
  // handlers no-op (no focus steal, no wasm crossing, no preventDefault) and
  // the events do nothing on the canvas. A safety timeout arms input
  // unconditionally so a missed signal can never leave the client deaf.
  //
  // 🚨 WHY `login-gump-added` NO LONGER ARMS ON ITS OWN (operator report: the
  // client freezes when you START TYPING your account/password). That signal
  // fires from LoginScene.Load at `UIManager.Add(new LoginGump(...))` — i.e.
  // when the gump OBJECT IS CONSTRUCTED, which says nothing about the loop
  // having produced a frame yet. It is the earliest possible arming moment and
  // it lands exactly on the most fragile instant of the whole session: the
  // memory probe below measures the tab at ~86 % of its per-tab budget right
  // there (~3.5 GB of 4 GB, wasm heap included), so allocation pressure is at
  // its peak while the engine is still warming up its first frames. Every
  // keystroke crosses into wasm and allocates. Typing FAST packs that burst
  // into the worst window there is — which is why the bug depends on typing
  // speed and is otherwise unreproducible.
  //
  // 🚨 WHY THIS IS NOT GATED ON AN ENGINE SIGNAL. The obvious fix — arm on
  // `draw-heartbeat`, which proves 60 real Draw() calls completed — CANNOT be
  // used: the forks disagree. cuo and mini emit it; **TazUO emits only
  // `login-gump-added` and `gamescene-active`** (verified 2026-08-14 across all
  // three trees). `gamescene-active` fires on WORLD ENTRY, i.e. after the login
  // this gate exists to protect, so gating TUO on engine signals would leave it
  // unable to type its own password until the fallback expired. Adding the
  // heartbeat to TazUO would mean a cold WASM rebuild of that fork; measuring
  // the main thread from JS costs nothing and covers all three identically.
  //
  // WHAT WE WAIT FOR INSTEAD: proof that the main thread is no longer being
  // hogged. Under Mercury MT the .NET loop is driven from the main thread's
  // animation-frame callbacks, so while boot work still owns that thread our
  // own rAF callbacks arrive late. QUIET_FRAMES consecutive frames under
  // QUIET_GAP_MS means the loop is genuinely keeping up and the burst of
  // keystrokes now has somewhere to land. At 60 fps that is ~0.3 s — invisible
  // in the healthy case, which matters: this must not make a good boot slower.
  const QUIET_FRAMES = 20;    // consecutive animation frames that must be on time
  const QUIET_GAP_MS = 50;    // ≥20 fps sustained — long frames mean it is still busy
  // 🚨 3 s, not the 10 s this shipped with in v1.0.13. The wait is ~158 ms on every client
  // measured in production, so anything approaching this bound means the watch is NOT converging,
  // and the player is staring at "Almost ready" the whole time (operator saw exactly that). At 60
  // fps the watch needs ~333 ms, so 3 s is still ~9x margin for a slow warm-up; past that,
  // arming is the honest call — a client that looks broken is worse than one that armed early.
  const POST_GUMP_FALLBACK_MS = 3_000;

  let _inputReady = false;
  const _armInput = (why) => {
    if (_inputReady) return;
    _inputReady = true;
    console.log('[p4d7] input bridge ARMED:', why);
    // 🚨 RECORDED WHERE A FREEZE CANNOT ERASE IT. The hang this gate exists to prevent wedges the
    // main thread: no console to read, no pagehide, nothing to copy — and it is intermittent, so
    // asking the operator to capture it live is asking for the impossible. The 2 s heartbeat below
    // already survives a hard kill and is read back on the NEXT boot, so the arm reason rides along
    // with it. The post-mortem can then say WHICH signal opened the gate: real quiescence, or the
    // 3 s fallback that opens regardless of whether the thread ever settled.
    window.__uoArm = { why: String(why), ms: Math.round((performance && performance.now) ? performance.now() : 0) };
    // Also into the unconditional event log, so the frozen session's timeline shows the gate
    // opening in sequence with the long tasks and visibility changes around it — which is the
    // comparison that separates "armed on real quiescence" from "armed by the escape hatch while
    // the thread was still blocked".
    try { globalThis.__uoEv && globalThis.__uoEv(`input-gate ARMED: ${why}`); } catch { /* */ }
    // Single source of truth for "the client is usable now": the loader is
    // dismissed by THIS event, so the on-screen state and the input gate can
    // never disagree. Showing a login form that silently eats keystrokes is
    // the failure mode being removed here.
    try { window.dispatchEvent(new CustomEvent('cuo:input-armed', { detail: { why } })); } catch {}
  };
  // Exposed so the loader's own last-resort timeout can surrender BOTH gates in
  // one act (see the 15 s net just before runMain). If we have given up waiting
  // and are showing the client anyway, it must also be typeable — a revealed
  // client that ignores the keyboard is worse than either state alone.
  // 🚨 It is the VISIBILITY-AWARE entry point, not the raw arm. That net is a wall-clock timer like
  // the other two, so on a backgrounded boot it opened the gate for a player who was not there —
  // the same defect as the branch removed below, just with a different label in the black box. On a
  // visible page it is unchanged.
  globalThis.__uoArmInput = _armWhenVisible;

  // These three all mean the loop is alive and past login; arm immediately.
  window.addEventListener('cuo:gamescene-active', () => _armInput('gamescene'));
  window.addEventListener('cuo:draw-heartbeat',  () => _armInput('draw-heartbeat'));
  window.addEventListener('cuo:player-created',   () => _armInput('player-created'));

  // 🚨 THE GATE MUST NOT OPEN WHILE THE PAGE IS HIDDEN. THIS IS THE HANG, MEASURED.
  //
  // What stood here armed the gate the moment the page was not visible, reasoning — correctly —
  // that "a page the browser is not painting cannot be receiving typed input from a human, so there
  // is no typist to protect", and concluding "this cannot weaken the gate". It does weaken it, and
  // the black box caught it on 2026-09-05 after ~690 automated attempts had reproduced nothing:
  //
  //   T+14665  visibility=hidden                    the operator switches away mid-boot
  //   T+15893  main-thread stalled ~893ms
  //   T+23323  input-gate ARMED: page-not-visible   the login gump arrives while hidden
  //   T+23544  visibility=visible                   they come back, 221 ms later
  //   T+23627  long-frame=22ms  ->  silence         still reserving 4096x4096 atlases
  //
  // The reasoning is about the WRONG INSTANT. Arming is permanent, so a decision taken while nobody
  // could type hands the protection away exactly when a human returns to a client that never
  // demonstrated quiescence. `engineLastBeat=0` and 1482/1487 MB of a 4192 MB heap: the engine was
  // alive and it was not out of memory — it was busy, and the gate was already open.
  //
  // The fix is not to delete that branch. Deleting it alone only relabels the arm: the fallback
  // below runs on WALL CLOCK, so it expires while hidden and opens the gate as 'post-gump-fallback'
  // with the thread in the same state. The rule that closes the class is: **the budget is spent on
  // a page somebody is looking at.** Frames are the evidence of quiescence, a hidden page delivers
  // none, so a hidden page simply waits — and when it comes back, the watch starts over with a
  // fresh budget. Nobody is staring at "Almost ready" in the meantime, because nobody is looking.
  //
  // On a page that is never hidden this is byte-for-byte the previous behaviour: `_armWhenVisible`
  // arms immediately and the watch runs once. That matters — this must not slow a healthy boot.
  let _quietWatch = 0;      // rAF handle, so a restart can never leave two watches racing
  let _fallbackTimer = 0;

  const _startQuietWatch = () => {
    if (_inputReady) return;
    try { cancelAnimationFrame(_quietWatch); } catch { /* pre-restart handle may be stale */ }
    clearTimeout(_fallbackTimer);
    let quiet = 0;
    let last = performance.now();
    const tick = () => {
      if (_inputReady) return;
      const now = performance.now();
      const gap = now - last;
      last = now;
      // A resumed tab reports one enormous gap first, which resets the count — correct, and the
      // reason this needs no special case: the frames either arrive on time or they do not.
      quiet = (gap <= QUIET_GAP_MS) ? quiet + 1 : 0;
      if (quiet >= QUIET_FRAMES) {
        _armInput(`main-thread-quiet(${QUIET_FRAMES}f<=${QUIET_GAP_MS}ms)`);
        return;
      }
      _quietWatch = requestAnimationFrame(tick);
    };
    _quietWatch = requestAnimationFrame(tick);
    // Bounded net for this phase: a machine that never settles must still be playable. Without it,
    // a permanently busy main thread would be indistinguishable from a broken client for the full
    // 180 s below. It defers rather than arms when hidden — that deferral IS the fix.
    _fallbackTimer = setTimeout(() => _armWhenVisible('post-gump-fallback'), POST_GUMP_FALLBACK_MS);
  };

  // Arm now if someone is looking; otherwise wait for them and then prove quiescence first.
  // Re-arming the watch rather than arming outright on the visible transition is deliberate: the
  // moment a player returns is precisely when the client is least likely to have settled.
  function _armWhenVisible(why) {
    if (_inputReady) return;
    let visible = true;
    try { visible = (document.visibilityState === 'visible'); } catch { /* no API — treat as visible */ }
    if (visible) { _armInput(why); return; }
    const onVisible = () => {
      try { if (document.visibilityState !== 'visible') return; } catch { /* fall through and arm */ }
      document.removeEventListener('visibilitychange', onVisible);
      if (_inputReady) return;
      _startQuietWatch();
    };
    document.addEventListener('visibilitychange', onVisible);
  }

  // The login gump starts the quiescence watch instead of arming.
  window.addEventListener('cuo:login-gump-added', () => {
    if (_inputReady) return;
    // Coming BACK counts as much as going away: the watch stalls the moment frames stop, so the
    // budget it had spent while hidden was spent on nothing. Start it over.
    document.addEventListener('visibilitychange', () => {
      try { if (document.visibilityState !== 'visible') return; } catch { /* */ }
      if (!_inputReady) _startQuietWatch();
    });
    _startQuietWatch();
  }, { once: true });

  // Absolute safety net: never leave input disabled forever if no signal
  // arrives (e.g. a render-path regression that never paints). 180 s is far
  // past the worst observed cold boot (~110 s) so it can't pre-arm mid-boot.
  // Same rule as the fallback: on a hidden page it waits, because opening the gate for a player who
  // is not there only means the gate is already open when they arrive.
  setTimeout(() => _armWhenVisible('safety-timeout-180s'), 180_000);

  // direction. Reasons:
  //   1. It locks the OS cursor inside the canvas — user wants the
  //      cursor free to leave the window like the reference impl
  //      (UO Classic Web).
  //   2. Under puppeteer the canvas is in a detached browsing
  //      context so requestPointerLock() throws WrongDocumentError
  //      on every click — pollutes the bot console and blocks the
  //      walk-direction path the bot is supposed to exercise.
  //   3. On Chrome the unlocked path already delivers pointermove
  //      correctly during right-mouse-hold (see the reference impl);
  //      the walk-stuck bug is only on Firefox / Safari where
  //      contextmenu / gesture handlers pre-empt pointermove.
  // See docs/MOUSE_POINTER_LOCK.md for the full history and the
  // four-option decision matrix. Restore by re-introducing the
  // `vX/vY + isLocked + tryRequestPointerLock` block from commit
  // 6625dc7 (also captured in that doc).

  const rectXY = (ev) => {
    const r = canvas.getBoundingClientRect();
    // Translate CSS-pixel pointer coords to backing-store pixels.
    // When the perf cap kicks in (canvas.width < rect.width), the
    // canvas element CSS-scales up so clicks must scale down to
    // stay in sync with what the GPU renders. In the 1:1 case
    // (backing == CSS) the ratio is 1 so it's a no-op.
    const sx = r.width  > 0 ? canvas.width  / r.width  : 1;
    const sy = r.height > 0 ? canvas.height / r.height : 1;
    return [(ev.clientX - r.left) * sx, (ev.clientY - r.top) * sy];
  };

  // puppeteer bot can exercise right-mouse-hold walks. CDP's
  // synthesized pointerdown events don't play well with setPointerCapture
  // (subsequent pointermove events during the hold were being dropped,
  // causing the walk direction to "not land" and the bot to never
  // actually move the character). On a real browser the absence of
  // capture can let Chrome's contextmenu / swipe-gesture handlers
  // while we're in bot-driven investigation mode. See
  // docs/MOUSE_POINTER_LOCK.md for the full decision matrix.
  // binding installs main-thread listeners for ALL DOM input + window
  // lifecycle events (mouse, wheel, focus, blur, visibilitychange,
  // resize, pointerlockchange). Each one uses `emscripten_proxy_sync`
  // to forward to the deputy, blocking the browser main thread for
  // the round-trip. If the deputy is busy (zone-load, GC, tab switch
  // storm, etc.), the main thread deadlocks and the ENTIRE browser
  // tab freezes (user can't even select text in DevTools).
  //
  // We already push all these events to the wasm ring buffer via our
  // own `wasm_push_*` bridge without cross-thread proxying. Register
  // every listener with `{ capture: true }` and call
  // never runs, eliminating the sync-proxy path entirely.
  const stop = (ev) => { ev.stopImmediatePropagation(); };
  /* Which pointers began their press ON the canvas. The window-level pointerup below synthesises a
     release for a drag that left the canvas (bug O52) and must NOT do so for a press that started
     on the rail — with a rail target armed, that synthesised release is consumed as the pick. */
  const _downOnCanvas = new Set();
  const _forgetPointer = (ev) => { _downOnCanvas.delete(ev.pointerId); };
  window.addEventListener('blur', () => { _downOnCanvas.clear(); });

  canvas.addEventListener('pointerdown', (ev) => {
    if (!_inputReady) return;   // drop input until the engine is draining
    _downOnCanvas.add(ev.pointerId);
    canvas.focus();
    const [x, y] = rectXY(ev);
    // bridge forwards into the SDL ring buffer. Pairs with [click-recv]
    // in GameController.cs. If you click and DON'T see [bridge-click],
    // the browser dropped the event before the canvas listener (focus
    // stolen, preventDefault upstream, etc). If you see [bridge-click]
    // but no [click-recv], the SDL ring buffer or PumpWasmInput drained
    // it before CUO's MOUSE_BUTTON_DOWN handler ran.
    console.log(`[bridge-click] pointerdown btn=${ev.button + 1} pos=(${Math.round(x)},${Math.round(y)}) target=${ev.target?.id || ev.target?.tagName}`);
    wasm_push_mouse_button(1, ev.button + 1, x, y);
    ev.preventDefault();
    stop(ev);
  }, { capture: true });
  canvas.addEventListener('pointerup', (ev) => {
    _forgetPointer(ev);
    if (!_inputReady) return;
    const [x, y] = rectXY(ev);
    wasm_push_mouse_button(0, ev.button + 1, x, y);
    ev.preventDefault();
    stop(ev);
  }, { capture: true });
  canvas.addEventListener('pointercancel', (ev) => {
    _forgetPointer(ev);
    if (!_inputReady) return;
    const [x, y] = rectXY(ev);
    wasm_push_mouse_button(0, ev.button + 1, x, y);
    stop(ev);
  }, { capture: true });

  // Window-level pointerup fallback. setPointerCapture was
  // events don't play well with capture), so drags that release
  // OUTSIDE the canvas never fire canvas.pointerup and leave
  // ItemHold permanently enabled — the picked-up item sticks to
  // the cursor forever (user-reported bug O52). Listen on window
  // too + synthesize a mouse-up when a button is released and the
  window.addEventListener('pointerup', (ev) => {
    if (ev.target === canvas) return; // canvas listener already fired
    // Only a drag that STARTED on the canvas: see _downOnCanvas above. Without this, clicking any
    // rail button pushed a mouse-up into the world, and an armed target picker ate it instantly.
    if (!_downOnCanvas.delete(ev.pointerId)) return;
    // Clamp coords to the canvas rect so CUO gets a plausible
    // in-world position for the release event. Also clamp button
    // index — right/middle/X buttons all map the same.
    const r = canvas.getBoundingClientRect();
    const cx = Math.max(0, Math.min(r.width, ev.clientX - r.left));
    const cy = Math.max(0, Math.min(r.height, ev.clientY - r.top));
    const sx = r.width > 0 ? canvas.width / r.width : 1;
    const sy = r.height > 0 ? canvas.height / r.height : 1;
    wasm_push_mouse_button(0, ev.button + 1, cx * sx, cy * sy);
  }, { capture: true });
  canvas.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); }, { capture: true });
  canvas.addEventListener('auxclick', (ev) => { ev.preventDefault(); ev.stopPropagation(); }, { capture: true });

  let lastX = 0, lastY = 0;
  // rAF-coalesced motion: accumulate deltas, push once per
  // animation frame. CUO reads Mouse.Position once per frame, so
  // coalescing at rAF cadence loses nothing vs. raw 120-240 Hz
  // event dispatch but cuts the wasm crossing rate by 2-4x.
  let pendingMotion = null;
  let motionRafScheduled = false;
  const flushPendingMotion = () => {
    motionRafScheduled = false;
    const m = pendingMotion;
    if (!m) return;
    pendingMotion = null;
    lastX = m.x; lastY = m.y;
    wasm_push_mouse_motion(m.x, m.y, m.dx, m.dy, m.buttons);
  };
  canvas.addEventListener('pointermove', (ev) => {
    if (!_inputReady) return;
    const [x, y] = rectXY(ev);
    // v0.5.8: multi-button support. Pointer Events fire `pointerdown`
    // ONLY for the first button held and `pointerup` ONLY for the last
    // one released. A button pressed or released while another is
    // already down — e.g. a left-click to apply a target cursor while
    // the right button is held to keep running — arrives here as a
    // `pointermove` with `ev.button` set to the changed button, never
    // as pointerdown/pointerup. Synthesize the button event so CUO
    // sees it; without this you must release one button to press the
    // other. DOM `buttons` bitmask: L=1, R=2, M=4, X1=8, X2=16; CUO
    // button id = ev.button + 1. `ev.button` is -1 on a pure move.
    if (ev.button !== -1) {
      const bit = ev.button === 0 ? 1
                : ev.button === 1 ? 4
                : ev.button === 2 ? 2
                : ev.button === 3 ? 8
                : ev.button === 4 ? 16 : 0;
      if (bit) {
        wasm_push_mouse_button((ev.buttons & bit) ? 1 : 0, ev.button + 1, x, y);
      }
    }
    let buttons = 0;
    if (ev.buttons & 1) buttons |= 0x01;
    if (ev.buttons & 2) buttons |= 0x04;
    if (ev.buttons & 4) buttons |= 0x02;
    if (ev.buttons & 8) buttons |= 0x08;
    if (ev.buttons & 16) buttons |= 0x10;
    // Delta accumulator fix (bug O50): the old code computed `dx = x
    // - lastX` against lastX which ONLY updates at rAF flush, then
    // ADDED that delta to the pending accumulator. After N moves
    // before the first rAF, xrel/yrel over-counted N×. Correct
    // behaviour: accumulate from the PREVIOUSLY-ACCUMULATED position,
    // not from the last-flushed one.
    if (pendingMotion) {
      const dxInc = x - pendingMotion.x;
      const dyInc = y - pendingMotion.y;
      pendingMotion.x = x;
      pendingMotion.y = y;
      pendingMotion.dx += dxInc;
      pendingMotion.dy += dyInc;
      pendingMotion.buttons = buttons;
    } else {
      pendingMotion = { x, y, dx: x - lastX, dy: y - lastY, buttons };
    }
    if (!motionRafScheduled) {
      motionRafScheduled = true;
      requestAnimationFrame(flushPendingMotion);
    }
    if (ev.buttons) ev.preventDefault();
    stop(ev);
  }, { capture: true });

  canvas.addEventListener('pointerenter', (ev) => { if (!_inputReady) return; wasm_push_mouse_io(1); stop(ev); }, { capture: true });
  canvas.addEventListener('pointerleave', (ev) => { if (!_inputReady) return; wasm_push_mouse_io(0); stop(ev); }, { capture: true });

  canvas.addEventListener('wheel', (ev) => {
    if (!_inputReady) return;
    const y = ev.deltaY > 0 ? -1 : (ev.deltaY < 0 ? 1 : 0);
    const x = ev.deltaX > 0 ? 1 : (ev.deltaX < 0 ? -1 : 0);
    // Use CURRENT pointer coords, not the rAF-stale lastX/lastY.
    // Otherwise wheel + zoom / context-menu anchor to stale
    // coordinates during fast movement (bug O49).
    const [mx, my] = rectXY(ev);
    wasm_push_mouse_wheel(x, y, mx, my);
    ev.preventDefault();
    stop(ev);
  }, { passive: false, capture: true });

  // listeners too, all using sync-proxy to deputy. User-reported
  // the visibilitychange/blur sync-proxy path. Same capture+stop
  // pattern as above.
  // NOTE: these capture listeners stop(ev) → stopImmediatePropagation, so any
  // LATER-registered focus/blur/visibility listener on the same target is DEAD
  // CODE. That killed the original stuck-modifier release for a year (player
  // report 2026-07-18: Alt stayed held after Alt+Tab) and the first cut of the
  // focus grace (caught by bugfix-verify-extra, 2026-07-19). All focus-state
  // work must live HERE, inside the surviving listeners.
  window.addEventListener('focus', (ev) => {
    // 🚨 focus/blur do NOT bubble but they DO capture, so this fires for EVERY element that takes
    // focus — every rail button, every input. Only the window itself means "the game window came
    // back", and only that should touch engine state or swallow keys.
    if (ev.target !== window && ev.target !== document) { return; }
    wasm_push_win_focus(1);
    // Alt+Tab tail: swallow Tab/Alt for a beat and clear any stuck modifiers.
    _focusGraceUntil = performance.now() + 250;
    _releaseStuckModifiers();
    _releaseHeldEngineKeys();
    stop(ev);
  }, { capture: true });
  window.addEventListener('blur', (ev) => {
    // Same capture trap as focus above, and here it was doing real damage: _releaseStuckMouseButtons
    // pushes a mouse-up for three buttons at the CENTRE of the canvas, so clicking any rail control
    // fired a click into the world and instantly consumed an armed target.
    if (ev.target !== window && ev.target !== document) { return; }
    wasm_push_win_focus(0);
    _releaseStuckModifiers();
    _releaseStuckMouseButtons();
    _releaseHeldEngineKeys();   // held walk key across Alt+Tab → release it too, not just modifiers
    stop(ev);
  }, { capture: true });
  document.addEventListener('visibilitychange', (ev) => {
    if (document.hidden) { _releaseStuckModifiers(); _releaseStuckMouseButtons(); _releaseHeldEngineKeys(); }
    stop(ev);
  }, { capture: true });
  window.addEventListener('pagehide', stop, { capture: true });
  window.addEventListener('pageshow', stop, { capture: true });

  const pushKeyAndMaybeText = (ev, down) => {
    const keycode  = translateKey(ev);
    const scancode = translateScancode(ev);
    const mod      = computeKeymod(ev);
    wasm_push_key(down ? 1 : 0, keycode, scancode, mod, ev.repeat ? 1 : 0);
    // Text input: only on the FIRST press, not on OS repeat. Browser
    // key-repeat is ~60 Hz; SDL desktop is ~20-30 Hz. Letting repeat
    // fire pushText caused held chat keys to duplicate 2-3× desktop
    // rate (bug O48). CUO's UIManager.KeyboardFocusControl already
    // handles its own blink + repeat cadence for text boxes.
    //
    // 🚨 AltGr is NOT a Ctrl+Alt chord, and treating it as one made every AltGr character
    // untypeable on European layouts -- `[ ] { } @ # ~ \ | €` and the rest (operator
    // 2026-07-30, "sigo sin poder escribir [ y ]"). Windows fires a synthetic Ctrl_L +
    // Alt_R for it, so the raw flags say Ctrl and Alt are held while the user is just
    // typing. computeKeymod already knew this; this test did not, so the character was
    // correctly kept out of the hotkey path AND silently dropped instead of typed.
    // Same isAltGr() for both, so they cannot drift apart again.
    const altGr = isAltGr(ev);
    if (down && !ev.repeat && ev.key && ev.key.length === 1 &&
        (altGr || (!_domMods.ctrl && !_domMods.alt && !_domMods.meta))) {
      pushText(ev.key);
    }
  };

  // An HTML form control (rail panel search box, hotkey filter, script name
  // prompt, …) currently owns the keyboard. While one is focused the game
  // must NOT eat the keys: Backspace was preventDefault'd (couldn't delete
  // text) and arrows kept walking the character under the panel (player
  // report 2026-07-18). The canvas is never an editable element, so in-game
  // chat is unaffected — clicking back on the canvas restores game input.
  const editableHasFocus = () => {
    const a = document.activeElement;
    return !!a && a !== canvas &&
      (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' ||
       a.tagName === 'SELECT' || a.isContentEditable === true);
  };

  // Keys we've pushed keyDOWN to the engine and not yet keyUP'd. When a guard
  // STARTS suppressing keys mid-hold — a rail HTML input steals focus, or the
  // window blurs — the matching keyup is swallowed and the engine keeps the key
  // "down", walking the character forever (the modifier-only stuck-release net
  // never covered held WALK keys). Track them so those guards can synthesise the
  // releases the engine would otherwise never see. (Same synthetic-event shape
  // pushKeyAndMaybeText already accepts from _releaseStuckModifiers.)
  const _heldEngineKeys = new Map();          // ev.code → { key, code }
  window.__uoHeldEngineKeys = _heldEngineKeys; // debug/smoke handle (cf. __uoDomMods)
  const _releaseHeldEngineKeys = () => {
    if (!_inputReady || _heldEngineKeys.size === 0) return;
    for (const k of _heldEngineKeys.values()) {
      pushKeyAndMaybeText({ key: k.key, code: k.code, repeat: false,
        altKey: false, ctrlKey: false, shiftKey: false, metaKey: false,
        getModifierState: () => false }, false);
    }
    _heldEngineKeys.clear();
  };

  // Grace window after the window regains focus. Alt+Tab-ing back INTO the
  // game can deliver a stray Tab (and Alt) key event as focus lands, which
  // toggled war mode (player report 2026-07-18). Any Tab/Alt key event in
  // the first 250 ms after focus is part of the switch chord, not gameplay.
  let _focusGraceUntil = 0;
  const inFocusGrace = (ev) =>
    (ev.key === 'Tab' || ev.key === 'Alt') && performance.now() < _focusGraceUntil;

  // also installs a window.keydown/keyup listener. On the MT runtime
  // that handler calls `emscripten_proxy_sync` → `pthread_cond_wait`
  // on the main thread to forward the key to the deputy synchronously.
  // If the deputy is mid-zone-load (a few seconds after entering the
  // world), the main thread deadlocks waiting for the ack while the
  // deputy cannot respond. Symptom: image freezes, no input, no audio.
  // Captured stack in docs/TROUBLESHOOTING if reproduced.
  //
  // Our bridge already writes the key to the C ring buffer via
  // handler is redundant AND dangerous. Register with `capture: true`
  // listener never runs.
  // `preventDefault` set — keys that the browser would otherwise
  // act on (reload, tab-close, find) but that CUO macros want.
  // `navigator.keyboard.lock` handles this inside fullscreen Chrome,
  // but outside fullscreen or on Firefox / Safari the lock no-ops
  // and these keys fall through to the browser UI. Prevent the
  // default action for any scancode/key that's in KEY_LOCK_SET — if
  // the user bound a macro to F5 or Ctrl+R, this keeps the session
  // alive instead of reloading the page. User-report bug O47.
  const PREVENT_KEYS = new Set([
    'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
    'F13','F14','F15','F16','F17','F18','F19','F20','F21','F22','F23','F24',
    'Tab','Backspace',
  ]);
  const PREVENT_CODES = new Set([
    'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
    'F13','F14','F15','F16','F17','F18','F19','F20','F21','F22','F23','F24',
    'Tab','Backspace',
    // Control-combo keys the browser eats (Ctrl+R, Ctrl+W, Ctrl+T, ...).
    // Only preventDefault when ctrlKey or metaKey is pressed so bare
    // letters still reach text inputs.
    'KeyR','KeyT','KeyW','KeyN','KeyL','KeyJ','KeyI','KeyH','KeyD','KeyF','KeyS',
  ]);
  window.addEventListener('keydown', (ev) => {
    // Gameview screenshot (operator 2026-06-23): intercept PrintScreen FIRST so it
    // never reaches the engine keypath (no TUO Ctrl+PrintScreen gump-capture either)
    // and the browser/OS default is suppressed where possible. The in-client C#
    // capture is the only reliable path and fires regardless of OS suppression.
    if (ev.key === 'PrintScreen') {
      // Only STEAL PrintScreen once the engine is live (capture the gameview); during
      // boot let it fall through to the browser/OS so the key still does something.
      // Either way it is never forwarded to the engine keypath (we return early).
      if (_inputReady) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        try { window.UONexusScreenshot && window.UONexusScreenshot.capture(); } catch (e) {}
      }
      return;
    }
    if (!_inputReady) return;   // drop keystrokes until the engine is draining
    trackDomModifier(ev, true);
    // Rail hotkey-binding capture: rail.js raised __uoRailKeyCapture and owns
    // the next keydown (its own capture listener runs after this one — it only
    // ever sees the key because we neither push nor stopImmediatePropagation).
    if (window.__uoRailKeyCapture) { _releaseHeldEngineKeys(); return; }
    // Escape closes an open rail panel: return WITHOUT stopImmediatePropagation
    // so the event bubbles to the rail's own window keydown listener (which the
    // engine keypath would otherwise starve). We don't push Escape to the engine.
    if (window.__uoRailPanelOpen && ev.key === 'Escape') return;
    if (editableHasFocus()) { _releaseHeldEngineKeys(); return; }   // HTML input owns the keys — release any held game key first
    if (inFocusGrace(ev)) { _releaseHeldEngineKeys(); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    pushKeyAndMaybeText(ev, true);
    _heldEngineKeys.set(ev.code || ev.key, { key: ev.key, code: ev.code || ev.key });
    const inCanvas = document.activeElement === canvas;
    if (PREVENT_KEYS.has(ev.key)) {
      ev.preventDefault();
    } else if (ev.key === 'Enter' && inCanvas) {
      ev.preventDefault();
    } else if ((_domMods.ctrl || _domMods.meta) && PREVENT_CODES.has(ev.code)) {
      ev.preventDefault();
    }
    ev.stopImmediatePropagation();
  }, { capture: true });
  window.addEventListener('keyup', (ev) => {
    if (ev.key === 'PrintScreen') { if (_inputReady) { ev.preventDefault(); ev.stopImmediatePropagation(); } return; }
    if (!_inputReady) return;
    trackDomModifier(ev, false);
    if (window.__uoRailKeyCapture) { _releaseHeldEngineKeys(); return; }
    if (window.__uoRailPanelOpen && ev.key === 'Escape') return;  // symmetric with keydown
    if (editableHasFocus()) { _releaseHeldEngineKeys(); return; }
    if (inFocusGrace(ev)) { _releaseHeldEngineKeys(); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    pushKeyAndMaybeText(ev, false);
    _heldEngineKeys.delete(ev.code || ev.key);
    ev.stopImmediatePropagation();
  }, { capture: true });

  // ── Stuck-modifier release (v0.8.93) ──────────────────────────────
  // Operator bug: "right-click on the world map stopped opening its
  // options menu". Control.OnMouseUp gates ContextMenu.Show() on
  // !Keyboard.Alt && !Keyboard.Shift && !Keyboard.Ctrl — and in a
  // browser those flags STICK: Alt+Tab / Ctrl+C-to-copy-logs / tab
  // switches deliver the modifier keyDOWN to the page but the keyUP to
  // the OS, so CUO believes the modifier is held forever and silently
  // refuses to open any context menu (among other chord misfires).
  // Desktop SDL gets WM focus-loss key releases; the DOM does not. On
  // every window blur / tab-hide, synthesize keyups for all modifiers
  // with mod=0 so the engine's Keyboard state resets. Harmless when no
  // modifier was held (CUO ignores keyups for keys it doesn't think
  // are down).
  const _releaseStuckModifiers = () => {
    resetDomModifiers();   // page-witnessed state — always safe to clear
    if (!_inputReady) return;
    for (const key of ['Alt', 'Control', 'Shift', 'Meta']) {
      const fake = {
        key, code: key + 'Left', repeat: false,
        altKey: false, ctrlKey: false, shiftKey: false, metaKey: false,
        getModifierState: () => false,
      };
      pushKeyAndMaybeText(fake, false);
    }
  };

  // MOUSE twin of the stuck-modifier release (audit S2-1): a button released
  // while the window is unfocused never fires pointerup here (the window-level
  // fallback only covers releases outside the CANVAS, not outside the WINDOW),
  // so a right-mouse walk held across Alt+Tab kept the character walking
  // forever. Synthesize a release for every button on blur/hide — the engine
  // ignores mouse-ups for buttons it doesn't think are down, same as keyups.
  const _releaseStuckMouseButtons = () => {
    if (!_inputReady) return;
    try {
      const r = canvas.getBoundingClientRect();
      const sx = r.width > 0 ? canvas.width / r.width : 1;
      const sy = r.height > 0 ? canvas.height / r.height : 1;
      const cx = (r.width / 2) * sx, cy = (r.height / 2) * sy;
      for (const b of [1, 2, 3]) { wasm_push_mouse_button(0, b, cx, cy); }
    } catch (e) { /* canvas gone mid-teardown */ }
  };
  // The blur/focus/visibility hooks live INSIDE the capture listeners above
  // (wasm_push_win_focus block) — a listener registered here would never run:
  // those capture handlers stop(ev) with stopImmediatePropagation. The
  // original registrations at this spot were dead code from day one.

  console.log('[p4d7] DOM input bridge attached to canvas');
}

// --- Mobile early-out ----------------------------------------------
//
// The WASM client needs a keyboard, mouse, and a desktop-class GPU
// pipeline. Touch input + soft-keyboard support aren't implemented;
// running on a phone produces a blank canvas the user can't interact
// with. Detect the common phone/tablet shape early and short-circuit
// to a static splash with just Discord + GitHub buttons. The rest of
// the boot (game-file download, SSO gate, picker, WS connect) is
// skipped — saves the user from pulling several hundred MB of .mul
// data they can't use.
function isMobileDevice() {
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  // iPad on iPadOS 13+ reports `MacIntel` and a non-mobile UA, so the
  // narrow+coarse fallback catches it. Add explicit iPad guard for
  // belt-and-braces.
  const ua = navigator.userAgent || '';
  const ipad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const mobileUA = /Android|iPhone|iPod|Opera Mini|IEMobile|Mobile/i.test(ua);
  return mobileUA || ipad || (narrow && coarse);
}
if (isMobileDevice() && window.__bundle !== 'mini') {
  document.body.classList.add('mobile-view');
  // Throwing here aborts module evaluation — anything after this point
  // (file download, SSO, WASM init) doesn't run, so a phone visitor
  // never pulls a MB of game data. The MINI client SUPPORTS mobile (touch
  // mode + canvas-fit + ultra profile), so it must NOT short-circuit here —
  // only the desktop-only cuo/tuo webclient keeps the mobile block.
  throw new Error('mobile device — game disabled');
}

// --- Multi-server: registry fetch + picker -------------------------
//
// we render the picker after the SSO gate; with exactly 1 we auto-
// select. With 0 the proxy is mis-configured and we fail loudly.
//
// The chosen slug is stored in sessionStorage (per-tab) so a refresh
// returns to the same shard without re-prompting; the user can clear
// it with ?pickserver=1 to force the picker again.
// (minimal) chosenServerSlug is declared with chosenServer above; no pre-declaration needed.
let assetsManifest = {};
// Per-shard map { "<gamefile name>": "<sha256 of RAW bytes>" } from
// /api/servers/<slug>/hashes (the asset-worker's .br.sha256/.nowin sidecars).
// Used by fetchFileCached to verify a freshly-downloaded file's integrity on a
// cache MISS (operator req 2026-06-09: heavy-shard cold loads sometimes land
// corrupt/incomplete statics, fixed only by reopening the browser). Empty {} =
// no verification (older proxy, no sidecars yet) → boots exactly as before.
let expectedRawHashes = {};




async function fetchManifest(slug) {
  try {
    const r = await fetch(`/api/servers/${encodeURIComponent(slug)}/manifest`, { cache: 'no-cache' });
    if (!r.ok) return {};
    return await r.json();
  } catch (err) {
    console.warn(`[boot] manifest fetch failed for ${slug}:`, err);
    return {};
  }
}

// Per-shard raw-content hash map for cold-load integrity verification.
// Mirrors fetchManifest: best-effort, returns {} on any failure so a missing
// endpoint / older proxy degrades to "no verification" instead of blocking
// boot. Keys + values are lowercase (the asset-worker lowercases names; the
// endpoint lowercases the hex). See fetchFileCached for the verify path.
async function fetchRawHashes(slug) {
  try {
    const r = await fetch(`/api/servers/${encodeURIComponent(slug)}/hashes`, { cache: 'no-cache' });
    if (!r.ok) return {};
    return await r.json();
  } catch (err) {
    console.warn(`[boot] raw-hash map fetch failed for ${slug}:`, err);
    return {};
  }
}

// Rewrite a "gamefiles/<name>" URL to the content-addressed pool URL
// when the manifest knows the file. Falls back to the legacy URL when
// the manifest is empty or doesn't list the name. Pool URLs end in
// sends Content-Encoding: br.
//
// (from servers/<slug>.yaml, default `gamefiles`) becomes the URL
// prefix so two shards with different .mul trees can serve from
// `gamefiles` literal when the chosen shard hasn't set one (legacy
// On a corrupt-asset RECOVERY boot, the ONE offending file is re-fetched with a
// cache-buster so Cloudflare serves it fresh from origin instead of the stale edge copy
// that triggered the recovery (the immutable pool always has the right bytes at origin).
// Read once at load; '' on a normal boot → the wrapper below is a no-op.
const _recoverFile = (() => { try { return (sessionStorage.getItem('uo-recover-file') || '').toLowerCase(); } catch { return ''; } })();
const _recoverCb = String(Date.now());
window.__rewriteGamefileUrl = function rewriteGamefileUrl(name) {
  const base = (window.__chosenGamefilesUrlBase || 'gamefiles').replace(/^\/+|\/+$/g, '');
  const key = String(name || '').toLowerCase();
  // string_dictionary.uop is UNLOADABLE by the current engine and KILLS the boot for ANY
  // value of the file (proven deterministically 2026-06-18): ClassicUO's
  // StringDictionaryLoader sizes its decompress buffer to file.Length (the WHOLE .uop)
  // instead of the entry's compressedLength, so ZLib.ReadCRC reads the zero-padded buffer
  // tail [0,0,0,0] as the Adler-32 instead of the real zlib trailer → throws "CRC mismatch"
  // out of GameController.LoadContent. (Engine bug from the up33 sync; source/cuo is
  // read-only here so we can't patch the buffer size.) It's a post-AOS localized-strings
  // file Pre-AOS shards don't use, and StringDictionaryLoader.Load() returns gracefully when
  // the file is ABSENT (its File.Exists guard) — so returning null here = the loader never
  // mounts it = the engine never tries to decompress it = clean boot. (Only `eternal` even
  // ships one; remove this skip if/when the engine's StringDictionary buffer is fixed.)
  if (key === 'string_dictionary.uop') return null;
  // Append the cache-buster to the recovery file's URL only (everything else untouched).
  const cb = (url) => (_recoverFile && key === _recoverFile && url) ? (url + (url.includes('?') ? '&' : '?') + '__cb=' + _recoverCb) : url;
  // an EXISTENCE check too — files not listed are known-absent on
  // this shard, so we don't fetch them. Pre-fix the loader hammered
  // Animationframe*.uop, Unifont3-12, etc), each producing a 404 in
  // the network panel + a [warn] SKIP. Returning `null` here makes
  // fetchFileCached short-circuit without a network round-trip.
  // Empty manifest = legacy behaviour (try every REQUIRED_FILES entry).
  // method names (`toString`, `valueOf`, `hasOwnProperty`, `__proto__`,
  // etc) don't bypass the existence check. None of these names appear
  // in REQUIRED_FILES today, but the defensive form costs nothing.
  const manifestEmpty = !assetsManifest || Object.keys(assetsManifest).length === 0;
  if (!manifestEmpty && !Object.hasOwn(assetsManifest, key)) return null;
  const hash = assetsManifest[key];
  // v0.8.43 self-service shards: the bytes live at the owner's external base,
  // one file per NAME (not our content-addressed pool/<hash>.br layout). The
  // manifest's hash still drives the per-file sha256 verify (fetchRawHashes),
  // but the URL is the owner's `<externalBase>/<name>` — absolute, cross-
  // origin (CORS), no cookies. Existence check above still applies.
  const ext0 = window.__chosenExternalGamefilesUrl;
  if (ext0) return cb(`${ext0.replace(/\/+$/, '')}/${name}`);
  // stays valid when the page is served from a sub-path (e.g. an
  // `/embed/` mount). Pre-fix returned `gamefiles/<name>` which is
  // page-relative and 404s outside `/`. Single-shard `/`-rooted
  // deploys are unaffected.
  if (!hash) return cb(`/${base}/${name}`);
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  return cb(`/${base}/pool/${hash}${ext}.br`);
};


// --- Boot ----------------------------------------------------------



void applyServerConfig();

// before deciding on a server slug.
// ── ONE FIXED SHARD (this is the minimal build) ───────────────────────────
// The full client fetches /api/servers and puts a picker in front of the player. This build
// serves a SINGLE shard chosen by whoever self-hosts it, so there is nothing to pick: the
// whole registry + picker + guest-confirm path (~1000 lines) is gone, and minimal-boot.js
// sets window.__MINIMAL_SERVER from config.json before this module is evaluated.
//
// 🚨 THE SHAPE OF THAT OBJECT IS THE CONTRACT. Everything downstream reads the same fields a
// /api/servers record carries (slug, clientVersion, encrypt, gamefilesUrlBase,
// externalGamefilesUrl). Rename one and nothing throws — the loader quietly falls back to its
// defaults ('gamefiles', 7.0.45.1), so the symptom is a client that boots against the WRONG
// fileset, which looks like corrupt art rather than a config error.

// SSO gate — blocks the WASM boot until the player has chosen. discordInit() shows the
// #sso-panel and resolves on "Continue as guest", or immediately when already signed in.
// KEPT ON PURPOSE: this build carries full Discord login + cloud profile/settings sync.
await discordInit();

const chosenServer = (window.__MINIMAL_SERVER && typeof window.__MINIMAL_SERVER === 'object')
  ? window.__MINIMAL_SERVER
  : null;

if (!chosenServer || typeof chosenServer.slug !== 'string' || !chosenServer.slug.trim()) {
  // Fail LOUDLY and say what to edit. The alternative — booting with defaults — produces a
  // client that connects nowhere and looks broken for a reason nobody can see.
  document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#fff;'
    + 'background:#1a1208;text-align:center;height:100vh">'
    + '<h2>No shard configured</h2>'
    + '<p>Set your server in <code>config.json</code> next to index.html, then reload.</p>'
    + '<p style="opacity:.6">See README.md for the fields.</p></div>';
  throw new Error('minimal: window.__MINIMAL_SERVER is missing or has no slug');
}

let chosenServerSlug = chosenServer.slug.trim().toLowerCase();
sessionStorage.setItem('chosenServerSlug', chosenServerSlug);
window.__chosenServerSlug = chosenServerSlug;
// Stash the chosen shard's clientVersion for the WASM env-var resolver
// below (.withEnvironmentVariable('WASM_UO_CLIENT_VERSION', ...)).
// Falls back to the same default the server uses when the field is
// (minimal) chosenServer comes from window.__MINIMAL_SERVER above - there is no registry to search.
window.__chosenClientVersion = (chosenServer && chosenServer.clientVersion) || '7.0.45.1';
// #231 (operator 2026-07-16 "la versión del cliente de UO que cargará internamente"): a minigame may run a
// DIFFERENT UO client version than its shard's default. rail.js forwards the admin per-game `clientVersion` as
// ?clientver=X.Y.Z(.W). Mini-only so a stray ?clientver= on cuo/tuo can't change the main client; regex-gated to
// the UO-version shape; must be set before the loader reads __chosenClientVersion → the WASM `-clientversion` arg.
if (window.__bundle === 'mini') {
  try {
    const _cv = (new URLSearchParams(location.search).get('clientver') || '').trim();
    if (_cv && /^\d{1,2}\.\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(_cv)) {
      window.__chosenClientVersion = _cv;
      try { console.log('[mini] #231 UO client version pinned → ' + _cv); } catch { /* console silenced */ }
    }
  } catch { /* no URL / bad param → shard default */ }
}
// the correct cipher is active without the user having to configure anything.
// is the authoritative default; the resolver below still respects an explicit
// `?encrypt=` URL override for one-off testing.
window.__chosenEncrypt = (chosenServer && chosenServer.encrypt) || 'none';
// Falls back to legacy `gamefiles` for backward compat with proxies
// that haven't been upgraded to expose the field.
window.__chosenGamefilesUrlBase = (chosenServer && chosenServer.gamefilesUrlBase) || 'gamefiles';
// #231 (operator 2026-07-16 "definir qué slug usar de cara a los gamefiles"): a minigame may pin a DIFFERENT
// gamefiles base than its shard's default. rail.js forwards the admin per-game `gamefilesSlug` as ?gamefiles=<base>.
// It overrides ONLY the fileset base (the pool namespace + manifest), never the shard connection. Mini-only so a
// stray ?gamefiles= on cuo/tuo can't repoint the main client; regex-gated to the base alphabet; must be resolved
// before fetchAll (this runs pre-fetch). A base with no pool/manifest 404s the fileset — an admin-only power knob.
if (window.__bundle === 'mini') {
  try {
    const _gf = (new URLSearchParams(location.search).get('gamefiles') || '').trim().toLowerCase();
    if (_gf && /^[a-z0-9][a-z0-9-]{0,62}$/.test(_gf)) {
      window.__chosenGamefilesUrlBase = _gf;
      try { console.log('[mini] #231 gamefiles base pinned → ' + _gf); } catch { /* console silenced */ }
    }
  } catch { /* no URL / bad param → shard default */ }
}
// v0.8.43 self-service shards: when the chosen shard is owner-hosted, its
// gamefile BYTES live at an external https base (CORS + manifest). The rewrite
// below points the loader straight at it; /api/servers/:slug/manifest + /hashes
// still come from us (we relay the owner's KB manifest for the existence check
// + sha256 verify). Absent → our pool, as before.
window.__chosenExternalGamefilesUrl = (chosenServer && chosenServer.externalGamefilesUrl) || '';

// Pull the manifest for the chosen shard. Empty {} means single-shard
// legacy fallback — fetchFileCached will use the raw /gamefiles/<name>
// path.
assetsManifest = await fetchManifest(chosenServerSlug);
window.__assetsManifest = assetsManifest;

// Raw-content hash map for cold-load integrity verification (see
// fetchFileCached). Best-effort; {} = verification disabled (boots as before).
expectedRawHashes = await fetchRawHashes(chosenServerSlug);
window.__expectedRawHashes = expectedRawHashes;


// Reveal the loading section (progress bar + status) now that the SSO
// gate + picker have closed.
const loadingSection = document.getElementById('loading-section');
if (loadingSection) loadingSection.style.display = 'flex';

// ── Request DURABLE (non-evictable) storage before the first OPFS write ──
// OPFS is "best-effort" by default: Chrome silently evicts it under storage
// pressure or for low-engagement origins, so a returner's ~1.3 GB boot-file
// cache can vanish between sessions → the entire asset set re-downloads from
// the NAS origin (the operator's "debería estar en caché pero tarda 56s").
// navigator.storage.persist() upgrades the origin to PERSISTENT storage, which
// Chrome will not evict, making the OPFS cache actually durable for returners.
// This does NOT speed the FIRST visit (that download is unavoidable without
// deferring world files) — only repeat visits. Harmless if the UA denies it;
// raced against a 2 s timeout so a hung permission check can never stall boot,
// and the underlying request still completes in the background even if the race
// times out. The GRANTED/denied log line lets the smoke test confirm the fix.
try {
  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    const _timeout = (ms) => new Promise((r) => setTimeout(() => r(undefined), ms));
    const already = (typeof navigator.storage.persisted === 'function')
      ? await Promise.race([navigator.storage.persisted(), _timeout(2000)])
      : false;
    if (already === true) {
      console.log('[loader] OPFS storage already PERSISTENT — boot-file cache survives sessions');
    } else {
      const granted = await Promise.race([navigator.storage.persist(), _timeout(2000)]);
      console.log(`[loader] navigator.storage.persist() → ${granted === true
        ? 'GRANTED (OPFS cache now durable — returners skip the re-download)'
        : 'denied/best-effort (OPFS cache may be evicted between sessions)'}`);
    }
  }
} catch (e) {
  console.warn('[loader] storage.persist() check failed (non-fatal):', e?.message ?? e);
}

// Now that we know which shard, kick off the parallel game-file pull.
// Each fetchFileCached call rewrites its URL via the manifest, so
// pool blobs are used when available and the legacy /gamefiles/<name>
// path is the fallback.
// Report the previous boot BEFORE this one overwrites the receipt.
_bootReceiptReport();
_cacheReceiptReport();
_bootStage('loading-assets');
const filesPromise = fetchAll();
const files = await filesPromise;

_bootStage('mounting-world');
uiStatus('Mounting the world into memory…');
uiDetail('');
uiProgress(1);

const canvas = document.getElementById('canvas');

// Game Mode wiring — fullscreen + keyboard.lock so F1-F24, numpad,
// Ctrl+R/T/W/L, Tab, Esc flow to CUO macros. See wireGameMode()
// comments above for the full rationale. Install BEFORE the input
// bridge so the auto-trigger's capture-phase mousedown hook
// out-orders the bridge's regular-phase handler.
const stageEl = document.getElementById('stage');
if (stageEl) wireGameMode(stageEl, canvas);

let capturedModule = null;
// (profile.json, gumps.xml, macros.xml, skillsgroups.xml, etc.).
// We hold runMain until this fires so CUO doesn't write defaults
// over existing cached state on startup.
let idbfsReady = null;
// Set when /Data is deliberately NOT persisted (embedded mini) or when the origin's
// storage quota rejected a write. Either way further flushes are pointless: each one
// walks the whole /Data tree in pruneDataExceptWhitelist() ON THE MAIN THREAD before
// calling syncfs, so retrying a doomed write every 10 s costs frames for nothing.
let _idbfsDisabled = false;

// Loader-fade state.
let loaderHidden = false;
function hideLoaderOnce(reason) {
  if (loaderHidden) return;
  loaderHidden = true;
  console.log('[loader] hide:', reason);
  uiHide();
}

// C# -> JS lifecycle bridge. The C# side calls
// `MAIN_THREAD_EM_ASM` -> this `globalThis.__uo_signal` -> a
// `cuo:<name>` CustomEvent listeners can subscribe to. Replaces the
// prior pattern of having C# emit magic trace strings via
// Console.Error.WriteLine and main.js sniffing the console for them
// — that pattern leaked the trace text into prod DevTools and broke
// when the runtime cached `console.error` early or when the silencer
// no-op'd it. Direct call: silencing has no effect, ordering is
// deterministic, the names are part of the public contract listed
globalThis.__uo_signal = (name) => {
  try { window.dispatchEvent(new CustomEvent('cuo:' + name)); }
  catch { /* listeners are best-effort */ }
};

// --- Facet swap (R1): instrumentation + crossfade ≤100ms ---
// Signals emitted from C# (World.MapIndex setter + GameScene.Update +
// GameScene.Draw):
//   facet-swap-begin_<from>_<to>   start of MapIndex setter (multi-facet 0-5)
//   facet-swap-end-setter          new Map() ctor returned (heavy CPU done)
//   facet-swap-first-update        first GameScene.Update tick post-swap
//   facet-swap-first-draw          first GameScene.Draw paint (user sees world)
//   facet-swap-transition-cleared  30 Update frames elapsed (flag auto-clear)
//
// We wrap __uo_signal (kept above) so the existing cuo:<name> CustomEvent
// dispatch contract is preserved. The facet-swap names ALSO emit cuo:
// events for any future subscriber, but the heavy lifting (perf marks +
// crossfade UI) happens here, not via the event bus.
//
// Crossfade hard cap = 100 ms: 50 ms fade-in + 50 ms fade-out scheduled
// at t=50 regardless of swap progress. If first-draw arrives later it
// just confirms the fade-out (already in flight). If it arrives earlier
// (rare — swap genuinely <50ms), we accept the visible overlay still
// briefly lingering; the cost of clipping it shorter outweighs the win.
{
  const _underlyingSignal = globalThis.__uo_signal;
  let _swapStartTime = 0;
  let _swapFromIdx = -1;
  let _swapToIdx = -1;
  let _crossfadeEl = null;
  let _crossfadeFadeOutTimer = 0;
  const CROSSFADE_FADE_MS = 50;          // fade-in OR fade-out duration
  const CROSSFADE_HOLD_BEFORE_OUT_MS = 50; // delay before fade-out starts
  // Total visible time: fade-in (50) overlapping with hold-then-fade-out
  // (50 + 50). Hard cap on opaque-near-1 duration = 100 ms.

  function ensureCrossfadeEl() {
    if (_crossfadeEl) return _crossfadeEl;
    _crossfadeEl = document.createElement('div');
    _crossfadeEl.id = 'facet-swap-crossfade';
    _crossfadeEl.setAttribute('aria-hidden', 'true');
    _crossfadeEl.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none',
      // Moongate-flavored radial: bright purple core fading to deep
      // void. Evokes the in-game moongate aesthetic without needing
      // to load a sprite asset (which would be its own paint cost).
      'background:radial-gradient(ellipse at center, rgba(190,140,255,0.55) 0%, rgba(40,10,80,0.85) 70%, rgba(0,0,0,0.95) 100%)',
      'opacity:0', 'z-index:9999',
      `transition:opacity ${CROSSFADE_FADE_MS}ms ease-in`,
    ].join(';');
    document.body.appendChild(_crossfadeEl);
    return _crossfadeEl;
  }

  function showCrossfade() {
    const el = ensureCrossfadeEl();
    el.style.transition = `opacity ${CROSSFADE_FADE_MS}ms ease-in`;
    // Force a reflow read so the browser commits opacity:0 before we
    // set it to 1 — otherwise the transition skips entirely.
    void el.offsetWidth;
    el.style.opacity = '1';
    clearTimeout(_crossfadeFadeOutTimer);
    _crossfadeFadeOutTimer = setTimeout(() => {
      el.style.transition = `opacity ${CROSSFADE_FADE_MS}ms ease-out`;
      el.style.opacity = '0';
    }, CROSSFADE_HOLD_BEFORE_OUT_MS);
  }

  function hideCrossfadeImmediate() {
    if (!_crossfadeEl) return;
    _crossfadeEl.style.transition = `opacity ${CROSSFADE_FADE_MS}ms ease-out`;
    _crossfadeEl.style.opacity = '0';
  }

  function onSwapBegin(from, to) {
    _swapStartTime = performance.now();
    _swapFromIdx = from;
    _swapToIdx = to;
    try { performance.mark('facet-swap-begin'); } catch {}
    console.log(`[facet-swap] begin: ${from} -> ${to}`);
    // Skip crossfade on the cold-login map set (-1 -> 0). It's not a
    // facet swap — it's the initial world load, already covered by the
    // existing #loader UI. Showing the purple moongate over a fresh
    // login looks confusing. Perf marks still fire (data is useful).
    if (from >= 0) {
      showCrossfade();
    }
  }

  function onSwapEndSetter() {
    const dt = performance.now() - _swapStartTime;
    try { performance.mark('facet-swap-end-setter'); } catch {}
    console.log(`[facet-swap] setter done: +${dt.toFixed(1)}ms (LoadMap + new Map ctor)`);
  }

  function onSwapFirstUpdate() {
    const dt = performance.now() - _swapStartTime;
    try { performance.mark('facet-swap-first-update'); } catch {}
    console.log(`[facet-swap] first Update: +${dt.toFixed(1)}ms`);
  }

  function onSwapFirstDraw() {
    const dt = performance.now() - _swapStartTime;
    try { performance.mark('facet-swap-first-draw'); } catch {}
    try { performance.measure('facet-swap-perceived', 'facet-swap-begin', 'facet-swap-first-draw'); } catch {}
    console.log(`[facet-swap] first Draw: +${dt.toFixed(1)}ms ← perceived unfreeze (${_swapFromIdx}->${_swapToIdx})`);
    hideCrossfadeImmediate();
  }

  function onSwapTransitionCleared() {
    const dt = performance.now() - _swapStartTime;
    try { performance.mark('facet-swap-transition-cleared'); } catch {}
    console.log(`[facet-swap] transition cleared: +${dt.toFixed(1)}ms (30 Update frames elapsed)`);
  }

  globalThis.__uo_signal = (name) => {
    // Delegate first: preserves the cuo:<name> CustomEvent contract for
    // every existing listener (LoginGump, player-created, gamescene-active).
    try { _underlyingSignal(name); } catch {}

    // Intercept facet-swap signals for perf marks + crossfade UI.
    try {
      if (name.startsWith('facet-swap-begin_')) {
        // Format: facet-swap-begin_<from>_<to>  (underscore payload
        // separator so a negative from-idx doesn't collide with the
        // dashes in the signal-name prefix).
        const tail = name.substring('facet-swap-begin_'.length);
        const fields = tail.split('_');
        const from = parseInt(fields[0], 10);
        const to = parseInt(fields[1], 10);
        if (Number.isFinite(from) && Number.isFinite(to)) {
          onSwapBegin(from, to);
        }
      } else if (name === 'facet-swap-end-setter') {
        onSwapEndSetter();
      } else if (name === 'facet-swap-first-update') {
        onSwapFirstUpdate();
      } else if (name === 'facet-swap-first-draw') {
        onSwapFirstDraw();
      } else if (name === 'facet-swap-transition-cleared') {
        onSwapTransitionCleared();
      }
    } catch (e) {
      console.warn('[facet-swap] handler error:', e?.message ?? e);
    }
  };
}
// --- End facet swap (R1) ---

// Loader / boot-marker listeners. The four signals C# fires:
//   entering-britannia -> char-select click, before scene transition
//   draw-heartbeat     -> every 60 frames during gameplay (BOOT_OK fallback)
//   player-created     -> World.CreatePlayer (belt-and-suspenders)
// 🚨 THE LOADER IS DISMISSED BY `cuo:input-armed`, NOT BY THESE SIGNALS.
// Reaching the login gump means the BOOT succeeded (BOOT_OK_KEY below), but
// not that the client can be typed into yet — see the input gate in
// installInputBridge(). Hiding the loader here used to reveal a login form
// whose keystrokes went into a ring buffer the engine was not draining, on a
// main thread still finishing its warm-up. That is the state the operator hit
// as "it freezes when I start typing my user and password".
//
// Keeping both on ONE event is deliberate: two separate conditions would drift
// apart and re-create a window where the form is visible but deaf.
window.addEventListener('cuo:input-armed', (e) => {
  hideLoaderOnce('input-armed:' + ((e && e.detail && e.detail.why) || '?'));
});
window.addEventListener('cuo:login-gump-added', () => {
  if (!_perfLoginMarked) { _perfLoginMarked = true; perfMark('LoginGump added'); }
  // all wired up, so a future cache mismatch on the SAME fingerprint
  // is almost certainly user network noise, not stale shell.
  try { localStorage.setItem(BOOT_OK_KEY, '1'); } catch {}
  // Tell the player what the remaining wait is FOR. Without this the extra
  // moment reads as the client having stalled at the very end of a long boot.
  uiStatus('Almost ready…');
  uiDetail('Finishing startup — the login screen accepts typing in a moment');
});
window.addEventListener('cuo:draw-heartbeat', () => {
  try { localStorage.setItem(BOOT_OK_KEY, '1'); } catch {}
});
window.addEventListener('cuo:player-created', () => {
  try { localStorage.setItem(BOOT_OK_KEY, '1'); } catch {}
});
// to whatever the rest of main.js wires up below (canvas resize,
// chrome-hide); no boot-marker handling needed here.

// v0.4.88: classify session kind (guest vs discord) BEFORE the .NET
// runtime starts so we can stamp it into Module.ENV during preRun.
// C# side reads via Environment.GetEnvironmentVariable("CUO_USER_KIND")
// in ProfileManager.Load to force-disable per-profile settings the
// operator wants kept off for Guests.
//
// /api/me returns { id, name, avatar } when authenticated (id IS the JWT sub).
// Ids that start with "guest-" are anonymous; anything else came from Discord
// OAuth (or the dev-login backdoor, treated as discord-equivalent).
// On fetch failure we default to "guest" — safer than leaking a
// discord-only path to an unidentified session.
let cuoUserKind = 'guest';
try {
  const _r = await fetch('/api/me', { credentials: 'same-origin' });
  if (_r.ok) {
    const _me = await _r.json();
    if (_me && _me.id && !String(_me.id).startsWith('guest-')) {
      cuoUserKind = 'discord';
    }
  }
} catch {}
console.log(`[cuo-init] session kind: ${cuoUserKind}`);
// ChunkSnapshot cache mode, resolved BEFORE the runtime is built.
//
// 🚨 THE DEFAULT IS NOW OFF, AND THAT IS A DELIBERATE LOSS OF PERFORMANCE. The cache is
// worth up to 30 fps on the same build -- the operator measured it -- but it is also the cause of
// the open ghost-statics defect: a chunk captured while part of its contents had already been freed
// is stored and reused, and the area comes back missing walls and other static art. Until that is
// fixed, an install that has expressed no opinion gets the correct picture rather than the fast one.
// The operator turns it back on per install from /admin (prod: the `chunk-snapshot-cache` runtime
// flag; minimal: the Chunk snapshot cache card).
//
// 🚨 AND IT IS AWAITED HERE, NOT FETCHED LATER, because .withEnvironmentVariable's argument
// below is evaluated the moment the builder chain is CONSTRUCTED. A value that lands after that is
// read by nothing at all: the panel would save, the client would report success, and the setting
// would do nothing -- the failure mode this project has already paid for more than once.
//
// Absent, unreadable or an old proxy that does not publish the field all mean OFF: an unknown falls
// to the side without the defect.
let cuoSnapshotServerMode = 'off';
try {
  const _rc = await fetch('/api/config', { cache: 'no-store', credentials: 'same-origin' });
  if (_rc.ok) {
    const _cfg = await _rc.json();
    if (_cfg && _cfg.chunkSnapshotCache === true) cuoSnapshotServerMode = 'full';
  }
} catch { /* keep 'off' */ }
console.log(`[cuo-init] chunk snapshot cache: ${cuoSnapshotServerMode} (server setting)`);

window.__cuoUserKind = cuoUserKind; // mini-runtime gates Discord-only features (Arena) on this

const { runMain, getAssemblyExports } = await dotnet
  .withModuleConfig({
    canvas,
    preRun: [
      (Module) => {
        Module.canvas = canvas;
        // v0.5.5: CUO_USER_KIND / CUO_SHARD_BASE are propagated to C#
        // via .withEnvironmentVariable() in the builder chain below
        // (the .NET boot-config env). A main-thread `Module.ENV.X = ...`
        // mutation does NOT reach the deputy worker where game code
        // runs under the .NET 10 MT runtime, so
        // Environment.GetEnvironmentVariable() returned empty there.
        // These Module.ENV writes are kept only for any main-thread
        // getenv(); the deputy reads the boot-config copy.
        Module.ENV = Module.ENV || {};
        Module.ENV.CUO_USER_KIND = cuoUserKind;
        Module.ENV.CUO_SHARD_BASE = window.__chosenGamefilesUrlBase || '';
        //
        // .NET 10's multithread runtime spawns its deputy/interop
        // workers via `new Worker(url, {name:"dotnet-worker-NNN", ...})`
        // that rewrites `transferredCanvasNames` never fires for the
        // deputy. Confirmed by instrumenting the patched L1885 block
        // with console.logs: no `[mt-hack]` line ever emits, while
        // we DO see `cmd=run moduleCanvasId=canvas offscreenCanvases=[]`
        // postMessages out of the runtime's own worker-spawn.
        //
        // Since the runtime asks the worker to read the canvas from
        // `data.offscreenCanvases[data.moduleCanvasId]` (see the
        // `Object.assign(GL.offscreenCanvases, data.offscreenCanvases)`
        // block in dotnet.native.*.js), we can satisfy the handshake
        // from outside by intercepting `.postMessage`: on the first
        // outgoing `cmd === 'run'` with a `moduleCanvasId`, we
        // `canvas.transferControlToOffscreen()` once and attach it
        // both to `msg.offscreenCanvases` and the transfer list.
        // Only the first deputy gets the canvas — subsequent workers
        // (interop threads) don't need it and can't receive it
        // anyway (OffscreenCanvas can only be transferred once).
        //
        // deputy produces `TypeError: Cannot read properties of
        // undefined (reading 'getParameter')` because
        // `GL.currentContext` stays null.
        if (!globalThis.__mtCanvasWired) {
          globalThis.__mtCanvasWired = true;
          const origPM = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function (msg, transferOrOpts) {
            try {
              if (msg && typeof msg === 'object'
                  && msg.cmd === 'run' && msg.moduleCanvasId === 'canvas'
                  && canvas && !canvas.__mtTransferred) {
                // If the runtime's own spawn path already put the
                // with OFFSCREENCANVAS_TO_PTHREAD flag, or a future
                // .NET version that does this natively), don't double-
                // transfer — transferControlToOffscreen throws
                // InvalidStateError on the second call.
                const alreadyInMsg = msg.offscreenCanvases
                  && Object.keys(msg.offscreenCanvases).length > 0;
                if (alreadyInMsg) {
                  canvas.__mtTransferred = true;
                  console.log('[mt-canvas] runtime already transferred; skipping shim');
                } else if (typeof canvas.transferControlToOffscreen === 'function'
                           && !canvas.controlTransferredOffscreen) {
                  const off = canvas.transferControlToOffscreen();
                  off.id = 'canvas';
                  canvas.__mtTransferred = true;
                  msg.offscreenCanvases = {
                    canvas: {
                      offscreenCanvas: off,
                      id: 'canvas',
                      canvasSharedPtr: 0,
                    },
                  };
                  const tl = Array.isArray(transferOrOpts)
                    ? transferOrOpts.slice()
                    : [];
                  tl.push(off);
                  console.log('[mt-canvas] transferred canvas to deputy worker');
                  return origPM.call(this, msg, tl);
                }
              }
            } catch (e) {
              console.warn('[mt-canvas] transfer failed:', e);
            }
            return origPM.apply(this, arguments);
          };
        }
        try { Module.FS.mkdir('/uo'); } catch { /* EEXIST ok */ }

        // thread; the syncfs callback fires on a microtask so it
        // overlaps the JS-thread writeFile loop. On a 638 MiB cold
        // is ~1-3 s; serialised they sum, parallel they max. Saves
        // 1-3 s of perceived boot time.
        const _idbfsStartedAt = performance.now();
        try {
          const idbfs = Module.FS?.filesystems?.IDBFS
                     ?? Module.IDBFS
                     ?? (typeof globalThis.IDBFS !== 'undefined' ? globalThis.IDBFS : null);
          if (!idbfs) throw new Error('IDBFS module not exposed by runtime');
          // Per-bundle IDBFS namespace. CUO (/) and TUO (/tuo/) are SAME-ORIGIN,
          // and Emscripten names the IDBFS database after the mountpoint
          // ('/Data') — so without this both bundles would persist their
          // /Data/Profiles into ONE IndexedDB and clobber each other (a
          // ClassicUO profile is not a TazUO profile). Suffix the DB name per
          // bundle. CUO keeps the legacy '/Data' (no migration loss); only
          // non-cuo bundles diverge to their own store ('/Data-tuo').
          const _idbNs = (_bundleId() === 'cuo') ? '' : ('-' + _bundleId());
          if (_idbNs && typeof idbfs.getDB === 'function' && !idbfs.__nsPatched) {
            const _origGetDB = idbfs.getDB.bind(idbfs);
            idbfs.getDB = (name, cb) => _origGetDB(name + _idbNs, cb);
            idbfs.__nsPatched = true;
            console.log(`[loader] IDBFS namespaced for bundle '${_bundleId()}' (DB '/Data${_idbNs}')`);
          }
          try { Module.FS.mkdir('/Data'); } catch { /* EEXIST ok */ }
          // The EMBEDDED mini does not persist /Data (operator 2026-07-26: TUO +
          // Tower Defense reached 99% and then "couldn't connect, retry"). Root cause
          // measured, and it is storage — not RAM: a minigame launched from inside a
          // full client puts TWO WASM clients on ONE origin, and the second one's
          // syncfs floods `QuotaExceededError` (31 consecutive failures in a 5-minute
          // repro) so its boot never settles. There is nothing worth persisting for a
          // minigame anyway — the accounts are ephemeral and player-derived, gumps are
          // hidden, no macros — so skip the mount entirely and leave /Data in MEMFS.
          // A STANDALONE /mini/ visit keeps persisting exactly as before; only the
          // embedded case (the failing one) changes.
          const _miniEmbedded = (typeof window !== 'undefined') && window.__MINI__ === true
                                && window.self !== window.top;
          if (_miniEmbedded) {
            console.log('[loader] embedded mini — /Data stays in MEMFS (no IDBFS, no origin-quota contention)');
            _idbfsDisabled = true;
            _capturedFS = Module.FS;
            idbfsReady = Promise.resolve();
          } else {
          Module.FS.mount(idbfs, {}, '/Data');
          perfMark('IDBFS /Data restore start');
          idbfsReady = new Promise((resolve) => {
            Module.FS.syncfs(true, async (err) => {
              const _idbfsMs = (performance.now() - _idbfsStartedAt).toFixed(0);
              if (err) console.warn(`[loader] IDBFS syncfs(load) error after ${_idbfsMs}ms:`, err);
              else console.log(`[loader] IDBFS /Data restored from IndexedDB in ${_idbfsMs}ms`);
              perfMark('IDBFS /Data restore done');
              // Discord cross-device sync: overlay the server profile
              // blob (if signed in and one exists) on top of the local
              // keeps profile/macros/gumps consistent across browsers.
              _capturedFS = Module.FS;
              await _discordOverlayProfile(Module.FS);
              resolve();
            });
          });
          }
        } catch (e) {
          console.warn('[loader] IDBFS mount failed (settings will not persist):', e.message || e);
          idbfsReady = Promise.resolve();
        }

        // mkdir-p helper: split the destination path on `/` and
        // create each intermediate directory if it doesn't exist.
        // REQUIRED_FILES now includes nested paths (e.g.
        // `music/digital/config.txt`) that would otherwise fail at
        // writeFile with ENOENT on the missing parent.
        const mkdirP = (relPath) => {
          const parts = relPath.split('/');
          parts.pop(); // drop the filename
          let cur = '/uo';
          for (const seg of parts) {
            if (!seg) continue;
            cur += '/' + seg;
            try { Module.FS.mkdir(cur); } catch { /* EEXIST ok */ }
          }
        };
        for (const [name, bytes] of files) {
          mkdirP(name);
          Module.FS.writeFile(`/uo/${name}`, bytes);
          _bootProgress();   // boot watchdog: mounting is advancing
        }
        console.log(`[loader] mounted ${files.length} files into /uo/`);

        // ── Background streamer for deferred giant anim files ──
        // On big-file legacy shards fetchAll() deferred anim2-5.mul so boot
        // didn't block on ~900 MB. Now that the world can load, stream them
        // in sequentially (concurrency 1 → don't starve the running game's
        // network/main-thread) and writeFile each into /uo. The C#
        // AnimationsLoader.EnsureMulFile opens each .mul lazily on the next
        // body access once its bytes are present, so creatures whose
        // graphics live in these files pop in a few seconds after world
        // entry instead of blocking the entire boot. Fire-and-forget.
        if (_deferredBgFiles.length) {
          const bgList = _deferredBgFiles.slice();
          const bgCache = _deferredBgCache;
          // v0.8.14: chunked + PRE-SIZED MEMFS write. A single
          // Module.FS.writeFile() of a ~300-500 MiB anim file blocks the main
          // thread ~400-700 ms (memfs capacity-grow + typed-array copy). Under
          // Mercury .NET MT the game loop lives on the deputy worker; every
          // proxied-to-main call (SDL event pump / GL) during that window
          // stalls — the 679/420/215 ms `[perf] upd=` hitches measured on
          // Memento right after world-entry (smoke v0.8.12).
          //
          // v0.8.13 split the copy into 8 MiB slices with an event-loop yield
          // between each, but that REGRESSED the tail: MEMFS grows its backing
          // store geometrically, so each FS.write past the current capacity
          // reallocs and copies the ENTIRE file-so-far — O(n^2) total, and the
          // last grow on a ~500 MiB file is a single ~870 ms main-thread stall
          // (smoke v0.8.13: upd=870 / 553 / 487 ms, max frame 994 ms — WORSE
          // than the monolithic writeFile it replaced).
          //
          // Fix: ftruncate the node to its final length ONCE up front (a single
          // allocation; the fresh typed array is lazily zero-paged by the
          // engine, near-free — pages are faulted in as the slices touch them).
          // With the node already at final capacity, every 8 MiB slice below is
          // a pure in-place copy that never reallocs, so each stays sub-frame
          // and the deputy keeps draining between yields. The file lands intact
          // (slices cover the whole range and overwrite the zero-fill), traded
          // for ~0.2 s of extra background wall-time per file. Bonus: peak
          // memory drops — never holds old+new backing buffers during a grow.
          // v0.8.15 INSTRUMENTATION (pure timing, no logic change): the v0.8.14
          // smoke proved the ftruncate pre-size was a NO-OP (p95 542 vs 543, max
          // 1022 vs 994). MEMFS ftruncate is NOT lazily zero-paged — it eagerly
          // allocates a new typed array and zero-fills it synchronously on main.
          // So before changing anything we MEASURE each phase to attribute the 5
          // streaming spikes precisely (instrument-before-fixing): time the
          // ftruncate call ALONE, the per-chunk FS.write (sum + max single chunk),
          // and the fetch — emitted as [bg-anim-timing]. Spike #1 (1022/upd903)
          // is during the first file's write window; this tells us ftruncate-vs-write.
          const writeFileChunked = async (path, bytes) => {
            const CHUNK = 8 * 1024 * 1024;
            if (bytes.length <= CHUNK) {
              const t0 = performance.now();
              Module.FS.writeFile(path, bytes);
              const ms = performance.now() - t0;
              return { ftruncateMs: 0, writeMs: ms, maxChunkMs: ms, chunks: 1 };
            }
            // v0.8.17: write to a `.part` temp node, atomic-rename on success
            // (see streamFileToMEMFS for the full race rationale — keeps the
            // real path ABSENT until fully written so C# never maps it partial).
            const tmpPath = `${path}.part`;
            const stream = Module.FS.open(tmpPath, 'w');
            let ftruncateMs = 0, writeMs = 0, maxChunkMs = 0, chunks = 0;
            try {
              // pre-size to final length: one allocation (v0.8.15: timed alone)
              const tT0 = performance.now();
              Module.FS.ftruncate(stream.fd, bytes.length);
              ftruncateMs = performance.now() - tT0;
              for (let off = 0; off < bytes.length; off += CHUNK) {
                const len = Math.min(CHUNK, bytes.length - off);
                const tW0 = performance.now();
                Module.FS.write(stream, bytes, off, len, off);
                const dW = performance.now() - tW0;
                writeMs += dW; if (dW > maxChunkMs) maxChunkMs = dW; chunks++;
                // yield → main thread drains the deputy's proxied-call queue
                await new Promise((r) => setTimeout(r, 0));
              }
            } finally {
              Module.FS.close(stream);
            }
            Module.FS.rename(tmpPath, path); // atomic: real path appears only now, fully written
            return { ftruncateMs, writeMs, maxChunkMs, chunks };
          };
          // v0.8.16 FIX (data-driven from the v0.8.15 instrument pass). The
          // v0.8.15 smoke timed every phase and proved them ALL cheap —
          // ftruncate 1-2 ms, the chunked write 55-84 ms (max single chunk
          // 2-3 ms, with a yield between chunks), the C# reclear scan 0.0 ms,
          // per-body decode+upload <2 ms. Yet the two biggest boot-transient
          // frames stayed at upd=797 / 942 ms — LARGER than any measured phase.
          // The only ops left UNMEASURED in the streaming window were the two
          // ~500 MiB main-thread allocations in fetchFileCached: the
          // `await res.arrayBuffer()` (one contiguous 500 MiB alloc+copy) and
          // the fire-and-forget `cachePut` (whose `opfsEncode(etag,bytes)`
          // builds ANOTHER 500 MiB buffer on main). Peak transient ~1.5 GB per
          // file (MEMFS node + arrayBuffer + cache buffer) → major GC pauses on
          // the main thread that stall the deputy → exactly those upd spikes.
          //
          // Fix: stream the response body straight into the MEMFS node with a
          // ReadableStream reader — the full file is NEVER materialized as one
          // JS buffer. Pre-size the node once via ftruncate(Content-Length)
          // (proven ~1 ms; keeps every write in-place, no geometric grow-storm),
          // then copy reader chunks into an 8 MiB staging buffer and FS.write +
          // yield each time it fills. Peak transient drops from ~1.5 GB to the
          // single MEMFS node + 8 MiB stage. Deferred anim files don't gate boot
          // (the client already reached the world before they land), so we SKIP
          // the OPFS/IDB persist for them — re-streamed in the background next
          // cold session, saving 1.5 GB of cache disk AND the cachePut GC churn.
          // The shared fetchFileCached path (with its HTTP/2 body-retry) is
          // untouched and remains the fallback if a stream breaks mid-way.
          const streamFileToMEMFS = async (path, src, fetchOpts) => {
            const rw = window.__rewriteGamefileUrl;
            const url = (typeof rw === 'function' ? rw(src) : `/gamefiles/${src}`) || `/gamefiles/${src}`;
            const res = await fetch(url, { cache: 'default', ...(fetchOpts || {}) });
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${src}`);
            if (!res.body) throw new Error(`no streamable body for ${src}`);
            const total = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
            // v0.8.17 RACE FIX (root cause of "mobiles/chars no se muestran").
            // This streamer is fire-and-forget from the boot mount flow, so it
            // runs DURING C# AnimationsLoader.Load(). The old code opened the
            // FINAL path and ftruncate'd it to full size up front → the node
            // existed (zero/partial) the instant the fetch headers resolved.
            // Whichever deferred .mul the streamer had reached when C# Load ran
            // (anim2.mul, first in the queue) was seen by C# as PRESENT, mapped
            // with zero/partial data, and therefore NOT queued as deferred —
            // EnsureMulFile never re-opened it after the real bytes landed, so
            // every body in that file rendered INVISIBLE permanently (anim3-5
            // streamed after Load, were absent, got pended + self-healed → only
            // anim2's creatures went missing). Fix: stream into a `.part` temp
            // node and atomic-rename on completion. The real path is ABSENT
            // until 100% written, so C# always pends every deferred .mul (the
            // [anim-defer] log flips from "3 pending: 2,3,4" to "4 pending:
            // 1,2,3,4") and only ever opens a complete file. Timing-independent.
            const tmpPath = `${path}.part`;
            const stream = Module.FS.open(tmpPath, 'w');
            let ftruncateMs = 0, writeMs = 0, maxWriteMs = 0, writes = 0, recvMs = 0, pos = 0;
            try {
              if (total > 0) {
                const tT0 = performance.now();
                Module.FS.ftruncate(stream.fd, total); // pre-size once → in-place writes
                ftruncateMs = performance.now() - tT0;
              }
              const STAGE = 8 * 1024 * 1024;
              const stage = new Uint8Array(STAGE);
              let stageLen = 0;
              const flush = () => {
                if (stageLen === 0) return;
                const tW0 = performance.now();
                Module.FS.write(stream, stage, 0, stageLen, pos);
                const dW = performance.now() - tW0;
                writeMs += dW; if (dW > maxWriteMs) maxWriteMs = dW; writes++;
                pos += stageLen; stageLen = 0;
              };
              const reader = res.body.getReader();
              for (;;) {
                const tR0 = performance.now();
                const { done, value } = await reader.read();
                recvMs += performance.now() - tR0;
                if (done) break;
                let off = 0;
                while (off < value.length) {
                  const take = Math.min(STAGE - stageLen, value.length - off);
                  stage.set(value.subarray(off, off + take), stageLen);
                  stageLen += take; off += take;
                  if (stageLen === STAGE) {
                    flush();
                    // yield → main thread drains the deputy's proxied-call queue
                    await new Promise((r) => setTimeout(r, 0));
                  }
                }
              }
              flush();
            } finally {
              Module.FS.close(stream);
            }
            Module.FS.rename(tmpPath, path); // atomic: real path appears only now, fully written
            return { ftruncateMs, writeMs, maxWriteMs, writes, recvMs, total: total || pos };
          };
          // v0.8.22: PLAYER-FIRST + overlapped streaming (was strict
          // sequential anim2→anim5). The local player's own character is the
          // one mobile guaranteed on screen at world-entry, and on big-file
          // legacy shards (Ultima Memento) the human paperdoll-equipment
          // animations live in the HIGHEST anim file (anim5.mul — proven by
          // the [naked-diag] trace: player shirt 0x045F / pants 0x03AD both
          // resolve to fileIndex=4). The old in-list-order stream put anim5
          // LAST, so the player stood naked for the full ~85 s it took to
          // download anim2+3+4 first (anim5 recv alone is only ~21 s). Fix:
          //   Phase 1 — stream the highest-index file ALONE at full pipe
          //             (default priority) → the player dresses in ~one file's
          //             download (~21 s here) instead of ~85 s.
          //   Phase 2 — stream the remaining files with bounded concurrency
          //             (2) at priority:'low' so they fill in behind the
          //             game's own latency-sensitive WS/API traffic without
          //             starving it (the reason the original was concurrency 1).
          // Net: player-dressed time drops ~4×, and the rest are no worse than
          // the old sequential tail (better when the pipe has spare capacity).
          // Heuristic note: "highest index == the player's file" holds for the
          // big-file legacy shards that defer; a future C#-driven priority
          // (the exact fileIndices the local player's body+equipment need, from
          // the MobileView [naked-diag] NOFRAMES path) would generalise it.
          const animIdx = (name) => {
            const m = /anim(\d*)\.mul$/i.exec(String(name));
            if (!m) return 0;
            return m[1] === '' ? 1 : parseInt(m[1], 10); // anim.mul=1, anim2.mul=2 …
          };
          const ordered = bgList.slice().sort((a, b) => animIdx(b[0]) - animIdx(a[0]));
          const streamOne = async ([src, dst], fetchOpts) => {
            try {
              mkdirP(dst);
              const tF0 = performance.now();
              const t = await streamFileToMEMFS(`/uo/${dst}`, src, fetchOpts);
              const totalMs = performance.now() - tF0;
              console.log(`[bg-anim] mounted ${dst} (${(t.total / 1048576).toFixed(1)} MiB, streamed→MEMFS, no buffer) — its bodies will now render`);
              console.log(`[bg-anim-timing] ${dst}: total=${totalMs.toFixed(0)}ms recv=${t.recvMs.toFixed(0)}ms ftruncate=${t.ftruncateMs.toFixed(0)}ms write=${t.writeMs.toFixed(0)}ms (${t.writes} writes, max-write=${t.maxWriteMs.toFixed(0)}ms)`);
            } catch (e) {
              console.warn(`[bg-anim] stream failed ${src}: ${e?.message ?? e} — falling back to buffered fetch`);
              try {
                mkdirP(dst);
                const { bytes } = await fetchFileCached(bgCache, src);
                const t = await writeFileChunked(`/uo/${dst}`, bytes);
                console.log(`[bg-anim] mounted ${dst} (${(bytes.length / 1048576).toFixed(1)} MiB, fallback buffered) — ftruncate=${t.ftruncateMs.toFixed(0)}ms write=${t.writeMs.toFixed(0)}ms (${t.chunks} chunks, max-chunk=${t.maxChunkMs.toFixed(0)}ms)`);
              } catch (e2) {
                console.warn(`[bg-anim] fallback also failed ${src}: ${e2?.message ?? e2}`);
              }
            }
          };
          // Bounded-concurrency pool (mirrors the boot loader's worker pattern)
          // so Phase 2 never runs more than `limit` giant streams at once.
          const runPool = async (items, limit, fn) => {
            let i = 0;
            const worker = async () => { while (i < items.length) { const j = i++; await fn(items[j]); } };
            await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
          };
          (async () => {
            console.log(`[bg-anim] streaming ${ordered.length} deferred anim file(s) post-boot (player-first: ${ordered.map(([s]) => s).join(' → ')})…`);
            // Phase 1: the player's file alone, full pipe, default priority.
            if (ordered.length) await streamOne(ordered[0]);
            // Phase 2: the rest, concurrency 2, deprioritised below game traffic.
            const rest = ordered.slice(1);
            if (rest.length) await runPool(rest, 2, (f) => streamOne(f, { priority: 'low' }));
            console.log('[bg-anim] all deferred anim files mounted');
          })();
        }

        // Integrity verification — only flag files the FS can't
        // stat (= mount/writeFile failed). Size 0 is legitimately
        // valid for many .def / .txt assets: which ones carry
        // data depends on era (e.g. Anim3.def + Anim4.def are
        // customisation, etc.) already tolerate empty files as
        // "no entries", matching the desktop CUO behaviour.
        // Flagging size==0 would era-couple this check.
        //
        // hues.mul is the canonical non-empty load-bearing asset;
        // if the shard admin misconfigured it there'd be a
        // STAT_ERR or the game would render greyscale — both are
        // already visible via other signals, not this check.
        const expected = files.map(([n]) => n);
        const missing = [];
        for (const name of expected) {
          try {
            const st = Module.FS.stat(`/uo/${name}`);
            if (!st) missing.push(`${name}=STAT_NULL`);
          } catch {
            missing.push(`${name}=STAT_ERR`);
          }
        }
        if (missing.length) {
          // Stringify so Puppeteer / DevTools console shows the
          // actual missing names instead of "[array Array]".
          console.warn('[loader] /uo integrity FAIL: ' + missing.join(', '));
        } else {
          console.log('[loader] /uo integrity OK (all files mounted; size varies by era)');
        }

        // read overlaps with the JS-thread file copy. See the

        // Loader-hide is now driven entirely by the C# -> JS signal
        // bridge installed at module scope (`globalThis.__uo_signal`
        // -> `cuo:login-gump-added` / `cuo:draw-heartbeat` /
        // `cuo:player-created` listeners). The earlier Module.printErr
        // sniff intercepted the same milestones via Mono stderr trace
        // strings, but: (a) leaked the strings to DevTools in prod,
        // calls into no-ops at compile, and (c) raced the runtime's
        // internal err() capture. The bridge is independent of console
        // routing so all three issues are gone — keep this comment as
        // the rationale for any future "should we re-add a printErr
        // sniff?" question.

        capturedModule = Module;
      },
    ],
  })
  .withEnvironmentVariable('FNA_PLATFORM_BACKEND', 'SDL2')
  // D3D11 and OpenGL backends; without this env var the driver
  // selection logic iterates and `PrepareWindowAttributes` fails
  // before OpenGL is evaluated, producing
  // are linked.
  .withEnvironmentVariable('FNA3D_FORCE_DRIVER', 'OpenGL')
  .withEnvironmentVariable('WASM_UO_WS_URL', (() => {
    const qs   = new URLSearchParams(location.search);
    // SECURITY (2026-06-08): the WS endpoint is ALWAYS this page's own host —
    // nginx proxies /ws to the game server. A client-supplied wsHost was a
    // STORED-MITM footgun: a crafted ?wsHost=evil.com link is auto-saved to
    // /api/settings on pagehide (discordSaveSettings) and restored on every
    // future load, pointing the game WebSocket — which carries the UO account
    // + password the user types — at an attacker host. So IGNORE any wsHost
    // param/saved value; lock the host to location.hostname. (wsPort/wsPath
    // stay overridable — they're same-host, no cross-host redirect.)
    const host = location.hostname;
    const port = qs.get('wsPort') ?? (location.port || (location.protocol === 'https:' ? '443' : '80'));
    const path = qs.get('wsPath') ?? '/ws';
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    // the shard from the registry on upgrade. Single-server deploys still
    // work without this — the proxy auto-selects the only registered
    // shard when the slug is missing.
    const slug = window.__chosenServerSlug || '';
    const sep  = path.includes('?') ? '&' : '?';
    let tail = slug ? `${sep}server=${encodeURIComponent(slug)}` : '';
    // #76 multi-minigame: the mini use-case may pin a minigame (runmatch/towerdefense) — carry it to the proxy so
    // it builds the per-minigame identity (role + account). Absent = TBH default. Mini bundle only.
    try {
    } catch { /* no use-case */ }
    // #113/#114 SPECTATOR: forward ?spectate=<charName> from the page URL to the proxy — it binds the
    // session to a pooled BLANK spectator account and the shard auto-begins the invisible-rabbit watch.
    // Mini bundle only; sanitized here AND at the proxy AND at the shard (defense in depth).
    try {
      if (window.__bundle === 'mini') {
        const _sp = (qs.get('spectate') || '').trim().replace(/[^a-zA-Z ]/g, '').slice(0, 16).trim();
        if (_sp) { tail += (tail.includes('?') ? '&' : '?') + 'spectate=' + encodeURIComponent(_sp); window.__uoSpectate = true; }
      }
    } catch { /* no spectate */ }
    return `${scheme}://${host}:${port}${path}${tail}`;
  })())
  // v0.5.5: CUO_SHARD_BASE / CUO_USER_KIND through the .NET boot-config
  // env — NOT Module.ENV, which never reaches the MT deputy worker where
  // game code runs. Without this, WorldMapGump's pre-baked-PNG prefetch
  // read an empty CUO_SHARD_BASE and always fell back to the 30-90 s
  // in-browser rebuild. __chosenGamefilesUrlBase is set far above (at
  // the shard pick); cuoUserKind is classified before the runtime starts.
  .withEnvironmentVariable('CUO_SHARD_BASE', window.__chosenGamefilesUrlBase || '')
  .withEnvironmentVariable('CUO_USER_KIND', cuoUserKind || '')
  // v0.8.94 A/B + diag switches (operator request: decide the snapshot
  // cache's fate with data on the SAME build, zero default change):
  //   ?snapshot=off  → no chunk snapshot cache (every chunk fresh from MUL)
  //   ?snapshot=mem  → F1 in-memory only, no OPFS persistence
  //   (absent/other) → full (today's behaviour)
  //   ?teleDiag=1    → re-arm the [tele-*] teleport dump (~300 lines/jump),
  //                    which is now OFF by default for everyone.
  .withEnvironmentVariable('CUO_SNAPSHOT_MODE', (() => {
    // ?snapshot= still wins over the operator's setting, in BOTH directions. It is the diagnostic
    // this project hands players and the discriminant the operator uses to tell "it is the cache"
    // from "it is the fileset", so it has to be able to force the cache ON as well as off -- which
    // it could not do while 'full' was merely what the absent case fell through to.
    try {
      const v = (new URLSearchParams(location.search).get('snapshot') || '').toLowerCase();
      if (v === 'off' || v === '0' || v === 'none') return 'off';
      if (v === 'mem' || v === 'f1') return 'mem';
      if (v === 'full' || v === 'on' || v === '1') return 'full';
      return cuoSnapshotServerMode;
    } catch { return cuoSnapshotServerMode; }
  })())
  .withEnvironmentVariable('CUO_TELE_DIAG', (() => {
    try { return new URLSearchParams(location.search).get('teleDiag') === '1' ? '1' : '0'; }
    catch { return '0'; }
  })())
  // v0.5.7: the page origin (e.g. https://uonexus.com). .NET's
  // HttpClient rejects a relative request URI with no BaseAddress
  // (net_http_client_invalid_requesturi); WorldMapGump builds the
  // absolute MapsCache URL as `${origin}/${shardBase}/MapsCache/...`.
  .withEnvironmentVariable('CUO_HTTP_ORIGIN', (typeof location !== 'undefined' && location.origin) || '')
  // Encryption mode — maps to ClassicUO.Network.Encryption.EncryptionType:
  //   old_bfish / 1      → OLD_BFISH (pre-1.25 shards)
  //   blowfish_1_25_36/2 → BLOWFISH_1_25_36 (exactly 1.25.36)
  //   blowfish / 3       → BLOWFISH (1.25.37–2.0.0)
  //   blowfish_2_0_3 / 4 → BLOWFISH_2_0_3 (2.0.3 era, fixed keys)
  //   twofish_md5 / 5    → TWOFISH_MD5 (post-2.0.3)
  //
  // Priority (highest wins):
  //   1. ?encrypt= querystring override (one-off testing)
  //   3. localStorage (backward compat, single-shard deploys without registry)
  //   4. '0' (NONE — last resort)
  //
  // shard's servers/<slug>.yaml field is now the authoritative source.
  .withEnvironmentVariable('WASM_UO_ENCRYPTION', (() => {
    const MAP = {
      'none':            0, '0': 0,
      'old':             1, 'old_bfish':        1, '1': 1,
      '1_25_36':         2, 'blowfish_1_25_36': 2, '2': 2,
      'blowfish':        3, '3': 3,
      '2_0_3':           4, 'blowfish_2_0_3':   4, '4': 4,
      'twofish':         5, 'twofish_md5':      5, '5': 5,
    };
    const qs        = new URLSearchParams(location.search);
    const fromQs    = qs.get('encrypt');
    const fromShard = (window.__chosenEncrypt || '').toString().toLowerCase().trim() || null;
    const fromLocal = (typeof localStorage !== 'undefined')
      ? localStorage.getItem('uo:encryption') : null;
    const raw = (fromQs ?? fromShard ?? fromLocal ?? '').toString().toLowerCase().trim();
    if (raw === '') return '0';
    const byte = MAP[raw];
    if (byte === undefined) {
      console.warn(`[loader] unknown encrypt=${raw} — falling back to 0 (NONE)`);
      return '0';
    }
    const source = fromQs    != null ? 'querystring'
                 : fromShard != null ? 'shard-default'
                 : 'localStorage';
    console.log(`[loader] encryption=${byte} (from ${source}: ${raw})`);
    return String(byte);
  })())
  // alongside the slug, and the picker stashes the chosen value on
  // window.__chosenClientVersion. Program.cs reads this env var and
  // hands it to CUO's `-clientversion` arg, so different shards on
  // the same proxy can run different protocol revisions.
  .withEnvironmentVariable('WASM_UO_CLIENT_VERSION', (() => {
    const v = (window.__chosenClientVersion || '').toString().trim();
    // Defensive validation — Program.cs trusts whatever lands here, so
    // if a malformed value somehow gets stashed (older proxy, broken
    // rather than feeding garbage into CUO's version parser.
    const ok = /^\d{1,2}\.\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(v);
    if (!ok) {
      if (v) console.warn(`[loader] WASM_UO_CLIENT_VERSION='${v}' invalid — falling back to 7.0.45.1`);
      return '7.0.45.1';
    }
    console.log(`[loader] clientVersion=${v}`);
    return v;
  })())
  // MINI auto-login gate (read by mini-wasm/Program.cs). '1' makes CUO autologin +
  // a placeholder username so LoginScene auto-submits the 0x80 (the proxy rewrites
  // it to the real Discord/guest account → straight to the world, no LoginGump
  // stall). Driven by the use-case login mode: discord-auto/guest (or any mini
  // bundle with no use-case) → '1'; 'picker' (desktop-window) → '0' (manual login).
  // Empty for the non-mini main client (cuo/tuo never autolog in). Ported from the
  // mini fork during the fase3 collapse — without it the mini sits at the LoginGump.
  .withEnvironmentVariable('WASM_MINI_AUTOLOGIN', (() => {
    try {
      if (typeof window === 'undefined' || window.__bundle !== 'mini') return '';
      const uc = window.__MINI_USECASE;
      const login = uc && typeof uc.login === 'string' ? uc.login : '';
      const on = login !== 'picker';
      console.log(`[loader] WASM_MINI_AUTOLOGIN=${on ? '1' : '0'} (use-case login=${login || '(default)'})`);
      return on ? '1' : '0';
    } catch { return ''; }
  })())
  .create();

perfMark('runtime ready (post-create, pre-runMain)');

if (capturedModule) {
  installInputBridge(canvas, capturedModule);
} else {
  console.error('[p4d7] preRun never captured Module — input bridge disabled');
}

// so CUO's profile loader sees the cached files (if any).
if (idbfsReady) {
  _bootStage('restoring-settings');
  uiStatus('Loading your saved settings…');
  await idbfsReady;
}

_bootStage('starting-engine');
uiStatus('Starting up…');
uiDetail('');

// This is just the absolute-last-resort safety net so the user never
// stares at "Starting up…" forever if CUO somehow starts without
// emitting either trace. It arms input as well: revealing the client while
// the keyboard stays gated would put back the exact "form that eats your
// keystrokes" state the input gate exists to remove.
setTimeout(() => {
  try { if (globalThis.__uoArmInput) globalThis.__uoArmInput('loader-timeout-15s'); } catch {}
  hideLoaderOnce('timeout-15s');
}, 15_000);

// (profile, gump positions, macros) survive a reload.
if (capturedModule) {
  const M = capturedModule;
  // Per-request counter + elapsed-ms log so "a veces se guarda, a
  // veces no" can be diagnosed from console.txt (user report
  // didn't commit (likely tab torn down before onsuccess fired).
  let _flushSeq = 0;
  const flush = (why) => {
    if (_idbfsDisabled) return;
    const seq = ++_flushSeq;
    try {
      const started = performance.now();
      // Layer 1 of the on-disk whitelist: prune everything outside
      // non-whitelisted files (journal logs, packet dumps, marker
      pruneDataExceptWhitelist(M.FS);
      M.FS.syncfs(false, (err) => {
        const ms = (performance.now() - started).toFixed(0);
        if (err) {
          console.warn(`[loader] IDBFS flush #${seq} error: ${why} (${ms}ms)`, err);
          // Out of origin storage: the write will keep failing, so stop paying for it.
          // Measured 2026-07-26 with two clients in one tab — 31 consecutive
          // QuotaExceededError flushes, each preceded by a full-tree prune on main.
          if (/quota/i.test(String(err && (err.name || err.message || err)))) {
            _idbfsDisabled = true;
            console.warn('[loader] origin storage is full — settings will not persist this session (further flushes disabled)');
          }
        } else console.log(`[loader] IDBFS flush #${seq} ok: ${why} (${ms}ms)`);
        // flush. Throttled to 30 s on regular ticks; pagehide/hidden
        // pass force=true so the final upload always fires.
        if (_discordUser) {
          // 'user-edit' forces too, and that is the point: the 30 s throttle is fine for the 5 s
          // autosave tick, but it left anything the player had just AUTHORED — a macro, a
          // keybind — living only in this browser for up to half a minute. Clearing site data
          // inside that window destroyed work that looked saved, with nothing on screen hinting
          // there was a wait. (operator, 2026-08-12: "a ver si es que yo no esperé".)
          const force = (why === 'hidden' || why === 'pagehide' || why === 'beforeunload'
            || why === 'user-edit');
          void uploadProfileBlob(force);
        }
      });
    } catch (e) {
      console.warn(`[loader] IDBFS flush #${seq} threw: ${why}`, e);
    }
  };
  // after ProfileManager.Save on the auto-save tick (5 s; see
  // GameController._wasmAutoSaveIntervalMs). Fire-and-forget — the
  // IDB tx commits async and any in-flight tx coalesces with the
  // next call.
  globalThis.__wasm_flush_idbfs = () => flush('cuo-auto-save');

  // Push what the player just authored, now — bypasses the 30 s upload throttle. Debounced,
  // because editing a macro is a BURST (name, keybind, one call per action) and each of those
  // would otherwise mean a full tar+gzip+PUT of the profile.
  let _userEditTimer = null;
  globalThis.__uoFlushProfileNow = () => {
    if (_userEditTimer) clearTimeout(_userEditTimer);
    _userEditTimer = setTimeout(() => { _userEditTimer = null; flush('user-edit'); }, 1200);
  };

  // JS-side periodic flush. Under .NET 10 MT (Mercury) the C# →
  // wasm_flush_idbfs → JS bridge is unreachable from the deputy
  // worker (where C# runs) and every main-thread JS scheduler
  // (setInterval, setTimeout, requestAnimationFrame on main) is
  // starved or suspended for one of two reasons:
  //   1. Emscripten's pthread mailbox (Atomics + Promise.then)
  //      saturates main's microtask queue, starving DOM timer
  //      macrotasks.
  //   2. The OffscreenCanvas is transferred to the deputy worker
  //      so main has no compositor work; Chrome suspends rAF on
  //      idle main threads after a few ticks.
  // Solution: spawn our own dedicated same-origin Worker. Workers
  // have independent event loops, so setInterval inside the worker
  // fires reliably regardless of main's compositor state. The
  // worker posts a tick every 10 s; main's `worker.onmessage`
  // handler runs as a regular DOM event task (separate from the
  // rAF/timer scheduler) and calls flush() locally.
  //
  // The worker URL is resolved via `new URL('./lib/...',
  // import.meta.url)` so it's same-origin and allowed by the page
  // CSP `script-src 'self'`. flush() is gated on `body.in-game`
  // (set by the viewport handler on cuo:gamescene-active /
  // player-created) so pre-game ticks are no-ops.
  //
  // Failed attempts kept around as historical postmortems in
  // release-highlights-v0.4.32 / 34 / 35-38 / 42.md — every other
  // approach we tried ended in a runtime crash, a CSP block, or
  // silent starvation under MT.
  try {
    const pollWorker = new Worker(
      new URL('./lib/js-poll-worker.mjs', import.meta.url),
      { type: 'module' }
    );
    pollWorker.addEventListener('message', (e) => {
      if (!e || !e.data || e.data.kind !== 'js-poll-tick') return;
      if (document.body && document.body.classList && document.body.classList.contains('in-game')) {
        try { flush('js-poll'); } catch (err) { console.warn('[js-poll] flush threw:', err); }
      }
    });
  } catch (err) {
    console.warn('[js-poll] failed to start poll worker:', err);
  }

  // Tab-lifecycle flushes. `beforeunload` on Chrome is strictly
  // fire-and-forget: the browser is NOT required to wait for async
  // IDB transactions before tearing the tab down, so "user
  // se guarda, a veces no" matches this race exactly.
  //
  // Real fix: save on `visibilitychange -> hidden`. That fires
  // BEFORE unload for any user-initiated close (alt-F4, tab-X,
  // window close, mobile swipe-to-close) and BEFORE
  // `document.visibilityState` flips to frozen. Chrome explicitly
  // gives async work started in a visibilitychange handler a
  // commit budget (usually seconds). We still register pagehide
  // + beforeunload as last-ditch coverage — they're fine for the
  // rare case where hidden didn't fire (e.g. Ctrl+F5 on a tab
  // already in foreground).
  let _unloadFlushFired = false;
  const unloadFlush = (why) => {
    if (_unloadFlushFired) return;
    _unloadFlushFired = true;
    flush(why);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      unloadFlush('hidden');
    } else if (document.visibilityState === 'visible') {
      // User came back to the tab — rearm the one-shot so the
      // next hide/unload also flushes.
      _unloadFlushFired = false;
    }
  });
  window.addEventListener('pagehide', () => unloadFlush('pagehide'));
  window.addEventListener('beforeunload', () => unloadFlush('beforeunload'));
}

// they survive cache wipes without the user having to re-enter them.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void discordSaveSettings();
});
window.addEventListener('pagehide', () => void discordSaveSettings());

// ── Clipboard bridge ───────────────────────────────────────────────
// CUO text boxes copy/paste through SDL's clipboard, which on wasm is
// an in-process buffer disconnected from the browser clipboard. The
// native shims wasm_clipboard_set / wasm_clipboard_get (SDL3.c) call
// the handlers below. `mirror` is the source of truth C# reads back;
// it is fed by C# copies AND by the DOM `paste` event — the only
// synchronous, permission-free read of the real system clipboard.
(function wireWasmClipboard() {
  let mirror = '';
  globalThis.__wasm_clipboard_set = function (text) {
    mirror = (typeof text === 'string') ? text : '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        // Best-effort push to the OS clipboard so the game selection
        // can be pasted into other apps. May reject without a
        // transient user gesture (notably Firefox) — the in-game
        // mirror still works regardless, so swallow the rejection.
        navigator.clipboard.writeText(mirror).catch(function () {});
      }
    } catch (e) { /* clipboard API absent or blocked */ }
  };
  globalThis.__wasm_clipboard_get = function () { return mirror; };
  // Ctrl+V keydown is NOT preventDefault'd by the input bridge (KeyV
  // is absent from PREVENT_CODES), so the browser still fires `paste`.
  // It dispatches in the same task as the keydown — before CUO's
  // frame-deferred Ctrl+V handler reads the mirror back.
  window.addEventListener('paste', function (ev) {
    try {
      const cd = ev.clipboardData || window.clipboardData;
      if (cd) {
        const t = cd.getData('text/plain') || cd.getData('text') || '';
        if (t) mirror = t;
      }
    } catch (e) { /* getData unavailable */ }
  }, true);
  console.log('[clipboard] wasm clipboard bridge installed');
})();

// Web Audio bridge — CUO uses FAudio on desktop, not linked on wasm.
// the browser's AudioContext instead. C# calls these via
(function wireWasmAudio() {
  let audioContext = null;
  let _miniMuted = false; // mini host-overlay mute (mini-runtime.js → __miniAudioCtl); always false for cuo/tuo
  // #224 split audio buses (mini-only): SFX (PCM combat/footsteps via __wasm_play_pcm)
  // and MUSIC (client MIDI/digital via __wasm_play_music[_url]) each get their OWN lazy
  // gain node so the two rail sliders (Music / Sound) attenuate independently. cuo/tuo
  // bypass both (return ctx.destination) → byte-identical direct path.
  let _sfxGain = null;    // mini SFX gain node (lazy); __wasm_play_pcm routes here
  let _sfxVol = 1;        // 0..1 mini SFX volume (cuo/tuo stay at 1 → transparent)
  let _musicGain = null;  // mini MUSIC gain node (lazy); __wasm_play_music[_url] route here
  let _musicVol = 1;      // 0..1 mini MUSIC volume
  const ensureContext = () => {
    if (!audioContext) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      audioContext = new Ctor();
    }
    // Chrome requires a user gesture before audio can play. The
    // unlock() listener below resumes the context on first click /
    // keydown. If the runtime calls in before that, audioContext is
    // in 'suspended' state and .start() on a source node is a silent
    // no-op until resume fires.
    if (audioContext.state === 'suspended' && !_miniMuted) audioContext.resume().catch(() => {});
    return audioContext;
  };
  const unlock = () => { ensureContext(); };
  document.addEventListener('click', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });
  document.addEventListener('pointerdown', unlock, { once: true });
  // mini host-overlay audio control (mini-runtime.js drives this from mini:mute /
  // mini:vol messages). Coarse mute = suspend the whole AudioContext (silences
  // sfx + PCM); volume is left to the TBH music module. mini-only — never set for
  // cuo/tuo, so their audio path is byte-identical.
  if (window.__bundle === 'mini') {
    window.__miniAudioCtl = {
      setMuted(m) { _miniMuted = !!m; if (audioContext) { if (m) audioContext.suspend().catch(() => {}); else audioContext.resume().catch(() => {}); } },
      // #224 independent buses. SFX = WASM combat/footstep PCM; MUSIC = client MIDI/digital
      // tracks. setMuted still suspends the whole context for a hard mute. Before this a
      // single slider drove both (operator 2026-07-05 "el slider de volumen no funciona"
      // → fixed as one bus; now split into two per operator 2026-07-14).
      setSfxVolume(v) {
        _sfxVol = Math.max(0, Math.min(1, Number(v) || 0));
        if (_sfxGain) { _sfxGain.gain.value = _sfxVol; }
      },
      setMusicVolume(v) {
        _musicVol = Math.max(0, Math.min(1, Number(v) || 0));
        if (_musicGain) { _musicGain.gain.value = _musicVol; }
      },
      // Back-compat: an older rail that posts only mini:vol drives BOTH buses at once.
      setVolume(v) { this.setSfxVolume(v); this.setMusicVolume(v); },
    };
  }

  const active = new Map();
  let nextHandle = 1;

  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

  // Mini master-volume bus (operator 2026-07-05): route EVERY WASM sound through one gain node so the mini
  // volume slider actually attenuates sfx (not just mute/unmute). cuo/tuo return the raw destination →
  // byte-identical direct path (the master bus is mini-only). Seeds from the boot volume on first use.
  const _sfxOut = (ctx) => {
    if (window.__bundle !== 'mini') { return ctx.destination; }
    if (!_sfxGain) {
      _sfxGain = ctx.createGain();
      try { if (window.__miniAudioState && typeof window.__miniAudioState.sfxVolume === 'number') { _sfxVol = window.__miniAudioState.sfxVolume; } } catch { /* default 1 */ }
      _sfxGain.gain.value = _sfxVol;
      _sfxGain.connect(ctx.destination);
    }
    return _sfxGain;
  };
  const _musicOut = (ctx) => {
    if (window.__bundle !== 'mini') { return ctx.destination; }
    if (!_musicGain) {
      _musicGain = ctx.createGain();
      try { if (window.__miniAudioState && typeof window.__miniAudioState.musicVolume === 'number') { _musicVol = window.__miniAudioState.musicVolume; } } catch { /* default 1 */ }
      _musicGain.gain.value = _musicVol;
      _musicGain.connect(ctx.destination);
    }
    return _musicGain;
  };

  // keyed by exact (channels, sampleRate, framesPerChannel) shape.
  // ~6 PCM/sec alternating between two shapes (17980 + 15060 byte
  // unpooled dispatch allocates a Float32Array + AudioBuffer +
  // BufferSource + GainNode → GC pressure → ~50 ms long-frames every
  // 1-2 s. The pool collapses Float32Array + AudioBuffer reuse;
  // BufferSource + Gain still alloc per call because BufferSource is
  // one-shot, but they're cheap relative to the 18k-element conversion.
  //
  // is shared with any still-playing BufferSource that captured it.
  // Overwriting via copyToChannel mid-playback would glitch the
  // earlier sound. Each shape keeps a pool of buffers; we lend one
  // to the source and return it on `onended`.
  //
  // Cap per shape at 8 — 8 simultaneous sounds of the same exact
  // shape is already an unusual burst. Beyond that we alloc fresh and
  // GC eats it; the pool's job is to absorb the steady-state churn.
  const PER_SHAPE_CAP = 8;
  const SHAPE_CAP = 12;  // total distinct shapes tracked
  const pool = new Map();  // key -> { float32, free: AudioBuffer[], planar?: Float32Array[] }
  const poolKey = (ch, sr, frames) => `${ch}|${sr}|${frames}`;
  function poolBorrow(ctx, ch, sr, frames) {
    const key = poolKey(ch, sr, frames);
    let bucket = pool.get(key);
    if (!bucket) {
      bucket = {
        float32: new Float32Array(frames * ch),
        free: [],
      };
      if (ch > 1) bucket.planar = Array.from({ length: ch }, () => new Float32Array(frames));
      if (pool.size >= SHAPE_CAP) {
        const firstKey = pool.keys().next().value;
        pool.delete(firstKey);
      }
      pool.set(key, bucket);
    }
    const ab = bucket.free.pop() || ctx.createBuffer(ch, frames, sr);
    return { bucket, audioBuffer: ab };
  }
  function poolReturn(key, audioBuffer) {
    const bucket = pool.get(key);
    if (!bucket) return;  // shape was evicted; let GC have the buffer
    if (bucket.free.length < PER_SHAPE_CAP) bucket.free.push(audioBuffer);
  }

  // Play raw 16-bit signed PCM. C# passes a pointer into the wasm
  // linear memory — we MUST copy out before detaching, because the
  // backing store can move / be reused between the pinvoke and the
  // async AudioBuffer.copyToChannel call on some runtimes.
  globalThis.__wasm_play_pcm = (dataPtr, len, volume, sampleRate, channels, loop) => {
    try {
      // sounds/sec at vol=0.053 (5.3%, near-inaudible distance attenuation
      // tail). Each call decodes Int16->Float32 + creates an AudioBuffer +
      // creates BufferSource + connects through GainNode + scheduling — the
      // cumulative work was eating ~50-80 ms per 1-2 s window. Threshold
      // 0.02 (~2%) keeps any sound the user can plausibly hear.
      if (volume < 0.02 && !loop) return 0;
      const ctx = ensureContext();
      if (!ctx) return 0;
      const sampleCount = (len | 0) / 2;
      const M = capturedModule || globalThis.Module;
      if (!M || !M.HEAPU8) { console.warn('[wasm_play_pcm] Module not ready'); return 0; }
      const ch = channels | 0 || 1;
      const framesPerChannel = (sampleCount / ch) | 0;
      if (framesPerChannel <= 0) return 0;
      const key = poolKey(ch, sampleRate, framesPerChannel);
      const { bucket, audioBuffer } = poolBorrow(ctx, ch, sampleRate, framesPerChannel);
      const src = new Int16Array(M.HEAPU8.buffer, dataPtr, sampleCount);
      const float32 = bucket.float32;
      for (let i = 0; i < sampleCount; i++) float32[i] = src[i] / 32768;
      if (ch === 1) {
        audioBuffer.copyToChannel(float32, 0);
      } else {
        const planar = bucket.planar;
        for (let c = 0; c < ch; c++) {
          const chData = planar[c];
          for (let i = 0; i < framesPerChannel; i++) chData[i] = float32[i * ch + c];
          audioBuffer.copyToChannel(chData, c);
        }
      }
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.loop = !!loop;
      const gain = ctx.createGain();
      gain.gain.value = clamp01(volume);
      source.connect(gain).connect(_sfxOut(ctx));
      source.start();
      const handle = nextHandle++;
      const activeEntry = { source, gain, stopped: false };
      active.set(handle, activeEntry);
      source.onended = () => {
        active.delete(handle);
        // Return the AudioBuffer to its free list so the next dispatch
        // of the same shape doesn't allocate. Looping sounds keep the
        // buffer until explicitly stopped — onended fires on stop too.
        poolReturn(key, audioBuffer);
      };
      return handle;
    } catch (e) {
      console.warn('[wasm_play_pcm] threw:', e);
      return 0;
    }
  };

  // Play MP3 (or any browser-decodable container) via
  // decodeAudioData. Async — we return a handle immediately and
  // kick off decode; playback starts when decode resolves (~50-200
  // ms for a typical UO loop track). If the C# side calls
  // __wasm_stop_sound before decode finishes, we set stopped=true
  // so the later .start() is skipped.
  globalThis.__wasm_play_music = (dataPtr, len, volume, loop) => {
    try {
      const ctx = ensureContext();
      console.log(`[audio] play_music len=${len} vol=${volume} loop=${loop} ctxState=${ctx?.state ?? 'null'}`);
      if (!ctx) return 0;
      const bytesLen = len | 0;
      if (bytesLen <= 0) return 0;
      // decodeAudioData needs a detached ArrayBuffer — copy out of
      // the wasm linear memory so neither side aliases the other.
      const M = capturedModule || globalThis.Module;
      if (!M || !M.HEAPU8) { console.warn('[wasm_play_music] Module not ready'); return 0; }
      const copy = new ArrayBuffer(bytesLen);
      new Uint8Array(copy).set(new Uint8Array(M.HEAPU8.buffer, dataPtr, bytesLen));
      const handle = nextHandle++;
      const entry = { source: null, gain: null, stopped: false, pendingVolume: clamp01(volume) };
      active.set(handle, entry);
      ctx.decodeAudioData(copy).then((audioBuffer) => {
        if (entry.stopped) return;
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.loop = !!loop;
        const gain = ctx.createGain();
        gain.gain.value = entry.pendingVolume;
        source.connect(gain).connect(_musicOut(ctx));
        source.start();
        entry.source = source;
        entry.gain = gain;
        source.onended = () => { active.delete(handle); };
      }).catch((e) => {
        console.warn('[wasm_play_music] decode failed:', e);
        active.delete(handle);
      });
      return handle;
    } catch (e) {
      console.warn('[wasm_play_music] threw:', e);
      return 0;
    }
  };

  // asset load by ~200 MB), so we pass the URL and let the browser
  // initial `fetch` latency is the same ~50-200 ms the in-memory
  // `decodeAudioData` path already took. After the first play the
  // HTTP cache covers subsequent plays of the same track.
  // ports of older content) 404 on every track change before the
  // MIDI fallback fires. Cache the 404 by base URL the first time
  // we see one, then route subsequent plays for that base directly
  // to the MIDI fallback (skips fetch + .arrayBuffer + decodeAudioData
  // pipeline). Per-base scope so a shard mounting MP3s on a different
  // path still gets a fair first attempt.
  const _mp3MissingBases = new Set();
  const mp3BaseKey = (u) => {
    try {
      const parsed = new URL(u, location.href);
      const m = parsed.pathname.match(/^(.*?\/music\/digital\/)/i);
      return m ? `${parsed.origin}${m[1]}` : null;
    } catch { return null; }
  };

  // Manifest pre-check: if the chosen shard's manifest is non-empty and
  // does not list the requested file, skip the network probe entirely
  // and jump straight to the MIDI fallback. Eliminates the browser's
  // network-stack 404 from DevTools for music files known-missing on
  // the shard (most common: .mid-only shards where stones2.mp3 etc.
  // never existed). Empty manifest = legacy single-shard mode → fall
  // through to the live fetch.
  const _isMissingFromManifest = (u) => {
    try {
      const m = (typeof assetsManifest !== 'undefined') ? assetsManifest : null;
      if (!m || Object.keys(m).length === 0) return false;
      const parsed = new URL(u, location.href);
      const base = (window.__chosenGamefilesUrlBase || 'gamefiles')
        .replace(/^\/+|\/+$/g, '');
      const pfx = `/${base.toLowerCase()}/`;
      const lower = parsed.pathname.toLowerCase();
      if (!lower.startsWith(pfx)) return false;
      const rel = lower.slice(pfx.length);
      return !Object.hasOwn(m, rel);
    } catch { return false; }
  };

  globalThis.__wasm_play_music_url = (url, volume, loop) => {
    try {
      const ctx = ensureContext();
      // The gamefile-relative name (e.g. "music/digital/britain1.mp3")
      // captured BEFORE the pool rewrite, plus whether the manifest resolved
      // it to a real pool blob. Used below so the "missing from manifest"
      // short-circuit is judged on the ORIGINAL name, not the rewritten
      // /<base>/pool/<hash>.mp3.br URL (whose `pool/<hash>…` path is never a
      // manifest key → it always looked "missing" → music wrongly fell back
      // to a non-existent .mid → SILENCE. v0.8.87 fix).
      let _origGfName = null;
      let _resolvedViaPool = false;
      // "gamefiles/<path>". That worked in the single-shard layout
      // except the content-addressed pool. Rewrite the C#-generated prefix
      // to the active shard's base so /gamefiles/Music/... lands at
      try {
        const u = new URL(url, location.href);
        const base = (window.__chosenGamefilesUrlBase || 'gamefiles')
          .replace(/^\/+|\/+$/g, '');
        // v0.8.84: route music through the SAME content-addressed pool rewriter
        // the .mul loader uses (window.__rewriteGamefileUrl), so a track lands at
        // /<base>/pool/<hash>.<ext>.br — the raw /<base>/music/... name does NOT
        // exist on disk in the pool-only layout (it 404'd → no music). Extract
        // the gamefile-relative name (strip a leading /gamefiles/ or /<base>/)
        // and let the rewriter resolve it via the manifest. Foreign-origin URLs
        // and unmatched paths pass through untouched.
        if (u.origin === location.origin) {
          const mGf = u.pathname.match(/^\/gamefiles\/(.+)$/i);
          const mBase = (base !== 'gamefiles')
            ? u.pathname.match(new RegExp('^/' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(.+)$', 'i'))
            : null;
          const name = mGf ? mGf[1] : (mBase ? mBase[1] : null);
          _origGfName = name;
          if (name && typeof window.__rewriteGamefileUrl === 'function') {
            const rewritten = window.__rewriteGamefileUrl(name);
            // rewritten can be: pool URL (has the file), raw /<base>/<name>
            // (manifest hit but no hash), external URL, or null (known-absent).
            if (rewritten) {
              url = new URL(rewritten, location.href).href;
              // A /pool/<hash>.<ext>.br rewrite is ONLY produced from a manifest
              // hit → the file definitely exists; never divert it to MIDI.
              _resolvedViaPool = /\/pool\/[0-9a-f]+\.[a-z0-9]+\.br$/i.test(url);
            }
            else if (base !== 'gamefiles' && mGf) url = u.origin + '/' + base + '/' + name;
          } else if (base !== 'gamefiles' && mGf) {
            // No rewriter available yet — fall back to the shard-base prefix swap.
            url = u.origin + '/' + base + '/' + name;
          }
        }
      } catch { /* malformed URL — let fetch fail naturally */ }
      console.log(`[audio] play_music_url url=${url} vol=${volume} loop=${loop} ctxState=${ctx?.state ?? 'null'}`);
      if (!ctx) return 0;
      const handle = nextHandle++;
      const entry = { source: null, gain: null, stopped: false, pendingVolume: clamp01(volume) };
      active.set(handle, entry);

      // shard's digital/ base has already 404'd once this session. Saves
      // a round-trip + decodeAudioData attempt on every track change.
      // v0.4.29: also short-circuit when the manifest knows the file is
      // absent — eliminates the browser's network-stack 404 from DevTools
      // entirely (impossible to suppress from JS otherwise — silencer
      // can't catch resource-load errors).
      const _knownMissingBase = mp3BaseKey(url);
      // Judge "missing" on the ORIGINAL gamefile name when we have it (the
      // rewritten pool URL's `pool/<hash>…` path is never a manifest key, so
      // testing it always returned "missing"). A pool-resolved URL is, by
      // construction, a manifest hit → never missing. Only fall back to the
      // URL-based heuristic for the legacy/no-rewrite path. (v0.8.87)
      const _missingFromManifest = _resolvedViaPool
        ? false
        : (_origGfName != null
            ? (typeof assetsManifest !== 'undefined' && assetsManifest
               && Object.keys(assetsManifest).length > 0
               && !Object.hasOwn(assetsManifest, String(_origGfName).toLowerCase()))
            : _isMissingFromManifest(url));
      if (_missingFromManifest && _knownMissingBase) _mp3MissingBases.add(_knownMissingBase);
      if ((_knownMissingBase && _mp3MissingBases.has(_knownMissingBase)) || _missingFromManifest) {
        (async () => {
          try {
            const { playMidiFallback, stopMidiFallback, setMidiFallbackVolume } =
              await import('./lib/midi-fallback.mjs');
            if (entry.stopped || !active.has(handle)) return;
            const midiHandle = await playMidiFallback(url, entry.pendingVolume, loop);
            if (!midiHandle) return;
            if (entry.stopped || !active.has(handle)) {
              try { stopMidiFallback(midiHandle); } catch {}
              return;
            }
            entry._midiHandle = midiHandle;
            entry._isMidi = true;
            try { setMidiFallbackVolume(midiHandle, entry.pendingVolume); } catch {}
          } catch (e) {
            console.warn('[wasm_play_music_url] cached-404 midi-fallback threw:', e);
          }
        })();
        return handle;
      }

      fetch(url)
        .then((r) => {
          // gamefiles have most music as .mid only; CUO's wasm renderer
          // status so the catch branch can dispatch on it.
          if (!r.ok) {
            const err = new Error(`${r.status} ${r.statusText}`);
            err._mp3Status = r.status;
            throw err;
          }
          return r.arrayBuffer();
        })
        .then((buf) => ctx.decodeAudioData(buf))
        .then((audioBuffer) => {
          if (entry.stopped) return;
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.loop = !!loop;
          const gain = ctx.createGain();
          gain.gain.value = entry.pendingVolume;
          source.connect(gain).connect(_musicOut(ctx));
          source.start();
          entry.source = source;
          entry.gain = gain;
          source.onended = () => { active.delete(handle); };
        })
        .catch(async (e) => {
          // .mp3 missing → MIDI fallback. Lazy-import so the synth
          // bundle only downloads on the first 404 (most modern
          // shards have full .mp3 coverage and never need this path).
          if (e?._mp3Status === 404) {
            // circuits to MIDI without a 404 round-trip.
            const _baseKey = mp3BaseKey(url);
            if (_baseKey) _mp3MissingBases.add(_baseKey);
            try {
              const { playMidiFallback, stopMidiFallback, setMidiFallbackVolume } = await import('./lib/midi-fallback.mjs');
              // The .mp3 fetch + dynamic-import + SF2 init is an async
              // window of several seconds on cold cache. CUO can call
              // wasm_stop_sound(handle) (zone change, char select, etc.)
              // during this window — at which point __wasm_stop_sound
              // marks entry.stopped=true and deletes it. Re-check both
              // before kicking the synth: starting playback after the
              // entry is gone produces an orphan MIDI track that no
              // wasm_stop_sound call can ever silence (the handle is
              // gone), and the next wasm_play_music_url call layers a
              // second track on top — exactly the user-reported "MIDI
              // + MP3 overlap" symptom on rapid zone transitions.
              if (entry.stopped || !active.has(handle)) {
                return;
              }
              const midiHandle = await playMidiFallback(url, entry.pendingVolume, loop);
              if (midiHandle) {
                // Re-check after the synth start await — the same
                // race can fire here. If CUO already stopped us,
                // immediately stop the freshly-started MIDI before
                // it produces audible overlap.
                if (entry.stopped || !active.has(handle)) {
                  try { stopMidiFallback(midiHandle); } catch {}
                  return;
                }
                // Re-purpose the entry so __wasm_stop_sound +
                // __wasm_set_sound_volume route to the MIDI path.
                entry._midiHandle = midiHandle;
                entry._isMidi = true;
                // is published. During the multi-second SF2 init window,
                // any __wasm_set_sound_volume call fell into the
                // `entry.gain` else-branch and parked the new volume on
                // entry.pendingVolume. playMidiFallback used the volume
                // value passed at the start, so any update arriving
                // BETWEEN the call and the resolve was lost. Apply now.
                try { setMidiFallbackVolume(midiHandle, entry.pendingVolume); } catch {}
                return;
              }
            } catch (midiErr) {
              console.warn('[wasm_play_music_url] midi-fallback threw:', midiErr);
            }
          }
          console.warn(`[wasm_play_music_url] failed ${url}:`, e);
          active.delete(handle);
        });
      return handle;
    } catch (e) {
      console.warn('[wasm_play_music_url] threw:', e);
      return 0;
    }
  };

  globalThis.__wasm_stop_sound = (handle) => {
    const entry = active.get(handle);
    if (!entry) return;
    entry.stopped = true;
    if (entry._isMidi && entry._midiHandle) {
      // MIDI fallback path: stop via the spessasynth wrapper.
      import('./lib/midi-fallback.mjs')
        .then((mod) => mod.stopMidiFallback(entry._midiHandle))
        .catch(() => {});
    } else {
      try { entry.source && entry.source.stop(); } catch {}
    }
    active.delete(handle);
  };

  globalThis.__wasm_set_sound_volume = (handle, volume) => {
    const entry = active.get(handle);
    if (!entry) return;
    const v = clamp01(volume);
    if (entry._isMidi && entry._midiHandle) {
      entry.pendingVolume = v;
      import('./lib/midi-fallback.mjs')
        .then((mod) => mod.setMidiFallbackVolume(entry._midiHandle, v))
        .catch(() => {});
    } else if (entry.gain) {
      entry.gain.gain.value = v;
    } else {
      entry.pendingVolume = v; // music still decoding
    }
  };
})();

// call WasmViewport.ResizeGame(innerWidth, innerHeight) so CUO's
// PreferredBackBuffer tracks the real viewport. Also react to
// browser resizes. Keeps the backing store = viewport CSS size
// stays at 640x480 because the C# method early-returns unless the
(function wireDynamicResolution() {
  let exportsPromise = null;
  // The wrapper assembly name differs per bundle: 'classicuo-wasm' (CUO) vs
  // 'tazuo-wasm' (TUO). Resolved from window.__bundle at runtime so this ONE
  // shared main.js serves both. (iter63 postmortem: a hardcoded wrong name
  // makes EVERY WasmViewport [JSExport] lookup unreachable — canvas never
  // resizes — so this branch is the single genuinely per-client line.)
  const _wrapperAssembly = (typeof window !== 'undefined' && window.__bundle === 'mini')
    ? 'mini-wasm'
    : (typeof window !== 'undefined' && window.__bundle === 'tuo') ? 'tazuo-wasm' : 'classicuo-wasm';
  const getExports = () => exportsPromise ??= getAssemblyExports(_wrapperAssembly);
  // mini-runtime.js (loaded only by the mini bundle) drives engine toggles
  // (TBH auto-walk/cursor/chrome + rail-bridge reads) through this accessor.
  if (window.__bundle === 'mini') window.__miniGetExports = getExports;

  // ── Gameview screenshot (window.UONexusScreenshot, operator 2026-06-23) ──
  // PrintScreen (keydown handler) calls capture(). It asks the C# ScreenshotBridge
  // (via the WasmRailBridge [JSExport]) for a base64 PNG of the WORLD render target
  // (gameview only — never gumps/UI/cursor), then stores it in the OPFS ring-buffer
  // of 5. NOTHING is uploaded here — the player approves/uploads from their profile.
  let _shotBusy = false, _shotToastEl = null, _shotToastT = 0;
  // Guard against the ~1-frame window right after world-entry where the world render
  // target exists but has not been drawn yet (reads back as a single flat colour /
  // black). A real gameview ALWAYS has variance (tiles, sprites, player), so we reject
  // only an essentially-uniform image — never a legitimately dark scene. JS-side so it
  // needs no engine change. On any decode error we do NOT block (resolve false).
  function _isUniformPng(b64) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => {
          try {
            const n = 24;
            const cv = document.createElement('canvas'); cv.width = n; cv.height = n;
            const ctx = cv.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, n, n);
            const d = ctx.getImageData(0, 0, n, n).data;
            let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
            for (let i = 0; i < d.length; i += 4) {
              const r = d[i], g = d[i + 1], b = d[i + 2];
              if (r < minR) minR = r; if (r > maxR) maxR = r;
              if (g < minG) minG = g; if (g > maxG) maxG = g;
              if (b < minB) minB = b; if (b > maxB) maxB = b;
            }
            resolve(Math.max(maxR - minR, maxG - minG, maxB - minB) <= 3);
          } catch (e) { resolve(false); }
        };
        img.onerror = () => resolve(false);
        img.src = 'data:image/png;base64,' + b64;
      } catch (e) { resolve(false); }
    });
  }
  function _shotToast(msg, ok) {
    try {
      if (!_shotToastEl) {
        _shotToastEl = document.createElement('div');
        _shotToastEl.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483646;padding:9px 16px;border-radius:9px;font:13px system-ui,sans-serif;color:#fff;pointer-events:none;box-shadow:0 6px 24px rgba(0,0,0,.5);transition:opacity .25s;opacity:0';
        document.body.appendChild(_shotToastEl);
      }
      _shotToastEl.textContent = msg;
      _shotToastEl.style.background = ok ? 'rgba(20,90,40,.95)' : 'rgba(120,30,30,.95)';
      _shotToastEl.style.opacity = '1';
      clearTimeout(_shotToastT);
      _shotToastT = setTimeout(() => { if (_shotToastEl) _shotToastEl.style.opacity = '0'; }, 3200);
    } catch (e) {}
  }
  // Resolve the CURRENT shard's display NAME (never the slug) for the capture
  // watermark. Caches one /api/servers fetch; falls back to the slug, then ''.
  let _shotSrvP = null;
  async function _shotShardName() {
    try {
      const slug = (typeof window !== 'undefined' && window.__chosenServerSlug) || '';
      if (!_shotSrvP) _shotSrvP = fetch('/api/servers', { credentials: 'same-origin', cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { const a = Array.isArray(d) ? d : (d && d.servers) || []; const m = {};
          a.forEach((s) => { if (s && s.slug) m[s.slug] = String(s.displayName ?? s.slug).replace(/<[^>]*>/g, '').trim() || s.slug; });
          return m; })
        .catch(() => ({}));
      const map = await _shotSrvP;
      return (map[slug] || slug || '').slice(0, 48);
    } catch (e) { return ''; }
  }
  // Burn a small bottom-right watermark (shard NAME + capture date) into the PNG.
  // Drawn via CSSOM canvas so it can never inject markup. Returns the new base64
  // (or the original on any failure — a watermark must never lose a capture).
  function _watermark(b64) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = async () => {
          try {
            const w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) { resolve(b64); return; }
            const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
            const ctx = cv.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const shard = await _shotShardName();
            const dt = new Date();
            const date = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
            const label = shard ? (shard + '  ·  ' + date) : date;
            const fs = Math.max(12, Math.round(w * 0.017));
            ctx.font = '600 ' + fs + 'px system-ui, "Segoe UI", sans-serif';
            ctx.textBaseline = 'alphabetic';
            const pad = Math.round(fs * 0.65);
            const tw = Math.ceil(ctx.measureText(label).width);
            const x = w - tw - pad, y = h - pad;
            ctx.fillStyle = 'rgba(0,0,0,.40)';
            ctx.fillRect(x - pad * 0.7, y - fs - pad * 0.45, tw + pad * 1.4, fs + pad * 0.9);
            ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 3; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 1;
            ctx.fillStyle = 'rgba(255,236,196,.94)'; // soft gold, matches the UO theme
            ctx.fillText(label, x, y);
            resolve((cv.toDataURL('image/png').split(',')[1]) || b64);
          } catch (e) { resolve(b64); }
        };
        img.onerror = () => resolve(b64);
        img.src = 'data:image/png;base64,' + b64;
      } catch (e) { resolve(b64); }
    });
  }
  window.UONexusScreenshot = {
    capture: async () => {
      if (_shotBusy) { _shotToast('Still saving the last screenshot…', true); return; }
      _shotBusy = true;
      try {
        const e = await getExports();
        const b64raw = await e.ClassicUO.Wasm.WasmRailBridge.CaptureGameview();
        if (!b64raw) { _shotToast('Screenshot: enter the world first', false); return; }
        if (await _isUniformPng(b64raw)) { _shotToast('Could not capture the view yet — try again', false); return; }
        const b64 = await _watermark(b64raw); // burn shard name + date, bottom-right
        // 🚨 STRAIGHT TO THE PLAYER'S DISK, AND NOWHERE ELSE. Upstream writes the capture into an
        // OPFS ring-buffer of five and lets the portal read it back for a "publish from your
        // profile" flow. This build has no profile and no publishing, so that copy was written where
        // nothing could ever display it — spending the player's storage quota to hold images only a
        // developer could find (operator, 2026-08-27: they should not be stored at all).
        //
        // The download used to be gated on that write succeeding, which made a pointless step into a
        // required one: a browser that refused the OPFS write produced no file either.
        try {
          const bin = atob(b64);
          const buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
          const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
          const a = document.createElement('a');
          a.href = url;
          // Local time, not the epoch: the file lands in the player's Downloads folder and its name
          // is the only thing that says when it was taken.
          const t = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          a.download = `uo-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}`
                     + `-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          // Revoke on a later tick: revoking synchronously can beat the download starting.
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
          _shotToast('Screenshot saved to your downloads', true);
        } catch (e) {
          console.warn('[shot] download failed:', e);
          _shotToast('Screenshot failed', false);
        }
      } catch (err) {
        console.warn('[shot] capture failed:', err);
        _shotToast('Screenshot failed', false);
      } finally { _shotBusy = false; }
    },
  };

  // ── Rail JS-macro bridge (window.UORailBridge) ─────────────────────────
  // ── the rail's account bridge ─────────────────────────────────────────────
  // 🚨 UPSTREAM THIS LIVES IN portal-rail.js, WHICH THIS BUILD DELIBERATELY DOES NOT SHIP. The rail's
  // User panel reads window.UORailAccount.identity() for the signed-in name, id and avatar; with no
  // provider it got {} and rendered "Guest" — to somebody who had just signed in with Discord and
  // watched it work. Every other button in that panel (Logout, Sync now, Export, Import) was inert
  // for the same reason.
  //
  // Third time in this build that removing a surface removed something ANOTHER surface depended on:
  // the picker was also the login page, and portal-rail was also the identity bridge. When a file is
  // excluded, the question is not "does this build need it" but "what was it carrying for someone".
  //
  // Only what this install can actually honour is provided. Every call site in rail.js is guarded and
  // several explain themselves when a method is missing, so an honest gap degrades better than a stub
  // that pretends: signOutEverywhere needs a token-epoch bump the reduced backend has no route for,
  // and clearCache is only rail.js's own fallback — it prefers its Storage Management API.
  window.UORailAccount = {
    identity: () => (_discordUser
      ? { name: _discordUser.name || null, id: _discordUser.id || null, avatarUrl: discordAvatarUrl(_discordUser) }
      : {}),
    signOut: async () => {
      try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); }
      catch (e) { console.warn('[account] logout request failed:', e); }
      // Reload regardless. The cookie is gone or it never existed; either way the page must stop
      // showing a session it can no longer prove.
      location.reload();
    },
    // Force-push the in-game settings and the profile files the same way the automatic save does.
    // Returns false rather than throwing when there is no session: the rail toasts on false.
    syncNow: async () => {
      if (!_discordUser) return false;
      try {
        await discordSaveSettings();
        await uploadProfileBlob();
        return true;
      } catch (e) { console.warn('[account] sync failed:', e); return false; }
    },
    exportProfile: () => exportProfileArchive(),
    importProfile: (file) => importProfileArchive(file),
  };

  // rail.js's UO API routes game-control verbs here. Each method marshals to
  // the deputy via the WasmRailBridge [JSExport], awaiting getExports() lazily
  // so a macro run before exports are ready simply waits. Only invoked on a
  // user macro run (post-gamescene) — never polled at boot (that hangs the
  // deputy, see WasmViewport.cs).
  window.UORailBridge = {
    player: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetPlayer()); }
      catch (err) { return { ingame: false, error: String(err) }; }
    },
    // Player-metrics telemetry: gameplay-counter deltas since the last poll.
    collectMetrics: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.CollectMetrics()); }
      catch (err) { return null; }
    },
    sysmsg: async (text, hue) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.SysMessage(String(text), (hue | 0) || 0); }
      catch (err) { console.warn('[rail] sysmsg bridge failed:', err); }
    },
    say: async (text) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.Say(String(text)); }
      catch (err) { console.warn('[rail] say bridge failed:', err); }
    },
    // Sprite smoothing (texel-AA, operator goal 2026-07-10): direct knob for
    // JS-macros/tools. The rail Game Options panel drives the same Profile
    // fields through the generic setSetting path; either route is hot.
    setSpriteSmoothing: async (level, full) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.SetSpriteSmoothing(level | 0, !!full); return true; }
      catch (err) { console.warn('[rail] setSpriteSmoothing bridge failed:', err); return false; }
    },
    getSpriteSmoothing: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.GetSpriteSmoothing(); }
      catch (err) { return null; }
    },
    useItem: async (serial) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.UseItem(Number(serial) || 0); }
      catch (err) { console.warn('[rail] useItem bridge failed:', err); }
    },
    target: async (serial) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.Target(Number(serial) || 0); }
      catch (err) { console.warn('[rail] target bridge failed:', err); return false; }
    },
    targetSelf: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.TargetSelf(); }
      catch (err) { console.warn('[rail] targetSelf bridge failed:', err); return false; }
    },
    targetLast: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.TargetLast(); }
      catch (err) { console.warn('[rail] targetLast bridge failed:', err); return false; }
    },
    useSkill: async (index) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.UseSkill(index | 0); }
      catch (err) { console.warn('[rail] useSkill bridge failed:', err); }
    },
    castSpell: async (index) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.CastSpell(index | 0); }
      catch (err) { console.warn('[rail] castSpell bridge failed:', err); }
    },
    cancelTarget: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.CancelTarget(); }
      catch (err) { console.warn('[rail] cancelTarget bridge failed:', err); return false; }
    },
    // Open the client's OWN native options window (used by the rail "Game Options"
    // gear when the custom HTML panel is not the admin-selected default).
    openNativeOptions: async () => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.OpenNativeOptions(); return true; }
      catch (err) { console.warn('[rail] openNativeOptions bridge failed:', err); return false; }
    },
    // LegionScript persistent vars — per-browser, survive across sessions. Pure
    // localStorage (no WASM): the Pyodide worker has no localStorage, so it round-trips
    // through here. Namespaced to avoid clashing with other rail keys.
    getPersistentVar: async (name, def) => {
      try { const v = localStorage.getItem('ls_pv_' + String(name)); return v === null ? (def !== undefined ? def : null) : v; }
      catch (e) { return def !== undefined ? def : null; }
    },
    savePersistentVar: async (name, val) => {
      try { localStorage.setItem('ls_pv_' + String(name), String(val)); return true; } catch (e) { return false; }
    },
    removePersistentVar: async (name) => {
      try { localStorage.removeItem('ls_pv_' + String(name)); return true; } catch (e) { return false; }
    },
    // ── LegionScript API completion (2026-07-24): bridges to the new WasmRailBridge
    // [JSExport]s. TUO-only for now; on cuo the missing export throws and we return
    // the safe fallback (bridge growth). Numbers cross as double, strings as string.
    setWarMode: async (enabled) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.SetWarMode(!!enabled); return true; }
      catch (err) { return false; }
    },
    bandageSelf: async () => {
      try { const e = await getExports(); return !!(await e.ClassicUO.Wasm.WasmRailBridge.BandageSelf()); }
      catch (err) { return false; }
    },
    toggleAbility: async (ability) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.ToggleAbility(String(ability)); return true; }
      catch (err) { return false; }
    },
    virtue: async (virtue) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.Virtue(String(virtue)); return true; }
      catch (err) { return false; }
    },
    setSkillLock: async (skill, mode) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.SetSkillLock(String(skill), String(mode)); return true; }
      catch (err) { return false; }
    },
    setStatLock: async (stat, mode) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.SetStatLock(String(stat), String(mode)); return true; }
      catch (err) { return false; }
    },
    displayRange: async (distance, hue) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.DisplayRange((distance | 0), (hue | 0)); return true; }
      catch (err) { return false; }
    },
    trackingArrow: async (x, y, identifier) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.TrackingArrow((x | 0), (y | 0), Number(identifier) || 0); return true; }
      catch (err) { return false; }
    },
    primaryAbilityActive: async () => {
      try { const e = await getExports(); return !!(await e.ClassicUO.Wasm.WasmRailBridge.PrimaryAbilityActive()); }
      catch (err) { return false; }
    },
    secondaryAbilityActive: async () => {
      try { const e = await getExports(); return !!(await e.ClassicUO.Wasm.WasmRailBridge.SecondaryAbilityActive()); }
      catch (err) { return false; }
    },
    currentAbilityNames: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.CurrentAbilityNames()); }
      catch (err) { return []; }
    },
    knownAbilityNames: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.KnownAbilityNames()); }
      catch (err) { return []; }
    },
    isGlobalCooldownActive: async () => {
      try { const e = await getExports(); return !!(await e.ClassicUO.Wasm.WasmRailBridge.IsGlobalCooldownActive()); }
      catch (err) { return false; }
    },
    activeBuffs: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.ActiveBuffs()); }
      catch (err) { return []; }
    },
    buffExists: async (name) => {
      try { const e = await getExports(); return !!(await e.ClassicUO.Wasm.WasmRailBridge.BuffExists(String(name))); }
      catch (err) { return false; }
    },
    mount: async (serial) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.Mount(Number(serial) || 0); return true; }
      catch (err) { return false; }
    },
    dismount: async () => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.Dismount(); return true; }
      catch (err) { return false; }
    },
    setMount: async (serial) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.SetMount(Number(serial) || 0); return true; }
      catch (err) { return false; }
    },
    toggleFly: async () => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.ToggleFly(); return true; }
      catch (err) { return false; }
    },
    logout: async () => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.Logout(); return true; }
      catch (err) { return false; }
    },
    rename: async (serial, name) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.Rename(Number(serial) || 0, String(name)); return true; }
      catch (err) { return false; }
    },
    clearLeftHand: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.ClearLeftHand()); }
      catch (err) { return null; }
    },
    clearRightHand: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.ClearRightHand()); }
      catch (err) { return null; }
    },
    pickUpToCursor: async (serial, amt) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.PickUpToCursor(Number(serial) || 0, (amt | 0)); return true; }
      catch (err) { return false; }
    },
    dropFromCursor: async (serial, x, y, z, container) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.DropFromCursor(Number(serial) || 0, (x | 0), (y | 0), (z | 0), Number(container) || 0); return true; }
      catch (err) { return false; }
    },
    moveItemOffset: async (serial, amt, x, y, z, osi) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.MoveItemOffset(Number(serial) || 0, (amt | 0), (x | 0), (y | 0), (z | 0), !!osi); return true; }
      catch (err) { return false; }
    },
    clearMoveQueue: async () => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.ClearMoveQueue(); return true; }
      catch (err) { return false; }
    },
    isProcessingMoveQueue: async () => {
      try { const e = await getExports(); return !!(await e.ClassicUO.Wasm.WasmRailBridge.IsProcessingMoveQueue()); }
      catch (err) { return false; }
    },
    isProcessingUseItemQueue: async () => {
      try { const e = await getExports(); return !!(await e.ClassicUO.Wasm.WasmRailBridge.IsProcessingUseItemQueue()); }
      catch (err) { return false; }
    },
    getHeldItem: async () => {
      try { const e = await getExports(); return Number(await e.ClassicUO.Wasm.WasmRailBridge.GetHeldItem()); }
      catch (err) { return -1; }
    },
    requestOPLData: async (serialsCsv) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.RequestOPLData(String(serialsCsv)); return true; }
      catch (err) { return false; }
    },
    itemNameAndProps: async (serial) => {
      try { const e = await getExports(); const v = await e.ClassicUO.Wasm.WasmRailBridge.ItemNameAndProps(Number(serial) || 0); return v == null ? '' : String(v); }
      catch (err) { return ''; }
    },
    closeGump: async (id) => {
      try { const e = await getExports(); return !!(await e.ClassicUO.Wasm.WasmRailBridge.CloseGump(Number(id) || 0)); }
      catch (err) { return false; }
    },
    gumpContains: async (text, id) => {
      try { const e = await getExports(); return !!(await e.ClassicUO.Wasm.WasmRailBridge.GumpContains(String(text), Number(id) || 0)); }
      catch (err) { return false; }
    },
    contextMenu: async (serial, entry) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.ContextMenu(Number(serial) || 0, (entry | 0)); return true; }
      catch (err) { return false; }
    },
    closeContextMenus: async () => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.CloseContextMenus(); return true; }
      catch (err) { return false; }
    },
    getMap: async () => {
      try { const e = await getExports(); return Number(await e.ClassicUO.Wasm.WasmRailBridge.GetMap()); }
      catch (err) { return -1; }
    },
    getTile: async (x, y) => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetTile((x | 0), (y | 0))); }
      catch (err) { return null; }
    },
    getStaticsAt: async (x, y) => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetStaticsAt((x | 0), (y | 0))); }
      catch (err) { return []; }
    },
    getStaticsInArea: async (x1, y1, x2, y2) => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetStaticsInArea((x1 | 0), (y1 | 0), (x2 | 0), (y2 | 0))); }
      catch (err) { return []; }
    },
    getPartyLeader: async () => {
      try { const e = await getExports(); return Number(await e.ClassicUO.Wasm.WasmRailBridge.GetPartyLeader()); }
      catch (err) { return -1; }
    },
    getPartyMemberSerials: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetPartyMemberSerials()); }
      catch (err) { return []; }
    },
    getPath: async (x, y, z, distance) => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetPath((x | 0), (y | 0), (z | 0), (distance | 0))); }
      catch (err) { return []; }
    },
    pathfinding: async () => {
      try { const e = await getExports(); return !!(await e.ClassicUO.Wasm.WasmRailBridge.Pathfinding()); }
      catch (err) { return false; }
    },
    cancelPathfinding: async () => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.CancelPathfinding(); return true; }
      catch (err) { return false; }
    },
    markTile: async (x, y, hue, map) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.MarkTile((x | 0), (y | 0), (hue | 0), (map | 0)); return true; }
      catch (err) { return false; }
    },
    removeMarkedTile: async (x, y, map) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.RemoveMarkedTile((x | 0), (y | 0), (map | 0)); return true; }
      catch (err) { return false; }
    },
    dress: async (name) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.Dress(String(name)); return true; }
      catch (err) { return false; }
    },
    undress: async (name) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.Undress(String(name)); return true; }
      catch (err) { return false; }
    },
    undressAll: async (kr) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.UndressAll(!!kr); return true; }
      catch (err) { return false; }
    },
    getAvailableDressOutfits: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetAvailableDressOutfits()); }
      catch (err) { return []; }
    },
    toggleAutoLoot: async () => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.ToggleAutoLoot(); return true; }
      catch (err) { return false; }
    },
    autoLootContainer: async (container) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.AutoLootContainer(Number(container) || 0); return true; }
      catch (err) { return false; }
    },
    autoFollow: async (mobile) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.AutoFollow(Number(mobile) || 0); return true; }
      catch (err) { return false; }
    },
    cancelAutoFollow: async () => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.CancelAutoFollow(); return true; }
      catch (err) { return false; }
    },
    targetLandRel: async (xOffset, yOffset) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.TargetLandRel((xOffset | 0), (yOffset | 0)); return true; }
      catch (err) { return false; }
    },
    targetTileRel: async (xOffset, yOffset, graphic) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.TargetTileRel((xOffset | 0), (yOffset | 0), (graphic | 0)); return true; }
      catch (err) { return false; }
    },
    targetResource: async (itemSerial, resource) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.TargetResource(Number(itemSerial) || 0, (resource | 0)); return true; }
      catch (err) { return false; }
    },
    findLayer: async (layer, serial) => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.FindLayer(String(layer), Number(serial) || 0)); }
      catch (err) { return null; }
    },
    // LegionScripting API.Attack — the [JSExport] currently exists only in the TUO
    // build; on cuo the missing export is caught and quietly no-ops (bridge growth).
    attack: async (serial) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.Attack(Number(serial) || 0); return true; }
      catch (err) { console.warn('[rail] attack bridge failed:', err); return false; }
    },
    // LegionScripting API.Turn — face a direction (0-7). TUO-only export; cuo no-ops.
    turn: async (dir) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.Turn(Number(dir) || 0); return true; }
      catch (err) { console.warn('[rail] turn bridge failed:', err); return false; }
    },
    // LegionScripting API.GetSkill family — returns [{index,name,value,base,cap,lock}].
    // TUO-only export today; cuo returns [] via the catch.
    getSkills: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetSkills()); }
      catch (err) { return []; }
    },
    getProfile: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetProfile()); }
      catch (err) { console.warn('[rail] getProfile bridge failed:', err); return {}; }
    },
    setSetting: async (name, value) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.SetSetting(String(name), String(value)); }
      catch (err) { console.warn('[rail] setSetting bridge failed:', err); }
    },
    getMacros: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetMacros()); }
      catch (err) { console.warn('[rail] getMacros bridge failed:', err); return []; }
    },
    getHuePalette: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetHuePalette()); }
      catch (err) { console.warn('[rail] getHuePalette bridge failed:', err); return []; }
    },
    addMacro: async (name) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.AddMacro(String(name)); }
      catch (err) { console.warn('[rail] addMacro bridge failed:', err); return false; }
    },
    deleteMacro: async (name) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.DeleteMacro(String(name)); }
      catch (err) { console.warn('[rail] deleteMacro bridge failed:', err); return false; }
    },
    getMacroCatalog: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetMacroCatalog()); }
      catch (err) { console.warn('[rail] getMacroCatalog bridge failed:', err); return { types: [], subs: {} }; }
    },
    addMacroAction: async (name) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.AddMacroAction(String(name)); }
      catch (err) { console.warn('[rail] addMacroAction bridge failed:', err); return false; }
    },
    removeMacroActionAt: async (name, index) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.RemoveMacroActionAt(String(name), index | 0); }
      catch (err) { console.warn('[rail] removeMacroActionAt bridge failed:', err); return false; }
    },
    setMacroAction: async (name, index, code, sub, text) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.SetMacroAction(String(name), index | 0, code | 0, sub | 0, String(text == null ? '' : text)); }
      catch (err) { console.warn('[rail] setMacroAction bridge failed:', err); return false; }
    },
    setMacroKey: async (name, token, alt, ctrl, shift) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.SetMacroKey(String(name), String(token), !!alt, !!ctrl, !!shift); }
      catch (err) { console.warn('[rail] setMacroKey bridge failed:', err); return false; }
    },
    clearMacroKey: async (name) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.ClearMacroKey(String(name)); }
      catch (err) { console.warn('[rail] clearMacroKey bridge failed:', err); return false; }
    },
    renameMacro: async (oldName, newName) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.RenameMacro(String(oldName), String(newName)); }
      catch (err) { console.warn('[rail] renameMacro bridge failed:', err); return false; }
    },
    // Shard latency for the rail readout. -1 means "no reading" and the rail draws a dash;
    // a failed call must return that too, never 0, which would render as a real-looking "0ms".
    getPing: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.GetPing(); }
      catch (err) { return -1; }
    },
    // ── Agents engine — real item read/move/equip primitives ────────────────
    getEquippedItems: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetEquippedItems()); }
      catch (err) { console.warn('[rail] getEquippedItems bridge failed:', err); return []; }
    },
    getContainerItems: async (serial) => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetContainerItems(Number(serial) || 0)); }
      catch (err) { console.warn('[rail] getContainerItems bridge failed:', err); return []; }
    },
    getBackpackSerial: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.GetBackpackSerial(); }
      catch (err) { console.warn('[rail] getBackpackSerial bridge failed:', err); return 0; }
    },
    equipItem: async (serial) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.EquipItem(Number(serial) || 0); }
      catch (err) { console.warn('[rail] equipItem bridge failed:', err); return false; }
    },
    moveItem: async (serial, dest, amount) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.MoveItem(Number(serial) || 0, Number(dest) || 0, amount | 0); }
      catch (err) { console.warn('[rail] moveItem bridge failed:', err); return false; }
    },
    grabItem: async (serial, amount, bag) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.GrabItem(Number(serial) || 0, amount | 0, Number(bag) || 0); }
      catch (err) { console.warn('[rail] grabItem bridge failed:', err); return false; }
    },
    // Target picker (autoloot "+") + real item art
    requestTarget: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.RequestTarget(); }
      catch (err) { console.warn('[rail] requestTarget bridge failed:', err); return false; }
    },
    pollTarget: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.PollTarget()); }
      catch (err) { return { cancelled: true }; }
    },
    cancelRailTarget: async () => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.CancelRailTarget(); }
      catch (err) { /* ignore */ }
    },
    // hue forwarded since v0.9.353 (TD catalog): the mini export is GetItemArt(graphic, hue) but this
    // wrapper silently DROPPED the hue, so every art fetch tinted as hue 0 — the three TD spellbooks
    // rendered identical no matter what the shard sent. cuo/tuo exports are 1-arg; the extra JS arg
    // is ignored there (their callers never pass a hue anyway).
    getItemArt: async (graphic, hue) => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetItemArt(graphic | 0, hue | 0)); }
      catch (err) { return {}; }
    },
    // Durability tracker (Agents > Durability): worn gear + OPL durability.
    getEquipmentDurability: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetEquipmentDurability()); }
      catch (err) { return []; }
    },
    // Lists agent (Friends / Enemies). Friends are TazUO-only (listsHasFriends).
    listsHasFriends: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.ListsHasFriends(); }
      catch (err) { return false; }
    },
    getFriends: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetFriends()); }
      catch (err) { return []; }
    },
    addFriend: async (serial) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.AddFriend(Number(serial) || 0); }
      catch (err) { return false; }
    },
    removeFriend: async (serial) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.RemoveFriend(Number(serial) || 0); }
      catch (err) { return false; }
    },
    getIgnored: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetIgnored()); }
      catch (err) { return []; }
    },
    addIgnore: async (serial) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.AddIgnore(Number(serial) || 0); }
      catch (err) { return false; }
    },
    removeIgnore: async (name) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.RemoveIgnore(String(name)); }
      catch (err) { return false; }
    },
    // UOAM peers → drawn on the in-game WorldMap (delimited: name\x1fx\x1fy\x1fmap, recs \x1e).
    setUoamPeers: async (data) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.SetUoamPeers(String(data || "")); }
      catch (err) { /* ignore */ }
    },
    // Filters agent (sound filtering, TazUO-only — filtersHasEngine gates the UI).
    filtersHasEngine: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.FiltersHasEngine(); }
      catch (err) { return false; }
    },
    getRecentSounds: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetRecentSounds()); }
      catch (err) { return []; }
    },
    getSoundFilters: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetSoundFilters()); }
      catch (err) { return []; }
    },
    addSoundFilter: async (id) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.AddSoundFilter(Number(id) | 0); }
      catch (err) { /* ignore */ }
    },
    removeSoundFilter: async (id) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.RemoveSoundFilter(Number(id) | 0); }
      catch (err) { /* ignore */ }
    },
    // Chat agent (native UO conference system — state read + join/leave/send over the game socket).
    getChatState: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetChatState()); }
      catch (err) { return { status: 0, current: "", channels: [] }; }
    },
    chatRegisterName: async (name) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.ChatRegisterName(String(name || "")); }
      catch (err) { return false; }
    },
    chatJoin: async (name, password) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.ChatJoin(String(name || ""), String(password || "")); }
      catch (err) { return false; }
    },
    chatLeave: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.ChatLeave(); }
      catch (err) { return false; }
    },
    chatSend: async (msg) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.ChatSend(String(msg || "")); }
      catch (err) { return false; }
    },
    // ── Perception / navigation / UI verbs (operator 2026-06-11) ────────────
    getJournal: async (max) => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetJournal(max | 0)); }
      catch (err) { console.warn('[rail] getJournal bridge failed:', err); return []; }
    },
    scanWorld: async (range, kind) => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.ScanWorld(range | 0, kind | 0)); }
      catch (err) { console.warn('[rail] scanWorld bridge failed:', err); return []; }
    },
    isTargeting: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.IsTargeting(); }
      catch (err) { return false; }
    },
    walkTo: async (x, y, distance) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.WalkTo(x | 0, y | 0, distance | 0); }
      catch (err) { console.warn('[rail] walkTo bridge failed:', err); return false; }
    },
    stopWalk: async () => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.StopWalk(); }
      catch (err) { return false; }
    },
    getGumps: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.GetGumps()); }
      catch (err) { console.warn('[rail] getGumps bridge failed:', err); return []; }
    },
    gumpReply: async (gumpServerSerial, button) => {
      try { const e = await getExports(); return await e.ClassicUO.Wasm.WasmRailBridge.GumpReply(Number(gumpServerSerial) || 0, button | 0); }
      catch (err) { console.warn('[rail] gumpReply bridge failed:', err); return false; }
    },
    mouseMove: async (x, y) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.MouseMove(x | 0, y | 0); }
      catch (err) { console.warn('[rail] mouseMove bridge failed:', err); }
    },
    mouseClick: async (rightButton) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.MouseClick(!!rightButton); }
      catch (err) { console.warn('[rail] mouseClick bridge failed:', err); }
    },
    mouseDoubleClick: async (rightButton) => {
      try { const e = await getExports(); await e.ClassicUO.Wasm.WasmRailBridge.MouseDoubleClick(!!rightButton); }
      catch (err) { console.warn('[rail] mouseDoubleClick bridge failed:', err); }
    },
    objectAtCursor: async () => {
      try { const e = await getExports(); return JSON.parse(await e.ClassicUO.Wasm.WasmRailBridge.ObjectAtCursor()); }
      catch (err) { return { kind: 'none' }; }
    },
  };

  // 🚨 Anything the player AUTHORS gets pushed to their account immediately.
  //
  // The profile upload is throttled to 30 s, which is right for the 5 s autosave tick and wrong
  // for a macro somebody just wrote: it lived only in this browser for up to half a minute, with
  // nothing on screen saying so. Clearing site data inside that window destroyed work that looked
  // saved — the likeliest explanation for the macros the operator lost twice, since the measured
  // sync itself is healthy end to end on both clients.
  //
  // Wrapped HERE rather than at the eleven call sites in rail.js, because the twelfth call site
  // is the one that would forget. Reads are untouched; only verbs that change stored state, and
  // only when the client reports the change actually took (a refused rename must not push).
  // __uoFlushProfileNow debounces, so an action-chain edit is one upload, not five.
  for (const verb of ['addMacro', 'deleteMacro', 'renameMacro', 'setMacroKey', 'clearMacroKey',
                      'addMacroAction', 'setMacroAction', 'removeMacroActionAt']) {
    const inner = window.UORailBridge[verb];
    if (typeof inner !== 'function') continue;   // fork without this verb: leave it absent
    window.UORailBridge[verb] = async (...args) => {
      const r = await inner(...args);
      if (r !== false) {
        // The player just changed their macros on purpose. Deleting the last one is a legitimate
        // thing to do, and the empty-profile guard must not undo it — without this flag that guard
        // refuses the upload and the next session restores what they deleted.
        _userEditedThisSession = true;
        if (globalThis.__uoFlushProfileNow) {
          try { globalThis.__uoFlushProfileNow(); } catch { /* never let syncing break the edit */ }
        }
      }
      return r;
    };
  }

  let resizeTimer = 0;
  let chromeHidden = false;
  const canvas = document.getElementById('canvas');
  const maybeHideHtmlChrome = () => {
    // that as a reliable "in-game" signal to drop the HTML
    // welcome-screen elements (banner + footer) that would
    // otherwise bleed through above the canvas (z-index:3).
    if (chromeHidden) return;
    if (!canvas || canvas.width <= 800) return;
    chromeHidden = true;
    const banner = document.getElementById('banner');
    const footer = document.getElementById('footer');
    if (banner) banner.style.display = 'none';
    if (footer) footer.style.display = 'none';
    // see both the UO hourglass/arrow AND the Windows arrow stacked.
    canvas.style.cursor = 'none';
    console.log('[viewport] HTML chrome hidden (canvas grew past LoginScene size)');
  };
  // Gate: don't touch the canvas backing store until CUO is past
  // fixed 640x480 target (LoginBackground GumpPicTiled is 640x480,
  // Resizing the canvas during login also resets the WebGL context,
  // which mid-init was confusing Mono. We flip `_inGame` to true in
  // the EnteringBritania sniff (onBoot) below — all earlier resize
  // events no-op.
  let _inGame = false;

  // Core resize — sets canvas.width/height directly in JS AND calls
  // the C# bridge so both paths stay consistent. Setting
  // canvas.width/height makes the DOM resize stick even when the C#
  // SetWindowSize -> SDL path is a no-op under the threaded wasm
  const doResize = async (why, wCss, hCss) => {
    if (!_inGame) {
      console.log(`[viewport] resize ${why}: deferred (not yet in-game)`);
      return;
    }
    // mini overlay modes (strip/embed) pin a FIXED viewport sized to the host
    // task-bar instead of following the window. mini-runtime.js owns that math;
    // when it handles the resize (overlay use-case) it returns true and we skip
    // the normal window-follow ResizeGame path. Returns false for non-overlay
    // mini modes (window/mobile) → fall through to the standard resize below.
    if (window.__bundle === 'mini' && window.__miniHooks && window.__miniHooks.applyViewport) {
      try { if (await window.__miniHooks.applyViewport(canvas, getExports, why, maybeHideHtmlChrome)) return; }
      catch (e) { try { console.warn('[mini] applyViewport failed', e); } catch {} }
    }
    // Backing store = window size 1:1. A prior revision capped
    // the backing at 1600x900 hoping to recover fill-rate, but
    // the game's WORLD VIEWPORT is `0.7 × canvas.width` pixels
    // (WasmViewport.cs). A smaller backing shrinks the world
    // viewport, which means fewer UO tiles fit on screen — each
    // backing to the window. Result: user saw "zoom pixelado"
    // instead of the expected mild upscale. Revert: keep 1:1.
    const w = wCss;
    const h = hCss;
    const before = canvas ? `${canvas.width}x${canvas.height}` : 'n/a';
    // Always ATTEMPT the JS-side write. If the canvas was transferred
    // to OffscreenCanvas (normal MT path), it throws
    // `InvalidStateError: Cannot resize canvas after call to
    // transferControlToOffscreen()` and we fall through to the C#
    // SDL_SetWindowSize below. If the runtime's own handshake ended
    // up NOT actually transferring (our shim detected
    // `msg.offscreenCanvases` populated but the deputy worker may
    // still be reading from the main-thread placeholder), this write
    // is what actually grows the visible canvas. User report
    // despite ResizeGame logging success; only the JS-side write
    // materialises the resize reliably on our current stack.
    let jsResized = false;
    if (canvas) {
      try {
        canvas.width  = w;
        canvas.height = h;
        jsResized = true;
      } catch { /* transferred, SDL path takes over */ }
    }
    let lastErr = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const exp = await getExports();
        // Now returns a Task — must await in MT mode (see
        // WasmViewport.cs). Await is harmless on ST (Task
        // completes immediately).
        await exp.ClassicUO.Wasm.WasmViewport.ResizeGame(w, h);
        const after = canvas ? `${canvas.width}x${canvas.height}` : 'n/a';
        const tag = attempt === 0 ? '' : ` (attempt ${attempt + 1})`;
        // The DPR-scaling experiment above was reverted to 1:1 (`const w = wCss`), so this
        // log's capTag could never fire — and the `scale` it interpolated is declared
        // nowhere, so restoring the scaling would have thrown on the first resize. Removed
        // rather than left as a landmine for whoever re-opens that experiment.
        console.log(`[viewport] resize ${why}: ${w}x${h} canvas ${before}->${after} js-write=${jsResized}${tag}`);
        maybeHideHtmlChrome();
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    console.warn('[viewport] resize call failed after 10 attempts:', lastErr);
  };

  const requestResize = (why) => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => doResize(why, window.innerWidth, window.innerHeight), 150);
  };

  // Immediate (non-debounced) resize path — used by the
  // EnteringBritania trigger below so the window.resize debounce
  // timer can't cancel the one-shot grow.
  const forceResizeNow = (why) => {
    clearTimeout(resizeTimer);
    return doResize(why, window.innerWidth, window.innerHeight);
  };

  // Debounced browser-resize listener. Only fires after the player
  // so installing it early is safe.
  window.addEventListener('resize', () => requestResize('window.resize'));

  // Belt-and-suspenders resize trigger. User reported the auto-resize
  // "se puede saltar" — multiple cases caused the canvas to stay at
  //      SelectCharacter. At that point WasmViewport.ResizeGame
  //      canvas.width=w write also throws InvalidStateError when the
  //      canvas was transferred to OffscreenCanvas in MT mode.
  //   3. Slow networks / stalled deputy threads can delay LoginComplete
  //      past any single fixed timeout.
  //
  // Strategy:
  //   * Sniff three independent signals (entering-britannia,
  //   * After the first trigger, start a polling retry (every 600 ms
  //     for up to 45 s). Each tick re-checks canvas dims; if still at
  //     the canvas grew OR after the cap.
  //   * Also re-trigger on `visibilitychange → visible` (tab refocus)
  //     and on the first pointer move inside the canvas, which cover
  //     the case where the user returns to a stuck tab.
  const LOGIN_CANVAS_MAX = 640;
  const RESIZE_POLL_MS = 600;
  const RESIZE_POLL_CAP_MS = 45_000;
  let canvasGrown = false;
  let resizePollHandle = 0;
  let resizePollStart = 0;

  const canvasLooksGrown = () => {
    if (!canvas) return false;
    // After transferControlToOffscreen the canvas's width/height
    // attributes may not track the real backing-store size. The
    // CSS rect on-screen does — it grows when ResizeGame succeeds.
    const rect = canvas.getBoundingClientRect();
    return (canvas.width > LOGIN_CANVAS_MAX) ||
           (rect.width > LOGIN_CANVAS_MAX + 8);
  };

  const stopResizePoll = (why) => {
    if (resizePollHandle) {
      clearInterval(resizePollHandle);
      resizePollHandle = 0;
      console.log(`[viewport] resize poll stopped: ${why}`);
    }
  };

  const startResizePoll = (why) => {
    if (resizePollHandle) return; // already polling
    resizePollStart = performance.now();
    console.log(`[viewport] resize poll started (trigger=${why}, every ${RESIZE_POLL_MS} ms for ${RESIZE_POLL_CAP_MS / 1000} s)`);
    resizePollHandle = setInterval(() => {
      if (canvasGrown || canvasLooksGrown()) {
        canvasGrown = true;
        stopResizePoll('canvas grew');
        return;
      }
      if (performance.now() - resizePollStart > RESIZE_POLL_CAP_MS) {
        stopResizePoll('timeout');
        return;
      }
      forceResizeNow('poll-retry');
    }, RESIZE_POLL_MS);
  };

  const triggerResize = (why) => {
    _inGame = true;
    console.log(`[viewport] ${why} received — resizing to window`);
    forceResizeNow(why);
    // Hide the pre-game welcome HTML chrome once we're confident
    // to maybeHideHtmlChrome's guard.
    const banner = document.getElementById('banner');
    const footer = document.getElementById('footer');
    const gmBtn  = document.getElementById('gamemode-toggle');
    if (banner) banner.style.display = 'none';
    if (footer) footer.style.display = 'none';
    // Keep the legacy floating fullscreen button HIDDEN: the rail's own bottom
    // fullscreen button is the single Game-Mode control (it calls the same
    // window.UORailGameMode path). Revealing this one duplicated the fullscreen
    // button and overlapped the rail's bug-report icon (operator-reported).
    if (gmBtn)  gmBtn.style.display  = 'none';
    document.body.classList.add('in-game');
    startResizePoll(why);
  };

  window.addEventListener('cuo:entering-britannia', () => triggerResize('entering-britannia'));
  window.addEventListener('cuo:gamescene-active', () => triggerResize('gamescene-active'));
  window.addEventListener('cuo:player-created', () => triggerResize('player-created'));

  // Cover the "user returns to a stuck tab" case — Chrome throttles
  // background timers + WebGL, so a resize that started while the
  // tab was hidden can land with the wrong window.innerWidth.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _inGame && !canvasGrown) {
      console.log('[viewport] visibilitychange -> visible, re-triggering resize');
      forceResizeNow('visibilitychange');
      startResizePoll('visibilitychange');
    }
  });

  // First pointer-move inside the canvas is a very reliable
  // "scene is interactive" signal — UIManager.Update has definitely
  // run at least once by then. Use it as a last-chance safety net.
  const oneShotPointerResize = (e) => {
    if (_inGame && !canvasGrown) {
      console.log('[viewport] first pointermove in-game, re-triggering resize');
      forceResizeNow('first-pointermove');
      startResizePoll('first-pointermove');
    }
    canvas?.removeEventListener('pointermove', oneShotPointerResize);
  };
  canvas?.addEventListener('pointermove', oneShotPointerResize, { once: false });

  // v0.7.7/iter64: in-world detection is PUSH via the NON-BLOCKING async
  // WasmSignal — C# LoginComplete emits "gamescene-active" through
  // wasm_signal_event_async (MAIN_THREAD_ASYNC_EM_ASM). The
  // `cuo:gamescene-active` listener above already calls triggerResize, so
  // nothing more is needed here.
  //
  // We deliberately DO NOT poll WasmViewport.IsGameScene() from main.js:
  // iter63 proved that marshalling a [JSExport] to the deputy DURING its
  // boot hangs it (boot reaches `[mt-canvas] transferred canvas to deputy
  // worker` then black canvas, never LoginGump — confirmed by a control
  // experiment vs v0.7.6 on identical cold-cache smoke). The async PUSH
  // fires post-login, and ResizeGame (the only main->deputy call) runs only
  // then, when the deputy is past boot and servicing interop between frames.
  // See docs/tuo/PORT_GUIDE.md + memory feedback_tuo_no_blocking_mainthread_rpc.

  // Hook doResize success to flip `canvasGrown` so the poll stops.
  // We can't modify doResize directly (closure), so rely on the
  // DOM rect growing — canvasLooksGrown() checks getBoundingClientRect
  // which updates synchronously with the JS-side canvas.width=w
  // write. If ResizeGame succeeded via the C# SetWindowSize path
  // without a JS-side write, the canvas element's attribute grows
  // updates the DOM rect.
})();


await runMain();
