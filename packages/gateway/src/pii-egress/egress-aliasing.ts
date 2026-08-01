/** D-167 P1 — Gateway chat-mode AI-egress PII aliasing.
 *
 *  Gateway owns enforcement at the LLM boundary: alias known PII before AI
 *  egress, keep the mapping local, restore only at approved local boundaries,
 *  and emit a redaction summary into audit (spec §"Gateway"). This module is
 *  the chat-mode composition layer over the pure `@recued/transforms` alias
 *  substrate — the session-scoped ledger lifetime lives in
 *  `session-ledger-store.ts`; the per-packet two-pass alias algorithm and the
 *  restore primitives are the substrate's.
 *
 *  What P1 ships (substrate-only slice — no chat-orchestrator edit):
 *    - `FieldPrivacyResolver` seam + `noopFieldPrivacyResolver` default —
 *      the resolver that decides which packet fields carry a `MetaField.privacy`
 *      tag is INJECTED. P1 ships the no-op (aliases nothing) because the
 *      runtime privacy-tag source (D-165 install-time schema machinery) is not
 *      landed. When it lands, the wiring supplies a resolver that reads the
 *      installed entity schemas for the packet's records.
 *    - `aliasPacketForEgress` — run the identifier + content passes over a
 *      packet against the session ledger; return the aliased copy + the
 *      `redaction_summary` for audit.
 *    - `shouldAliasForEgress` — the `owns_llm_egress` gate (D-163 amendment);
 *      no-op on external-egress channels.
 *    - `restoreForDisplay` / `restoreArgsForApproval` — the local restore
 *      boundaries (assistant reply rendering; D-157 approval-preview).
 *
 *  Spec: D-167 §"Runtime flow", §"Gateway", §"Channel ownership
 *  signal".
 */

import type {
  EntityFieldPrivacy,
  PiiAliasableData,
  PiiFieldTag,
  RedactionMode,
  RedactionSummary,
} from '@recued/contracts';
import {
  aliasArgs,
  aliasFields,
  aliasIdentifierField,
  aliasRecallArgs,
  buildKnownValueIndex,
  cloneLedger,
  commitLedger,
  containsPotentialPiiAliasLiteral,
  createCounters,
  createLedger,
  derivePiiRestoreAuthority,
  preScanReservePii,
  restoreArgs,
  restoreArgsWithAuthority,
  restoreArgsAndKeys,
  restoreArgsAndKeysWithAuthority,
  restoreArgKeysWithAuthority,
  restoreInString,
  restoreInStringWithAuthority,
  restrictStagedLedgerToRestoreAuthority,
  summarizeRedactions,
  tokenizeForOverlap,
  type KnownValueIdentifierSeed,
  type KnownValueIndex,
  type KnownValueSeed,
  type Ledger,
  type PiiRestoreAuthority,
  type RedactionCounters,
  decorateOverlapReveal,
} from '@recued/transforms';

/* ──────────────── Privacy-tag resolver seam ──────────────── */

/**
 * Resolves which fields of an LLM-bound packet carry a `MetaField.privacy`
 * tag, as dot-paths into the packet (the shared `PiiFieldTag` shape — same as
 * the recipe-mode `pii-protect` `fields[]` input).
 *
 * INJECTED at the egress seam. P1 ships `noopFieldPrivacyResolver` because the
 * runtime privacy-tag source — D-165's install-time schema machinery (schema
 * discovery, `discovered_schemas`, `CONNECTION_VENDOR_ENTITIES` regeneration)
 * — is not landed: `MetaField.privacy` exists only as a contract type today,
 * with no registry mapping a packet's records to their field tags. When D-165
 * lands, the wiring supplies a resolver that reads the installed entity
 * schemas for the records present in the packet.
 */
export type FieldPrivacyResolver = (packet: PiiAliasableData) => readonly PiiFieldTag[];

/** The P1 default — no schema source, so no field is tagged and nothing
 *  aliases. The egress path stays a no-op until D-165's runtime schema source
 *  supplies a real resolver. */
