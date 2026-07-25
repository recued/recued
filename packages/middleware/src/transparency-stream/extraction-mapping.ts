/** D-145 PB7 — PB6 ExtractionEvent → PB7 TransparencyEvent mapping.
 *
 *  PB6 ships a closed extraction-event taxonomy with confidence-tier
 *  dispatch (auto_save / queue_for_confirm / annotate_only). PB7's
 *  Transparency Stream surfaces those events with Recued voice
 *  templates per § B.8.2 + § B.8.4.
 *
 *  This mapping translates a PB6 `DispatchedEvent` into one
 *  `TransparencyEvent` so the unified composer can render the AI-
 *  emitted side of the stream with the same pipeline that handles
 *  engine-brokering events.
 *
 *  Per dispatch tier:
 *    - `auto_save` → `extraction.saved` (the AI-auto-save UX line)
 *    - `queue_for_confirm` → `extraction.queued_for_confirm`
 *    - `annotate_only` → `extraction.skipped_low_confidence`
 *
 *  The PB6 confidence threshold (§ B.7.7) is the dispatch decision;
 *  PB7's mapping reads that decision rather than re-deriving from
 *  raw `confidence`. Caller-side (typically the orchestrator's per-
 *  turn flush) passes the dispatched events through this mapper into
 *  the composer.
 *
 *  Spec: § B.7 + § B.8. */

import type {
  DispatchedEvent,
} from '../ai-output/dispatch.js';
import type {
  TransparencyEvent,
} from '@recued/contracts';

// ── PB7.M.1 — Map dispatched event → transparency event ─────────────

/** Map one PB6 `DispatchedEvent` to a PB7 `TransparencyEvent`. The
 *  mapping pulls fields from `event.args` / `event.source_message_id`
 *  / `event.confidence` per the kind-specific extraction-event
 *  payload conventions. When the args don't include the field the
 *  template needs, we fall back to a closed-list sentinel — never
 *  raise; the composer's downstream validator catches malformed
 *  events at the gate. */
export const mapDispatchedEventToTransparency = (
  dispatched: DispatchedEvent,
): TransparencyEvent | null => {
  const { event, dispatch } = dispatched;
  // Resolution events surface verbatim (no confidence-tier shaping —
  // they describe identity-graph augmentations the user should always
  // see when emitted).
  if (event.kind === 'resolution.alias') {
    const alias = stringField(event.args, 'alias');
    const contact_name = stringField(event.args, 'contact_name');
    const network_domain = stringField(event.args, 'network_domain');
    if (alias === undefined || contact_name === undefined) return null;
    return {
      kind: 'resolution.alias',
      alias,
      contact_name,
      ...(network_domain !== undefined ? { network_domain } : {}),
    };
  }
  if (event.kind === 'resolution.contact_created_mention_only') {
    const name = stringField(event.args, 'name');
    const mention_only_id = stringField(event.args, 'mention_only_id');
    if (name === undefined || mention_only_id === undefined) return null;
    return { kind: 'resolution.contact_created_mention_only', name, mention_only_id };
  }
  if (event.kind === 'resolution.network_domain_inferred') {
    const contact_name = stringField(event.args, 'contact_name');
    const domain = stringField(event.args, 'domain');
    if (contact_name === undefined || domain === undefined) return null;
    return { kind: 'resolution.network_domain_inferred', contact_name, domain };
  }

  // Extraction events surface based on dispatch tier.
  //
  // Codex P2 fold (2026-05-10) — return `null` instead of fabricating
  // sentinel ids (`'<pending>'`) when the dispatched event is missing
  // `entity_id` / `queue_entry_id`. The downstream
  // `validateTransparencyEvent` only checks that the field is a
  // string; sentinels would slip through and surface as fake-but-
  // valid audit / chat events. A null return tells the caller to
  // skip emission rather than render a misleading line.
  if (event.kind.startsWith('extraction.')) {
    if (dispatch === 'auto_save') {
      const entity_kind = entityKindForExtraction(event.kind);
      const entity_id = stringField(event.args, 'entity_id');
      if (entity_id === undefined) return null;
      return {
        kind: 'extraction.saved',
        entity_kind,
        entity_id,
        confidence: event.confidence,
      };
    }
    if (dispatch === 'queue_for_confirm') {
      const queue_entry_id = stringField(event.args, 'queue_entry_id');
      if (queue_entry_id === undefined) return null;
      return {
        kind: 'extraction.queued_for_confirm',
        queue_entry_id,
        confidence: event.confidence,
      };
    }
    // annotate_only — surface the fact briefly with a "not confident
    // enough" tone per the template. Drops the event entirely when
    // neither `fact` nor `summary` is present so the substrate never
    // emits a placeholder fact string.
    const fact = stringField(event.args, 'fact')
      ?? stringField(event.args, 'summary');
    if (fact === undefined) return null;
    return {
      kind: 'extraction.skipped_low_confidence',
      fact,
      confidence: event.confidence,
    };
  }

  // PB6 only emits `extraction.*` + `resolution.*`; future kinds widen
  // here when cascade events land. Return null for any
  // unmapped kind so the composer skips emission rather than
  // emitting a malformed event.
  return null;
};

/** § B.7 hint — extraction kind → entity_kind for the saved event.
 *  Closed registry; falls back to the trailing kind segment. */
const entityKindForExtraction = (kind: string): string => {
  switch (kind) {
    case 'extraction.purchase':
      return 'purchase';
    case 'extraction.plan':
      return 'plan';
    case 'extraction.commitment':
      return 'commitment';
    case 'extraction.task':
      return 'task';
    case 'extraction.note':
      return 'note';
    case 'extraction.preference':
      return 'preference';
    case 'extraction.commitment_status_check':
      return 'commitment_status_check';
    default: {
      const idx = kind.lastIndexOf('.');
      return idx >= 0 ? kind.slice(idx + 1) : kind;
    }
  }
};

const stringField = (
  args: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined => {
  const v = args[name];
  return typeof v === 'string' ? v : undefined;
};
