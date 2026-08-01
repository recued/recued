/** Packs R22 R3 — the grant-derivation pieces SHARED by the two axes of the
 *  one grant matrix: the by-CONTRACT view (`contract-grants-panel.ts`, one
 *  contract × every entry) and the by-PACK view
 *  (`settings/pack-access-controls.ts`, one pack's ops × every contract).
 *
 *  Extracted VERBATIM from the contract-grants-panel (which now imports them)
 *  so the two panels resolve a cell identically — the derivation IS the gate's
 *  read path, and two private copies would drift:
 *   - a CLI op's authority is the `cli_reachability` allowlist keyed
 *     `(principal, ingredientId, operationKey)`, fail-closed (absent ⇒ off) —
 *     NEVER the `contract_grant` op axis (D-182 §7.2);
 *   - a connection op resolves `explicit row ?? ownerOnlyAdjustedAuthor
 *     Default(entry, contract, authorDefault)` — the same resolver the D-157
 *     gate runs, so the UI can never report a state the gate won't enforce. */

import {
  opGrantEntry,
  ownerOnlyAdjustedAuthorDefault,
  type CatalogIngredientView,
  type CliReachabilityListResponse,
  type DependencyReadAdmission,
  type GrantEntryKind,
  type RiskTier,
} from '@recued/contracts';

/** One grant-able entry. `authorDefault` is the per-entry BASE; the effective
 *  default for a contract is `ownerOnlyAdjustedAuthorDefault` ∘ this, so every
 *  read MUST go through {@link effectiveGrantState}. */
export interface GrantUniverseEntry {
  entry_key: string;
  kind: GrantEntryKind;
  /** Display label (operation_id / collection / topic). */
  label: string;
  /** Ops only — the ingredient/domain group label. */
  group: string;
  /** Catalog ops only — the catalog `ingredient_id` (= the pack composition's
   *  slug, one catalog ingredient per composition), so the by-PACK view can
   *  filter the universe to one pack's membership. Absent on kernel ops,
   *  collections, and topics. */
  ingredientId?: string;
  /** Ops only — the risk tier (drives the badge + "asks" mark). */
  risk_tier?: string;
  /** Topics only — the author description. */
  description?: string;
  authorDefault: boolean;
  /** Ops only — the container reads granting this op TRANSITIVELY admits
   *  (`work_entity_sources[].source_dependencies[]`, D-192 Slice 7): granting a
   *  write op like `issue.create` also lets the gateway read `team.search`
   *  WITHOUT a separate team-read grant, so the grid discloses "also reads: team".
   *  Absent on the (many) ops that admit no container read. */
  also_reads?: ReadonlyArray<DependencyReadAdmission>;
  /** Ops only — present ⇔ the op's ingredient is `kind:'cli'`. Its admission is
   *  the SEPARATE `cli_reachability` allowlist (fail-closed), so panels read +
   *  write its toggle to `cli.reachability.*` keyed `(principal, ingredientId,
   *  operationKey)` — NEVER the `contract_grant` op axis the gate ignores for
   *  cli. `operationKey` is the manifest MAP KEY (e.g. `audio.transcribe`) the
   *  gateway + cli-tool-universe key rows on — DISTINCT from the qualified
   *  `label`/entry_key (`<author>/<slug>.audio.transcribe`); both are carried
   *  so neither can drift. */
  cli?: { ingredientId: string; operationKey: string };
}

/** `cli_reachability` map key — `(ingredient_id, operation_id)` (the principal
 *  axis is handled by {@link cliRowsForPrincipal}). */
export const cliRowKey = (ingredientId: string, operationId: string): string =>
  [ingredientId, operationId].join('::');

/** Project a `cli.reachability.list` response into ONE principal's row map —
 *  filter to `principal`, key by {@link cliRowKey}. */
