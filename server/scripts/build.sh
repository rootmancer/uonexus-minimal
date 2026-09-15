#!/usr/bin/env bash
# ── uonexus-webclient: rebuild the C# → WASM bundle (Linux/macOS) ────
#
# Usage:
#   server/scripts/build.sh          (dev mode)
#   server/scripts/build.sh prod     (strips internal trace strings)
#
# Prerequisites:
#   .NET SDK 10  — dotnet in PATH
#   wasm-tools workload:  dotnet workload install wasm-tools
#   git submodules:  git submodule update --init --recursive
#   source/vendor/mercury-statics/SDL2.a + FAudio.a  (in repo)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO/source"
WEBCLIENT="$SRC/webclient"

# v0.7.9: CLIENT_NAME dispatch mirrors server/scripts/build.bat. Default is
# CUO; set CLIENT_NAME=tuo to build the TazUO bundle into client/tuo/.
if [ "${CLIENT_NAME:-cuo}" = "tuo" ]; then
  CLIENT_NAME=tuo
  WASM_WRAPPER_PROJ="$WEBCLIENT/tazuo-wasm/tazuo-wasm.csproj"
  CUO="$SRC/tuo"
  BUILD_TMP="$REPO/.build/tazuo-wasm"
  CLIENT="$REPO/client/tuo"
elif [ "${CLIENT_NAME:-cuo}" = "mini" ]; then
  # mini = 3rd client (operator 2026-06-27): own source tree source/mini + mini-wasm wrapper → client/mini.
  CLIENT_NAME=mini
  WASM_WRAPPER_PROJ="$WEBCLIENT/mini-wasm/mini-wasm.csproj"
  CUO="$SRC/mini"
  BUILD_TMP="$REPO/.build/mini-wasm"
  CLIENT="$REPO/client/mini"
else
  CLIENT_NAME=cuo
  WASM_WRAPPER_PROJ="$WEBCLIENT/classicuo-wasm/classicuo-wasm.csproj"
  CUO="$SRC/cuo"
  BUILD_TMP="$REPO/.build/classicuo-wasm"
  CLIENT="$REPO/client/cuo"
fi
echo "[build] CLIENT_NAME=$CLIENT_NAME   out=$CLIENT"

# ── shared-www sync (2026-06-10 web dedup) ────────────────────────────────────
# The web layer (index.html / main.js / rail.js / rail.css / fonts / lib/) is
# single-sourced in source/webclient/shared-www/ — the per-project wwwroot
# copies are GITIGNORED generated artifacts. Sync into BOTH projects (not just
# the one being built) so the trees never diverge. No --delete: per-client
# files (classicuo-wasm/wwwroot/admin.html) must survive. See
# source/webclient/shared-www/README.md.
echo "[build] Syncing shared-www into both wwwroot trees..."
for proj in classicuo-wasm tazuo-wasm mini-wasm; do
  mkdir -p "$WEBCLIENT/$proj/wwwroot"
  if command -v rsync &>/dev/null; then
    rsync -a --exclude README.md "$WEBCLIENT/shared-www/" "$WEBCLIENT/$proj/wwwroot/"
  else
    cp -r "$WEBCLIENT/shared-www/." "$WEBCLIENT/$proj/wwwroot/"
    rm -f "$WEBCLIENT/$proj/wwwroot/README.md"
  fi
done
# mini (operator 2026-06-27): overlay its own divergent web (main.js/index.html/tbh-music) ON TOP of the
# shared-www sync. The shared rail.js (one rail, __MINI__-gated) stays; only the mini-specific files override.
if [ "$CLIENT_NAME" = "mini" ]; then
  echo "[build] Overlaying mini-overrides into mini-wasm wwwroot..."
  if command -v rsync &>/dev/null; then
    rsync -a "$WEBCLIENT/mini-overrides/" "$WEBCLIENT/mini-wasm/wwwroot/"
  else
    cp -r "$WEBCLIENT/mini-overrides/." "$WEBCLIENT/mini-wasm/wwwroot/"
  fi
fi

