import { type LLMRequirements, type ModelHint } from '@recued/contracts';
import type {
  AvailabilitySnapshot,
  CoordinationStrategy,
  FreePoolApiEntry,
  FreePoolEntry,
  LLMConfig,
  LLMSlot,
  Match,
  Modalities,
} from './types.js';
import { hasModalityDemand, LLMError, normalizeLLMSlot, supportsModalities } from './types.js';
import { imageInputSeen } from './endpoint-capabilities.js';
import type { QuotaTracker } from './quota.js';

/** Numeric rank for speed-tier comparison. Higher = more capable.
 *  Used for downgrade/upgrade ladders (thinking > quality > fast). */
const SPEED_RANK: Record<ModelHint, number> = { fast: 0, quality: 1, thinking: 2 };

/** Relaxation ladder when `allow_downgrade` is true. Starts at the
 *  requirement, widens downward. */
const DOWNGRADE_ORDER: Record<ModelHint, ModelHint[]> = {
  thinking: ['thinking', 'quality', 'fast'],
  quality: ['quality', 'fast'],
  fast: ['fast'],
};

/** Expansion ladder when `allow_llm_upgrade` is true. Starts at the
 *  requirement, widens upward. */
const UPGRADE_ORDER: Record<ModelHint, ModelHint[]> = {
  fast: ['fast', 'quality', 'thinking'],
  quality: ['quality', 'thinking'],
  thinking: ['thinking'],
};

/** Recipe-level policy override. Restricts which layer can serve the call,
 *  useful for compliance recipes that must pin BYOK. `'any'` (default)
 *  means "use everything configured." */
export type ForceLayer = 'free' | 'byok' | 'any';

/** D-191 Phase 6 — a BYOK slot key. A `pinSlot` constraint restricts the
 *  match to EXACTLY this slot (and excludes the free pool), so a manually-
 *  picked slot is fail-closed: if it is rejected/unavailable the match returns
 *  no candidate rather than cascading to the other slot or the pool (INV3 —
 *  closes the same-speed local+remote leak). */
export type PinnedSlot = 'slot_1' | 'slot_2';

export interface MatchRequest {
  requires: LLMRequirements;
  /** True when the recipe variable `allow_llm_upgrade` or the user-level
   *  `allow_upgrade_default` permits climbing past the requirement tier
   *  (typically routing to BYOK for more capability). */
  allowUpgrade: boolean;
  /** Recipe/step-level layer restriction. `'any'` allows everything. */
  forceLayer?: ForceLayer;
  /** D-191 Phase 6 — exact-slot pin. When set, ONLY this slot is eligible
   *  (the free pool + the other slot are excluded across every relaxation
   *  pass). Set by a manual chat pick of a configured slot so a same-speed
   *  local+remote pair can't leak on a retryable-error re-match. Absent →
   *  normal free-before-BYOK routing. */
  pinSlot?: PinnedSlot;
  /** D-172 P5 / N.8 — modality demand derived from the turn's content parts.
   *  When set, only sources whose declared `modalities` cover the demand
   *  match. No capable
   *  source → the executor surfaces `AI_MODALITY_UNSUPPORTED` (warn, never
   *  silently drop / auto-reroute — Q4). */
  requireModalities?: Modalities;
}

export interface MatchDeps {
  config: LLMConfig;
  availability: AvailabilitySnapshot;
  quota: QuotaTracker;
  strategy: CoordinationStrategy;
  /** Entries to exclude (cascade re-match after a retryable error). */
  rejectSet?: Set<string>;
  /** Random-number generator used by the `weighted` strategy. Returns a
   *  value in `[0, 1)`. Default: `Math.random`. Injectable so tests can
   *  drive the weighted path deterministically. */
  rng?: () => number;
}

/** Diagnostic payload attached to AI_LLM_UNAVAILABLE errors. */
export interface MatchFailureDetails {
  rejected: string[];
  snapshot: AvailabilitySnapshot;
  requires: LLMRequirements;
  forceLayer?: ForceLayer;
  /** D-191 Phase 6 — present when the failed match was pinned to a slot, so
   *  the caller can distinguish "pinned slot unavailable" from a plain no-match. */
  pinSlot?: PinnedSlot;
  /** D-172 P5 — present when the failed match demanded a modality, so the
   *  caller can distinguish "no capable model" from a plain no-match. */
  requireModalities?: Modalities;
}

interface CapabilityFilter {
  speed: ModelHint;
  require_json: boolean;
  require_search: boolean;
  /** D-172 P5 — modality demand; undefined means text-only (no demand). */
  require_modalities?: Modalities;
}