export const cliRowsForPrincipal = (
  rows: CliReachabilityListResponse['rows'],
  principal: string,
): Map<string, boolean> => {
  const m = new Map<string, boolean>();
  for (const row of rows) {
    if (row.principal !== principal) continue;
    m.set(cliRowKey(row.ingredient_id, row.operation_id), row.allowed);
  }
  return m;
};

/** The installed-pack-catalog slice of the entry universe — one op entry per
 *  catalog operation, cli ops tagged with their reachability routing. (The
 *  kernel / collection / topic slices stay in the by-CONTRACT panel's
 *  `buildUniverse`; the by-PACK view only ranges over catalog ops.) */
export const catalogOpUniverseEntries = (
  ingredients: ReadonlyArray<CatalogIngredientView>,
): GrantUniverseEntry[] => {
  const entries: GrantUniverseEntry[] = [];
  for (const ing of ingredients) {
    // A cli ingredient's ops are gated by the SEPARATE cli_reachability
    // allowlist (D-182 §7.2), NOT the contract_grant op axis — mark them so
    // panels read + write their toggle there. The reachability key's
    // `ingredient_id` is the cli catalog slug (`ing.ingredient_id`).
    const isCli = ing.kind === 'cli';
    for (const op of ing.operations) {
      let entry_key: string;
      try {
        entry_key = opGrantEntry(op.operation_id);
      } catch {
        continue;
      }
      entries.push({
        entry_key,
        kind: 'op',
        label: op.operation_id,
        group: ing.name,
        ingredientId: ing.ingredient_id,
        risk_tier: op.risk_tier,
        authorDefault: op.risk_tier === 'read',
        ...(op.also_reads !== undefined && op.also_reads.length > 0
          ? { also_reads: op.also_reads }
          : {}),
        ...(isCli
          ? { cli: { ingredientId: ing.ingredient_id, operationKey: op.operation_key } }
          : {}),
      });
    }
  }
  return entries;
};

/** THE cell resolver (matches the gate — do not fork):
 *  - CLI op: the `cli_reachability` allowlist is the authority (fail-closed:
 *    absent ⇒ off). It has no author-default ON — the owner enables per-tool.
 *  - Anything else: the contract's explicit row, else the per-(entry ×
 *    contract) owner-only-adjusted author default. */
export const effectiveGrantState = (
  entry: GrantUniverseEntry,
  contractId: string,
  grants: ReadonlyMap<string, boolean>,
  cliRows: ReadonlyMap<string, boolean>,
): 'on' | 'off' => {
  if (entry.cli !== undefined) {
    return cliRows.get(cliRowKey(entry.cli.ingredientId, entry.cli.operationKey)) === true
      ? 'on'
      : 'off';
  }
  const explicit = grants.get(entry.entry_key);
  const value =
    explicit
    ?? ownerOnlyAdjustedAuthorDefault(entry.entry_key, contractId, entry.authorDefault);
  return value ? 'on' : 'off';
};

/** True iff the entry carries an EXPLICIT stored row for this contract — a
 *  grant row for connection ops; a present cli_reachability row for cli ops
 *  (fail-closed, so a present row IS the only ON state). */
export const hasExplicitGrant = (
  entry: GrantUniverseEntry,
  grants: ReadonlyMap<string, boolean>,
  cliRows: ReadonlyMap<string, boolean>,
): boolean => {
  if (entry.cli !== undefined) {
    return cliRows.has(cliRowKey(entry.cli.ingredientId, entry.cli.operationKey));
  }
  return grants.has(entry.entry_key);
};

const RISK_LABEL: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  admin: 'Admin',
  destructive: 'Destructive',
};
export const riskLabel = (risk: string): string =>
  RISK_LABEL[risk] ?? risk.charAt(0).toUpperCase() + risk.slice(1);

