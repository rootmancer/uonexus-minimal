import { WebSocketServer, WebSocket } from 'ws';
import * as net from 'net';
import * as http from 'http';
import * as crypto from 'crypto';
// UO_SERVER_HOST/UO_SERVER_PORT are no longer used directly here — the
// per-session target is resolved from the registry. They live on in
// config.ts as the legacy fallback that ServerRegistry.installLegacyFallback
// reads when no servers/*.yaml is present.
import { ASSETS_HTTP_PORT, getPublicOrigins, TRUST_PROXY_HOPS } from './config.js';
import { Huffman } from './Huffman.js';
import { DeathWatch } from './deathWatch.js';
import { recordDeathWitness } from './deathWitness.js';
import { getServer, defaultSlug, SLUG_REGEX, type ServerRecord } from './serverRegistry.js';
import { miniAccountForDiscord, miniAccountForGuest, miniAccountForSpectator } from './miniAccount.js';
import { resolvePublicIp } from './netGuard.js';
import { verifyRequestJwt } from './auth.js';
import { allowUpgrade } from './rateLimiter.js';
import { findActiveBan, banMatches, type BanEntry } from './banRegistry.js';
import { sweepBannedSessions } from './banSweep.js';
import {
  isShardCoolingDown,
  recordImmediateFin,
  recordPeerClose,
  recordC2sBytes,
  registerUpstreamConnect,
} from './shardCooldown.js';
import { buildWebIdentityFrame, normaliseClientIp, type WebIdentityFields } from './webIdentity.js';
import { adminHasScope, canEditServer } from './config.js';
// 🚨 NOT `import { getNickname } from '../nicknames.js'`, and the reason is the same one that keeps
// cards out of auth.ts. That import is used on exactly ONE line, inside the minigame branch, to
// prefer a player's public nickname over their Discord name. Minigames do not exist in the minimal
// build, so that branch never runs there — yet the static import put nicknames.ts (20 KB of public
// rankings, visibility opt-in and impersonation guards) into the minimal backend's import graph,
// and the publisher derives what it ships FROM that graph. A line that never executes was a file
// that always published.
//
// uonexus registers the resolver at startup. A build with no rankings registers none, and the
// fallback — the Discord display name — is what the branch already used when nobody had a
// nickname set, so the behaviour is unchanged rather than degraded.
type DisplayNameResolver = (sub: string) => string | null | undefined;
let _resolveDisplayName: DisplayNameResolver | null = null;
/** Register the public-display-name lookup used for minigame characters (uonexus: nicknames). */
export function setDisplayNameResolver(fn: DisplayNameResolver | null): void {
  _resolveDisplayName = fn;
  console.log(`[registry] display-name resolver: ${fn ? 'registered' : 'cleared'}`);
}
const getNickname = (sub: string): string | null | undefined =>
  (_resolveDisplayName ? _resolveDisplayName(sub) : null);
import { trackSession, untrackSession } from './proxyStats.js';
// Only the SIGNAL is imported here. The shard-facing delivery modules deliberately are not:
// this process must not be able to call them by accident (see loginSignals.ts).
import { signalLogin } from './loginSignals.js';
import { isSnowflake } from './discordId.js';

// MINI auto-login (opt-in per container via env MINI_AUTOLOGIN=1). When ON, a
// Discord-authed OR guest connection is auto-bound to a shard account (role
// mini-player / mini-guest in the 0xA4 so eternal's Custom/ClassicUO/
// MiniAutoLogin.cs binds/creates the account+character), and its 0x80/0x91 login
// is rewritten to that account + an internal password derived from the
// WebIdentitySecret (the SAME value MiniAutoLogin.cs derives). OFF (default) on
// the shared dev/prod proxy → every branch below is inert there.
const MINI_AUTOLOGIN = process.env.MINI_AUTOLOGIN === '1';

// Deterministic internal account password — MUST match MiniAutoLogin.cs
// DerivePassword: Base64(HMAC-SHA256(key=WebIdentitySecret, msg=discordId))[:24].
function deriveMiniPassword(secret: string, discordId: string): string {
  const mac = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(discordId, 'utf8')).digest('base64');
  return mac.slice(0, 24);
}

// 🚨 IMPORTED, not re-declared. serverRegistry owns what a shard slug is — it is the module
// that creates them — and this file had its own byte-identical copy under a third name. Four
// copies of this pattern existed across the proxy; the repo has already been bitten twice by
// exactly that shape (SNOWFLAKE declared four times with two different bounds, and the
// leaderboard account regex whose migration updated one copy of two).
const SLUG_PARAM_REGEX = SLUG_REGEX;

/** Pull `?server=<slug>` out of a WS upgrade request URL.
 *  Falls back to defaultSlug() when the parameter is missing — that lets
 *  single-shard deploys keep working without the client knowing about
 *  registry slugs at all. Returns null if the slug is malformed or
 *  references a server that doesn't exist. */
function resolveServerFromReq(req: http.IncomingMessage): ServerRecord | null {
  let slugFromQuery: string | null = null;
  try {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const raw = u.searchParams.get('server');
    if (raw) {
      // Trim + lower-case so a stray cap or whitespace doesn't 403 a legit
      // user. The regex is strict enough that this is safe.
      const lc = raw.trim().toLowerCase();
      if (SLUG_PARAM_REGEX.test(lc)) slugFromQuery = lc;
    }
  } catch { /* malformed URL — fall through to default */ }

  const slug = slugFromQuery ?? defaultSlug();
  if (!slug) return null;
  return getServer(slug);
}

// Feature #76: per-minigame identity. The mini/AoS shard hosts several
// minigames off one process; the account name it auto-provisions must be
// namespaced per game so runmatch and towerdefense don't collide on the same
// Discord/guest sub. The client passes `?minigame=<id>` on the WS URL. Only
// whitelisted ids are honoured — anything else is treated as "no minigame"
// (null) so the TBH/bare path stays byte-for-byte identical to today.
// SINGLE SOURCE OF TRUTH (audit 2026-07-06): the whitelist is DERIVED from the code map so the two can
// never drift. Adding a minigame = adding ONE MG_CODES entry (both the honoured id AND its short code).
// This matters because the short code now travels in BOTH the ≤30-char account (d<id>-<code>) AND the
// 0xA4 `role` field (mini-*-<code>) — the FULL name in the role overflows the fixed 149-byte 0xA4 frame
// (that was the towerdefense-stuck-at-char-list bug; see MiniAutoLogin.SplitMinigame). So a whitelist
// entry with no short code must be structurally impossible, else mgAcctCode's fallback would leak the
// full name back into the role and re-break the frame.
// Live registry = runmatch + towerdefense only (minigameRegistry.ts). Keep MG_CODES in lockstep:
// survivalarena/bomberman were orphan entries (in NO registry, achievements, mini _allowedVerbs or
// client) so MINIGAME_WHITELIST honoured minigames that did not exist — removed 2026-07-21.
const MG_CODES: Record<string, string> = { runmatch: 'rm', towerdefense: 'td' };
const MINIGAME_WHITELIST = new Set(Object.keys(MG_CODES));
/** Short 2-char account/role code for each minigame. Only ever called with a whitelist member
 *  (resolveMinigameFromReq gates it), and the whitelist IS Object.keys(MG_CODES), so the lookup
 *  always hits — the `?? mg` fallback is provably dead and can never leak a full name into the frame. */
function mgAcctCode(mg: string): string {
  return MG_CODES[mg] ?? mg;
}

/** #113/#114 SPECTATOR: pull `?spectate=<charName>` out of the WS upgrade URL. Strictly sanitized
 *  (letters+spaces only, <=16 chars — the UO char-name alphabet MiniAutoLogin.SanitizeName accepts);
 *  anything else → null (no spectate). The name rides the 0xA4 username field to the shard, which
 *  stores it as the account's SpectateTarget tag for SpectatorSystem's login auto-begin. */
function resolveSpectateFromReq(req: http.IncomingMessage): string | null {
  try {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const raw = u.searchParams.get('spectate');
    if (raw) {
      const clean = raw.trim().replace(/[^a-zA-Z ]/g, '').slice(0, 16).trim();
      if (clean.length > 0) return clean;
    }
  } catch { /* malformed URL — no spectate */ }
  return null;
}

/** Pull `?minigame=<id>` out of a WS upgrade request URL. Trimmed + lower-cased,
 *  returned ONLY when it's in the whitelist; otherwise null (→ bare TBH path). */
function resolveMinigameFromReq(req: http.IncomingMessage): string | null {
  try {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const raw = u.searchParams.get('minigame');
    if (raw) {
      const lc = raw.trim().toLowerCase();
      if (MINIGAME_WHITELIST.has(lc)) return lc;
    }
  } catch { /* malformed URL — treat as no minigame */ }
  return null;
}

// Bumped on every change to UOProxy.ts so the operator can confirm the
// rebuilt container is actually running the new code. Look for this
// string in the proxy startup logs to verify the rebuild took effect:
//
//   [UOProxy] build=2026-04-30T18:30Z-diag-rev2 (Path C + c2s/s2c diag)
//
// If the log on the NAS shows an older tag, the docker image cache lied.
// Force a clean rebuild with:
//   docker compose build proxy --no-cache && docker compose up -d --force-recreate proxy
export const PROXY_BUILD_TAG = '2026-09-15T-v1.0.56-audit (An audit of the last three days of changes. Opening a minigame link on a phone builds one client and never a hidden second one. Closing or retrying the minigame bar no longer sweeps the HUD away or leaves a stale lift behind. On the phone the camera pan stays inside what the engine can show and the panned arena draws whole, two-finger gestures are no longer read as taps, and a second finger cannot steer the walking hero. Tower Defense clicks on the web land on the tile and the tower they were aimed at. The release tooling judges a compressed twin by the bytes it decodes to and checks the immutable file promise before a release is published.)';

// When ModernUO finishes the auth phase it sends 0x8C and immediately FINs
// the TCP. The proxy used to react by closing the WS with code 1000 right
// away; the wasm client's ReceiveAsync loop, however, processes WS frames
// on a worker thread, and a Close arriving in close succession with the
// preceding Binary frame (the 0x8C) can reach the wasm side before the
// last Binary is consumed — the BrowserWebSocket implementation surfaces
// this as `WebSocketException net_WebSockets_InvalidState, CloseReceived`
// with `position=0`. The 0x8C is silently dropped, the relay handler
// never fires, and the user sees "Verifying Account" forever.
//
// In LAN local the race window is sub-millisecond, so the bug is rare. Over
// Cloudflare the WS hop adds 100-300 ms RTT and the race becomes the common
// case. Defer the proxy-initiated close so the client has a clear window to
// drain the receive queue before the Close frame arrives. If the client
// closes first (it will: HandleRelayServerPacket → Disconnect on 0x8C, or
// just normal logout), the deferred close is cancelled in `ws.on('close')`.
const WS_CLOSE_AFTER_TCP_FIN_MS = 1000;

// The proxy rewrites 0x8C so the browser reconnects via the same host:port
// it already used — just with path /ws.  We don't need a separate WS port.
//
// PROXY_WS_HOST is the env-fallback for the rewrite. When the WS upgrade
// arrives we derive the rewrite target from the request's Host header
// (per-session) — this fixes the audit finding R2-H-5 where the static
// 127.0.0.1 default broke any deploy beyond loopback. The env var only
// applies when the Host header is missing or unparseable.
const PROXY_WS_HOST_FALLBACK = process.env.PROXY_WS_HOST ?? '127.0.0.1';
const PROXY_WS_PORT = ASSETS_HTTP_PORT; // same port as HTTP

// Length of the ConnectToGameServer relay packet.
const PACKET_0x8C_LEN = 11;

// ── caps / limits (audit R2-CRIT-2, R2-CRIT-3, R2-H-3, R2-H-4) ───────────────
const WS_MAX_PAYLOAD_BYTES = 64 * 1024;      // single WS frame
const WS_HANDSHAKE_TIMEOUT_MS = 5_000;       // pre-upgrade slow-loris cap
const TCP_IDLE_TIMEOUT_MS = 15 * 60 * 1000;  // 15 min idle TCP→destroy
const TCP_BUF_MAX_BYTES = 64 * 1024;         // accumulation buffer cap
const WS_BUFFERED_PAUSE_BYTES = 1 * 1024 * 1024;  // pause TCP read above this
const WS_BUFFERED_KILL_BYTES = 8 * 1024 * 1024;   // destroy session above this
const SCAN_0x8C_MAX_BYTES = 1024;            // walk only first 1 KiB for 0x8C
const PER_IP_SESSION_CAP = 4;
// v0.3.27 (500-user scale): bumped from 256 to 1000. Target deploy
// size is 500 concurrent web players + headroom for bursts +
// short-lived overlap during reconnect/refresh = 1000 cap leaves
// 100% margin. Memory cost: ~250 KB/session × 1000 = 250 MB worst
// case (most sessions idle at <50 KB), within the proxy container's
// 768 MB mem_limit. For 1000+ concurrent target, bump this to 2000
// AND mem_limit to 1024m+ in docker-compose.yml.
// 🚨 READ FROM THE ENVIRONMENT so the cap can be exercised at all. At 1000 it is unreachable
// from a test — nobody opens a thousand sockets to prove a refusal — which is exactly why raising
// it to MAX_SAFE_INTEGER left the whole suite green. The default is unchanged, so production
// behaviour is identical; the knob also happens to be the one the comment above already tells an
// operator to turn when moving to a bigger box, which until now meant editing this line.
const GLOBAL_SESSION_CAP = Math.max(1, Number(process.env.UO_MAX_SESSIONS) || 1000);

// Per-session c2s rate-limit (audit WS-C1). UO clients legitimately send
// ~10 packets/sec at peak; capping at 200/sec leaves a comfortable margin
// while making it impossible to pump MB/s of arbitrary payloads at the
// upstream UO server. Token bucket: capacity = burst, refill = sustained.
const WS_C2S_BURST = 200;       // max packets in a 1s burst
const WS_C2S_REFILL_PER_SEC = 200;
// Per-session lifetime cap on bytes received via the c2s WS pipe — defends
// against a slow drip that's under the per-second limit but eventually
// adds up to absurd volume. ModernUO's busiest legitimate session over a
// few hours is single-digit MB; 256 MB lifetime is generous.
const WS_C2S_LIFETIME_BYTES = 256 * 1024 * 1024;

// Cumulative Huffman output cap per session (audit WS-H1). Per-call cap
// (`maxOut=65536`) only protects one decompress call; without a lifetime
// cap, a malicious or compromised upstream can pump unbounded GB through
// repeated 64 KiB windows. ModernUO's busiest legitimate s2c stream is
// well under 100 MB; 256 MB is the safety ceiling.
const HUFFMAN_LIFETIME_BYTES = 256 * 1024 * 1024;

// Pre-c2s deadline (audit WS-H2). After WS upgrade succeeds, the client
// has 30s to send its first byte. Otherwise we close — defends against
// silent connection-pinning.
const WS_FIRST_C2S_DEADLINE_MS = 30_000;

