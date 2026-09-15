// userData.ts — GDPR right-to-erasure: wipe every personal record we hold for a
// Discord user (operator 2026-06-11; extended 2026-06-18 to the full progression
// suite — comments/wall, points, cosmetics, cards, follows, quests, seasons,
// notifications, market — so an admin "delete user" or a self "delete account"
// truly leaves nothing behind).
//
// The caller also deletes the user's cloud profile blobs (auth.deleteProfilesForUser),
// removes any admin/owner grant, and logs them out. The main-DB wipe is one
// transaction (all-or-nothing); the dedicated cards.db is wiped best-effort after.

import { db, tx } from './db.js';
// 🚨 NO DIRECT IMPORT OF THE CARD STORE. GDPR erasure must reach every store holding the user's
// data — but that does not mean THIS module has to know them all. Knowing them means importing
// them, and importing them means any build that can delete an account also carries the economy. A
// minimal self-hosted install stores identity, settings and profiles; there is nothing else to
// erase there. Inverted: each store registers its own eraser (uonexus registers the card one at
// startup). It is also better here — a new store registers itself instead of editing this file,
// which is exactly how a store gets forgotten and quietly survives a deletion.
type Eraser = (sub: string) => number;
const _erasers = new Map<string, Eraser>();
/** Register a store's eraser, run by eraseUserData. Keyed, so re-registration is harmless. */
export function registerUserDataEraser(name: string, fn: Eraser): void {
  _erasers.set(name, fn);
  console.log(`[registry] GDPR eraser registered: ${name} (${_erasers.size} total)`);
}

// Tables keyed by a single `sub` column.
const SINGLE_TABLES = [
  'identities', 'nicknames', 'player_metrics', 'players', 'achievements', 'votes', 'death_log',
  'cheat_flags', 'points_ledger', 'points_balance', 'points_awarded', 'points_daily',
  'cosmetics_owned', 'cosmetics_equipped', 'cards_owned', 'card_daily', 'market_bans',
  'activity', 'notifications', 'quest_progress', 'quest_claims', 'season_points',
  'discord_prefs', // opt-out-of-rank pref keyed by the Discord sub (audit F1: was a GDPR remnant — nothing else ever deleted it)
  'account_deletions', // pending self-deletion schedule (sub + timestamps) — an admin direct-delete must wipe it too, else the Discord id lingers ~7 days (audit 2026-06-21)
  // ── the item economy (audit 2026-08-03) ──────────────────────────────────────────────────
  // 🚨 EIGHT TABLES CARRYING A SUB SURVIVED "DELETE EVERYTHING", and every one of them was
  // added AFTER this list was written. That is the shape of the defect, not an oversight in
  // any single commit: a hand-maintained list of tables, in a schema that keeps growing. The
  // test that now guards it (ErasureCoverage) enumerates the schema instead of trusting this
  // array, so the next table cannot slip through the same way.
  //
  // Operator 2026-08-03: "si se borra una cuenta de la web, sus objetos han de borrarse."
  'item_instances',   // magic items minted TO this player
  'item_deliveries',  // items bought or won and not yet handed over
  'item_drops',       // their loot-roll history (also the daily cap / cooldown state)
  'shop_purchases',   // what they bought from the operator's shop, and when
  'backpack_pos',     // where they arranged each piece in their bag
  'live_sessions',    // the live-session mirror row, if they are connected as they are erased
  'login_signals',    // a queued login hand-off that would otherwise name them after erasure
  'death_witness',    // an observed death waiting to be published — same reason as login_signals
];

// 🚨 PREPARED ON FIRST USE, NOT AT IMPORT — and that is a correctness fix, not a style choice.
// These used to be prepared while this module loaded, which silently required every table above
// to already exist at that instant. It does not: `item_drops` is created by itemDrops.ts, so
// whether this module or that one loaded first decided whether the PROCESS STARTED AT ALL. It
// threw `no such table: item_drops` out of an import — a boot crash-loop in production, caught
// here only because the suite happens to import the two in the unlucky order.
//
// The list is hand-maintained and will keep growing; preparing lazily means the next name added
// to it can be wrong without taking the site down with it.
// 🚨 AND LAZY IS ONLY HALF OF IT: THE TABLE HAS TO EXIST. Preparing on first use stops a bad NAME
// from taking the process down at import, which is what the note above is about. It does nothing
// for a table that is legitimately ABSENT — and that case is real, not hypothetical: db.ts runs 45
// unconditional CREATE TABLEs today, so a build that stops creating the economy ones (the minimal
// reaches ~30 tables it can never read or write) would make every statement below throw the first
// time somebody deleted an account. The GDPR path is the worst place to learn that.
//
// So a statement is prepared once, on demand, and resolves to null when its table is not in this
// schema. Callers treat null as "nothing to delete here", which is exactly true.
const _stmts = new Map<string, import('node:sqlite').StatementSync | null>();
function stmt(sql: string): import('node:sqlite').StatementSync | null {
  if (!_stmts.has(sql)) {
    // The table is read from the SQL rather than passed alongside it: two sources for one fact is
    // how the hand-maintained list above drifted in the first place.
    const t = /(?:DELETE\s+FROM|UPDATE|\bFROM)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql)?.[1];
    const present = !t || db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
    if (!present) console.warn(`[userData] skipping erasure on absent table: ${t}`);
    _stmts.set(sql, present ? db.prepare(sql) : null);
  }
  return _stmts.get(sql) ?? null;
}
/** Run an erasure statement and count the rows it removed; 0 when the table is not in this build. */
function ran(sql: string, ...args: unknown[]): number {
  const s = stmt(sql);
  return s ? (Number((s.run(...args as never[])).changes) || 0) : 0;
}

