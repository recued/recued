/** Pair-scoped instance preferences — the ext authors, the server
 *  mirrors. Lives in the `prefs` sync-namespace (pair transport only).
 *
 *  Each entry here is a per-pair behavior knob. The extension is the
 *  authority: on connect and on toggle it pushes its view via the
 *  pair rpc `prefs.set`; the server persists the value on that peer's
 *  paired-instance row and uses it to gate per-peer cache traffic
 *  (see `backend/server/src/cache-rpc-handler.ts` + ws peer pushes).
 *
 *  Adding a preference:
 *    1. Add an entry to `INSTANCE_PREFS` below (key, type, default,
 *       description).
 *    2. Add the key to the `InstancePrefs` interface so TypeScript
 *       enforces exhaustiveness.
 *    3. Teach the consumer (cache gate, scheduler, whatever) to read
 *       the pref via `getPref(prefs, key)`.
 *    4. No migrations needed — defaults apply automatically for
 *       existing rows via `applyPrefsPatch`.
 *
 *  Keys use dotted paths for namespacing (`cache.sync_l2`). Treat the
 *  path as opaque — the storage layer stores the whole flat map as a
 *  single JSON blob; the dots are for human readability, not
 *  hierarchy. */

import {
  TRANSPARENCY_REDACTION_TIERS,
} from './transparency-stream/redaction.js';

export type InstancePrefSpec =
  | {
      type: 'boolean';
      default: boolean;
      description: string;
    }
  | {
      /** Closed-enum string pref — the first non-boolean kind
       *  (anticipated by the original boolean-only spec comment). The
       *  patch merge checks `typeof` AND `allowed` membership at the
       *  boundary, so a malformed wire/storage value falls back to the
       *  default rather than leaking an out-of-enum string into
       *  consumers. */
      type: 'string';
      default: string;
      allowed: readonly string[];
      description: string;
    };

/** Typed registry — every pair-scoped preference the ext and server
 *  agree on. Source of truth for defaults, value shapes, and doc
 *  strings. */
