/* ──────────────────────────────────────────────────────────────────────────
   rail.js — vertical icon rail + modern panels (Phase 1: the shell)

   Faithful HTML replica of the official ClassicUO Web right-side rail. Builds a
   DOM overlay inside #stage, shows it on cuo:gamescene-active, hides on logout.
   Phase 1 = structure only: the bar, all icons, the panel drawer with header +
   tabs + close, the toast host, latency readout, fullscreen / FAQ / bug-report.
   Panel bodies are scaffolds — the C# bridge (read/write options, macros,
   profiles, the JS scripting engine, agents) lands in Phase 2-4.

   SHARED verbatim by classicuo-wasm AND tazuo-wasm. Client-specific copy comes
   from CLIENT_CFG (selected by path: /tuo/* → tuo, else cuo). No forking.

   Public API (window.UORail): open(id) / close() / toggle(id) / toast(text,opts)
   / setLatency(ms) / isReady(). The C# WASM client can call these via JSImport,
   and dispatch cuo:* CustomEvents the rail listens for (profile-loaded, ping).
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  if (window.__uorailBooted) return;
  window.__uorailBooted = true;

  // Bundle detection: main.js sets window.__bundle in a synchronous IIFE at its
  // top (runs before this deferred script), and it SURVIVES the history.replaceState
  // that the TUO bundle does to strip the "/tuo/" prefix — so location.pathname is
  // an unreliable signal (it reads "/" on every TUO session). Prefer __bundle;
  // fall back to pathname for the standalone docs/dev preview (no main.js).
  var CLIENT = (window.__MINI__ === true) ? "mini"
             : (window.__bundle === "tuo") ? "tuo"
             : (window.__bundle === "cuo") ? "cuo"
             : (location.pathname.indexOf("/tuo") === 0 ? "tuo" : "cuo");
  // Needed by the restored Scripting panel: LEGION_Q busts the legion-*.js cache alongside
  // rail.js, and _legionLoading gates concurrent LegionScript engine loads.
  var LEGION_Q = RAIL_VER ? ("?v=" + RAIL_VER) : "";
  var _legionLoading = false;

  // Base URL + version token of THIS client's bundle, derived from rail.js's own
  // (fingerprinted) script URL so each client loads its OWN legion-engine.js
  // (+ worker + pyodide) with zero cross-client coupling. Works for cuo/tuo/mini
  // alike; falls back to /<CLIENT>/ if the script tag can't be located.
  // RAIL_VER is rail's content hash → used as a ?v= cache-buster on the
  // non-fingerprinted legion-*.js so an update is never served stale from the
  // immutable 1y cache (the hash changes every build).
  var RAIL_BASE = "/" + CLIENT + "/", RAIL_VER = "";
  (function () {
    try {
      var ss = document.getElementsByTagName("script");
      for (var i = 0; i < ss.length; i++) {
        var src = ss[i].src || "";
        var m = src.match(/\/(rail(?:\.([^\/.]+))?\.js)(?:\?|$)/);
        if (m) { RAIL_BASE = src.replace(/rail\.[^\/]*$/, ""); RAIL_VER = m[2] || ""; return; }
      }
    } catch (e) {}
  })();
  // In a real game host (__bundle set by main.js) the script-derived base can
  // LIE: the TUO bundle's history.replaceState strips "/tuo/" before the
  // parser reaches the rail <script>, so its relative src resolves against "/"
  // and legion-engine.js was requested from the WRONG bundle root (prod 404,
  // player console 2026-07-18). The bundle name is authoritative there; the
  // script-derived base stays only for the standalone docs/dev preview.
  if (window.__bundle && RAIL_BASE.indexOf("/" + CLIENT + "/") < 0) {
    RAIL_BASE = "/" + CLIENT + "/";
  }

  // Client-specific copy. Layout/icons are identical; only wording differs
  // (e.g. the scripting model: CUO≈Razor agents, TUO≈LegionScript/IronPython).
  var CLIENT_CFG = {
    cuo: {
      scriptingModel: "a JavaScript macro API",
      hasAgentsToday: false,
    },
    // The mini is a CUO build → its rail copy mirrors cuo's. Without this arm
    // CLIENT_CFG[CLIENT] is undefined for CLIENT==='mini' and the rail copy breaks.
    mini: {
      scriptingModel: "a JavaScript macro API",
      hasAgentsToday: false,
    },
    tuo: {
      scriptingModel: "a JavaScript macro API",
      hasAgentsToday: true,
    },
    // Any unknown CLIENT (a future 4th alias riding shared rail.js) falls back to
    // the cuo copy instead of leaving CLIENT_CFG undefined → TypeError at the eager
    // PANELS deref of CLIENT_CFG.scriptingModel, which dead-boots the whole rail
    // for that client only (modularity audit 2026-06-27 C3).
  }[CLIENT] || { scriptingModel: "a JavaScript macro API", hasAgentsToday: false };

  // External links (kept generic; brand Discord, not ModernUO's).
  // 🚨 NO COMMUNITY LINK IS BAKED IN HERE. This used to be a real Discord invite written out
  // in full, which means every self-hoster shipped a "Report a bug" button that sent THEIR
  // players to somebody else's community. The published repository already states the rule --
  // "a published repo must not carry one community's link" -- and index.html was scrubbed for
  // exactly this; the rail was missed, so the rule held in one file and not in the other.
  //
  // It comes from /api/config now, like the landing icon does. Unset means the button is never
  // added: an affordance that goes nowhere is worse than no affordance.
  var LINK_BUG = "";

  /* ── icons (24x24, stroke=currentColor) ──────────────────────────────── */
  var I = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>',
    // language-neutral "code" glyph (</>): the Scripting panel hosts BOTH JS and
    // LegionScript, so the bar icon must not be the JavaScript logo.
    code: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4M13.5 6l-3 12"/>',
    gear: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512"><path d="M230.357 17.62c-5.547.092-11.576 1.096-18.023 3.204-23.305 7.618-73.14 45.618-83.234 99.074 45.49-22.467 84.27-17.018 107.437-25.052 52.28-18.113 38.996-77.965-6.18-77.225zm120.215 54.4c-12.926.01-26.166 1.873-39.002 6.37 42.205 28.16 56.877 64.468 75.414 80.518 46.965 40.667 98.17-16.56 52.004-57.972-13.688-12.28-49.637-28.94-88.416-28.915zm-70.3 38.177c-19.064-.228-41 3.8-59.237 16.246 36.71 12.436 54.713 36.326 71.565 44.502h.002c42.693 20.722 69.162-31.628 26.91-53.056-7.83-3.974-22.416-7.49-39.24-7.693zm-90.295 15.278c-6.9-.114-14.648 2.048-22.71 7.304-15.69 10.228-44.953 48.12-41.83 89.562 29.127-25.574 58.818-29.222 74.327-39.727 31.31-21.207 17.284-56.694-9.787-57.14zM69.723 138.68c-16.972-.096-34.502 11.827-40.094 38.377-5.056 23.994 2.93 86.155 44.183 121.62 3.285-50.63 27.397-81.49 32.02-105.568 6.603-34.317-14.29-54.307-36.11-54.43zm282.162 22.603c7.584 38.012-4.102 65.546-2.758 84.23 3.4 47.335 61.976 44.085 59.406-3.224-1.01-18.703-19.197-62.992-56.648-81.007zm-95.64 27.38c-37.658 0-68.384 30.728-68.384 68.382 0 37.655 30.73 68.38 68.384 68.38 37.657 0 68.38-30.726 68.38-68.38 0-37.655-30.725-68.383-68.38-68.383zm0 18.68c27.558 0 49.702 22.143 49.702 49.702 0 27.56-22.14 49.7-49.703 49.7-27.56 0-49.703-22.14-49.703-49.7 0-27.56 22.143-49.703 49.704-49.703zm182.507 8.317c-3.286 50.63-27.396 81.49-32.02 105.57-11.738 61.004 63.423 76.735 76.205 16.05 5.054-23.995-2.932-86.156-44.185-121.62zm-305.86 19.27c-15.24.07-30.174 12.75-28.85 37.144 1.013 18.702 19.198 62.99 56.65 81.006-7.585-38.01 4.1-65.548 2.757-84.232-1.648-22.928-16.24-33.986-30.557-33.918zm254.247 57.09c-29.128 25.575-58.82 29.223-74.327 39.728-39.293 26.613-7.19 75.712 32.496 49.834 15.69-10.228 44.952-48.117 41.83-89.56zm-185.79 46.64c-30.664-.36-43.938 39.734-8.287 57.815 16.704 8.476 64.15 14.87 98.476-8.555-36.71-12.436-54.714-36.326-71.565-44.502h-.002c-6.67-3.238-12.945-4.69-18.623-4.758zm-108.18 2.844c-33.205-.786-54.937 40.19-19.592 71.896 18.25 16.375 76.075 40.54 127.416 22.545-42.204-28.16-56.877-64.467-75.414-80.515-11.007-9.532-22.245-13.686-32.41-13.926zm290.295 52.935c-45.488 22.465-84.27 17.016-107.436 25.05h-.003c-58.7 20.337-34.744 93.295 24.203 74.022 23.305-7.616 73.14-45.618 83.235-99.073z"></path></svg>',
    js:   '<svg stroke="currentColor" fill="currentColor" stroke-width="0" role="img" viewBox="0 0 24 24"><title></title><path d="M0 0h24v24H0V0zm22.034 18.276c-.175-1.095-.888-2.015-3.003-2.873-.736-.345-1.554-.585-1.797-1.14-.091-.33-.105-.51-.046-.705.15-.646.915-.84 1.515-.66.39.12.75.42.976.9 1.034-.676 1.034-.676 1.755-1.125-.27-.42-.404-.601-.586-.78-.63-.705-1.469-1.065-2.834-1.034l-.705.089c-.676.165-1.32.525-1.71 1.005-1.14 1.291-.811 3.541.569 4.471 1.365 1.02 3.361 1.244 3.616 2.205.24 1.17-.87 1.545-1.966 1.41-.811-.18-1.26-.586-1.755-1.336l-1.83 1.051c.21.48.45.689.81 1.109 1.74 1.756 6.09 1.666 6.871-1.004.029-.09.24-.705.074-1.65l.046.067zm-8.983-7.245h-2.248c0 1.938-.009 3.864-.009 5.805 0 1.232.063 2.363-.138 2.711-.33.689-1.18.601-1.566.48-.396-.196-.597-.466-.83-.855-.063-.105-.11-.196-.127-.196l-1.825 1.125c.305.63.75 1.172 1.324 1.517.855.51 2.004.675 3.207.405.783-.226 1.458-.691 1.811-1.411.51-.93.402-2.07.397-3.346.012-2.054 0-4.109 0-6.179l.004-.056z"></path></svg>',
    keyboard: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512"><path d="M247 21.074c0 10.508 7.18 18.167 14.71 23.412 7.532 5.246 16.41 9.202 24.698 13.15 8.287 3.95 15.954 7.94 20.332 11.657 4.378 3.717 5.225 5.25 4.46 8.82-.497 2.315-1.215 3.316-2.612 4.46-1.397 1.146-3.766 2.287-7.15 3.107-6.77 1.64-17.084 1.778-27.94 1.722-10.856-.055-22.27-.272-32.76 1.975-10.49 2.246-21.296 8.173-25.252 19.7-2.59 7.548-.236 15.34 3.37 20.804 3.605 5.464 8.328 9.71 12.857 13.696 2.997 2.638 5.89 5.126 8.355 7.424h22.875c-1.575-3.354-3.862-6.223-6.168-8.754-4.138-4.544-8.918-8.44-13.17-12.182-4.25-3.74-7.917-7.357-9.726-10.1-1.81-2.74-1.9-3.496-1.368-5.044 1.518-4.425 4.565-6.35 11.996-7.94 7.43-1.593 18.006-1.633 28.898-1.578 10.892.056 22.087.24 32.27-2.228 5.09-1.234 10.058-3.184 14.322-6.678 4.264-3.494 7.53-8.68 8.8-14.61 2.275-10.606-3.357-20.327-10.41-26.314-7.052-5.987-15.765-10.15-24.238-14.185-8.472-4.037-16.733-7.896-22.152-11.67-5.42-3.775-6.998-6.34-6.998-8.643h-18zM41 169v174h430V169H41zm7 14h16v18H48v-18zm32 0h16v18H80v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm48 0h48v18h-48v-18zm96 0h32v18h-32v-18zM48 215h32v18H48v-18zm48 0h16v18H96v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h32v18h-32v-18zm48 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm-127.87 25h18v57h-25v-18h7v-39zM48 247h16v18H48v-18zm32 0h16v18H80v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm96 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm-96 16h16v18h-16v-18zM48 279h32v18H48v-18zm48 0h16v18H96v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm112 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zM48 311h16v18H48v-18zm32 0h16v18H80v-18zm32 0h144v18H112v-18zm160 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h16v18h-16v-18zm32 0h48v18h-48v-18zm64 0h16v18h-16v-18z"></path></svg>',
    agents: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512"><path d="M218 19c-1 0-2.76.52-5.502 3.107-2.742 2.589-6.006 7.021-9.191 12.76-6.37 11.478-12.527 28.033-17.666 45.653-4.33 14.844-7.91 30.457-10.616 44.601 54.351 24.019 107.599 24.019 161.95 0-2.706-14.144-6.286-29.757-10.616-44.601-5.139-17.62-11.295-34.175-17.666-45.653-3.185-5.739-6.45-10.171-9.191-12.76C296.76 19.52 295 19 294 19c-6.5 0-9.092 1.375-10.822 2.85-1.73 1.474-3.02 3.81-4.358 7.34-1.338 3.53-2.397 8.024-5.55 12.783C270.116 46.73 263.367 51 256 51c-7.433 0-14.24-4.195-17.455-8.988-3.214-4.794-4.26-9.335-5.576-12.881-1.316-3.546-2.575-5.867-4.254-7.315C227.035 20.37 224.5 19 218 19zm-46.111 124.334c-1.41 9.278-2.296 17.16-2.57 22.602 6.61 5.087 17.736 10.007 31.742 13.302C217.18 183.031 236.6 185 256 185s38.82-1.969 54.94-5.762c14.005-3.295 25.13-8.215 31.742-13.302-.275-5.443-1.161-13.324-2.57-22.602-55.757 23.332-112.467 23.332-168.223 0zM151.945 155.1c-19.206 3.36-36.706 7.385-51.918 11.63-19.879 5.548-35.905 11.489-46.545 16.57-5.32 2.542-9.312 4.915-11.494 6.57-.37.28-.247.306-.445.546.333.677.82 1.456 1.73 2.479 1.973 2.216 5.564 4.992 10.627 7.744 10.127 5.504 25.944 10.958 45.725 15.506C139.187 225.24 194.703 231 256 231s116.813-5.76 156.375-14.855c19.78-4.548 35.598-10.002 45.725-15.506 5.063-2.752 8.653-5.528 10.627-7.744.91-1.023 1.397-1.802 1.73-2.479-.198-.24-.075-.266-.445-.547-2.182-1.654-6.174-4.027-11.494-6.568-10.64-5.082-26.666-11.023-46.545-16.57-15.212-4.246-32.712-8.272-51.918-11.631.608 5.787.945 10.866.945 14.9v3.729l-2.637 2.634c-10.121 10.122-25.422 16.191-43.302 20.399C297.18 200.969 276.6 203 256 203s-41.18-2.031-59.06-6.238c-17.881-4.208-33.182-10.277-43.303-20.399L151 173.73V170c0-4.034.337-9.113.945-14.9zm1.094 88.205C154.558 308.17 200.64 359 256 359c55.36 0 101.442-50.83 102.96-115.695a748.452 748.452 0 0 1-19.284 2.013c-1.33 5.252-6.884 25.248-15.676 30.682-13.61 8.412-34.006 7.756-48 0-7.986-4.426-14.865-19.196-18.064-27.012-.648.002-1.287.012-1.936.012-.65 0-1.288-.01-1.936-.012-3.2 7.816-10.078 22.586-18.064 27.012-13.994 7.756-34.39 8.412-48 0-8.792-5.434-14.346-25.43-15.676-30.682a748.452 748.452 0 0 1-19.285-2.013zM137.4 267.209c-47.432 13.23-77.243 32.253-113.546 61.082 42.575 4.442 67.486 21.318 101.265 48.719l16.928 13.732-21.686 2.211c-13.663 1.393-28.446 8.622-39.3 17.3-5.925 4.738-10.178 10.06-12.957 14.356 44.68 5.864 73.463 10.086 98.011 20.147 18.603 7.624 34.81 18.89 53.737 35.781l5.304-23.576c-1.838-9.734-4.134-19.884-6.879-30.3-5.12-7.23-9.698-14.866-13.136-22.007C201.612 397.326 199 391 199 384c0-3.283.936-6.396 2.428-9.133a480.414 480.414 0 0 0-6.942-16.863c-29.083-19.498-50.217-52.359-57.086-90.795zm237.2 0c-6.87 38.436-28.003 71.297-57.086 90.795a480.521 480.521 0 0 0-6.942 16.861c1.493 2.737 2.428 5.851 2.428 9.135 0 7-2.612 13.326-6.14 20.654-3.44 7.142-8.019 14.78-13.14 22.01-2.778 10.547-5.099 20.82-6.949 30.666l5.14 23.42c19.03-17.01 35.293-28.338 53.974-35.994 24.548-10.06 53.33-14.283 98.011-20.147-2.78-4.297-7.032-9.618-12.957-14.355-10.854-8.679-25.637-15.908-39.3-17.3l-21.686-2.212 16.928-13.732c33.779-27.4 58.69-44.277 101.265-48.719-36.303-28.829-66.114-47.851-113.546-61.082zM256 377c-8 0-19.592.098-28.234 1.826-4.321.864-7.8 2.222-9.393 3.324-1.592 1.103-1.373.85-1.373 1.85s1.388 6.674 4.36 12.846c2.971 6.172 7.247 13.32 11.964 19.924 4.717 6.604 9.925 12.699 14.465 16.806 4.075 3.687 7.842 5.121 8.211 5.377.37-.256 4.136-1.69 8.21-5.377 4.54-4.107 9.749-10.202 14.466-16.806 4.717-6.605 8.993-13.752 11.965-19.924C293.612 390.674 295 385 295 384s.22-.747-1.373-1.85c-1.593-1.102-5.072-2.46-9.393-3.324C275.592 377.098 264 377 256 377zm0 61.953c-.042.03-.051.047 0 .047s.042-.018 0-.047zm-11.648 14.701L235.047 495h41.56l-9.058-41.285C264.162 455.71 260.449 457 256 457c-4.492 0-8.235-1.316-11.648-3.346z"></path></svg>',
    globe: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4.083 9h1.946c.089-1.546.383-2.97.837-4.118A6.004 6.004 0 004.083 9zM10 2a8 8 0 100 16 8 8 0 000-16zm0 2c-.076 0-.232.032-.465.262-.238.234-.497.623-.737 1.182-.389.907-.673 2.142-.766 3.556h3.936c-.093-1.414-.377-2.649-.766-3.556-.24-.56-.5-.948-.737-1.182C10.232 4.032 10.076 4 10 4zm3.971 5c-.089-1.546-.383-2.97-.837-4.118A6.004 6.004 0 0115.917 9h-1.946zm-2.003 2H8.032c.093 1.414.377 2.649.766 3.556.24.56.5.948.737 1.182.233.23.389.262.465.262.076 0 .232-.032.465-.262.238-.234.498-.623.737-1.182.389-.907.673-2.142.766-3.556zm1.166 4.118c.454-1.147.748-2.572.837-4.118h1.946a6.004 6.004 0 01-2.783 4.118zm-6.268 0C6.412 13.97 6.118 12.546 6.03 11H4.083a6.004 6.004 0 002.783 4.118z" clip-rule="evenodd"></path></svg>',
    fullscreen: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24"><g><path fill="none" d="M0 0h24v24H0z"></path><path d="M16 3h6v6h-2V5h-4V3zM2 3h6v2H4v4H2V3zm18 16v-4h2v6h-6v-2h4zM4 19h4v2H2v-6h2v4z"></path></g></svg>',
    // camera — Screenshot rail action (operator 2026-06-24): a dependable capture
    // trigger, since the OS intercepts the PrintScreen key outside fullscreen.
    camera: '<path d="M4 8h3l1.6-2.2h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.3"/>',
    faq:  '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.5 1.5c0 1.8-2 2-2 3.5M12 17.5h.01"/>',
    bug:  '<rect x="7" y="8" width="10" height="11" rx="5"/><path d="M9 8a3 3 0 0 1 6 0M4.5 11h2.5M17 11h2.5M4 16h3M17 16h3M5 21l2.5-2M19 21l-2.5-2M12 4.5V3"/>',
    // backpack — the official Loot tab shows a backpack in the autoloot slot
    // (the autoloot target container). Hand-drawn stroke glyph, gold-tinted in CSS.
    backpack: '<path d="M8 8V7a4 4 0 0 1 8 0v1"/><rect x="5" y="8" width="14" height="13" rx="3"/><path d="M9.5 8V7.5a2.5 2.5 0 0 1 5 0V8M5 13h14M10 13v3.5h4V13"/>',
    // shield-check — GM Tools (staff-only) rail icon.
    shield: '<path d="M12 3l7 3v5.5c0 4.4-3 7.4-7 8.5-4-1.1-7-4.1-7-8.5V6l7-3z"/><path d="M9.2 12l1.9 1.9 3.7-3.8"/>',
    // gamepad — Minigames rail icon (operator 2026-07-02: launch TBH over the game).
    gamepad: '<rect x="3" y="8" width="18" height="9" rx="4.5"/><path d="M8 10.8v3.4M6.3 12.5h3.4M15.6 11.2h.01M17.6 13.4h.01"/>',
  };
  function svg(paths, cls) {
    // Official react-icons are stored as a full <svg …> string (fill-based, own
    // viewBox) — pass them through (CSS sizes them). Hand-drawn icons are
    // path-only fragments wrapped in our stroke <svg>.
    if (paths && paths.lastIndexOf("<svg", 0) === 0) {
      return cls ? paths.replace("<svg", '<svg class="' + cls + '"') : paths;
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round"' + (cls ? ' class="' + cls + '"' : '') +
      '>' + paths + '</svg>';
  }

  /* ── panel definitions. Tab panels render faithful per-tab forms via
     renderTab(tabName, body, panel) (matches webclient/fotos-original/). ── */
  // MINIMAL BUILD: four panels. The full client also ships Scripting, Agents, Minigames and
  // GM Tools; none of them belongs in a self-hosted client — Minigames and GM Tools are uonexus
  // features outright, and dropping Scripting takes legion-*.js and the whole pyodide/ runtime
  // with it, which is most of the rail's download weight.
  var PANELS = [
    { id: "user",     icon: I.user,     tip: "User",
      tabs: ["Profile", "Storage Management", "Performance"], renderTab: renderUser,
      blurb: "Your Discord account, cloud settings sync, and browser storage tools." },
    // Gear = the client's OWN native options window. native:true = bar button with NO rail
    // panel; the click handler routes it straight to the openNativeOptions bridge.
    { id: "options",  icon: I.gear,     tip: "Game Options", native: true },
    // Macros only. The full client also exposes Combat / General / Skills / Spells / Target
    // here; keeping one tab keeps the panel honest about what this build offers.
    // Scripting stays in this build (operator 2026-08-18: "Scripting también debería estar. Tanto
    // JS como LS"). Both languages, and with them the sandbox that contains them: JS runs in an
    // <iframe sandbox="allow-scripts"> on a throwaway origin, LegionScript runs CPython in a worker
    // that SHARES this page origin — which is what makes it a full Python and also why imported
    // scripts get screened. Shipping the panel without that screening would be the wrong half.
    { id: "scripting", icon: I.code,    tip: "Scripting",
      tabs: null, render: renderScripting,
      blurb: "A built-in JavaScript editor with " + CLIENT_CFG.scriptingModel + "." },
    { id: "hotkeys",  icon: I.keyboard, tip: "Macros",
      tabs: ["Macros"],
      renderTab: renderHotkeys, search: "Search bindings",
      blurb: "Macro builder and key bindings." },
    { id: "agents",   icon: I.agents,   tip: "Agents",
      tabs: ["Loot", "Restock", "Dress", "Lists", "Chat", "Filters", "Recording", "Durability"], renderTab: renderAgents,
      blurb: "Loot, Restock, Dress and more." },
    { id: "worldmap", icon: I.globe,    tip: "World Map",
      tabs: null, render: renderWorldMap,
      blurb: "Live position sharing — see your group on the map (per-shard private rooms)." },
  ];

  var root, bar, panel, panelTitle, panelTabs, panelBody, toastHost, latencyEl;
  var activeId = null;

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (html != null) n.innerHTML = html;
    return n;
  }

  // Make the panel draggable by its header (the official client lets you move
  // menu windows freely). On first drag we convert from the default right/top
  // anchoring to left/top and clear the open-animation transform; the dragged
  // position then persists across panel switches. Pointer-capture keeps the
  // drag smooth even when the cursor leaves the header / crosses the canvas.
  function makePanelDraggable(panelEl, handle) {
    var drag = null;
    handle.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || (e.target && e.target.closest && e.target.closest("#uorail-panel-close"))) return;
      var r = panelEl.getBoundingClientRect();
      panelEl.style.left = r.left + "px";
      panelEl.style.top = r.top + "px";
      panelEl.style.right = "auto";
      panelEl.style.transform = "none";
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width };
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    handle.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var x = e.clientX - drag.dx, y = e.clientY - drag.dy;
      // keep at least ~60px of the header on-screen so it stays grabbable
      x = Math.max(60 - drag.w, Math.min(x, window.innerWidth - 60));
      y = Math.max(0, Math.min(y, window.innerHeight - 38));
      panelEl.style.left = x + "px";
      panelEl.style.top = y + "px";
    });
    function end(e) { if (drag) { drag = null; try { handle.releasePointerCapture(e.pointerId); } catch (_) {} } }
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function build() {
    root = el("div", { id: "uorail-root" });

    bar = el("div", { id: "uorail-bar", "data-pointer": "auto" });

    PANELS.forEach(function (p) {
      var b = el("button", {
        "class": "uorail-btn" + (p.disabled ? " uorail-btn-disabled" : ""), "data-panel": p.id, "data-tip": p.tip,
        "data-pointer": "auto", "aria-label": p.tip, type: "button",
      }, svg(p.icon));
      b.addEventListener("click", function () {
        // native:true entries (the Game Options gear) have no rail panel at all —
        // they hand straight to the client's own options window on every client.
        if (p.native) {
          var br = window.UORailBridge;
          if (br && typeof br.openNativeOptions === "function") { br.openNativeOptions(); }
          return;
        }
        toggle(p.id);
      });
      bar.appendChild(b);
    });

    bar.appendChild(el("div", { "class": "uorail-spacer" }));
    bar.appendChild(el("div", { "class": "uorail-sep" }));

    // latency readout
    latencyEl = el("div", { id: "uorail-latency", "data-tip": "Latency" },
      '<span class="uorail-ping-dot"></span><span class="uorail-ping-ms">—</span>');
    bar.appendChild(latencyEl);

    // ⚠️ NO SCREENSHOT BUTTON IN THIS BUILD (operator, 2026-08-27). Upstream it exists because the
    // shot goes into a ring-buffer the web profile can publish from; there is no profile here, so
    // it had nowhere to go. It was changed to download the PNG instead, and the operator's reading
    // is that a browser client does not need its own screenshot button at all — the OS and the
    // browser both already take one, and a rail slot is worth more than a duplicate.
    //
    // window.UONexusScreenshot still exists (main.js), so a self-hoster who wants it back needs
    // only re-add the button; nothing else was removed.

    // fullscreen — official renders a large ~40px glyph (not the mini size).
    var fs = el("button", {
      "class": "uorail-btn uorail-fs", "data-tip": "Fullscreen",
      "data-pointer": "auto", "aria-label": "Fullscreen", type: "button",
    }, svg(I.fullscreen));
    fs.addEventListener("click", toggleFullscreen);
    bar.appendChild(fs);

    // No FAQ link here: the FAQ lives on the site, and the rail is for things you
    // cannot reach from a page you are not currently looking at.

    // Bug report — official renders a TEXT link "🐛 Bug Report" in gold, not an icon.
    //
    // Appended only once an invite has been resolved, rather than created hidden and revealed: a
    // control shown by clearing style.display does not appear at all when the stylesheet says none,
    // which this project has already paid for once. Appending later still lands it last in the bar,
    // which is where it belongs.
    (function wireBugLink() {
      fetch("/api/config", { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (cfg) {
          var invite = String((cfg && cfg.discordInvite) || "").trim();
          if (!invite) return;
          // http(s) only. The value is this install's own configuration, but the check costs nothing
          // and keeps a mistyped javascript: out of something the client will open.
          try {
            var u = new URL(invite);
            if (u.protocol !== "https:" && u.protocol !== "http:") return;
          } catch (e) { return; }
          LINK_BUG = invite;
          var bug = el("button", {
            "class": "uorail-textlink uorail-textlink-gold", "data-pointer": "auto", "aria-label": "Report a bug", type: "button",
          }, "🐛 Bug Report");
          bug.addEventListener("click", function () { openExternal(LINK_BUG); });
          bar.appendChild(bug);
        })
        .catch(function () { /* offline: no button, which is the honest state */ });
    }());

    root.appendChild(bar);

    // panel drawer
    panel = el("div", { id: "uorail-panel", "data-pointer": "auto" });
    var head = el("div", { id: "uorail-panel-head" });
    panelTitle = el("div", { id: "uorail-panel-title" }, "");
    var close = el("button", { id: "uorail-panel-close", "aria-label": "Close", type: "button" }, "×");
    close.addEventListener("click", function () { closePanel(); });
    head.appendChild(panelTitle);
    head.appendChild(close);
    panel.appendChild(head);
    makePanelDraggable(panel, head);

    // content row: LEFT vertical nav (tabs / script list) + body — matches the
    // official ClassicUO Web layout (panels use a left sidebar, not top tabs).
    var content = el("div", { id: "uorail-panel-content" });
    panelTabs = el("div", { id: "uorail-panel-nav" });
    panelBody = el("div", { id: "uorail-panel-body" });
    content.appendChild(panelTabs);
    content.appendChild(panelBody);
    panel.appendChild(content);

    root.appendChild(panel);

    // toast host
    toastHost = el("div", { id: "uorail-toasts" });
    // main.js publishes the weak-machine signal during boot; it is consulted here, with the
    // toast host already created. Waiting for the bridge happens inside.
    setTimeout(maybeSuggestPerformance, 4000);
    root.appendChild(toastHost);

    var stage = document.getElementById("stage") || document.body;
    stage.appendChild(root);

    // Reveal staff-only rail panels (GM Tools) for admins / shard owners.

    // close on Escape
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && activeId) { closePanel(); }
    });
  }

  // Live filter for the panel's "Search options…" / "Search bindings" box.
  // Hides controls (checkboxes, sliders, selects, hue swatches, macro list rows)
  // whose label doesn't match, then hides any group header (.uorail-sub) left
  // with no visible control. Generic over the Options/Hotkeys body structure;
  // a no-op for panels without these elements.
  function applyPanelSearch(body, q) {
    if (!body) return;
    q = String(q || "").trim().toLowerCase();
    body.querySelectorAll(".uorail-radio").forEach(function (el) {
      var t = (el.querySelector(".uorail-radio-txt") || el).textContent.toLowerCase();
      el.style.display = (!q || t.indexOf(q) >= 0) ? "" : "none";
    });
    body.querySelectorAll(".uorail-radios").forEach(function (row) {
      var any = Array.prototype.some.call(row.querySelectorAll(".uorail-radio"), function (r) { return r.style.display !== "none"; });
      row.style.display = any ? "" : "none";
    });
    body.querySelectorAll(".uorail-field, .uorail-huefield").forEach(function (el) {
      var lbl = el.querySelector(".uorail-field-lbl");
      var t = (lbl ? lbl.textContent : el.textContent).toLowerCase();
      el.style.display = (!q || t.indexOf(q) >= 0) ? "" : "none";
    });
    body.querySelectorAll(".uorail-hk-item").forEach(function (el) {
      el.style.display = (!q || el.textContent.toLowerCase().indexOf(q) >= 0) ? "" : "none";
    });
    body.querySelectorAll(".uorail-bind-row").forEach(function (el) {
      var c = el.querySelector(".uorail-bind-cmd");
      el.style.display = (!q || (c && c.textContent.toLowerCase().indexOf(q) >= 0)) ? "" : "none";
    });
    body.querySelectorAll(".uorail-sub").forEach(function (sub) {
      var n = sub.nextElementSibling, anyVisible = false;
      while (n && !n.classList.contains("uorail-sub")) {
        if (n.style.display !== "none") { anyVisible = true; break; }
        n = n.nextElementSibling;
      }
      sub.style.display = (!q || anyVisible) ? "" : "none";
    });
  }

  function renderPanel(p) {
    // header: icon + title (matches the fotos' "⚙ Game Options" etc.)
    panelTitle.innerHTML = svg(p.icon, "uorail-title-ic") + "<span>" + p.tip + "</span>";
    panelTabs.innerHTML = "";
    panelBody.innerHTML = "";
    /* 🚨 The Scripting panel ADDS uorail-script-body (padding: 0 — it owns a two-column editor
       layout) and nothing ever took it off. So every panel opened AFTER Scripting inherited zero
       padding and drew its text flush against the frame: the operator reported it against the World
       Map and said it was not the only one, which is exactly the shape of a class that leaks. The
       body is reset here, so the state that describes a panel is cleared here too. */
    panelBody.className = "";
    // Custom full-takeover renderer (scripting builds its own toolbar/editor).
    if (typeof p.render === "function") {
      panel.classList.add("uorail-no-nav");
      p.render(panelBody, p);
      return;
    }
    // LEFT vertical tab list (official layout) + faithful per-tab body.
    if (p.tabs && p.tabs.length) {
      panel.classList.remove("uorail-no-nav");
      var searchInput = null, activeTabName = p.tabs[0];
      var renderTab = (typeof p.renderTab === "function") ? p.renderTab : function (t, b) {
        b.innerHTML = '<div class="uorail-ph">' + svg(p.icon) +
          '<div><b>' + p.tip + '</b></div><div>' + p.blurb + '</div></div>';
      };
      var showTab = function (name) {
        panelBody.innerHTML = "";
        try { renderTab(name, panelBody, p); } catch (e) { panelBody.innerHTML = '<div class="uorail-note">' + esc(String(e)) + '</div>'; }
      };
      var onSearch = function () {
        var q = searchInput.value.trim();
        if (!q) { showTab(activeTabName); return; }
        // p.searchRender (Options) lists matches across ALL tabs; otherwise filter
        // the active tab in place.
        if (typeof p.searchRender === "function") { p.searchRender(q, panelBody, p); }
        else { showTab(activeTabName); applyPanelSearch(panelBody, q); }
      };
      if (p.search) {
        searchInput = el("input", {
          type: "search", "class": "uorail-navsearch", placeholder: p.search,
          "data-pointer": "auto", "aria-label": p.search, spellcheck: "false",
        });
        searchInput.addEventListener("input", onSearch);
        panelTabs.appendChild(searchInput);
        // Hotkeys/Macros tabs populate ASYNCHRONOUSLY (bridge promises), so the
        // rows didn't exist yet when applyPanelSearch ran and the filter looked
        // dead ("Search Bindings does not seem to work", 2026-07-18). Re-apply
        // the live query whenever nodes are added under the body. childList-only:
        // applyPanelSearch merely flips style.display, so no observer feedback.
        if (_panelSearchObserver) { _panelSearchObserver.disconnect(); }
        _panelSearchObserver = new MutationObserver(function () {
          var q = searchInput.value.trim();
          if (q && typeof p.searchRender !== "function") applyPanelSearch(panelBody, q);
        });
        _panelSearchObserver.observe(panelBody, { childList: true, subtree: true });
      }
      var activate = function (name, tabEl) {
        activeTabName = name;
        panelTabs.querySelectorAll(".uorail-tab").forEach(function (x) { x.classList.remove("uorail-tab-active"); });
        tabEl.classList.add("uorail-tab-active");
        if (searchInput) searchInput.value = ""; // clicking a tab clears the search
        showTab(name);
      };
      p.tabs.forEach(function (t, i) {
        var tab = el("button", { "class": "uorail-tab" + (i === 0 ? " uorail-tab-active" : ""), type: "button", "data-pointer": "auto" }, t);
        tab.addEventListener("click", function () { activate(t, tab); });
        panelTabs.appendChild(tab);
      });
      activate(p.tabs[0], panelTabs.querySelector(".uorail-tab"));
    } else {
      panel.classList.add("uorail-no-nav");
      panelBody.innerHTML =
        '<div class="uorail-ph">' + svg(p.icon) +
          '<div><b>' + p.tip + '</b></div>' +
          '<div>' + p.blurb + '</div>' +
          '<div class="uorail-ph-tag">Coming soon</div>' +
        '</div>';
    }
  }

  /* ── Scripting panel (Phase 2: editor + sandboxed JS runner) ─────────────
     User macros run in a sandboxed <iframe sandbox="allow-scripts"> (origin
     null — no DOM/cookie/network access) whose OWN CSP allows eval. The script
     talks to a `UO` API that postMessages calls back to this parent, which
     performs them (print → output console; sysmsg/pause → here; player and the
     game-control verbs → window.UORailBridge once the C# JSExport bridge lands
     in Phase 4). This keeps the host page CSP strict (no 'unsafe-eval'). The API
     surface mirrors LegionScript (TUO) / Razor (CUO) naming. */
  var SCRIPTS_KEY = "uorail.scripts." + CLIENT;
  // Scripting language. JS is the default on every client. TUO ALSO offers "ls"
  // (LegionScript — Python), surfaced as a JS|LS toggle in the editor toolbar;
  // CUO never shows the toggle (JS only). The two languages keep SEPARATE script
  // stores so a JS macro and an LS script can share a name without colliding.
  var _scriptLang = "js";
  var _editor = null, _output = null, _scriptListEl = null, _curName = null;
  var _sandbox = null;
  // ONE macro at a time (operator 2026-07-26: "solo deberia permitir un hilo").
  // Two concurrent runs would drive the SAME game bridge, so a spammed Run could
  // double every action. The hard guard lives in each engine (runScript destroys
  // its sandbox first; UORailLegion.run refuses while running) — this drives the
  // BUTTON STATE: Run glows green when idle, Stop glows red while running.
  var _scriptBusy = false, _runBtn = null, _stopBtn = null, _busyPoll = null;
  function setScriptBusy(on) {
    _scriptBusy = !!on;
    if (_runBtn) {
      _runBtn.classList.toggle("uorail-armed-run", !_scriptBusy);
      _runBtn.disabled = _scriptBusy;
      // A greyed-out button is a weak signal: players were reading the Output pane to work out
      // whether anything was still running (reported 2026-08-09). Say it on the control itself.
      // Deliberately NOT relabelled Pause, which is what was asked for: neither engine can
      // suspend a running script, and a button that says Pause and cannot pause is a worse lie
      // than saying nothing. Stop, next to it, does what Pause would promise.
      _runBtn.textContent = _scriptBusy ? "● Running…" : "▶ Run";
    }
    if (_stopBtn) _stopBtn.classList.toggle("uorail-armed-stop", _scriptBusy);
    if (_busyPoll) { clearInterval(_busyPoll); _busyPoll = null; }
  }
  var _railUpdateGutter = null;
  function activeScriptsKey() { return _scriptLang === "ls" ? ("uorail.lscripts." + CLIENT) : SCRIPTS_KEY; }
  // Practical, player-oriented starters — real things you'd actually macro on a
  // shard (train a skill, heal, fight, loot, keep a buff up), not API demos. Some
  // use verbs your shard's admin must enable (scan/grab/etc.); if a line says
  // "disabled by this shard's script policy", ask the admin to switch it on.
  var EXAMPLES = {
    "Train a skill": "// The classic skill grind: bark, use the skill on yourself, wait, repeat.\n// Swap Anatomy for whatever skill you're raising; tune the delay to your shard.\nwhile (true) {\n  player.say('Practicing...');\n  player.useSkill(Skills.Anatomy);\n  await target.waitTargetEntity(player);   // many skills target you\n  await sleep(11000);\n}",
    "Heal when hurt": "// Cast Greater Heal on yourself whenever your HP drops below 70%.\nwhile (true) {\n  const p = await player.refresh();\n  if (p.ingame && p.hitsmax && p.hits < p.hitsmax * 0.7) {\n    p.castSpell(Spells.GreaterHeal);\n    await sleep(600);\n    await target.self();\n    await sleep(3000);\n  }\n  await sleep(800);\n}",
    "Attack nearest monster": "// Find the closest creature and attack it — scan() hands you the serial,\n// so there's no hex to look up. Skips players and corpses.\nwhile (true) {\n  const foes = (await scan(12, 1)).filter(m => !m.dead && !m.isHuman);\n  foes.sort((a, b) => a.dist - b.dist);\n  if (foes.length) { msg('Attacking ' + (foes[0].name || 'creature')); await target.entity(foes[0].serial); }\n  await sleep(1500);\n}",
    "Loot a corpse": "// Pick a corpse once, then grab everything in it into your backpack.\nconst bp = await backpack();\nprint('Pick the corpse to loot…');\nconst c = await pick();\nif (c) {\n  let n = 0;\n  for (const it of await items(c.serial)) { await grabItem(it.serial, it.amount || 1, bp); n++; await sleep(700); }\n  msg('Looted ' + n + ' item(s).');\n}",
    "Keep Bless up": "// Re-cast Bless on yourself on a timer so it never lapses.\nwhile (true) {\n  player.castSpell(Spells.Bless);\n  await sleep(700);\n  await target.self();\n  await sleep(90000);   // Bless lasts a while; recast just before it ends\n}",
    "Player info (learn the API)": "// A readout TO YOU (msg/print go to this console, not in-world chat).\nconst p = await player.refresh();\nprint('You are ' + p.name);\nprint('Pos: ' + p.x + ', ' + p.y + ', ' + p.z);\nmsg('HP ' + p.hits + '/' + p.hitsmax + '   Mana ' + p.mana + '/' + p.manamax);",
  };
  // LegionScript (Python) starters — TazUO's real `API.*` surface. Mirrors the
  // desktop LegionScript so scripts are portable. (Execution engine — CPython via
  // Pyodide over the C# bridge — lands in a later dev phase; see
  // docs/dev/LEGION_SCRIPT_PYTHON_PORT_STUDY.md. The editor, examples, save/load
  // and syntax highlight work now.)
  var LS_EXAMPLES = {
    "Train a skill": "# Classic skill grind in LegionScript (Python).\n# Bark, use the skill on yourself, wait, repeat.\nwhile True:\n    API.Msg(\"Practicing...\")\n    API.UseSkill(\"Anatomy\")\n    if API.WaitForTarget():\n        API.TargetSelf()\n    API.Pause(11)\n",
    "Heal when hurt": "# Cast Greater Heal on yourself when HP drops below 70%.\nwhile True:\n    if API.Player.Hits < API.Player.HitsMax * 0.7:\n        API.CastSpell(\"Greater Heal\")\n        if API.WaitForTarget():\n            API.TargetSelf()\n        API.Pause(3)\n    API.Pause(0.8)\n",
    "Attack nearest monster": "# Find the nearest enemy and attack it.\nwhile True:\n    enemy = API.NearestEntity(API.ScanType.Hostile, 12)\n    if enemy:\n        API.HeadMsg(\"Attacking!\", API.Player.Serial)\n        API.Attack(enemy.Serial)\n    API.Pause(1.5)\n",
    "Loot gold from a corpse": "# Pick a corpse, then grab all gold from it.\nAPI.SysMessage(\"Target the corpse to loot...\", 88)\ncorpse = API.RequestTarget()\nif corpse:\n    for item in API.ItemsInContainer(corpse):\n        if item.Graphic == 0x0EED:   # gold\n            API.MoveItem(item.Serial, API.Backpack)\n            API.Pause(0.7)\n",
    "Player info (learn the API)": "# Read your own stats to the journal.\nAPI.SysMessage(\"You are \" + API.Player.Name, 68)\nAPI.SysMessage(\"HP %d/%d  Mana %d/%d\" % (API.Player.Hits, API.Player.HitsMax, API.Player.Mana, API.Player.ManaMax), 68)\n",
  };
  // ── Screening for scripts you did not write (operator 2026-08-04) ──────────
  //
  // WHY THIS EXISTS, and what it is NOT. The two scripting languages are equally capable but
  // NOT equally contained: JavaScript runs in an <iframe sandbox="allow-scripts"> with no
  // allow-same-origin, so it gets a throwaway origin and can only reach the game API.
  // LegionScript runs real CPython in a worker that SHARES this page's origin, which is what
  // lets it be a full Python — and also means a hostile file can act as the signed-in browser
  // rather than merely rearranging a backpack. Scripts have been passed around in UO since
  // Razor, so "somebody else wrote it" is the normal case, not the exotic one.
  //
  // 🚨 THIS IS ADVISORY, NOT A BOUNDARY, and saying so is the point — a warning presented as a
  // guarantee is worse than no warning. A determined author can express any of this in a shape
  // no list anticipates. What makes it worth having anyway is the operator's framing: HIDING is
  // itself one of the flags. A macro that moves items and casts spells has no reason to decode
  // base64, build code at runtime, or import by name, so an author who wants to evade the list
  // has to keep the script looking ordinary — which is most of the restriction.
  var LS_FLAGS = [
    { re: /\bimport\s+js\b|\bfrom\s+js\s+import\b/, why: "reaches the browser bridge (import js)" },
    { re: /\bpyodide_js\b/, why: "reaches the Python host object (pyodide_js)" },
    { re: /\b__import__\s*\(/, why: "imports modules by name at run time (__import__)" },
    { re: /\b(?:eval|exec|compile)\s*\(/, why: "builds and runs new code while it runs" },
    { re: /\bbase64\b|\bb64decode\b|\bunhexlify\b|\bfromhex\s*\(/, why: "decodes hidden text (base64 / hex)" },
    { re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, why: "makes its own network requests" },
    { re: /\bopen\s*\(/, why: "opens files" },
  ];
  function lsScreen(code) {
    var s = String(code || ""), found = [];
    for (var i = 0; i < LS_FLAGS.length; i++) if (LS_FLAGS[i].re.test(s)) found.push(LS_FLAGS[i].why);
    return found;
  }
  // LegionScript (Python) is offered on BOTH clients: the engine/worker/Pyodide
  // are client-agnostic and the C# bridge (window.UORailBridge) is identical on
  // CUO and TUO, so the same ~63 bridge capabilities work on either. (The few
  // TazUO-exclusive verbs — autoloot/organizer/grid — simply no-op on CUO.)
  // Assets live under /tuo/ but load fine from CUO (absolute same-origin URLs).
  function isLegionAvailable() {
    if (!(CLIENT === "tuo" || CLIENT === "cuo")) return false;
    // Per-shard LANGUAGE gate: an admin can make a shard JS-only by blocking the
    // 'legionScript' capability (shared script policy). Default ON — show LS unless
    // the loaded policy explicitly lacks it; never hide on an unloaded/unreachable
    // policy (so a stale/missing endpoint doesn't accidentally disable LS).
    return !_scriptPolicy || _scriptPolicy.has("legionScript");
  }
  // LegionScript finishes inside its own engine, so poll its state to release the UI.
  function watchLegionBusy() {
    if (_busyPoll) clearInterval(_busyPoll);
    _busyPoll = setInterval(function () {
      var L = window.UORailLegion;
      if (!L || typeof L.isRunning !== "function" || !L.isRunning()) setScriptBusy(false);
    }, 400);
  }
  function loadScriptPolicy() {
    var slug = (window.__chosenServerSlug || "").toString();
    return fetch("/api/script-policy/" + encodeURIComponent(slug), { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      // success → Set (even empty = all blocked); failure/404 → null (unknown).
      // JS sandbox treats null the same as empty (gated verbs stay blocked = fail
      // safe); the LS language gate treats null as "unknown → show LS" (fail open),
      // so a missing/stale policy endpoint never hides LegionScript.
      .then(function (j) { _scriptPolicy = (j && Array.isArray(j.verbs)) ? new Set(j.verbs) : null; });
  }
  function destroySandbox() {
    try { if (_sandbox && _sandbox.parentNode) _sandbox.parentNode.removeChild(_sandbox); } catch (e) {}
    _sandbox = null;
  }
  function sandboxBootstrap() {
    // Runs INSIDE the sandboxed iframe (origin null). Builds the UO proxy and
    // runs user code in an async function. Kept as a string injected via srcdoc.
    return [
      "(function(){",
      "  var pending = {};",
      "  function call(m,a,ret){var id=Math.random().toString(36).slice(2);parent.postMessage({__uo:1,type:'call',method:m,args:a,id:id},'*');if(!ret)return;return new Promise(function(res,rej){pending[id]={res:res,rej:rej};});}",
      "  window.addEventListener('message',function(e){var d=e.data||{};if(d.__uo!==1)return;",
      "    if(d.type==='result'&&pending[d.id]){pending[d.id].res(d.value);delete pending[d.id];}",
      "    else if(d.type==='error-result'&&pending[d.id]){pending[d.id].rej(new Error(d.error));delete pending[d.id];}",
      "    else if(d.type==='run'){runUser(d.code);}});",
      // ── Macro API (object-namespaced, mirrors the official ClassicUO Web:
      //    player.say()/use()/useSkill()/castSpell(), target.self()/last()/entity(),
      //    sleep(ms), print()/msg()). Backed by the C# RailBridgeApi bridge. ──
      "  function hex(s){return (typeof s==='string'?parseInt(s,16):s);}",
      "  function print(){call('print',[[].slice.call(arguments).map(String).join(' ')],false);}",
      "  function msg(){call('sysmsg',[[].slice.call(arguments).map(String).join(' ')],false);}",
      "  var sysmsg=msg;",
      "  function sleep(ms){return call('pause',[ms|0],true);}",
      // Skill + Magery-spell name->index maps (official ClassicUO naming). Pass
      // a constant (Skills.Anatomy), a string ('Anatomy'), or a raw index.
      "  var Skills={Alchemy:0,Anatomy:1,AnimalLore:2,ItemID:3,ArmsLore:4,Parry:5,Begging:6,Blacksmith:7,Fletching:8,Peacemaking:9,Camping:10,Carpentry:11,Cartography:12,Cooking:13,DetectHidden:14,Discordance:15,EvalInt:16,Healing:17,Fishing:18,Forensics:19,Herding:20,Hiding:21,Provocation:22,Inscription:23,Lockpicking:24,Magery:25,MagicResist:26,Tactics:27,Snooping:28,Musicianship:29,Poisoning:30,Archery:31,SpiritSpeak:32,Stealing:33,Tailoring:34,AnimalTaming:35,TasteID:36,Tinkering:37,Tracking:38,Veterinary:39,Swordsmanship:40,Macefighting:41,Fencing:42,Wrestling:43,Lumberjacking:44,Mining:45,Meditation:46,Stealth:47,RemoveTrap:48,Necromancy:49,Focus:50,Chivalry:51,Bushido:52,Ninjitsu:53,Spellweaving:54,Mysticism:55,Imbuing:56,Throwing:57};",
      "  var Spells={Clumsy:1,CreateFood:2,Feeblemind:3,Heal:4,MagicArrow:5,NightSight:6,ReactiveArmor:7,Weaken:8,Agility:9,Cunning:10,Cure:11,Harm:12,MagicTrap:13,MagicUntrap:14,Protection:15,Strength:16,Bless:17,Fireball:18,MagicLock:19,Poison:20,Telekinesis:21,Teleport:22,Unlock:23,WallOfStone:24,ArchCure:25,ArchProtection:26,Curse:27,FireField:28,GreaterHeal:29,Lightning:30,ManaDrain:31,Recall:32,BladeSpirits:33,DispelField:34,Incognito:35,MagicReflection:36,MindBlast:37,Paralyze:38,PoisonField:39,SummonCreature:40,Dispel:41,EnergyBolt:42,Explosion:43,Invisibility:44,Mark:45,MassCurse:46,ParalyzeField:47,Reveal:48,ChainLightning:49,EnergyField:50,Flamestrike:51,GateTravel:52,ManaVampire:53,MassDispel:54,MeteorSwarm:55,Polymorph:56,Earthquake:57,EnergyVortex:58,Resurrection:59,AirElemental:60,SummonDaemon:61,EarthElemental:62,FireElemental:63,WaterElemental:64};",
      "  function resolveIdx(map,s){return (typeof s==='number')?s:(map[s]!=null?map[s]:parseInt(s,10));}",
      // Shared cursor wait: polls isTargeting (ungated) until a target cursor
      // is up or timeoutMs (default 5000) elapses. The waitXxx verbs use it so a
      // skill/spell cursor that arrives a server round-trip AFTER the action is
      // still answered (player report 2026-07-18 was the entity case).
      "  async function awaitCursor(timeoutMs){",
      "    var until=Date.now()+(((timeoutMs|0)>0)?(timeoutMs|0):5000);",
      "    while(Date.now()<until){if(await call('isTargeting',[],true))return true;await call('pause',[150],true);}",
      "    return false;",
      "  }",
      // self/last/entity ANSWER a cursor immediately (attack/use/answer — no
      // wait, so a tight attack loop can't stall). waitSelf/waitLast/
      // waitTargetEntity WAIT for the cursor first — use these right after a
      // castSpell()/useSkill() that raises one. Pass a ms timeout to override.
      "  var target={",
      "    self:function(){return call('targetSelf',[],true);},",
      "    last:function(){return call('targetLast',[],true);},",
      "    entity:function(s){return call('target',[hex(s)],true);},",
      "    waitSelf:async function(t){await awaitCursor(t);return call('targetSelf',[],true);},",
      "    waitLast:async function(t){await awaitCursor(t);return call('targetLast',[],true);},",
      "    waitTargetEntity:async function(e,t){var s=(e&&e.serial!=null)?e.serial:e;await awaitCursor(t);return call('target',[hex(s)],true);},",
      "    cancel:function(){return call('cancelTarget',[],true);}",
      "  };",
      "  function mkPlayer(ps){",
      "    var p=Object.assign({},ps);",
      "    p.say=function(t){call('say',[String(t)],false);};",
      "    p.use=function(s){call('useItem',[hex(s)],false);};p.useItem=p.use;",
      "    p.useSkill=function(s){var i=resolveIdx(Skills,s);if(i>=0&&!isNaN(i))call('useSkill',[i|0],false);};",
      "    p.castSpell=function(s){var i=resolveIdx(Spells,s);if(i>0&&!isNaN(i))call('castSpell',[i|0],false);};",
      "    p.refresh=function(){return call('player',[],true).then(mkPlayer);};",
      "    return p;",
      "  }",
      // v0.8.50 object picker: pick() raises the target cursor and resolves to
      // the chosen object {kind,serial,graphic,hue,name} (or null if cancelled).
      // Then use its .serial with player.use()/target.entity() in a loop.
      "  async function pick(){var ok=await call('requestTarget',[],true);if(!ok)return null;",
      "    for(var i=0;i<150;i++){var r=await call('pollTarget',[],true);",
      "      if(r&&r.serial!=null)return r;if(r&&r.cancelled)return null;await call('pause',[200],true);}return null;}",
      "  function backpack(){return call('getBackpackSerial',[],true);}",
      "  function items(s){return call('getContainerItems',[hex(s)],true);}",
      // Inventory mutators: move an item to a container, grab into your pack,
      // equip. amount<=0 / omitted means the whole stack on most shards.
      "  function moveItem(s,dest,amt){return call('moveItem',[hex(s),hex(dest),amt|0],true);}",
      "  function grabItem(s,amt,bag){return call('grabItem',[hex(s),amt|0,bag?hex(bag):0],true);}",
      "  function equip(s){return call('equipItem',[hex(s)],true);}",
      // Safe reads + chat send (config/list mutators stay off-limits).
      "  function equipped(){return call('getEquippedItems',[],true);}",
      "  function durability(){return call('getEquipmentDurability',[],true);}",
      "  function friends(){return call('getFriends',[],true);}",
      "  function itemArt(g){return call('getItemArt',[g|0],true);}",
      "  function chatSend(t){return call('chatSend',[String(t)],true);}",
      // ── Perception / navigation / mouse (v0.8.56). journal()/scan() read the
      //    world; walkTo() pathfinds; gumps()/gumpReply() read+answer NPC menus;
      //    mouseMove()+mouseClick()/mouseDoubleClick() are the no-hex human path
      //    (move, sleep, then click whatever you hovered). objectAtCursor() reads
      //    the hovered entity so a macro never needs a hex serial.
      "  function journal(n){return call('getJournal',[(n|0)||50],true);}",
      "  function scan(range,kind){return call('scanWorld',[(range|0)||12,kind|0],true);}",
      "  function isTargeting(){return call('isTargeting',[],true);}",
      "  function walkTo(x,y,dist){return call('walkTo',[x|0,y|0,dist|0],true);}",
      "  function stopWalk(){return call('stopWalk',[],true);}",
      "  function gumps(){return call('getGumps',[],true);}",
      // waitGump WAITS for a gump to be open before returning the list (audit
      // S2-3): useItem(door/moongate) raises the gump a server round-trip later,
      // so gumps() in the same tick always missed on the first loop — the gump
      // twin of the waitTargetEntity race. Polls getGumps up to timeoutMs
      // (default 5000); resolves to the gump array ([] on timeout).
      "  async function waitGump(timeoutMs){",
      "    var until=Date.now()+(((timeoutMs|0)>0)?(timeoutMs|0):5000);",
      "    while(Date.now()<until){var g=await call('getGumps',[],true);if(g&&g.length)return g;await call('pause',[150],true);}",
      "    return [];",
      "  }",
      "  function gumpReply(g,btn){return call('gumpReply',[(g&&g.server!=null)?g.server:hex(g),btn|0],true);}",
      "  function objectAtCursor(){return call('objectAtCursor',[],true);}",
      "  function mouseMove(x,y){return call('mouseMove',[x|0,y|0],true);}",
      "  function mouseClick(right){return call('mouseClick',[!!right],true);}",
      "  function mouseDoubleClick(right){return call('mouseDoubleClick',[!!right],true);}",
      "  function runUser(code){parent.postMessage({__uo:1,type:'started'},'*');",
      "    (async function(){try{",
      "      var player=mkPlayer(await call('player',[],true));",
      "      var ARGS=['player','target','sleep','print','msg','sysmsg','Skills','Spells','pick','backpack','items','moveItem','grabItem','equip','equipped','durability','friends','itemArt','chatSend','journal','scan','isTargeting','walkTo','stopWalk','gumps','waitGump','gumpReply','objectAtCursor','mouseMove','mouseClick','mouseDoubleClick'];",
      "      var VALS=[player,target,sleep,print,msg,sysmsg,Skills,Spells,pick,backpack,items,moveItem,grabItem,equip,equipped,durability,friends,itemArt,chatSend,journal,scan,isTargeting,walkTo,stopWalk,gumps,waitGump,gumpReply,objectAtCursor,mouseMove,mouseClick,mouseDoubleClick];",
      "      var fn=new Function(...ARGS.concat(['\"use strict\";return (async()=>{\\n'+code+'\\n})();']));",
      "      await fn.apply(null,VALS);parent.postMessage({__uo:1,type:'done'},'*');}",
      "    catch(err){parent.postMessage({__uo:1,type:'script-error',error:String(err&&err.stack||err)},'*');}})();}",
      "})();"
    ].join("\n");
  }
  function runScript(code) {
    destroySandbox();
    var policyP = loadScriptPolicy();   // refresh this shard's allowed-verb set first
    var iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.srcdoc =
      '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" ' +
      "content=\"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';\">" +
      "</head><body><script>" + sandboxBootstrap() + "<\/script></body></html>";
    iframe.addEventListener("load", function () {
      policyP.then(function () {
        try { iframe.contentWindow.postMessage({ __uo: 1, type: "run", code: code }, "*"); } catch (e) { out(String(e), "err"); }
      });
    });
    (document.getElementById("uorail-root") || document.body).appendChild(iframe);
    _sandbox = iframe;
  }
  function runLegionScript(code) {
    var flags = lsScreen(code), now = Date.now();
    if (flags.length && !(_lsOkCode === String(code) && now < _lsOkUntil)) {
      _lsOkCode = String(code); _lsOkUntil = now + 20000;
      out("This script does things a game macro does not need:", "err");
      for (var i = 0; i < flags.length; i++) out("   - " + flags[i], "err");
      out("LegionScript can do these; the JavaScript sandbox cannot. If you did not write this script yourself, do not run it.", "err");
      out("Press Run again within 20 seconds to run it anyway.", "muted");
      return;
    }
    _lsOkCode = ""; _lsOkUntil = 0;
    function go() { try { window.UORailLegion.run(code, out); } catch (e) { out(String(e), "err"); } }
    if (window.UORailLegion && typeof window.UORailLegion.run === "function") return go();
    if (_legionLoading) { out("LegionScript engine still loading…", "muted"); return; }
    _legionLoading = true;
    out("⏳ Loading the LegionScript engine (CPython)…", "muted");
    var s = document.createElement("script");
    s.src = RAIL_BASE + "legion-engine.js" + LEGION_Q; s.async = true;
    s.onload = function () { _legionLoading = false; if (window.UORailLegion) go(); else out("LegionScript engine failed to initialise.", "err"); };
    s.onerror = function () { _legionLoading = false; out("Could not load the LegionScript engine (" + RAIL_BASE + "legion-engine.js).", "err"); };
    document.head.appendChild(s);
  }
  function renderScripting(body) {
    body.classList.add("uorail-script-body");
    // Official layout: left script list + right (toolbar + editor + footer).
    var twocol = el("div", { "class": "uorail-script-2col" });
    var listCol = el("div", { "class": "uorail-script-list" });
    listCol.appendChild(el("div", { "class": "uorail-script-list-head" }, "<span>Scripts</span>"));
    _scriptListEl = el("div", { "class": "uorail-script-items" });
    listCol.appendChild(_scriptListEl);
    listCol.appendChild(el("div", { "class": "uorail-script-list-foot" }, "<button class=\"uorail-btn-pill uorail-btn-sm\" data-pointer=\"auto\">+ New</button>"));
    var main = el("div", { "class": "uorail-script-main" });
    twocol.appendChild(listCol); twocol.appendChild(main); body.appendChild(twocol);
    // toolbar (no script/examples dropdowns — the left list replaces them)
    var bar2 = el("div", { "class": "uorail-script-toolbar" });
    var runBtn  = el("button", { "class": "uorail-sbtn uorail-sbtn-run", type: "button", "data-pointer": "auto" }, "▶ Run");
    var stopBtn = el("button", { "class": "uorail-sbtn", type: "button", "data-pointer": "auto" }, "■ Stop");
    var saveBtn = el("button", { "class": "uorail-sbtn", type: "button", "data-pointer": "auto" }, "Save");
    // Rename is its own button because Save is a save-AS: it writes a new key and leaves the
    // original, so the only way to change a script's name was to save a copy and delete the old
    // one by hand. Reported as "there is no way to rename at all", which was accurate.
    var renBtn  = el("button", { "class": "uorail-sbtn", type: "button", "data-pointer": "auto" }, "Rename");
    var delBtn  = el("button", { "class": "uorail-sbtn", type: "button", "data-pointer": "auto" }, "Delete");
    [runBtn, stopBtn, saveBtn, renBtn, delBtn].forEach(function (n) { bar2.appendChild(n); });
    _runBtn = runBtn; _stopBtn = stopBtn; setScriptBusy(false);   // idle: Run armed green
    // JS | LS language toggle (LS = LegionScript / Python). Shown on BOTH cuo and
    // tuo (operator-confirmed 2026-07-22 — the LS engine is Pyodide, client-agnostic
    // over the same RailBridgeApi, so CUO gets it too); only the mini is excluded.
    // Per-shard an admin can still make a shard JS-only via the 'legionScript'
    // capability — see isLegionAvailable(). Right-aligned segmented control.
    var langJsBtn = null, langLsBtn = null;
    if (isLegionAvailable()) {
      var langWrap = el("div", { "class": "uorail-lang-toggle" });
      langJsBtn = el("button", { "class": "uorail-lang-btn uorail-lang-on", type: "button", "data-pointer": "auto", "data-lang": "js", "data-tip": "JavaScript macro" }, "JAVASCRIPT");
      langLsBtn = el("button", { "class": "uorail-lang-btn", type: "button", "data-pointer": "auto", "data-lang": "ls", "data-tip": "LegionScript (Python)" }, "LEGIONSCRIPT");
      langWrap.appendChild(langJsBtn); langWrap.appendChild(langLsBtn);
      bar2.appendChild(langWrap);
    }
    main.appendChild(bar2);
    var newBtn = listCol.querySelector(".uorail-script-list-foot button");

    // editor: line-number gutter + a syntax-highlight overlay behind a
    // transparent-text textarea (classic "highlighted textarea" — the <pre> and
    // the textarea share identical font/size/line-height/padding + wrap=off so
    // tokens align; scroll is synced across gutter/highlight/textarea).
    var edWrap = el("div", { "class": "uorail-editor-wrap" });
    var gutter = el("div", { "class": "uorail-gutter", "aria-hidden": "true" }, "1");
    var editArea = el("div", { "class": "uorail-edit-area" });
    var hl = el("pre", { "class": "uorail-highlight", "aria-hidden": "true" });
    var hlCode = el("code", {});
    hl.appendChild(hlCode);
    var PLACEHOLDER_JS = "// JS macro. API: player.say(), player.use(serial), target.self()/last(), await sleep(ms), print()…";
    var PLACEHOLDER_LS = "# LegionScript (Python). API: API.Msg(), API.UseObject(serial), API.CastSpell(name), API.WaitForTarget(), API.Pause(s)…";
    _editor = el("textarea", { "class": "uorail-editor", spellcheck: "false", wrap: "off", "data-pointer": "auto",
      placeholder: PLACEHOLDER_JS });
    _editor.value = activeExamples()["Train a skill"];
    function escHtml(s) { return s.replace(/[&<>]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]; }); }
    function highlightJs(src) {
      return src.replace(
        /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|\b(while|for|if|else|const|let|var|function|return|await|async|new|of|in|break|continue|try|catch|throw|typeof)\b|\b(player|target|sleep|print|msg|sysmsg|Skills|Spells)\b|\b(true|false|null|undefined)\b|\b(\d+(?:\.\d+)?|0x[0-9a-fA-F]+)\b/g,
        function (m, c, s, k, a, lit, n) {
          if (c) return '<span class="tk-c">' + c + "</span>";
          if (s) return '<span class="tk-s">' + s + "</span>";
          if (k) return '<span class="tk-k">' + k + "</span>";
          if (a) return '<span class="tk-a">' + a + "</span>";
          if (lit) return '<span class="tk-l">' + lit + "</span>";
          if (n) return '<span class="tk-n">' + n + "</span>";
          return m;
        });
    }
    // LegionScript / Python tokens: # comments, str literals, py keywords, the API
    // root object, numbers/hex.
    function highlightPy(src) {
      return src.replace(
        /(#[^\n]*)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|\b(while|for|if|elif|else|def|class|return|import|from|as|and|or|not|in|is|break|continue|try|except|finally|raise|with|pass|lambda|global|yield)\b|\b(None|True|False)\b|\b(API)\b|\b(\d+(?:\.\d+)?|0x[0-9a-fA-F]+)\b/g,
        function (m, c, s, k, lit, a, n) {
          if (c) return '<span class="tk-c">' + c + "</span>";
          if (s) return '<span class="tk-s">' + s + "</span>";
          if (k) return '<span class="tk-k">' + k + "</span>";
          if (lit) return '<span class="tk-l">' + lit + "</span>";
          if (a) return '<span class="tk-a">' + a + "</span>";
          if (n) return '<span class="tk-n">' + n + "</span>";
          return m;
        });
    }
    function highlight() {
      var src = escHtml(_editor.value);
      hlCode.innerHTML = (_scriptLang === "ls" ? highlightPy(src) : highlightJs(src)) + "\n";
    }
    function updateGutter() {
      var n = _editor.value.split("\n").length;
      var s = ""; for (var i = 1; i <= n; i++) s += i + "\n";
      gutter.textContent = s;
      gutter.scrollTop = _editor.scrollTop;
    }
    function refreshEditor() { updateGutter(); highlight(); }
    function syncScroll() { gutter.scrollTop = _editor.scrollTop; hl.scrollTop = _editor.scrollTop; hl.scrollLeft = _editor.scrollLeft; }
    _editor.addEventListener("input", refreshEditor);
    _editor.addEventListener("scroll", syncScroll);
    // Tab inserts two spaces instead of moving focus
    _editor.addEventListener("keydown", function (e) {
      if (e.key === "Tab") { e.preventDefault(); var s = _editor.selectionStart, en = _editor.selectionEnd;
        _editor.value = _editor.value.slice(0, s) + "  " + _editor.value.slice(en); _editor.selectionStart = _editor.selectionEnd = s + 2; refreshEditor(); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runBtn.click(); }
      // Official shortcuts: Ctrl+S saves, Ctrl+R runs (preventDefault stops the
      // browser's save-page / reload while the editor is focused).
      if ((e.key === "s" || e.key === "S") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveBtn.click(); }
      if ((e.key === "r" || e.key === "R") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runBtn.click(); }
    });
    editArea.appendChild(hl); editArea.appendChild(_editor);
    edWrap.appendChild(gutter); edWrap.appendChild(editArea);
    main.appendChild(edWrap);
    _railUpdateGutter = refreshEditor;
    refreshEditor();

    // output console
    var outWrap = el("div", { "class": "uorail-out-wrap" });
    var outHead = el("div", { "class": "uorail-out-head" }, "<span>Output</span>");
    var clr = el("button", { "class": "uorail-sbtn uorail-sbtn-mini", type: "button", "data-pointer": "auto" }, "clear");
    outHead.appendChild(clr);
    _output = el("div", { id: "uorail-output", "class": "uorail-out" });
    outWrap.appendChild(outHead); outWrap.appendChild(_output);
    main.appendChild(outWrap);

    // Official-parity footer: docs hint + the keyboard-shortcut legend.
    var footer = el("div", { "class": "uorail-script-footer" },
      '<span class="uorail-sfoot-help">Need help? Check out the <a href="' + esc(CLIENT_CFG.scriptingDocsUrl || "#") + '"' + (CLIENT_CFG.scriptingDocsUrl ? ' target="_blank" rel="noopener"' : "") + ' data-pointer="auto">documentation</a></span>' +
      '<span class="uorail-sfoot-keys"><kbd>Ctrl</kbd>+<kbd>S</kbd> save &nbsp;·&nbsp; <kbd>Ctrl</kbd>+<kbd>R</kbd> run</span>');
    main.appendChild(footer);

    // setLang: switch JS↔LS. Swaps the per-language store, examples, placeholder
    // and highlighter, then reloads the editor + script list. Only reachable on
    // TUO (the toggle buttons only exist there).
    function setLang(lang) {
      lang = (lang === "ls") ? "ls" : "js";
      if (lang === _scriptLang) return;
      _scriptLang = lang;
      if (langJsBtn) langJsBtn.classList.toggle("uorail-lang-on", _scriptLang === "js");
      if (langLsBtn) langLsBtn.classList.toggle("uorail-lang-on", _scriptLang === "ls");
      _editor.placeholder = (_scriptLang === "ls") ? PLACEHOLDER_LS : PLACEHOLDER_JS;
      _curName = null;
      var saved = loadScripts(); var names = Object.keys(saved);
      if (names.length) { _curName = names[0]; _editor.value = saved[names[0]]; }
      else { _editor.value = activeExamples()["Train a skill"] || ""; }
      refreshScriptList();
      refreshEditor();
    }
    if (langJsBtn) langJsBtn.addEventListener("click", function () { setLang("js"); });
    if (langLsBtn) langLsBtn.addEventListener("click", function () { setLang("ls"); });

    // wiring
    runBtn.addEventListener("click", function () {
      if (_scriptBusy) { out("Already running — press Stop first.", "muted"); return; }
      setScriptBusy(true);
      if (_scriptLang === "ls") { runLegionScript(_editor.value); watchLegionBusy(); return; }
      runScript(_editor.value);
    });
    stopBtn.addEventListener("click", function () {
      if (_scriptLang === "ls") {
        if (window.UORailLegion && window.UORailLegion.stop) window.UORailLegion.stop();
        else out("■ stopped", "muted");
        setScriptBusy(false);
        return;
      }
      destroySandbox(); out("■ stopped", "muted"); setScriptBusy(false);
    });
    clr.addEventListener("click", function () { _output.innerHTML = ""; });
    newBtn.addEventListener("click", function () { _curName = null; _editor.value = ""; refreshScriptList(); if (_railUpdateGutter) _railUpdateGutter(); _editor.focus(); });
    saveBtn.addEventListener("click", function () {
      var cur = (_curName || "").trim();
      uiPrompt("Save script as:", cur || "script1").then(function (raw) {
        var name = (raw || "").trim();
        if (!name) return;
        var s = loadScripts(); s[name] = _editor.value; saveScripts(s); _curName = name; refreshScriptList();
        toast("Saved “" + name + "”");
      });
    });
    renBtn.addEventListener("click", function () {
      if (!_curName) { toast("Open a script first"); return; }
      var s = loadScripts();
      // A built-in example has no stored key, so there is nothing to rename — saving it under a
      // new name is the right move there, and saying so beats renaming a phantom.
      if (!(_curName in s)) { toast("That is a built-in example — use Save to store your own copy"); return; }
      var from = _curName;
      uiPrompt("Rename script to:", from).then(function (raw) {
        var to = (raw || "").trim();
        if (!to || to === from) return;
        var cur = loadScripts();
        if (to in cur) { toast("“" + to + "” already exists"); return; }
        // Carry the CONTENT across rather than the editor buffer: renaming must not silently
        // commit unsaved edits, and must not lose the saved body if the editor drifted.
        cur[to] = cur[from];
        delete cur[from];
        saveScripts(cur);
        _curName = to;
        refreshScriptList();
        toast("Renamed to “" + to + "”");
      });
    });
    delBtn.addEventListener("click", function () {
      if (!_curName) return;
      var s = loadScripts(); delete s[_curName]; saveScripts(s); _curName = null; refreshScriptList();
    });

    refreshScriptList();
  }
  function activeExamples()   { return _scriptLang === "ls" ? LS_EXAMPLES : EXAMPLES; }



  var AGENTS_KEY = "uorail.agents." + CLIENT;

  /* ── Which character's scripts are these? ────────────────────────────────
     🚨 THEY USED TO BE EVERYONE'S. The store was keyed by the Discord account and nothing else, so
     one person's scripts followed them onto every shard, every game account and every character —
     and a screenshot taken while signed in as one identity showed another character's script list.
     The operator's rule (2026-08-27): "cada personaje tiene que tener su propia configuración y no
     mezclarse entre servers, cuentas, etc., aunque sean del mismo user de discord."

     The scope is shard + character. The shard account name is not exposed by the bridge, and it
     does not need to be: a UO character name is unique within a shard, so two accounts on one shard
     are two different characters and separate cleanly.

     ⚠️ SCOPING LIVES INSIDE THE VALUE, NOT IN THE localStorage KEY. The value becomes
     { "<slug>/<character>": { name: code } }. The server contract (one opaque JSON string per
     language) and the restore path are then unchanged — and a change that touches fewer moving
     parts is the one to make when the failure mode is losing somebody's scripts. */
  function scriptScope() {
    var slug = "";
    try { slug = String(window.__chosenServerSlug || "").trim(); } catch (e) {}
    var who = "";
    try { who = String((window.__uoRailPlayerName || "")).trim(); } catch (e) {}
    return (slug && who) ? (slug + "/" + who) : "";
  }

  /* A stored blob is LEGACY when every value is a string: that is the old flat { name: code }.
     Scoped blobs hold objects. Distinguishing by shape rather than by a version field means an
     install that never upgrades still reads correctly, and there is no flag to get wrong. */
  function isLegacyBlob(o) {
    if (!o || typeof o !== "object") return false;
    var ks = Object.keys(o);
    if (!ks.length) return false;
    for (var i = 0; i < ks.length; i++) if (typeof o[ks[i]] !== "string") return false;
    return true;
  }

  /* Agents need their OWN shape test and this is not a duplicate of isLegacyBlob.
     That one answers "are all the values strings?", which is exact for script bodies and WRONG for
     agents, whose values are config objects — a pre-upgrade agents store would answer "already
     scoped", match no scope, and disappear from the panel while still sitting in localStorage.
     Here the question is asked of the KEYS instead: a scoped blob is one whose every key is
     "<shard>/<character>", and neither a slug nor a character name can contain a slash. */
  function isLegacyAgents(o) {
    if (!o || typeof o !== "object") return false;
    var ks = Object.keys(o);
    if (!ks.length) return false;
    for (var i = 0; i < ks.length; i++) if (!/^[^/]+\/[^/]+$/.test(ks[i])) return true;
    return false;
  }

  function readBlob() {
    try { return JSON.parse(localStorage.getItem(activeScriptsKey()) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function loadScripts() {
    var blob = readBlob();
    var scope = scriptScope();
    /* ⚠️ NEVER MIGRATE WHILE THE SCOPE IS UNKNOWN. Out of world there is no character, and writing
       the legacy set under "" would file everyone's scripts under a scope no character ever reads
       — a silent loss that looks exactly like the bug this change fixes. Show them, own them
       later. */
    if (isLegacyBlob(blob)) return blob;
    if (!scope) return {};
    return (blob[scope] && typeof blob[scope] === "object") ? blob[scope] : {};
  }

  function saveScripts(obj) {
    var scope = scriptScope();
    if (!scope) { try { console.warn("[rail] not in world — scripts not saved"); } catch (e) {} return; }
    var blob = readBlob();
    /* First save after the upgrade adopts the legacy set for THIS character, then leaves the flat
       shape behind. Whoever was using the old store keeps their scripts on the character they were
       using them with, which is the only answer that does not throw work away. */
    if (isLegacyBlob(blob)) { var carried = blob; blob = {}; blob[scope] = carried; }
    blob[scope] = obj;
    try { localStorage.setItem(activeScriptsKey(), JSON.stringify(blob)); } catch (e) {}
    // mirror to the Discord account — separate key per language so cloud sync
    // doesn't clobber the other language's scripts.
    schedulePersist(_scriptLang === "ls" ? "railLScripts" : "railScripts", blob);
  }

  /* Agents, scoped exactly like scripts and for the same reason: a Loot or Dress agent is set up for
     ONE character on ONE shard, and inheriting somebody else's — or your own from another server —
     is the defect, not a convenience. See scriptScope() above for the shape, and for why the scope
     lives inside the value rather than in the storage key. */
  /* Agents, scoped exactly like scripts and for the same reason: a Loot or Dress agent is set up for
     ONE character on ONE shard, and inheriting somebody else's — or your own from another server —
     is the defect, not a convenience. See scriptScope() for the shape, and for why the scope lives
     inside the value rather than in the storage key. */
  function loadAgents() {
    var blob;
    try { blob = JSON.parse(localStorage.getItem(AGENTS_KEY) || "{}") || {}; } catch (e) { return {}; }
    if (isLegacyAgents(blob)) return blob;
    var scope = scriptScope();
    if (!scope) return {};
    return (blob[scope] && typeof blob[scope] === "object") ? blob[scope] : {};
  }
  function saveAgents(obj) {
    var scope = scriptScope();
    /* Out of world there is no character. Writing under "" would file everyone's agents under a
       scope no character ever reads — a silent loss shaped exactly like the bug being fixed. */
    if (!scope) { try { console.warn("[rail] not in world — agents not saved"); } catch (e) {} return; }
    var blob;
    try { blob = JSON.parse(localStorage.getItem(AGENTS_KEY) || "{}") || {}; } catch (e) { blob = {}; }
    if (isLegacyAgents(blob)) { var carried = blob; blob = {}; blob[scope] = carried; }
    blob[scope] = obj;
    try { localStorage.setItem(AGENTS_KEY, JSON.stringify(blob)); } catch (e) {}
    schedulePersist("railAgents", blob);
  }

  /* ── Cross-device persistence via /api/settings ──────────────────────────
     Scripts + agents config are mirrored to the logged-in Discord account so
     they travel across browsers/devices (server stores them as opaque JSON
     strings under the railScripts / railAgents keys — see auth.ts). localStorage
     stays the fast local cache; the server is authoritative on (re)load. PUT
     replaces the whole settings doc, so we GET-merge-PUT and debounce. */
  var _persistTimer = null, _persistPending = {};
  function schedulePersist(key, obj) {
    try { _persistPending[key] = JSON.stringify(obj); } catch (e) { return; }
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(flushPersist, 1500);
  }
  function flushPersist() {
    _persistTimer = null;
    var pend = _persistPending; _persistPending = {};
    if (!Object.keys(pend).length) return;
    fetch("/api/settings", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
      .then(function (cur) {
        cur = (cur && typeof cur === "object") ? cur : {};
        for (var k in pend) cur[k] = pend[k];
        return fetch("/api/settings", { method: "PUT", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(cur) });
      }).catch(function () { /* offline / guest — localStorage still holds it */ });
  }
  // On mount, pull the server copy and merge into localStorage (server wins for
  // cross-device). Called once when the rail builds.
  function syncPersistedFromServer() {
    fetch("/api/settings", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      .then(function (s) {
        if (!s || typeof s !== "object") return;
        // 🚨 Restore BOTH script languages. Saving writes JS under `railScripts` and LegionScript
        // under `railLScripts` (see saveScripts), but this only ever read the first one back — so
        // LS scripts uploaded fine, sat on the account, and NEVER came home. Clearing site data
        // made them look permanently deleted while the server still had them. The two keys are
        // written a few lines apart and read here; the write side grew a language and the read
        // side did not. (operator, 2026-08-12: macros/scripts gone after a cache wipe.)
        try { if (typeof s.railScripts === "string") localStorage.setItem(SCRIPTS_KEY, s.railScripts); } catch (e) {}
        try { if (typeof s.railLScripts === "string") localStorage.setItem("uorail.lscripts." + CLIENT, s.railLScripts); } catch (e) {}
        try { if (typeof s.railAgents === "string") localStorage.setItem(AGENTS_KEY, s.railAgents); } catch (e) {}
        if (typeof refreshScriptList === "function" && _scriptListEl) { try { refreshScriptList(); } catch (e) {} }
      });
  }
  // Left script list (official layout): built-in examples + the user's saved
  // scripts, each clickable to load into the editor.
  function refreshScriptList() {
    if (!_scriptListEl) return;
    var saved = loadScripts();
    // A saved script SHADOWS the built-in example with the same name — saving
    // "Train a skill" used to add a second identically-named row whose content
    // depended on which twin you clicked (player report 2026-07-18). The list
    // also follows the active language (LS examples in LS mode).
    var examples = activeExamples();
    var items = Object.keys(examples).filter(function (n) { return !(n in saved); })
      .map(function (n) { return { name: n, ex: true }; })
      .concat(Object.keys(saved).sort().map(function (n) { return { name: n, ex: false }; }));
    _scriptListEl.innerHTML = items.map(function (it) {
      return '<button class="uorail-hk-item' + (it.name === _curName ? " uorail-hk-item-active" : "") + (it.ex ? " uorail-script-ex" : "") +
        '" data-name="' + esc(it.name) + '" data-ex="' + (it.ex ? 1 : 0) + '" data-pointer="auto">' + esc(it.name) + "</button>";
    }).join("") || '<div class="uorail-note">No scripts.</div>';
    Array.prototype.forEach.call(_scriptListEl.querySelectorAll(".uorail-hk-item"), function (b) {
      b.addEventListener("click", function () {
        var n = b.getAttribute("data-name"), ex = b.getAttribute("data-ex") === "1";
        var src = ex ? (activeExamples()[n] || "") : (loadScripts()[n] || "");
        if (_editor) { _editor.value = src; _curName = n; if (_railUpdateGutter) _railUpdateGutter(); }
        refreshScriptList();
      });
    });
  }

  function out(text, cls) {
    if (!_output) return;
    var line = el("div", { "class": "uorail-out-line" + (cls ? " uorail-out-" + cls : "") },
      String(text).replace(/[<>&]/g, function (c) { return ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]; }));
    _output.appendChild(line);
    _output.scrollTop = _output.scrollHeight;
  }

  // The host-side implementation of each UO.* call. Phase 4 routes the
  // ── Per-shard script-verb policy (operator 2026-06-11) ───────────────────
  // The server decides which gated verbs scripts may call on THIS shard
  // (global allow − shard block). Default null/empty = everything gated is
  // BLOCKED until an admin opts verbs in. This is a 2nd gate ON TOP of the hard
  // allow-list below — it can only ever RESTRICT, never widen.
  var _scriptPolicy = null;   // Set of allowed verb names, or null = none loaded
  // 🚨 `player` and `stopWalk` joined this list on 2026-08-03, by the operator's call ("B, nadie
  // ahora mismo está usando scripts"). They used to run on a shard that had blocked EVERYTHING
  // else, while their own siblings did not: getEquippedItems reads your gear and IS gated,
  // walkTo moves you and IS gated — but `player` read your character and `stopWalk` moved it,
  // freely. From a shard owner's side that split was arbitrary, and "block all scripting" did
  // not mean what it says.
  //
  // The line is now one sentence: reading the console, waiting, and looking at your own cursor
  // are free; anything that touches your CHARACTER is something the shard can turn off.
  var GATED_VERBS = new Set(["say","chatSend","useItem","useSkill","castSpell",
    "target","targetSelf","targetLast","cancelTarget","requestTarget","moveItem",
    "grabItem","equipItem","getBackpackSerial","getContainerItems",
    "getEquippedItems","getEquipmentDurability","getFriends","getItemArt",
    "getJournal","scanWorld","getGumps","objectAtCursor","walkTo","gumpReply",
    "mouseMove","mouseClick","mouseDoubleClick","player","stopWalk"]);
  var ARRAY_VERBS = new Set(["getContainerItems","getEquippedItems","getEquipmentDurability","getFriends",
    "getJournal","scanWorld","getGumps"]);
  var BOOL_VERBS = new Set(["target","targetSelf","targetLast","cancelTarget","requestTarget","moveItem","grabItem","equipItem","chatSend",
    "walkTo","gumpReply"]);

  // game-control verbs to window.UORailBridge (C# JSExport); for now they log.
  function handleApiCall(method, args) {
    args = args || [];
    var br = window.UORailBridge || null;
    // Policy gate: a gated verb must be allowed by this shard's policy.
    if (GATED_VERBS.has(method) && !(_scriptPolicy && _scriptPolicy.has(method))) {
      out(method + "() — disabled by this shard's script policy (an admin can enable it)", "muted");
      if (ARRAY_VERBS.has(method)) return [];
      if (BOOL_VERBS.has(method)) return false;
      if (method === "getBackpackSerial") return 0;
      if (method === "objectAtCursor") return { kind: "none" };
      if (method === "getItemArt") return null;   // object-returning read: stub null (matches the LS D-table), not undefined
      return; // void (say/useItem/useSkill/castSpell/mouse*)
    }
    switch (method) {
      case "print":  out(args[0], "print"); return;
      case "sysmsg": out("sysmsg: " + args[0], "sys"); if (br && br.sysmsg) br.sysmsg(String(args[0]), args[1]); else toast(String(args[0])); return;
      case "say":    out("say: " + args[0], "sys"); if (br && br.say) br.say(String(args[0])); else out("say() needs the game bridge (in-world)", "muted"); return;
      case "useItem": out("useItem: " + args[0], "sys"); if (br && br.useItem) br.useItem(args[0]); else out("useItem() needs the game bridge (in-world)", "muted"); return;
      case "target": out("target: " + args[0], "sys"); return (br && br.target) ? br.target(args[0]) : false;
      case "targetSelf": out("targetSelf", "sys"); return (br && br.targetSelf) ? br.targetSelf() : false;
      case "targetLast": out("targetLast", "sys"); return (br && br.targetLast) ? br.targetLast() : false;
      case "useSkill": out("useSkill: " + args[0], "sys"); if (br && br.useSkill) br.useSkill(args[0]); else out("useSkill() needs the game bridge (in-world)", "muted"); return;
      case "castSpell": out("castSpell: " + args[0], "sys"); if (br && br.castSpell) br.castSpell(args[0]); else out("castSpell() needs the game bridge (in-world)", "muted"); return;
      case "cancelTarget": out("cancelTarget", "sys"); return (br && br.cancelTarget) ? br.cancelTarget() : false;
      // v0.8.50: object picker + read-only inventory (SAFE — the user picks the
      // object; no mutate-config verbs like moveItem/setSetting are exposed).
      case "requestTarget": out("pick: choose an object…", "sys"); return (br && br.requestTarget) ? br.requestTarget() : false;
      case "pollTarget": return (br && br.pollTarget) ? br.pollTarget() : { cancelled: true };
      case "getBackpackSerial": return (br && br.getBackpackSerial) ? br.getBackpackSerial() : 0;
      case "getContainerItems": return (br && br.getContainerItems) ? br.getContainerItems(args[0]) : [];
      // v0.8.50b: item-management verbs (move/grab/equip). These MUTATE your
      // inventory, so only run scripts you trust — same caveat as any
      // macro/assistant. setSetting/deleteMacro/addMacro stay OFF-limits.
      case "moveItem": out("moveItem", "sys"); return (br && br.moveItem) ? br.moveItem(args[0], args[1], args[2] | 0) : false;
      case "grabItem": out("grabItem", "sys"); return (br && br.grabItem) ? br.grabItem(args[0], args[1] | 0, args[2] || 0) : false;
      case "equipItem": out("equipItem", "sys"); return (br && br.equipItem) ? br.equipItem(args[0]) : false;
      // v0.8.52: safe READS + chat send. (Config/list MUTATORS — setSetting,
      // add/deleteMacro, add/removeFriend, sound filters — stay bridge-only.)
      case "getEquippedItems": return (br && br.getEquippedItems) ? br.getEquippedItems() : [];
      case "getEquipmentDurability": return (br && br.getEquipmentDurability) ? br.getEquipmentDurability() : [];
      case "getFriends": return (br && br.getFriends) ? br.getFriends() : [];
      case "getItemArt": return (br && br.getItemArt) ? br.getItemArt(args[0] | 0) : null;
      case "chatSend": out("chatSend: " + args[0], "sys"); return (br && br.chatSend) ? br.chatSend(String(args[0])) : false;
      // v0.8.56: perception (journal/world scan/gumps/cursor), navigation
      // (walkTo/stopWalk), and the "natural human" mouse path. Reads are pure;
      // walkTo/gumpReply/mouse* are actions, gated per-shard like the rest.
      case "getJournal": return (br && br.getJournal) ? br.getJournal(args[0] | 0) : [];
      case "scanWorld": return (br && br.scanWorld) ? br.scanWorld(args[0] | 0, args[1] | 0) : [];
      case "isTargeting": return (br && br.isTargeting) ? br.isTargeting() : false;
      case "walkTo": out("walkTo: " + (args[0] | 0) + "," + (args[1] | 0), "sys"); return (br && br.walkTo) ? br.walkTo(args[0] | 0, args[1] | 0, args[2] | 0) : false;
      case "stopWalk": return (br && br.stopWalk) ? br.stopWalk() : false;
      case "getGumps": return (br && br.getGumps) ? br.getGumps() : [];
      case "gumpReply": out("gumpReply: " + args[0] + " btn " + (args[1] | 0), "sys"); return (br && br.gumpReply) ? br.gumpReply(args[0], args[1] | 0) : false;
      case "objectAtCursor": return (br && br.objectAtCursor) ? br.objectAtCursor() : { kind: "none" };
      case "mouseMove": out("mouseMove: " + (args[0] | 0) + "," + (args[1] | 0), "sys"); return (br && br.mouseMove) ? br.mouseMove(args[0] | 0, args[1] | 0) : undefined;
      case "mouseClick": out("mouseClick", "sys"); return (br && br.mouseClick) ? br.mouseClick(!!args[0]) : undefined;
      case "mouseDoubleClick": out("mouseDoubleClick", "sys"); return (br && br.mouseDoubleClick) ? br.mouseDoubleClick(!!args[0]) : undefined;
      case "pause":  return new Promise(function (r) { setTimeout(r, Math.max(0, Math.min(60000, args[0] | 0))); });
      case "player": return (br && br.player) ? br.player() : { name: "(bridge pending)", x: 0, y: 0, z: 0, hp: 0, serial: 0 };
      default:
        // SECURITY: do NOT pass arbitrary method names through to br[method].
        // Sandboxed user code can postMessage a crafted {type:'call',method:…}
        // and would otherwise reach ANY UORailBridge verb — including
        // CONFIG-MUTATING ones (setSetting, deleteMacro, addMacro) that could
        // wreck a user's setup. Those stay refused. Game/inventory verbs above
        // (incl. move/grab/equip) are intentionally reachable; everything else
        // (config, profile writes) is refused.
        out(method + "() — not available to scripts", "muted"); return;
    }
  }



  function onSandboxMessage(e) {
    if (!_sandbox || e.source !== _sandbox.contentWindow) return;
    var d = e.data || {}; if (d.__uo !== 1) return;
    if (d.type === "call") {
      Promise.resolve().then(function () { return handleApiCall(d.method, d.args); })
        .then(function (v) { try { _sandbox.contentWindow.postMessage({ __uo: 1, type: "result", id: d.id, value: v }, "*"); } catch (x) {} })
        .catch(function (err) { try { _sandbox.contentWindow.postMessage({ __uo: 1, type: "error-result", id: d.id, error: String(err) }, "*"); } catch (x) {} });
    } else if (d.type === "started") { out("▶ running…", "muted"); }
    else if (d.type === "done") { out("✓ finished", "ok"); setScriptBusy(false); }
    else if (d.type === "script-error") { out(d.error, "err"); setScriptBusy(false); }
  }


  // LegionScript (Python) runner. The editor / examples / save-load / highlight
  // are live; the EXECUTION engine is CPython-via-Pyodide over the C# bridge and
  // lands in a later dev phase (docs/dev/LEGION_SCRIPT_PYTHON_PORT_STUDY.md). This
  // is the single hook the engine will replace — until then it reports honestly
  // rather than faking a run. window.UORailLegion (set by the future engine) takes
  // precedence the moment it exists.

  // Confirmation is a SECOND press of Run, not a dialog: the site does not use native
  // confirm()/alert(), and the output pane is already where this panel talks to you.
  var _lsOkCode = "", _lsOkUntil = 0;



  /* ── Faithful panel chrome (replicates webclient/fotos-original/) ─────────
     Native <input> controls work locally now; persisting them to the client
     profile + the deep autoloot/macro engines are the C# bridge work in the
     next pass (option 1). Sample content mirrors the reference shots. ────── */
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function subH(t)  { return '<div class="uorail-sub">' + esc(t) + '</div>'; }
  // Blue info box — the official uses these atop several Agents tabs (Recording,
  // Durability, …) to explain the feature.
  function infoBox(title, text) {
    return '<div class="uorail-infobox">' + (title ? '<div class="uorail-infobox-t">' + esc(title) + "</div>" : "") +
      '<div class="uorail-infobox-b">' + esc(text) + "</div></div>";
  }




  // ── Options model ────────────────────────────────────────────────────────
  // Each tab mirrors a native ClassicUO OptionsGump page, grouped the same way.
  // Every item binds to a REAL Profile property (data-k). Item forms:
  //   ["c", key, label]                checkbox  (bool)
  //   ["r", key, label, min, max]      slider    (int/byte)  — ranges from OptionsGump.cs
  //   ["s", key, label, [opt0,opt1…]]  combobox  (int/enum)  — option order = native SelectedIndex
  //   ["h", key, label]                hue swatch (ushort)   — opens the UO palette picker














  // Render the binding string (as the native HotkeyBox prints it, e.g.
  // "Alt + P") into key chips, splitting on the " + " separator.
  function bindChips(key) {
    var parts = String(key || "Not bound").split(" + ");
    return parts.map(function (p, i) {
      return (i ? '<span class="uorail-key-plus">+</span>' : "") + '<span class="uorail-key">' + esc(p) + "</span>";
    }).join("");
  }

  // Browser KeyboardEvent -> a layout-correct, shift-independent token the C#
  // bridge maps to an SDL_Keycode (SdlKeyFromBrowser). Uses e.code (physical
  // key) so Shift+1 still binds "1". Returns "" for keys we don't bind (lone
  // modifiers, numpad, unknown) so the caller cancels cleanly.
  function keyToken(e) {
    var c = e.code || "";
    if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(c)) return c.slice(5);
    if (/^F([1-9]|1[0-2])$/.test(c)) return c;
    var m = {
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Space: "Space", Enter: "Return", NumpadEnter: "Return", Escape: "Esc", Tab: "Tab",
      Backspace: "Backspace", Delete: "Del", Insert: "Ins", Home: "Home", End: "End",
      PageUp: "PageUp", PageDown: "PageDown",
      Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";",
      Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
    };
    return m[c] || "";
  }

  // ── Hotkeys binding tables (Combat/General/Target + Skills/Spells) ──
  // REAL: each row binds a key to a single-action macro — the official client's
  // per-command hotkey model — via the same macro bridge the Macros tab uses
  // (addMacro + setMacroAction + setMacroKey). Skills/Spells rows are built from
  // the live macro catalog (UseSkill/CastSpell sub-lists) so they can never drift
  // from the client; Combat/General/Target map each command to its real MacroType
  // (commands with no backing MacroType are pruned — no dead rows). Filtered by
  // the panel "Search bindings" box (operates on .uorail-bind-row). wireBindings
  // does the async build. Each entry is {label, type} where type is the exact
  // MacroType enum name resolved against the catalog.
  var HK_TABS = {
    Combat: [
      { label: "Toggle War Mode", type: "WarPeace" },
      { label: "Arm / Disarm", type: "ArmDisarm" },
      { label: "Primary Ability", type: "PrimaryAbility" },
      { label: "Secondary Ability", type: "SecondaryAbility" },
      { label: "Attack Last", type: "AttackLast" },
      { label: "Attack Selected Target", type: "AttackSelectedTarget" },
      { label: "Bandage Self", type: "BandageSelf" },
      { label: "Bandage Target", type: "BandageTarget" },
      { label: "Equip Last Weapon", type: "EquipLastWeapon" },
      { label: "Use Potion", type: "UsePotion" },
      { label: "Invoke Virtue", type: "InvokeVirtue" },
    ],
    General: [
      { label: "All Names", type: "AllNames" },
      { label: "Always Run", type: "AlwaysRun" },
      { label: "Bow", type: "Bow" },
      { label: "Salute", type: "Salute" },
      { label: "Open Door", type: "OpenDoor" },
      { label: "Close Gump", type: "CloseGump" },
      { label: "Close Corpses", type: "CloseCorpses" },
      { label: "Close All Health Bars", type: "CloseAllHealthBars" },
      { label: "Close Inactive Health Bars", type: "CloseInactiveHealthBars" },
      { label: "Set Grab Bag", type: "SetGrabBag" },
      { label: "Use Item In Hand", type: "UseItemInHand" },
      { label: "Last Object", type: "LastObject" },
      { label: "Toggle Chat", type: "ToggleChatVisibility" },
      { label: "Circle Of Transparency", type: "CircleTrans" },
      { label: "Toggle Gargoyle Flying", type: "ToggleGargoyleFly" },
      { label: "Save Desktop", type: "SaveDesktop" },
      { label: "Quit Game", type: "QuitGame" },
    ],
    Target: [
      { label: "Last Target", type: "LastTarget" },
      { label: "Target Self", type: "TargetSelf" },
      { label: "Target Next", type: "TargetNext" },
      { label: "Current Target", type: "CurrentTarget" },
      { label: "Select Next", type: "SelectNext" },
      { label: "Select Previous", type: "SelectPrevious" },
      { label: "Select Nearest", type: "SelectNearest" },
      { label: "Use Selected Target", type: "UseSelectedTarget" },
      { label: "Wait For Target", type: "WaitForTarget" },
      { label: "Target System On/Off", type: "TargetSystemOnOff" },
    ],
  };

  // Cancel-hook of the binding row currently sitting in "Press a key…" —
  // only one capture may be live at a time (see keyBtn click handler).
  var _bindCaptureCancel = null;

  // Re-applies the panel search after async tab population (see renderPanel).
  var _panelSearchObserver = null;

  // Macro catalog (MacroType list + sub-ranges) cached after first fetch; shared
  // by the Macros editor and the binding tables. Source of truth = the C# enums.
  var _macroCatalog = null;
  function loadMacroCatalog() {
    var br = window.UORailBridge;
    if (_macroCatalog) return Promise.resolve(_macroCatalog);
    if (!br || !br.getMacroCatalog) return Promise.resolve(null);
    return Promise.resolve(br.getMacroCatalog()).then(function (c) {
      if (c && c.types) _macroCatalog = c;
      return _macroCatalog;
    }).catch(function () { return null; });
  }

  // Build a category's binding rows and wire each to a REAL macro keybind.
  function wireBindings(tab, body) {
    var br = window.UORailBridge;
    var root = body.querySelector("[data-bind]");
    if (!root) return;
    if (!br || !br.getMacroCatalog || !br.setMacroKey) {
      root.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Hotkey bindings are available in-world.</div>';
      return;
    }
    var norm = function (s) { return String(s).replace(/[^a-z0-9]/gi, "").toLowerCase(); };
    Promise.all([loadMacroCatalog(), Promise.resolve(br.getMacros ? br.getMacros() : [])]).then(function (out) {
      var cat = out[0] || { types: [], subs: {} };
      var macros = out[1] || [];
      var typeByName = {};
      (cat.types || []).forEach(function (t) { typeByName[norm(t.n)] = t.v; });
      var subOf = function (code) { return (cat.subs && (cat.subs[code] || cat.subs[String(code)])) || []; };
      // Candidate rows: {label, code, sub}. Skills/Spells from the catalog subs.
      var rows = [];
      if (tab === "Skills" || tab === "Spells") {
        var code = typeByName[norm(tab === "Skills" ? "UseSkill" : "CastSpell")];
        if (code != null) subOf(code).forEach(function (s) { rows.push({ label: s.n, code: code, sub: s.v }); });
      } else {
        (HK_TABS[tab] || []).forEach(function (e) {
          var code = typeByName[norm(e.type)];
          if (code != null) rows.push({ label: e.label, code: code, sub: 0 });
        });
      }
      if (!rows.length) { root.innerHTML = '<div class="uorail-note" style="padding:8px 4px">No bindable commands in this category on this client.</div>'; return; }
      // Bind-macros are OURS and carry the "HK: " prefix (audit S2-2): naming
      // them after the bare command label collided with hand-built user macros
      // — binding overwrote their first action and ✕ deleted them outright.
      // LEGACY (pre-prefix) bind-macros are recognised conservatively: exact
      // command name + a key + exactly one action; anything else is the
      // player's and is never touched or shown here.
      var BIND_PREFIX = "HK: ";
      var bindName = function (label) { return BIND_PREFIX + label; };
      var byName = {};
      macros.forEach(function (m) { if (m && m.name) byName[m.name] = m; });
      // getMacros renders an UNBOUND key as the literal string "Not bound"
      // (MacroKeyLabel) — treating that as truthy made legacyBind swallow a
      // player's unkeyed one-action macro (the suite's s7 caught it on
      // v0.9.451: the user macro got deleted as a "legacy migration").
      var hasKey = function (m) { return !!(m && m.key && m.key !== "Not bound"); };
      var legacyBind = function (label) {
        var m = byName[label];
        return (hasKey(m) && (m.actions || []).length === 1) ? m : null;
      };
      var keyByLabel = {};
      rows.forEach(function (r) {
        var m = byName[bindName(r.label)] || legacyBind(r.label);
        if (hasKey(m)) keyByLabel[r.label] = m.key;
      });
      root.innerHTML = '<div class="uorail-bind-head"><span class="uorail-bind-cmd">Command</span><span class="uorail-bind-kh">Key</span></div>';
      var list = el("div", { "class": "uorail-bind-list" });
      rows.forEach(function (r) {
        var row = el("div", { "class": "uorail-bind-row" });
        row.appendChild(el("span", { "class": "uorail-bind-cmd" }, esc(r.label)));
        var keyBtn = el("button", { "class": "uorail-bind-key", "data-pointer": "auto", "data-tip": "Click, then press a key" }, esc(keyByLabel[r.label] || "Not bound"));
        var clrBtn = el("button", { "class": "uorail-key-x", "data-pointer": "auto", "data-tip": "Clear binding" }, "×");
        var capturing = false;
        keyBtn.addEventListener("click", function () {
          if (capturing) return;
          // Single capture at a time: starting a capture cancels any other row
          // still sitting in "Press a key…" (its capture-phase listener would
          // stopPropagation and starve this one — player report 2026-07-18).
          if (_bindCaptureCancel) _bindCaptureCancel();
          capturing = true;
          // Tells the main.js input bridge to hand US the next key instead of
          // pushing it into the engine (and walking/acting with it).
          window.__uoRailKeyCapture = true;
          keyBtn.textContent = "Press a key…";
          keyBtn.classList.add("uorail-key-capturing");
          var endCapture = function () {
            window.removeEventListener("keydown", onKey, true);
            window.removeEventListener("mousedown", onOutsideClick, true);
            capturing = false;
            window.__uoRailKeyCapture = false;
            _bindCaptureCancel = null;
            keyBtn.classList.remove("uorail-key-capturing");
          };
          // Clicking anywhere else disarms the capture — otherwise the armed
          // listener (+ the input-bridge yield flag) would eat the next key
          // the player presses while already back in the game.
          var onOutsideClick = function (ev) {
            if (ev.target !== keyBtn && _bindCaptureCancel) _bindCaptureCancel();
          };
          _bindCaptureCancel = function () {
            endCapture();
            keyBtn.textContent = keyByLabel[r.label] || "Not bound";
          };
          var onKey = function (ev) {
            if (ev.key === "Shift" || ev.key === "Control" || ev.key === "Alt" || ev.key === "Meta") return;
            ev.preventDefault(); ev.stopPropagation();
            endCapture();
            if (ev.key === "Escape") { keyBtn.textContent = keyByLabel[r.label] || "Not bound"; return; }
            var tok = keyToken(ev);
            if (!tok) { toast("Unsupported key"); keyBtn.textContent = keyByLabel[r.label] || "Not bound"; return; }
            // Modifiers from what the PAGE actually saw held (main.js __uoDomMods),
            // not ev.altKey/ctrlKey/shiftKey — those go stale after Alt+Tab and
            // would bind a phantom Alt+X. Fall back to ev if the bridge view is
            // absent (standalone docs/dev preview).
            var dm = window.__uoDomMods;
            var mAlt = dm ? dm.alt : ev.altKey, mCtrl = dm ? dm.ctrl : ev.ctrlKey, mShift = dm ? dm.shift : ev.shiftKey;
            // (falls through with the capture already ended by endCapture above)
            // Create (or reuse) OUR prefixed macro, set its single action, bind
            // the key. A pre-prefix legacy bind-macro is migrated (deleted)
            // first so its old key can't collide with the new binding.
            var bn = bindName(r.label);
            var legacy = legacyBind(r.label);
            Promise.resolve(legacy && br.deleteMacro ? br.deleteMacro(r.label) : true)
              .then(function () { return br.addMacro(bn); })
              .then(function () { return br.setMacroAction(bn, 0, r.code, r.sub || 0, ""); })
              .then(function () { return br.setMacroKey(bn, tok, mAlt, mCtrl, mShift); })
              .then(function (ok) {
                if (!ok) { toast("Key combo already in use"); keyBtn.textContent = keyByLabel[r.label] || "Not bound"; return; }
                Promise.resolve(br.getMacros ? br.getMacros() : []).then(function (ms) {
                  var mm = (ms || []).filter(function (x) { return x && x.name === bn; })[0];
                  var k = (mm && mm.key) ? mm.key : tok;
                  byName[bn] = mm || { name: bn, key: k, actions: [0] };   // ✕ can delete without a reload
                  if (legacy) { delete byName[r.label]; }                  // migrated away
                  keyByLabel[r.label] = k;
                  keyBtn.textContent = k;
                });
              })
              .catch(function () { toast("Could not bind"); keyBtn.textContent = keyByLabel[r.label] || "Not bound"; });
          };
          window.addEventListener("keydown", onKey, true);
          window.addEventListener("mousedown", onOutsideClick, true);
        });
        clrBtn.addEventListener("click", function () {
          if (!keyByLabel[r.label]) return;
          // Delete OUR macro: the prefixed one, or a legacy single-action bind.
          // A player's own macro that merely shares the command name is never
          // deleted from here (it isn't shown on the row either).
          var delName = byName[bindName(r.label)] ? bindName(r.label) : (legacyBind(r.label) ? r.label : null);
          if (!delName || !br.deleteMacro) { delete keyByLabel[r.label]; keyBtn.textContent = "Not bound"; return; }
          Promise.resolve(br.deleteMacro(delName)).then(function () {
            delete byName[delName];
            delete keyByLabel[r.label];
            keyBtn.textContent = "Not bound";
          });
        });
        row.appendChild(keyBtn);
        row.appendChild(clrBtn);
        list.appendChild(row);
      });
      root.appendChild(list);
    }).catch(function () { root.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Hotkey bindings are available in-world.</div>'; });
  }

  function renderHotkeys(tab, body) {
    if (tab === "Macros") {
      // The official Hotkeys panel IS the client's own macro system (the same
      // World.Macros / MacroManager the native Macro gump edits). We mirror the
      // native MacroControl: a macro is a name + keybind + an action chain, and
      // every action is a main dropdown (MacroType) plus — exactly per the
      // native SubMenuType — either a sub-dropdown (the GetBoundByCode range) or
      // a text field. Every list (types + sub-ranges) comes straight from the C#
      // bridge (getMacroCatalog) so it can never drift from the client's enums.
      // 🚨 Say so when these macros are browser-only. Measured 2026-08-11 (smoke macro-persist):
      // with a Discord session a macro DOES reach the server profile — created in-world, upload
      // logged, and GET /api/profile came back containing it. The upload is gated on being signed
      // in (`if (!_discordUser) return false`), so without Discord the macros live in this
      // browser's storage and ONLY there: clearing site data destroys them, which is what the
      // operator reported losing. The mechanism was never broken; the silence was.
      // The note starts EMPTY and is filled only once the identity is known. Defaulting to
      // "browser only" would flash a data-loss warning at a signed-in player whenever /api/me had
      // not answered yet — a false alarm about losing work is worse than no notice at all.
      body.innerHTML =
        '<div class="uorail-hk">' +
          '<div class="uorail-hk-col">' +
            '<div id="uorail-macro-sync-note"></div>' +
            '<div class="uorail-hk-add"><button class="uorail-btn-pill" id="uorail-add-macro" data-pointer="auto">Add Macro</button></div>' +
            '<div class="uorail-hk-list" id="uorail-hk-list"><div class="uorail-note">Loading…</div></div>' +
          "</div>" +
          '<div class="uorail-hk-edit" id="uorail-hk-edit"></div>' +
        "</div>";
      var listEl = body.querySelector("#uorail-hk-list");
      var editEl = body.querySelector("#uorail-hk-edit");

      // Resolve who is signed in, then say whether these macros leave this browser.
      // 401 (no session) and a guest sub are the two cases with no cloud copy; a Discord id is
      // the one case that syncs, and it stays silent.
      (function () {
        var noteEl = body.querySelector("#uorail-macro-sync-note");
        if (!noteEl) return;
        var warn = function () {
          noteEl.className = "uorail-note uorail-note-warn";
          noteEl.textContent = "Not signed in with Discord — macros are saved in this browser only, "
            + "and clearing its data deletes them. Sign in to keep them on your account.";
        };
        var decide = function (me) {
          if (me && me.id && String(me.id).indexOf("guest-") !== 0) return;  // Discord: it syncs
          warn();
        };
        if (window.__gmIdentity) { decide(window.__gmIdentity); return; }
        fetch("/api/me", { credentials: "same-origin", cache: "no-cache" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(decide)
          .catch(function () { /* offline: unknown, so say nothing rather than cry wolf */ });
      })();
      var br = window.UORailBridge;
      var reload, selectedName = null, catalog = { types: [], subs: {} }, typeSub = {};
      var buildTypeSub = function () { typeSub = {}; (catalog.types || []).forEach(function (t) { typeSub[t.v] = t.sub; }); };
      var editable = function () { return !!(br && br.setMacroAction && catalog.types && catalog.types.length); };
      var typeOptions = function (code) {
        return (catalog.types || []).map(function (t) {
          return '<option value="' + t.v + '"' + (t.v === code ? " selected" : "") + ">" + esc(t.n) + "</option>";
        }).join("");
      };
      var subOptions = function (code, sub) {
        return (((catalog.subs || {})[code]) || []).map(function (s) {
          return '<option value="' + s.v + '"' + (s.v === sub ? " selected" : "") + ">" + esc(s.n) + "</option>";
        }).join("");
      };
      var actionRow = function (a, i) {
        var st = typeSub[a.code] || 0, mid = "";
        if (st === 1) mid = '<select class="uorail-macro-sub" data-pointer="auto">' + subOptions(a.code, a.sub) + "</select>";
        else if (st === 2) mid = '<input class="uorail-macro-text" data-pointer="auto" placeholder="text…" value="' + esc(a.text || "") + '">';
        return '<div class="uorail-macro-row" data-i="' + i + '">' +
            '<select class="uorail-macro-type" data-pointer="auto">' + typeOptions(a.code) + "</select>" +
            '<button class="uorail-icon-btn uorail-icon-danger uorail-icon-sm uorail-macro-del" data-pointer="auto" data-tip="Remove action">−</button>' +
            mid +
          "</div>";
      };
      var showMacro = function (m) {
        selectedName = m.name;
        var capturing = false;
        var head =
          '<div class="uorail-hk-name"><input class="uorail-input" id="uorail-macro-name" value="' + esc(m.name || "") + '" data-pointer="auto"' + (br && br.renameMacro ? ' data-tip="Type here to rename"' : ' readonly') + '>' +
          '<button class="uorail-icon-btn uorail-icon-danger" id="uorail-del-macro" data-pointer="auto" data-tip="Delete macro">−</button></div>' +
          '<div class="uorail-hk-bind"><button class="uorail-key-capture" id="uorail-bind-set" data-pointer="auto" data-tip="Click, then press a key">' + bindChips(m.key) + "</button>" +
          '<button class="uorail-key-x" id="uorail-bind-clear" data-pointer="auto" data-tip="Clear key">×</button></div>';
        var bodyHtml;
        if (editable()) {
          bodyHtml = '<div class="uorail-macro-list">' + (m.actions || []).map(actionRow).join("") + "</div>" +
            '<div class="uorail-macro-add"><button class="uorail-btn-pill" id="uorail-add-action" data-pointer="auto">+ Add action</button></div>';
        } else {
          // Out of world (no live bridge): read-only labels, like the native gump.
          bodyHtml = (m.actions && m.actions.length)
            ? m.actions.map(function (a, i) {
                return '<div class="uorail-hk-action-lbl">Action #' + (i + 1) + "</div>" +
                  '<div class="uorail-hk-action"><div class="uorail-hk-actiontext">' + esc((a && (a.label || a.codeName)) || "") + "</div></div>";
              }).join("")
            : '<div class="uorail-note">No actions in this macro.</div>';
        }
        editEl.innerHTML = head + bodyHtml;
        // Renaming used to be impossible: this field LOOKED editable and carried readonly, which
        // is why it was reported as broken rather than missing. It stays readonly out of world,
        // where there is no macro store to write to. Commit on Enter or on blur; the client
        // refuses a blank name or one another macro holds, and on success the panel reloads from
        // the client so the list cannot disagree with the macro store.
        var nameEl = editEl.querySelector("#uorail-macro-name");
        if (nameEl && br && br.renameMacro) {
          var commitName = function () {
            var next = (nameEl.value || "").trim();
            if (!next || next === m.name) { nameEl.value = m.name || ""; return; }
            Promise.resolve(br.renameMacro(m.name, next)).then(function (ok) {
              if (!ok) { nameEl.value = m.name || ""; toast("That name is already taken"); return; }
              selectedName = next; m.name = next; reload();
            });
          };
          // 🚨 COMMIT DIRECTLY, NOT THROUGH blur(). This used to be `keydown Enter → nameEl.blur()`
          // and rely on the blur handler, and renaming a macro simply did not work (operator,
          // 2026-08-27). Traced live: the Enter keydown REACHES the input, the listeners ARE
          // attached — confirmed through CDP, not by reading — and the programmatic blur() emits no
          // blur event at all, so the commit never ran. Nothing errors; the field just snaps back.
          //
          // `change` is the reliable signal for a text input (it fires on Enter and on a real focus
          // loss), and the Enter handler now calls the commit itself rather than hoping a second
          // event arrives. blur stays as a third path for a genuine click-away.
          var committed = false;
          var commitOnce = function () { if (committed) return; committed = true; commitName(); };
          nameEl.addEventListener("change", commitOnce);
          nameEl.addEventListener("blur", commitOnce);
          nameEl.addEventListener("keydown", function (ev) {
            if (ev.key !== "Enter") return;
            ev.preventDefault();
            commitOnce();
          });
          // Re-arm for the next edit: without this a second rename in the same panel is a no-op,
          // which would read exactly like the bug being fixed.
          nameEl.addEventListener("focus", function () { committed = false; });
        }
        var del = editEl.querySelector("#uorail-del-macro");
        if (del) del.addEventListener("click", function () {
          if (!br || !br.deleteMacro) { toast("Macros are available in-world"); return; }
          uiConfirm("Delete macro “" + (m.name || "") + "”?").then(function (yes) {
            if (!yes) return;
            Promise.resolve(br.deleteMacro(m.name)).then(function (ok) { if (ok) { selectedName = null; reload(); } else toast("Delete failed"); });
          });
        });
        // Keybind capture (native HotkeyBox): click → press a key → SetMacroKey.
        var setBtn = editEl.querySelector("#uorail-bind-set");
        var clrBtn = editEl.querySelector("#uorail-bind-clear");
        if (setBtn && br && br.setMacroKey) {
          setBtn.addEventListener("click", function () {
            if (capturing) return;
            // 🚨 TELL THE INPUT BRIDGE TO YIELD, WHICH THIS ONE NEVER DID. main.js swallows every
            // keydown and pushes it into the engine — it calls stopImmediatePropagation, so a
            // listener added later on window never runs — UNLESS window.__uoRailKeyCapture is
            // raised. The Hotkeys rows a few hundred lines up do raise it; this capture, in the
            // MACRO editor, did not, so pressing any key did nothing at all and the button sat on
            // "Press a key…" for ever (operator, 2026-08-27).
            //
            // Two implementations of one interaction, and only one of them held the contract. The
            // bridge's own comment says the rail "raises __uoRailKeyCapture and owns the next
            // keydown" — accurate about the mechanism, silent about the second caller that forgot.
            if (_bindCaptureCancel) _bindCaptureCancel();   // one capture at a time, as above
            capturing = true;
            window.__uoRailKeyCapture = true;
            setBtn.textContent = "Press a key…";
            setBtn.classList.add("uorail-key-capturing");
            var endCapture = function () {
              window.removeEventListener("keydown", onKey, true);
              window.removeEventListener("mousedown", onOutsideClick, true);
              capturing = false;
              window.__uoRailKeyCapture = false;
              _bindCaptureCancel = null;
              setBtn.classList.remove("uorail-key-capturing");
            };
            // Clicking elsewhere disarms it. Without this the yield flag stays raised and the next
            // key the player presses in the game is eaten instead of walking them.
            var onOutsideClick = function (ev) {
              if (ev.target !== setBtn && _bindCaptureCancel) _bindCaptureCancel();
            };
            _bindCaptureCancel = function () { endCapture(); reload(); };
            var onKey = function (e) {
              if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
              e.preventDefault(); e.stopPropagation();
              endCapture();
              if (e.key === "Escape") { reload(); return; }
              var tok = keyToken(e);
              if (!tok) { toast("Unsupported key"); reload(); return; }
              Promise.resolve(br.setMacroKey(m.name, tok, e.altKey, e.ctrlKey, e.shiftKey)).then(function (ok) { if (!ok) toast("Key combo already in use"); reload(); });
            };
            window.addEventListener("keydown", onKey, true);
            window.addEventListener("mousedown", onOutsideClick, true);
          });
        } else if (setBtn) {
          setBtn.addEventListener("click", function () { toast("Macros are available in-world"); });
        }
        if (clrBtn && br && br.clearMacroKey) {
          clrBtn.addEventListener("click", function () { Promise.resolve(br.clearMacroKey(m.name)).then(function () { reload(); }); });
        }
        if (!editable()) return;
        var persist = function (i, code, sub, text) {
          Promise.resolve(br.setMacroAction(m.name, i, code, sub, text || "")).then(function (ok) { if (ok) reload(); });
        };
        editEl.querySelectorAll(".uorail-macro-row").forEach(function (row) {
          var i = +row.getAttribute("data-i");
          var typeSel = row.querySelector(".uorail-macro-type");
          var subSel = row.querySelector(".uorail-macro-sub");
          var txt = row.querySelector(".uorail-macro-text");
          var delA = row.querySelector(".uorail-macro-del");
          if (typeSel) typeSel.addEventListener("change", function () { persist(i, +typeSel.value, -1, ""); });
          if (subSel) subSel.addEventListener("change", function () { persist(i, +typeSel.value, +subSel.value, ""); });
          if (txt) txt.addEventListener("change", function () { persist(i, +typeSel.value, 0, txt.value); });
          if (delA) delA.addEventListener("click", function () { Promise.resolve(br.removeMacroActionAt(m.name, i)).then(function (ok) { if (ok) reload(); }); });
        });
        var addA = editEl.querySelector("#uorail-add-action");
        if (addA) addA.addEventListener("click", function () { Promise.resolve(br.addMacroAction(m.name)).then(function (ok) { if (ok) reload(); }); });
      };
      var renderList = function (macros) {
        if (!macros || !macros.length) {
          listEl.innerHTML = '<div class="uorail-note">No macros yet — your in-world macros appear here.</div>';
          editEl.innerHTML = "";
          return;
        }
        var sel = 0;
        if (selectedName) { for (var k = 0; k < macros.length; k++) { if (macros[k].name === selectedName) { sel = k; break; } } }
        listEl.innerHTML = macros.map(function (m, i) {
          return '<button class="uorail-hk-item' + (i === sel ? " uorail-hk-item-active" : "") + '" data-pointer="auto">' + esc(m.name || "(unnamed)") + "</button>";
        }).join("");
        var items = listEl.querySelectorAll(".uorail-hk-item");
        items.forEach(function (it, i) {
          it.addEventListener("click", function () {
            items.forEach(function (x) { x.classList.remove("uorail-hk-item-active"); });
            it.classList.add("uorail-hk-item-active");
            showMacro(macros[i]);
          });
        });
        showMacro(macros[sel]);
      };
      reload = function () {
        if (br && br.getMacros) { Promise.resolve(br.getMacros()).then(renderList).catch(function () { renderList([]); }); }
        else { renderList([]); }
      };
      var addBtn = body.querySelector("#uorail-add-macro");
      if (addBtn) addBtn.addEventListener("click", function () {
        if (!br || !br.addMacro) { toast("Macros are available in-world"); return; }
        uiPrompt("New macro name:", "Macro").then(function (raw) {
          var name = (raw || "").trim();
          if (!name) return;
          Promise.resolve(br.addMacro(name)).then(function (ok) { if (ok) { selectedName = name; reload(); } else toast("Couldn’t add (need a unique name, in-world)"); });
        });
      });
      // Load the action catalog once (types + sub-ranges), then the macro list.
      (br && br.getMacroCatalog ? Promise.resolve(br.getMacroCatalog()).then(function (c) { if (c && c.types) { catalog = c; buildTypeSub(); } }).catch(function () {}) : Promise.resolve()).then(reload);
    } else {
      // Real per-command keybinds (Combat/General/Target/Skills/Spells), built
      // and wired asynchronously from the live macro catalog. See wireBindings.
      body.innerHTML = '<div class="uorail-form uorail-bind-form"><div class="uorail-bind" data-bind><div class="uorail-note" style="padding:8px 4px">Loading…</div></div></div>';
      wireBindings(tab, body);
    }
  }

  // Action-button icons for the User panel (matches the official icon+label look).
  var AI = {
    imp:   '<path d="M12 3v12M7 11l5 5 5-5M5 21h14"/>',
    map:   '<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="10.5" r="2"/>',
    doc:   '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11.5v5M9.5 14h5"/>',
    pen:   '<path d="M4 20h4L18.5 9.5l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    del:   '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13"/>',
    clone: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    out:   '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
    cloud: '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.3A3.5 3.5 0 0 1 17 18z"/><path d="M12 16v-5M9.5 13l2.5-2.5 2.5 2.5"/>',
    exp:   '<path d="M12 16V4M7 8l5-5 5 5M5 21h14"/>',
  };
  function actBtn(cls, icon, label, off) {
    return '<button class="uorail-act ' + cls + '" data-pointer="auto"' + (off ? " disabled" : "") + ">" +
      svg(icon, "uorail-act-ic") + "<span>" + esc(label) + "</span></button>";
  }

  // User panel — every control here is backed by a REAL engine (no aesthetic
  // stubs). Account identity comes from window.UORailAccount.identity() (the
  // host's Discord session); cloud sync is the live /api/profile tar mechanism
  // (auto-restored on login, auto-saved on exit) with a manual "Sync now"
  // wired to UORailAccount.syncNow() (force-upload). Logout / Clear cache call
  // the host's real handlers.
  // ── GM Tools (staff-only) ───────────────────────────────────────────────────
  // Visible only to global admins (servers:write) and owners of THIS shard
  // (servers:write:own + ownedServers includes the slug). Offers the right
  // desktop toolkit for the shard's emulator — Pandora for RunUO/ServUO/ModernUO,
  // Leviathan for Sphere — with setup help. The desktop tools are Windows-only;
  // on macOS/Linux a GM just types commands in the game view. A command only acts
  // if the in-game character is staff on this shard.
  // ⚠️ THE STAFF GATE IS GONE, and it was doing nothing here. gmGate() fetched /api/me on every
  // gamescene activation to reveal rail buttons marked data-admin-only — and no panel in this build
  // declares adminOnly, so it revealed nothing, every time. It came across with the hand-trim
  // because it lives in rail.js rather than in the GM panel that was removed.
  //
  // Its one surviving effect was warming window.__gmIdentity for the macro-sync note, which already
  // fetches /api/me itself when that cache is cold. So this is strictly fewer requests: one when
  // the Macros panel is opened, instead of one per entry into the world.






  // ⚠️ "Export from cache" USED TO LIVE HERE and was removed on 2026-08-27: 73 lines that nothing
  // called. It belonged to the GM tools panel, which this build does not have, so it shipped as an
  // unreachable function rather than a feature. It is worth someone's time to wire it to the
  // Storage panel one day — dumping the browser's copy of the gamefiles to a .tar, entirely client
  // side, is genuinely useful to a self-hoster — but code that no button reaches is not that
  // feature, it is the appearance of it. See git history for the implementation.

  // (Quick Commands tab removed — a GM types commands directly in the game view,
  //  so an in-rail command sender was redundant.)


  function renderUser(tab, body) {
    var acct = (window.UORailAccount && window.UORailAccount.identity)
      ? (window.UORailAccount.identity() || {}) : {};
    // Import/export operate on THIS client's own profile format, so the label
    // names the client (a TazUO bundle imports TazUO profiles, never CUO's).
    var clientName = (CLIENT === "tuo") ? "TazUO" : "ClassicUO";
    // ── Performance tab ────────────────────────────────────────────────────────
    // A one-click preset for old hardware. The operator's players run machines ten
    // years old, and the three defaults that hurt most there are all invisible wins
    // for someone on a weak GPU: object shadows are drawn as an EXTRA sprite per
    // mobile and per static, every frame (MobileView/StaticView consult
    // ShadowsEnabled inside Draw), terrain shadows add a second pass, and sprite
    // smoothing costs GPU time on every blit.
    //
    // Deliberately NOT a new default: shadows are visible, so switching them off for
    // everyone would trade the look of the game for frames nobody asked to trade.
    // This gives the lever to the player who needs it, and hands it back intact.
    if (tab === "Performance") {
      // Defined at module scope (PERF_LOW_MAP / PERF_STD_MAP) so the automatic
      // weak-machine hint applies EXACTLY what this button does. Two copies would
      // drift and the hint would end up promising something the panel does not do.
      var PERF_LOW = PERF_LOW_MAP;
      var PERF_STD = PERF_STD_MAP;
      body.innerHTML = '<div class="uorail-form">' + subH("Performance") +
        '<div class="uorail-note">For older machines. Turns off the effects that cost the most ' +
        'GPU time per frame: object shadows (an extra sprite for every creature and every static, ' +
        'every frame), terrain shadows, and sprite smoothing. Applies to this character profile ' +
        'and takes effect immediately.</div>' +
        '<div class="uorail-hk-add">' +
          '<button class="uorail-btn-pill" data-act="perf-low" data-pointer="auto">Apply performance mode</button>' +
          '<button class="uorail-btn-pill" data-act="perf-std" data-pointer="auto">Restore standard quality</button>' +
        '</div>' +
        '<div class="uorail-note uorail-perf-state" style="margin-top:10px"></div>' +
      '</div>';

      var stateEl = body.querySelector(".uorail-perf-state");
      function perfShow() {
        var br = window.UORailBridge;
        if (!br || !br.getProfile) { stateEl.textContent = ""; return; }
        Promise.resolve(br.getProfile()).then(function (p) {
          if (!p) return;
          var sh = String(p.ShadowsEnabled) === "true";
          var sm = Number(p.SpriteSmoothingMode) || 0;
          stateEl.textContent = "Now: object shadows " + (sh ? "on" : "off")
            + " · terrain shadows " + (Number(p.TerrainShadowsLevel) || 0)
            + " · sprite smoothing " + (sm ? "on" : "off");
        }).catch(function () { /* panel still usable without the readback */ });
      }
      function perfApply(map, label) {
        var br = window.UORailBridge;
        if (!br || !br.setSetting) return;
        Object.keys(map).forEach(function (k) {
          try { br.setSetting(k, map[k]); } catch (e) { /* skip keys this fork lacks */ }
        });
        stateEl.textContent = label;
        setTimeout(perfShow, 350);
      }
      body.addEventListener("click", function (ev) {
        var b = ev.target.closest("[data-act]");
        if (!b) return;
        if (b.getAttribute("data-act") === "perf-low") perfApply(PERF_LOW, "Performance mode applied.");
        if (b.getAttribute("data-act") === "perf-std") perfApply(PERF_STD, "Standard quality restored.");
      });
      perfShow();
      return;
    }
    if (tab === "Profile") {
      var signedIn = !!acct.id;
      var idRow = signedIn
        ? '<div class="uorail-pid"><span data-tip="Discord ID">' + esc(acct.id) + '</span>' +
            '<button class="uorail-icon-btn uorail-icon-sm" data-act="copyid" data-pointer="auto" data-tip="Copy Discord ID">⧉</button></div>'
        : '<div class="uorail-note">Guest session — sign in with Discord to sync your settings across devices.</div>';
      body.innerHTML =
        '<div class="uorail-user">' +
          '<div class="uorail-user-main">' +
            '<div class="uorail-sec">Account</div>' +
            '<div class="uorail-acct">' +
              (acct.avatarUrl ? '<img class="uorail-acct-av" crossorigin="anonymous" referrerpolicy="no-referrer" src="' + esc(acct.avatarUrl) + '" alt="">' : '<div class="uorail-acct-av uorail-acct-av-ph"></div>') +
              '<div class="uorail-acct-meta">' +
                '<div class="uorail-acct-name">' + esc(acct.name || "Guest") + '</div>' +
                idRow +
              '</div>' +
            '</div>' +
            '<div class="uorail-sec">Cloud Sync</div>' +
            '<div class="uorail-note">Your in-game settings — options, macros, hotkeys and window layout — ' +
              (signedIn
                ? 'sync to the cloud against your Discord account. They are restored automatically when you log in and saved when you leave; use <strong>Sync now</strong> to push the current state immediately.'
                : 'are stored only in this browser. Sign in with Discord to back them up to the cloud and carry them across devices.') +
            '</div>' +
            '<div class="uorail-sec">Profile</div>' +
            '<div class="uorail-note">Export your ' + esc(clientName) + ' profile to a file (settings, macros, hotkeys, window layout) to back it up or move it to another device, or import one you exported before. Importing reloads the client.</div>' +
          "</div>" +
          '<div class="uorail-user-side">' +
            (signedIn ? actBtn("uorail-act-gold", AI.cloud, "Sync now") : '') +
            actBtn("", AI.exp, "Export " + clientName + " profile") +
            actBtn("", AI.imp, "Import " + clientName + " profile") +
            actBtn("", AI.out, "Logout") +
            // Only for signed-in accounts: it revokes every session of the
            // Discord `sub`, which is meaningless for a device-local guest.
            (signedIn ? actBtn("", AI.out, "Sign out everywhere") : '') +
          "</div>" +
        "</div>";
      var copyBtn = body.querySelector('[data-act="copyid"]');
      if (copyBtn) copyBtn.addEventListener("click", function () {
        try { navigator.clipboard.writeText(acct.id); toast("Discord ID copied"); }
        catch (e) { toast("Copy unavailable"); }
      });
      body.querySelectorAll(".uorail-user-side .uorail-act").forEach(function (b) {
        var label = (b.textContent || "").trim();
        if (label === "Logout") {
          b.addEventListener("click", function () {
            if (window.UORailAccount && window.UORailAccount.signOut) { window.UORailAccount.signOut(); }
            else { toast("Sign out is available in-world"); }
          });
        } else if (label === "Sign out everywhere") {
          // Two-click confirm, prompted by TOAST rather than by rewriting the
          // button: actBtn's markup carries an icon, and setting textContent
          // would wipe it. Re-arms itself after 5 s so a stray first click
          // cannot leave the button primed for later.
          var armed = false, armT = null;
          b.addEventListener("click", function () {
            if (!(window.UORailAccount && window.UORailAccount.signOutEverywhere)) {
              toast("Sign out is available in-world"); return;
            }
            if (!armed) {
              armed = true;
              toast("Click again to sign out on ALL your devices");
              armT = setTimeout(function () { armed = false; }, 5000);
              return;
            }
            clearTimeout(armT); armed = false; b.disabled = true;
            window.UORailAccount.signOutEverywhere();
          });
        } else if (label === "Sync now") {
          b.addEventListener("click", function () {
            if (!(window.UORailAccount && window.UORailAccount.syncNow)) { toast("Cloud sync is available in-world"); return; }
            b.disabled = true; toast("Syncing settings to the cloud…");
            Promise.resolve(window.UORailAccount.syncNow()).then(function (ok) {
              toast(ok ? "Settings synced to the cloud" : "Nothing to sync yet");
            }).catch(function () { toast("Sync failed — try again"); })
              .then(function () { b.disabled = false; });
          });
        } else if (label.indexOf("Export") === 0) {
          b.addEventListener("click", function () {
            if (!(window.UORailAccount && window.UORailAccount.exportProfile)) { toast("Export is available in-world"); return; }
            b.disabled = true;
            Promise.resolve(window.UORailAccount.exportProfile()).then(function (r) {
              toast(r && r.ok ? ("Exported " + r.count + " profile file" + (r.count === 1 ? "" : "s")) : "Nothing to export yet");
            }).catch(function () { toast("Export failed"); })
              .then(function () { b.disabled = false; });
          });
        } else if (label.indexOf("Import") === 0) {
          b.addEventListener("click", function () {
            if (!(window.UORailAccount && window.UORailAccount.importProfile)) { toast("Import is available in-world"); return; }
            Promise.resolve(window.UORailAccount.importProfile()).then(function (r) {
              if (r && r.ok) { toast("Imported " + r.count + " file" + (r.count === 1 ? "" : "s") + " — reloading…"); }
              else if (r && r.error) { toast("Import failed: " + r.error); }
              else { toast("Import cancelled"); }
            }).catch(function () { toast("Import failed"); });
          });
        }
      });
    } else {
      body.innerHTML = '<div class="uorail-form">' + subH("Storage Management") +
        '<div class="uorail-note">Cached gamefiles + profile storage used by this browser.</div>' +
        '<div class="uorail-field"><div class="uorail-field-lbl">Storage used <span class="uorail-storage-val">measuring…</span></div>' +
          '<div class="uorail-storage-bar"><div class="uorail-storage-fill" style="width:0%"></div></div></div>' +
        '<div class="uorail-note uorail-cache-receipt" style="margin-top:8px"></div>' +
        '<div class="uorail-field-lbl" style="margin-top:10px">Cached game data <span class="uorail-sm-total uorail-storage-val">measuring…</span></div>' +
        '<div class="uorail-sm-list"><div class="uorail-note" style="padding:8px 4px">Loading…</div></div>' +
        '<div class="uorail-hk-add"><button class="uorail-btn-pill" data-act="sm-clear-all" data-pointer="auto">Clear all cached data</button></div></div>';
      // REAL usage via the Storage API (navigator.storage.estimate), not a fake bar.
      (function () {
        var valEl = body.querySelector(".uorail-storage-val");
        var fillEl = body.querySelector(".uorail-storage-fill");
        if (navigator.storage && navigator.storage.estimate) {
          navigator.storage.estimate().then(function (est) {
            var used = est.usage || 0, quota = est.quota || 0;
            var pct = quota > 0 ? Math.min(100, Math.round(used / quota * 100)) : 0;
            if (valEl) valEl.textContent = fmtBytes(used) + (quota ? " / " + fmtBytes(quota) + " (" + pct + "%)" : "");
            if (fillEl) fillEl.style.width = pct + "%";
          }).catch(function () { if (valEl) valEl.textContent = "unavailable"; });
        } else if (valEl) { valEl.textContent = "unavailable"; }
      })();
      // Last asset load, from the receipt main.js writes at the end of fetchAll.
      // Answers "did the second client reuse what the first one downloaded?" without
      // DevTools — the console line that says it is silenced for normal sessions.
      // textContent throughout; every field is coerced to a number or a fixed word.
      (function () {
        var rcEl = body.querySelector(".uorail-cache-receipt");
        if (!rcEl) return;
        var r = null;
        try { r = JSON.parse(localStorage.getItem("uo-cache-receipt") || "null"); } catch (e) { r = null; }
        if (!r || typeof r.files !== "number") {
          rcEl.textContent = "Last game-file load: no record yet — it appears after you enter a world.";
          return;
        }
        var bundle = ({ cuo: "ClassicUO", tuo: "TazUO", mini: "Mini" })[r.bundle] || "client";
        var mins = Math.max(0, Math.round((Date.now() - r.t) / 60000));
        var when = mins < 1 ? "just now" : (mins < 60 ? mins + " min ago" : Math.round(mins / 60) + " h ago");
        var cached = r.cached | 0, dl = r.downloaded | 0;
        var txt = "Last game-file load (" + bundle + ", " + when + "): " + cached + " reused from cache, " + dl + " downloaded";
        if (dl > 0 && r.miss) {
          // Name the reason rather than leaving "downloaded" to be read as a verdict on
          // the cache: noEntry means nothing was stored, net200 means the bytes changed.
          var why = (r.miss.noEntry | 0) >= dl ? "nothing was cached for them"
            : (r.miss.net200 | 0) > 0 ? "the server had newer bytes"
            : "mixed reasons";
          txt += " (" + why + ")";
        }
        txt += ".";
        if (r.writesOff) txt += " Caching was DISABLED mid-load — this browser ran out of storage.";
        else if (r.persisted === false) txt += " Storage is best-effort here, so the browser may evict this cache between sessions.";
        rcEl.textContent = txt;
      })();
      // Per-shard cached-gamefiles breakdown with individual delete — same data
      // and options as the main Discord storage modal (_storageRender in main.js),
      // re-skinned with the rail's uorail-* classes. Data via the shared
      // window.__uoGamefilesCache (set by main.js). textContent throughout — a
      // hostile shard displayName can never inject markup.
      (function () {
        var listEl  = body.querySelector(".uorail-sm-list");
        var totalEl = body.querySelector(".uorail-sm-total");
        var api = window.__uoGamefilesCache;
        if (!api || !api.usageByShard) {
          if (listEl) listEl.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Cached game data appears once you\'re in-world.</div>';
          if (totalEl) totalEl.textContent = "";
          return;
        }
        function render() {
          if (!listEl) return;
          listEl.textContent = "";
          if (totalEl) totalEl.textContent = "measuring…";
          // Best-effort base→shard-name map so rows show "Britannia" not "files-…".
          var baseNames = {};
          fetch("/api/servers", { credentials: "same-origin" }).then(function (r) {
            return r.ok ? r.json() : null;
          }).catch(function () { return null; }).then(function (data) {
            if (data) {
              var arr = Array.isArray(data) ? data : (data.servers || []);
              arr.forEach(function (s) {
                var b = s && s.gamefilesUrlBase; if (!b) return;
                (baseNames[b] = baseNames[b] || []).push(s.displayName || s.slug || b);
              });
            }
            return api.usageByShard();
          }).then(function (usage) {
            usage = usage || { total: 0, shards: [] };
            if (totalEl) {
              totalEl.textContent = fmtBytes(usage.total) +
                (usage.shards.length ? " · " + usage.shards.length + " shard" + (usage.shards.length === 1 ? "" : "s") : "");
            }
            listEl.textContent = "";
            if (!usage.shards.length) {
              listEl.appendChild(el("div", { "class": "uorail-note", style: "padding:8px 4px" }, "No cached game data in this browser yet."));
              return;
            }
            usage.shards.forEach(function (sh) {
              var names = baseNames[sh.base];
              var row = el("div", { "class": "uorail-sm-row" });
              var mid = el("div", { "class": "uorail-sm-mid" });
              var nm = el("div", { "class": "uorail-sm-name" });
              nm.textContent = (names && names.length) ? names.join(", ") : sh.base;
              var sub = el("div", { "class": "uorail-sm-sub" });
              sub.textContent = sh.base + " · " + sh.files + " file" + (sh.files === 1 ? "" : "s");
              mid.appendChild(nm); mid.appendChild(sub);
              var size = el("div", { "class": "uorail-sm-size" });
              size.textContent = fmtBytes(sh.bytes);
              var del = el("button", { "class": "uorail-sm-del", type: "button", "data-pointer": "auto" }, "Delete");
              del.addEventListener("click", function () {
                del.disabled = true; del.textContent = "Deleting…";
                Promise.resolve(api.deleteShard(sh.base)).catch(function () {}).then(render);
              });
              row.appendChild(mid); row.appendChild(size); row.appendChild(del);
              listEl.appendChild(row);
            });
          }).catch(function () {
            if (listEl) listEl.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Could not read cached data.</div>';
          });
        }
        render();
        var clr = body.querySelector('[data-act="sm-clear-all"]');
        // uiConfirm, not window.confirm: the native dialog parks the Mercury MT main
        // thread (same freeze family as window.prompt). The Macros Delete button was
        // converted when the macro audit caught it; this one survived the sweep.
        if (clr) clr.addEventListener("click", function () {
          uiConfirm("Delete ALL cached game data for every shard in this browser? It re-downloads on next play.").then(function (yes) {
            if (!yes) return;
            clr.disabled = true; var orig = clr.textContent; clr.textContent = "Deleting…";
            Promise.resolve(api.clearAll ? api.clearAll() : (window.UORailAccount && window.UORailAccount.clearCache && window.UORailAccount.clearCache()))
              .catch(function () {}).then(function () { clr.disabled = false; clr.textContent = orig; render(); });
          });
        });
      })();
    }
  }

  // Human-readable byte count for the storage readout.
  function fmtBytes(n) {
    if (!n || n < 1024) return (n | 0) + " B";
    var u = ["KB", "MB", "GB", "TB"], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + " " + u[i];
  }

  // ── World Map — UOAM-style live position sharing ────────────────────────────
  // Connects to the proxy's /uoam hub. Rooms are keyed SERVER-side by shard slug
  // + the group password, so only same-shard peers who entered the SAME password
  // see each other (private "domains", per-server). Off until the user clicks
  // Connect — position is never shared otherwise. The WS + position loop live at
  // module scope so they persist while you play with the panel closed; the panel
  // shows status + a live radar. (Native in-game WorldMap markers are a planned
  // follow-up; WMapManager is party-gated so that needs a WorldMapGump pass.)
  var _uoam = { ws: null, timer: 0, connected: false, peers: {}, cfg: null, onPeers: null };

  function uoamSlug() { return (window.__chosenServerSlug || "").toString(); }
  // Per-shard AND per-account: the room password must NOT leak between accounts
  // sharing a browser (localStorage is browser-global, not account-scoped). Key on
  // the signed-in Discord id (or "guest"), and drop the legacy shard-only key.
  function uoamCfgKey() {
    var acct = (window.UORailAccount && window.UORailAccount.identity)
      ? (window.UORailAccount.identity() || {}) : {};
    var id = (acct && acct.id) ? String(acct.id) : "guest";
    return "uorail.uoam." + (CLIENT === "mini" ? "mini." : "") + uoamSlug() + "." + id; // mini namespaced (same origin as cuo on uonexus.com → avoid UOAM key collision); cuo/tuo key unchanged
  }
  function loadUoamCfg() {
    try { localStorage.removeItem("uorail.uoam." + uoamSlug()); } catch (e) {}   // legacy cross-account leak — drop it
    try { return JSON.parse(localStorage.getItem(uoamCfgKey()) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function saveUoamCfg(c) { try { localStorage.setItem(uoamCfgKey(), JSON.stringify(c)); } catch (e) {} }

  // Push the current peers to the in-game WorldMap (native markers via the
  // bridge). Runs regardless of panel state so the map updates while you play.
  // Compact delimited string (record \x1e, field \x1f: name\x1fx\x1fy\x1fmap);
  // names are stripped of the delimiters + capped.
  function pushUoamToWorldMap() {
    var br = window.UORailBridge;
    if (!br || !br.setUoamPeers) return;
    var s = Object.keys(_uoam.peers).map(function (k) {
      var p = _uoam.peers[k];
      var nm = String(p.name || "").replace(/[\x1e\x1f]/g, "").slice(0, 24);
      return nm + "\x1f" + (p.x | 0) + "\x1f" + (p.y | 0) + "\x1f" + (p.map | 0);
    }).join("\x1e");
    br.setUoamPeers(s);
  }

  function uoamDisconnect() {
    if (_uoam.timer) { clearInterval(_uoam.timer); _uoam.timer = 0; }
    if (_uoam.ws) { try { _uoam.ws.close(); } catch (e) {} _uoam.ws = null; }
    _uoam.connected = false; _uoam.peers = {};
    pushUoamToWorldMap();   // clear the in-game markers
    if (_uoam.onPeers) _uoam.onPeers();
  }

  function uoamConnect(cfg) {
    uoamDisconnect();
    _uoam.cfg = cfg;
    var br = window.UORailBridge;
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/uoam?slug=" + encodeURIComponent(uoamSlug());
    var ws;
    try { ws = new WebSocket(url); } catch (e) { toast("World Map connect failed"); return; }
    _uoam.ws = ws;
    var _opened = false;
    ws.onopen = function () {
      _uoam.connected = true;
      _opened = true;
      ws.send(JSON.stringify({ t: "join", pw: cfg.password || "", name: cfg.name || "player" }));
      if (_uoam.onPeers) _uoam.onPeers();
      var iv = Math.max(250, Math.min(5000, cfg.interval || 1000));
      _uoam.timer = setInterval(function () {
        if (!br || !br.player || !_uoam.ws || _uoam.ws.readyState !== 1) return;
        Promise.resolve(br.player()).then(function (p) {
          if (!p || !p.ingame || !_uoam.ws || _uoam.ws.readyState !== 1) return;
          _uoam.ws.send(JSON.stringify({ t: "pos", x: p.x | 0, y: p.y | 0, map: p.map | 0, hue: cfg.color | 0 }));
        }).catch(function () {});
      }, iv);
    };
    // Defensive: the hub already caps name(32)/room(200) and stamps peer ids,
    // but never trust peer data from other players — re-sanitize + bound here.
    function sanPeer(pp) {
      if (!pp || pp.id == null) return null;
      return { id: String(pp.id).slice(0, 64), name: String(pp.name || "player").slice(0, 24),
               x: pp.x | 0, y: pp.y | 0, map: pp.map | 0 };
    }
    ws.onmessage = function (ev) {
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.t === "peers") { _uoam.peers = {}; (Array.isArray(d.peers) ? d.peers : []).slice(0, 256).forEach(function (pp) { var s = sanPeer(pp); if (s) _uoam.peers[s.id] = s; }); }
      else if (d.t === "pos") { var s = sanPeer(d); if (s && (_uoam.peers[s.id] || Object.keys(_uoam.peers).length < 256)) _uoam.peers[s.id] = s; }
      else if (d.t === "leave") { if (d.id != null) delete _uoam.peers[String(d.id).slice(0, 64)]; }
      else if (d.t === "error") { toast("World Map: " + String(d.error || "error").slice(0, 80)); }
      pushUoamToWorldMap();             // update native in-game WorldMap markers
      if (_uoam.onPeers) _uoam.onPeers();   // update the rail panel radar/list (if open)
    };
    ws.onclose = function () {
      _uoam.connected = false;
      // Closed BEFORE onopen = the upgrade was refused (gate / not signed in). The
      // old empty handler hid this, so a failed Connect looked like "nothing happens".
      if (!_opened && _uoam.ws === ws) toast("World Map connect failed — sign in with Discord (guests can’t share position).");
      if (_uoam.onPeers) _uoam.onPeers();
    };
    ws.onerror = function () { /* onclose fires next and carries the user-facing toast */ };
  }

  function drawUoamRadar(canvas, peers) {
    if (!canvas) return;
    var ctx = canvas.getContext("2d"); var W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2;
    var br = window.UORailBridge;
    Promise.resolve(br && br.player ? br.player() : null).then(function (me) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "rgba(0,0,0,0.30)"; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
      ctx.fillStyle = "#e6a44e"; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 7); ctx.fill();   // you
      if (!me || !me.ingame) return;
      var scale = 0.04;  // px per world tile (radar zoom)
      peers.forEach(function (p) {
        if ((p.map | 0) !== (me.map | 0)) return;   // only same facet
        var dx = Math.max(-cx + 8, Math.min(cx - 8, (p.x - me.x) * scale));
        var dy = Math.max(-cy + 8, Math.min(cy - 8, (p.y - me.y) * scale));
        ctx.fillStyle = "#5cb85c"; ctx.beginPath(); ctx.arc(cx + dx, cy + dy, 3, 0, 7); ctx.fill();
        ctx.fillStyle = "#cfd6e6"; ctx.font = "10px sans-serif"; ctx.fillText((p.name || "").slice(0, 10), cx + dx + 6, cy + dy + 3);
      });
    }).catch(function () {});
  }


  var _huePalette = null, _huePalettePromise = null;
  function hueCss(idx) { // idx = 1-based Profile hue; palette[idx-1] = 0xRRGGBB
    if (!idx || !_huePalette || idx > _huePalette.length) return null;
    var c = _huePalette[idx - 1];
    return "rgb(" + ((c >> 16) & 255) + "," + ((c >> 8) & 255) + "," + (c & 255) + ")";
  }
  function selectB(k, label, opts) {
    var o = opts.map(function (x, i) { return '<option value="' + i + '">' + esc(x) + "</option>"; }).join("");
    return '<div class="uorail-field"><div class="uorail-field-lbl">' + esc(label) + '</div><div class="uorail-select-wrap"><select class="uorail-select" data-k="' + esc(k) + '" data-pointer="auto">' + o + '</select><span class="uorail-select-chev">⌄</span></div></div>';
  }
  function textB(k, label, ph) {
    return '<div class="uorail-field"><div class="uorail-field-lbl">' + esc(label) + '</div>' +
      '<input type="text" class="uorail-input uorail-textb" data-k="' + esc(k) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : "") + ' data-pointer="auto"></div>';
  }

  /* ══ Agents ═══════════════════════════════════════════════════════════════
     Ported from the full client on 2026-08-28, after the operator asked why this build did not have
     it. It was trimmed when this layer was hand-written, and the trim was not justified: the panel
     talks to NOTHING but window.UORailBridge — 34 verbs, every one already exposed here, and every
     CSS class it emits already in this stylesheet. It needed no portal, no economy and no server.

     Copied programmatically rather than retyped: 951 lines transcribed by eye is exactly how the two
     copies start to differ, and they are supposed to behave the same. */
  // A labelled single-line text field (Chat tab-manager, World Map, …).
  // Reached from renderOptItems rather than from the panel body, which is why the port
  // missed them on the first pass and the Loot tab rendered a ReferenceError instead.
  function checkB(k, label) { return '<label class="uorail-radio uorail-check"><input type="checkbox" data-k="' + esc(k) + '" data-pointer="auto"><span class="uorail-radio-box"></span><span class="uorail-radio-txt">' + esc(label) + '</span></label>'; }
  function rangeB(k, label, min, max) { return '<div class="uorail-field"><div class="uorail-field-lbl">' + esc(label) + '</div><input type="range" class="uorail-range" data-k="' + esc(k) + '" min="' + min + '" max="' + max + '" data-pointer="auto"></div>'; }

  function rangeH(label, min, max, val) { return '<div class="uorail-field"><div class="uorail-field-lbl">' + esc(label) + '</div><input type="range" class="uorail-range" min="' + min + '" max="' + max + '" value="' + val + '" data-pointer="auto"></div>'; }

  function selectH(label, opts, sel) {
    var o = opts.map(function (x) { return '<option' + (x === sel ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("");
    return '<div class="uorail-field"><div class="uorail-field-lbl">' + esc(label) + '</div><div class="uorail-select-wrap"><select class="uorail-select" data-pointer="auto">' + o + '</select><span class="uorail-select-chev">⌄</span></div></div>';
  }

  function radiosH() { return '<div class="uorail-radios">' + [].join.call(arguments, "") + "</div>"; }

  // Hue/colour control: a swatch button (data-huek = Profile ushort hue key) that
  // opens the UO palette picker. The swatch is painted with the hue's real colour
  // from the bridge palette (window.UORailBridge.getHuePalette).
  function hueB(k, label) {
    return '<div class="uorail-field uorail-huefield"><div class="uorail-field-lbl">' + esc(label) + '</div>' +
      '<button class="uorail-hue-swatch" data-huek="' + esc(k) + '" data-pointer="auto" data-tip="Pick a hue">' +
      '<span class="uorail-hue-fill"></span><span class="uorail-hue-idx">—</span></button></div>';
  }

  function huePaletteCached() {
    if (_huePalette) return Promise.resolve(_huePalette);
    var br = window.UORailBridge;
    if (!br || !br.getHuePalette) return Promise.resolve([]);
    if (!_huePalettePromise) {
      _huePalettePromise = Promise.resolve(br.getHuePalette()).then(function (p) {
        _huePalette = (p && p.length) ? p : null; return _huePalette || [];
      }).catch(function () { return []; });
    }
    return _huePalettePromise;
  }

  function paintSwatch(el, idx) {
    var fill = el.querySelector(".uorail-hue-fill"), lab = el.querySelector(".uorail-hue-idx");
    var css = hueCss(idx);
    if (lab) lab.textContent = idx ? String(idx) : "none";
    if (fill) { fill.style.background = css || ""; fill.classList.toggle("uorail-hue-none", !css); }
  }

  // Mirror of Profile.ResolveSpriteSmoothingMode (C#): map the -1 "legacy/auto"
  // sentinel to the concrete 0..4 mode for display. Works for both clients — CUO's
  // profile has no PostProcessingType so those branches are simply skipped.
  function resolveSmoothingMode(prof) {
    var m = parseInt(prof.SpriteSmoothingMode, 10);
    if (!isNaN(m) && m >= 0) return m;
    if (prof.EnablePostProcessingEffects && (prof.PostProcessingType | 0) === 3) return 3;
    if (prof.EnablePostProcessingEffects && (prof.PostProcessingType | 0) === 4) return 4;
    var lvl = parseInt(prof.SpriteSmoothingLevel, 10) || 0;
    if (lvl <= 0) return 0;
    return prof.SpriteSmoothingFull ? 2 : 1;
  }

  // UO hue palette popup — a canvas grid of every hue, click to pick. Faithful
  // colours come from the loaded hues.mul (bridge); shows a hint pre-in-world.
  function openHuePicker(current, onPick) {
    var prev = document.getElementById("uorail-hue-popup");
    if (prev) prev.remove();
    var overlay = el("div", { id: "uorail-hue-popup", "class": "uorail-hue-overlay" });
    var box = el("div", { "class": "uorail-hue-box" });
    box.innerHTML = '<div class="uorail-hue-head"><span>Pick a hue</span>' +
      '<button class="uorail-hue-default" data-pointer="auto">Default (no hue)</button>' +
      '<button class="uorail-hue-close" data-pointer="auto" data-tip="Close">✕</button></div>';
    huePaletteCached().then(function (pal) {
      if (!pal || !pal.length) {
        box.appendChild(el("div", { "class": "uorail-note", style: "padding:18px" }, "Hues load once you're in-world."));
      } else {
        var COLS = 50, CELL = 13, rows = Math.ceil(pal.length / COLS);
        var canvas = el("canvas", { "class": "uorail-hue-canvas", width: COLS * CELL, height: rows * CELL, "data-pointer": "auto" });
        var ctx = canvas.getContext("2d");
        for (var i = 0; i < pal.length; i++) {
          var c = pal[i];
          ctx.fillStyle = "rgb(" + ((c >> 16) & 255) + "," + ((c >> 8) & 255) + "," + (c & 255) + ")";
          ctx.fillRect((i % COLS) * CELL, ((i / COLS) | 0) * CELL, CELL, CELL);
        }
        if (current && current <= pal.length) {
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
          ctx.strokeRect(((current - 1) % COLS) * CELL + 1, (((current - 1) / COLS) | 0) * CELL + 1, CELL - 2, CELL - 2);
        }
        canvas.addEventListener("click", function (ev) {
          var rect = canvas.getBoundingClientRect();
          var x = ((ev.clientX - rect.left) / (rect.width / COLS)) | 0;
          var y = ((ev.clientY - rect.top) / (rect.height / rows)) | 0;
          var idx = y * COLS + x + 1;
          if (idx >= 1 && idx <= pal.length) { onPick(idx); overlay.remove(); }
        });
        var scroll = el("div", { "class": "uorail-hue-scroll" }); scroll.appendChild(canvas); box.appendChild(scroll);
      }
    });
    overlay.appendChild(box);
    (document.getElementById("uorail-panel") || document.body).appendChild(overlay);
    overlay.addEventListener("click", function (ev) { if (ev.target === overlay) overlay.remove(); });
    box.querySelector(".uorail-hue-close").addEventListener("click", function () { overlay.remove(); });
    box.querySelector(".uorail-hue-default").addEventListener("click", function () { onPick(0); overlay.remove(); });
  }

  function bindOptionControls(body) {
    var br = window.UORailBridge;
    var ctrls = body.querySelectorAll("[data-k]");
    var swatches = body.querySelectorAll("[data-huek]");
    if (br && br.getProfile) {
      Promise.resolve(br.getProfile()).then(function (prof) {
        if (!prof) return;
        ctrls.forEach(function (el) {
          var k = el.getAttribute("data-k");
          if (!(k in prof)) return;
          if (el.type === "checkbox") { el.checked = !!prof[k]; return; }
          if (el.tagName === "SELECT") {
            // A <select> value with no matching <option> leaves the dropdown blank.
            // SpriteSmoothingMode ships as -1 ("legacy/auto") on fresh profiles, so
            // resolve it from the sibling fields (mirror of the C# resolver); clamp
            // any other out-of-range enum into its option range.
            var n = parseInt(prof[k], 10);
            if (k === "SpriteSmoothingMode" && (isNaN(n) || n < 0)) n = resolveSmoothingMode(prof);
            var maxI = el.options.length - 1;
            if (isNaN(n)) n = 0;
            el.value = String(n < 0 ? 0 : (n > maxI ? maxI : n));
            return;
          }
          el.value = String(prof[k]);
        });
        if (swatches.length) huePaletteCached().then(function () {
          swatches.forEach(function (el) {
            var k = el.getAttribute("data-huek");
            var idx = (k in prof) ? (prof[k] | 0) : 0;
            el.setAttribute("data-hue", idx);
            paintSwatch(el, idx);
          });
        });
      }).catch(function () {});
    }
    ctrls.forEach(function (el) {
      var k = el.getAttribute("data-k");
      var ev = (el.type === "range") ? "input" : "change";
      el.addEventListener(ev, function () {
        var val = (el.type === "checkbox") ? (el.checked ? "true" : "false") : el.value;
        if (br && br.setSetting) br.setSetting(k, val);
      });
    });
    swatches.forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        var k = el.getAttribute("data-huek");
        openHuePicker(el.getAttribute("data-hue") | 0, function (idx) {
          el.setAttribute("data-hue", idx);
          paintSwatch(el, idx);
          if (br && br.setSetting) br.setSetting(k, String(idx));
        });
      });
    });
  }

  function renderOptItems(items) {
    // Checkboxes pack into one .uorail-radios row; sliders/selects are block-level.
    var html = "", checks = [];
    function flush() { if (checks.length) { html += radiosH.apply(null, checks); checks = []; } }
    items.forEach(function (it) {
      if (it[0] === "c") { checks.push(checkB(it[1], it[2])); }
      else if (it[0] === "r") { flush(); html += rangeB(it[1], it[2], it[3], it[4]); }
      // A select with an empty option list is dropped (an empty <select> looks
      // broken). That safety net silently HID two options whose lists were never
      // filled in the hand-port (Grid_BorderStyle, JournalStyle) — so warn in dev
      // mode when it fires, to surface any future incomplete select.
      else if (it[0] === "s") {
        if (it[3] && it[3].length) { flush(); html += selectB(it[1], it[2], it[3]); }
        else { try { console.warn("[rail] option '" + it[1] + "' (" + it[2] + ") has an empty option list — not rendered"); } catch (_) {} }
      }
      else if (it[0] === "h") { flush(); html += hueB(it[1], it[2]); }
      else if (it[0] === "t") { flush(); html += textB(it[1], it[2], it[3]); }
    });
    flush();
    return html;
  }

  // Friends/Enemy list block (official Agents → Lists). CUO has an Ignore list,
  // not Razor-style friend/enemy lists — so this is the faithful structure; the
  // backing list is the functional layer (per-client difference noted).
  // Razor-style agent list: a [+][edit][−] toolbar + a scrollable list of named
  // agents. The official Restock/Dress tabs are built on this (an agent manager,
  // not a settings form). Reusable across those tabs.

  // Manual screen recording via the browser MediaRecorder on the game canvas
  // (the official's Recording agent). Real + self-contained; falls back with a
  // note if the canvas can't be captured (OffscreenCanvas-transferred mode).
  /* The three controls above the button are READ, not decoration.
     They were drawn to mirror the official client's panel and nothing consulted them: the recorder
     asked for captureStream(30) and passed no bitrate, so a player could set 60 fps and 50 Mbps and
     get neither. A control that moves and changes nothing is exactly what the Filters tab refuses to
     be, and all three map onto APIs the browser already provides. */
  function wireRecording(body) {
    var btn = body.querySelector(".uorail-rec-btn"), status = body.querySelector(".uorail-rec-status");
    if (!btn) return;
    /* Real class names, read from rangeH/selectH rather than guessed: the first draft of this
       looked for .uorail-field-label, which does not exist, and would have silently updated
       nothing. */
    var ranges = body.querySelectorAll("input.uorail-range");
    var srcSel = body.querySelector("select.uorail-select");
    var fpsEl = ranges[0] || null, bpsEl = ranges[1] || null;
    var rec = null, chunks = [], live = null;

    /* The size estimate is in the slider's own label, so it has to follow the slider. Left static it
       reads as a fact about the clip you are about to record, and it would be wrong. */
    function estimate() {
      if (!bpsEl) return;
      var lbl = bpsEl.closest(".uorail-field") || bpsEl.parentElement;
      var el = lbl && lbl.querySelector(".uorail-field-lbl");
      var mb = Math.round((+bpsEl.value || 9) * 30 / 8 * 10) / 10;   // Mbit/s -> MB per 30 s
      if (el) el.textContent = "Bitrate (Mbps) ~ " + mb + " MB / 30s clip";
    }
    if (bpsEl) { bpsEl.addEventListener("input", estimate); estimate(); }

    function stopTracks() {
      try { if (live) live.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      live = null;
    }

    /* "Full Tab" is a different capture source, not a different quality: getDisplayMedia records
       what the tab shows, gump layers and all, at the cost of the browser's own picker dialog.
       "Game Window" stays on the canvas, which is what the note under the dropdown describes. */
    function getStream(fps) {
      var wantTab = !!(srcSel && /full tab/i.test(srcSel.value || ""));
      if (wantTab) {
        if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
          return Promise.reject(new Error("This browser cannot record the whole tab."));
        }
        return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false });
      }
      var canvas = document.getElementById("canvas");
      if (!canvas || !canvas.captureStream) {
        return Promise.reject(new Error("Canvas capture isn’t available in this render mode."));
      }
      return Promise.resolve(canvas.captureStream(fps));
    }

    btn.addEventListener("click", function () {
      if (rec && rec.state === "recording") { rec.stop(); return; }
      var fps = Math.max(1, +(fpsEl && fpsEl.value) || 30);
      var mbps = Math.max(1, +(bpsEl && bpsEl.value) || 9);
      status.textContent = "Starting…";
      getStream(fps).then(function (stream) {
        live = stream;
        chunks = [];
        rec = new MediaRecorder(stream, { mimeType: "video/webm", videoBitsPerSecond: mbps * 1000000 });
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          stopTracks();
          var blob = new Blob(chunks, { type: "video/webm" });
          var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "uo-clip-" + Date.now() + ".webm"; a.click();
          btn.textContent = "● Start manual recording";
          status.textContent = "Saved clip (" + Math.round(blob.size / 1024) + " KB).";
        };
        /* Stopping the share from the browser's own bar ends the track, not the recorder — without
           this the button still says "Stop recording" over a stream that is already dead. */
        try {
          var vt = stream.getVideoTracks()[0];
          if (vt) vt.addEventListener("ended", function () { if (rec && rec.state === "recording") rec.stop(); });
        } catch (e) {}
        rec.start();
        btn.textContent = "■ Stop recording";
        status.textContent = "Recording… " + fps + " fps, " + mbps + " Mbps";
      }).catch(function (e) {
        stopTracks();
        status.textContent = (e && e.name === "NotAllowedError")
          ? "Recording cancelled." : ("Recording failed: " + ((e && e.message) || e));
      });
    });
  }

  function renderAgents(tab, body) {
    var bound = false, h;
    if (tab === "Loot") {
      // Real: the official Loot tab IS the client's corpse/grid-loot settings.
      bound = true;
      // Official shows "Modern Loot Gump" as a checkbox (we keep the underlying
      // 3-way GridLootType: checked => Both(2), unchecked => None(0)). Custom-wired
      // (NOT renderOptItems "c", which would send true/false to an int enum).
      h = subH("Corpse Options") +
        '<div class="uorail-radios"><label class="uorail-radio uorail-check"><input type="checkbox" id="uorail-mlg" data-pointer="auto"><span class="uorail-radio-box"></span><span class="uorail-radio-txt">Modern Loot Gump</span></label></div>' +
        renderOptItems([
        ["c", "AutoOpenCorpses", "Auto open corpses"], ["c", "SkipEmptyCorpse", "Skip empty corpses"],
        ["r", "AutoOpenCorpseRange", "Corpse open range", 0, 18],
        ["s", "CorpseOpenOptions", "Corpse open options", ["None", "Not Targeting", "Not Hiding", "Both"]],
      ]) + subH("Autoloot Items") +
        '<div class="uorail-radios"><label class="uorail-radio uorail-check"><input type="checkbox" id="uorail-autoloot-on" data-pointer="auto"><span class="uorail-radio-box"></span><span class="uorail-radio-txt">Loot corpses automatically</span></label></div>' +
        '<div class="uorail-note">Walk within a few tiles of a corpse and the items below are moved to your backpack. Only the types listed here are taken. On most shards, looting a corpse you did not kill can flag you as a criminal, and the client cannot tell whose kill it was — leave this off in crowded places.</div>' +
        '<div class="uorail-loot-row"><button class="uorail-icon-btn" data-pointer="auto" data-tip="Add item">+</button>' +
        '<span class="uorail-loot-slot uorail-loot-pack" data-tip="Autoloot backpack">' + svg(I.backpack) + '</span>' +
        '<button class="uorail-icon-btn" data-pointer="auto" data-tip="Refresh">⟳</button></div>';
    } else if (tab === "Restock") {
      // REAL: keep N of each item type in the backpack, pulling from a chosen
      // source container. Uses the bridge target + container + move primitives.
      h = infoBox("Restock", "Keep your backpack topped up. Pick a source container, add the item types and how many to maintain, then Run — matching items are pulled from the source into your backpack.") +
        subH("Source container") +
        '<div class="uorail-loot-row"><button class="uorail-btn-pill" data-act="rs-source" data-pointer="auto">Set source container</button>' +
          '<span class="uorail-rs-srclbl uorail-note"></span></div>' +
        subH("Keep stocked") +
        '<div class="uorail-loot-row"><button class="uorail-icon-btn" data-act="rs-add" data-pointer="auto" data-tip="Add item">+</button>' +
          '<span class="uorail-note">Target an item, then enter the amount to maintain.</span></div>' +
        '<div class="uorail-al-list" data-rs-list></div>' +
        '<div class="uorail-hk-add"><button class="uorail-btn-pill" data-act="rs-run" data-pointer="auto">Run restock now</button></div>' +
        '<div class="uorail-note uorail-rs-status"></div>';
    } else if (tab === "Dress") {
      // Official: agent list (left) + a settings column (right). Real actions
      // (wired by wireDressAgent): read your worn outfit, then Equip / Unequip
      // it — the action buttons enable once an outfit has been saved.
      h = '<div class="uorail-ag2col">' +
        '<div class="uorail-aglb">' +
          '<div class="uorail-aglb-bar">' +
            '<button class="uorail-icon-btn uorail-icon-danger uorail-dress-forget" type="button" data-pointer="auto" data-tip="Forget saved outfit">−</button>' +
          "</div>" +
          '<div class="uorail-aglb-list" data-dress-list></div>' +
        "</div>" +
        '<div class="uorail-ag2col-side">' +
          '<button class="uorail-btn-pill" data-pointer="auto">Read equipped items</button>' +
          '<button class="uorail-btn-pill" data-pointer="auto" disabled>Equip gear</button>' +
          '<button class="uorail-btn-pill" data-pointer="auto" disabled>Unequip gear</button>' +
        "</div>" +
      "</div>";
    } else if (tab === "Lists") {
      // REAL: Friends (TazUO FriendsListManager — TUO only) + Enemies (the
      // IgnoreManager ignore list — both clients). Built by wireLists once the
      // friends capability is known. Add by targeting a creature/player.
      h = infoBox("Friends & Enemies", "Add a player to your Friends or Enemies (ignore) list by targeting them. Friends are a TazUO feature; the Enemies/ignore list works on both clients.") +
        '<div class="uorail-lists" data-lists><div class="uorail-note" style="padding:8px 4px">Loading…</div></div>';
    } else if (tab === "Chat") {
      // REAL: the native UO Chat (conference) system, driven over the game
      // socket (World.ChatManager state + 0xB3/0xB5 join/leave/send packets).
      // wireChat reflects the server's real chat status: when the shard hasn't
      // enabled chat it says so honestly; when enabled you can join/leave
      // channels and send messages (messages appear in the in-game journal).
      h = infoBox("UO Chat", "The classic UO Chat (conference) system. Join a channel and chat with everyone online; messages appear in your in-game journal. Availability depends on the server.") +
        '<div class="uorail-chat" data-chat><div class="uorail-note" style="padding:8px 4px">Loading…</div></div>';
    } else if (tab === "Filters") {
      // REAL on TazUO: block specific sound effects. The bridge reads the live
      // "recently played sounds" feed (Audio.LastPlayedSounds) and the persisted
      // SoundFilterManager list. CUO has neither → wireFilters shows an honest
      // "TazUO-only" note (gated on br.filtersHasEngine()).
      h = infoBox("Sound Filters", "Silence specific sound effects. Pick from the sounds you have recently heard to add them to the filter; filtered sounds stay muted across sessions.") +
        '<div class="uorail-filters" data-filters><div class="uorail-note" style="padding:8px 4px">Loading…</div></div>';
    } else if (tab === "Recording") {
      // Official: info box + "Recording Source" dropdown + FPS/Bitrate sliders.
      // (Manual Recording is our own working MediaRecorder feature, kept below.)
      h = infoBox("Recording", "Capture video for sharing, may consume CPU and slow down your game. Two recording sources are available; pick one per the trade-offs below.") +
        selectH("Recording Source", ["Source: Game Window", "Source: Full Tab"], "Source: Game Window") +
        '<div class="uorail-note">Captures only the game window. Mouse cursor and Assistant UI elements are not captured.</div>' +
        rangeH("Capture FPS", 12, 60, 30) +
        rangeH("Bitrate (Mbps) ~ 9.4 MB / 30s clip", 3, 100, 9) +
        subH("Manual Recording") +
        '<div class="uorail-hk-add"><button class="uorail-btn-pill uorail-rec-btn" data-pointer="auto">● Start manual recording</button></div>' +
        '<div class="uorail-note uorail-rec-status"></div>';
    } else if (tab === "Durability") {
      // REAL: live durability of worn gear, read from each item's tooltip (OPL)
      // via the bridge. Warning/Danger sliders recolor the bars (persisted).
      h = infoBox("Equipment Durability Tracker", "Live durability of your worn gear, read from item tooltips. Bars turn amber, then red, as items wear down.") +
        subH("Thresholds") +
        '<div class="uorail-field"><div class="uorail-field-lbl">Warning at <span class="uorail-dura-warnv"></span></div>' +
          '<input type="range" class="uorail-range" data-act="dura-warn" min="0" max="100" data-pointer="auto"></div>' +
        '<div class="uorail-field"><div class="uorail-field-lbl">Danger at <span class="uorail-dura-dangerv"></span></div>' +
          '<input type="range" class="uorail-range" data-act="dura-danger" min="0" max="100" data-pointer="auto"></div>' +
        subH("Worn items") +
        '<div class="uorail-dura-list"><div class="uorail-note" style="padding:8px 4px">Loading…</div></div>' +
        '<div class="uorail-hk-add"><button class="uorail-btn-pill" data-act="dura-refresh" data-pointer="auto">⟳ Refresh</button></div>';
    } else { h = subH(tab); }
    body.innerHTML = '<div class="uorail-form">' + h + "</div>";
    if (bound) bindOptionControls(body);
    if (tab === "Recording") wireRecording(body);
    if (tab === "Loot") { wireModernLootGump(body); wireAutoloot(body); }
    if (tab === "Dress") wireDressAgent(body);
    if (tab === "Durability") wireDurability(body);
    if (tab === "Restock") wireRestock(body);
    if (tab === "Lists") wireLists(body);
    if (tab === "Filters") wireFilters(body);
    if (tab === "Chat") wireChat(body);
  }

  // Chat agent (REAL) — native UO conference chat over the game socket. Reads
  // World.ChatManager state via the bridge and sends standard chat packets. The
  // panel honestly reflects the server's chat status (0 disabled / 1 enabled /
  // 2 needs-name). Received messages surface in the in-game journal, not here.
  function wireChat(body) {
    var br = window.UORailBridge;
    var root = body.querySelector("[data-chat]");
    if (!root) return;
    if (!br || !br.getChatState) { root.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Chat is available in-world.</div>'; return; }
    function note(t) { return '<div class="uorail-note" style="padding:6px 2px">' + t + "</div>"; }
    function render() {
      Promise.resolve(br.getChatState()).then(function (st) {
        st = st || { status: 0, current: "", channels: [] };
        root.innerHTML = "";
        if (st.status === 0) {
          root.innerHTML = note('This server has <strong>not enabled</strong> the UO Chat (conference) system, so there is nothing to join here. Your shard may use its own chat instead.');
          return;
        }
        if (st.status === 2) {
          // Server wants a chat name before enabling chat.
          var nameWrap = el("div", { "class": "uorail-chat-join" });
          nameWrap.appendChild(el("div", { "class": "uorail-sub" }, "Choose your chat name"));
          var nIn = el("input", { "class": "uorail-input", type: "text", maxlength: "29", placeholder: "Chat name", "data-pointer": "auto" });
          var nBtn = el("button", { "class": "uorail-btn-pill", "data-pointer": "auto" }, "Set name");
          nBtn.addEventListener("click", function () {
            var v = (nIn.value || "").trim();
            if (!v) { toast("Enter a chat name"); return; }
            Promise.resolve(br.chatRegisterName(v)).then(function (ok) { toast(ok ? "Chat name set" : "Could not set name"); setTimeout(render, 600); });
          });
          nameWrap.appendChild(nIn);
          nameWrap.appendChild(el("div", { "class": "uorail-hk-add" })).appendChild(nBtn);
          root.appendChild(nameWrap);
          root.appendChild(el("div", { "class": "uorail-note", style: "padding:6px 2px" }, "This server asks for a chat name before joining channels."));
          return;
        }
        // status === 1 : chat ready.
        // Current channel + leave.
        var cur = el("div", { "class": "uorail-chat-cur" });
        if (st.current) {
          cur.appendChild(el("span", { "class": "uorail-chat-curname" }, "In channel: " + esc(st.current)));
          var leave = el("button", { "class": "uorail-icon-btn uorail-icon-sm", "data-pointer": "auto", "data-tip": "Leave channel" }, "Leave");
          leave.addEventListener("click", function () {
            Promise.resolve(br.chatLeave()).then(function () { toast("Left channel"); setTimeout(render, 500); });
          });
          cur.appendChild(leave);
        } else {
          cur.appendChild(el("span", { "class": "uorail-chat-curname" }, "Not in a channel"));
        }
        root.appendChild(cur);
        // Channel list.
        root.appendChild(el("div", { "class": "uorail-sub" }, "Channels"));
        var list = el("div", { "class": "uorail-al-list" });
        var chans = st.channels || [];
        if (!chans.length) {
          list.innerHTML = note("No channels advertised. Create one below or join by name.");
        } else {
          chans.forEach(function (c) {
            var row = el("div", { "class": "uorail-al-item" });
            row.appendChild(el("span", { "class": "uorail-al-name" }, esc(c.name) + (c.pw ? " 🔒" : "")));
            var join = el("button", { "class": "uorail-icon-btn uorail-icon-sm", "data-pointer": "auto", "data-tip": "Join" }, "Join");
            join.addEventListener("click", function () {
              var doJoin = function (pw) {
                Promise.resolve(br.chatJoin(c.name, pw)).then(function (ok) { toast(ok ? ("Joining " + c.name) : "Could not join"); setTimeout(render, 700); });
              };
              if (c.pw) {
                uiPrompt("Password for " + c.name + ":", "", { password: true }).then(function (pw) { if (pw) doJoin(pw); });
              } else { doJoin(""); }
            });
            row.appendChild(join);
            list.appendChild(row);
          });
        }
        root.appendChild(list);
        var refresh = el("button", { "class": "uorail-btn-pill", "data-pointer": "auto" }, "⟳ Refresh");
        refresh.addEventListener("click", render);
        root.appendChild(el("div", { "class": "uorail-hk-add" })).appendChild(refresh);
        // Join by name.
        root.appendChild(el("div", { "class": "uorail-sub" }, "Join by name"));
        var jWrap = el("div", { "class": "uorail-chat-join" });
        var jName = el("input", { "class": "uorail-input", type: "text", maxlength: "29", placeholder: "Channel name", "data-pointer": "auto" });
        var jPw = el("input", { "class": "uorail-input", type: "password", maxlength: "29", placeholder: "Password (optional)", "data-pointer": "auto" });
        var jBtn = el("button", { "class": "uorail-btn-pill", "data-pointer": "auto" }, "Join channel");
        jBtn.addEventListener("click", function () {
          var v = (jName.value || "").trim();
          if (!v) { toast("Enter a channel name"); return; }
          Promise.resolve(br.chatJoin(v, jPw.value || "")).then(function (ok) { toast(ok ? ("Joining " + v) : "Could not join"); setTimeout(render, 700); });
        });
        jWrap.appendChild(jName);
        jWrap.appendChild(jPw);
        jWrap.appendChild(el("div", { "class": "uorail-hk-add" })).appendChild(jBtn);
        root.appendChild(jWrap);
        // Send a message (only meaningful while in a channel).
        if (st.current) {
          root.appendChild(el("div", { "class": "uorail-sub" }, "Send to " + esc(st.current)));
          var sWrap = el("div", { "class": "uorail-chat-send" });
          var sIn = el("input", { "class": "uorail-input", type: "text", maxlength: "200", placeholder: "Message…", "data-pointer": "auto" });
          var sBtn = el("button", { "class": "uorail-btn-pill", "data-pointer": "auto" }, "Send");
          var doSend = function () {
            var v = (sIn.value || "").trim();
            if (!v) return;
            Promise.resolve(br.chatSend(v)).then(function (ok) { if (ok) { sIn.value = ""; } else { toast("Could not send"); } });
          };
          sBtn.addEventListener("click", doSend);
          sIn.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); doSend(); } });
          sWrap.appendChild(sIn);
          sWrap.appendChild(el("div", { "class": "uorail-hk-add" })).appendChild(sBtn);
          root.appendChild(sWrap);
          root.appendChild(el("div", { "class": "uorail-note", style: "padding:6px 2px" }, "Replies appear in your in-game chat/journal."));
        }
      }).catch(function () { root.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Chat is available in-world.</div>'; });
    }
    render();
  }

  // Filters agent (REAL on TazUO) — block specific sound effects. Two columns:
  // "Recently heard" (from Audio.LastPlayedSounds, click to block) + "Filtered"
  // (from SoundFilterManager, click to unblock). CUO lacks both managers, so the
  // capability flag (filtersHasEngine) downgrades to an honest TazUO-only note.
  function wireFilters(body) {
    var br = window.UORailBridge;
    var root = body.querySelector("[data-filters]");
    if (!root) return;
    if (!br || !br.filtersHasEngine) { root.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Sound filters are available in-world.</div>'; return; }
    // Recently-heard sounds carry a name; the filtered set is bare IDs (the
    // SoundFilterManager only stores ints). Cache names seen in the recent feed
    // so the filtered column can show them too, falling back to "Sound #id".
    var nameById = {};
    function labelFor(id) {
      var sid = id >>> 0;
      var name = nameById[sid];
      return name ? (name + "  (#" + sid + ")") : ("Sound #" + sid);
    }
    function rowFor(label, btnLabel, btnTitle, onClick) {
      var row = el("div", { "class": "uorail-al-item" });
      row.appendChild(el("span", { "class": "uorail-al-name" }, esc(label)));
      var btn = el("button", { "class": "uorail-icon-btn uorail-icon-sm", "data-pointer": "auto", title: btnTitle }, btnLabel);
      btn.addEventListener("click", onClick);
      row.appendChild(btn);
      return row;
    }
    Promise.resolve(br.filtersHasEngine()).then(function (has) {
      if (!has) {
        root.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Sound filtering is a <strong>TazUO</strong> feature — open this on the TazUO client (<code>/tuo/</code>) to mute specific sound effects.</div>';
        return;
      }
      root.innerHTML = "";
      var wrap = el("div", { "class": "uorail-ag2col" });
      root.appendChild(wrap);
      var recent = el("div", { "class": "uorail-list-col" });
      recent.appendChild(el("div", { "class": "uorail-sub" }, "Recently heard"));
      var recentList = el("div", { "class": "uorail-al-list" });
      recent.appendChild(recentList);
      var refreshBtn = el("button", { "class": "uorail-btn-pill", "data-pointer": "auto" }, "⟳ Refresh");
      recent.appendChild(el("div", { "class": "uorail-hk-add" })).appendChild(refreshBtn);
      var filtered = el("div", { "class": "uorail-list-col" });
      filtered.appendChild(el("div", { "class": "uorail-sub" }, "Filtered (muted)"));
      var filteredList = el("div", { "class": "uorail-al-list" });
      filtered.appendChild(filteredList);
      wrap.appendChild(recent);
      wrap.appendChild(filtered);
      function refreshFiltered() {
        Promise.resolve(br.getSoundFilters()).then(function (list) {
          filteredList.innerHTML = "";
          if (!list || !list.length) { filteredList.innerHTML = '<div class="uorail-note" style="padding:6px 2px">No sounds muted.</div>'; return; }
          list.forEach(function (id) {
            var sid = id >>> 0;
            filteredList.appendChild(rowFor(labelFor(sid), "×", "Unmute", function () {
              Promise.resolve(br.removeSoundFilter(sid)).then(function () { refreshFiltered(); refreshRecent(); });
            }));
          });
        }).catch(function () {});
      }
      function refreshRecent() {
        Promise.resolve(br.getRecentSounds()).then(function (list) {
          Promise.resolve(br.getSoundFilters()).then(function (muted) {
            var mutedIds = {};
            (muted || []).forEach(function (id) { mutedIds[id >>> 0] = true; });
            recentList.innerHTML = "";
            if (!list || !list.length) { recentList.innerHTML = '<div class="uorail-note" style="padding:6px 2px">No sounds heard yet — they appear here as they play.</div>'; return; }
            list.forEach(function (s) {
              var sid = (s && s.id != null) ? (s.id >>> 0) : 0;
              if (s && s.name) nameById[sid] = String(s.name);   // remember for the filtered column
              if (mutedIds[sid]) return;   // already muted → it's in the other column
              recentList.appendChild(rowFor(labelFor(sid), "🔇", "Mute this sound", function () {
                Promise.resolve(br.addSoundFilter(sid)).then(function () { refreshFiltered(); refreshRecent(); });
              }));
            });
            if (!recentList.children.length) recentList.innerHTML = '<div class="uorail-note" style="padding:6px 2px">All recent sounds are already muted.</div>';
          });
        }).catch(function () {});
      }
      refreshBtn.addEventListener("click", function () { refreshRecent(); refreshFiltered(); });
      refreshFiltered();
      refreshRecent();
    }).catch(function () { root.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Sound filters are available in-world.</div>'; });
  }

  // Lists agent (REAL) — Friends (TazUO FriendsListManager, TUO only) + Enemies
  // (IgnoreManager, both clients). Entries come straight from the bridge; add by
  // targeting a creature/player. No local persistence — the managers own it.
  function wireLists(body) {
    var br = window.UORailBridge;
    var root = body.querySelector("[data-lists]");
    if (!root) return;
    if (!br || !br.getIgnored) { root.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Lists are available in-world.</div>'; return; }
    function makeCol(title, addLabel) {
      var col = el("div", { "class": "uorail-list-col" });
      col.appendChild(el("div", { "class": "uorail-sub" }, esc(title)));
      var listEl = el("div", { "class": "uorail-al-list" });
      var addBtn = el("button", { "class": "uorail-btn-pill", "data-pointer": "auto" }, addLabel);
      col.appendChild(listEl);
      col.appendChild(el("div", { "class": "uorail-hk-add" })).appendChild(addBtn);
      return { col: col, listEl: listEl, addBtn: addBtn };
    }
    function rowFor(label, onRemove) {
      var row = el("div", { "class": "uorail-al-item" });
      row.appendChild(el("span", { "class": "uorail-al-name" }, esc(label)));
      var del = el("button", { "class": "uorail-icon-btn uorail-icon-sm", "data-pointer": "auto", "data-tip": "Remove" }, "×");
      del.addEventListener("click", onRemove);
      row.appendChild(del);
      return row;
    }
    function targetMobile(then) {
      toast("Target a creature or player…");
      railAwaitTarget(function (res) {
        if (!res) return;
        if (res.kind !== "mobile") { toast("Target a creature or player, not an item"); return; }
        then(res);
      });
    }
    Promise.resolve(br.listsHasFriends()).then(function (hasFriends) {
      root.innerHTML = "";
      var wrap = el("div", { "class": "uorail-ag2col" });
      root.appendChild(wrap);
      // Enemies (ignore) — both clients
      var en = makeCol("Enemies (ignored)", "+ Add enemy");
      function refreshEnemies() {
        Promise.resolve(br.getIgnored()).then(function (list) {
          en.listEl.innerHTML = "";
          if (!list || !list.length) { en.listEl.innerHTML = '<div class="uorail-note" style="padding:6px 2px">No ignored players.</div>'; return; }
          list.forEach(function (e) {
            en.listEl.appendChild(rowFor(e.name, function () {
              Promise.resolve(br.removeIgnore(e.name)).then(function () { refreshEnemies(); });
            }));
          });
        }).catch(function () {});
      }
      en.addBtn.addEventListener("click", function () {
        targetMobile(function (res) {
          Promise.resolve(br.addIgnore(res.serial)).then(function (ok) {
            toast(ok ? ("Ignored " + (res.name || "target")) : "Already ignored / not a player");
            refreshEnemies();
          });
        });
      });
      // Friends — TazUO only
      if (hasFriends) {
        var fr = makeCol("Friends", "+ Add friend");
        wrap.appendChild(fr.col);
        var refreshFriends = function () {
          Promise.resolve(br.getFriends()).then(function (list) {
            fr.listEl.innerHTML = "";
            if (!list || !list.length) { fr.listEl.innerHTML = '<div class="uorail-note" style="padding:6px 2px">No friends yet.</div>'; return; }
            list.forEach(function (e) {
              fr.listEl.appendChild(rowFor(e.name, function () {
                Promise.resolve(br.removeFriend(e.serial)).then(function () { refreshFriends(); });
              }));
            });
          }).catch(function () {});
        };
        fr.addBtn.addEventListener("click", function () {
          targetMobile(function (res) {
            Promise.resolve(br.addFriend(res.serial)).then(function (ok) {
              toast(ok ? ("Added " + (res.name || "friend")) : "Already a friend / not a player");
              refreshFriends();
            });
          });
        });
        refreshFriends();
      }
      wrap.appendChild(en.col);
      refreshEnemies();
    }).catch(function () { root.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Lists are available in-world.</div>'; });
  }

  // Poll the bridge target picker once armed; calls onPick(res) with the picked
  // entity ({serial,graphic,hue,name}) or onPick(null) on cancel/timeout.
  function railAwaitTarget(onPick) {
    var br = window.UORailBridge;
    if (!br || !br.requestTarget) { toast("Targeting is available in-world"); onPick(null); return; }
    Promise.resolve(br.requestTarget()).then(function (ok) {
      if (!ok) { toast("Targeting unavailable (in-world only)"); onPick(null); return; }
      var tries = 0;
      (function step() {
        if (++tries > 75) { onPick(null); return; }   // ~30s timeout
        Promise.resolve(br.pollTarget()).then(function (res) {
          if (res && res.graphic) { onPick(res); return; }
          if (res && res.cancelled) { onPick(null); return; }
          setTimeout(step, 400);
        }).catch(function () { onPick(null); });
      })();
    });
  }

  // Restock agent (REAL) — maintain item counts in the backpack by moving
  // matching items from a chosen source container. Persists to railAgents.
  function wireRestock(body) {
    var br = window.UORailBridge;
    var ag = loadAgents(); ag.restock = ag.restock || { source: 0, rules: [] };
    var srcLbl = body.querySelector(".uorail-rs-srclbl");
    var listEl = body.querySelector("[data-rs-list]");
    var statusEl = body.querySelector(".uorail-rs-status");
    function status(t) { if (statusEl) statusEl.textContent = t || ""; }
    function showSrc() { if (srcLbl) srcLbl.textContent = ag.restock.source ? ("Source: 0x" + (ag.restock.source >>> 0).toString(16)) : "No source set"; }
    function renderRules() {
      var t = ag.restock.rules || [];
      if (!t.length) { listEl.innerHTML = '<div class="uorail-note" style="padding:6px 2px">No items yet — click + and target an item to keep stocked.</div>'; return; }
      listEl.innerHTML = "";
      t.forEach(function (e, i) {
        var row = el("div", { "class": "uorail-al-item" });
        var art = el("span", { "class": "uorail-al-art" }); drawItemArt(art, e.graphic, e.hue);
        var nm = el("span", { "class": "uorail-al-name" }, esc(e.name || ("0x" + (e.graphic || 0).toString(16))) + "  ×" + e.amount);
        var del = el("button", { "class": "uorail-icon-btn uorail-icon-sm", "data-pointer": "auto", "data-tip": "Remove" }, "×");
        del.addEventListener("click", function () { ag.restock.rules.splice(i, 1); saveAgents(ag); renderRules(); });
        row.appendChild(art); row.appendChild(nm); row.appendChild(del); listEl.appendChild(row);
      });
    }
    showSrc(); renderRules();
    var srcBtn = body.querySelector('[data-act="rs-source"]');
    if (srcBtn) srcBtn.addEventListener("click", function () {
      toast("Target the source container…");
      railAwaitTarget(function (res) {
        if (!res) return;
        if (res.kind === "mobile") { toast("Target a container, not a creature"); return; }
        ag.restock.source = res.serial >>> 0; saveAgents(ag); showSrc();
        toast("Source set");
      });
    });
    var addBtn = body.querySelector('[data-act="rs-add"]');
    if (addBtn) addBtn.addEventListener("click", function () {
      toast("Target an item to keep stocked…");
      railAwaitTarget(function (res) {
        if (!res) return;
        if (res.kind === "mobile") { toast("Target an item, not a creature"); return; }
        uiPrompt("Keep how many " + (res.name || "of this item") + "?", "100").then(function (raw) {
          var amt = parseInt(raw, 10);
          if (!amt || amt < 1) return;
          ag.restock.rules.push({ graphic: res.graphic, hue: res.hue, name: res.name, amount: amt });
          saveAgents(ag); renderRules(); toast("Added");
        });
      });
    });
    var runBtn = body.querySelector('[data-act="rs-run"]');
    if (runBtn) runBtn.addEventListener("click", function () {
      if (!br || !br.getContainerItems || !br.moveItem || !br.getBackpackSerial) { toast("Restock is available in-world"); return; }
      if (!ag.restock.source) { toast("Set a source container first"); return; }
      if (!(ag.restock.rules || []).length) { toast("Add at least one item"); return; }
      runBtn.disabled = true; status("Restocking…");
      Promise.all([br.getBackpackSerial(), br.getContainerItems(0), br.getContainerItems(ag.restock.source)])
        .then(function (r) {
          var bpSerial = r[0], bp = r[1] || [], src = r[2] || [];
          var sum = function (acc, it) { return acc + (it.amount || 1); };
          var moved = 0, chain = Promise.resolve();
          (ag.restock.rules || []).forEach(function (rule) {
            var have = bp.filter(function (it) { return it.graphic === rule.graphic; }).reduce(sum, 0);
            var deficit = rule.amount - have;
            if (deficit <= 0) return;
            src.filter(function (it) { return it.graphic === rule.graphic; }).forEach(function (item) {
              if (deficit <= 0) return;
              var take = Math.min(deficit, item.amount || 1); deficit -= take;
              chain = chain.then(function () { return br.moveItem(item.serial, bpSerial, take); })
                .then(function (ok) { if (ok) moved += take; }).catch(function () {});
            });
          });
          return chain.then(function () { status(moved > 0 ? ("Restocked " + moved + " item(s)") : "Nothing to restock — already stocked or source empty"); });
        })
        .catch(function () { status("Restock failed"); })
        .then(function () { runBtn.disabled = false; });
    });
  }

  // Durability agent (REAL) — render worn gear with live durability bars read
  // from the bridge (GetEquipmentDurability → item OPL). Warning/Danger
  // thresholds recolor the bars and persist to the Discord account (railAgents).
  function wireDurability(body) {
    var br = window.UORailBridge;
    var ag = loadAgents(); ag.durability = ag.durability || { warn: 50, danger: 25 };
    var listEl = body.querySelector(".uorail-dura-list");
    var warnEl = body.querySelector('[data-act="dura-warn"]');
    var dangerEl = body.querySelector('[data-act="dura-danger"]');
    var warnV = body.querySelector(".uorail-dura-warnv");
    var dangerV = body.querySelector(".uorail-dura-dangerv");
    var refreshBtn = body.querySelector('[data-act="dura-refresh"]');
    function syncLabels() { if (warnV) warnV.textContent = ag.durability.warn + "%"; if (dangerV) dangerV.textContent = ag.durability.danger + "%"; }
    if (warnEl) warnEl.value = ag.durability.warn;
    if (dangerEl) dangerEl.value = ag.durability.danger;
    syncLabels();
    function colorFor(pct) {
      if (pct <= ag.durability.danger) return "var(--rail-danger, #d9534f)";
      if (pct <= ag.durability.warn) return "var(--rail-orange, #e6a44e)";
      return "var(--rail-ok, #5cb85c)";
    }
    function render(items) {
      if (!items || !items.length) { listEl.innerHTML = '<div class="uorail-note" style="padding:8px 4px">No worn items found — available in-world.</div>'; return; }
      var withDura = items.filter(function (e) { return e.max > 0; });
      if (!withDura.length) { listEl.innerHTML = '<div class="uorail-note" style="padding:8px 4px">No worn items report durability on this shard.</div>'; return; }
      listEl.innerHTML = "";
      withDura.sort(function (a, b) { return (a.cur / a.max) - (b.cur / b.max); });
      withDura.forEach(function (e) {
        var pct = Math.max(0, Math.min(100, Math.round((e.cur >= 0 ? e.cur : e.max) / e.max * 100)));
        var row = el("div", { "class": "uorail-dura-row" });
        var art = el("span", { "class": "uorail-al-art" });
        drawItemArt(art, e.graphic, e.hue);
        var mid = el("div", { "class": "uorail-dura-mid" });
        mid.appendChild(el("div", { "class": "uorail-dura-name" }, esc(e.name || ("0x" + (e.graphic || 0).toString(16)))));
        var bar = el("div", { "class": "uorail-dura-bar" });
        var fill = el("div", { "class": "uorail-dura-fill" });
        fill.style.width = pct + "%"; fill.style.background = colorFor(pct);
        bar.appendChild(fill); mid.appendChild(bar);
        var val = el("span", { "class": "uorail-dura-val" }, (e.cur >= 0 ? e.cur : "?") + " / " + e.max);
        row.appendChild(art); row.appendChild(mid); row.appendChild(val);
        listEl.appendChild(row);
      });
    }
    function reload() {
      if (!br || !br.getEquipmentDurability) { listEl.innerHTML = '<div class="uorail-note" style="padding:8px 4px">Durability is available in-world.</div>'; return; }
      Promise.resolve(br.getEquipmentDurability()).then(render).catch(function () { render([]); });
    }
    if (warnEl) warnEl.addEventListener("input", function () { ag.durability.warn = +warnEl.value; syncLabels(); saveAgents(ag); reload(); });
    if (dangerEl) dangerEl.addEventListener("input", function () { ag.durability.danger = +dangerEl.value; syncLabels(); saveAgents(ag); reload(); });
    if (refreshBtn) refreshBtn.addEventListener("click", reload);
    reload();
  }

  // ── Dress agent (REAL) — save the worn outfit + re-equip / unequip via the
  // C# bridge (GetEquippedItems / GetContainerItems / EquipItem / MoveItem).
  // The saved list is graphic+hue+layer (NOT serials), so it survives across
  // sessions: "Equip" finds matching items in the backpack and wears them.
  // Persisted to the Discord account via saveAgents → railAgents.
  function wireDressAgent(body) {
    var br = window.UORailBridge;
    var pills = body.querySelectorAll(".uorail-ag2col-side .uorail-btn-pill");
    var readBtn = pills[0], equipBtn = pills[1], unequipBtn = pills[2];
    var ag = loadAgents(); ag.dress = ag.dress || { items: [] };
    var listEl = body.querySelector("[data-dress-list]");
    var forgetBtn = body.querySelector(".uorail-dress-forget");
    function refresh() {
      var items = ag.dress.items || [], n = items.length;
      if (readBtn) readBtn.textContent = n ? ("Re-read equipped (" + n + " saved)") : "Read equipped items";
      if (equipBtn) equipBtn.disabled = !n;
      if (unequipBtn) unequipBtn.disabled = !n;
      if (forgetBtn) forgetBtn.disabled = !n;
      /* The saved outfit, listed. This area used to say "click + to create one" over a button that
         did nothing; showing what IS saved is both honest and the thing a player wants to see. */
      if (listEl) {
        listEl.textContent = "";
        if (!n) {
          var note = el("div", { "class": "uorail-note" },
            "No outfit saved yet — wear what you want and press Read equipped items.");
          listEl.appendChild(note);
        } else {
          items.forEach(function (it) {
            /* .uorail-al-item, the class the sibling lists already use and the stylesheet already
               carries. A new class name here would have rendered unstyled — and looked deliberate. */
            listEl.appendChild(el("div", { "class": "uorail-al-item" },
              String(it.name || ("Item 0x" + Number(it.graphic || 0).toString(16)))));
          });
        }
      }
    }
    refresh();
    if (forgetBtn) forgetBtn.addEventListener("click", function () {
      if (!(ag.dress.items || []).length) return;
      ag.dress.items = []; saveAgents(ag); refresh(); toast("Forgot the saved outfit");
    });
    if (readBtn) readBtn.addEventListener("click", function () {
      if (!br || !br.getEquippedItems) { toast("Dress is available in-world"); return; }
      Promise.resolve(br.getEquippedItems()).then(function (items) {
        ag.dress.items = (items || []).map(function (it) { return { graphic: it.graphic, hue: it.hue, layer: it.layer, name: it.name }; });
        saveAgents(ag); refresh(); toast("Saved outfit — " + ag.dress.items.length + " items");
      }).catch(function () { toast("Couldn't read equipped items"); });
    });
    if (equipBtn) equipBtn.addEventListener("click", function () {
      if (!br || !br.getContainerItems) { toast("Dress is available in-world"); return; }
      Promise.resolve(br.getContainerItems(0)).then(function (bp) {
        bp = bp || []; var queue = [];
        (ag.dress.items || []).forEach(function (s) {
          var m = bp.filter(function (b) { return b.graphic === s.graphic && (s.hue ? b.hue === s.hue : true); })[0];
          if (m) queue.push(m.serial);
        });
        if (!queue.length) { toast("No matching items in backpack"); return; }
        toast("Equipping " + queue.length + " items…");
        runSerialItemActions(queue, function (serial) { return br.equipItem(serial); });
      }).catch(function () { toast("Couldn't read backpack"); });
    });
    if (unequipBtn) unequipBtn.addEventListener("click", function () {
      if (!br || !br.getEquippedItems) { toast("Dress is available in-world"); return; }
      Promise.resolve(br.getEquippedItems()).then(function (items) {
        items = items || [];
        if (!items.length) { toast("Nothing to unequip"); return; }
        toast("Unequipping " + items.length + " items to backpack…");
        runSerialItemActions(items.map(function (it) { return it.serial; }), function (serial) { return br.moveItem(serial, 0, 0); });
      });
    });
  }

  // Item move/equip actions MUST run one at a time: each goes through PickUp,
  // which the client gates on ItemHold (only one item can be on the cursor at
  // once). Firing a batch concurrently makes all but the first PickUp no-op.
  // Serialize: do one, wait for the bridge call + a server round-trip, then the
  // next. ~650ms matches the desktop client's move-item cadence.
  function runSerialItemActions(serials, fn) {
    var i = 0;
    (function step() {
      if (i >= serials.length) return;
      var s = serials[i++];
      Promise.resolve(fn(s)).catch(function () {}).then(function () { setTimeout(step, 650); });
    })();
  }

  /* ── The corpse looter ───────────────────────────────────────────────────────────────────
     ONE loop for the whole session, not one per render: the Loot tab re-renders every time it is
     opened, and a loop started there would multiply silently and loot the same corpse N times.
     It reads the config on each tick, so toggling the checkbox takes effect without restarting it.

     Corpses are remembered once handled. Without that it would re-open the same corpse forever —
     the contents it wants are gone, so nothing would be taken and nothing would look wrong. */
  var _lootSeen = null;          // serials already handled this session, oldest first
  var _lootBusy = false;
  var _lootBusyAt = 0;           // when the pass started, so a stalled one can be reclaimed
  var _lootTimer = null;
  var CORPSE_GRAPHIC = 0x2006;
  var LOOT_SEEN_CAP = 400;       // a long session should not accumulate serials forever
  var LOOT_PASS_MS = 20000;      // a pass that takes longer than this has stalled, not finished

  /* 🚨 _lootBusy is cleared in every branch that RETURNS — but a bridge promise that never settles
     takes no branch, and .catch only fires on rejection. One stalled call and the looter is off for
     the rest of the session with the toggle still reading on. The deadline is what makes that
     recoverable instead of permanent. */
  function lootBusy() {
    if (!_lootBusy) return false;
    if (Date.now() - _lootBusyAt < LOOT_PASS_MS) return true;
    try { console.warn("[rail] autoloot pass stalled — reclaiming"); } catch (e) {}
    _lootBusy = false;
    return false;
  }
  function lootDone() { _lootBusy = false; }
  function lootStart() { _lootBusy = true; _lootBusyAt = Date.now(); }
  function lootRemember(serial) {
    if (!_lootSeen) _lootSeen = [];
    _lootSeen.push(serial);
    if (_lootSeen.length > LOOT_SEEN_CAP) _lootSeen.splice(0, _lootSeen.length - LOOT_SEEN_CAP);
  }
  function lootKnown(serial) { return !!_lootSeen && _lootSeen.indexOf(serial) >= 0; }

  function autolootWanted() {
    try {
      var ag = loadAgents();
      var a = ag && ag.autoloot;
      return (a && a.enabled && (a.types || []).length) ? a : null;
    } catch (e) { return null; }
  }

  function autolootMatches(types, it) {
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      /* Hue 0 in the saved type means "any hue of this graphic". A player who targets a plain
         stack of gold means gold, not gold-of-exactly-that-tint. */
      if (t.graphic === it.graphic && (!t.hue || t.hue === it.hue)) return true;
    }
    return false;
  }

  function autolootTick() {
    if (lootBusy()) return;
    var cfg = autolootWanted();
    if (!cfg) return;
    var br = window.UORailBridge;
    if (!br || !br.scanWorld || !br.getContainerItems || !br.grabItem || !br.useItem) return;
    lootStart();
    Promise.resolve(br.scanWorld(3, 2)).then(function (near) {
      var corpse = (near || []).filter(function (o) {
        return o && o.graphic === CORPSE_GRAPHIC && !lootKnown(o.serial);
      }).sort(function (a, b) { return (a.dist || 0) - (b.dist || 0); })[0];
      if (!corpse) { lootDone(); return; }
      lootRemember(corpse.serial);
      /* Opening it is what makes the server send the contents; the client cannot know them
         beforehand, so reading first would always come back empty. */
      return Promise.resolve(br.useItem(corpse.serial)).then(function () {
        return new Promise(function (r) { setTimeout(r, 900); });
      }).then(function () {
        return br.getContainerItems(corpse.serial);
      }).then(function (items) {
        var take = (items || []).filter(function (it) { return autolootMatches(cfg.types, it); });
        if (!take.length) { lootDone(); return; }
        toast("Looting " + take.length + " item" + (take.length === 1 ? "" : "s") + "…");
        var wanted = take.length, i = 0;
        (function step() {
          if (i >= take.length) { verify(corpse, cfg, wanted); return; }
          var it = take[i++];
          Promise.resolve(br.grabItem(it.serial, it.amount || 0, 0)).catch(function () {})
            .then(function () { setTimeout(step, 650); });
        })();
      });
    }).catch(function () { lootDone(); });
  }

  /* 🚨 THE ONLY HONEST SOURCE IS THE CORPSE. grabItem returns before the server has done anything,
     so out of range, a full backpack, or someone else emptying it first all leave the player having
     been told "Looting 3 items…" with nothing arriving and no way to tell. Re-read what is still
     there and say so. */
  function verify(corpse, cfg, wanted) {
    var br = window.UORailBridge;
    setTimeout(function () {
      Promise.resolve(br.getContainerItems(corpse.serial)).then(function (left) {
        var stuck = (left || []).filter(function (it) { return autolootMatches(cfg.types, it); }).length;
        if (stuck <= 0) { toast("Looted " + wanted + " item" + (wanted === 1 ? "" : "s")); }
        else if (stuck >= wanted) { toast("Could not loot — too far, or your pack is full"); }
        else { toast("Looted " + (wanted - stuck) + " of " + wanted + " — " + stuck + " left behind"); }
      }).catch(function () {}).then(lootDone);
    }, 900);
  }

  function autolootStart() {
    if (_lootTimer) return;
    _lootTimer = setInterval(autolootTick, 1500);
  }

  /* Forget the corpses on logout: serials are reused across sessions, and a remembered one would
     make the looter skip a real corpse for the rest of the next session. */
  try {
    window.addEventListener("cuo:logout", function () { _lootSeen = null; lootDone(); });
  } catch (e) {}
  // ── Autoloot — a persisted list of item TYPES (graphic+hue) and a toggle that
  // takes them off nearby corpses. See autolootTick above for the loop.
  //
  // ⚠️ It used to only pull matching items out of your OWN backpack, while being called
  // Autoloot. The operator killed a monster, got nothing, and reported the agents as
  // broken — correctly: nothing in the client watched for a corpse. A feature named
  // for something it does not do is worse than an absent one.
  //
  // The type list persists per character (railAgents.autoloot, see loadAgents).
  function wireAutoloot(body) {
    var br = window.UORailBridge;
    var row = body.querySelector(".uorail-loot-row");
    if (!row) return;
    var addBtn = row.querySelector('button[data-tip="Add item"]');
    var refreshBtn = row.querySelector('button[data-tip="Refresh"]');
    var ag = loadAgents(); ag.autoloot = ag.autoloot || { types: [] };
    // Render the REAL backpack art into the loot slot (no invented pictogram).
    var slot = row.querySelector(".uorail-loot-pack");
    if (slot) { slot.innerHTML = ""; drawItemArt(slot, 0x0E75); }   // default backpack
    var listEl = el("div", { "class": "uorail-al-list" });
    row.parentNode.insertBefore(listEl, row.nextSibling);
    function renderList() {
      var t = ag.autoloot.types || [];
      if (!t.length) { listEl.innerHTML = '<div class="uorail-note" style="padding:6px 2px">No autoloot types — click + then target an item in the world to add it.</div>'; return; }
      listEl.innerHTML = "";
      t.forEach(function (e, i) {
        var rowEl = el("div", { "class": "uorail-al-item" });
        var art = el("span", { "class": "uorail-al-art" });
        drawItemArt(art, e.graphic, e.hue);
        var nm = el("span", { "class": "uorail-al-name" }, esc(e.name || ("0x" + (e.graphic || 0).toString(16))));
        var del = el("button", { "class": "uorail-icon-btn uorail-icon-sm", "data-pointer": "auto", "data-tip": "Remove" }, "×");
        del.addEventListener("click", function () { ag.autoloot.types.splice(i, 1); saveAgents(ag); renderList(); });
        rowEl.appendChild(art); rowEl.appendChild(nm); rowEl.appendChild(del);
        listEl.appendChild(rowEl);
      });
    }
    renderList();
    // "+" → enter TARGET mode (like the official); the user clicks an item and
    // its type is added with its real art. NOT a modal list.
    if (addBtn) addBtn.addEventListener("click", function () {
      if (!br || !br.requestTarget) { toast("Autoloot is available in-world"); return; }
      Promise.resolve(br.requestTarget()).then(function (ok) {
        if (!ok) { toast("Targeting unavailable (in-world only)"); return; }
        toast("Target an item to add to autoloot…");
        pollForTarget();
      });
    });
    function pollForTarget() {
      var tries = 0;
      (function step() {
        if (++tries > 75) { return; }  // ~30s timeout — give up quietly
        Promise.resolve(br.pollTarget()).then(function (res) {
          if (res && res.graphic) {
            if (res.kind === "mobile") { toast("Target an item, not a creature"); return; }
            if (!(ag.autoloot.types || []).some(function (e) { return e.graphic === res.graphic && e.hue === res.hue; })) {
              ag.autoloot.types.push({ graphic: res.graphic, hue: res.hue, name: res.name }); saveAgents(ag); renderList();
              toast("Added " + (res.name || ("0x" + res.graphic.toString(16))));
            } else { toast("Already in the autoloot list"); }
            return;
          }
          if (res && res.cancelled) { return; }
          setTimeout(step, 400);  // still pending — keep polling
        }).catch(function () {});
      })();
    }
    if (refreshBtn) refreshBtn.addEventListener("click", renderList);

    /* The toggle. The loop itself lives at module scope and is started once — see autolootStart. */
    var onBox = body.querySelector("#uorail-autoloot-on");
    if (onBox) {
      onBox.checked = !!ag.autoloot.enabled;
      onBox.addEventListener("change", function () {
        ag.autoloot.enabled = !!onBox.checked;
        saveAgents(ag);
        if (ag.autoloot.enabled) {
          autolootStart();
          toast((ag.autoloot.types || []).length
            ? "Auto-looting corpses" : "Add item types first — nothing will be taken yet");
        } else { toast("Auto-loot off"); }
      });
      if (ag.autoloot.enabled) autolootStart();
    }
  }

  // Draw the REAL item art (graphic) into a container element via the bridge
  // (getItemArt → RGBA → canvas → img). Silent no-op if art is unavailable
  // (out-of-world / missing). hue is accepted for future hued rendering.
  function drawItemArt(container, graphic, hue) {
    var br = window.UORailBridge;
    if (!container || !br || !br.getItemArt || !graphic) return;
    Promise.resolve(br.getItemArt(graphic)).then(function (a) {
      if (!a || !a.w || !a.h || !a.rgba) return;
      try {
        var bin = atob(a.rgba), len = bin.length, buf = new Uint8ClampedArray(len);
        for (var i = 0; i < len; i++) { buf[i] = bin.charCodeAt(i); }
        var cv = document.createElement("canvas"); cv.width = a.w; cv.height = a.h;
        cv.getContext("2d").putImageData(new ImageData(buf, a.w, a.h), 0, 0);
        var img = document.createElement("img");
        img.className = "uorail-al-img"; img.alt = ""; img.src = cv.toDataURL();
        container.innerHTML = ""; container.appendChild(img);
      } catch (e) { /* ignore */ }
    }).catch(function () {});
  }
  // The "Modern Loot Gump" checkbox maps to the 3-way GridLootType enum:
  // checked => 2 (Both), unchecked => 0 (None). Sends the numeric string the
  // client expects (a plain "c" control would send true/false and not parse).
  function wireModernLootGump(body) {
    var cb = body.querySelector("#uorail-mlg");
    if (!cb) return;
    var br = window.UORailBridge;
    if (br && br.getProfile) {
      Promise.resolve(br.getProfile()).then(function (prof) {
        if (prof && prof.GridLootType != null) { cb.checked = (+prof.GridLootType) > 0; }
      }).catch(function () {});
    }
    cb.addEventListener("change", function () {
      if (br && br.setSetting) { br.setSetting("GridLootType", cb.checked ? "2" : "0"); }
    });
  }



  // ── Hotkeys binding tables (Combat/General/Target + Skills/Spells) ──
  // REAL: each row binds a key to a single-action macro — the official client's
  // per-command hotkey model — via the same macro bridge the Macros tab uses
  // (addMacro + setMacroAction + setMacroKey). Skills/Spells rows are built from
  // the live macro catalog (UseSkill/CastSpell sub-lists) so they can never drift
  // from the client; Combat/General/Target map each command to its real MacroType
  // (commands with no backing MacroType are pruned — no dead rows). Filtered by
  // the panel "Search bindings" box (operates on .uorail-bind-row). wireBindings
  // does the async build. Each entry is {label, type} where type is the exact
  // MacroType enum name resolved against the catalog.
  var HK_TABS = {
    Combat: [
      { label: "Toggle War Mode", type: "WarPeace" },
      { label: "Arm / Disarm", type: "ArmDisarm" },
      { label: "Primary Ability", type: "PrimaryAbility" },
      { label: "Secondary Ability", type: "SecondaryAbility" },
      { label: "Attack Last", type: "AttackLast" },
      { label: "Attack Selected Target", type: "AttackSelectedTarget" },
      { label: "Bandage Self", type: "BandageSelf" },
      { label: "Bandage Target", type: "BandageTarget" },
      { label: "Equip Last Weapon", type: "EquipLastWeapon" },
      { label: "Use Potion", type: "UsePotion" },
      { label: "Invoke Virtue", type: "InvokeVirtue" },
    ],
    General: [
      { label: "All Names", type: "AllNames" },
      { label: "Always Run", type: "AlwaysRun" },
      { label: "Bow", type: "Bow" },
      { label: "Salute", type: "Salute" },
      { label: "Open Door", type: "OpenDoor" },
      { label: "Close Gump", type: "CloseGump" },
      { label: "Close Corpses", type: "CloseCorpses" },
      { label: "Close All Health Bars", type: "CloseAllHealthBars" },
      { label: "Close Inactive Health Bars", type: "CloseInactiveHealthBars" },
      { label: "Set Grab Bag", type: "SetGrabBag" },
      { label: "Use Item In Hand", type: "UseItemInHand" },
      { label: "Last Object", type: "LastObject" },
      { label: "Toggle Chat", type: "ToggleChatVisibility" },
      { label: "Circle Of Transparency", type: "CircleTrans" },
      { label: "Toggle Gargoyle Flying", type: "ToggleGargoyleFly" },
      { label: "Save Desktop", type: "SaveDesktop" },
      { label: "Quit Game", type: "QuitGame" },
    ],
    Target: [
      { label: "Last Target", type: "LastTarget" },
      { label: "Target Self", type: "TargetSelf" },
      { label: "Target Next", type: "TargetNext" },
      { label: "Current Target", type: "CurrentTarget" },
      { label: "Select Next", type: "SelectNext" },
      { label: "Select Previous", type: "SelectPrevious" },
      { label: "Select Nearest", type: "SelectNearest" },
      { label: "Use Selected Target", type: "UseSelectedTarget" },
      { label: "Wait For Target", type: "WaitForTarget" },
      { label: "Target System On/Off", type: "TargetSystemOnOff" },
    ],
  };

  // Cancel-hook of the binding row currently sitting in "Press a key…" —
  // only one capture may be live at a time (see keyBtn click handler).
  var _bindCaptureCancel = null;

  // Re-applies the panel search after async tab population (see renderPanel).
  var _panelSearchObserver = null;

  // Macro catalog (MacroType list + sub-ranges) cached after first fetch; shared
  // by the Macros editor and the binding tables. Source of truth = the C# enums.
  var _macroCatalog = null;


  function renderWorldMap(body) {
    var cfg = loadUoamCfg();
    body.innerHTML = infoBox("World Map — live position sharing",
      "See your group on the map. Everyone on THIS shard who connects with the SAME password shares positions live — a private room. Your position is never shared until you Connect.") +
      '<div class="uorail-form">' +
        '<div class="uorail-field"><div class="uorail-field-lbl">Group password (share it with your group)</div>' +
          '<div class="uorail-input-row" style="display:flex;gap:6px"><input type="text" class="uorail-input uorail-textb" data-uoam="pw" value="' + esc(cfg.password || "") + '" placeholder="e.g. dragons-2026" data-pointer="auto" style="flex:1 1 auto">' +
          '<button class="uorail-icon-btn" data-act="uoam-newpw" data-tip="Generate a random password" data-pointer="auto">🎲</button></div></div>' +
        '<div class="uorail-field"><div class="uorail-field-lbl">Your marker color (hue)</div>' +
          '<input type="range" class="uorail-range" data-uoam="color" min="1" max="3000" value="' + (cfg.color || 88) + '" data-pointer="auto"></div>' +
        '<div class="uorail-field"><div class="uorail-field-lbl">Update interval <span data-uoam="ivlbl"></span></div>' +
          '<input type="range" class="uorail-range" data-uoam="interval" min="250" max="3000" step="250" value="' + (cfg.interval || 1000) + '" data-pointer="auto"></div>' +
        '<div class="uorail-hk-add"><button class="uorail-btn-pill" data-act="uoam-toggle" data-pointer="auto">Connect</button></div>' +
        '<div class="uorail-note uoam-status"></div>' +
      '</div>' +
      subH("Connected players") +
      '<canvas class="uoam-radar" width="300" height="190"></canvas>' +
      '<div class="uoam-peers"></div>';
    wireUoam(body, cfg);
  }

  function wireUoam(body, cfg) {
    var br = window.UORailBridge;
    var pwEl = body.querySelector('[data-uoam="pw"]');
    var colorEl = body.querySelector('[data-uoam="color"]');
    var ivEl = body.querySelector('[data-uoam="interval"]');
    var ivLbl = body.querySelector('[data-uoam="ivlbl"]');
    var toggle = body.querySelector('[data-act="uoam-toggle"]');
    var newpw = body.querySelector('[data-act="uoam-newpw"]');
    var statusEl = body.querySelector(".uoam-status");
    var peersEl = body.querySelector(".uoam-peers");
    var radar = body.querySelector(".uoam-radar");
    function syncIv() { if (ivLbl && ivEl) ivLbl.textContent = (ivEl.value / 1000) + "s"; }
    syncIv();
    function persist() { saveUoamCfg({ password: pwEl.value.trim(), color: +colorEl.value, interval: +ivEl.value }); }
    [pwEl, colorEl, ivEl].forEach(function (e) { if (e) e.addEventListener("change", persist); });
    if (ivEl) ivEl.addEventListener("input", syncIv);
    if (newpw) newpw.addEventListener("click", function () {
      pwEl.value = Math.random().toString(36).slice(2, 8) + "-" + Math.random().toString(36).slice(2, 6); persist();
    });
    function render() {
      if (!body.isConnected) { if (_uoam.onPeers === render) _uoam.onPeers = null; return; }
      if (toggle) { toggle.textContent = _uoam.connected ? "Disconnect" : "Connect"; toggle.classList.toggle("uorail-act-gold", !_uoam.connected); }
      var peers = Object.keys(_uoam.peers).map(function (k) { return _uoam.peers[k]; });
      if (statusEl) statusEl.textContent = _uoam.connected
        ? ("Connected — " + peers.length + " other player(s) sharing on this shard.")
        : "Not connected — your position is private.";
      if (peersEl) {
        if (!_uoam.connected) peersEl.innerHTML = '<div class="uorail-note" style="padding:6px 2px">Connect to see your group.</div>';
        else if (!peers.length) peersEl.innerHTML = '<div class="uorail-note" style="padding:6px 2px">No one else connected yet — share your password.</div>';
        else peersEl.innerHTML = peers.map(function (p) {
          return '<div class="uoam-peer"><span class="uoam-peer-name">' + esc(p.name || "player") + '</span><span class="uoam-peer-loc">' + (p.x | 0) + ", " + (p.y | 0) + " · map " + (p.map | 0) + '</span></div>';
        }).join("");
      }
      drawUoamRadar(radar, peers);
    }
    _uoam.onPeers = render;
    if (toggle) toggle.addEventListener("click", function () {
      if (_uoam.connected) { uoamDisconnect(); return; }
      if (!br || !br.player) { toast("World Map is available in-world"); return; }
      var c = { password: pwEl.value.trim(), color: +colorEl.value, interval: +ivEl.value, name: "player" };
      persist();
      Promise.resolve(br.player()).then(function (p) { c.name = (p && p.name) || "player"; uoamConnect(c); })
        .catch(function () { uoamConnect(c); });
    });
    render();
  }

  /* ── Minigames (operator 2026-07-02): TBH embedded OVER the current page ── */
  // NOT a floating window (operator: "debería cargarse como en el index, incrustado sobre la web
  // actual, no en una ventana flotante") — the EXACT launch-demo.html mechanics, extracted as
  // window.UOMinigameBar so the portal Minigames tab and this rail panel embed the same FRAMELESS,
  // TRANSPARENT bottom bar: boot HIDDEN behind a loader pill until the mini posts `mini:inworld`
  // (no LoginGump flash), host-side ✕ + 🔊/volume controls in the rail style, close DESTROYS the
  // iframe (frees the WASM heap) and sweeps the mini's parent-doc panels (.mghud-wrap et al).
  // Boot deadline = STALL watchdog, not a stopwatch (operator 2026-07-26: TUO +
  // Tower Defense "llega al 99% y pone couldn't connect, retry"). It used to be a
  // flat 50 s, but a COLD mini boot downloads the whole minigame fileset (~570 MB
  // measured) — on a laptop, or with a full client already running in the tab, that
  // simply does not finish in 50 s, so the bar killed a boot that was working. Now
  // every progress tick re-arms the timer: we only give up when the download stops
  // MOVING, with an absolute ceiling so a wedged iframe can't hang the bar forever.
  var MG_STALL_MS = 45000, MG_MAX_BOOT_MS = 600000;
  // Operator 2026-07-15: order + size + position + drag + camera + rules, admin-tunable and
  // registry-driven. Cached once per page; every field is an OPTIONAL override (null/0 = the
  // client's built-in default), so a game with no admin overrides behaves exactly as before.
  // Shared entry point — the portal Minigames tab (portal-rail.js) calls this too.

  // ── #92 draggable minigame WINDOW (Runmatch / Tower Defense) ──────────────────
  // Operator 2026-07-06: Runmatch + Tower Defense must NOT dock as the TBH bottom bar —
  // they open in a DRAGGABLE, RESIZABLE floating box the player places anywhere and plays
  // there. (TBH stays the frameless bottom bar; its floating-window form is vetoed.) Each
  // minigame id gets its OWN window + iframe — the proxy mints a per-minigame account
  // (short-code identity) so several can be open at once without kicking each other. As with
  // the bar, NEVER reparent the iframe after build (that reloads the WASM instance): it is
  // created once inside .uomw-body and only ever moved via CSS left/top on the outer window.
  var _miniWins = {};            // gid -> { win, iframe, muted, revealTimer }
  var _miniZ = 2147483560;   // bumped to front on focus
  var _miniWinWired = false;
  // ClassicUO game-viewport frame art (extracted from gumpart.mul): 0x0A8C golden
  // horizontal bevel (top/bottom), 0x0A8D vertical bevel (left/right), 0x0837 resize
  // gem. Used so the minigame window wears the AUTHENTIC CUO border, not a CSS one.
  var UOMW_HB = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAgkAAAAECAYAAAAEY6wPAAAIoklEQVR4nM1Zr3ckNxL+9r0DEpOYGw4cszE7w4N7bMPW0DDw4IXen7DQMMsCExjoYzbbgQ01TGIttve+qpK6e37s2rkkm963Hk13q1RVX/2eN//+/t1n7wDH/1wASKmg5irr4uUD0wSgTnxJPmuNkDfqiLv7ewAO2y1QKzDlglIzaq2Yporr6w2mPKHUKnSnWnEoE3Ku8o7smUiNdIWUEIrDoIfDCX98V76R13ZPnlZ4z+96L8aIEDaIcYtpSgAiPj48CNkmI9/7TXKLzEDKBR8+fA/nBtSaUGv59jJ+fEBKXBtFexfw8H7+HqPSCcHrmv9ChPdXcK5i3PO0gh8ffoQLfGr8wpTCFenZ/eCc0gkO0Xk4o8mHKXscDhlPT4+opdqmJm/FZgDiELHb7eBcRK0TSlG74fslT8iiP/0P4iFaNFzgUU2nuy1Qqsf9/buuS+q/lKmv9VO/L3FRXCfTd0WMg+lOGVZYapdZdIkz2ATDxr0UG+rSX8ZG7r8Mm46OLZxh4yPpLbCRgx1K8hgFm2fUmjtvHZuNyrLb/R3OecGGmOQJhk2+jI1dskew8SD8io0zHErHe4kNv3O92QRM0wE31+9N5ge4EF4kc7fHGBe6dijFI6UJT0//RSlNZkWS79AdQ4i4udnJ57E9ppXt/P4ya8zhelrZXQjk7Ub4u7t7i5wzUjqIb6mNZ41VtN4eYNQ+lzFlac9Ti3U19VhDx6Yqz9njHH8iYgzyfL/XU1bYyDGkMilCX4kVam9qj6lkPD0+S/5YYQNg2Bg211s5izK0WKtxd0I2PYpHn8GGPk5MtlvaM3B/9058Vu3aYkWu3a7zWWyMKs8HeaqCTYwT3r//p2KSClLOKEXxJjbC0xIb2V9XMWGFS0kvihMNl8A4cQYXuI1GY5d7HuMnYzivYAoiFsMQTE0WGyvwt+/u/3GS6IbtnOjGlDUQUmHFdMOAYYJyrwQ/4ayIEltQVoWq4Lyn32clkano6MTKJJ2XSguRCdwh0Cr627PNeBqXeQABUCepHRRUMjoC+BUuGLh8TzR/OcG/RO6mYDrrOI4IIeFwKD0ZfUsZr7YbXG0p07TwjCpFEB2yB4dJ6aVc4UZNcMElxDBK5ZQzHbCKI1NW0nNWaDRHnzlWMxd7oK7ozJpFJbFESaERLrKozAs5afC0UL4aJJhLurWgKDZD55Lg3YK4HG4JvWLK6qRCS970cGESXEiLAVmDsVR6KpMBoU6mhS4doU4XcGmVwBexoX1bUBj/AGxCQoxNptdjQ27FH63w5N8YudchCDYONbtTbFzDRipMMG5r0imC5ZexsfAnutLi+qXYDINiEwbiskHKo8kcXm2P05SFFg1NZIaToEi9Un7FlH5thTnx9QHDELvMKhLpKq9/pMzH9ijJm+zLPcYu4IcfPszG2BodKXACQhzgeyGliVBOs6Jjac+skbjMIxODFRJmj42Pbo+JvLZiOPXkNNvjApuWgJz/aqxgfOA7IoM0F0x0ao/nsWGBwUTIAo42yDhhftj1afGXPqIGOzcCzXdNF/sjbCivxm+l4UhmoEdQR16SvRYwmoyXCV+w+c9Dj0jtDE3qAcPVoA1pSwZHhULzwCIG4JDTKS4nceICLimz8iEug+h7JXv0iGwwrNHZDFFiHvWvTQX9P/T8+Oann/71mV3GpUS32Q7YbHgQkK3KYmVYsgbREBP2n55RS0LOUYQTo7binozkWoSJZpzhymFgtzU4Zc6UppVLxYEYUOlpbKW0YMHl0kGpOBkCyCsEsHX6mmTIaxi4zkjCm3aedJu7u1u8Sm45fAbSB4+fPz5iHBMGKjz6by7jdnfbpyKrpLYI/1J1s1K2TlDkaoGE2LoJMZLmIPTa9KT1JSqLXxUv6VBRUhKcNQFqUuKXONBQI7bXnBTMRUBjjoEqJ3bIz1pEiOGy++Bf7tXgdzUMCz22ILbG5ZB4z2PcPwo/xFc6I3OGVoGzG6FD6H11IG3CLuDyp2JDeytfxeZmd6vy/5/YUBebhs0ycklnR14qxqcz2LjWeSs2DDoKhCUmw0b05YDDeIoNOyMcY3MVTa8O46hBer//5XeVeWWPJm9bv0ZmL5Oc18l81h5F5mCTTesmmx31XhqgSXI1Pj3qhMR0ri4hXPZOsQ1A28RDeDqyZ9nuHQaOjKwg0eioJzIXFit+OKmQQrOZyNIew4DtzW0vRFrnr/JoMmAMlbiTSIu5goX0ETZRsdlwJN38wvxbkmZh3qlII9tkNmtYxwrKFIJMJpt/Cv1lF29xmLRYJKZPOrUIUti0wkSPFBuNal+Ks/Ihc4plHCNvUkySt0/wMr1SQn3y2Pa3wsCw7bYnn3a8NPNO8o/WBeoPPU5Yw5jP4iKdLWLMUiDQzkvWaXVgozFZ4xo08jB/jXtOOJUPbUp0inl1FeScN+/v334+jGrALdHJVJwFR3Bow3ANYvpJXeaqT1i9yBiZimOrsjLrPnWax4HdjI6unr/n4VAb8ay0uzihPzohtgDGruHt7fzIOzz++oxZblZSuCh339eL26OfJ/4iMq7HEcvLGGRQbkc3nhfXbGqKW3PwTmVBv+mq86/TtzVRE6LREh0vj2/TNzFua9lmP7UXVal95LZwls5LO6s5oP2sow42/0RyvLOeuyfE7CehxblttDjvPKY647hoML58cXzY9T7z+TWbwTlsjracYnOEi/CoC3afKxuzddvOgmUlbcdIR8mytgcW0/TYRSjoONv4p+u14XvE2lIQ8n5sj8f11hftcYFdOzdwcnXGryxf2Qh+aQAL+Q23kyJvTWrOyZNNJTvzF7Bu6hKs/QWqF87Qb0suT+x0id1i2LnC8TxHSqvXAKuL2OgY/Lwwx7xeoCMTWtvmL2Cjx80Yz3l3fcnPG5cdsNExbtb2+IqrnovJL95M/iexW04m28UJVF8bT6muff3PuG6/2+Lx52cpQv4HpIpadFyZMoEAAAAASUVORK5CYII=";
  var UOMW_VB = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAGECAYAAAD+9OosAAAG1UlEQVR4nO1YK3RbRxAd6wjMsl2mBwUV5rAEBibMYaWBhYENbFlpoWGhy1IoaKgwGwo+sbdsh6Xnzsx+pBi0uNpzEkvj3Z3P3rkz45v373bfOUZKKdDudkeH/ZFWREQiQqUQEeMbmbAuph+EhSiYeIXPMTKllCgvosI1/vvw7jVRIHp4OBBTsuObKRIzU862s2nHvxjrnUSURWhZhJhDF8JGkULBZP34MpsDIi5MiWnaJnOA/8vxNYyWXPQXATvrnWpOZIox2nF2O7EzTXzpEVGsxguCq6aw/juLp34PLtQTbkpda3wukGYmKR66aOeokClToV7TtJEJ8Sy6weVYq3YmYOMY+dx/gbWGgb9++UiHw5G+7Z/7TmYLxDzPLoQiyZRzoRgt+ivcXUqhUjyeGhAxRYgU8wuhk+oRfoejEHD1CL+sAq6w0efIiwpTw2d9uITID1jC8cTpUrsr4UGRarfv3SMEc8k9oKpdDVdbxXf6Ypgjw2uaJo/GuFNFfCGsNmKtp8jEKTUlWKvNdqLPnz/T4+MTPT0+mRBKcj7qdSlVKAoCciJOofuOu/JpoUDcXFXt85LVHK5CKUWfVyV8hmShTQIg3HfgFEm13U7NJVUEC/x5epAt6hpEE+Jn0G2hgwG/xXNgo7Qgl4olgKzttJuA/VBRtyjLRI0+1yBPienjh1eUjzOJuJ3qIYOsiJaacbgw8qTQzqfFhFCYxRJgs4OrRDe3u+33FCNtXk307u4t7e8fDSFRaUJhYsdDteMsN6myQkMNFOGjuyJuUk9iplSfw09S3FxgXnNdY1outQ8cUs3QqiADkg0uTBmgMGYw8seaZw+IoY31+Hzy47ACYdMrynAnEnWakj91pUogjlmf2hRRV5RBLszmewiGYhntXBZzj/3Ezfs3u+/Tq0kF292ODn8/O7znheZZKKZLTnb/B3xyC/4ZWZ09HPfPbdmdTsHsATePNkkjlVs8iejjh50+/v2fjxRRN7U0bqxuinPzGhZq0uaRP5EV2TIkRn/3mlIIWxgLX1mswpaWMsF2qVdh2Gl1mGl6ufClvrOGLFZOrqVIa0x4ofCFmoZASK3BpULRfoJx5LLw0UuFj6quf1n46mqFDzJudqLw/fKRbnfb88KnVvNF4YPVKD+xtTHgDuek4KFvJfKHwrcstfBJF1YBK+E1YemNBI9v5JmHZTuBDpjDF6yIbGMPQHs4pQo+K3z4iDfxLqjGHcrOqyHKuQa7dJMarUvdqVJpAZbmUbuN9DZ/d6bgJslY+ApAVbyv20yJfv50R8+HIx2fj0N3ISf9kmrhwy3LjPZgKLvYOS+9McFaw3G85Fj5VtZySBNgta5yA9OIeuHDRtAateP6rNaH6BKpieD9hpibnfx7y0C9biLvF7nokzXuRY90tlkq6oRW+IJqoBaQ36kKFA1D0W/Ep+WbfKe3wYr7UIXe+S1zpt1uq8K1YRI2LiRjvtf2iM96G9QPFYTqpn2pKMZaKU3oBnC9ymgNc4z4YaTVSfWo9os0QhFJgGSQBkXxIuWp0+gX6BCHDo3PYcqo78Tx3pexa9ee4aIeJQ7qQHGqbRyijUQ2YJhQsQPoTJ2svvz2QN+ej3T7btePg2UsPcWFQyMhbtQKYRzi2/E5ophgPHCEBYBxfWLbFGzAY3NXKR3eDD0pDT3DwN490Zy9a75X4hM8CYm1xErrPDQSNDYSOY/zpreuxelCrUwYQnkYMdxL7C5lhE006su5KAkqM+A+tIZSH07H1FP+cTJ9+PpM+/0zvX3/ugvRDoJHonbAA7wt56Sb1JYMofuhu+Chu+DLgXG8Zo3/wDTwKlck4+Td3Rv9cn+/10f0eJqWXAdwDWOxos9nA3i29iD6K671p9ej4POMlZ4i+milQhEIAX9aI8Hd99ZIbKqiNgaaE70iOF1GnyjORqFU7azdqdXjMEQJSVBxSG2CJqKTzQnNd9sstNSAIAEq8/HYrV1wPw3aLwbGPFfsBQ8dM/3+xyc6HJ5p/9ejgVY7dLY8Px1nTSjlEEwT2khsvLNCK2c9gw+2qB1A28PXJ4rbiZjNthWSNCNVnKykZZzSUC3pTumANfgudEpH/tjROHaVlVB5HDHsiXpUNGVqfy81SloyAtERLsqQsPh48s5XjC7AND7yyMCfE0AwgH6lybpJ+nB1qZ0pbUgWoNkVWVpvnecX/Xnz6ac339FITDqZFjrsT7Sas6iN5kQY7exNGbUKWzEirt3GVz7748uqHUdE2HfWtghdEPs7rTCnIhGOTydFc/ub1XVw4OvgQNfBga6DA1cuug4OdB0c6Do4yHVw4OvgQNfBga+DQ/x/Dg7/ANRq2STHuoUhAAAAAElFTkSuQmCC";
  var UOMW_GRIP = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAsAAAALCAYAAACprHcmAAABVElEQVR4nHWRIXDqQBCGv6Cu7s5x8mRwxBEZGQmOyDyXOnCvElkclZXBgQMHMrjUEXkyzyWu564DzJtpRX+1s/vN7P7/wjflqfT5dOjb9uRfF4nfbOb++zz4X9Snv75uLE3zgdGSrFiz2+1QWmOMJBr9Ce5wMR16oZ441iFCx2gJDjCqZT4NaS57nl/OweAGm2hEdRWgYvrW0jkYJymVlay3grwoKcvcD7qu9E1do6IV7rNFanM/yzmHDkc01wbnKqrDgWC1mHihFWWdsXqZYwzk+Zr+X0toFFVVEY8lafLEIElihAjpHTgBRjwMS6nouxYQGNWjTfJI47RbeNvBchuRphMuxzc+u5aR0UyMZbmcoXT2MBjFMZfjnvfCcjlvCcOYJJ0h7BtKtNjr9b7tDis9C4Z6SF0dKOIzY1li9xnaSJJsTW1vQf6icjP11Wnx43u3/heBnYq+jB0GSwAAAABJRU5ErkJggg==";




  // `open(g, opts)` — opts.web marks a launch that came from the WEBSITE menu rather than the
  // in-client rail, which is what selects the format chooser + the framed window. See mgIsWebLaunch.


  // sandbox RPC listener (registered once)
  window.addEventListener("message", onSandboxMessage);

  /* ── public-ish controls ─────────────────────────────────────────────── */
  function open(id) {
    var p = PANELS.find(function (x) { return x.id === id; });
    if (!p) return;
    activeId = id;
    // Tell the main.js input bridge a panel owns Escape now: in-world the
    // bridge's capture keydown stopImmediatePropagation's, which starved this
    // rail's own Escape→close listener (only the ✕ worked). The bridge yields
    // Escape while this flag is set (mirrors __uoRailKeyCapture).
    try { window.__uoRailPanelOpen = true; } catch (e) {}
    bar.querySelectorAll(".uorail-btn[data-panel]").forEach(function (b) {
      b.classList.toggle("uorail-active", b.getAttribute("data-panel") === id);
    });
    renderPanel(p);
    panel.classList.add("uorail-open");
  }
  function closePanel() {
    activeId = null;
    try { window.__uoRailPanelOpen = false; } catch (e) {}
    panel.classList.remove("uorail-open");
    bar.querySelectorAll(".uorail-btn[data-panel]").forEach(function (b) { b.classList.remove("uorail-active"); });
  }
  function toggle(id) { (activeId === id) ? closePanel() : open(id); }

  function toggleFullscreen() {
    try {
      // Prefer the host page's Game Mode (fullscreen + keyboard.lock so F-keys /
      // numpad / Ctrl-combos reach the client) — the rail's button IS the only
      // fullscreen control now (the floating #gamemode-toggle is hidden below).
      if (window.UORailGameMode && typeof window.UORailGameMode.toggle === "function") {
        window.UORailGameMode.toggle();
        return;
      }
      var stage = document.getElementById("stage");
      if (document.fullscreenElement) { document.exitFullscreen(); }
      else if (stage && stage.requestFullscreen) { stage.requestFullscreen({ navigationUI: "hide" }); }
    } catch (e) { /* non-fatal */ }
  }
  function openExternal(url) {
    try { window.open(url, "_blank", "noopener,noreferrer"); } catch (e) {}
  }

  // The settings that save the most GPU per frame. Shared by the Performance tab and by
  // the automatic hint below.
  var PERF_LOW_MAP = {
    ShadowsEnabled: "false", TerrainShadowsLevel: "0",
    SpriteSmoothingMode: "0", SpriteSmoothingLevel: "0", SpriteSmoothingFull: "false",
    AnimatedWaterEffect: "false", UseAlternativeLights: "true",
  };
  // CUO's own defaults, so "restore" restores rather than guessing something sensible.
  var PERF_STD_MAP = {
    ShadowsEnabled: "true", TerrainShadowsLevel: "15",
    SpriteSmoothingMode: "0", SpriteSmoothingLevel: "0", SpriteSmoothingFull: "false",
    AnimatedWaterEffect: "false", UseAlternativeLights: "true",
  };

  function perfApplyMap(map) {
    var br = window.UORailBridge;
    if (!br || !br.setSetting) return false;
    Object.keys(map).forEach(function (k) {
      try { br.setSetting(k, map[k]); } catch (e) { /* skip keys this fork lacks */ }
    });
    return true;
  }

  // Weak-machine hint.
  // main.js already published window.__uoWeakMachine (few cores, little RAM, or a software
  // GPU) but NOTHING read it: the signal existed and did nothing. The performance preset is
  // worth about 8% of renderer CPU and sat buried in a tab, so precisely the players who
  // need it never found it.
  //
  // It OFFERS, it does not apply itself. Changing someone's graphics without asking is
  // rude, and the detection is coarse on purpose -- deviceMemory is browser-rounded and
  // hardwareConcurrency lies on several machines. A false positive that asks is a nuisance;
  // one that acts degrades the picture for no reason.
  //
  // Asked ONCE per browser, and the answer is remembered whichever way it goes. A hint that
  // returns every boot becomes noise people learn to ignore.
  var PERF_ASK_KEY = "uo.perfSuggest.v1";

  function maybeSuggestPerformance() {
    try {
      if (!window.__uoWeakMachine) return;
      if (localStorage.getItem(PERF_ASK_KEY)) return;
    } catch (e) { return; }

    var tries = 0;
    (function waitForBridge() {
      var br = window.UORailBridge;
      if (!br || !br.setSetting) {
        // 🚨 MEASURED 2026-07-30, and the previous budget was wrong in the worst possible
        // direction. This used to give up after ~60s on the assumption that "if the bridge is
        // still missing something worse is wrong". It is not: an instrumented guest cold boot
        // on an RTX 3080 / 16 cores took **80 seconds** for UORailBridge.setSetting to appear,
        // so the poll expired ~20s BEFORE the bridge existed and the offer was never shown.
        //
        // The irony is the point: this hint exists FOR SLOW MACHINES, where boot takes longer
        // still -- so a budget calibrated on a fast machine meant the weak-machine offer
        // essentially never fired on weak machines. Ten minutes is generous on purpose; the
        // cost of waiting is one 500ms timer, and the cost of giving up early is the whole
        // feature. The loop still ends the moment the bridge appears.
        if (++tries > 1200) return;
        setTimeout(waitForBridge, 500);
        return;
      }
      toast("This machine looks modest. Turn off the heaviest effects?", {
        sticky: true,
        action: {
          label: "Turn them off",
          onClick: function () {
            try { localStorage.setItem(PERF_ASK_KEY, "applied"); } catch (e) {}
            if (perfApplyMap(PERF_LOW_MAP)) toast("Performance mode applied.");
          },
        },
        onDismiss: function () {
          try { localStorage.setItem(PERF_ASK_KEY, "declined"); } catch (e) {}
        },
      });
    })();
  }

  function toast(text, opts) {
    if (!toastHost) return;
    opts = opts || {};
    var t = el("div", { "class": "uorail-toast" },
      '<span class="uorail-toast-dot"></span><span>' + String(text).replace(/[<>&]/g, function (c) {
        return ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c];
      }) + "</span>");
    var close = function () {
      t.classList.remove("uorail-toast-in");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 240);
    };

    // Optional action: makes a hint actionable without opening a modal, which at boot would
    // be intrusive. The label goes in via textContent -- never innerHTML.
    if (opts.action) {
      var btn = el("button", { "class": "uorail-btn-pill", "data-pointer": "auto" });
      btn.textContent = String(opts.action.label || "OK");
      btn.style.cssText = "flex:0 0 auto";
      btn.addEventListener("click", function () {
        close();
        try { opts.action.onClick(); } catch (e) { /* never break on a handler */ }
      });
      t.appendChild(btn);
    }

    if (opts.sticky || opts.onDismiss) {
      var x = el("button", { "class": "uorail-btn-pill", "data-pointer": "auto" });
      x.textContent = "Dismiss";
      x.style.cssText = "flex:0 0 auto";
      x.addEventListener("click", function () {
        close();
        try { if (opts.onDismiss) opts.onDismiss(); } catch (e) {}
      });
      t.appendChild(x);
    }

    toastHost.appendChild(t);
    requestAnimationFrame(function () { t.classList.add("uorail-toast-in"); });

    // A hint that asks for a decision must not evaporate on its own: vanishing unanswered is
    // worse than never asking, because the player sees something and cannot read it.
    if (opts.sticky) return;
    setTimeout(close, opts.ttl || 3200);
  }

  // Non-blocking replacement for window.prompt(): the native prompt PARKS the
  // browser main thread while open, which under Mercury MT stalls rAF/audio/the
  // input bridge (freeze family). This resolves to the entered string, or null
  // if cancelled — a real modal, no main-thread block. title is set as
  // textContent (never innerHTML) so item/shard names can't inject.
  function uiPrompt(title, def, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var host = document.getElementById("uorail-root") || document.body;
      var overlay = el("div", { "class": "uorail-prompt-overlay", "data-pointer": "auto" });
      var box = el("div", { "class": "uorail-prompt-box" });
      var h = el("div", { "class": "uorail-prompt-title" });
      h.textContent = String(title == null ? "" : title);
      var input = el("input", { type: opts.password ? "password" : "text", "data-pointer": "auto", spellcheck: "false" });
      input.value = (def == null ? "" : String(def));
      var row = el("div", { "class": "uorail-prompt-row" });
      var cancel = el("button", { "class": "uorail-btn-pill uorail-btn-sm", "data-pointer": "auto" }, "Cancel");
      var ok = el("button", { "class": "uorail-btn-pill uorail-btn-sm uorail-prompt-ok", "data-pointer": "auto" }, "OK");
      row.appendChild(cancel); row.appendChild(ok);
      box.appendChild(h); box.appendChild(input); box.appendChild(row);
      overlay.appendChild(box); host.appendChild(overlay);
      var done = false;
      function finish(val) {
        if (done) return; done = true;
        window.removeEventListener("keydown", onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(input.value); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
      }
      // capture:true so the main.js input bridge (also capture) can't swallow the
      // Enter/Escape before this modal sees them while it's open.
      window.addEventListener("keydown", onKey, true);
      ok.addEventListener("click", function () { finish(input.value); });
      cancel.addEventListener("click", function () { finish(null); });
      overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) finish(null); });
      setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 20);
    });
  }

  // Non-blocking confirm on the same overlay machinery as uiPrompt() — the
  // native window.confirm parks the MT main thread exactly like window.prompt
  // did (freeze family; the macro-audit smoke caught this survivor on the
  // Macros editor Delete button, and the mini already bans window.confirm by
  // operator directive). Resolves true (OK) / false (Cancel/Escape/backdrop).
  function uiConfirm(title) {
    return new Promise(function (resolve) {
      var host = document.getElementById("uorail-root") || document.body;
      var overlay = el("div", { "class": "uorail-prompt-overlay", "data-pointer": "auto" });
      var box = el("div", { "class": "uorail-prompt-box" });
      var h = el("div", { "class": "uorail-prompt-title" });
      h.textContent = String(title == null ? "" : title);
      var row = el("div", { "class": "uorail-prompt-row" });
      var cancel = el("button", { "class": "uorail-btn-pill uorail-btn-sm", "data-pointer": "auto" }, "Cancel");
      var ok = el("button", { "class": "uorail-btn-pill uorail-btn-sm uorail-prompt-ok", "data-pointer": "auto" }, "OK");
      row.appendChild(cancel); row.appendChild(ok);
      box.appendChild(h); box.appendChild(row);
      overlay.appendChild(box); host.appendChild(overlay);
      var done = false;
      function finish(val) {
        if (done) return; done = true;
        window.removeEventListener("keydown", onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      }
      window.addEventListener("keydown", onKey, true);
      ok.addEventListener("click", function () { finish(true); });
      cancel.addEventListener("click", function () { finish(false); });
      overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) finish(false); });
      setTimeout(function () { try { ok.focus(); } catch (e) {} }, 20);
    });
  }

  function setLatency(ms) {
    if (!latencyEl) return;
    var n = parseInt(ms, 10);
    var msEl = latencyEl.querySelector(".uorail-ping-ms");
    if (!isFinite(n) || n < 0) { if (msEl) msEl.textContent = "—"; return; }
    if (msEl) msEl.textContent = n + "ms";
    latencyEl.classList.toggle("uorail-warn", n >= 120 && n < 250);
    latencyEl.classList.toggle("uorail-bad", n >= 250);
  }

  /* ── show / hide lifecycle ───────────────────────────────────────────── */
  // MINI rail gate, evaluated AT SHOW TIME (operator 2026-07-02 "aparece el rail de opciones
  // activado por defecto en el TBH; debería estar oculto por defecto"): on the mini the rail is
  // OPT-IN — it shows only when window.__MINI_RAIL is exactly true (?railmodes= param, or a
  // use-case with rail:true). The old init-time `__MINI_RAIL === false` check raced the ASYNC
  // use-case resolution (mini-runtime applies cfg.rail AFTER rail.js init), so an undecided
  // `undefined` fell through to "shown" and the mg-overlay got the rail's buttons by default.
  // Checking `!== true` at show() (gamescene-active — minutes after the cfg resolved) is
  // race-free and fail-closed; cuo/tuo (__MINI__ absent) are untouched.
  function railAllowed() { return window.__MINI__ !== true || window.__MINI_RAIL === true; }
  // ── latency poll ──────────────────────────────────────────────────────────
  // The readout is driven by POLLING the bridge, not by an event. It used to listen for a
  // `cuo:ping` CustomEvent that NOTHING in the tree ever dispatched — the element, the thresholds
  // and the listener all shipped, so the rail looked wired while every client showed a dash.
  //
  // Tied to the rail's own lifecycle rather than a global timer: the value only exists in-world,
  // which is exactly when the rail is up. No network — this reads a number the engine already
  // computes for its own NetworkStatsGump. 2 s is well under the engine's own ping cadence, so it
  // costs one cheap interop call and never misses a refresh.
  var _pingPoll = null;
  function startPingPoll() {
    if (_pingPoll) return;
    var tick = function () {
      var br = window.UORailBridge;
      if (!br || typeof br.getPing !== "function") { setLatency(-1); return; }
      Promise.resolve(br.getPing()).then(setLatency, function () { setLatency(-1); });
    };
    tick();
    _pingPoll = setInterval(tick, 2000);
  }
  function stopPingPoll() {
    if (!_pingPoll) return;
    clearInterval(_pingPoll); _pingPoll = null;
    setLatency(-1);   // leaving the world must clear the number, not freeze the last one
  }

  function show() {
    if (!railAllowed()) return;
    if (!document.getElementById("uorail-root")) build(); // mini defers the build until allowed
    if (root) root.classList.add("uorail-on");
    startPingPoll();
  }
  function hide() { if (root) { root.classList.remove("uorail-on"); closePanel(); } stopPingPoll(); }

  function init() {
    // MINI: ships the SAME rail as CUO with ALL its features (operator 2026-06-27
    // "el mini dispone del rail ingame con las features que tiene cuo") — but OPT-IN
    // (hidden unless __MINI_RAIL resolves true; see railAllowed above). Known-false
    // exits early; undecided registers listeners and lets show() decide race-free.
    if (window.__MINI__ && window.__MINI_RAIL === false) {
      try { console.log('[rail] hidden (mini strip mode, __MINI_RAIL=false)'); } catch (e) {}
      return;
    }
    if (railAllowed() && !document.getElementById("uorail-root")) build();
    // pull the Discord-account copy of scripts + agents into localStorage
    try { syncPersistedFromServer(); } catch (e) {}
    // show when the game world becomes active
    window.addEventListener("cuo:gamescene-active", show);

  /* Who the scripts belong to, cached synchronously for scriptScope().
     🚨 THE SCOPE HAS TO BE READABLE WITHOUT AWAITING. load/save run inside click handlers, and an
     async lookup there would let a save land under the wrong (or empty) scope while the answer is
     still in flight — a race whose symptom is somebody else's scripts appearing, which is the bug
     this whole change exists to stop. So the name is refreshed on entering the world and cached.

     Cleared on logout for the same reason: a stale name would scope the NEXT character's saves to
     the previous one. */
  (function trackScriptScope() {
    var refresh = function () {
      try {
        var br2 = window.UORailBridge;
        if (!br2 || !br2.player) return;
        Promise.resolve(br2.player()).then(function (p) {
          try { window.__uoRailPlayerName = (p && p.name) ? String(p.name) : ""; } catch (e) {}
        }).catch(function () {});
      } catch (e) {}
    };
    window.addEventListener("cuo:gamescene-active", refresh);
    window.addEventListener("cuo:logout", function () { try { window.__uoRailPlayerName = ""; } catch (e) {} });
    refresh();                      // already in world when the rail (re)initialises
    setInterval(refresh, 15000);    // cheap, and covers a character switch without a page reload
  })();

    window.addEventListener("cuo:player-created", show);
    // Load this shard's script policy in-world (slug is known by now) so the LS
    // language gate + JS sandbox gating reflect the admin's per-shard settings.
    // Re-evaluate GM-tools visibility in-world: at init the shard slug may not be
    // set yet, so a shard owner's panel would stay hidden until we re-check here.
    // hide when leaving the world
    window.addEventListener("cuo:logout", hide);
    window.addEventListener("cuo:disconnected", hide);
    window.addEventListener("cuo:login-gump-added", hide);
    // optional bridge signals
    window.addEventListener("cuo:profile-loaded", function (e) {
      var name = (e && e.detail && e.detail.name) ? e.detail.name : "Profile";
      toast(name + " loaded");
    });
    // Kept as an OPTIONAL push input (the C# side may dispatch it one day); the poll above is
    // what actually feeds the readout. This listener alone is what the feature used to be.
    window.addEventListener("cuo:ping", function (e) {
      if (e && e.detail != null) setLatency(e.detail);
    });
    // if we somehow init after the world is already up
    if (document.body && document.body.classList.contains("in-game")) show();
  }

  window.UORail = {
    open: open, close: closePanel, toggle: toggle,
    toast: toast, setLatency: setLatency,
    show: show, hide: hide,
    isReady: function () { return !!root; },
    client: CLIENT,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