export const noopFieldPrivacyResolver: FieldPrivacyResolver = () => [];

/* ──────────────── owns_llm_egress gate (D-163 amendment) ──────────────── */

/** The channel-ownership signal the gate reads. */
export interface EgressGateInput {
  /** D-163 `owns_llm_egress` — does Recued own the LLM↔user boundary on this
   *  medium? The wiring sources it from the chat `surface` (`'chat'` → true;
   *  `'messenger-slack'` / `'messenger-telegram'` → false, since the external
   *  app owns downstream presentation) or the D-158 notification `Channel`.
   *  D-167 only operates when Recued owns the boundary. */
  owns_llm_egress: boolean;
}

/**
 * Whether to apply egress aliasing on this channel. D-167 aliases only when
 * Recued owns the LLM↔user boundary; raw external-egress paths (a raw MCP
 * data-tool request, a messenger surface the external app renders) pass real
 * values because the external client owns downstream presentation and has no
 * Recued restore boundary (spec §"Channel ownership signal"). A `false` here
 * means the caller sends the packet raw — no per-call branching inside the
 * alias logic.
 */
export const shouldAliasForEgress = (gate: EgressGateInput): boolean =>
  gate.owns_llm_egress === true;

/* ──────────────── redaction_summary for audit ──────────────── */

/**
 * Build the audit `redaction_summary` from the pass's per-kind counters. The
 * ledger itself never reaches audit — only this count summary does (spec
 * §"Alias ledger"). Internal `'domain'` / `'email_local'` allocations are
 * excluded (handled by `summarizeRedactions`). `scope_kind` is always
 * `'session'` — the only durable v1 alias scope.
 */
export const buildRedactionSummary = (
  mode: RedactionMode,
  counters: RedactionCounters,
): RedactionSummary => ({
  mode,
  scope_kind: 'session',
  counts: summarizeRedactions(counters),
});

/* ──────────────── Egress alias pass ──────────────── */

export interface AliasPacketInput {
  /** The session's alias ledger (from a `SessionLedgerStore`). Reused across
   *  packets within the session so the same real value renders as the same
   *  alias every time. */
  ledger: Ledger;
  /** The LLM-bound context packet — any JSON-serializable structure. */
  packet: PiiAliasableData;
  /** Resolves which packet fields carry a privacy tag. P1 ships the no-op;
   *  D-165 wiring supplies the real resolver. */
  resolver: FieldPrivacyResolver;
  /** Redaction mode recorded in the audit summary. Comfort default `'alias'`. */
  mode?: RedactionMode;
}

export interface AliasPacketResult {
  /** The packet with tagged field values replaced by typed aliases — a deep
   *  copy; the input packet is never mutated (the orchestrator keeps the real
   *  packet for audit). */
  aliased: PiiAliasableData;
  /** The count summary the wiring stamps onto the turn's D-120 audit row. */
  summary: RedactionSummary;
}

/**
 * D-167 Slice 3 — collision-proof a model-bound packet against user-typed
 * `pii.*` literal tokens, BEFORE the alias pass. Reserve/escape each so it
 * round-trips through restore instead of colliding with an allocated alias (a
 * user-typed `pii.Person1` that happens to equal Pat Lee's alias would otherwise
 * restore to "Pat Lee", corrupting the literal and leaking her). Run EXACTLY
 * ONCE per packet at the egress seam (the orchestrator's `aliasChatAiInput`),
 * BEFORE `aliasPacketForEgress` + the data-field scans — never inside them (a
 * second pass would re-escape an escaped token). Returns the (possibly rewritten)
 * packet + whether any token was ESCAPED, so the caller keeps its byte-identity
 * fast path when nothing was rewritten.
 */
export const preScanPacketForEgress = <T>(
  ledger: Ledger,
  packet: T,
): { value: T; escaped: boolean } => preScanReservePii(ledger, packet);

