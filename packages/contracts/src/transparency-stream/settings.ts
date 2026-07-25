/** D-145 PB7 — Transparency Stream Settings controls (§ B.8.9).
 *
 *  User-facing toggles for the transparency stream. Settings shape +
 *  resolver helpers live in contracts so the engine composer +
 *  webclient renderer + audit emitter all read the same data shape.
 *
 *  Layered controls per § B.8.9:
 *
 *    - Master toggle — "Show inline thought stream" (default on).
 *    - Per-stream-kind opt-out — extractions / alias resolutions /
 *      pattern observations / drift signals / reactive fires /
 *      capacity checks / memory lookups / context omissions.
 *    - Per-`network_domain` filter — show family-domain extractions or
 *      hide them (privacy preference). Applies only to events
 *      carrying `network_domain` in their payload (currently
 *      `resolution.alias`).
 *    - Per-redaction-tier visibility — render `none` only / `none +
 *      summary_only` / all-including-hidden (debug mode).
 *
 *  Composer reads the resolved settings via `applyVisibilityPolicy`
 *  before emitting envelopes; chat-log render also re-applies before
 *  paint to handle live-toggle of settings during a session.
 *
 *  Spec: § B.8.9 + § B.8.7. */

import type { TransparencyEvent, TransparencyEventClass } from './events.js';
import {
  TRANSPARENCY_EVENT_CLASS_FOR_KIND,
  TRANSPARENCY_EVENT_CLASSES,
} from './events.js';
import {
  TRANSPARENCY_REDACTION_TIER_PRIORITY,
  type TransparencyRedactionTier,
} from './redaction.js';
import { getPref, type InstancePrefs } from '../prefs.js';

// ── PB7.4.1 — Settings shape ────────────────────────────────────────

/** Per-class visibility map. Closed key set so adding a class requires
 *  a substrate D-spec change. Default is "all visible"; the user-set
 *  Settings overlay flips individual classes off. */
export type TransparencyClassVisibility = Readonly<
  Record<TransparencyEventClass, boolean>
>;

/** Max redaction tier the chat-log surface renders. The visibility
 *  filter keeps events whose envelope `redaction` is <=
 *  `max_redaction_tier` (per priority table); higher tiers route to
 *  audit-only. Default `'summary_only'` matches § B.8.7's "default
 *  visible, opt-out hide" + "click-to-expand" UX. */
export type TransparencyMaxRedactionTier = TransparencyRedactionTier;

export interface TransparencyStreamSettings {
  /** Master toggle — false suppresses every chat-log render line. */
  readonly enabled: boolean;
  /** Per-event-class opt-out. Class with `false` → hidden. */
  readonly visible_classes: TransparencyClassVisibility;
  /** Highest redaction tier rendered to chat log. Events with higher-
   *  priority tiers route to audit only (still emitted to D-120). */
  readonly max_redaction_tier: TransparencyMaxRedactionTier;
  /** Per-`network_domain` opt-out. When a domain key is present and
   *  set to `false`, events carrying that `network_domain` are
   *  suppressed in chat log. Currently applies to `resolution.alias`
   *  whose payload carries `network_domain`. */
  readonly hidden_network_domains: ReadonlySet<string>;
}

/** § B.8.9 default — master ON, every class visible EXCEPT
 *  `orchestration` (multi-turn loop + fixed-slot drift; low-noise UX
 *  per § B.6.1). Render up to `summary_only` (so click-to-expand works
 *  for `context_omitted` / `ai_call`), no per-network-domain hides. */
export const DEFAULT_TRANSPARENCY_STREAM_SETTINGS: TransparencyStreamSettings = Object.freeze({
  enabled: true,
  visible_classes: Object.freeze({
    ai_emitted: true,
    engine_brokering: true,
    failure: true,
    /** Hidden by default — engine cooperation noise. Users opt in via
     *  Settings → Show internal orchestration. */
    orchestration: false,
  }) as TransparencyClassVisibility,
  max_redaction_tier: 'summary_only',
  hidden_network_domains: new Set<string>(),
});