/** What a candidate can take in: its declared `modalities`, plus picture input
 *  once Test connection has shown it a picture it read back
 *  (`endpoint-capabilities` § Picture input) — held in memory, and stored on
 *  the source as `image_input_ok`. Both are read: the memory is filled at boot
 *  from what is stored, and a boot that could not read the store (locked)
 *  leaves it empty while the per-use config read still finds the stored proof.
 *  ⚠ The proof only ever ADDS: a declaration typed into the config is the
 *  owner's to keep. */
const modalitiesOf = (
  source: Pick<LLMSlot, 'provider' | 'base_url' | 'model' | 'modalities' | 'image_input_ok'>,
): Modalities | undefined =>
  source.modalities?.image !== true
    && (source.image_input_ok === true || imageInputSeen(source))
    ? { ...source.modalities, image: true }
    : source.modalities;

/** D-172 P5 — true iff the filter has a modality demand the candidate's
 *  modalities cannot cover. No demand → always passes. */
const failsModalities = (caps: Modalities | undefined, f: CapabilityFilter): boolean =>
  f.require_modalities !== undefined
  && hasModalityDemand(f.require_modalities)
  && !supportsModalities(caps, f.require_modalities);

const apiEntryMatches = (e: FreePoolApiEntry, f: CapabilityFilter): boolean => {
  if (e.speed !== f.speed) return false;
  if (f.require_json && !e.supports_json) return false;
  if (f.require_search && !e.supports_search) return false;
  if (failsModalities(modalitiesOf(e), f)) return false;
  return true;
};

const slotMatches = (s: LLMSlot, f: CapabilityFilter): boolean => {
  if (s.speed !== f.speed) return false;
  if (f.require_json && !s.supports_json) return false;
  if (f.require_search && !s.supports_search) return false;
  if (failsModalities(modalitiesOf(s), f)) return false;
  return true;
};

const synthesizeSlotForPoolEntry = (e: FreePoolApiEntry): LLMSlot => ({
  provider: e.provider,
  model: e.model,
  api_key: e.api_key,
  base_url: e.base_url,
  speed: e.speed,
  supports_json: e.supports_json,
  supports_search: e.supports_search,
  ...(e.context_window_tokens !== undefined
    ? { context_window_tokens: e.context_window_tokens }
    : {}),
  // D-172 P5 — carry modality + transcription declarations onto the
  // synthesized slot so the resolved Match retains the capability the
  // executor checks (multimodal) / the transcribe path consumes (A.9).
  ...(e.modalities !== undefined ? { modalities: e.modalities } : {}),
});

/** Candidate = one eligible source the match could route to. Partitioned
 *  later into free vs byok groups so "free-first" ranking is trivial. */
interface Candidate {
  kind: 'pool' | 'slot';
  /** Stable id for rejectSet membership + round-robin cursor keys. */
  id: string;
  /** True for free-tier sources. Drives the free-before-BYOK partition. */
  free: boolean;
  /** Weighted-strategy weight (defaults 1 for slots + weightless pool entries). */
  weight: number;
  /** Build a Match object for this candidate. Invoked once after ranking. */
  toMatch(resolvedHint: ModelHint, usedDowngrade: boolean, usedUpgrade: boolean): Match;
}

/** Collect every eligible source that satisfies the given capability filter
 *  + rejectSet + layer restriction. Ordered as pool api / slot_1 / slot_2
 *  but the caller re-sorts by free-vs-BYOK before picking. */
const collectCandidates = (
  filter: CapabilityFilter,
  forceLayer: ForceLayer,
  pinSlot: PinnedSlot | undefined,
  deps: MatchDeps,
): Candidate[] => {
  const { config, availability, rejectSet } = deps;
  const rejected = rejectSet ?? new Set<string>();
  const pool = config.free_pool ?? [];
  // O(1) availability lookup by pool-entry id.
  const poolStatusById = new Map(availability.free_pool.map((p) => [p.id, p]));
  const slot_1 = normalizeLLMSlot(config.slot_1, 'slot_1');
  const slot_2 = normalizeLLMSlot(config.slot_2, 'slot_2');
  // D-191 Phase 6 — a pinned slot excludes the free pool entirely; only the
  // pinned BYOK slot can serve (fail-closed, INV3).
  const allowPool =
    pinSlot === undefined && (forceLayer === 'any' || forceLayer === 'free');
  const allowByok = forceLayer === 'any' || forceLayer === 'byok';
  const out: Candidate[] = [];

  if (allowPool) {
    for (const e of pool) {
      if (e.type !== 'api') continue;
      if (rejected.has(e.id)) continue;
      if (!poolStatusById.get(e.id)?.status.available) continue;
      if (!apiEntryMatches(e, filter)) continue;
      out.push({
        kind: 'pool', id: e.id, free: true, weight: e.weight ?? 1,
        toMatch: (resolved_hint, used_downgrade, used_upgrade) => ({
          source: { kind: 'pool', entry: e },
          slot: synthesizeSlotForPoolEntry(e),
          adapterKey: e.provider,
          resolved_hint, used_downgrade, used_upgrade,
        }),
      });
    }
  }

  if (allowByok) {
    for (const [slotKey, slot] of [['slot_1', slot_1], ['slot_2', slot_2]] as const) {
      if (!slot) continue;
      // D-191 Phase 6 — a pinned slot restricts the match to exactly itself.
      if (pinSlot !== undefined && slotKey !== pinSlot) continue;
      if (rejected.has(slotKey)) continue;
      const baseStatus = availability[slotKey];
      if (!baseStatus.available) continue;
      // Budget cutoff deranks rather than excludes — a slot over its
      // scheduled-cutoff is last-resort. Practically, because free
      // candidates always sort ahead of BYOK, an over-budget slot fires
      // only when nothing else matches.
      if (availability.slot_budget[slotKey].over_cutoff) continue;
      if (!slotMatches(slot, filter)) continue;
      out.push({
        kind: 'slot', id: slotKey, free: false, weight: 1,
        toMatch: (resolved_hint, used_downgrade, used_upgrade) => ({
          source: { kind: 'slot', slot_key: slotKey },
          slot,
          adapterKey: slot.provider,
          resolved_hint, used_downgrade, used_upgrade,
        }),
      });
    }
  }

  return out;
};