/** Cheap conservative gate for deciding whether the whole-packet literal
 * collision pre-scan is necessary. */
export const hasPotentialPiiAliasLiteral =
  containsPotentialPiiAliasLiteral;

/**
 * Alias a context packet for LLM egress (spec §"Runtime flow" steps 2-4).
 * Resolves the packet's privacy-tagged fields, runs the substrate's two
 * ordered passes (identifier then content) against the session ledger, and
 * returns the aliased copy plus the `redaction_summary` for audit.
 *
 * The caller gates with `shouldAliasForEgress` first; this function assumes
 * aliasing is wanted. With the P1 no-op resolver the field list is empty, so
 * the returned packet equals a deep copy of the input and the summary counts
 * are all zero — inert until D-165 supplies tags.
 */
export const aliasPacketForEgress = (input: AliasPacketInput): AliasPacketResult => {
  const counters = createCounters();
  const fields = input.resolver(input.packet);
  const aliased = aliasFields(input.ledger, input.packet, fields, counters);
  const summary = buildRedactionSummary(input.mode ?? 'alias', counters);
  return { aliased, summary };
};

/* ──────────────── Local restore boundaries ──────────────── */

/**
 * Restore aliases in assistant reply text for user-facing display (spec
 * §"Runtime flow" step 6). The substrate scans case-sensitive first (the LLM
 * almost always echoes the canonical `pii.Person1` shape it received), then
 * case-insensitive as fallback. Unknown aliases pass through unchanged. The
 * end user sees real values; aliases never bleed into the chat surface.
 */
export const restoreForDisplay = (ledger: Ledger, text: string): string =>
  restoreInString(ledger, text);

/**
 * Restore aliases across an LLM-proposed outbound-write args object before the
 * D-157 preflight gate renders it (spec §"Runtime flow" step 7) — so the
 * approval-preview reads "email alice@acme.com", not "email m1@d1.invalid".
 * Walks nested objects / arrays; unknown aliases pass through unchanged
 * (comfort feature — the user remains the final gate, no rejection here).
 */
export const restoreArgsForApproval = <T>(ledger: Ledger, args: T): T =>
  restoreArgs(ledger, args);

/**
 * KEY-AWARE restore for the model's `tool_calls[].args` ONLY (D-167 N.10). The
 * uniform chat egress aliases a result map's KEYS, so the model can copy an aliased
 * key into a later tool-call args map; this un-aliases both keys and values so
 * dispatch receives the real key. NARROWLY scoped — the shared
 * `restoreArgsForApproval` stays value-only so it never rewrites a legitimate
 * alias-shaped key on the approval-preview / recipe surfaces.
 */
export const restoreArgsAndKeysForApproval = <T>(ledger: Ledger, args: T): T =>
  restoreArgsAndKeys(ledger, args);

/**
 * D-167 P3 — request-local reverse authority. Forward allocation remains
 * session-scoped; these restore functions admit only aliases found in the exact
 * protected request that produced the response.
 */
export type RequestRestoreAuthority = PiiRestoreAuthority;

export const deriveRequestRestoreAuthority = (
  ledger: Ledger,
  serializedProtectedPacket: string,
): RequestRestoreAuthority =>
  derivePiiRestoreAuthority(ledger, serializedProtectedPacket);

export const restoreForDisplayWithAuthority = (
  authority: RequestRestoreAuthority,
  text: string,
): string => restoreInStringWithAuthority(authority, text);

export const restoreArgsForApprovalWithAuthority = <T>(
  authority: RequestRestoreAuthority,
  args: T,
): T => restoreArgsWithAuthority(authority, args);

export const restoreArgsAndKeysForApprovalWithAuthority = <T>(
  authority: RequestRestoreAuthority,
  args: T,
): T => restoreArgsAndKeysWithAuthority(authority, args);

/** Restore only nested object keys after the enclosing result's values have
 * already been restored once. */