// 🚨 THE VENDOR STALL ROW IS NOT SYMMETRIC, and copying card_listings would have been wrong.
// Their own listings go, item and all. But a listing they BOUGHT is somebody else's sale, and
// deleting it would erase a third party's history because a stranger closed their account. The
// personal data in that row is the buyer columns, so those are what get removed.
//
// (card_listings above does delete both sides. Stated here so the difference reads as a
// decision rather than as one of the two having been forgotten.)
const SQL_DEL_MY_LISTINGS = "DELETE FROM item_listings WHERE seller_sub = ?";
const SQL_ANON_BUYER = 'UPDATE item_listings SET buyer_sub = NULL, buyer_nick = NULL WHERE buyer_sub = ?';
const SQL_REPORTER = 'DELETE FROM comment_reports WHERE reporter_sub = ?';
// season_winners stores only (season, rank, nickname, points) — no sub column — so
// it must be wiped by the user's nickname, captured BEFORE the nicknames row goes
// (audit 2026-06-23: a GDPR erasure was leaving the pseudonymous snapshot behind).
const SQL_NICK_FOR_ERASE = 'SELECT nickname FROM nicknames WHERE sub = ?';
const SQL_DEL_SEASON_WINNERS = 'DELETE FROM season_winners WHERE nickname = ?';
// Tables where the user can be on either side — wiped for both roles.
const PAIRS = [
  'DELETE FROM profile_comments WHERE author_sub = ? OR profile_sub = ?', // their comments + their wall
  'DELETE FROM comment_blocks   WHERE owner_sub = ? OR blocked_sub = ?',
  'DELETE FROM follows          WHERE follower_sub = ? OR target_sub = ?',
  'DELETE FROM card_listings    WHERE seller_sub = ? OR buyer_sub = ?',
];

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** Erase every personal record for `sub` across both SQLite databases. Returns
 *  total rows removed. Idempotent. Never throws on a clean call (main-DB wipe is
 *  transactional; cards.db is best-effort). */
export function eraseUserData(sub: string): number {
  if (!sub || sub.startsWith('guest-') || UNSAFE.has(sub)) return 0;
  let removed = 0;
  // IMMEDIATE, via tx(). This transaction READS the nickname before it writes, which is exactly
  // the shape a deferred BEGIN cannot make wait: SQLite fails the upgrade instantly rather than
  // honouring busy_timeout, because retrying would break the snapshot the read already took.
  // Measured in the container: 0 ms to fail deferred, 4003 ms of grace with IMMEDIATE. A GDPR
  // erasure is the last thing that should lose a coin-flip against the other process.
  tx(() => {
    const wnick = (stmt(SQL_NICK_FOR_ERASE)?.get(sub) as { nickname?: string } | undefined)?.nickname; // capture before SINGLE wipes nicknames
    for (const t of SINGLE_TABLES) removed += ran(`DELETE FROM ${t} WHERE sub = ?`, sub);
    removed += ran(SQL_REPORTER, sub);
    removed += ran(SQL_DEL_MY_LISTINGS, sub);
    removed += ran(SQL_ANON_BUYER, sub);
    for (const sql of PAIRS) removed += ran(sql, sub, sub);
    if (wnick) removed += ran(SQL_DEL_SEASON_WINNERS, wnick);
  });
  // Dedicated cards.db (separate connection), outside the txn above because two databases cannot
  // share one — that part is unavoidable. What is NOT is what used to happen next.
  //
  // 🚨 THIS FAILURE MUST NOT BE SWALLOWED, and the reason is stronger than tidiness. `eraseUserCards`
  // clears card_owned, card_showcase, card_drops, card_progress and card_escrow, and cardsdb.ts says
  // in its own comment why the last one matters: the boot reconciler settles escrow rows and MINTS
  // the card back to the sub on them. A swallowed failure therefore does not leave a harmless
  // remnant — it leaves a row that RESURRECTS the erased user's ownership on the next restart, while
  // the endpoint has already told them, and the operator, that everything was deleted. Being wrong
  // about a deletion is worse than failing at one: the user stops asking.
  //
  // SQLITE_BUSY is the realistic trigger and it is a RATE here, not an impossibility: two processes
  // have shared this WAL since the proxy split, and the buyItemListing incident was exactly a BUSY
  // on a write nobody expected to fail.
  //
  // One retry, then throw. Throwing is safe precisely because every statement in both halves is a
  // DELETE or an anonymising UPDATE keyed by sub: a caller that retries finishes the job instead of
  // double-counting, so the failure mode is "try again", never "half-erased twice".
  // Same contract for every registered store, and the retry-then-THROW is the load-bearing part:
  // see the reasoning above. A store that fails twice aborts the whole call rather than reporting a
  // deletion that did not happen.
  for (const [name, erase] of _erasers) {
    try {
      removed += erase(sub);
    } catch (first) {
      try {
        removed += erase(sub);
      } catch (second) {
        throw new Error(
          `GDPR erasure incomplete: the main database was wiped but the "${name}" store was not `
          + `(${(second as Error).message}; first attempt: ${(first as Error).message}). `
          + `Retry — every statement is idempotent.`,
        );
      }
    }
  }
  return removed;
}
