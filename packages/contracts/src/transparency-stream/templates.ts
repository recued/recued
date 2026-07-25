/** D-145 PB7 — Recued voice templates (English baseline) per § B.8.4.
 *
 *  The Transparency Stream is NOT a passthrough of AI output. It's a
 *  closed event taxonomy + templated composition layer where Recued
 *  owns the user-facing voice. AI providers return structured events
 *  (tool calls, JSON); Recued's composer parses by event type and
 *  templates into Recued-voiced inline text per the registry below.
 *
 *  Tone calibration (§ B.8.5):
 *    - Warm but concise — short, friendly, no hedging.
 *    - Lower-case stylistic when in the inline stream (not formal).
 *    - First-person-system — "I'm noticing" not "the system has detected".
 *    - Honest about uncertainty — "not confident enough" is fine.
 *    - Never apologetic for capability — say what was done.
 *    - Per-event-class tone may vary — extractions matter-of-fact;
 *      pattern observations slightly more conversational.
 *
 *  Each template is a slot-substitution function mapping the typed
 *  event payload to a Recued-voiced line. Empty-string return is the
 *  signal for "renders nothing" (silent-by-default events still pass
 *  through the composer for audit emission; the chat-log renderer
 *  drops empty render_text lines).
 *
 *  Localization-ready by construction: closed taxonomy + per-locale
 *  registry. PB7 ships the English baseline; future locales add a
 *  parallel registry under the same key set.
 *
 *  Spec: § B.8.3 + § B.8.4 + § B.8.5. */

import type {
  TransparencyEvent,
  TransparencyEventKind,
} from './events.js';
import { TRANSPARENCY_EVENT_KINDS } from './events.js';

// ── PB7.3.1 — Per-kind template registry ────────────────────────────

/** Each entry takes the typed event payload and returns the Recued-
 *  voiced line. Empty string = silent (audit-only). The registry is a
 *  closed `Record<TransparencyEventKind, ...>` so the validator can
 *  assert every kind has a template at module load. */