export const restoreArgKeysForApprovalWithAuthority = <T>(
  authority: RequestRestoreAuthority,
  args: T,
): T => restoreArgKeysWithAuthority(authority, args);

/** Stage provider-request allocations and commit them only after send success. */
export const stageLedgerForRequest = (ledger: Ledger): Ledger =>
  cloneLedger(ledger);

export const commitLedgerForRequest = (
  ledger: Ledger,
  staged: Ledger,
): void => {
  commitLedger(ledger, staged);
};

/** Drop new mappings whose aliases are absent from the final request bytes. */
export const restrictStagedLedgerForRequest = (
  baseline: Ledger,
  staged: Ledger,
  authority: RequestRestoreAuthority,
): void => {
  restrictStagedLedgerToRestoreAuthority(baseline, staged, authority);
};

/**
 * Re-alias an LLM-bound args object for egress — the forward mirror of
 * `restoreArgsForApproval`. Walk nested objects / arrays / strings and
 * content-scan every string leaf against the session ledger, replacing any
 * ledger-known real value with its alias.
 *
 * The chat egress seam calls this on `prior_tool_calls[].args`: the tool loop
 * restored the model's aliased args to real for dispatch, so on a reinvoke they
 * must be re-aliased before re-egress or a contact referenced by alias in an
 * earlier round leaks RAW. VALUE-based (not a dot-path field tag) so an arbitrary
 * arg key containing a literal dot can't defeat it. Returns the aliased copy +
 * the redaction summary for audit; the input is never mutated. `content_text_
 * replacements` is the only count an args scan produces (a content pass never
 * bumps the identifier kinds), so a non-empty `summary.counts` means the caller
 * should re-bind + re-serialize; an empty one means a byte-identical pass-through.
 */
export const aliasArgsForEgress = <T>(
  ledger: Ledger,
  args: T,
  mode: RedactionMode = 'alias',
): { aliased: T; summary: RedactionSummary } => {
  const counters = createCounters();
  const aliased = aliasArgs(ledger, args, counters);
  return { aliased, summary: buildRedactionSummary(mode, counters) };
};

/* ──────────────── Recall-path egress (D-167 recall↔PII) ──────────────── */

/**
 * D-167 (recall path) — the RAW contact strings the recall index is built from.
 * The backend supplies these from the contact warehouse (the per-pair list it
 * already holds locally, D-157), pre-filtered by its own commonness gate; the
 * gateway turns them into the Aho-Corasick name/org automaton + identifier seeds.
 * Keeping the wire shape RAW STRINGS means the backend never touches the
 * `@recued/transforms` index types directly — it stays on the `piiEgress`
 * consumer surface.
 */
export interface RecallContactSeeds {
  /** Contact display names. */
  readonly names: readonly string[];
  /** Contact org / company values. */
  readonly orgs: readonly string[];
  /** Contact canonical emails (full address). */
  readonly emails: readonly string[];
  /** Contact canonical phones (full E.164). */
  readonly phones: readonly string[];
  /** STREET LINES only (`mailing_address.address1` / `.address2`) — multi-token, distinctive
   *  strings the A-C matches safely, exactly like a name or an org.
   *
   *  NEVER a postcode: it is all digits, so it collides with invoice numbers and years — the
   *  content pass refuses to blind-match any all-digit value for precisely that reason (a
   *  postcode in prose is reached instead through `registerAddressComposite`'s city/state
   *  neighbour forms). NEVER a city / state / country either: they are single common tokens
   *  that would over-alias, AND the owner's ruling is that they stay VISIBLE so the model is
   *  location-aware. Optional so every existing caller stays byte-identical. */
  readonly addresses?: readonly string[];
}

/**
 * The built recall index — the name/org Aho-Corasick automaton plus the
 * email/phone identifier seeds, the EXACT-match-against-contacts surface the
 * recall egress aliases against. Opaque to the backend (it holds and forwards it,
 * never inspects it).
 */