/** Apply the coordination strategy within a pre-filtered group of equals.
 *  Single candidate is a fast-path (no rng call, no cursor read). */
const pickFromGroup = (
  group: Candidate[],
  strategy: CoordinationStrategy,
  sourceKey: string,
  quota: QuotaTracker,
  rng: () => number,
): Candidate => {
  if (group.length === 1) return group[0]!;
  if (strategy === 'round_robin') {
    const cursor = quota.currentCursor(sourceKey);
    return group[cursor % group.length]!;
  }
  // weighted
  const total = group.reduce((a, c) => a + c.weight, 0);
  let roll = rng() * total;
  for (const c of group) {
    roll -= c.weight;
    if (roll <= 0) return c;
  }
  return group[group.length - 1]!;
};

/** Pick the best candidate: free group first, BYOK group second. Coordination
 *  strategy applies within the winning group. Returns null when both are
 *  empty (caller moves to the next relaxation step). */
const pickCandidate = (
  all: Candidate[],
  speed: ModelHint,
  strategy: CoordinationStrategy,
  quota: QuotaTracker,
  rng: () => number,
): { candidate: Candidate; sourceKey: string } | null => {
  if (all.length === 0) return null;
  // Single-pass partition — avoids iterating `all` twice.
  const free: Candidate[] = [];
  const byok: Candidate[] = [];
  for (const c of all) (c.free ? free : byok).push(c);
  if (free.length > 0) {
    const sourceKey = `free:${speed}`;
    return { candidate: pickFromGroup(free, strategy, sourceKey, quota, rng), sourceKey };
  }
  const sourceKey = `byok:${speed}`;
  return { candidate: pickFromGroup(byok, strategy, sourceKey, quota, rng), sourceKey };
};

/** Resolve a match by auto-ranking every eligible candidate under the
 *  demand (`requires`) and user supply (everything in `config`).
 *
 *  Algorithm:
 *    1. Strict tier match (exact speed). Free candidates beat BYOK; within
 *       the winning group, coordination strategy picks the entry.
 *    2. If `allow_downgrade`, relax tier one step at a time toward `fast`.
 *    3. If `allowUpgrade`, climb tier one step at a time toward `thinking`.
 *    4. Exhausted → throw AI_LLM_UNAVAILABLE with a snapshot + details.
 *
 *  `forceLayer` (recipe/step override) restricts which layer can serve. */
/** Every slot that COULD serve a request at this layer, as real `LLMSlot`s.
 *
 *  ⛔⛔ THIS LIVES HERE, BESIDE `collectCandidates`, FOR ONE REASON: it must
 *  produce slots through the SAME `normalizeLLMSlot` /
 *  `synthesizeSlotForPoolEntry` the matcher uses. A caller that rebuilt the
 *  slot shape itself would compute a DIFFERENT `endpointFingerprint` for the
 *  same endpoint, and every learned-capability lookup against it would miss
 *  silently — a lookup that finds nothing is indistinguishable from an endpoint
 *  that has learned nothing.
 *
 *  ⚠ DELIBERATELY WIDER THAN `collectCandidates`: no availability, capability
 *  or reject-set filtering. Those are per-instant and this answers a question
 *  about the SET ("what might serve this turn"), where a transiently-excluded
 *  source must still count — it can come back before the call. For the one
 *  consumer today (context budgeting, which takes a MINIMUM) a superset is the
 *  conservative direction; a narrower set would be the unsafe one. */
