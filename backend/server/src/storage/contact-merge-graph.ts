/** D-205 #3.5 — the contact ADDRESS GRAPH. The one place that knows which
 *  addresses a single person answers to.
 *
 *  🔑 **A merge does not MOVE anything.** It records an edge (`merged_into`)
 *  and leaves every row keyed on the address it was written under — moving
 *  would clobber on `(contact_id, kind, source_id)` and destroy the un-merge
 *  (`contact.merge.split`). See D-205 rule 2.
 *
 *  That ruling buys the FORWARD direction for free: the loser survives as a
 *  tombstone, so a stored reference to it still resolves to the survivor.
 *  **It buys the REVERSE direction nothing.** "Given this contact, find its
 *  rows" asks for ONE address, and every row written under an address the
 *  contact later absorbed is invisible to it — not lost, merely unreachable
 *  from the survivor's key. Left alone that is a silent UNDER-COUNT in every
 *  per-contact fact Recued computes: a follow-through score over half the
 *  commitments, a meeting frequency over half the calendar. The number still
 *  renders — it is simply wrong, and the model states it to the user as fact.
 *
 *  ────────────────────────────────────────────────────────────────
 *  🔴 THE MERGE IS ONLY ONE OF **TWO** WAYS AN ADDRESS JOINS A PERSON
 *  ────────────────────────────────────────────────────────────────
 *  The first cut of this module walked the merge graph and nothing else, and
 *  its own docstring gave away the bug: it promised *"every address the contact
 *  ANSWERS TO"* and delivered *"every address merged away into it"* — a strict
 *  subset. The substrate's address space (slice 4) is the union of TWO tables,
 *  and `resolveCanonicalEmail` reads both:
 *
 *    - `contacts.email`            — the PK, plus every tombstone redirecting to it
 *    - `contact_alias`             — kind `email_alias`, the SECONDARY addresses
 *
 *  So an address can reach a person WITHOUT ever having been merged, and two
 *  live paths do exactly that:
 *
 *    - **an import attaches one.** A vendor record is multi-valued upstream
 *      (Pipedrive natively; HubSpot/Salesforce whenever the record carries a
 *      second address), and the sync write-pass upserts EVERY supplied address
 *      as an `email_alias`. Bob's mail from `bob@personal.com` is Bob's mail.
 *    - **a PROMOTION retires one.** `promoteMentionOnlyToVerified` re-keys the
 *      `email` PK and keeps the outgoing synthetic as an `email_alias` — NOT a
 *      tombstone. So the address a `mention_only` / `partial` contact's rows
 *      were written under is, after promotion, reachable ONLY through the alias
 *      table. Contact books (D-205 #4) mint those contacts EN MASSE.
 *
 *  A merge-only walk misses both. This module is the union of the two.
 *
 *  ────────────────────────────────────────────────────────────────
 *  The single definition — four steps:
 *
 *    1. **Forward-resolve to the TERMINAL survivor.** Never trust the id you
 *       were handed: a stored survivor may itself have been merged onward, and
 *       a walk that stops at the first hop lands on a tombstone and leaves the
 *       real survivor stale forever.
 *    2. **Reverse-expand.** Every tombstone whose `merged_into` chain
 *       terminates at that survivor — transitively: with A→B→C, asking for C
 *       must surface both A and B.
 *    3. **Add the survivor's own address**, which step 2 never returns (a live
 *       row's `merged_into` is NULL, so the CTE's seed `WHERE merged_into = ?`
 *       cannot match it). ⚠ This is the step `engagement-store`'s
 *       `ContactIdentityExpansion` doc-comment claims is automatic. It is not —
 *       its caller adds the survivor by hand.
 *    4. **Union the ALIAS space** — every `email_alias` of every contact in the
 *       group. Per GROUP member, not just the survivor: a merge leaves the
 *       loser's alias rows on the LOSER's `contact_id` (step 0's ruling — the
 *       merge moves nothing), and those addresses still resolve to the survivor
 *       through the tombstone. Reading only the survivor's aliases would
 *       reintroduce the same under-read one table over.
 *
 *  **Deterministically ordered.** An aggregate whose input set reorders
 *  FLICKERS between values from identical data — worse than being wrong,
 *  because it is not reproducible.
 *
 *  **Cycle-safe.** `UNION` (not `UNION ALL`) makes a corrupt redirect cycle
 *  terminate by deduplication instead of recursing forever; the forward walk
 *  is depth-capped for the same reason.
 *
 *  ⚠ **A contact with no merges and no aliases yields exactly `[its own
 *  address]`** — so every caller is behavior-identical until one exists. This
 *  WIDENS reads; it does not change them. */

