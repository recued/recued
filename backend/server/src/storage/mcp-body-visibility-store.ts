/** D-139 P6.B — MCP body-content visibility grant store.
 *
 *  Body content (mail bodies, meeting notes, call recap text) is
 *  STRIPPED from MCP engagement reads by default (§ A.9.5 body-content
 *  privacy gate; `projectEngagementRowForMCP` drops `body_inline` +
 *  `vendor_raw_timestamp`). A pack install can grant the closed-list
 *  registry key `data.contact.engagements.body_content`
 *  (`ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY`); the `crm-commitment-tracker`
 *  pack — whose whole point is body extraction — ships exactly that
 *  grant. When granted, `recued_contactEngagementsList` inlines body
 *  content instead of stripping it.
 *
 *  Scope: the grant is SERVER/INSTALL-scoped, keyed by the granting
 *  pack `(pack_slug, publisher)` — matching the
 *  `grantBodyVisibility({ pack_slug, publisher, grants, granted_at })`
 *  install callback (which carries NO token). `isGranted(key)` is the
 *  read-time check: "is this key granted by ANY installed pack on this
 *  server?" The MCP per-tool checklist (`inboundTokenAuthorize`) still
 *  gates whether a door reaches the engagement tool AT ALL; this store
 *  gates whether the body is included once it does. Finer per-door body
 *  gating is a noted future refinement (it needs the door-checklist UI).
 *
 *  Mirrors the standing-instructions store's pack-keyed lifecycle:
 *  install grants, uninstall + install-rollback revoke by pack. Drop a
 *  pack's rows by `(pack_slug, publisher)` — robust to manifest drift
 *  between install + uninstall (a pack that bumped its grant set still
 *  has its old rows dropped).
 */

import type Database from 'better-sqlite3';

export const MCP_BODY_VISIBILITY_TABLE = 'mcp_body_visibility_grants';

/** Idempotent schema install. One row per `(pack_slug, publisher,
 *  grant_key)`. The `grant_key` index backs the hot read path
 *  (`isGranted` — a key-only EXISTS across all packs). */
export const ensureMcpBodyVisibilitySchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MCP_BODY_VISIBILITY_TABLE} (
      pack_slug   TEXT NOT NULL,
      publisher   TEXT NOT NULL,
      grant_key   TEXT NOT NULL,
      granted_at  INTEGER NOT NULL,
      PRIMARY KEY (pack_slug, publisher, grant_key)
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_body_visibility_grant_key
      ON ${MCP_BODY_VISIBILITY_TABLE} (grant_key);
  `);
};

export interface McpBodyVisibilityStore {
  /** Persist the closed-list body-content grant keys a pack install
   *  consented to. Idempotent upsert (re-install / version bump
   *  refreshes `granted_at`). Empty `grants` is a no-op. */
  grant(input: {
    pack_slug: string;
    publisher: string;
    grants: ReadonlyArray<string>;
    granted_at: number;
  }): void;
  /** Drop a pack's body grants. With `grants`, drops only those
   *  `(pack_slug, publisher, key)` rows (the install-rollback path
   *  passes the exact keys it just granted); without, drops EVERY row
   *  for the pack (the uninstall path — robust to manifest drift).
   *  `publisher` is OPTIONAL for the whole-pack (no-`grants`) revoke: an
   *  orphaned marketplace pack (its `installed_pack` inventory-write failed)
   *  has no recorded publisher, so uninstall drops EVERY grant for the slug
   *  (any publisher) rather than leave body content exposed after the user
   *  believes the pack was removed. The `grants` variant still requires a
   *  publisher (its only caller — install rollback — always has one).
   *  Returns the grant keys actually removed. */
  revokeForPack(input: {
    pack_slug: string;
    publisher?: string;
    grants?: ReadonlyArray<string>;
  }): string[];
  /** Read-time gate: is `grant_key` granted by ANY installed pack on
   *  this server? The MCP body-content check. */
  isGranted(grant_key: string): boolean;
  /** Every distinct currently-granted key (across all packs). For the
   *  Settings surface + tests. */
  listGrantedKeys(): string[];
  /** The grant keys currently held by ONE pack `(pack_slug, publisher)`.
   *  Used by the install wiring to snapshot pre-existing grants so a
   *  rollback only revokes the keys THIS transaction added. */
  listGrantsForPack(input: { pack_slug: string; publisher: string }): string[];
  /** Does ANY publisher hold a grant under this `pack_slug`? The uninstall
   *  existence proof: a body grant can be a marketplace pack's ONLY durable
   *  artifact (a recipe-free pack whose best-effort inventory write failed), so
   *  it must keep the pack uninstallable — else the grant orphans + body content
   *  stays MCP-readable after the user removed the pack. */
  hasGrantsForPackSlug(pack_slug: string): boolean;
}

export const createMcpBodyVisibilityStore = (
  db: Database.Database,
): McpBodyVisibilityStore => {
  ensureMcpBodyVisibilitySchema(db);

  const upsertStmt = db.prepare(`
    INSERT INTO ${MCP_BODY_VISIBILITY_TABLE}
      (pack_slug, publisher, grant_key, granted_at)
      VALUES (@pack_slug, @publisher, @grant_key, @granted_at)
    ON CONFLICT(pack_slug, publisher, grant_key) DO UPDATE SET
      granted_at = excluded.granted_at
  `);
  const deleteOneStmt = db.prepare(`
    DELETE FROM ${MCP_BODY_VISIBILITY_TABLE}
     WHERE pack_slug = @pack_slug AND publisher = @publisher AND grant_key = @grant_key
  `);
  const selectKeysForPackStmt = db.prepare(`
    SELECT grant_key FROM ${MCP_BODY_VISIBILITY_TABLE}
     WHERE pack_slug = @pack_slug AND publisher = @publisher
  `);
  const deleteForPackStmt = db.prepare(`
    DELETE FROM ${MCP_BODY_VISIBILITY_TABLE}
     WHERE pack_slug = @pack_slug AND publisher = @publisher
  `);
  // Slug-wide (any-publisher) variants — the uninstall recovery path when the
  // pack's publisher is unknown (orphaned marketplace install, no inventory row).
  const selectKeysForPackSlugStmt = db.prepare(`
    SELECT grant_key FROM ${MCP_BODY_VISIBILITY_TABLE} WHERE pack_slug = @pack_slug
  `);
  const deleteForPackSlugStmt = db.prepare(`
    DELETE FROM ${MCP_BODY_VISIBILITY_TABLE} WHERE pack_slug = @pack_slug
  `);
  const existsForPackSlugStmt = db.prepare(`
    SELECT 1 FROM ${MCP_BODY_VISIBILITY_TABLE} WHERE pack_slug = @pack_slug LIMIT 1
  `);
  const existsByKeyStmt = db.prepare(`
    SELECT 1 FROM ${MCP_BODY_VISIBILITY_TABLE} WHERE grant_key = ? LIMIT 1
  `);
  const distinctKeysStmt = db.prepare(`
    SELECT DISTINCT grant_key FROM ${MCP_BODY_VISIBILITY_TABLE} ORDER BY grant_key ASC
  `);

  return {
    grant({ pack_slug, publisher, grants, granted_at }) {
      for (const grant_key of grants) {
        if (typeof grant_key !== 'string' || grant_key.length === 0) continue;
        upsertStmt.run({ pack_slug, publisher, grant_key, granted_at });
      }
    },
    revokeForPack({ pack_slug, publisher, grants }) {
      // The per-grant (install-rollback) shape REQUIRES a publisher — a
      // grants-without-publisher call would silently fall through to the
      // slug-wide whole-pack delete below and drop EVERY grant for the slug,
      // ignoring the list. Fail closed on that caller / version skew.
      if (grants !== undefined && publisher === undefined) {
        throw new Error('revokeForPack: `grants` requires a `publisher`');
      }
      // Per-grant delete (install rollback) — publisher-scoped by its only caller.
      if (grants !== undefined && publisher !== undefined) {
        const removed: string[] = [];
        for (const grant_key of grants) {
          if (typeof grant_key !== 'string' || grant_key.length === 0) continue;
          const result = deleteOneStmt.run({ pack_slug, publisher, grant_key });
          if (result.changes > 0) removed.push(grant_key);
        }
        return removed;
      }
      // Whole-pack revoke (uninstall): publisher-scoped when known, else slug-wide
      // (any publisher) — an orphaned marketplace pack has no recorded publisher,
      // so drop EVERY grant for the slug rather than leave body content exposed.
      if (publisher !== undefined) {
        const keys = (
          selectKeysForPackStmt.all({ pack_slug, publisher }) as { grant_key: string }[]
        ).map((r) => r.grant_key);
        deleteForPackStmt.run({ pack_slug, publisher });
        return keys;
      }
      const keys = (
        selectKeysForPackSlugStmt.all({ pack_slug }) as { grant_key: string }[]
      ).map((r) => r.grant_key);
      deleteForPackSlugStmt.run({ pack_slug });
      return keys;
    },
    isGranted(grant_key) {
      if (typeof grant_key !== 'string' || grant_key.length === 0) return false;
      return existsByKeyStmt.get(grant_key) !== undefined;
    },
    listGrantedKeys() {
      return (distinctKeysStmt.all() as { grant_key: string }[]).map(
        (r) => r.grant_key,
      );
    },
    listGrantsForPack({ pack_slug, publisher }) {
      return (
        selectKeysForPackStmt.all({ pack_slug, publisher }) as { grant_key: string }[]
      ).map((r) => r.grant_key);
    },
    hasGrantsForPackSlug(pack_slug) {
      return existsForPackSlugStmt.get({ pack_slug }) !== undefined;
    },
  };
};