// Game-phase retry backoff (audit WS-C2). Without a delay, a degraded
// upstream lets each session burn its 8 retries in milliseconds and
// repeat across thousands of concurrent sessions = connection-amplification
// gadget. Exponential backoff: attempt N waits BASE_MS * 2^(N-1).
const WS_RETRY_BACKOFF_BASE_MS = 100;     // 100, 200, 400, 800, 1.6s, 3.2s…
const WS_RETRY_BACKOFF_MAX_MS = 3_000;    // cap individual delay
// Global semaphore on in-flight retries across ALL sessions. Past this
// many simultaneous retries the upstream is clearly broken; further
// retries are dropped instead of piling on more TCP connects.
const GLOBAL_RETRY_INFLIGHT_CAP = 16;
let globalRetriesInflight = 0;

// ── helpers ──────────────────────────────────────────────────────────────────

function clientIpFromReq(req: http.IncomingMessage): string {
  // Mirrors AssetServer.clientIp(): only honour XFF when we expect a trusted
  // reverse proxy hop count. Otherwise the header is attacker-controlled.
  if (TRUST_PROXY_HOPS > 0) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      const idx = Math.max(0, parts.length - TRUST_PROXY_HOPS);
      if (parts[idx]) return parts[idx];
    }
    const xri = req.headers['x-real-ip'];
    if (typeof xri === 'string' && xri.length > 0) return xri;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Same-origin / allow-list check on the WS upgrade Origin header. Defeats
 * cross-origin WS hijack from a malicious page (audit R2-H-2). Browsers
 * always send `Origin` on a WS upgrade; non-browsers usually omit it which
 * we also reject.
 */
export function isAllowedOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  const originLc = origin.toLowerCase();
  // Same-origin check via Host. Use $http_host-style raw value (preserves
  // the port). Compare case-insensitively (R2-M-3).
  const xfh = req.headers['x-forwarded-host'];
  const fwdHost = (typeof xfh === 'string' && xfh) ? xfh.split(',')[0].trim() : null;
  const host = (fwdHost ?? req.headers.host ?? '').toLowerCase();
  if (host && (originLc === `http://${host}` || originLc === `https://${host}`)) return true;
  for (const allowed of getPublicOrigins()) if (allowed.toLowerCase() === originLc) return true;
  return false;
}

/**
 * Pick the rewrite target IPv4 + port for the 0x8C packet. Per-session,
 * derived from the upgrade's Host header so a deploy at e.g. 192.168.x.x
 * sends the right address back to the client (R2-H-5).
 */
function resolveProxyAddress(req: http.IncomingMessage): { ipv4: number[]; port: number } {
  const xfh = req.headers['x-forwarded-host'];
  const fwdHost = (typeof xfh === 'string' && xfh) ? xfh.split(',')[0].trim() : null;
  const hostHeader = fwdHost ?? req.headers.host ?? '';
  const [hostPart, portPart] = hostHeader.split(':');
  const port = parseInt(portPart, 10);
  // If the hostPart parses cleanly as an IPv4, use it; otherwise fall back.
  // Hostnames need DNS resolution which we don't do here — operator must
  // set PROXY_WS_HOST to a literal IPv4 in that case.
  const candidate = (hostPart && /^\d+\.\d+\.\d+\.\d+$/.test(hostPart)) ? hostPart : PROXY_WS_HOST_FALLBACK;
  const parts = candidate.split('.').map(Number);
  const ipv4 = (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255))
    ? parts
    : [127, 0, 0, 1];
  return {
    ipv4,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : PROXY_WS_PORT,
  };
}

/**
 * Scan `buf` for a 0x8C packet and rewrite the embedded server IP / port so
 * the browser reconnects to our proxy instead of the real game server.
 *
 * Bounded scan window (R2-H-4): we only walk the first SCAN_0x8C_MAX_BYTES
 * of the buffer. The legitimate ConnectToGameServer packet sits at a
 * deterministic position right after the ServerList (≪ 1 KiB), so this is
 * always sufficient and prevents an O(N) walk amplification attack from a
 * compromised upstream.
 */
/**
 * @param skipAuthIdSwap  Set true for encrypted shards (encrypt ≠ 'none').
 *   The authID swap patches the 4-byte auth ID in the s2c 0x8C packet so its
 *   high byte ≠ 0xEF, preventing ModernUO's LONG-seed sniff from firing.
 *   With encryption active the client would re-encrypt the swapped value and
 *   the server-side decryption would produce a different number than what was
 *   in the swap table, causing a login failure. Encrypted shards (SphereServer
 *   etc.) don't have ModernUO's 0xEF sniff, so the swap is unnecessary and
 *   counter-productive — skip it.
 */
function rewrite0x8C(
  buf: Buffer,
  target: { ipv4: number[]; port: number },
  remoteAddr: string,
  skipAuthIdSwap = false,
  /** WS M-2: the requesting session's own swap map. The shadow→original
   *  mapping is stored here so only this session's c2s lookup can resolve
   *  it. Undefined ⇒ skip the swap (encrypted shards pass skipAuthIdSwap). */
  swapMap?: AuthIdSwapMap,
): Buffer {
  const limit = Math.min(buf.length - PACKET_0x8C_LEN, SCAN_0x8C_MAX_BYTES);
  for (let i = 0; i <= limit; i++) {
    if (buf[i] === 0x8c) {
      const out = Buffer.from(buf);
      const origIp = `${buf[i + 1]}.${buf[i + 2]}.${buf[i + 3]}.${buf[i + 4]}`;
      const origPort = (buf[i + 5] << 8) | buf[i + 6];
      out[i + 1] = target.ipv4[0];
      out[i + 2] = target.ipv4[1];
      out[i + 3] = target.ipv4[2];
      out[i + 4] = target.ipv4[3];
      out[i + 5] = (target.port >> 8) & 0xff;
      out[i + 6] = target.port & 0xff;
      console.log(
        `[UOProxy] 0x8C intercepted: rewriting ${origIp}:${origPort} → ${target.ipv4.join('.')}:${target.port}`
      );
      if (!skipAuthIdSwap && swapMap) {
        // Auth ID lives at offset i+7 (4 bytes BE). If high byte is 0xEF the
        // CUO client will trigger ModernUO's LONG-seed sniff in game phase —
        // shadow it here so the value the client echoes back is safe.
        // Skipped for encrypted shards — see parameter JSDoc.
        swapMap.maybeShadow0xEF(out, i + 7, '0x8C relay', remoteAddr);
      }
      return out;
    }
  }
  return buf;
}

// ── 0xEF AuthID swap (CUO ↔ ModernUO protocol mismatch workaround) ────────────
//
// ModernUO's NetState.HandleReceive() distinguishes a LOGIN-phase LONG seed
// (0xEF + 21 bytes) from a GAME-phase SHORT seed (4 raw bytes) purely by the
// first byte of the connection: 0xEF → LoginServer_AwaitingLogin. The CUO
// game-phase reconnect (LoginScene.HandleRelayServerPacket) sends the auth
// ID as 4 raw bytes (the SHORT seed) — when ModernUO's IncomingAccountPackets.
// GenerateAuthID happens to produce a value whose high byte is 0xEF (50% top
// bit flip × 1/128 high-byte uniform = ~1/256 per login), the server reads
// the 4 bytes as the start of a LONG seed, blocks waiting for 17 more bytes,
// then once the bundled 0x91 GameServerLogin arrives it consumes 21 bytes as
// LONG seed (with garbage version fields), reads byte 21 (= mid-username NUL
// 0x00) as the next packet ID, sees it isn't 0x80 → "Possible encrypted
// client detected, disconnecting...". Confirmed by ModernUO
// network-disconnects.log entry "0x00 with length 48" (= 69-21).
//
// The CUO client cannot work around this on its own: the auth ID it sends
// MUST exactly match what ModernUO emitted in the 0x8C relay packet so the
// server's `_authIDWindow.TryGetValue(authId, …)` lookup passes. So we fix
// it in the proxy: rewrite the auth ID in the s2c 0x8C packet to a safe
// shadow value (high byte ≠ 0xEF), remember the (shadow → original)
// mapping, and translate the value back when the client returns it via the
// c2s SHORT seed + the inner 0x91 authID. ModernUO sees the original
// bytes; the CUO client sees a benign shadow. Transparent both ways.
//
// LIMITATION: this assumes encryption is OFF on the shard. If
// Twofish/Blowfish gets enabled, the seed is also fed into key derivation
// — server would derive keys from `original`, client from `shadow`, and
// crypto would mismatch. Gate behind a config flag if that day comes.
export const AUTH_ID_SWAP_TTL_MS = 60_000;

/**
 * WS M-2 fix: the shadow→original auth-ID map used to be a single
 * process-global `Map` shared by every session. Because the c2s lookup
 * consulted it globally, a client whose 4-byte SHORT seed happened to
 * collide with ANOTHER session's active shadow would resolve to that
 * other session's real auth ID — a cross-session coupling. Exploitation
 * is ~1/2³¹ (crypto-random shadow) so this is defence-in-depth, but the
 * correct shape is per-session ownership: each `Session` carries its own
 * `AuthIdSwapMap` and the c2s lookup only ever consults the requesting
 * session's own entries. With the map scoped per session there is no
 * shared namespace for a foreign shadow to be found in.
 *
 * This is the fully per-session refactor (the cleaner of the two options
 * in the audit): no global map exists any more.
 */
export class AuthIdSwapMap {
  private readonly map = new Map<number, { original: number; expires: number }>();

  /** Picks a 31-bit positive value as the shadow auth ID. With the top
   *  bit cleared the high byte is in 0x00..0x7F — never 0xEF, so
   *  ModernUO's AwaitingSeed branch correctly classifies it as a SHORT
   *  seed and routes to GameServer_AwaitingGameServerLogin. Loops until
   *  the value is unused in this session's swap map. */
  private generateShadow(): number {
    // SECURITY: must be cryptographically random. V8's Math.random is
    // xorshift128+ and reversible from a handful of outputs — an attacker
    // who observes their own assigned shadows could otherwise predict a
    // value and forge a SHORT-seed packet. crypto.randomInt is CSPRNG.
    for (let attempts = 0; attempts < 100; attempts++) {
      const v = crypto.randomInt(0, 0x80000000); // [0, 2^31-1], top bit = 0
      if (!this.map.has(v)) return v;
    }
    throw new Error('authIdSwapMap saturated — refusing to issue shadow auth ID');
  }

  prune(now: number = Date.now()): void {
    for (const [k, v] of this.map) {
      if (v.expires <= now) this.map.delete(k);
    }
  }

  /** Rewrites the 4-byte auth ID at `offset` if its high byte is 0xEF. */
  maybeShadow0xEF(buf: Buffer, offset: number, label: string, remoteAddr: string): boolean {
    const original = buf.readUInt32BE(offset);
    if (((original >>> 24) & 0xff) !== 0xef) return false;
    this.prune();
    const shadow = this.generateShadow();
    this.map.set(shadow, { original, expires: Date.now() + AUTH_ID_SWAP_TTL_MS });
    buf.writeUInt32BE(shadow, offset);
    console.log(
      `[UOProxy] [${remoteAddr}] [authid-swap] s2c ${label}: shadowing 0x${original.toString(16).padStart(8, '0')} → 0x${shadow.toString(16).padStart(8, '0')} (high byte was 0xEF — would collide with LONG-seed sniff in ModernUO AwaitingSeed)`
    );
    return true;
  }

  /** If `value` matches a stored shadow for THIS session, returns the
   *  original auth ID. A shadow from another session is never visible
   *  here because each session owns a distinct map. */
  lookupOriginal(shadow: number): number | null {
    const entry = this.map.get(shadow);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      this.map.delete(shadow);
      return null;
    }
    return entry.original;
  }

  /** Number of live (incl. not-yet-pruned) shadow entries. Test seam. */
  get size(): number {
    return this.map.size;
  }

  /** Test seam: backdate a stored shadow's TTL so expiry-path tests don't
   *  have to sleep AUTH_ID_SWAP_TTL_MS. No production caller. */
  expireForTest(shadow: number): void {
    const entry = this.map.get(shadow);
    if (entry) entry.expires = Date.now() - 1;
  }
}

// ── Pattern B fix — handshake-phase batched bundle split ──────────────────────
//
// ModernUO's TcpServer.ProcessSocketConnection does a SocketFlags.Peek on a
// 128-byte buffer with a 500ms timeout, then validates bytesRead against a
// strict shape table:
//   4
//   8 (with 0xF1 magic)
//   ≥66 + [4]=0x80   (older clients)
//   ≥83 + [0]=0xEF + [21]=0x80   (newer LONG seed + login)
//   21  + [0]=0xEF                (LONG seed alone)
//   ≥69 + [4]=0x91                (game-phase short seed + 0x91)
// Anything else → ForceCloseSocket (no log).
//
// Socket.ReceiveAsync returns when ≥1 byte is available, NOT when the full
// buffer is filled. So if the kernel hands ModernUO a chunk smaller than the
// minimum-valid count for its shape, peek validation rejects it silently.
// Local loopback usually delivers atomically; Cloudflare's WS hop and the
// intra-Docker bridge on NAS prod fragment unpredictably (~tens of percent
// of logins).
//
// Two batched shapes the wasm CUO can produce on its first c2s emission:
//
//   (a) Login-phase 0xEF + 0x80 batched, 83 bytes:
//       [0]=0xEF, [21]=0x80. Risk: kernel hands ModernUO any chunk in 1..82
//       except {4, 21, 8 (with magic)} → reject. Split at byte 21 so the
//       first peek sees the 21-byte LONG-seed-alone shape (matches `==21
//       && [0]=0xEF` ✓). The 0x80 + 62-byte AccountLogin lands on the next
//       recv after NetState is in LoginServer_AwaitingLogin.
//
//   (b) Game-phase SHORT seed + 0x91 batched, 69 bytes:
//       [4]=0x91. Risk: chunks in 5..68 → reject. Split at byte 4 so the
//       first peek sees `==4` ✓ (game-phase SHORT seed). The 65-byte
//       0x91 lands on the next recv after NetState is in
//       GameServer_AwaitingGameServerLogin.
//
// With setNoDelay(true) (already active) each .write() maps 1:1 to a TCP
// segment, so the splits hold.
export function splitBatchedHandshake(buf: Buffer): Buffer[] {
  // Login-phase 0xEF + 0x80 batched (83 bytes) → split at byte 21.
  if (buf.length === 83 && buf[0] === 0xef && buf[21] === 0x80) {
    return [buf.subarray(0, 21), buf.subarray(21, 83)];
  }
  // Game-phase SHORT seed + 0x91 batched (69 bytes) → split at byte 4.
  if (buf.length === 69 && buf[4] === 0x91) {
    return [buf.subarray(0, 4), buf.subarray(4, 69)];
  }
  return [buf];
}

// Back-compat alias — older test name, kept until callers migrate.
export const splitGameLoginBatched = splitBatchedHandshake;

// ── Session ───────────────────────────────────────────────────────────────────

