/** D-255 — the CANONICAL op tool descriptors a door may be granted.
 *
 *  The sibling of `raw-op-tool-catalog.ts`, and the difference is the whole point.
 *  A raw op names ONE vendor operation on one installed pack
 *  (`recued_op_<publisher>.<pack>.<operation>`). A canonical op names an
 *  `(alias × verb)` — `recued_canonical_contact.update` — that resolves to whichever
 *  vendor the SUPPLIED CONNECTION is, at dispatch, through R2.
 *
 *  🔑 ONE DESCRIPTOR PER (alias, verb), NEVER PER CONNECTION. The canonical name is
 *  vendor-agnostic by construction, so the connection is an ARGUMENT, not part of
 *  the identity. Minting `recued_canonical_contact.update@hubspot1` would rebuild
 *  the per-vendor catalog this surface exists to collapse — and it would put the
 *  connection in the one place D-254 ruled it must not be: a name carrying
 *  authority. The per-connection decision stays where it already lives, on the
 *  RESOLVED vendor op, gated by the connection's operation profile and the op axis.
 *
 *  ⛔ AN ALIAS WITH NO BOUND CONNECTION IS NOT LISTED. D-254's visibility matrix
 *  settled this for the generic entry point — "a generic entry point with no
 *  reachable target is a tool that can only fail" — and it applies verbatim here:
 *  advertising `invoice.update` to an owner with no accounting connection spends a
 *  model's turn to earn a refusal it could not have predicted.
 *
 *  ⚠ THIS BUILDS NAMES, NOT PERMISSION. Every descriptor here still has to be
 *  granted on the door's per-token checklist before it is callable, exactly as a
 *  raw op does; and the dispatch it names is gated again on the resolved vendor op.
 *  Appearing in this list is a statement about what COULD be granted. */

import {
  CANONICAL_CRM_VERBS,
  CANONICAL_OP_TOOL_PREFIX,
  CONNECTION_VENDOR_ENTITIES,
  TIER1_TOOL_ENTITY,
  kernelVerbRiskTier,
  type ConnectionVendorEntity,
} from '@recued/contracts';

import { ingredientRiskToGrantClassification } from './raw-op-tool-catalog.js';

/** One canonical op tool, in the shape both door surfaces (the grant catalog and
 *  `tools/list`) map into their own entry. Mirrors `RawOpToolDescriptor` field for
 *  field where the meaning is the same, so the two can be concatenated. */
export interface CanonicalOpToolDescriptor {
  /** wire name `recued_canonical_<alias>.<verb>`. */
  wireName: string;
  /** the canonical op id `<alias>.<verb>` — what the transient recipe's op-step
   *  carries, and what the resolver dispatches on. */
  opId: string;
  alias: string;
  verb: string;
  description: string;
  inputSchema: unknown;
  classification: 'read' | 'write' | 'unknown';
  /** the bound connections this alias can resolve against, for the description and
   *  for the caller's own pre-check. NOT part of the identity. */
  connections: readonly string[];
}

const aliasOf = (entry: ConnectionVendorEntity): string | undefined =>
  entry.crm_alias ?? entry.acct_alias;

/** ⛔⛔ THE ALIASES A TIER-1 TOOL ALREADY SEARCHES — DERIVED, never listed.
 *
 *  A Tier-1 search tool is literally named `<alias>.search`, so the covered set
 *  falls out of the tool registry itself and cannot drift from it.
 *
 *  🔑 WHY SUPPRESS RATHER THAN ADD: the Tier-1 tool fans out to ALL SOURCES of its
 *  entity, and `contact.search` includes the OWNER'S OWN `data.contact` graph
 *  (`buildLocalContactSource`) alongside every CRM mirror. A canonical
 *  `contact.search` fans out over CONNECTIONS only — the local graph is not a
 *  connection and R2 could not resolve it as one — so shipping both offers the
 *  model two tools for one concept where the newer one SILENTLY OMITS a source.
 *  A model that picks it gets a confident answer over a subset, which is the exact
 *  failure `wrapEmptyResults` exists to prevent, reintroduced one layer up.
 *
 *  Same doctrine as §8 recipe-preferred suppression, which hides a raw primitive an
 *  installed recipe already covers: the headline tool is the guardrailed one, and
 *  the primitive beside it lets the AI sidestep what the headline tool guarantees.
 *
 *  ⚠ CONSEQUENCE, STATED PLAINLY: every shipped `crm_alias` has a Tier-1 search, so
 *  this suppresses canonical `search` for ALL of them today and the canonical
 *  fan-out is LATENT — it lights up for an alias with no Tier-1 tool (the accounting
 *  family). The fan-out was the duplicate; the Tier-1 tool was already the answer. */
const TIER1_SEARCHED_ALIASES: ReadonlySet<string> = new Set(
  Object.keys(TIER1_TOOL_ENTITY)
    .filter((name) => name.endsWith('.search'))
    .map((name) => name.slice(0, -'.search'.length)),
);