export interface RecallIndex {
  readonly index: KnownValueIndex;
  readonly identifierSeeds: readonly KnownValueIdentifierSeed[];
}

const EMAIL_PRIVACY_KIND = 'email' as const;

/**
 * Build the recall index from raw contact strings. Pure — the backend builds it
 * once per turn (lazily, only when a `memory.*` result is present) and reuses it
 * across the tool loop's reinvokes.
 */
export const buildRecallIndex = (seeds: RecallContactSeeds): RecallIndex => {
  const nameOrgSeeds: KnownValueSeed[] = [
    ...seeds.names.map((value) => ({ value, kind: 'name' as const })),
    ...seeds.orgs.map((value) => ({ value, kind: 'org' as const })),
    // Street lines ride the SAME automaton as names/orgs — they are multi-token, distinctive
    // strings, which is exactly what the A-C is good at. (Postcodes and city/state names are
    // deliberately absent; see `RecallContactSeeds.addresses`.)
    ...(seeds.addresses ?? []).map((value) => ({ value, kind: 'address' as const })),
  ];
  const identifierSeeds: KnownValueIdentifierSeed[] = [
    ...seeds.emails.map((value) => ({ kind: EMAIL_PRIVACY_KIND, value })),
    ...seeds.phones.map((value) => ({ kind: 'phone' as const, value })),
  ];
  return { index: buildKnownValueIndex(nameOrgSeeds), identifierSeeds };
};

/**
 * D-167 (recall path) — re-alias a `memory.*` tool RESULT for egress against the
 * contact recall index + overlap-reveal the user-disclosed fragments. The recall
 * counterpart of `aliasArgsForEgress`: where that aliases only values ALREADY in
 * the session ledger, this SEEDS from the contact index first, so a contact
 * recalled from a prior session (never surfaced this session — the leak) is
 * aliased too, and a partial reference re-binds via `pii.Person1.sarah`.
 *
 * `disclosedTexts` are the raw USER-authored strings this turn (the current
 * `user_message` + user-role `chat_tail`) — tokenised HERE so the backend never
 * imports the transforms tokenizer. Returns the aliased copy + the redaction
 * summary; the input is never mutated.
 */
export const aliasRecallArgsForEgress = <T>(
  ledger: Ledger,
  args: T,
  recall: RecallIndex,
  disclosedTexts: readonly string[],
  mode: RedactionMode = 'alias',
): { aliased: T; summary: RedactionSummary } => {
  const disclosed = new Set<string>();
  for (const text of disclosedTexts) {
    for (const tok of tokenizeForOverlap(text)) disclosed.add(tok);
  }
  const counters = createCounters();
  const aliased = aliasRecallArgs(
    ledger,
    args,
    recall.index,
    recall.identifierSeeds,
    disclosed,
    counters,
  );
  return { aliased, summary: buildRedactionSummary(mode, counters) };
};

/**
 * D-224 — overlap-reveal ALONE, over an already-aliased value.
 *
 * `aliasRecallArgsForEgress` bundles seeding + aliasing + decoration, which is
 * right for a `memory.*` result. The PREFETCH path has already aliased its
 * records (`aliasPacketForEgress`) and must not re-alias them — it only needs
 * the disclosed-overlap tails. Splitting the decoration out is what lets the
 * two paths share one implementation instead of one growing a second copy.
 *
 * ⛔ WHY THE PREFETCH NEEDS IT AT ALL: overlap-reveal existed for name/org since
 * D-167 but was reachable ONLY from the recall path, so a contact surfaced by
 * the SPECULATIVE prefetch egressed as a bare `pii.Person1`. Observed live — a
 * model holding the owner's own "Northwind Traders" beside an opaque alias could
 * not join them and gave up, reporting that "the name and email were redacted".
 * The feature that exists to prevent exactly that was not on the path where it
 * happened.
 *
 * Pure; the ledger is read-only. `disclosedTexts` are tokenised HERE, as in the
 * recall path, so the backend never imports the transforms tokenizer.
 */