class Session {
  // Mutable so the Pattern B retry path can swap the underlying socket
  // when ModernUO's ThreadStatic+async race fires a silent FIN.
  private tcpSocket: net.Socket;
  private tcpBuf: Buffer = Buffer.alloc(0);
  private tcpClosed = false;
  private wsClosed = false;
  private skip8CScan = false;
  private bytesScanned = 0;
  private tcpPaused = false;
  private destroyed = false;
  private readonly proxyAddress: { ipv4: number[]; port: number };
  private readonly onClosed: () => void;
  // WS L-3 fix: `onClosed` decrements the per-IP counter and must run
  // EXACTLY ONCE per session. maybeCleanup() can converge twice — most
  // notably the force-close timer path: the timer callback runs
  // onClosed(), then its own destroy()→ws.terminate() emits a 'close'
  // event whose handler calls maybeCleanup() again. This flag makes the
  // decrement idempotent regardless of how many times cleanup converges.
  private onClosedFired = false;
  private cleanupTimeout: ReturnType<typeof setTimeout> | null = null;

  // Path C v0.1.9 — server-side Huffman decode for the wasm client. The
  // client receives the resulting raw bytes over WS and skips its own
  // Huffman pass (NetClient.cs DecompressBuffer is a pass-through under
  // BROWSER_WASM in v0.1.9+). Doing the decode here on the stable
  // NAS-local TCP side eliminates the bit-stream alignment loss that
  // hung wasm logins behind Cloudflare WSS framing.
  //
  // The TS port has byte-equal parity tests vs the desktop C# decoder
  // in `server/test/Huffman.test.ts`; CI/local gate any regression.
  private readonly huffman = new Huffman();
  private compressionEnabled = false;

  // WS M-2 fix: per-session shadow→original auth-ID swap map. Replaces the
  // former process-global `authIdSwapMap`. Scoping it to the session means
  // a c2s lookup can only ever resolve THIS session's own shadows — a
  // SHORT seed that collides with another session's shadow finds nothing.
  private readonly authIdSwap = new AuthIdSwapMap();

  // Per-session counters used by the silent-FIN retry path: when the TCP
  // closes with c2sCount===1 && s2cCount===0 and we have a buffered
  // batched-handshake bundle, that's the ThreadStatic-race signature
  // (see project memory `project_modernuo_threadstatic_race.md`). t0 is
  // set on TCP connect for the elapsed() timestamps in close/end logs.
  private t0 = 0;
  private c2sCount = 0;
  private s2cCount = 0;
  // v0.3.47 s2c packet-cadence diag. Operator reports microhitches
  // every ~1.5 s when running, plus a `why=PlayerMoved` cadence in
  // the (now-removed) v0.3.42 fill-diag log. Hypothesis: ModernUO
  // is pushing periodic position re-sync packets (suspect 0x77) that
  // invalidate the client's cache + force a full chunk-loop pass.
  // The diag captures s2c packet-type cadence in a 60s window after
  // first traffic, then prints ONE summary line and disables itself.
  // Zero ongoing overhead post-window.
  private s2cDiagEnabled = true;
  private s2cDiagStartMs = 0;
  private s2cTypeCount: Map<number, { count: number; firstMs: number; lastMs: number }> = new Map();
  // Deferred close handle, set on TCP FIN, cleared if the client closes
  // the WS first or the session is destroyed.
  private wsCloseAfterFinTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Pattern B workaround: game-phase retry on ThreadStatic race ──────────
  // ModernUO TcpServer.cs:160-172 has a [ThreadStatic] _firstBytes buffer
  // re-evaluated AFTER an `await` on ReceiveAsync(Peek). When the await
  // suspends and resumes on a different ThreadPool thread, the post-await
  // _firstBytes read returns a DIFFERENT thread's buffer (usually with
  // stale or undefined bytes), so `_firstBytes[0]==0xEF` / `[4]==0x91`
  // checks fail randomly even though the wire data is correct. tcpdump
  // proves the bytes arrive: the race is purely server-side. Result:
  // silent ForceCloseSocket with no log entry, ~75% of game-phase logins.
  //
  // We can't fix ModernUO (project rule). Workaround: when the game-phase
  // first c2s message has been forwarded and ModernUO closes the TCP
  // without sending any s2c data, open a new TCP connection and replay
  // the same bundle. The authID stays in _authIDWindow because the
  // failed peek path never ran GameLogin; subsequent retries have
  // independent ~25% success chances, so 5 retries → ~76% success,
  // 8 retries → ~90%.
  private static readonly GAME_PHASE_RETRY_MAX = 8;
  private gamePhaseRetryBuf: Buffer | null = null;
  // v0.3.10 diagnostic: capture the FIRST c2s packet's length + first 4
  // bytes (hex) so the FIN handler can log them without re-reading the
  // raw TCP buffer. Used to confirm whether real-world clients send the
  // 83-byte 0xEF login bundle or 69-byte 0x91 game bundle that the
  // batched-handshake detection expects.
  private firstC2sLen: number | null = null;
  private firstC2sFirst4: string | null = null;
  private gamePhaseRetryAttempts = 0;

  // v0.3.15-A timing fix: we tried emitting 0xA4 BEFORE any client byte,
  // but ModernUO's TcpServer.ProcessSocketConnection peek-validates the
  // first 128 bytes against a hard-coded list of valid login starts
  // (0xEF/0x80/0x91 patterns). 0xA4 is not on that list, so the socket
  // is silently FIN'd before NetState ever exists and our handler never
  // runs. Fix: send 0xA4 INSIDE the c2s flow, immediately after the
  // first wasm-side packet is forwarded — at that point the peek has
  // already validated against the 0xEF login bundle and NetState reads
  // 0xA4 as the next packet, dispatching to our handler. Reset to false
  // on the Pattern B retry path so a fresh TCP gets the preamble.
  private webIdentitySent = false;

  // Per-session c2s rate-limit state (audit WS-C1). Token bucket refilled
  // continuously; each WS message consumes one token regardless of size.
  // The size cap is enforced separately below.
  private c2sTokens = WS_C2S_BURST;
  private c2sLastRefill = Date.now();
  private c2sLifetimeBytes = 0;

  /**
   * Derives the killer's name from the shard's OWN packets, so the public widget never prints a
   * string the browser made up. See deathWatch.ts for the reasoning, including why a character
   * filter is not the fix.
   *
   * 🚨 ONLY FOR PLAINTEXT SESSIONS. On an encrypted shard these bytes are ciphertext: parsing them
   * would not merely fail, it would read random bytes as names — the exact outcome this exists to
   * prevent. Null there, and a death then publishes with no name at all, which is the safe side.
   * Built lazily so a session that never dies costs one null field.
   */
  private deathWatch: DeathWatch | null = null;

  // Cumulative Huffman output budget per session (audit WS-H1). Decremented
  // on every successful decode; if it ever runs out the session is dropped
  // — almost certainly indicates a compromised or malicious upstream.
  private huffmanRemainingBytes = HUFFMAN_LIFETIME_BYTES;

  // Pre-c2s deadline timer (audit WS-H2). Cleared on first c2s message.
  private firstC2sDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  isFullyClosed(): boolean { return this.tcpClosed && this.wsClosed; }

  constructor(
    private readonly ws: WebSocket,
    readonly remoteAddr: string,
    proxyAddress: { ipv4: number[]; port: number },
    /** Resolved by the registry from the WS upgrade's `?server=<slug>`
     *  query. The session's TCP socket connects to this host/port for
     *  its entire lifetime — slug binding is once-per-WS-upgrade and
     *  cannot be changed mid-session. Pattern-B retries reconnect to
     *  the same target.
     *
     *  `encrypt` mirrors the shard's EncryptType ('none', 'blowfish_2_0_3',
     *  etc.). The proxy never performs the crypto itself — bytes flow
     *  through verbatim. But `encrypt` gates two proxy-side behaviours:
     *  (1) Huffman s2c detection (only needed for ModernUO / encrypt=none
     *      shards; old servers like SphereServer don't compress s2c), and
     *  (2) 0xEF authID shadowing in the 0x8C relay (only needed to work
     *      around ModernUO's LONG-seed sniff; incorrect for encrypted
     *      sessions where the encrypted 0x91 body can't be patched). */
    private readonly target: {
      slug: string;
      host: string;
      port: number;
      encrypt: string;
      /** v0.3.15: per-shard WebIdentity opt-in. When `enabled: true` the
       *  proxy emits a 0xA4 preamble carrying real client IP + secret. */
      webIdentity?: { enabled: boolean; secret: string };
      /** v0.8.43: untrusted self-service shard. When true, connectTcp resolves
       *  the host and PINS a verified public IP (anti DNS-rebind SSRF). */
      selfService?: boolean;
      /** v0.9.131: host/port set by an untrusted owner on a non-self-service
       *  shard — same connect-time resolve-pin as selfService (audit 2026-06-21). */
      untrustedHost?: boolean;
    },
    onClosed: () => void = () => {},
    /** v0.3.14: Discord JWT sub captured at WS upgrade — used by the
     *  admin ban-list force-close path. null for guests. */
    readonly discordSub: string | null = null,
    /** v0.3.15: bundle of user-identity fields the WebIdentity frame
     *  needs. Resolved once at WS upgrade. Empty/null fields are normal
     *  for guests. */
    private readonly identity: {
      userId: string;
      discordUsername: string;
      // Feature #76: the mini roles may carry a `-<minigame>` suffix
      // ('mini-player-towerdefense'); widened to `string` so the dynamic value
      // built at WS upgrade type-checks. The literals stay for documentation.
      role: 'user' | 'admin' | 'shard-owner' | 'mini-player' | 'mini-guest' | string;
      /** MINI auto-login (Discord OR guest). externalAuthProvider/Id override the
       *  discordSub-derived 0xA4 fields; miniAccount/miniSub drive the 0x80 rewrite
       *  (account to inject + password-derivation seed). Unset for normal sessions. */
      externalAuthProvider?: string;  // 'Discord' | 'Guest' | ''
      externalAuthId?: string;        // discordSub | guestSub | ''
      miniAccount?: string;           // 0x80 account to inject ('d<id>' | 'g<hex>')
      miniSub?: string;               // password-derivation seed
      miniAutologin?: boolean;        // v0.9.224: per-shard mini auto-login active
                                      // (target.autologin || global MINI_AUTOLOGIN);
                                      // gates the 0x80 rewrite + 0xA4 game-phase suppression
    } = { userId: '', discordUsername: '', role: 'user' },
  ) {
    this.onClosed = onClosed;
    this.proxyAddress = proxyAddress;
    this.tcpSocket = this.makeTcpSocket();
    this.attachTcpHandlers();
    this.attachWsHandlers();
    this.connectTcp();

    // Arm the pre-c2s deadline (audit WS-H2). If the client connects but
    // never sends the first packet, drop the session before it eats an
    // FD slot and a TCP socket on the upstream UO server for 15 minutes.
    this.firstC2sDeadlineTimer = setTimeout(() => {
      if (this.c2sCount === 0 && !this.destroyed) {
        console.warn(
          `[UOProxy] [${this.remoteAddr}] no c2s within ${WS_FIRST_C2S_DEADLINE_MS}ms — closing idle session`
        );
        if (!this.wsClosed && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(1008, 'pre-c2s deadline');
        }
        this.destroy();
      }
    }, WS_FIRST_C2S_DEADLINE_MS);
  }

  // Token-bucket gate for c2s WS messages (audit WS-C1). Returns true if
  // the message should be accepted; false to drop + close the session.
  private allowC2s(byteLen: number): boolean {
    const now = Date.now();
    const elapsedSec = (now - this.c2sLastRefill) / 1000;
    if (elapsedSec > 0) {
      this.c2sTokens = Math.min(WS_C2S_BURST, this.c2sTokens + elapsedSec * WS_C2S_REFILL_PER_SEC);
      this.c2sLastRefill = now;
    }
    if (this.c2sTokens < 1) return false;
    this.c2sTokens -= 1;
    this.c2sLifetimeBytes += byteLen;
    if (this.c2sLifetimeBytes > WS_C2S_LIFETIME_BYTES) return false;
    return true;
  }