// ── PB7.4.2 — Visibility filter ─────────────────────────────────────

/** Resolve whether an event should render to the chat-log surface
 *  given the user's Settings. Returns the resolved redaction tier OR
 *  `'hidden'` to signal "drop from chat log".
 *
 *  Priority order (each step short-circuits on hide):
 *
 *    1. Master toggle — `enabled === false` → `'hidden'`.
 *    2. Per-class visibility — class disabled → `'hidden'`.
 *    3. Per-network-domain filter — payload's `network_domain` in
 *       `hidden_network_domains` → `'hidden'`.
 *    4. Per-redaction-tier — incoming tier > `max_redaction_tier` →
 *       `'hidden'`. Otherwise pass through the incoming tier.
 *
 *  **Failure-class invariant (§ B.8.2 user-must-see).** Events in the
 *  `'failure'` class — `privacy.hard_fail` / `standing_instruction_-
 *  conflict` / `cost_ceiling.halted` / `cost_ceiling.demoted` /
 *  `capacity_gap_mid_run` / `ai_call.malformed` / `ai_call.giving_-
 *  up_malformed` — bypass Settings hide entirely (master toggle +
 *  per-class + per-tier). Truthful failure messaging is a substrate
 *  invariant, not a user preference. The user can still suppress
 *  individual failure-class kinds at the OS / chat-bubble layer
 *  (delete / collapse) but cannot make Recued lie about a failure
 *  through Settings. */
export const applyVisibilityPolicy = (
  event: TransparencyEvent,
  envelope_redaction: TransparencyRedactionTier,
  settings: TransparencyStreamSettings,
): TransparencyRedactionTier => {
  const cls = TRANSPARENCY_EVENT_CLASS_FOR_KIND[event.kind];
  // Codex P2 fold (2026-05-10) — failure-class events bypass Settings
  // hide per § B.8.2's user-must-see-truthful-failures invariant. The
  // incoming tier still threads through (defaulted to `'none'` by the
  // composer for every failure kind in `TRANSPARENCY_DEFAULT_REDACTION_-
  // FOR_KIND`). Settings cannot suppress a failure event.
  if (cls === 'failure') {
    return envelope_redaction;
  }
  if (!settings.enabled) {
    return 'hidden';
  }
  if (settings.visible_classes[cls] === false) {
    return 'hidden';
  }
  // Per-network-domain filter — only `resolution.alias` carries
  // `network_domain` in its payload at PB7. The check is keyed on the
  // payload field directly so a future kind that adds `network_domain`
  // is automatically governed by the same filter.
  if (event.kind === 'resolution.alias') {
    const domain = event.network_domain;
    if (typeof domain === 'string' && settings.hidden_network_domains.has(domain)) {
      return 'hidden';
    }
  }
  // Tier filter — the incoming envelope's tier must be ≤ the user's
  // max-tier preference (per priority table; lower number = more info).
  const incomingPriority = TRANSPARENCY_REDACTION_TIER_PRIORITY[envelope_redaction];
  const maxPriority = TRANSPARENCY_REDACTION_TIER_PRIORITY[settings.max_redaction_tier];
  if (incomingPriority > maxPriority) {
    return 'hidden';
  }
  return envelope_redaction;
};

/** Assemble the typed Settings object from the per-pair `ui.
 *  transparency.*` instance prefs (the persistence shape — see the
 *  registry block in `prefs.ts`). Missing / invalid prefs fall back to
 *  the registered defaults, which mirror
 *  `DEFAULT_TRANSPARENCY_STREAM_SETTINGS` (a contracts test pins the
 *  correspondence), so `transparencyStreamSettingsFromPrefs(undefined)`
 *  ≡ the default settings.
 *
 *  The `failure` class is hard-wired `true`: § B.8.2's user-must-see
 *  invariant is a substrate guarantee, not a pref —
 *  `applyVisibilityPolicy` bypasses Settings for failure-class events
 *  regardless, this just keeps the assembled shape honest. Per-
 *  network-domain hides have no prefs persistence yet (the § B.8.9
 *  surface for them is a follow-on); the assembled set is empty. */