export const INSTANCE_PREFS = {
  'cache.sync_l2': {
    type: 'boolean',
    default: true,
    description:
      'Broadcast and accept L2 step-cache entries (category=step) ' +
      'across this ext↔server pair. Turn off when on metered/roaming ' +
      'data to cut cache-sync traffic without disabling the pair ' +
      'itself (rpc, schedules, other cache categories still work).',
  },
  // Phase G (D-109) — per-class Chrome notification opt-ins. The
  // notification dispatcher reads these on every transition and
  // decides whether to fire a desktop toast. Pair-scoped so a user
  // who silences crash notifications on their laptop still gets them
  // on a desk machine.
  'ui.notifications.pressure': {
    type: 'boolean',
    default: true,
    description:
      'Fire a Chrome notification when the paired server enters ' +
      'pressure_managed or writes_blocked on any surface.',
  },
  'ui.notifications.crash': {
    type: 'boolean',
    default: true,
    description:
      'Fire a Chrome notification when the paired server transitions ' +
      'into crashed lifecycle state or engages the crash-loop ' +
      'kill switch.',
  },
  'ui.notifications.restart': {
    type: 'boolean',
    default: false,
    description:
      'Fire a Chrome notification when the paired server restarts ' +
      '(supervisor respawn). Default off — benign events.',
  },
  'ui.notifications.collection_error': {
    type: 'boolean',
    default: true,
    description:
      'Fire a Chrome notification when any paired-server collection ' +
      '(mail/file/webhook) transitions into error state.',
  },
  // D-120 Phase 7 — compliance toggle. When true, every "Memory"
  // user-facing label flips back to "Audit log" / "Audit". Default
  // false because the new framing matches the AI-substrate framing
  // most users will encounter; the toggle exists for users who prefer
  // the compliance-flavored vocabulary (legal / ops / SOC2 audit-trail
  // contexts). Storage layer + rpc names stay `audit_*` either way.
  'ui.memory.show_as_audit_log': {
    type: 'boolean',
    default: false,
    description:
      'Render every Memory label back as "Audit log". Underlying ' +
      'storage and rpc names are unchanged; this is purely a label ' +
      'flip for users who prefer the compliance-flavored framing.',
  },
  // D-190 — the per-tool per-source fan-out toggles (`chat.scope_sources.*`) were
  // DROPPED. With generic CRM-source enumeration, `deal.search` / `contact.search`
  // fan out over the user's BOUND CRM connections; a bound connection is already
  // the opt-in, so a per-vendor enable toggle is redundant (disable at the
  // Connections level instead). Pre-launch — deleted outright (no migration).
  // D-145 § B.8.9 — transparency-stream visibility controls. Defaults
  // MUST mirror `DEFAULT_TRANSPARENCY_STREAM_SETTINGS` (transparency-
  // stream/settings.ts) — `transparencyStreamSettingsFromPrefs` is the
  // bridge and a contracts test pins the correspondence. The `failure`
  // class is deliberately NOT a pref: § B.8.2's user-must-see invariant
  // makes truthful failure messaging a substrate guarantee, not a user
  // preference (`applyVisibilityPolicy` bypasses Settings for it).
  'ui.transparency.enabled': {
    type: 'boolean',
    default: true,
    description:
      'Master toggle for the inline thought stream — the per-turn ' +
      'activity narrative in chat (§ B.8.9 "Show inline thought ' +
      'stream"). Off suppresses every narrative line; tool-dispatch ' +
      'provenance rows and failure notices still render.',
  },
  'ui.transparency.class.ai_emitted': {
    type: 'boolean',
    default: true,
    description:
      'Show AI-emitted narrative lines (extractions, alias ' +
      'resolutions, pattern observations, drift signals).',
  },
  'ui.transparency.class.engine_brokering': {
    type: 'boolean',
    default: true,
    description:
      'Show engine-brokering narrative lines (capacity checks, memory ' +
      'lookups, "thinking..." cues, bridge dispatches, approval ' +
      'requests).',
  },
  'ui.transparency.class.orchestration': {
    type: 'boolean',
    default: false,
    description:
      'Show internal orchestration lines (multi-turn round cues, ' +
      'per-turn token usage, fixed-slot drift). Default off — engine ' +
      'cooperation noise per § B.6.1; opt in for visibility into the ' +
      'tool loop.',
  },
  'ui.transparency.max_redaction_tier': {
    type: 'string',
    default: 'summary_only',
    allowed: TRANSPARENCY_REDACTION_TIERS,
    description:
      'Highest redaction tier rendered to the chat surface: "none" = ' +
      'essential lines only, "summary_only" = the § B.8.7 default, ' +
      '"hidden" = everything including silent-by-default engine cues ' +
      '(debug mode). Higher tiers still reach the audit log regardless.',
  },
} as const satisfies Record<string, InstancePrefSpec>;

export type InstancePrefKey = keyof typeof INSTANCE_PREFS;

/** Per-key value type derived from the registry literal: boolean prefs
 *  stay `boolean`; string prefs narrow to their `allowed` union (e.g.
 *  `ui.transparency.max_redaction_tier` →
 *  `TransparencyRedactionTier`). The outer `K extends InstancePrefKey`
 *  distributes over union keys (codex review fold) so
 *  `InstancePrefValue<InstancePrefKey>` is the union of every per-key
 *  value type rather than collapsing to `boolean`. */
export type InstancePrefValue<K extends InstancePrefKey> = K extends InstancePrefKey
  ? (typeof INSTANCE_PREFS)[K] extends { readonly type: 'string' }
    ? (typeof INSTANCE_PREFS)[K] extends {
        readonly allowed: readonly (infer A extends string)[];
      }
      ? A
      : string
    : boolean
  : never;

/** Full concrete preference set. Every key is required; use
 *  `applyPrefsPatch` to merge a partial with defaults. */
export type InstancePrefs = {
  [K in InstancePrefKey]: InstancePrefValue<K>;
};

/** Defaults derived from the registry. Kept as a frozen object so
 *  accidental mutation of a shared reference can't silently drift. */