export const TRANSPARENCY_TEMPLATES_EN: Readonly<{
  [K in TransparencyEventKind]: (event: Extract<TransparencyEvent, { kind: K }>) => string;
}> = Object.freeze({
  // ─ AI-emitted ─
  'extraction.detected': (e) => `detected ${e.fact_type}: ${e.summary}`,
  'extraction.saved': (e) => `saving as ${e.entity_kind} ✓`,
  'extraction.queued_for_confirm': () =>
    'medium-confidence — added to your review queue',
  'extraction.skipped_low_confidence': (e) =>
    `saw mention of ${e.fact} but not confident enough to save — let me know if you want it`,
  'resolution.alias': (e) =>
    e.network_domain
      ? `resolving "${e.alias}" → ${e.contact_name} (${e.network_domain})`
      : `resolving "${e.alias}" → ${e.contact_name}`,
  'resolution.contact_created_mention_only': (e) =>
    `created stub for "${e.name}" — promote when you know more`,
  'resolution.network_domain_inferred': (e) =>
    `noted ${e.contact_name} is in ${e.domain} network`,
  'pattern.observation': (e) => `pattern noted: ${e.observation}`,
  'drift.signal': (e) => `noticing ${e.topic} confidence drifting; flagging for review`,
  'action.completed': (e) => `done ✓ ${e.brief_outcome}`,
  'action.failed': (e) => `couldn't ${e.action}: ${e.brief_reason}`,
  // § B.8.4 — silent by default. Composer suppresses to empty.
  'cascade.fired': () => '',

  // ─ Engine-brokering ─
  // § B.8.4 — silent by default.
  'capacity_check.ok': () => '',
  'capacity_check.gap': (e) =>
    `need ${e.gap.kind}: ${e.remediation.user_facing_copy}`,
  memory_lookup: (e) =>
    `checking ${e.query_summary}... → ${e.result_count} found`,
  // § B.8.4 — surfaces only on click-to-expand. Empty render_text;
  // audit log carries the structured row.
  context_omitted: () => '',
  // § B.8.4 — composer's tier policy widens reasoning-tier to visible;
  // baseline template is summary-only "thinking..." cue. The composer
  // (engine side) escalates to the full string for reasoning tier.
  ai_call: (e) =>
    e.tier === 'reasoning'
      ? `reasoning... (round ${e.round})`
      : `thinking... (round ${e.round})`,
  bridge_dispatch: (e) =>
    `asking your browser to ${e.ingredient_slug}...`,
  approval_request: (e) => `pausing for your approval: ${e.capability}`,
  identity_resolution: (e) =>
    `resolving ${e.reference} → ${e.resolved_contact}`,
  standing_instruction_applied: (e) => {
    if (e.result.kind === 'conflict') {
      return `standing instructions need review (${e.result.conflicts.length})`;
    }
    const result = e.result;
    if (result.final_approval_required === true) {
      return 'standing instruction requires approval before the final action';
    }
    const parts = result.action_kinds.map((kind) => {
      switch (kind) {
        case 'require_approval':
          return 'approval';
        case 'force_redirect':
          return 'redirect';
        case 'redact_context':
          return 'redaction';
        case 'ban_omission_class':
          return 'omission guard';
        case 'tag_response':
          return 'response tag';
        case 'min_tier':
          return result.min_tier === null ? 'minimum tier' : `minimum ${result.min_tier}`;
        case 'max_tier':
          return result.max_tier === null ? 'maximum tier' : `maximum ${result.max_tier}`;
      }
    });
    return parts.length === 0
      ? 'standing instructions checked'
      : `standing instructions applied: ${parts.join(', ')}`;
  },

  // ─ D-164 prompt-cache main-turn assembly ─
  // Hidden by default; templates surface compact cues when users opt
  // in via the engine_brokering per-class visibility toggle.
  'engine.gate_short_circuit': (e) =>
    `matched template ${e.template_hash.slice(0, 8)} — answered without a model call`,
  'engine.catalog_assembled': (e) => {
    const entries = Object.entries(e.section_counts);
    if (entries.length === 0) return 'catalog assembled';
    const parts = entries
      .filter(([, count]) => count > 0)
      .map(([section, count]) => `${section}:${count}`);
    return `catalog: ${parts.join(' ')}`;
  },
  'engine.budget_exceeded': (e) =>
    `request budget reached: ${e.total_calls} calls / $${(e.total_cost_cents / 100).toFixed(2)}`,

  // ─ Failure semantics — user must see truthful failure messaging ─
  'engine.decoder_unavailable': (e) => {
    if (e.reason === 'no_source') {
      return 'no AI model source available for this turn — check Settings → AI / Models';
    }
    if (e.reason === 'invalid_output') {
      return 'the AI returned output that could not be decoded';
    }
    return e.site === 'tool_loop'
      ? 'the AI provider failed partway through this turn'
      : 'the AI provider failed before answering';
  },
  // Ack-before-run — the turn shell died after the message was
  // accepted; no assistant reply is coming for it. Dual-audience copy
  // (chat bubble now, audit feed later): states the outcome + the
  // recovery action without implying any partial work survived.
  'engine.turn_failed': () =>
    'this turn failed before completing — your message was saved; send it again to retry',
  'ai_call.malformed': (e) =>
    `the model returned unexpected output (round ${e.round}) — retrying`,
  'ai_call.giving_up_malformed': () =>
    `the model kept returning unexpected output — switching to fallback`,
  standing_instruction_conflict: (e) =>
    `conflicting standing instructions (${e.instruction_ids.length}) — pausing for your call`,
  'privacy.hard_fail': (e) =>
    `privacy guard halted this: ${e.violation_class.replace(/_/g, ' ')}`,
  capacity_gap_mid_run: (e) =>
    `${e.gap.kind} dropped mid-run — pausing this step`,
  'cost_ceiling.demoted': (e) =>
    `tier downgraded ${e.from_tier} → ${e.to_tier} to stay under budget`,
  'cost_ceiling.halted': (e) =>
    e.reason === 'min_tier_floor'
      ? `cost ceiling reached at minimum tier — halting`
      : `cost ceiling reached with no lower tier available — halting`,

  // ─ Engine orchestration: multi-turn loop ─
  'recued.multi_turn.round_started': (e) =>
    `round ${e.round_index + 1} of up to ${e.expected_max_rounds}...`,
  'recued.multi_turn.round_completed': (e) => {
    if (e.outcome === 'aborted') {
      return `round ${e.round_index + 1} aborted`;
    }
    if (e.outcome === 'completed') {
      return `round ${e.round_index + 1} done ✓`;
    }
    return `round ${e.round_index + 1} → continuing`;
  },
  'recued.multi_turn.loop_terminated': (e) => {
    if (e.termination_reason === 'completed') {
      return `${e.total_rounds} round${e.total_rounds === 1 ? '' : 's'} ✓`;
    }
    if (e.termination_reason === 'max_rounds_exhausted') {
      return `stopped after ${e.total_rounds} round${e.total_rounds === 1 ? '' : 's'} — round budget reached`;
    }
    return `stopped after ${e.total_rounds} round${e.total_rounds === 1 ? '' : 's'}`;
  },

  // ─ D-137 Trio #E follow-on — per-turn token usage aggregate ─
  // Compact "12.3k tokens" cue. Chat renderer pulls the structured
  // breakdown from the audit row when the user expands the drawer.
  // Scale: <1000 raw; 1000–9999 → "X.Yk" with trailing ".0" trimmed;
  // ≥10_000 → whole "Xk". Keeps the line short even at 100k+ totals.
  'recued.token_usage': (e) => {
    const k = (n: number): string => {
      if (n < 1000) return `${n}`;
      if (n >= 10_000) return `${Math.round(n / 1000)}k`;
      const tenths = Math.round(n / 100) / 10;
      return tenths === Math.trunc(tenths) ? `${tenths}k` : `${tenths.toFixed(1)}k`;
    };
    return `${k(e.total_tokens)} tokens (in ${k(e.input_tokens)} / out ${k(e.output_tokens)})`;
  },

  // ─ Engine orchestration: fixed-slot drift ─
  fixed_slot_drift: (e) => {
    const reason = e.violation_kind === 'fixed_slot_unknown_field'
      ? `unknown slot "${e.slot}"`
      : `${e.slot} drifted`;
    return `dropped alternative #${e.alternative_index} — ${reason}`;
  },
});