/** Build the canonical op tools reachable for a set of bound connections.
 *
 *  `boundConnections` is `(name, vendor)` for every enrolled api connection — the
 *  same pair `resolveConnectionVendor` yields. An alias is offered when at least
 *  one bound connection's vendor declares an entity carrying it. */
export const buildCanonicalOpToolDescriptors = (input: {
  boundConnections: ReadonlyArray<{ name: string; vendor: string }>;
  /** ⛔⛔ THE VISIBILITY GATE, AND IT IS CONTRACT-GENERAL BY CONSTRUCTION.
   *
   *  `(connectionName, vendorOpKey) => granted`. A canonical `<alias>.<verb>` is
   *  offered for a connection only when that connection's operation profile grants
   *  the VENDOR op the alias resolves to — `account.update` is `company.update` on
   *  HubSpot, `account.update` on Salesforce, `organization.update` on Pipedrive,
   *  and the registry supplies which.
   *
   *  🔑 THIS IS WHY THERE IS NO OWNER-VS-DOOR BRANCH. The owner is the `user_self`
   *  contract and a door is another contract id; both resolve through the same
   *  grant. An earlier cut gated the door listing on the MCP per-token checklist —
   *  a mechanism only doors have — which would have left the owner's own catalog
   *  unfiltered while looking correct on the surface that was tested.
   *
   *  ⚠ ABSENT ⇒ UNFILTERED, matching the raw-op source's documented posture for a
   *  missing gate (over-exposure, never hiding a write) and keeping dbless
   *  harnesses working. The dispatch is gated regardless — deny-until-granted at
   *  the connection profile is the enforcement; this only decides what is worth
   *  advertising. */
  grantsVendorOp?: (connectionName: string, vendorOpKey: string) => boolean;
  registry?: ReadonlyArray<ConnectionVendorEntity>;
}): CanonicalOpToolDescriptor[] => {
  const registry = input.registry ?? CONNECTION_VENDOR_ENTITIES;
  const grants = input.grantsVendorOp;

  // alias → [(connection, the vendor ENTITY it resolves that alias to)].
  const servingByAlias = new Map<string, { name: string; entity: string }[]>();
  for (const conn of input.boundConnections) {
    for (const entry of registry) {
      if (entry.vendor !== conn.vendor) continue;
      const alias = aliasOf(entry);
      if (alias === undefined) continue;
      const list = servingByAlias.get(alias) ?? [];
      if (!list.some((c) => c.name === conn.name)) {
        list.push({ name: conn.name, entity: entry.entity });
      }
      servingByAlias.set(alias, list);
    }
  }

  const out: CanonicalOpToolDescriptor[] = [];
  for (const [alias, serving] of [...servingByAlias].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const verb of CANONICAL_CRM_VERBS) {
      // Per VERB, because a profile grants reads without writes — the common case.
      // `account.read` may be offered while `account.update` is not.
      const connections = serving
        .filter((c) => grants === undefined || grants(c.name, `${c.entity}.${verb}`))
        .map((c) => c.name);
      if (connections.length === 0) continue;
      // ⛔ A canonical search is suppressed where a Tier-1 tool already fans out
      // over MORE sources for the same entity. CRUD has no Tier-1 equivalent and
      // is exactly what the canonical layer is for.
      if (verb === 'search' && TIER1_SEARCHED_ALIASES.has(alias)) continue;
      const risk = kernelVerbRiskTier(verb);
      // ⛔ An unclassifiable verb is skipped, never defaulted. `kernelVerbRiskTier`
      // partitions the canonical verb set exactly, so this is unreachable today —
      // and a verb added without a tier must not silently arrive as `unknown`,
      // which the checklist's read-default would treat as the cheaper class.
      if (risk === null) continue;
      const opId = `${alias}.${verb}`;
      out.push({
        wireName: `${CANONICAL_OP_TOOL_PREFIX}${opId}`,
        opId,
        alias,
        verb,
        classification: ingredientRiskToGrantClassification(risk),
        description:
          `Canonical ${alias} ${verb} — resolves to the vendor operation of the `
          + `named connection at dispatch. Available connections: `
          + `${connections.join(', ')}.`,
        inputSchema: {
          type: 'object',
          properties: {
            connection: {
              type: 'string',
              enum: [...connections],
              description: verb === 'search'
                ? 'The enrolled connection to search. OMIT to search every '
                  + `connection that serves ${alias} and get one merged result.`
                : 'The enrolled connection to resolve against. Its vendor decides '
                  + 'which operation actually runs.',
            },
            args: {
              type: 'object',
              description:
                `Canonical ${alias} fields — canonical names, not vendor property `
                + 'names. The resolver reverse-maps them to the vendor write body.',
            },
          },
          // ⛔⛔ FAN-OUT IS `search`-ONLY, AND THE OTHER VERBS STAY REQUIRED.
          //
          //  - `create` / `update` / `delete` — omitting the connection would write
          //    to EVERY connected CRM. There is no reading of "the default" that
          //    makes an unscoped destructive write correct.
          //  - `read` takes an ID, and an id belongs to exactly ONE connection
          //    (D-254: the id names its own connection). Fanning it out would ask
          //    every other vendor about a record that is definitionally not theirs.
          //
          //  `search` alone has no id and no side effect, so "look everywhere unless
          //  told otherwise" is both safe and what a caller means.
          ...(verb === 'search' ? {} : { required: ['connection'] }),
          additionalProperties: false,
        },
        connections,
      });
    }
  }
  return out;
};