export const decorateOverlapForEgress = <T>(
  ledger: Ledger,
  value: T,
  disclosedTexts: readonly string[],
): T => {
  const disclosed = new Set<string>();
  for (const text of disclosedTexts) {
    for (const tok of tokenizeForOverlap(text)) disclosed.add(tok);
  }
  if (disclosed.size === 0) return value;
  const decorate = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return decorateOverlapReveal(ledger, node, disclosed);
    }
    if (Array.isArray(node)) return node.map(decorate);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      // ⚠ VALUES ONLY, never keys — mirrors `aliasRecallArgs`, whose comment is
      // the reason: keys carry no user-facing coreference, so decorating one
      // would add a hint nobody reads while changing a wire field name.
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = decorate(v);
      }
      return out;
    }
    return node;
  };
  return decorate(value) as T;
};

/** A schema-attested historical value admitted to the turn-local candidate
 * index. `content` is intentionally absent: free-form prose is deterministically
 * extracted, never retained wholesale as one aliasable value. */
export interface CandidateValueSeed {
  readonly value: string;
  readonly kind: Exclude<EntityFieldPrivacy, 'content'>;
}

const CANDIDATE_UNSAFE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const candidateStringSurfaces = (
  root: unknown,
): {
  readonly all: readonly string[];
  readonly keys: readonly string[];
} => {
  const all: string[] = [];
  const keys: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      all.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const member of value) stack.push(member);
      continue;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, member] of Object.entries(
        value as Record<string, unknown>,
      )) {
        // Match the key-aware `walk` contract: prototype-sensitive members are
        // removed, not inspected. A candidate occurring only there must not
        // allocate a reverse mapping that the protected result never carries.
        if (CANDIDATE_UNSAFE_KEYS.has(key)) continue;
        all.push(key);
        keys.push(key);
        stack.push(member);
      }
    }
  }
  return { all, keys };
};

const escapeCandidateRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const identifierCandidateOccurs = (
  surfaces: readonly string[],
  seed: CandidateValueSeed,
): boolean => {
  if (seed.value.length === 0) return false;
  if (seed.kind === 'phone') {
    const digits = seed.value.replace(/\D/gu, '');
    return digits.length > 0 && surfaces.some(
      (surface) => surface.replace(/\D/gu, '').includes(digits),
    );
  }
  if (seed.kind === 'url') {
    const needle = seed.value.toLowerCase();
    return surfaces.some((surface) => surface.toLowerCase().includes(needle));
  }
  if (seed.kind === EMAIL_PRIVACY_KIND) {
    const needle = seed.value.toLowerCase();
    return surfaces.some((surface) => surface.toLowerCase().includes(needle));
  }
  const boundary = new RegExp(
    `(?<![A-Za-z0-9])${escapeCandidateRegExp(seed.value)}(?![A-Za-z0-9])`,
    'iu',
  );
  return surfaces.some((surface) => boundary.test(surface));
};

const candidatesThatActuallyAlias = <T>(
  args: T,
  candidates: readonly CandidateValueSeed[],
): readonly CandidateValueSeed[] => {
  if (candidates.length === 0) return [];
  const scope = 'candidate-presence-probe';
  const baseline = createLedger(scope);
  const probe = createLedger(scope);
  const requiredReverseKeys = new Map<CandidateValueSeed, readonly string[]>();
  for (const candidate of candidates) {
    const alias = aliasIdentifierField(
      probe,
      candidate.kind as
        | KnownValueIdentifierSeed['kind']
        | 'external_id'
        | 'account_id',
      candidate.value,
    );
    requiredReverseKeys.set(
      candidate,
      [...derivePiiRestoreAuthority(probe, alias).ledger.byKindBaseAlias.keys()],
    );
  }

  // Probe all prefiltered candidates in one key-aware packet walk. Restricting
  // the isolated ledger to aliases that reached its output gives the exact same
  // presence proof as one probe per candidate without O(candidates × packet
  // traversal) cloning. Nothing from this scratch ledger reaches the session.
  const aliased = aliasArgs(probe, args);
  const exposed = candidateStringSurfaces(aliased).all.join('\u0000');
  const authority = derivePiiRestoreAuthority(probe, exposed);
  restrictStagedLedgerToRestoreAuthority(baseline, probe, authority);
  return candidates.filter((candidate) => {
    const keys = requiredReverseKeys.get(candidate) ?? [];
    return keys.length > 0
      && keys.every((key) => probe.byKindBaseAlias.has(key));
  });
};