export const candidateSlotsForLayer = (
  config: LLMConfig,
  forceLayer: ForceLayer,
  pinSlot?: PinnedSlot,
): LLMSlot[] => {
  const allowPool =
    pinSlot === undefined && (forceLayer === 'any' || forceLayer === 'free');
  const allowByok = forceLayer === 'any' || forceLayer === 'byok';
  const out: LLMSlot[] = [];
  if (allowByok) {
    for (const slotKey of ['slot_1', 'slot_2'] as const) {
      if (pinSlot !== undefined && pinSlot !== slotKey) continue;
      const slot = normalizeLLMSlot(config[slotKey], slotKey);
      if (slot) out.push(slot);
    }
  }
  if (allowPool) {
    for (const e of config.free_pool ?? []) {
      if (e.type !== 'api') continue;
      out.push(synthesizeSlotForPoolEntry(e));
    }
  }
  return out;
};

export const matchLLM = (request: MatchRequest, deps: MatchDeps): Match => {
  const { requires } = request;
  const forceLayer: ForceLayer = request.forceLayer ?? 'any';
  const pinSlot = request.pinSlot;
  const base: CapabilityFilter = {
    speed: requires.speed,
    require_json: requires.output_format === 'json',
    require_search: requires.needs_search === true,
    // D-172 P5 — a modality demand survives every speed-tier relaxation
    // pass below (the filter is spread into each relaxed/climbed filter),
    // so a downgrade/upgrade can never route media to a text-only model.
    ...(request.requireModalities !== undefined && hasModalityDemand(request.requireModalities)
      ? { require_modalities: request.requireModalities }
      : {}),
  };
  const rng = deps.rng ?? Math.random;

  // Pass 1 — strict speed tier.
  {
    const candidates = collectCandidates(base, forceLayer, pinSlot, deps);
    const picked = pickCandidate(candidates, base.speed, deps.strategy, deps.quota, rng);
    if (picked) return picked.candidate.toMatch(base.speed, false, false);
  }

  // Pass 2 — ingredient-author downgrade (walk down the tier ladder).
  if (requires.allow_downgrade) {
    for (const relaxed of DOWNGRADE_ORDER[requires.speed].slice(1)) {
      const filter = { ...base, speed: relaxed };
      const candidates = collectCandidates(filter, forceLayer, pinSlot, deps);
      const picked = pickCandidate(candidates, relaxed, deps.strategy, deps.quota, rng);
      if (picked) return picked.candidate.toMatch(relaxed, true, false);
    }
  }

  // Pass 3 — user-cost upgrade (walk up the tier ladder). Skip the exact
  // tier because Pass 1 already tried it; start one step higher.
  if (request.allowUpgrade) {
    for (const climbed of UPGRADE_ORDER[requires.speed].slice(1)) {
      const filter = { ...base, speed: climbed };
      const candidates = collectCandidates(filter, forceLayer, pinSlot, deps);
      const picked = pickCandidate(candidates, climbed, deps.strategy, deps.quota, rng);
      if (picked) return picked.candidate.toMatch(climbed, false, true);
    }
    // Combined: upgrade allowed AND downgrade allowed. Try each upgraded
    // tier with downgrade ladder beyond it — rare but complete.
    if (requires.allow_downgrade) {
      for (const climbed of UPGRADE_ORDER[requires.speed].slice(1)) {
        for (const relaxed of DOWNGRADE_ORDER[climbed].slice(1)) {
          const filter = { ...base, speed: relaxed };
          const candidates = collectCandidates(filter, forceLayer, pinSlot, deps);
          const picked = pickCandidate(candidates, relaxed, deps.strategy, deps.quota, rng);
          if (picked) return picked.candidate.toMatch(relaxed, true, true);
        }
      }
    }
  }

  const modalityList = base.require_modalities
    ? (Object.keys(base.require_modalities) as Array<keyof Modalities>)
        .filter((k) => base.require_modalities?.[k] === true)
    : [];
  const details: MatchFailureDetails = {
    rejected: Array.from(deps.rejectSet ?? []),
    snapshot: deps.availability,
    requires,
    forceLayer,
    ...(pinSlot !== undefined ? { pinSlot } : {}),
    ...(modalityList.length > 0 ? { requireModalities: base.require_modalities } : {}),
  };
  throw new LLMError(
    'AI_LLM_UNAVAILABLE',
    `No LLM source matches requirements (speed: ${requires.speed}`
    + `${requires.output_format === 'json' ? ', json' : ''}`
    + `${requires.needs_search ? ', search' : ''}`
    + `${modalityList.length > 0 ? `, modalities: ${modalityList.join('+')}` : ''}`
    + `${forceLayer !== 'any' ? `, forceLayer: ${forceLayer}` : ''}`
    + `${pinSlot !== undefined ? `, pinSlot: ${pinSlot}` : ''})`,
    details as unknown as Record<string, unknown>,
  );
};

export { SPEED_RANK };