/** ⛔ `riskAsks` RETIRED 2026-07-17 — it was `risk !== 'read'`, a TIER-ONLY predicate
 *  standing in for an `f(risk, ceiling, grants)` truth, and its only job was to SUPPRESS
 *  the chip on read. Both jobs are wrong: read needs the loudest chip of all (the grant IS
 *  its whole authorization), and the write/admin claim it gated ("still asks every run") is
 *  not something a tier alone can promise. Replaced by {@link riskApprovalCopy}, which
 *  answers per tier instead of yes/no. (The retired `settings/local-tools-panel.ts` kept a PRIVATE copy
 *  of the old predicate: a different authority axis — `cli_reachability`, D-182 §7.2 — and
 *  deliberately its own wording. Left alone; do not "unify" it without re-verifying what a
 *  granted CLI read actually does.) */

/** The per-tier APPROVAL chip: what the row CLAIMS will happen when this op runs.
 *
 *  🔑 WHY THIS EXISTS (owner, 2026-07-17): *"surfacing as text fixing the mental model is
 *  better than working out in code."* A grant is ACCESS ("may this contract reach the op") —
 *  it is NOT authorization to act; that is the separate APPROVAL axis (op risk vs the
 *  dispatch's trust ceiling). Every other platform equates the two because their grantee is
 *  deterministic code a developer wrote; ours is a model reading text an attacker may have
 *  authored, so the grant bounds the capability SET and the approval bounds the ACT. The two
 *  axes are enforced correctly; what was missing is a reader who understands them.
 *
 *  ⛔ THE POLARITY THAT MUST NOT SHIP: "this is only visibility, permission is governed
 *  elsewhere." FALSE for `read`, i.e. for most of the catalog — a read is NEVER-class: it
 *  admits at every ceiling, so the toggle IS the whole authorization and nothing downstream
 *  will ever ask. `read` previously rendered NO chip at all, which reads as "nothing to say
 *  here" about the one decision no one else will check.
 *
 *  ✅ The `destructive` line is a guarantee VERIFIED end-to-end, not inherited from a comment:
 *  `TrustCeiling` has no `destructive` member (`ingredient-catalog.ts`), `applyTrustCeiling`
 *  relaxes only when op-risk <= ceiling, and no seed's `grantable_risk_tiers` includes
 *  destructive (`session-grant.ts`; the store's put-path floor guard only TIGHTENS). Three
 *  independent legs — hence "no setting removes this" is safe to promise.
 *
 *  ⚠ The write/admin line says "unless you approve it for a session" and NOT "still asks every
 *  run" (the claim it replaces): whether an op asks is `f(risk, ceiling, grants)`, and a
 *  session grant genuinely silences a subsequent write/admin. D-210 §9 is the sharp edge —
 *  the session-grant axis is APPROVAL-BLIND (it tests the TIER, never `resolution.approval`),
 *  so even an `approval: 'always'` write stays grantable. The fence is the TIER, never the tag.
 *
 *  ⛔ Keyed `Record<RiskTier, ...>` so a 5th tier fails COMPILATION here rather than silently
 *  rendering no claim. An unknown runtime value returns undefined ⇒ the caller renders NO chip:
 *  absence of a claim, never a wrong one. */
export interface RiskApprovalCopy {
  /** The chip's visible text. */
  readonly chip: string;
  /** The chip's hover title — the sentence doing the actual teaching. */
  readonly title: string;
}

const ASK_TITLE =
  'Held for your approval each run — unless you approve it for a session.';

const RISK_APPROVAL_COPY: Record<RiskTier, RiskApprovalCopy> = {
  read: {
    chip: 'silent',
    title: 'Granted reads run without asking. Turning this on IS the permission.',
  },
  write: { chip: 'asks', title: ASK_TITLE },
  admin: { chip: 'asks', title: ASK_TITLE },
  destructive: {
    chip: 'always asks',
    title: 'Always held for your approval. No setting removes this.',
  },
};

/** The approval chip for `risk`, or undefined when the tier is unknown (render no
 *  chip — see the closed-list note above). */
export const riskApprovalCopy = (risk: string): RiskApprovalCopy | undefined =>
  (RISK_APPROVAL_COPY as Record<string, RiskApprovalCopy | undefined>)[risk];