/**
 * Alias a dynamic packet projection against one bounded candidate set.
 * Names/orgs/addresses use one Aho-Corasick index; identifier seeds are first
 * filtered to values actually present in this packet, and external/account ids
 * are allocated only after the same presence gate. Thus a superset-safe cache
 * never widens the session reverse map merely by being read.
 */
export const aliasCandidateValuesForEgress = <T>(
  ledger: Ledger,
  args: T,
  candidates: readonly CandidateValueSeed[],
  disclosedTexts: readonly string[],
  mode: RedactionMode = 'alias',
): { aliased: T; summary: RedactionSummary } => {
  const knownValues: KnownValueSeed[] = [];
  const identifierCandidates: CandidateValueSeed[] = [];
  const directCandidates: CandidateValueSeed[] = [];
  for (const candidate of candidates) {
    if (candidate.value.length === 0) continue;
    if (
      candidate.kind === 'name'
      || candidate.kind === 'org'
      || candidate.kind === 'address'
    ) {
      knownValues.push({ value: candidate.value, kind: candidate.kind });
    } else if (
      candidate.kind === EMAIL_PRIVACY_KIND
      || candidate.kind === 'phone'
      || candidate.kind === 'url'
    ) {
      identifierCandidates.push(candidate);
    } else {
      directCandidates.push(candidate);
    }
  }

  const surfaces = candidateStringSurfaces(args);
  // `aliasRecallArgs` discovers known values from string VALUES, then aliases
  // object keys ledger-anchored. A candidate present only in a nested key needs
  // an explicit seed first; otherwise `owner_Alice Ada` stays raw because no
  // value walk ever populated the ledger. Use the key-aware alphanumeric
  // boundary, then let the ordinary key mapper perform the replacement.
  for (const candidate of candidates) {
    if (
      (
        candidate.kind === 'name'
        || candidate.kind === 'org'
        || candidate.kind === 'address'
      )
      && identifierCandidateOccurs(surfaces.keys, candidate)
    ) {
      aliasIdentifierField(
        ledger,
        candidate.kind,
        candidate.value,
      );
    }
  }
  const presentIdentifiers = candidatesThatActuallyAlias(
    args,
    identifierCandidates.filter(
      (candidate) => identifierCandidateOccurs(surfaces.all, candidate),
    ),
  );
  const presentDirect = candidatesThatActuallyAlias(
    args,
    directCandidates.filter(
      (candidate) => identifierCandidateOccurs(surfaces.all, candidate),
    ),
  );
  const identifierSeeds: KnownValueIdentifierSeed[] = presentIdentifiers
    .map((candidate) => ({
      value: candidate.value,
      kind: candidate.kind as KnownValueIdentifierSeed['kind'],
    }));
  for (const candidate of presentDirect) {
    aliasIdentifierField(
      ledger,
      candidate.kind as 'external_id' | 'account_id',
      candidate.value,
    );
  }

  const disclosed = new Set<string>();
  for (const text of disclosedTexts) {
    for (const token of tokenizeForOverlap(text)) disclosed.add(token);
  }
  const counters = createCounters();
  const aliased = aliasRecallArgs(
    ledger,
    args,
    buildKnownValueIndex(knownValues),
    identifierSeeds,
    disclosed,
    counters,
  );
  return { aliased, summary: buildRedactionSummary(mode, counters) };
};