export const DEFAULT_INSTANCE_PREFS: Readonly<InstancePrefs> = Object.freeze(
  (Object.keys(INSTANCE_PREFS) as InstancePrefKey[]).reduce((acc, k) => {
    (acc as Record<string, unknown>)[k] = INSTANCE_PREFS[k].default;
    return acc;
  }, {} as InstancePrefs),
) as InstancePrefs;

const hasOwnPref = (
  prefs: Readonly<Record<string, unknown>>,
  key: InstancePrefKey,
): boolean => Object.prototype.hasOwnProperty.call(prefs, key);

/** Runtime validity gate shared by the patch/read paths: the value
 *  must match the spec's `typeof` AND, for closed-enum string prefs,
 *  sit inside the `allowed` list — an out-of-enum string from wire /
 *  storage falls back to the default rather than reaching consumers. */
const isValidPrefValue = (spec: InstancePrefSpec, value: unknown): boolean => {
  if (typeof value !== spec.type) return false;
  if (spec.type === 'string') {
    return (spec.allowed as readonly string[]).includes(value as string);
  }
  return true;
};

/** Narrow a runtime patch (from wire / storage) to known keys +
 *  correct types. Unknown keys are dropped (forward-compatibility:
 *  an older server that hasn't shipped a new pref yet should ignore
 *  values it doesn't understand, not crash). Wrong-typed values are
 *  dropped for the same reason. */
export const applyPrefsPatch = (
  current: Partial<InstancePrefs>,
  patch: Readonly<Record<string, unknown>>,
): InstancePrefs => {
  const merged: Partial<InstancePrefs> = { ...current };
  for (const k of Object.keys(INSTANCE_PREFS) as InstancePrefKey[]) {
    // Re-validate `current` too (codex review fold): a stored value
    // that predates an allowed-list change (or a corrupted blob) must
    // fall back to the default on the final spread, not override it.
    // Unknown keys in `current` pass through untouched — they can't be
    // validated and the wholesale spread preserves them across version
    // up/downgrades (existing behavior).
    if (
      hasOwnPref(current as Readonly<Record<string, unknown>>, k) &&
      !isValidPrefValue(INSTANCE_PREFS[k], current[k])
    ) {
      delete merged[k];
    }
    if (!hasOwnPref(patch, k)) continue;
    const incoming = patch[k];
    if (!isValidPrefValue(INSTANCE_PREFS[k], incoming)) continue;
    (merged as Record<string, unknown>)[k] = incoming;
  }
  return { ...DEFAULT_INSTANCE_PREFS, ...merged };
};

/** Look up one pref's effective value, falling back to the registered
 *  default when the key is missing from `prefs` or carries an invalid
 *  value (wrong type, or out-of-enum for string prefs). */
export const getPref = <K extends InstancePrefKey>(
  prefs: Partial<InstancePrefs> | undefined,
  key: K,
): InstancePrefValue<K> => {
  const spec = INSTANCE_PREFS[key];
  const v = prefs && hasOwnPref(prefs as Readonly<Record<string, unknown>>, key)
    ? prefs[key]
    : undefined;
  if (isValidPrefValue(spec, v)) return v as InstancePrefValue<K>;
  return spec.default as InstancePrefValue<K>;
};

/** Narrow a raw patch (from wire / storage) to known-and-well-typed
 *  keys WITHOUT filling defaults. Use this when persisting — caller
 *  only wants to write what the caller sent, not clobber other keys.
 *  Contrast with `applyPrefsPatch`, which returns a complete set with
 *  defaults applied (right for *reading* the effective state).
 *
 *  Invariants mirror applyPrefsPatch:
 *    - Unknown keys dropped (forward-compat).
 *    - Wrong-typed values dropped (never crash).
 *    - Known keys passed through verbatim. */
export const sanitizePrefsPatch = (
  patch: Readonly<Record<string, unknown>>,
): Partial<InstancePrefs> => {
  const out: Partial<InstancePrefs> = {};
  for (const k of Object.keys(INSTANCE_PREFS) as InstancePrefKey[]) {
    if (!hasOwnPref(patch, k)) continue;
    const incoming = patch[k];
    if (!isValidPrefValue(INSTANCE_PREFS[k], incoming)) continue;
    (out as Record<string, unknown>)[k] = incoming;
  }
  return out;
};