import type Database from 'better-sqlite3';

import { canonicalizeEmail } from '@recued/contracts';

/** The contacts table. Owned here so the merge-graph SQL below and
 *  `contact-store`'s own statements can never name two different tables. */
export const CONTACT_TABLE = 'contacts';

/** The alias table — the OTHER half of the address space (see the header).
 *  Owned here for the same reason `CONTACT_TABLE` is; `contact-store`
 *  re-exports it, so there is one definition and two doors. */
export const CONTACT_ALIAS_TABLE = 'contact_alias';

/** Forward-walk cap. A `merged_into` cycle is corruption, not a shape the
 *  substrate should hang on. The reverse CTE dedups its way out; this caps the
 *  forward walk to match. */
const MAX_REDIRECT_DEPTH = 32;

/** The reverse merge walk — every tombstone address whose `merged_into` chain
 *  terminates at `?`, transitively.
 *
 *  **ONE definition**: `contact-store`'s `listMergedSourceEmails` prepares this
 *  same SQL. Two copies of a graph walk is how the survivor's set and the
 *  store's set drift apart.
 *
 *  `UNION` (not `UNION ALL`) terminates a corrupt cycle by deduplication;
 *  `idx_contacts_merged_into` serves each expansion step; `ORDER BY email ASC`
 *  keeps the set deterministic. */
export const MERGED_SOURCE_EMAILS_SQL = `WITH RECURSIVE merged_sources(email) AS (
       SELECT email FROM ${CONTACT_TABLE} WHERE merged_into = ?
       UNION
       SELECT c.email FROM ${CONTACT_TABLE} c
         JOIN merged_sources ms ON c.merged_into = ms.email
     )
     SELECT email FROM merged_sources ORDER BY email ASC`;

/** One contact's SECONDARY addresses — the alias half of the address space.
 *
 *  Keyed by the member's `email` rather than its `contact_id` because the merge
 *  walk speaks in addresses; the join is a PK lookup on `contacts` followed by
 *  `idx_contact_alias_by_contact`. Called once per GROUP MEMBER, which is one
 *  extra indexed read for the overwhelmingly common unmerged contact.
 *
 *  Kind-filtered to `email_alias` deliberately: `phone_alias` / `chat_alias` /
 *  `platform_id` identify the person on ANOTHER axis and are not addresses that
 *  a row can be keyed on. Folding them in would poison every `LIKE` pre-narrow
 *  with a phone number. */
export const CONTACT_ALIAS_EMAILS_SQL = `SELECT ca.alias_pattern_normalized AS email
       FROM ${CONTACT_ALIAS_TABLE} ca
       JOIN ${CONTACT_TABLE} c ON c.contact_id = ca.contact_id
      WHERE ca.kind = 'email_alias' AND c.email = ?`;

/** The OWNING contact's PK address for an alias — the slice-4 fall-through, in
 *  reverse of the one above.
 *
 *  🔑 The forward walk needs this and it is not optional. A caller passes "the
 *  address a row is keyed on", and after a PROMOTION that address is an alias:
 *  the `contacts` PK was re-keyed out from under every row written while the
 *  contact was `mention_only`. A walk that only follows `merged_into` finds no
 *  row for it, concludes "unknown address", and resolves it to ITSELF — so the
 *  contact's own rows come back as a set of one, and the promotion redirect
 *  (`81c5a9671`) that exists precisely to make that address resolve is never
 *  consulted. `contactByAnyEmail` has always fallen through to this index; this
 *  walk simply has to do the same. */
export const CONTACT_ALIAS_OWNER_SQL = `SELECT c.email AS email
       FROM ${CONTACT_ALIAS_TABLE} ca
       JOIN ${CONTACT_TABLE} c ON c.contact_id = ca.contact_id
      WHERE ca.kind = 'email_alias' AND ca.alias_pattern_normalized = ?
      LIMIT 1`;

interface MergeGraphStatements {
  /** `null` when the database has no `contacts` table — see `graphFor`. */
  readonly forward: Database.Statement | null;
  readonly reverse: Database.Statement | null;
  /** Survivor-row `name` lookup for `contactDisplayName`. Null on the
   *  same no-`contacts`-table condition as `forward`. */
  readonly nameOf: Database.Statement | null;
  /** `null` when the database has no `contact_alias` table — a producer test
   *  fixture that built only `contacts`. The merge half still answers; the
   *  alias half degrades to empty, which is exactly its un-aliased value. */
  readonly aliases: Database.Statement | null;
  /** Alias → the owning contact's PK address. Null on the same condition. */
  readonly aliasOwner: Database.Statement | null;
}