# ── Web de-dup (2026-06-28 "higiene": el portal web vive SOLO en client/web/) ─────────────────
# Tras el sync, BORRAR del wwwroot los ficheros/dirs PURO-WEB que el game-host NO usa, para que
# `dotnet publish` NO los meta en el bundle del juego NI fingerprinte cards-ui.js en el importmap
# (causa raíz del incidente prod 2026-06-28). Se CONSERVAN: macros/ (LegionScript del rail =
# game-host SÍ lo usa vía main.js), lib/, pyodide/, las fuentes del juego e
# index/main/rail. nginx sirve toda ruta web desde web/ (deploy-web). Paridad con build.bat +
# WEB_FILES/WEB_DIRS de build-web.mjs.
# legion-engine.js / legion-worker.js: rail.js los carga POR NOMBRE PLANO con
# ?v= — publish NO debe fingerprintarlos (los cold builds de v0.9.447 dejaron
# solo el twin fingerprinted → 404 en prod /legion-engine.js, 2026-07-18).
# Igual que cards-ui: strip pre-publish; se restauran RAW post-publish (paso
# cuo/tuo más abajo; mini vía build-web copyStatic).
echo "[build] Web de-dup: stripping pure-web files from wwwroot trees..."
for proj in classicuo-wasm tazuo-wasm mini-wasm; do
  for f in faq.html privacy.html macros.html profile.html shop.html cards.html notifications.html \
           cards-ui.js portal-rail.js ui.css aura.css profile-fx.css RobotoMono-Regular.ttf \
           legion-engine.js legion-worker.js; do
    rm -f "$WEBCLIENT/$proj/wwwroot/$f" "$WEBCLIENT/$proj/wwwroot/$f.br"
  done
  for d in webidentity cosmetics ui; do
    rm -rf "$WEBCLIENT/$proj/wwwroot/$d"
  done
done

# ── Dependency checks ─────────────────────────────────────────────────────────
MISSING=0
if ! command -v dotnet &>/dev/null; then
  echo "[build] ERROR: dotnet not found. Install .NET 10 SDK: https://dotnet.microsoft.com/download"
  MISSING=1
fi
if ! dotnet workload list 2>/dev/null | grep -q 'wasm-tools'; then
  echo "[build] ERROR: wasm-tools workload not installed. Run: dotnet workload install wasm-tools"
  MISSING=1
fi
if ! command -v npm &>/dev/null; then
  echo "[build] WARNING: npm not found — you will need Node.js 22+ and npm to serve the built client."
  echo "         Install: https://nodejs.org  or  https://github.com/nodesource/distributions"
fi
if [ ! -f "$SRC/vendor/mercury-statics/SDL2.a" ]; then
  echo "[build] ERROR: source/vendor/mercury-statics/SDL2.a not found. Clone the full repo."
  MISSING=1
fi
if [ ! -f "$SRC/vendor/sdl2-headers/include/SDL2/SDL.h" ]; then
  echo "[build] ERROR: source/vendor/sdl2-headers/include/SDL2/SDL.h not found."
  echo "        See source/vendor/sdl2-headers/README.md to repopulate."
  MISSING=1
fi
# mini (operator 2026-06-27) de-submoduled FileEmbed+MP3Sharp into source/mini/external/ (vendored) → check
# ITS own tree; cuo/tuo still rely on source/cuo's submodules.
_EMBED="$SRC/cuo/external/FileEmbed/FileEmbed/FileEmbed.csproj"
[ "$CLIENT_NAME" = "mini" ] && _EMBED="$SRC/mini/external/FileEmbed/FileEmbed/FileEmbed.csproj"
if [ ! -f "$_EMBED" ]; then
  echo "[build] ERROR: $CLIENT_NAME externals missing ($_EMBED). cuo/tuo: git submodule update --init --recursive"
  MISSING=1
fi
# Where to look for dotnet workload packs. User installs land in $HOME/.dotnet,
# system-wide installs (Microsoft .deb / dotnet-install.sh --install-dir) land in
# /usr/lib/dotnet (Ubuntu) or /usr/share/dotnet (other distros / older guides).
_DOTNET_PACK_DIRS=()
for _d in "$HOME/.dotnet/packs" "/usr/lib/dotnet/packs" "/usr/share/dotnet/packs"; do
  [ -d "$_d" ] && _DOTNET_PACK_DIRS+=("$_d")
done