export const transparencyStreamSettingsFromPrefs = (
  prefs: Partial<InstancePrefs> | undefined,
): TransparencyStreamSettings => ({
  enabled: getPref(prefs, 'ui.transparency.enabled'),
  visible_classes: Object.freeze({
    ai_emitted: getPref(prefs, 'ui.transparency.class.ai_emitted'),
    engine_brokering: getPref(prefs, 'ui.transparency.class.engine_brokering'),
    orchestration: getPref(prefs, 'ui.transparency.class.orchestration'),
    failure: true,
  }) as TransparencyClassVisibility,
  max_redaction_tier: getPref(prefs, 'ui.transparency.max_redaction_tier'),
  hidden_network_domains: new Set<string>(),
});

// ── PB7.4.3 — Settings builder helpers ──────────────────────────────

/** Build a new Settings object overriding specified per-class
 *  visibility entries. Pure — does not mutate the input. The webclient
 *  Settings UI uses this when the user toggles a class. */
export const withVisibleClasses = (
  base: TransparencyStreamSettings,
  overrides: Partial<TransparencyClassVisibility>,
): TransparencyStreamSettings => ({
  enabled: base.enabled,
  visible_classes: Object.freeze({
    ...base.visible_classes,
    ...overrides,
  }) as TransparencyClassVisibility,
  max_redaction_tier: base.max_redaction_tier,
  hidden_network_domains: base.hidden_network_domains,
});

/** Build a new Settings object overriding the master toggle. */
export const withEnabled = (
  base: TransparencyStreamSettings,
  enabled: boolean,
): TransparencyStreamSettings => ({
  enabled,
  visible_classes: base.visible_classes,
  max_redaction_tier: base.max_redaction_tier,
  hidden_network_domains: base.hidden_network_domains,
});

/** Build a new Settings object overriding the max-redaction-tier. */
export const withMaxRedactionTier = (
  base: TransparencyStreamSettings,
  tier: TransparencyMaxRedactionTier,
): TransparencyStreamSettings => ({
  enabled: base.enabled,
  visible_classes: base.visible_classes,
  max_redaction_tier: tier,
  hidden_network_domains: base.hidden_network_domains,
});

/** Build a new Settings object adding/removing a hidden network
 *  domain. */
export const withHiddenNetworkDomain = (
  base: TransparencyStreamSettings,
  domain: string,
  hidden: boolean,
): TransparencyStreamSettings => {
  const next = new Set(base.hidden_network_domains);
  if (hidden) {
    next.add(domain);
  } else {
    next.delete(domain);
  }
  return {
    enabled: base.enabled,
    visible_classes: base.visible_classes,
    max_redaction_tier: base.max_redaction_tier,
    hidden_network_domains: next,
  };
};

// ── PB7.4.4 — Substrate self-check ──────────────────────────────────

export const assertTransparencySettingsInvariants = (): void => {
  // Default visibility must include every class.
  for (const cls of TRANSPARENCY_EVENT_CLASSES) {
    if (
      typeof DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes[cls] !==
      'boolean'
    ) {
      throw new Error(
        `DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes missing entry for class '${cls}'`,
      );
    }
  }
  const defaultClassKeys = Object.keys(
    DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes,
  );
  if (defaultClassKeys.length !== TRANSPARENCY_EVENT_CLASSES.length) {
    throw new Error(
      `DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes has ${defaultClassKeys.length} entries; expected ${TRANSPARENCY_EVENT_CLASSES.length}`,
    );
  }
};