/** Prepared statements are compiled once per database handle. The producers
 *  call `contactAddressSet` once per contact per cycle — re-preparing the CTE
 *  on every call would compile it thousands of times a sweep. */
const graphs = new WeakMap<Database.Database, MergeGraphStatements>();

const graphFor = (db: Database.Database): MergeGraphStatements => {
  const cached = graphs.get(db);
  if (cached !== undefined) return cached;
  // A database with no `contacts` table has no merge graph, so every address
  // is its own whole set. Production ALWAYS has the table (the contact store
  // creates it at boot, and without it every contact read would already be
  // broken) — this branch exists for the producer test fixtures, which build
  // only the one collection table under test. Guarding here rather than
  // letting `db.prepare` throw keeps those fixtures meaningful: they assert
  // the un-merged behavior, which is exactly `[the address]`.
  //
  // The two tables are probed INDEPENDENTLY: they are one substrate in
  // production (the store creates both), but a fixture may hold either alone,
  // and a missing alias table must degrade the alias half to empty rather than
  // take the merge half down with it.
  const hasTable = (name: string): boolean =>
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
      .get(name) !== undefined;
  // Probe COLUMNS, not just the table: a producer test fixture may build a
  // PARTIAL `contacts` (an email-only directory with no merge columns, or a
  // merge-only skeleton with no `name`). Each statement degrades
  // independently — a missing `merged_into` makes every address its own
  // whole set (exactly the un-merged behavior those fixtures assert), and a
  // missing `name` makes `contactDisplayName` return `undefined` (exactly
  // its no-directory-name value) — rather than one absent column taking the
  // whole graph down at prepare time.
  const contactColumns = hasTable(CONTACT_TABLE)
    ? new Set(
        (db.prepare(`PRAGMA table_info(${CONTACT_TABLE})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      )
    : null;
  const graph: MergeGraphStatements = {
    ...(contactColumns !== null && contactColumns.has('merged_into')
      ? {
          forward: db.prepare(`SELECT merged_into FROM ${CONTACT_TABLE} WHERE email = ?`),
          reverse: db.prepare(MERGED_SOURCE_EMAILS_SQL),
        }
      : { forward: null, reverse: null }),
    nameOf:
      contactColumns !== null && contactColumns.has('name')
        ? db.prepare(`SELECT name FROM ${CONTACT_TABLE} WHERE email = ?`)
        : null,
    // The alias joins reach BOTH tables, so they need both present.
    aliases:
      hasTable(CONTACT_ALIAS_TABLE) && hasTable(CONTACT_TABLE)
        ? db.prepare(CONTACT_ALIAS_EMAILS_SQL)
        : null,
    aliasOwner:
      hasTable(CONTACT_ALIAS_TABLE) && hasTable(CONTACT_TABLE)
        ? db.prepare(CONTACT_ALIAS_OWNER_SQL)
        : null,
  };
  graphs.set(db, graph);
  return graph;
};

/** Steps 1a + 1b of the walk — land on the contact row that OWNS the seed,
 *  then forward-resolve THAT row to the TERMINAL survivor. Shared by
 *  `contactAddressSet` and `contactDisplayName` so the two doors can never
 *  disagree about who the survivor is.
 *
 *  1a. The seed is "the address a row is keyed on", and that is not always a
 *  `contacts` PK. A PROMOTION re-keys the PK and demotes the outgoing address
 *  to an `email_alias`, so every row written while the contact was
 *  `mention_only` is now keyed on an address that has NO contacts row at all.
 *  Reading `merged_into` for it finds nothing, which is indistinguishable from
 *  "unknown address" — and the walk would resolve it to itself and hand back a
 *  set of one, silently, for the contact whose rows we were asked to find.
 *  So fall through to the alias index exactly as `contactByAnyEmail` does. A
 *  genuinely unknown address still round-trips to itself (callers canonicalize
 *  before creating a contact, so a miss must not vanish).
 *
 *  1b. Forward-resolve to the TERMINAL survivor — the owning row may itself be
 *  a tombstone, and a walk that stops at the first hop leaves the real
 *  survivor stale forever. */
const resolveSurvivorAddress = (
  graph: MergeGraphStatements,
  seed: string,
): string => {
  const { forward, aliasOwner } = graph;
  if (forward === null) return seed;

  let survivor = seed;
  if (aliasOwner !== null && forward.get(seed) === undefined) {
    const owner = aliasOwner.get(seed) as { email: string } | undefined;
    if (owner !== undefined) survivor = owner.email;
  }

  const walked = new Set<string>([survivor]);
  for (let hop = 0; hop < MAX_REDIRECT_DEPTH; hop += 1) {
    const row = forward.get(survivor) as { merged_into: string | null } | undefined;
    const next = row?.merged_into ?? null;
    if (next === null) break; // live row, or unknown address — terminal either way
    if (walked.has(next)) break; // corrupt cycle — stop, do not spin
    walked.add(next);
    survivor = next;
  }
  return survivor;
};

/** Display name of the PERSON reachable from `email` — the terminal
 *  survivor's `contacts.name`, resolved through the same alias + merge walk
 *  as `contactAddressSet` (one definition; see the module header).
 *
 *  Bench harvest (internal benchmarks P1 v6–v12): enrichment
 *  producers denormalize `{ entity, name }` pairs into their values at
 *  producer-run time so LLM surfaces present people by name without a
 *  per-question `entity.query` resolution loop. `undefined` when the input
 *  is un-canonicalizable, the database has no `contacts` table, the row is
 *  absent, or the row carries no name — callers OMIT the field rather than
 *  fabricate one. */
export const contactDisplayName = (
  db: Database.Database,
  email: string,
): string | undefined => {
  const seed = canonicalizeEmail(email);
  if (seed === '') return undefined;

  const graph = graphFor(db);
  if (graph.nameOf === null) return undefined;

  const survivor = resolveSurvivorAddress(graph, seed);
  const row = graph.nameOf.get(survivor) as { name: string | null } | undefined;
  const name = row?.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
};

/** Every address the contact reachable from `email` answers to:
 *
 *    the terminal survivor's own address
 *  ∪ every address MERGED away into it (transitively)
 *  ∪ every `email_alias` of every contact in that group
 *
 *  — i.e. exactly the address space `resolveCanonicalEmail` resolves THROUGH,
 *  read in reverse. The third term is not a refinement: an address can reach a
 *  person without ever having been merged (an import attaches a second address;
 *  a promotion retires the synthetic one), and a merge-only walk misses both.
 *  See the module header.
 *
 *  Pass the address a row is keyed on (a `ContactRecord.email`, a stored
 *  `assigned_contact_id`); the forward walk absorbs the case where that address
 *  has since been merged onward. Returns `[]` only for an un-canonicalizable
 *  input. Ascending order.
 *
 *  ⚠ The synthetic `mention-only-…@_recued.invalid` placeholder is a real
 *  stored address and is returned like any other — a caller that must not show
 *  it to a human filters it (`chat-prompt-cache-gate` does). After a promotion
 *  it arrives via the ALIAS term, which is precisely the point: the rows written
 *  while the contact was `mention_only` are still keyed on it. */
export const contactAddressSet = (
  db: Database.Database,
  email: string,
): string[] => {
  const seed = canonicalizeEmail(email);
  if (seed === null) return [];

  const graph = graphFor(db);
  const { forward, reverse, aliases } = graph;
  if (forward === null || reverse === null) return [seed];

  const survivor = resolveSurvivorAddress(graph, seed);

  // 2. Reverse-expand + 3. add the survivor (the CTE cannot return it).
  const members = new Set<string>([survivor]);
  for (const row of reverse.all(survivor) as Array<{ email: string }>) {
    members.add(row.email);
  }

  // 4. Union the ALIAS space, per GROUP MEMBER.
  //
  // Per member, not just the survivor: the merge moves nothing, so a loser's
  // `email_alias` rows stay on the LOSER's `contact_id` — and they still resolve
  // to the survivor through the tombstone, so they are still addresses this
  // person answers to. Reading only the survivor's aliases would reintroduce the
  // very under-read this step exists to close, one table over.
  //
  // The snapshot is load-bearing: we are adding to the set we iterate. It is
  // also SUFFICIENT — an alias hangs off a `contact_id`, and every contact in
  // the group is already a member, so there is no second generation to walk.
  if (aliases !== null) {
    for (const member of [...members]) {
      for (const row of aliases.all(member) as Array<{ email: string | null }>) {
        // `alias_pattern_normalized` for an `email_alias` is `canonicalizeEmail`
        // output by construction (the store normalizes on write, and the slice-4
        // resolver matches against this exact column), so it is already in the
        // one canonical form every consumer compares against.
        const alias = row.email;
        if (typeof alias === 'string' && alias.length > 0) members.add(alias);
      }
    }
  }

  return [...members].sort();
};