// ── PB7.3.2 — Render entrypoint ─────────────────────────────────────

/** Render a single transparency event into its Recued-voiced line.
 *  Pure — no IO, no mutation. Caller is the composer; rendered text
 *  flows into `TransparencyEventEnvelope.render_text`. */
export const renderTransparencyTemplate = (event: TransparencyEvent): string => {
  // The discriminated-union `kind` narrows the event type within each
  // case branch automatically; the registry lookup is statically
  // typed via the conditional `Extract` mapping above.
  const fn = TRANSPARENCY_TEMPLATES_EN[event.kind] as (
    e: TransparencyEvent,
  ) => string;
  return fn(event);
};

// ── PB7.3.3 — Substrate self-check ──────────────────────────────────

/** Defensive runtime check — every kind in the closed list has a
 *  matching template entry. The validator at registry load asserts
 *  this so adding a kind without a template is caught at boot. */
export const assertTransparencyTemplatesComplete = (): void => {
  for (const kind of TRANSPARENCY_EVENT_KINDS) {
    const fn = (TRANSPARENCY_TEMPLATES_EN as Record<string, unknown>)[kind];
    if (typeof fn !== 'function') {
      throw new Error(
        `TRANSPARENCY_TEMPLATES_EN missing template for kind '${kind}'`,
      );
    }
  }
  const registryKeys = Object.keys(TRANSPARENCY_TEMPLATES_EN);
  if (registryKeys.length !== TRANSPARENCY_EVENT_KINDS.length) {
    throw new Error(
      `TRANSPARENCY_TEMPLATES_EN has ${registryKeys.length} entries; expected ${TRANSPARENCY_EVENT_KINDS.length}`,
    );
  }
};