  private makeTcpSocket(): net.Socket {
    const sock = new net.Socket();
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15_000);
    sock.setTimeout(TCP_IDLE_TIMEOUT_MS);
    return sock;
  }

  private connectTcp(): void {
    // v0.3.14: register the upstream socket with the shard-cooldown tracker
    // BEFORE the connect call so an immediate FIN arriving with c2sBytes=0
    // is correctly attributed to a per-IP shard block. The tracker uses
    // a WeakMap keyed on socket — every fresh socket from makeTcpSocket()
    // re-registers on retry.
    registerUpstreamConnect(this.tcpSocket, this.target.slug);
    // v0.8.43 SSRF: an untrusted shard host is resolved + PINNED to a verified
    // PUBLIC IP, so a DNS rebind can't redirect the bridge into our LAN /
    // cloud-metadata. Applies to self-service shards AND non-self-service shards
    // whose host an owner-tier editor set (untrustedHost — audit 2026-06-21).
    // Operator shards never touched by an owner keep the direct connect (they
    // legitimately point at internal docker/LAN hosts).
    if (this.target.selfService || this.target.untrustedHost) {
      resolvePublicIp(this.target.host)
        .then((ip) => { this.tcpSocket.connect(this.target.port, ip, () => this.onUpstreamConnected()); })
        .catch((e) => {
          console.warn(`[UOProxy] [${this.remoteAddr}] refusing untrusted-host connect ${this.target.slug} (${this.target.host}): ${(e as Error).message}`);
          try { this.tcpSocket.destroy(); } catch { /* already gone */ }
        });
      return;
    }
    this.tcpSocket.connect(this.target.port, this.target.host, () => this.onUpstreamConnected());
  }

  /** Upstream TCP connected — WebIdentity preamble + any buffered retry replay.
   *  Extracted from connectTcp so both the direct and the self-service
   *  (resolve+pin) connect paths share identical post-connect behaviour. */
  private onUpstreamConnected(): void {
      this.t0 = Date.now();
      console.log(
        `[UOProxy] [${this.remoteAddr}] TCP connected → ${this.target.slug} (${this.target.host}:${this.target.port}) (t0)`
      );

      // v0.3.15-A: WebIdentity 0xA4 preamble timing depends on shard type.
      //   - Plaintext (encrypt='none', e.g. ModernUO): emit AFTER first c2s
      //     in maybeSendWebIdentity() (see ws message handler). ModernUO's
      //     TcpServer peek-validation rejects a leading 0xA4 (only 0xEF/
      //     0x80/0x91 are valid login starts).
      //   - Encrypted (encrypt!='none', e.g. Sphere blowfish_2_0_3): emit
      //     RIGHT NOW, before any client byte. Sphere's pre-seed handler
      //     (v0.3.15-B-rev2 patch in CNetworkInput.cpp) reads 0xA4 plaintext
      //     before the stream cipher initialises. Required because the
      //     wasm client sends encrypted bytes after seed; if 0xA4 came
      //     after, Sphere would decrypt it as ciphertext = garbage.
      // For a Pattern B retry on a fresh TCP, reset the sent flag so
      // the new connection gets its own preamble.
      this.webIdentitySent = false;
      this.sendWebIdentityIfEncryptedShard();

      // If we're reconnecting for a game-phase retry, replay the buffered
      // batched 0x91 bundle as soon as the new TCP completes connect.
      if (this.gamePhaseRetryBuf !== null) {
        const buf = this.gamePhaseRetryBuf;
        const parts = splitBatchedHandshake(buf);
        console.log(
          `[UOProxy] [${this.remoteAddr}] [pattern-b-retry] replaying ${buf.length}B bundle on new TCP (attempt ${this.gamePhaseRetryAttempts}/${Session.GAME_PHASE_RETRY_MAX})`
        );
        // MINI game-phase retry: same real-timer split as the first attempt so the
        // 4-byte seed and 65-byte 0x91 land in SEPARATE TCP segments (a setImmediate
        // gap gets coalesced → ModernUO peek rejects the 69B batch). maybeSendWebIdentity
        // is a no-op on the mini game-phase (0xA4 suppressed).
        const _miniGamePhaseRetry = this.identity.miniAutologin && this.skip8CScan;
        if (parts.length > 1) {
          this.tcpSocket.write(parts[0]);
          const _emitSecond = () => {
            if (this.tcpSocket.writable) this.tcpSocket.write(parts[1]);
            // v0.3.15-A: emit WebIdentity preamble right after the
            // replayed login bundle on the fresh retry TCP. Same timing
            // contract as the normal first-c2s path — peek validates on
            // the 0xEF/0x91 bundle, NetState reads 0xA4 next.
            this.maybeSendWebIdentity();
          };
          if (_miniGamePhaseRetry) setTimeout(_emitSecond, 120); else setImmediate(_emitSecond);
        } else {
          this.tcpSocket.write(buf);
          this.maybeSendWebIdentity();
        }
      }
  }

  /**
   * v0.3.15-B-rev2: emit the WebIdentity 0xA4 preamble for ENCRYPTED
   * shards as the very first bytes on the upstream socket — BEFORE the
   * wasm client's seed/login. Sphere's pre-seed handler (CNetworkInput.cpp
   * patch) reads it plaintext before the stream cipher initialises.
   * Plaintext shards SKIP this call; their emission lives in
   * `maybeSendWebIdentity()` which is invoked AFTER the first c2s.
   */
  private sendWebIdentityIfEncryptedShard(): void {
    if (this.webIdentitySent) return;
    if (!this.target.webIdentity?.enabled) return;
    if (!this.tcpSocket.writable) return;
    if (!this.target.encrypt || this.target.encrypt === 'none') {
      // Plaintext shard — handled post-first-c2s by maybeSendWebIdentity.
      return;
    }
    try {
      const frame = buildWebIdentityFrame({
        secret: this.target.webIdentity.secret,
        userId: this.identity.userId,
        connectingIp: normaliseClientIp(this.remoteAddr),
        externalAuthProvider: this.identity.externalAuthProvider ?? (this.discordSub ? 'Discord' : ''),
        externalAuthUsername: this.identity.discordUsername,
        externalAuthId: this.identity.externalAuthId ?? (this.discordSub ?? ''),
        // Feature #76: role may carry a `-<minigame>` suffix; the frame builder
        // writes it verbatim as a strz, so the narrowing cast is compile-time
        // only and runtime-safe (full name flows through unchanged).
        role: this.identity.role as WebIdentityFields['role'],
      });
      this.tcpSocket.write(frame, (err) => {
        if (err) console.error(`[UOProxy] [${this.remoteAddr}] [webident-pre] write error: ${err.message}`);
      });
      this.webIdentitySent = true;
      recordC2sBytes(this.tcpSocket, frame.length);
      console.log(
        `[UOProxy] [${this.remoteAddr}] [webident-pre] sent 0xA4 preamble (${frame.length}B) ` +
        `slug=${this.target.slug} encrypt=${this.target.encrypt} userId=${this.identity.userId} role=${this.identity.role}`
      );
    } catch (err) {
      console.error(
        `[UOProxy] [${this.remoteAddr}] [webident-pre] frame build failed: ${(err as Error).message} — proceeding without preamble`
      );
    }
  }

  /**
   * v0.3.15-A: emit the WebIdentity 0xA4 preamble on the upstream socket
   * exactly once per TCP session. Called AFTER the first wasm-side c2s
   * packet has been forwarded, so ModernUO's TcpServer peek validation
   * has already passed against the 0xEF/0x80/0x91 login patterns and a
   * NetState exists to dispatch our 0xA4 to the registered handler. No-op
   * when the shard hasn't opted in via YAML or when called twice.
   */
  private maybeSendWebIdentity(): void {
    if (this.webIdentitySent) return;
    if (!this.target.webIdentity?.enabled) return;
    if (!this.tcpSocket.writable) return;
    // MINI: NEVER inject the 0xA4 on the GAME-PHASE connection (detected via the
    // 0x91 GameServerLogin → skip8CScan). The identity/account is already bound at
    // the LOGIN phase; on the game phase ModernUO expects seed + 0x91 only, and an
    // injected 149-byte 0xA4 right after the 0x91 (or interleaved by the split)
    // corrupts the GameLogin authId read → "Invalid client detected". The login
    // phase still gets its 0xA4 (skip8CScan is false there). prod webclient
    // unaffected (gate on MINI_AUTOLOGIN).
    if (this.identity.miniAutologin && this.skip8CScan) return;
    // v0.3.15-B-rev2: post-seed branch. Plaintext shards (encrypt='none',
    // e.g. ModernUO) emit 0xA4 here, AFTER the wasm's first c2s packet so
    // ModernUO's TcpServer peek-validation passes against the legitimate
    // 0xEF/0x91 login bundle. Encrypted shards take a different path —
    // they emit 0xA4 in `connectTcp` BEFORE any client byte (= plaintext
    // first on the wire), where Sphere's pre-seed handler reads it before
    // the stream cipher initialises. This branch only handles plaintext
    // shards; the connectTcp callback handles encrypted ones via
    // `sendWebIdentityPreSeed()`.
    if (this.target.encrypt && this.target.encrypt !== 'none') {
      // Encrypted path is handled in connectTcp; if we ended up here it
      // means the connectTcp emission already ran and set webIdentitySent
      // — we should never get this far. Safety no-op.
      return;
    }
    try {
      const frame = buildWebIdentityFrame({
        secret: this.target.webIdentity.secret,
        userId: this.identity.userId,
        connectingIp: normaliseClientIp(this.remoteAddr),
        externalAuthProvider: this.identity.externalAuthProvider ?? (this.discordSub ? 'Discord' : ''),
        externalAuthUsername: this.identity.discordUsername,
        externalAuthId: this.identity.externalAuthId ?? (this.discordSub ?? ''),
        // Feature #76: see webident-pre — narrowing cast is runtime-safe.
        role: this.identity.role as WebIdentityFields['role'],
      });
      this.tcpSocket.write(frame, (err) => {
        if (err) {
          console.error(
            `[UOProxy] [${this.remoteAddr}] [webident] write error: ${err.message}`
          );
        }
      });
      this.webIdentitySent = true;
      recordC2sBytes(this.tcpSocket, frame.length);
      console.log(
        `[UOProxy] [${this.remoteAddr}] [webident] sent 0xA4 preamble (${frame.length}B) ` +
        `slug=${this.target.slug} userId=${this.identity.userId} role=${this.identity.role}`
      );
    } catch (err) {
      console.error(
        `[UOProxy] [${this.remoteAddr}] [webident] frame build failed: ${(err as Error).message} — proceeding without preamble`
      );
    }
  }

  private miniLoginRewritten = false;
  /**
   * MINI auto-login: rewrite the c2s account+password so BOTH login phases use the
   * Discord/guest-bound account (d<id>/g<hex>) + the internal HMAC password (the
   * value eternal's MiniAutoLogin.cs sets). The client only knows a placeholder
   * username ("mini" from -username), so without rewriting the GAME-phase 0x91 too
   * the server's GameServerLoginEvent re-auth rejects "mini" even though the authId
   * matched (root-caused 2026-06-15 via [MINI-DIAG]: first GameLogin found=True but
   * the connection still FIN'd — the username re-check failed). Both packets carry
   * the account at `acctOff` and the password at `acctOff+30` (fixed 30-byte fields):
   *   • 0x80 AccountLogin   standalone 62B → acctOff 1   |  seed-batched 0xEF+0x80 83B → 22
   *   • 0x91 GameServerLogin standalone 65B → acctOff 5   |  seed-batched 4B+0x91 69B  → 9
   * Plaintext shards only; once per session (the login + game phases are separate
   * sessions, each rewrites its own first packet); gated by MINI_AUTOLOGIN+miniAccount.
   */
  private maybeRewriteMiniLogin(outBuf: Buffer): Buffer {
    if (!this.identity.miniAutologin || !this.identity.miniAccount || this.miniLoginRewritten) return outBuf;
    if (this.target.encrypt && this.target.encrypt !== 'none') return outBuf;
    let acctOff = -1;
    let kind = '';
    if (outBuf.length >= 62 && outBuf[0] === 0x80) { acctOff = 1; kind = '0x80'; }
    else if (outBuf.length >= 83 && outBuf[0] === 0xef && outBuf[21] === 0x80) { acctOff = 22; kind = '0xEF+0x80'; }
    else if (outBuf.length >= 65 && outBuf[0] === 0x91) { acctOff = 5; kind = '0x91'; }
    else if (outBuf.length >= 69 && outBuf[4] === 0x91) { acctOff = 9; kind = 'seed+0x91'; }
    // v0.9.226: legacy AccountLogin = [4-byte seed][0x80][30B user][30B pass].
    // A pre-6.0.5 client (the mini on a 3.0.8-era AoS shard) puts the 0x80 at
    // offset 4 — not offset 0 (standalone) or 21 (0xEF-batched) — so the placeholder
    // username was never rewritten to g<hex> and the shard rejected the login (0x82)
    // before MiniAutoLogin could bind the account. The username sits right after the
    // 1-byte 0x80 cmd (no 4-byte AuthId like the 0x91 game login) → acctOff 5.
    else if (outBuf.length >= 66 && outBuf[4] === 0x80) { acctOff = 5; kind = 'seed+0x80'; }
    if (acctOff < 0) return outBuf;
    const account = this.identity.miniAccount.slice(0, 30);
    const password = deriveMiniPassword(this.target.webIdentity?.secret ?? '', this.identity.miniSub ?? '').slice(0, 30);
    const out = Buffer.from(outBuf);              // writable copy
    out.fill(0, acctOff, acctOff + 60);           // clear 30B account + 30B password
    out.write(account, acctOff, 'ascii');
    out.write(password, acctOff + 30, 'ascii');
    this.miniLoginRewritten = true;

    // 🚨 RECORD THE LOGIN; DO NOT DELIVER ANYTHING HERE. This is the game process, and
    // handing an item over is a call to the minigames shard — the web proxy's job and
    // nobody else's (operator 2026-07-31: "que no vaya al proxy normal ... así si se satura
    // la otra parte web, no afecta al resto de jugadores que solo quieren jugar realmente").
    //
    // This used to drain the loot queue and the item queue right here, on a timer: ~2.5 s
    // bridge round-trips, retries included, on the single event loop that relays live
    // gameplay for EVERY connected player. It is now one local SQLite upsert, and the web
    // process picks it up — see loginSignals.ts, which also owns the settle delay.
    if (this.identity.miniAccount?.startsWith('d')) {
      signalLogin(this.identity.miniAccount.slice(1));
    }
    console.log(`[UOProxy] [${this.remoteAddr}] [mini-autologin] rewrote ${kind} → account=${account} (off ${acctOff})`);
    return out;
  }

  private elapsed(): number {
    return this.t0 === 0 ? -1 : Date.now() - this.t0;
  }

  // ── TCP → WS ────────────────────────────────────────────────────────────

  /**
   * True only where the relay can actually READ the protocol. On an encrypted shard the bytes are
   * ciphertext and walking them would read random data as names — worse than publishing nothing,
   * because it would publish something believable. Also skipped for guests without a sub, who have
   * nowhere to record an observation.
   */
  private canWatchDeaths(): boolean {
    return this.target.encrypt === 'none' && !!this.identity.userId;
  }

  /** Server -> client, already decompressed. Records a witness row when this chunk held the death. */
  private observeServerBytes(inbound: Buffer): void {
    if (!this.canWatchDeaths()) return;
    try {
      if (!this.deathWatch) this.deathWatch = new DeathWatch();
      const killer = this.deathWatch.onServerToClient(inbound);
      // `undefined` is "no death in this chunk"; `null` is "died, no name known" and must still be
      // recorded — a nameless row is what tells the web side to publish a nameless death instead of
      // reaching for whatever the client sent.
      if (killer !== undefined) recordDeathWitness(this.identity.userId, killer);
    } catch (e) {
      // Deliberately swallowed and disabled rather than retried. This runs inside the relay for
      // every player: a parser fault must degrade the widget, never the session. Turning the
      // watcher off also stops a repeating fault from logging on every chunk.
      this.deathWatch = null;
      console.warn(`[UOProxy] [${this.remoteAddr}] deathWatch disabled: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Client -> server, plaintext. Only the attack request is read, and only as a pointer. */
  private observeClientBytes(buf: Buffer): void {
    if (!this.canWatchDeaths() || !this.deathWatch) return;
    try {
      this.deathWatch.onClientToServer(buf);
    } catch {
      this.deathWatch = null;   // same reasoning as above
    }
  }

  private attachTcpHandlers(): void {
    this.tcpSocket.on('data', (chunk: Buffer) => {
      this.s2cCount++;
      // Game-phase retry no longer needed once ModernUO has sent ANY reply —
      // peek validation passed, NetState is alive, race didn't fire.
      this.gamePhaseRetryBuf = null;

      // Path C: when game-phase compression is on, decompress the chunk
      // BEFORE buffering / scanning / forwarding. Decoder is stateful —
      // a partial Huffman code at chunk boundary resumes mid-symbol on
      // the next call. Pre-game-phase data is never compressed, so the
      // existing 0x8C rewrite + scan logic still operates on raw bytes.
      let inbound: Buffer = chunk;
      if (this.compressionEnabled) {
        try {
          inbound = this.huffman.decompress(chunk);
        } catch (err) {
          console.error(
            `[UOProxy] [${this.remoteAddr}] Huffman decompress error: ${(err as Error).message}`
          );
          this.destroy();
          return;
        }
        // Cumulative cap (audit WS-H1). Per-call cap inside Huffman caps
        // ONE call at 64 KiB; without a session-lifetime budget a malicious
        // upstream can pump unbounded GB through repeated 64 KiB windows.
        this.huffmanRemainingBytes -= inbound.length;
        if (this.huffmanRemainingBytes < 0) {
          console.error(
            `[UOProxy] [${this.remoteAddr}] Huffman lifetime cap exceeded (cap=${HUFFMAN_LIFETIME_BYTES}) — destroying`
          );
          this.destroy();
          return;
        }
        // A chunk can decompress to 0 bytes (only EOS marker bits) — skip
        // the rest of the pipeline so we don't send an empty WS frame.
        if (inbound.length === 0) return;
      }

      // Observe the shard's OWN bytes for a death plus the killer's name, before any of the
      // forwarding below and unable to affect it: the watcher only reads, and its failure must
      // never cost a player their session over what is ultimately a cosmetic widget.
      this.observeServerBytes(inbound);

      // Hard cap on accumulated buffer — defends against an upstream that
      // streams data we haven't been able to forward yet.
      if (this.tcpBuf.length + inbound.length > TCP_BUF_MAX_BYTES) {
        console.warn(`[UOProxy] [${this.remoteAddr}] tcpBuf would exceed ${TCP_BUF_MAX_BYTES} B — destroying`);
        this.destroy();
        return;
      }
      this.tcpBuf = Buffer.concat([this.tcpBuf, inbound]);

      // rev11: skip the entire 0x8C scan for encrypted shards. The scan
      // matches a single byte 0x8C and rewrites the next 6 bytes as IP+port;
      // on encrypted s2c traffic that's a 1/256-per-byte chance of mutating
      // ciphertext (376 bytes received in a Sphere game-phase reply ≈ 1.5
      // expected false positives), each scrambling a 6-byte window and
      // destroying Blowfish/Twofish stream decryption. The IP+port rewrite
      // is also pointless for encrypted shards: the wasm CUO logs
      // "Ignoring relay server packet IP address" and reuses its existing
      // WS URL regardless of what's in the (encrypted) 0x8C body.
      let rewritten: Buffer;
      if (this.target.encrypt !== 'none') {
        rewritten = this.tcpBuf;
        this.skip8CScan = true;
      } else if (!this.skip8CScan) {
        rewritten = rewrite0x8C(
          this.tcpBuf, this.proxyAddress, this.remoteAddr,
          false,
          this.authIdSwap,
        );
        if (rewritten !== this.tcpBuf) {
          this.skip8CScan = true;
        } else {
          // After SCAN_0x8C_MAX_BYTES of upstream data without a 0x8C, give
          // up the search — Huffman-compressed game data must be forwarded
          // verbatim and cannot be scanned by string-match.
          this.bytesScanned += inbound.length;
          if (this.bytesScanned >= SCAN_0x8C_MAX_BYTES) this.skip8CScan = true;
        }
      } else {
        rewritten = this.tcpBuf;
      }

      // Backpressure: if the WS send queue is large, pause the TCP read so
      // we don't accumulate more. The WS 'drain' handler resumes us.
      const buffered = this.ws.bufferedAmount;
      if (buffered > WS_BUFFERED_KILL_BYTES) {
        console.warn(`[UOProxy] [${this.remoteAddr}] ws.bufferedAmount=${buffered} > kill threshold — destroying`);
        this.destroy();
        return;
      }
      if (buffered > WS_BUFFERED_PAUSE_BYTES && !this.tcpPaused) {
        this.tcpSocket.pause();
        this.tcpPaused = true;
      }

      // v0.3.47 s2c-diag: sample packet-type cadence for 60 s, then
      // emit a single summary line and self-disable.
      if (this.s2cDiagEnabled && rewritten.length > 0) {
        const now = Date.now();
        if (this.s2cDiagStartMs === 0) {
          this.s2cDiagStartMs = now;
        }
        if (now - this.s2cDiagStartMs > 60_000) {
          this.s2cDiagEnabled = false;
          const parts: string[] = [];
          const byCount = Array.from(this.s2cTypeCount.entries())
            .sort((a, b) => b[1].count - a[1].count);
          for (const [type, data] of byCount) {
            const dur = data.lastMs - data.firstMs;
            const avgDtMs = data.count > 1 ? Math.round(dur / (data.count - 1)) : 0;
            parts.push(`0x${type.toString(16).padStart(2, '0')}:n=${data.count}/avgDt=${avgDtMs}ms`);
          }
          console.log(
            `[UOProxy] [${this.remoteAddr}] [s2c-diag] 60s window: ${parts.join(' ')}`
          );
        } else {
          const t = rewritten[0];
          const cur = this.s2cTypeCount.get(t);
          if (cur) {
            cur.count++;
            cur.lastMs = now;
          } else {
            this.s2cTypeCount.set(t, { count: 1, firstMs: now, lastMs: now });
          }
        }
      }

      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(rewritten, { binary: true }, (err) => {
          if (err) {
            console.error(`[UOProxy] [${this.remoteAddr}] WS send error:`, err.message);
            this.destroy();
            return;
          }
          // Resume TCP if we paused and the queue has drained.
          if (this.tcpPaused && this.ws.bufferedAmount < WS_BUFFERED_PAUSE_BYTES / 2) {
            this.tcpSocket.resume();
            this.tcpPaused = false;
          }
        });
      }

      this.tcpBuf = Buffer.alloc(0);
    });

    this.tcpSocket.on('end', () => {
      // The SHARD sent FIN. Recorded so the cool-down tracker can tell a per-IP block from
      // this proxy hanging up because the player's WebSocket went away — see shardCooldown.ts.
      recordPeerClose(this.tcpSocket);
      console.log(
        `[UOProxy] [${this.remoteAddr}] TCP FIN received tEcho=${this.elapsed()}ms c2sCount=${this.c2sCount} s2cCount=${this.s2cCount}`
      );
      // Defer the WS close — see WS_CLOSE_AFTER_TCP_FIN_MS rationale up top.
      // Race repro: the wasm client must drain the just-forwarded 0x8C
      // before the Close frame arrives, otherwise BrowserWebSocket drops
      // the trailing Binary and the user is stuck at "Verifying Account".
      if (!this.wsClosed && this.ws.readyState === WebSocket.OPEN
          && this.wsCloseAfterFinTimer === null) {
        console.log(
          `[UOProxy] [${this.remoteAddr}] scheduling WS close in ${WS_CLOSE_AFTER_TCP_FIN_MS}ms (cancel if client closes first)`
        );
        this.wsCloseAfterFinTimer = setTimeout(() => {
          this.wsCloseAfterFinTimer = null;
          if (!this.wsClosed && this.ws.readyState === WebSocket.OPEN) {
            console.log(
              `[UOProxy] [${this.remoteAddr}] deferred WS close fired tEcho=${this.elapsed()}ms (client did not close in time)`
            );
            this.ws.close(1000, 'Server closed connection');
          }
        }, WS_CLOSE_AFTER_TCP_FIN_MS);
      }
    });

    this.tcpSocket.on('close', (hadError) => {
      console.log(
        `[UOProxy] [${this.remoteAddr}] TCP socket closed tEcho=${this.elapsed()}ms hadError=${hadError}`
      );

      // v0.3.14: feed the close into the shard-cooldown tracker. If the
      // socket FINed within 50 ms of connect AND zero c2s bytes flowed,
      // the tracker enters cool-down for this slug — see shardCooldown.ts.
      // Sessions that wrote at least one frame OR survived past the
      // window are no-ops for the cool-down logic.
      recordImmediateFin(this.tcpSocket);

      // Pattern B retry — workaround for ModernUO TcpServer.cs ThreadStatic
      // + async/await race in `_firstBytes`. When that race fires, peek
      // validation reads stale/wrong-thread bytes, fails, ForceCloseSocket
      // silently. Visible from the proxy as: TCP closes within ~5ms of
      // sending the game-phase bundle, with s2cCount === 0.
      //
      // Retry safeguards (audit WS-C2):
      //   - `tEcho < 50ms` filter: only retry on FAST closes that match
      //     the race signature, not on every silent close. A degraded
      //     upstream that takes 500ms to FIN was already past Peek when
      //     it failed, so retrying won't help — and would amplify load.
      //   - Exponential backoff: attempt N waits BASE * 2^(N-1). Without
      //     this, all 8 retries fire in milliseconds and a botnet of
      //     1024 sessions floods the upstream with connect storms.
      //   - Global in-flight semaphore: cap simultaneous retries across
      //     all sessions. Past `GLOBAL_RETRY_INFLIGHT_CAP`, the upstream
      //     is clearly broken and additional retries are dropped.
      const tEcho = this.elapsed();
      // v0.3.10 diagnostic: when a TCP FIN arrives without server response,
      // log the captured first-c2s buffer shape so we can tell whether the
      // retry's batched-handshake detection (83-byte 0xEF login or 69-byte
      // 0x91 game) is misfiring on this client version. The previous
      // workaround was tuned for a single-shard 7.0.x client; multi-shard +
      // per-shard `clientVersion` may emit different bundle shapes.
      if (this.s2cCount === 0 && this.c2sCount > 0) {
        const firstHex = this.firstC2sFirst4 ?? '<none>';
        const firstLen = this.firstC2sLen ?? -1;
        console.log(
          `[UOProxy] [${this.remoteAddr}] [diag-fin] tEcho=${tEcho}ms c2sCount=${this.c2sCount} `
          + `firstC2sLen=${firstLen} firstC2sFirst4=${firstHex} `
          + `retryBufSet=${this.gamePhaseRetryBuf !== null}`
        );
      }
      const retryEligible =
        this.gamePhaseRetryBuf !== null
        && this.s2cCount === 0
        // v0.3.10: tEcho gate relaxed from 50ms to 500ms after diag
        // showed the ThreadStatic race firing at ~130-200ms in current
        // production (vs the ~30ms original measurement). 500ms still
        // excludes genuine auth failures (those take >1s of server-side
        // logic) and degraded-upstream timeouts (multi-second), while
        // catching the slower race window seen in 2026-05.
        && tEcho < 500
        && this.gamePhaseRetryAttempts < Session.GAME_PHASE_RETRY_MAX
        && !this.wsClosed
        && this.ws.readyState === WebSocket.OPEN
        && !this.destroyed
        && globalRetriesInflight < GLOBAL_RETRY_INFLIGHT_CAP;
      if (retryEligible) {
        this.gamePhaseRetryAttempts++;
        globalRetriesInflight++;
        const buf = this.gamePhaseRetryBuf!;
        const delay = Math.min(
          WS_RETRY_BACKOFF_MAX_MS,
          WS_RETRY_BACKOFF_BASE_MS * (1 << (this.gamePhaseRetryAttempts - 1))
        );
        console.log(
          `[UOProxy] [${this.remoteAddr}] [pattern-b-retry] silent FIN detected (tEcho=${tEcho}ms, s2cCount=0) — opening fresh TCP for retry ${this.gamePhaseRetryAttempts}/${Session.GAME_PHASE_RETRY_MAX} after ${delay}ms (inflight=${globalRetriesInflight}/${GLOBAL_RETRY_INFLIGHT_CAP})`
        );
        // Cancel the deferred WS-close so the wasm client doesn't see the
        // failed underlying TCP. The retry keeps the WS alive.
        if (this.wsCloseAfterFinTimer !== null) {
          clearTimeout(this.wsCloseAfterFinTimer);
          this.wsCloseAfterFinTimer = null;
        }
        // Reset transport-level state. Application-level state
        // (compressionEnabled, skip8CScan, huffman) is preserved across
        // retries because the wasm client's view of the protocol hasn't
        // changed — only the underlying TCP swapped underneath.
        this.tcpBuf = Buffer.alloc(0);
        this.tcpPaused = false;
        this.t0 = 0;
        // Schedule the retry with backoff so a degraded upstream doesn't
        // see all retries arrive in microseconds.
        //
        // WS M-1 fix: `globalRetriesInflight` is incremented exactly once
        // above when a retry is scheduled, so it MUST be decremented
        // exactly once per retry. The old code decremented in three places
        // gated such that a retry socket that failed to `connect` on a
        // non-final attempt leaked the counter (no 'connect', and the
        // 'close' decrement was gated to only the final attempt). Repeated
        // upstream-down retries pinned the counter ≥16 fleet-wide. Fix:
        // a single idempotent per-retry guard — whichever terminal event
        // fires first (the destroyed/wsClosed early-out, 'connect' success,
        // or 'close'/'error') decrements once and flips the guard so no
        // later event can double-decrement or leak.
        let retryInflightReleased = false;
        const releaseRetryInflight = (): void => {
          if (retryInflightReleased) return;
          retryInflightReleased = true;
          globalRetriesInflight = Math.max(0, globalRetriesInflight - 1);
        };
        setTimeout(() => {
          if (this.destroyed || this.wsClosed) {
            releaseRetryInflight();
            return;
          }
          this.tcpSocket = this.makeTcpSocket();
          this.attachTcpHandlers();
          // Whichever fires first releases the in-flight slot: 'connect'
          // on a successful retry connect, or 'close'/'error' if the
          // connect attempt itself failed before 'connect' ever fired.
          this.tcpSocket.once('connect', releaseRetryInflight);
          this.tcpSocket.once('close', releaseRetryInflight);
          this.tcpSocket.once('error', releaseRetryInflight);
          this.connectTcp();
        }, delay);
        return;
      }

      // Diagnostic when we declined to retry but normally would have, so
      // operators can see when the global cap is throttling them.
      if (
        this.gamePhaseRetryBuf !== null
        && this.s2cCount === 0
        && globalRetriesInflight >= GLOBAL_RETRY_INFLIGHT_CAP
      ) {
        console.warn(
          `[UOProxy] [${this.remoteAddr}] [pattern-b-retry] DECLINING retry — global cap reached (${globalRetriesInflight}/${GLOBAL_RETRY_INFLIGHT_CAP}). Upstream likely degraded.`
        );
      }

      this.tcpClosed = true;
      this.maybeCleanup();
    });

    this.tcpSocket.on('error', (err) => {
      // A reset is the far side going away too, just less politely than a FIN.
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') recordPeerClose(this.tcpSocket);
      console.error(
        `[UOProxy] [${this.remoteAddr}] TCP error tEcho=${this.elapsed()}ms ${err.message}`
      );
      if (!this.wsClosed && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1011, 'TCP error');
      }
      // R2-L-5: ensure cleanup arms even if 'close' is suppressed.
      this.tcpClosed = true;
      this.maybeCleanup();
    });

    this.tcpSocket.on('timeout', () => {
      console.warn(
        `[UOProxy] [${this.remoteAddr}] TCP idle timeout tEcho=${this.elapsed()}ms — destroying`
      );
      this.destroy();
    });
  }

  // ── WS → TCP ────────────────────────────────────────────────────────────

  private attachWsHandlers(): void {
    // v0.3.13 audit R4-L-3: WS control-frame flood (ping spam) wasn't
    // counted against the c2s rate limit — `allowC2s` only fires inside
    // the `'message'` handler. The `ws` library's `autoPong: true`
    // default replies to every ping, burning CPU + bandwidth. Count
    // each incoming ping as a 125-byte (max RFC payload) c2s slot
    // against the same token bucket; floods exhaust the bucket and
    // the session closes with the same rate-limit reason as message
    // floods. autoPong stays on — legitimate keep-alive traffic
    // (typically <1 ping per 30s) is well under the 200-burst ceiling.
    this.ws.on('ping', () => {
      if (!this.allowC2s(125)) {
        console.warn(
          `[UOProxy] [${this.remoteAddr}] ping flood rate cap exceeded — closing`,
        );
        this.ws.close(1008, 'rate limit');
        this.destroy();
      }
    });
    this.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
     // Belt-and-suspenders (audit 2026-07-22): this c2s path is defensively
     // length-gated, but the process policy is uncaughtException -> exit(1)
     // (index.ts). In a single-process proxy ONE synchronous throw here would
     // drop EVERY player, so contain any unexpected throw to THIS session.
     try {
      if (!isBinary) {
        // R2-M-9: text frames are not part of the UO protocol; close hard
        // instead of looping on them.
        console.warn(`[UOProxy] [${this.remoteAddr}] text frame received — closing`);
        this.ws.close(1003, 'binary only');
        this.destroy();
        return;
      }

      let buf: Buffer;
      if (Buffer.isBuffer(data)) {
        buf = data;
      } else if (data instanceof ArrayBuffer) {
        buf = Buffer.from(data);
      } else {
        buf = Buffer.concat(data as Buffer[]);
      }

      // Per-session c2s rate limit + lifetime cap (audit WS-C1). One UO
      // packet = one WS frame; a legitimate client peaks at ~10/sec. Drop
      // sessions that exceed the burst (200/sec) or the lifetime byte cap.
      if (!this.allowC2s(buf.length)) {
        console.warn(
          `[UOProxy] [${this.remoteAddr}] c2s rate/byte cap exceeded (lifetime=${this.c2sLifetimeBytes}B) — closing`
        );
        this.ws.close(1008, 'rate limit');
        this.destroy();
        return;
      }

      // Clear the pre-c2s deadline on first message (audit WS-H2).
      if (this.firstC2sDeadlineTimer !== null) {
        clearTimeout(this.firstC2sDeadlineTimer);
        this.firstC2sDeadlineTimer = null;
      }

      this.c2sCount++;

      // The client half of the derivation: the attack request names WHICH mobile to blame, and can
      // only ever point at a name the server already supplied. See deathWatch.ts.
      this.observeClientBytes(buf);

      // 0xEF authID swap — translate the shadow value the client sees back
      // to the original ModernUO emitted. See the block-comment above the
      // authIdSwapMap definition for the full rationale. We mutate a copy
      // so the original Buffer is not shared back through the WS layer.
      //
      // Three frame shapes the wasm CUO can produce on game-phase first
      // send (LoginScene.HandleRelayServerPacket):
      //   (a) 4 bytes alone        — SHORT seed only (wasm Flush split)
      //   (b) 65 bytes, [0]=0x91   — 0x91 alone, seed sent in (a) prior
      //   (c) 69 bytes, [4]=0x91   — batched seed (4) + 0x91 (65)
      //
      // For (a) and (c) we swap the SHORT seed at bytes 0..3.
      // For (b) and (c) we swap the inner 0x91 authID at bytes 1..4 (or
      // bundle bytes 5..8 in the batched case). The two values are always
      // identical client-side so the same shadow → original mapping covers
      // both occurrences.
      let outBuf: Buffer = buf;
      // Gate by c2sCount so we only consider the first two c2s messages
      // (separate-shape: msg #1 = SHORT seed, msg #2 = 0x91; batched: msg #1
      // = both). Past that point in the stream we'd risk false-positive
      // matches on unrelated 4-byte status packets whose payload happens to
      // collide with an active shadow.
      const isFirstTwoMessages = this.c2sCount <= 2;
      const tryGameShortSeed = isFirstTwoMessages && buf.length === 4;
      const tryGameLogin91Separate = isFirstTwoMessages && buf.length === 65 && buf[0] === 0x91;
      const tryGameLogin91Batched  = isFirstTwoMessages && buf.length === 69 && buf[4] === 0x91;
      if (tryGameShortSeed || tryGameLogin91Separate || tryGameLogin91Batched) {
        const shadowOffset = tryGameShortSeed ? 0
          : tryGameLogin91Batched ? 0
          : 1;  // separate 0x91 → inner authID at byte 1
        const shadow = buf.readUInt32BE(shadowOffset);
        const original = this.authIdSwap.lookupOriginal(shadow);
        if (original !== null) {
          outBuf = Buffer.from(buf);
          outBuf.writeUInt32BE(original, shadowOffset);
          if (tryGameLogin91Batched) {
            // Batched form has the auth ID twice: once as the SHORT seed
            // (bytes 0..3), once embedded in 0x91 (bytes 5..8). Swap both
            // in lock-step.
            outBuf.writeUInt32BE(original, 5);
          }
          console.log(
            `[UOProxy] [${this.remoteAddr}] [authid-swap] c2s ${tryGameShortSeed ? 'SHORT seed' : tryGameLogin91Batched ? 'batched seed+0x91' : '0x91 inner'}: shadow=0x${shadow.toString(16).padStart(8, '0')} → original=0x${original.toString(16).padStart(8, '0')}`
          );
        }
      }

      // Path C: detect the c2s 0x91 GameServerLogin so we can both (a)
      // disable the 0x8C rewrite (we're past auth phase) and (b) flip on
      // server-side Huffman decode for the s2c stream that the server
      // begins encoding right after it processes 0x91.
      //
      // IMPORTANT: only applies when encrypt='none'. With encryption active
      // (SphereServer etc.) the 0x91 byte and all payload bytes are encrypted
      // by the client-side cipher, so `buf[0]`/`buf[4]` are ciphertext — the
      // 0x91 pattern check would fire ~1/256 of the time on unrelated packets.
      // Encrypted shards also don't use Huffman compression on s2c (old
      // servers pre-date the Huffman optimisation), so enabling Huffman on
      // those sessions would corrupt the forwarded data.
      //
      // Two flavours for encrypt=none shards:
      //   (a) buf.length === 65 && buf[0] === 0x91   (separate)
      //   (b) buf.length === 69 && buf[4] === 0x91   (batched seed+login)
      const isGameLoginSeparate = this.target.encrypt === 'none' && buf.length === 65 && buf[0] === 0x91;
      const isGameLoginBatched  = this.target.encrypt === 'none' && buf.length === 69 && buf[4] === 0x91;
      if (!this.skip8CScan && (isGameLoginSeparate || isGameLoginBatched)) {
        console.log(`[UOProxy] [${this.remoteAddr}] Game-phase session detected — disabling 0x8C rewrite`);
        this.skip8CScan = true;
      }
      if (!this.compressionEnabled && (isGameLoginSeparate || isGameLoginBatched)) {
        const shape = isGameLoginSeparate ? 'separate seed+login' : 'batched seed+login';
        console.log(
          `[UOProxy] [${this.remoteAddr}] enabling Huffman decompress on s2c — 0x91 GameServerLogin (${shape})`
        );
        this.huffman.reset();
        this.compressionEnabled = true;
      }

      if (this.tcpSocket.writable) {
        // MINI auto-login: rewrite the 0x80 AccountLogin to d<discordId>/HMAC
        // before any downstream handling (length + 0xEF/0x80 markers preserved, so
        // the batched-handshake detection + retry still work on the rewritten buf).
        outBuf = this.maybeRewriteMiniLogin(outBuf);
        // v0.3.14: account c2s bytes for the shard-cooldown tracker BEFORE
        // we issue the TCP writes. If the upstream FINs immediately, the
        // close handler reads c2sBytes>0 from this counter and skips the
        // cool-down (= application-level reject, not a per-IP block).
        recordC2sBytes(this.tcpSocket, outBuf.length);

        // Mark the FIRST batched handshake bundle (login OR game) as
        // retryable. ModernUO's TcpServer.cs:160-172 ThreadStatic+async
        // race in `_firstBytes` fires on EITHER phase — the post-await
        // re-read of the [ThreadStatic] field returns the wrong thread's
        // buffer ~75% of the time, validation reads stale bytes, peek
        // rejects, ForceCloseSocket fires silently with no log entry.
        //
        // Login (83B = 0xEF + 0x80) and game (69B with [4]=0x91) bundles
        // are both vulnerable. We detect them via splitBatchedHandshake
        // (the same heuristic that does the kernel-segment split). On
        // silent FIN we replay the exact buffer on a fresh TCP. The
        // server keeps no state from the failed peek, so each retry has
        // an independent ~25% success chance.
        const isFirstHandshake = this.c2sCount === 1 && this.s2cCount === 0;
        // v0.3.23 audit fix: only run handshake-batch detection on
        // PLAINTEXT shards. Encrypted shards (Sphere with `encrypt:
        // blowfish/twofish`) send ciphertext after the seed, so the
        // 83-byte 0xEF+0x80 / 69-byte 0x91 byte-shape matches probabilistically
        // (~1/65536 / ~1/256 per encrypted login) and either:
        //   (a) `gamePhaseRetryBuf` captures cipher bytes that, on a
        //       silent FIN replay, replay-of-consumed-seed against
        //       Sphere's stream cipher → guaranteed handshake corruption.
        //   (b) `splitBatchedHandshake` fragments the cipher stream
        //       across two TCP writes with a setImmediate gap, breaking
        //       Blowfish/Twofish stream alignment for the rest of the
        //       session.
        // The same gating shape is already used at the Huffman
        // detection a few lines up — mirror it here.
        const isPlaintextShard = this.target.encrypt === 'none';
        const isBatchedHandshake = isPlaintextShard && (
          (outBuf.length === 83 && outBuf[0] === 0xef && outBuf[21] === 0x80) ||
          (outBuf.length === 69 && outBuf[4] === 0x91) ||
          // v0.9.225: legacy login (pre-6.0.5 client) = [4-byte seed][0x80 AccountLogin].
          // cuo/tuo send the 0xEF batched shape (covered above) so they already get
          // the silent-FIN race retry; a legacy-seed client (the mini on a 3.0.8-era
          // shard) was NOT covered, so its login-phase TCP died on ModernUO's
          // TcpServer ThreadStatic race with retryBufSet=false (no retry). This is
          // the exact eternal-works-vs-mini-fails difference on the SAME shard.
          // Universal: race survival is independent of the TcpServer peek, so it
          // works on both old (no peek) and new (peek) ModernUO; the retry only
          // ever fires on a fast silent FIN, so non-race connections are untouched.
          (outBuf.length >= 66 && outBuf[4] === 0x80)
        );
        if (isFirstHandshake) {
          // Always capture the first c2s shape for the diag-fin log,
          // regardless of whether it matched the batched-handshake
          // detection. If a FIN arrives later without a server response,
          // the FIN handler logs these so we can refine detection.
          this.firstC2sLen = outBuf.length;
          this.firstC2sFirst4 = Array.from(outBuf.subarray(0, Math.min(4, outBuf.length)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
        }
        if (isFirstHandshake && isBatchedHandshake) {
          this.gamePhaseRetryBuf = Buffer.from(outBuf);
        }
        // splitBatchedHandshake is also gated on isPlaintextShard via
        // isBatchedHandshake — the helper already returns the input
        // unchanged if length doesn't match the 83/69 shape, but we
        // make the gating explicit here so a future change to the
        // helper can't accidentally re-enable splitting on encrypted
        // bytes.
        // MINI game-phase (operator 2026-06-15): ModernUO expects the 4-byte
        // game-phase seed ALONE in one recv, then the 65-byte 0x91 in the NEXT.
        // The autologin is fast enough that seed+0x91 arrive BATCHED (69B), and
        // the normal setImmediate split still gets coalesced by the kernel into one
        // 69B segment → ModernUO peek rejects → silent FIN (8/8). So for the mini
        // game-phase we split AND write the 0x91 after a REAL timer delay, forcing
        // two distinct TCP segments.
        const _miniGamePhase = this.identity.miniAutologin && this.skip8CScan;
        const _splitGap = (cb: () => void) => { _miniGamePhase ? setTimeout(cb, 120) : setImmediate(cb); };
        const parts = isPlaintextShard ? splitBatchedHandshake(outBuf) : [outBuf];
        if (parts.length > 1) {
          // Split batched login (83B) / game (69B) into two TCP writes
          // with a setImmediate yield between them. The split alone is
          // not what makes Pattern B work — the silent-FIN retry below
          // is the actual workaround for ModernUO's TcpServer.cs
          // ThreadStatic+async race. The split is a defence-in-depth:
          // if the kernel coalesces, ModernUO peek sees the full bundled
          // shape; if it splits, the first segment matches a valid
          // sub-shape (==21 [0]=0xEF / ==4). Either way, the resumed
          // thread's _firstBytes is what determines validation, not
          // the wire bytes — but we still want validation to pass when
          // the race DOESN'T fire (~25% of the time).
          this.tcpSocket.write(parts[0], (err) => {
            if (err) { console.error(`[UOProxy] [${this.remoteAddr}] TCP write error (split[0]): ${err.message}`); this.destroy(); }
          });
          _splitGap(() => {
            if (!this.tcpSocket.writable) return;
            this.tcpSocket.write(parts[1], (err) => {
              if (err) { console.error(`[UOProxy] [${this.remoteAddr}] TCP write error (split[1]): ${err.message}`); this.destroy(); }
            });
            // v0.3.15-A: emit WebIdentity right after the second half of
            // the batched bundle. Peek has already validated against the
            // full 83/69 bytes; NetState now reads our 0xA4 as the next
            // packet and dispatches to the registered handler. This is
            // the FIRST c2s case — subsequent packets won't re-emit
            // (maybeSendWebIdentity is idempotent via webIdentitySent).
            this.maybeSendWebIdentity();
          });
        } else {
          this.tcpSocket.write(parts[0], (err) => {
            if (err) {
              console.error(
                `[UOProxy] [${this.remoteAddr}] TCP write error: ${err.message}`
              );
              this.destroy();
            }
          });
          // v0.3.15-A: emit WebIdentity after the single-write c2s. If
          // the wasm sent only 4 bytes (split SHORT seed), peek may not
          // have validated yet — but the kernel typically delivers our
          // 0xA4 in the same TCP segment so peek sees seed+0xA4 ≥ 4 bytes
          // matching the `bytesRead == 4` path… NO, that path requires
          // EXACTLY 4 bytes. Sending 0xA4 right after 4 bytes makes peek
          // see 153 bytes total which fails. For now we only emit after
          // batched (83/69 byte) bundles via the parts.length > 1 branch
          // above. Single-byte c2s flows (game-phase reconnects, etc) get
          // skipped — guarded internally by maybeSendWebIdentity's no-op
          // when called twice, and the proxy only EVER sees a non-batched
          // first c2s in the 4-byte short seed case. Safer to no-op for
          // now and revisit if a shard requires it. TODO: gate emission
          // on outBuf.length >= 66 here too.
          if (outBuf.length >= 66) {
            this.maybeSendWebIdentity();
          }
        }
      }
     } catch (err) {
       try { console.error(`[UOProxy] [${this.remoteAddr}] c2s frame handler threw — closing session: ${(err as Error)?.message}`); } catch { /* logging must never rethrow */ }
       try { this.ws.close(1011, 'internal'); } catch { /* already gone */ }
       this.destroy();
     }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.wsClosed = true;
      const reasonStr = reason.length > 0 ? reason.toString() : '(no reason)';
      // Cancel the deferred TCP-FIN-triggered close: the client closed first,
      // which is exactly the path that proves the 0x8C reached it. Skipping
      // the deferred close avoids a redundant `ws.close()` call after the
      // socket is already CLOSED (no-op but clutter in logs).
      if (this.wsCloseAfterFinTimer !== null) {
        clearTimeout(this.wsCloseAfterFinTimer);
        this.wsCloseAfterFinTimer = null;
      }
      console.log(
        `[UOProxy] [${this.remoteAddr}] WS closed tEcho=${this.elapsed()}ms code=${code} reason=${reasonStr} c2sCount=${this.c2sCount} s2cCount=${this.s2cCount} tcpClosed=${this.tcpClosed}`
      );
      if (!this.tcpClosed) {
        this.tcpSocket.end();
      }
      this.maybeCleanup();
    });

    this.ws.on('error', (err: Error) => {
      console.error(
        `[UOProxy] [${this.remoteAddr}] WS error tEcho=${this.elapsed()}ms ${err.message}`
      );
      if (!this.tcpClosed) {
        this.tcpSocket.destroy();
      }
      // R2-L-5: same — mark wsClosed so cleanup converges.
      this.wsClosed = true;
      this.maybeCleanup();
    });
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  // v0.3.14: was private; widened to internal so UOProxy.closeMatching can
  // force-close sessions when an admin ban arrives. No external use.
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.wsCloseAfterFinTimer !== null) {
      clearTimeout(this.wsCloseAfterFinTimer);
      this.wsCloseAfterFinTimer = null;
    }
    if (this.firstC2sDeadlineTimer !== null) {
      clearTimeout(this.firstC2sDeadlineTimer);
      this.firstC2sDeadlineTimer = null;
    }
    // WS L-2 fix: clear the maybeCleanup() force-close timer too. If a
    // session is destroy()-ed while that 10s timer is armed, it would
    // otherwise fire later and run the cleanup path again → onClosed()
    // called twice → the per-IP counter decremented twice for one session.
    if (this.cleanupTimeout !== null) {
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }
    if (!this.wsClosed && this.ws.readyState !== WebSocket.CLOSED) {
      try { this.ws.terminate(); } catch { /* already gone */ }
    }
    if (!this.tcpClosed) {
      try { this.tcpSocket.destroy(); } catch { /* already gone */ }
    }
  }

  // WS L-3: run the per-IP-counter-decrementing `onClosed` exactly once,
  // no matter how many times maybeCleanup() converges on a fully-closed
  // session (force-close timer + the terminate-induced 'close' event, a
  // ws 'close' racing a ws 'error', etc.).
  private fireOnClosed(): void {
    if (this.onClosedFired) return;
    this.onClosedFired = true;
    this.onClosed();
  }

  private maybeCleanup(): void {
    if (this.tcpClosed && this.wsClosed) {
      if (this.cleanupTimeout) { clearTimeout(this.cleanupTimeout); this.cleanupTimeout = null; }
      console.log(`[UOProxy] [${this.remoteAddr}] Session fully closed`);
      this.fireOnClosed();
    } else if ((this.tcpClosed || this.wsClosed) && !this.cleanupTimeout) {
      this.cleanupTimeout = setTimeout(() => {
        console.warn(`[UOProxy] [${this.remoteAddr}] Force-closing stale session`);
        this.destroy();
        this.tcpClosed = true;
        this.wsClosed = true;
        this.fireOnClosed();
      }, 10_000);
    }
  }
}