# On Linux, verify the Emscripten bundled Node.js works — it needs libatomic.so.1
# which is not always present on minimal server installs. Testing it here avoids
# a cryptic failure after 7+ minutes of AOT work.
if [ "$(uname)" = "Linux" ] && [ ${#_DOTNET_PACK_DIRS[@]} -gt 0 ]; then
  _EM_NODE=$(find "${_DOTNET_PACK_DIRS[@]}" -name "node" \
    -path "*Emscripten*Node*" -path "*/tools/bin/node" 2>/dev/null | head -1)
  if [ -n "$_EM_NODE" ] && ! "$_EM_NODE" -e "console.log('ok')" &>/dev/null; then
    echo "[build] ERROR: Emscripten's bundled Node.js failed to start (missing system library)."
    echo "        Most likely fix:"
    echo "          Debian / Ubuntu:    sudo apt-get install -y libatomic1"
    echo "          RHEL / Rocky:       sudo dnf install -y libatomic"
    MISSING=1
  fi
fi
[ "$MISSING" -eq 1 ] && exit 1

PROD_FLAG=""
DEV_FAST=0
if [ "${1:-}" = "prod" ]; then
  PROD_FLAG="-p:WasmDevTrace=false"
  echo "[build] PROD mode -- trace strings stripped"
elif [ "${1:-}" = "dev" ]; then
  # dev mode = AOT-ON (matches prod runtime). The old "dev-fast" AOT-off mode
  # is RETIRED (2026-06-09): the .NET WASM INTERPRETER cannot marshal the async
  # window.UORailBridge [JSExport] (Task / Task<T>, required by Mercury MT for
  # cross-thread calls) and crashes at startup with "function signature
  # mismatch". Bisect-proven: pre-bridge commit boots AOT-off, first bridge
  # commit crashes AOT-off. AOT pre-generates the stubs, so AOT-on dev boots +
  # runs exactly like prod. The rail bridge is always present, so AOT-off dev
  # is permanently broken — no fast path left. ~10 min cold build, accepted.
  # KEEPS obj/bin wipe + verify-sri. Skips BUILD-TIME CF purge; deploy-dev
  # purges AFTER deploy. Keeps WasmDevTrace=true + WasmStripILAfterAOT=false.
  PROD_FLAG="-p:WasmDevTrace=true -p:WasmStripILAfterAOT=false"
  DEV_FAST=1
  echo "[build] DEV mode -- AOT ON, matches prod runtime; dev-fast AOT-off retired"
fi

# v0.7.8: WebClientVersion resolution mirrors build.bat lines ~95-122.
# Order:
#   1. WEBCLIENT_VERSION env var (set by release.sh from RELEASE_TAG)
#   2. client/version.txt (last released tag persisted by release.sh)
#   3. git describe --tags --always --dirty (iterative builds; surfaces
#      the actual commit in the LoginGump instead of the csproj default)
#   4. csproj default "v0.7.8-dev"
VERSION_FLAG=""
if [ -n "${WEBCLIENT_VERSION:-}" ]; then
  VERSION_FLAG="-p:WebClientVersion=$WEBCLIENT_VERSION"
  echo "[build] WebClientVersion = $WEBCLIENT_VERSION (from env)"
elif [ -f "$CLIENT/version.txt" ]; then
  _VER=$(tr -d '\r\n' < "$CLIENT/version.txt")
  VERSION_FLAG="-p:WebClientVersion=$_VER"
  echo "[build] WebClientVersion = $_VER (from client/version.txt)"
else
  _GIT_VER=$(git describe --tags --always --dirty 2>/dev/null || true)
  if [ -n "$_GIT_VER" ]; then
    VERSION_FLAG="-p:WebClientVersion=$_GIT_VER"
    echo "[build] WebClientVersion = $_GIT_VER (from git describe)"
  else
    echo "[build] WebClientVersion unset; csproj default applies"
  fi
fi

# Nuke cached Renderer dll so FileEmbed re-embeds shaders on every build.
rm -f "$CUO/src/ClassicUO.Renderer/bin/Release/net10.0/ClassicUO.Renderer.dll"
rm -f "$CUO/src/ClassicUO.Renderer/obj/Release/net10.0/ClassicUO.Renderer.dll"
rm -f "$CUO/bin/Release/net10.0/ClassicUO.Renderer.dll"

# Full obj/bin wipe — parity with build.bat (an incremental WASM build ships
# broken AOT; a cold build is mandatory). Scoped to the active engine tree ($CUO)
# + THIS client's WASM wrapper dir only, so it never touches the other wrappers.
# build.bat did a global %WEBCLIENT% wipe (the SEQUENTIAL-builds footgun) while
# build.sh previously did NO obj/bin wipe at all — the Linux half of audit B1.
WASM_WRAPPER_DIR="$(dirname "$WASM_WRAPPER_PROJ")"
echo "[build] Full clean: wiping obj/ + bin/ under $CUO + $WASM_WRAPPER_DIR (cold build)..."
find "$CUO" "$WASM_WRAPPER_DIR" -type d \( -name obj -o -name bin \) -exec rm -rf {} + 2>/dev/null || true

# SDL2 headers come from source/vendor/sdl2-headers/ via an -I in the targets
# file. No em_cache shenanigans needed: -I beats -iwithsysroot/include/fakesdl
# in clang's search order, so the .NET pack's SDL stub can't intercept.
# (See source/vendor/sdl2-headers/README.md for the why.)

echo "[build] Publishing..."
dotnet publish "$WASM_WRAPPER_PROJ" \
  -c Release \
  -o "$BUILD_TMP" \
  -m:1 \
  -p:IsBrowserWasm=true \
  $PROD_FLAG \
  $VERSION_FLAG

echo "[build] Copying output to client/..."
rsync -a --delete \
  --exclude='gamefiles/' \
  --exclude='*.br' \
  --exclude='*.gz' \
  "$BUILD_TMP/wwwroot/" "$CLIENT/"

# Preserve gamefiles placeholder. If the deployer has symlinked client/gamefiles
# to the real UO data tree (recommended on Linux — see README "Linux deployment"),
# leave the symlink alone. The placeholder + .gitkeep is only for fresh dev
# checkouts where gamefiles doesn't exist yet.
if [ ! -L "$CLIENT/gamefiles" ]; then
  mkdir -p "$CLIENT/gamefiles"
  touch "$CLIENT/gamefiles/.gitkeep"
fi

rm -rf "$BUILD_TMP"

# mini (operator 2026-06-27): delegate WEB finishing to build-web --client mini (brotli _framework twins +
# launcher demos + window.__MINI__ inject + main.js-from-mini-overrides strip + SRI). Skips the cuo/tuo inline
# finishing below. cuo/tuo never enter this branch.
if [ "$CLIENT_NAME" = "mini" ]; then
  _WP="--no-prod"; [ "${1:-}" = "prod" ] && _WP=""
  echo "[build] mini: regenerating _framework brotli twins (publish emits none)..."
  node "$(dirname "$0")/brotli-framework.mjs" --in "$CLIENT/_framework"
  echo "[build] mini: web finishing via build-web --client mini $_WP ..."
  node "$(dirname "$0")/build-web.mjs" --client mini $_WP
  echo "[build] Done. client/ is ready to serve."
  exit 0
fi

# v0.4.87: brotli twins for _framework + lib + client root, plus SRI
# verification — parity with build.bat. Without these, a Linux build
# produces a client/ that has no .br twins (nginx falls back to
# on-the-fly compression which is slow on first hit), and any prior
# release.sh strip-dev-blocks mutation of main.<HASH>.js leaves a
# stale .br that verify-sri.mjs catches in the next build. The .mjs
# tools are mtime-aware so re-runs that find nothing stale are no-ops.
echo "[build] Refreshing brotli twins (_framework)..."
node "$(dirname "$0")/brotli-framework.mjs" --in "$CLIENT/_framework"

if [ -d "$CLIENT/lib" ]; then
  echo "[build] Refreshing brotli twins (lib)..."
  node "$(dirname "$0")/brotli-framework.mjs" --in "$CLIENT/lib"
fi

# v0.4.98 root fix: brotli-framework's mtime check returns "no
# targets need updating" when a previous release's strip-dev-blocks
# pass left a .br twin newer than the just-published .js. robocopy
# /MIR (Windows) and rsync --exclude *.br (Linux) preserve those
# twins for deployer-generated gamefile compression, but they then
# block legitimate regeneration of main.HASH.js.br. verify-sri
# downstream catches the mismatch and aborts. Nuking the twin
# unconditionally before brotli-framework runs forces a fresh
# regen and removes the failure mode entirely. See build.bat for
# the full explanation.
echo "[build] Removing any stale main.*.js.br twin (regenerate from fresh source)..."
rm -f "$CLIENT"/main.*.js.br

# Restaura los legion-*.js RAW que el strip pre-publish quitó (rail.js los
# carga por nombre plano + ?v=RAIL_VER; nunca fingerprinted). Borra el twin
# .br viejo para que el paso brotli de abajo regenere uno fresco.
echo "[build] Restoring raw legion-*.js (plain-named, never fingerprinted)..."
cp -f "$WEBCLIENT/shared-www/legion-engine.js" "$CLIENT/legion-engine.js"
cp -f "$WEBCLIENT/shared-www/legion-worker.js" "$CLIENT/legion-worker.js"
if [ ! -f "$CLIENT/legion-engine.js" ]; then
  echo "[build] ERROR: raw legion-engine.js restore failed"
  exit 1
fi
rm -f "$CLIENT/legion-engine.js.br" "$CLIENT/legion-worker.js.br"

# Igual para pyodide/*.js: legion-worker.js hace importScripts('pyodide/pyodide.js')
# POR NOMBRE PLANO y `dotnet publish` fingerprintea todo .js de wwwroot -- el build
# frio dejaba el bundle sin pyodide/pyodide.js plano y nginx devolvia el fallback SPA
# (200 text/html), que importScripts rechaza. Mismo incidente que legion-engine.js en
# v0.9.447, con un fichero que nadie habia anadido aqui. En local no se veia porque
# copyStatic de build-web repone pyodide/ -- o sea que sobrevivia al build frio SOLO
# si build-web corria antes del release (prod v0.9.509: los 4 smokes de LegionScript
# de TazUO en rojo).
echo "[build] Restoring raw pyodide/*.js (plain-named, never fingerprinted)..."
mkdir -p "$CLIENT/pyodide"
cp -f "$WEBCLIENT/shared-www/pyodide/." "$CLIENT/pyodide/" -r
if [ ! -f "$CLIENT/pyodide/pyodide.js" ]; then
  echo "[build] ERROR: raw pyodide/pyodide.js restore failed"
  exit 1
fi
rm -f "$CLIENT"/pyodide/*.js.br

echo "[build] Refreshing brotli twins at client/ root (main.HASH.js)..."
node "$(dirname "$0")/brotli-framework.mjs" --in "$CLIENT"

# Fingerprint rail.css (the WASM SDK only fingerprints .js; a plain-named
# mutable .css can be pinned `immutable` by a CDN edge with no purgeable URL —
# our CF token is scoped to a different zone than the app domain). rail.css ->
# rail.HASH.css + .br + index.html link rewrite => every change is a fresh URL,
# origin-fresh on the CDN with no purge ever needed.
echo "[build] Fingerprinting rail.css (rail.HASH.css)..."
node "$(dirname "$0")/fingerprint-rail-css.mjs" --in "$CLIENT"

# v0.7.9: verify-sri KEPT even in dev-fast — 2s safety net for the
# incremental-build risk where the .wasm and its .br twin can desync.
# 2026-09-14: framework files named by their FINAL bytes before anything verifies or deploys this
# bundle. The SDK names them from the SOURCE, and a bundle deployed with those names can change
# bytes under a URL served `immutable` - a returning browser then refuses the loader and never
# boots (the year-long black screen of 2026-09-02). See framework-names.mjs.
echo "[build] Naming _framework files by their content hash..."
node "$(dirname "$0")/framework-names.mjs" "$CLIENT" || { echo "[build] framework-names failed -- build aborted."; exit 1; }
echo "[build] Verifying SRI integrity manifest..."
node "$(dirname "$0")/verify-sri.mjs" --root "$CLIENT"

# Stamp build-id.txt — used by the in-page reload guard in index.html to detect
# when a new client bundle has been deployed and force a hard refresh.
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$CLIENT/build-id.txt"

echo "[build] Done. client/ is ready to serve."