/** The canonical op tools reachable for a server's ENROLLED api connections.
 *
 *  The deps-level convenience both door surfaces call, so neither re-derives
 *  "which connections count" — `kind: 'api'` with a resolvable vendor, read
 *  through `resolveConnectionVendor`, the same resolver the grant-write path and
 *  the profile seed share (they are kept in lock-step deliberately; a third
 *  reading of `config_json.vendor` would be a third thing to drift).
 *
 *  ⚠ NO STORE ⇒ NO TOOLS. A dbless harness advertises none rather than
 *  advertising all — the same posture `path_scope` takes when its store is absent,
 *  and the safe direction: an unlisted tool is discoverable by nobody, while a
 *  listed one whose connection cannot be resolved is a turn spent on a refusal. */
export const canonicalOpToolsForConnections = (
  connectionStore: {
    list(query?: { kind?: string }): ReadonlyArray<{ name: string; config_json: string; subtype?: string | null }>;
  } | undefined,
  resolveVendor: (row: { config_json: string; subtype?: string | null }) => string | undefined,
  /** The per-connection operation profile — the SAME deny-until-granted set the
   *  gateway enforces at dispatch (`allowed_operations`, D-182 §7.1: nothing is
   *  auto-admitted at enrolment). Passing it makes the catalog advertise only what
   *  would actually run; omitting it advertises the reachable set. */
  profiles?: { get(connection_name: string): { allowed_operations: ReadonlyArray<string> } | null },
): CanonicalOpToolDescriptor[] => {
  if (connectionStore === undefined) return [];
  const bound: { name: string; vendor: string }[] = [];
  for (const row of connectionStore.list({ kind: 'api' })) {
    const vendor = resolveVendor(row);
    if (vendor !== undefined) bound.push({ name: row.name, vendor });
  }
  return buildCanonicalOpToolDescriptors({
    boundConnections: bound,
    ...(profiles !== undefined
      ? {
        grantsVendorOp: (connectionName: string, vendorOpKey: string): boolean =>
          profiles.get(connectionName)?.allowed_operations.includes(vendorOpKey) ?? false,
      }
      : {}),
  });
};

// ════════════════════════════════════════════════════════════════
// D-255 — fan-out execution for a canonical `search`
// ════════════════════════════════════════════════════════════════

/** One connection's leg of a fanned-out canonical search. */
export interface CanonicalFanoutLeg {
  connection: string;
  ok: boolean;
  result?: unknown;
  /** Present iff `ok` is false. Free-form short text, like
   *  `ScopeSearchPartialFailure.reason`. */
  reason?: string;
}

export interface CanonicalFanoutResult {
  legs: CanonicalFanoutLeg[];
  /** ⛔ TRUE IFF AT LEAST ONE LEG FAILED, AND IT IS NOT DECORATION. A caller that
   *  cannot tell a complete empty from a partial empty will report "there are none"
   *  about a set it never saw — the failure `wrapEmptyResults` already names for
   *  the Tier-1 fan-out ("a boolean beside an empty collection is not a sentence").
   *  Callers surface the reasons, never just the flag. */
  partial: boolean;
}

/** Run a canonical `search` across every supplied connection and merge.
 *
 *  🔑 THE SHAPE IS `runScopeSearchFanout`'s, DELIBERATELY. That runner already
 *  settled this exact problem for the Tier-1 chat tools: run each source, catch a
 *  per-source throw into a NAMED partial failure rather than losing it, and keep
 *  provenance on every result so "which connection said this" survives the merge.
 *  A second answer to the same question is how the first stops being true.
 *
 *  ⛔ SEQUENTIAL, matching that runner's own reasoning — vendor calls carry
 *  rate-limit pressure, and deterministic ordering keeps a partial-failure list
 *  reproducible for tests and legible to a model.
 *
 *  ⛔ ONE LEG'S FAILURE NEVER SINKS THE OTHERS. A CRM being down must degrade the
 *  answer, not replace it: the caller gets the connections that worked plus a named
 *  reason for the one that did not. */
export const runCanonicalSearchFanout = async (
  connections: readonly string[],
  execute: (connection: string) => Promise<unknown>,
): Promise<CanonicalFanoutResult> => {
  const legs: CanonicalFanoutLeg[] = [];
  for (const connection of connections) {
    try {
      legs.push({ connection, ok: true, result: await execute(connection) });
    } catch (err) {
      legs.push({
        connection,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { legs, partial: legs.some((l) => !l.ok) };
};