// ── UOProxy ───────────────────────────────────────────────────────────────────

export class UOProxy {
  /** Singleton ref so the admin ban-list endpoint in AssetServer can reach
   *  the active proxy without a constructor-injected reference (the two
   *  classes are independently constructed in index.ts and there's only
   *  ever one of each). v0.3.14 force-close-on-ban path relies on this. */
  static instance: UOProxy | null = null;

  private readonly wss: WebSocketServer;
  private readonly sessions = new Set<Session>();
  /** Per-IP active session counter (R2-CRIT-2). WS L-1: incremented in
   *  `verifyClient` at accept time (atomic check+reserve), decremented in
   *  the session `onClosed` callback, or by `releaseReservation` if the
   *  upgrade aborts before a full Session exists. */
  private readonly perIp = new Map<string, number>();
  /** WS L-1: count of slots reserved by `verifyClient` that have not yet
   *  been promoted to a live Session. Folded into the global-cap check so
   *  the check+reserve is atomic across a burst of concurrent upgrades. */
  private reservedConnections = 0;

  /** Attach the WS proxy to an existing HTTP server on path /ws */
  constructor(server: http.Server) {
    UOProxy.instance = this;
    this.wss = new WebSocketServer({
      // noServer: the proxy owns the http server's 'upgrade' event and routes by
      // path below, so a SECOND WS server (the /uoam hub) can coexist. With
      // { server, path:'/ws' } the ws lib installs a server-wide upgrade handler
      // that aborts EVERY non-/ws upgrade with 400 — which silently broke /uoam.
      noServer: true,
      // R2-H-3: cap one frame at 64 KiB. Real UO packets are < 1 KiB; this
      // leaves headroom while killing 100-MiB-frame DoS.
      maxPayload: WS_MAX_PAYLOAD_BYTES,
      // R2-M-7 is enforced in the server.on('upgrade') handler below — NOT here:
      // `handshakeTimeout` is a ws *client* option (initAsClient) that
      // WebSocketServer silently ignores, so it never capped anything on the
      // server in the old { server, path } form either.
      // R2-M-8: explicitly disable per-message-deflate. UO traffic is already
      // Huffman-compressed; double-compression buys nothing and opens a
      // compression-bomb amplification surface.
      perMessageDeflate: false,
      // R2-H-2 + R2-CRIT-1: gate the upgrade on (a) a same-origin/allow-listed
      // Origin header (defeats cross-origin browser hijack + non-browser
      // scripted clients that omit Origin) and (b) the per-IP / global session
      // cap. We don't currently require Discord auth here because guest play
      // is a product feature; Origin-pinning + caps + the existing
      // game-protocol-level account login is the layered defence.
      verifyClient: (info, cb) => {
        if (!isAllowedOrigin(info.req)) {
          console.warn(`[UOProxy] reject upgrade from origin="${info.req.headers.origin ?? '<missing>'}"`);
          cb(false, 403, 'origin not allowed');
          return;
        }
        // Multi-server routing: resolve `?server=<slug>` against the
        // registry up front. Reject the upgrade rather than complete a
        // WS handshake we'd just have to close again.
        const target = resolveServerFromReq(info.req);
        if (!target) {
          console.warn(`[UOProxy] reject upgrade — unknown server slug in URL '${info.req.url ?? ''}'`);
          cb(false, 404, 'unknown server');
          return;
        }
        // Pending self-service shards await operator approval and are HIDDEN from
        // the picker; they must not be joinable over the bridge until approved
        // (audit 2026-06-21 — the moderation gate was enforced in the picker/listing
        // but not on the WS upgrade, so a direct ?server=<pending-slug> bypassed it).
        // The gate is for SELF-SERVICE shards awaiting admin approval. Operator-
        // defined shards (selfService unset) use pending:true purely to HIDE the
        // shard from the public picker while staying reachable by a pinned WS — e.g.
        // the hidden `uonexus` AoS shard the mini connects to (servers/uonexus.yaml
        // documents exactly this). Blocking those broke the mini's in-world connect
        // when it moved to uonexus.com (2026-06-30) — only gate self-service pending.
        if (target.pending && target.selfService) {
          console.warn('[UOProxy] reject upgrade - slug=' + target.slug + ' is pending approval');
          cb(false, 403, 'shard pending approval');
          return;
        }
        const ip = clientIpFromReq(info.req);

        // v0.3.14: shard cool-down — if the upstream shard recently FINed
        // immediately on connect (per-IP block on its side), refuse new
        // upgrades for the affected slug until the periodic probe lifts
        // the cool-down. Avoids piling on more TCP connects that would
        // extend the shard-side ban window.
        const cd = isShardCoolingDown(target.slug);
        if (cd) {
          console.warn(
            `[UOProxy] reject upgrade — slug=${target.slug} cooling down (triggered ${cd.triggerCount}x, ` +
            `expires in ${Math.max(0, Math.round((cd.expiresAt - Date.now()) / 1000))}s)`
          );
          cb(false, 503, 'shard temporarily unreachable');
          return;
        }

        // v0.3.14: extract auth handle from the WS upgrade JWT once so
        // the rate limit, ban check, and guestsAllowed gate share one
        // verify call (HMAC + iat + revoked-jti + exp checks happen here).
        const jwt = verifyRequestJwt(info.req);
        const discordSub = (jwt && isSnowflake(jwt.sub)) ? jwt.sub : null;

        // v0.3.14: persistent admin ban-list. discordId match wins over
        // ipCidr match — a logged-in banned user gets their precise
        // reason logged regardless of network.
        const ban = findActiveBan({ discordId: discordSub, ip });
        if (ban) {
          console.warn(
            `[UOProxy] reject upgrade — admin ban id=${ban.id} ` +
            `${ban.discordId ? `discordId=${ban.discordId}` : `ipCidr=${ban.ipCidr}`} ` +
            `reason="${ban.reason.slice(0, 60)}"`
          );
          cb(false, 403, 'banned');
          return;
        }

        // v0.3.14: per-handle rate limit (token bucket). Whitelisted IPs
        // bypass — see PROXY_RATE_LIMIT_WHITELIST in config.ts. Discord
        // users key by sub (durable); guests key by real IP (the only
        // stable handle they have).
        const rlKey = discordSub
          ? { kind: 'discord' as const, id: discordSub }
          : { kind: 'ip' as const, id: ip };
        if (!allowUpgrade(rlKey.kind, rlKey.id, ip)) {
          console.warn(
            `[UOProxy] reject upgrade — rate limit (${rlKey.kind}=${rlKey.id}) burst exhausted`
          );
          cb(false, 429, 'rate limited');
          return;
        }

        // v0.3.14: per-shard guestsAllowed. When false, the slug requires
        // a Discord-authed JWT; guest sessions get a 403 here rather than
        // wasting a WS handshake + slot only to be closed later.
        if (target.guestsAllowed === false && !discordSub) {
          console.warn(
            `[UOProxy] reject upgrade — slug=${target.slug} requires Discord sign-in (guestsAllowed=false)`
          );
          cb(false, 403, 'discord sign-in required');
          return;
        }

        // WS L-1 fix: the per-IP / global cap check and the counter
        // increment must be atomic. The old code checked here but only
        // incremented `perIp` later in `handleConnection`, one event-loop
        // tick away — a burst of concurrent upgrades all observed the
        // pre-burst count and every one of them passed, momentarily
        // blowing past PER_IP_SESSION_CAP. Fix: reserve the per-IP slot
        // RIGHT HERE, in the same synchronous block that the check passes.
        // `reservedConnections` tracks slots reserved at verifyClient time
        // but not yet promoted to a full Session; the global cap counts
        // both live sessions and pending reservations so it is atomic too.
        // Mirrors the v0.3.24 ban-recheck shape (check + commit together).
        const ipCount = this.perIp.get(ip) ?? 0;
        if (ipCount >= PER_IP_SESSION_CAP) {
          console.warn(`[UOProxy] reject upgrade from ${ip} — per-IP cap (${PER_IP_SESSION_CAP}) reached`);
          cb(false, 429, 'too many sessions');
          return;
        }
        if (this.sessions.size + this.reservedConnections >= GLOBAL_SESSION_CAP) {
          console.warn(`[UOProxy] reject upgrade from ${ip} — global cap (${GLOBAL_SESSION_CAP}) reached`);
          cb(false, 503, 'server busy');
          return;
        }
        // Reserve the slot atomically with the passing check. The
        // reservation is converted into a real session in
        // handleConnection (which does NOT re-increment), or released by
        // releaseReservation() if the upgrade is aborted/rejected after
        // this point but before a full Session exists.
        this.perIp.set(ip, ipCount + 1);
        this.reservedConnections++;
        // Safety net for the abort window between cb(true) and the
        // 'connection' event: if the underlying socket dies during the
        // WS handshake response write, `ws` never emits 'connection' and
        // handleConnection never runs — the reservation would leak. Tag
        // the request so handleConnection can cancel this, and release on
        // a socket 'close' that wins the race. `pendingReleased` makes the
        // two paths mutually exclusive so the slot is freed exactly once.
        const reservedReq = info.req as http.IncomingMessage & {
          _uoReservedIp?: string;
          _uoReservationReleased?: boolean;
        };
        reservedReq._uoReservedIp = ip;
        reservedReq._uoReservationReleased = false;
        const onAbort = (): void => {
          if (reservedReq._uoReservationReleased) return;
          reservedReq._uoReservationReleased = true;
          console.warn(`[UOProxy] [${ip}] upgrade aborted before 'connection' — releasing reserved slot`);
          this.releaseReservation(ip);
        };
        info.req.socket.once('close', onAbort);
        cb(true);
      },
    });
    // Route ONLY /ws upgrades to this server; return for any other path (e.g. the
    // /uoam hub) so its own 'upgrade' listener can take it. verifyClient still runs
    // inside handleUpgrade.
    server.on('upgrade', (req, socket, head) => {
      let pathname = '/';
      try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { /* keep default */ }
      if (pathname !== '/ws') return;
      // R2-M-7 (real impl): ws's WebSocketServer has no handshake timeout, so
      // now that we own the upgrade we cap the /ws handshake window ourselves —
      // destroy a socket that does not reach a live 'connection' within
      // WS_HANDSHAKE_TIMEOUT_MS. Scoped to /ws only (no global headersTimeout
      // change), cleared on success or socket close.
      const handshakeGuard = setTimeout(() => socket.destroy(), WS_HANDSHAKE_TIMEOUT_MS);
      handshakeGuard.unref();
      socket.once('close', () => clearTimeout(handshakeGuard));
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        clearTimeout(handshakeGuard);
        this.wss.emit('connection', ws, req);
      });
    });
    this.wss.on('connection', this.handleConnection.bind(this));
    this.wss.on('error', (err: Error) => {
      console.error('[UOProxy] WebSocketServer error:', err.message);
    });
    console.log(`[UOProxy] build=${PROXY_BUILD_TAG}`);
    console.log(
      `[UOProxy] WebSocket proxy attached on ws://0.0.0.0:${PROXY_WS_PORT}/ws` +
        ` → TCP destination resolved per-session from ?server=<slug>`
    );

    setInterval(() => this.cleanupStaleSessions(), 30_000).unref();
  }

  /**
   * WS L-1: release a per-IP slot + global reservation taken in
   * `verifyClient` when the upgrade is aborted/rejected after verifyClient
   * accepted it but before a full Session exists (registry hot-reload,
   * post-upgrade ban, etc.). Decrements exactly the two counters that
   * `verifyClient`'s accept path incremented. Idempotent-safe to call once
   * per aborted upgrade; never call it for an upgrade that became a
   * Session (the session `onClosed` callback owns that decrement instead).
   */
  private releaseReservation(ip: string): void {
    this.reservedConnections = Math.max(0, this.reservedConnections - 1);
    const cnt = (this.perIp.get(ip) ?? 1) - 1;
    if (cnt <= 0) this.perIp.delete(ip);
    else this.perIp.set(ip, cnt);
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const remoteAddr = clientIpFromReq(req);

    // WS L-1: the 'connection' event won — neutralise the verifyClient
    // socket-'close' abort net so it can't double-release the slot when
    // this established session's socket later closes normally. The
    // reservation marker is now owned by handleConnection: either it is
    // consumed into a Session below, or released by one of the early
    // returns here.
    const reservedReq = req as http.IncomingMessage & { _uoReservationReleased?: boolean };
    // WS L-1 residual-race guard: verifyClient set the marker to `false` on
    // accept. If it reads `true` here, the socket-'close' abort net in
    // verifyClient already fired and ALREADY released the per-IP + global
    // reservation. Continuing would create a Session whose `onClosed` does
    // a second `perIp--`, and line ~1737 would do a second
    // `reservedConnections--` — double-decrement counter drift. The upgrade
    // is already dead, so bail before consuming a reservation that's gone.
    if (reservedReq._uoReservationReleased === true) {
      console.warn(
        `[UOProxy] [${remoteAddr}] 'connection' fired after the upgrade was already aborted — dropping`
      );
      try { ws.close(4000, 'aborted'); } catch { /* already closed */ }
      return;
    }
    reservedReq._uoReservationReleased = true;
    const releaseReservationOnce = (): void => {
      // Already-true marker means the slot was reserved by verifyClient;
      // release it exactly once for an aborted-here upgrade.
      this.releaseReservation(remoteAddr);
    };

    // Resolve `?server=<slug>` against the registry. Already validated at
    // upgrade time by verifyClient, but we re-resolve here so the Session
    // gets the live record (handles a future hot-reload of the registry).
    const target = resolveServerFromReq(req);
    if (!target) {
      // Defensive — verifyClient should already have rejected this. If we
      // get here, the registry was hot-reloaded between upgrade and connect
      // and the slug disappeared.
      console.warn(`[UOProxy] [${remoteAddr}] dropping WS — resolve target gone post-upgrade`);
      // WS L-1: the verifyClient accept already reserved a per-IP + global
      // slot — release it since no Session will be created.
      releaseReservationOnce();
      try { ws.close(4004, 'unknown server'); } catch { /* already closed */ }
      return;
    }

    // v0.3.14: re-verify the JWT here so the Session can carry the
    // Discord sub for the admin force-close-on-ban path. Cheap (HMAC over
    // ~200 bytes) and we already paid the verify cost in verifyClient.
    const jwt = verifyRequestJwt(req);
    const discordSub = (jwt && isSnowflake(jwt.sub)) ? jwt.sub : null;
    const discordName = (jwt && typeof jwt.name === 'string') ? jwt.name : '';

    // v0.3.24: TOCTOU ban re-check. The window between verifyClient and
    // this 'connection' event is 5-50ms (one event-loop tick for the WS
    // handshake response write). An admin POST /api/admin/bans firing in
    // that window calls closeMatching which iterates this.sessions —
    // but the new session is not added until below (this.sessions.add).
    // So a ban for this user issued in that exact window would not match
    // any session and the now-banned user would still get a live session.
    // Re-checking here closes the gap. Other gates (cooldown, guestsAllowed)
    // are not re-checked because their hot-mutation surfaces are admin-
    // initiated registry edits + cooldown probes which target the slug
    // not a session, so they catch the next connect rather than racing.
    const postBan = findActiveBan({ discordId: discordSub, ip: remoteAddr });
    if (postBan) {
      console.warn(
        `[UOProxy] [${remoteAddr}] dropping WS post-upgrade — ban added between verifyClient and 'connection' event ` +
        `id=${postBan.id} ${postBan.discordId ? `discordId=${postBan.discordId}` : `ipCidr=${postBan.ipCidr}`}`
      );
      // WS L-1: release the verifyClient reservation — no Session created.
      releaseReservationOnce();
      try { ws.close(4003, 'banned'); } catch { /* already closed */ }
      return;
    }

    // v0.3.15: bundle the identity fields the WebIdentity frame needs.
    // Discord sub becomes externalAuthId; Discord display name becomes
    // externalAuthUsername. Guest sessions have empty Discord fields and
    // a per-session synthetic userId so the shard can still distinguish
    // them in audit logs even though they share their docker-bridge IP
    // until WebIdentity rewrites it.
    //
    // v0.9.131 (audit 2026-06-21, cross-tenant role elevation): the role
    // asserted to the destination shard's game server must be scoped to THIS
    // shard. Previously ANY admins-map member (including a self-service owner of
    // some OTHER throwaway shard) was announced as role='admin' to EVERY shard —
    // if a victim shard trusts the WebIdentity role to grant in-game staff, that
    // is owner→cross-tenant privilege elevation. Now: only a GENERAL/platform
    // admin (servers:write, trusted shard-wide) is 'admin'; an owner joining a
    // shard THEY manage is 'shard-owner'; everyone else (incl. an owner joining a
    // shard they don't manage) is 'user'.
    //
    // MINI auto-login (Discord OR guest, gated by MINI_AUTOLOGIN env — OFF on the
    // shared dev/prod proxy → the mini branches are inert there; the non-mini
    // `else` keeps prod's exact cross-tenant-scoped role unchanged). With it ON the
    // proxy auto-binds the connection to a shard account so the player enters with
    // no typing (eternal's MiniAutoLogin.cs creates account+char from the 0xA4):
    // real Discord → role=mini-player, account d<id>, char = WEB nickname; guest
    // JWT → role=mini-guest, account g<hex>, char = "Guest".
    const guestSub = (jwt && typeof jwt.sub === 'string' && jwt.sub.startsWith('guest-')) ? jwt.sub : null;
    // v0.9.224: per-shard gate — the mini/AoS shard sets `autologin: true` in its
    // YAML; the global MINI_AUTOLOGIN env stays as a legacy/test force-on. Operator
    // shards (eternal) leave autologin unset → miniAuto=false → cuo/tuo Discord+guest
    // sessions are NEVER bound to a mini account or 0x80-rewritten.
    const miniAuto = MINI_AUTOLOGIN || !!target.autologin;
    const isMiniDiscord = miniAuto && !!discordSub;
    const isMiniGuest = miniAuto && !discordSub && !!guestSub;
    // Feature #76: when present, the role suffix carries the SHORT minigame code
    // ('mini-player-td'), MIRRORING the account's short code. It used to carry the
    // FULL name ('mini-player-towerdefense'), but the 0xA4 WebIdentity frame is FIXED
    // at 149 bytes and the 48-char shared secret + the two ~18-char ids leave only
    // ~130 bytes for all 7 strz fields: 'mini-guest-towerdefense' (23B) tipped it over,
    // buildWebIdentityFrame THREW, the proxy sent NO 0xA4, MiniAutoLogin never ran and
    // the account stuck at an empty char list (runmatch at 19B squeaked in by 1 byte;
    // towerdefense did not). The short code ('td'/'rm') always fits; the shard's
    // MiniAutoLogin.SplitMinigame maps it back to the full name. null → bare
    // 'mini-player'/'mini-guest' + bare account, exactly as before.
    const minigame = resolveMinigameFromReq(req);
    // `string` widens the union so the dynamic 'mini-player-'+code /
    // 'mini-guest-'+code roles type-check; the fixed literals below still
    // assign fine.
    let role: 'user' | 'admin' | 'shard-owner' | 'mini-player' | 'mini-guest' | string;
    let externalAuthProvider = '';
    let externalAuthId = '';
    let displayName = discordName;
    let miniAccount: string | undefined;
    let miniSub: string | undefined;
    if (isMiniDiscord) {
      role = minigame ? ('mini-player-' + mgAcctCode(minigame)) : 'mini-player';
      externalAuthProvider = 'Discord';
      externalAuthId = discordSub as string;
      displayName = getNickname(discordSub as string) || discordName || 'Wanderer';
      // ONE ACCOUNT PER PLAYER (operator 2026-07-30). This used to append the minigame code
      // so d<id>, d<id>-td and d<id>-rm coexisted, which bought exactly one thing: two
      // minigames open in two tabs without the second login kicking the first. That ability
      // was removed anyway, and the kick is now the INTENDED behaviour -- so the split was
      // buying nothing while making "which is this player's character?" unanswerable, and
      // both the web profile and the backpack mirror have to answer it.
      //
      // 🚨 The ROLE above still carries the minigame. That is what routes the player into
      // Runmatch or Tower Defense on the shard; only the ACCOUNT collapsed. Keep them
      // separate -- and keep this in lockstep with MiniAutoLogin.username on the shard,
      // because a mismatch is not a bug report, it is every mini login failing at once.
      miniAccount = miniAccountForDiscord(discordSub as string);
      miniSub = discordSub as string;
    } else if (isMiniGuest && resolveSpectateFromReq(req)) {
      // #113/#114 SPECTATOR pool: a guest session opening the mini with ?spectate=<name> binds to a
      // pooled BLANK account s<hex> (per-browser, like guests). The TARGET char name rides the 0xA4
      // username field (displayName) → the shard tags the account SpectateTarget and SpectatorSystem
      // auto-begins the invisible-rabbit session on login. Frame budget: 'mini-spec' (9B) + name (<=16B) fit.
      const hex = (guestSub as string).replace(/^guest-/, '');
      role = 'mini-spec';
      externalAuthProvider = 'Guest';
      externalAuthId = 'spec-' + hex;
      displayName = resolveSpectateFromReq(req) as string;
      miniAccount = miniAccountForSpectator(guestSub as string);
      miniSub = 'spec-' + hex;
    } else if (isMiniGuest) {
      role = minigame ? ('mini-guest-' + mgAcctCode(minigame)) : 'mini-guest';
      externalAuthProvider = 'Guest';
      externalAuthId = guestSub as string;
      displayName = 'Guest';
      // One account per guest BROWSER, same collapse as the Discord branch above.
      miniAccount = miniAccountForGuest(guestSub as string);
      miniSub = guestSub as string;
    } else {
      role =
        (discordSub && adminHasScope(discordSub, 'servers:write')) ? 'admin'
        : (discordSub && canEditServer(discordSub, target.slug)) ? 'shard-owner'
        : 'user';
    }
    // Prefer a STABLE id (Discord sub or the guest JWT sub) so a guest's
    // auto-account/char persists across reconnects within its 24h session; only
    // fabricate a random id when there's no session token at all.
    const userId = discordSub ?? guestSub ?? `guest-${crypto.randomBytes(6).toString('hex')}`;

    const proxyAddress = resolveProxyAddress(req);
    // WS L-1: promote the verifyClient reservation into a live session.
    // The per-IP slot was ALREADY incremented atomically in verifyClient —
    // do NOT re-increment here (that was the TOCTOU double-count bug). We
    // only consume the global reservation; the session `onClosed` callback
    // below owns the matching per-IP decrement for the session's lifetime.
    this.reservedConnections = Math.max(0, this.reservedConnections - 1);
    console.log(
      `[UOProxy] [${remoteAddr}] WebSocket connected → ${target.slug} (${target.host}:${target.port}) (${this.sessions.size + 1} active)`
    );
    const session = new Session(ws, remoteAddr, proxyAddress,
      {
        slug: target.slug,
        host: target.host,
        port: target.port,
        encrypt: target.encrypt,
        ...(target.webIdentity !== undefined && { webIdentity: target.webIdentity }),
        ...(target.selfService === true && { selfService: true }),
        ...(target.untrustedHost === true && { untrustedHost: true }),
      },
      () => {
        this.sessions.delete(session);
        untrackSession(session);
        const cnt = (this.perIp.get(remoteAddr) ?? 1) - 1;
        if (cnt <= 0) this.perIp.delete(remoteAddr);
        else this.perIp.set(remoteAddr, cnt);
        console.log(`[UOProxy] Session removed (${this.sessions.size} active)`);
      },
      discordSub,
      { userId, discordUsername: displayName, role,
        ...(externalAuthProvider && { externalAuthProvider }),
        ...(externalAuthId && { externalAuthId }),
        ...(miniAccount && { miniAccount }),
        ...(miniSub && { miniSub }),
        ...(miniAuto && { miniAutologin: true }) });
    this.sessions.add(session);
    // proxyStats: live "online now" snapshot for the supreme-admin metrics panel.
    // destroy closure powers the admin "kick" button (sessions panel) without
    // proxyStats needing a UOProxy import.
    // #112/#113: per-minigame "playing now" lists. Coded roles ('mini-player-rm', …) carry their
    // explicit minigame; a plain 'mini-player'/'mini-guest' with no ?minigame= is not a launchable
    // game anymore (the retired default was removed 2026-07-14) → untagged, in no roster. 'mini-spec'
    // (spectators) also stays untagged on purpose — a watcher must never appear in a "playing now" list.
    const mgTag = minigame ?? null;
    trackSession(session, {
      sub: userId, slug: target.slug, isGuest: !discordSub, since: Date.now(),
      ...(mgTag && { minigame: mgTag }),
      // The UO account, only when the proxy MINTED it (mini path). On an ordinary shard
      // the player types their own and we only relay the login, so it stays undefined —
      // which the Backpack mirror must read as "cannot mirror", not as "no account".
      ...(miniAccount && { account: miniAccount }),
      destroy: () => { try { session.destroy(); } catch { /* already destroyed */ } },
    });
  }

  private cleanupStaleSessions(): void {
    for (const session of this.sessions) {
      if (session.isFullyClosed()) {
        this.sessions.delete(session);
        untrackSession(session);
      }
    }

    // 🚨 RE-CHECK THE SURVIVORS AGAINST THE BAN LIST. Banning has two halves — refuse the next
    // connection and cut the current one — and only the first worked once /api/admin/bans moved to
    // the web process, which has no sessions to close. An IP ban left the offender playing until
    // they felt like leaving. See banSweep.ts for why the fix runs HERE rather than publishing
    // player IPs into a shared table.
    //
    // Riding the existing 30 s sweep rather than adding a timer: the registry re-reads only when
    // the file's mtime moves, so the steady-state cost is one stat per pass, not per session.
    sweepBannedSessions(this.sessions, (s, ban) => {
      console.warn(
        `[UOProxy] [${s.remoteAddr}] force-close: live session matches ban id=${ban.id} `
        + `${ban.discordId ? `discordId=${ban.discordId}` : `ipCidr=${ban.ipCidr}`}`);
    });
  }

  /**
   * v0.3.14: walk active sessions and force-close every one matching the
   * given ban entry. Called from the /api/admin/bans POST handler so a
   * freshly-issued ban kicks the offender immediately rather than waiting
   * for their current connection to disconnect on its own.
   *
   * Match rules mirror findActiveBan: discordId match wins; ipCidr match
   * runs through the ban-registry's CIDR check by reusing findActiveBan
   * with the session's per-handle pair.
   */
  closeMatching(ban: BanEntry): number {
    let closed = 0;
    // v0.3.23 audit fix: snapshot the Set before iterating. `session.destroy()`
    // synchronously fires the 'close' handler that calls
    // `this.sessions.delete(session)` — mutating a Set during a `for…of`
    // loop in V8 makes the iterator skip the next entry. With 100
    // matching sessions the original loop would close ~50. Iterating an
    // Array.from snapshot decouples from the live Set so deletes don't
    // affect iteration order.
    const snapshot = Array.from(this.sessions);
    for (const session of snapshot) {
      // v0.3.22 audit fix: evaluate the specific ban directly via
      // `banMatches`, NOT via `findActiveBan({ip}) === ban.id`.
      // The old form only matched when this ban was the FIRST active
      // ban for the session's IP — overlapping CIDRs (e.g. operator
      // adding both /24 and /16 covering the same address) silently
      // failed to close sessions covered by the later-added ban.
      const matchByDiscord = !!(ban.discordId && session.discordSub === ban.discordId);
      const matchByIp      = !!(ban.ipCidr && banMatches(ban, { ip: session.remoteAddr }));
      if (!matchByDiscord && !matchByIp) continue;
      console.warn(
        `[UOProxy] [${session.remoteAddr}] force-close from admin ban id=${ban.id} ` +
        `${ban.discordId ? `discordId=${ban.discordId}` : `ipCidr=${ban.ipCidr}`}`
      );
      try { session.destroy(); } catch { /* already destroyed */ }
      closed++;
    }
    return closed;
  }
}
