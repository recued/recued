/** D-149 P4 § A.4 + § A.5.1 — `reception_page_packet` transformation
 *  helpers (server-side, per-kind).
 *
 *  P2 shipped the source-query → raw-input adapter skeleton. P4 lands
 *  the live wiring against the registry singleton row's
 *  `metadata_blob` (the `ReceptionPageConfig` payload). The substrate
 *  (`packages/contracts/src/redacted-packets.ts`) owns the closed-list
 *  pick + per-kind transformation step; this file owns the registry-
 *  side reads that produce the raw input (display profile + section
 *  toggles + linked endpoint ids + custom links).
 *
 *  Default-empty state per § A.5.1: when no `ReceptionPageConfig` row
 *  exists yet (fresh-install), the handler skips raw-input assembly
 *  entirely + renders the substrate placeholder. The assembler here
 *  is only called for configured rows. */

import type {
  ReceptionPageConfig,
  ReceptionPageLinkedEndpoints,
  ReceptionPagePreferredContactMethod,
  ReceptionPagePacketRawInput,
  ReceptionPageSectionConfig,
} from '@recued/contracts';

/** Minimal source view used to build the raw input. Mirrors the
 *  fields the boundary transform picks; per-kind transformation in
 *  the redacted-packet substrate handles section→cta projection. */
export interface ReceptionPageSourceView {
  readonly display_name: string;
  readonly tagline: string;
  readonly avatar_url?: string;
  readonly preferred_contact_methods: ReadonlyArray<ReceptionPagePreferredContactMethod>;
  readonly tz_label: string;
  readonly response_time_estimate?: string;
  readonly section_config?: ReceptionPageSectionConfig;
  readonly linked_endpoints?: ReceptionPageLinkedEndpoints;
}

/** Adapter — produces the raw input the substrate transform consumes.
 *  Pure function; takes the source view as-is. The substrate's
 *  closed-list pick + per-kind boundary transformation enforces the
 *  privacy contract (private fields like `section_config` get
 *  projected to `cta_buttons` + dropped). */
export const buildReceptionPagePacketRawInput = (
  source: ReceptionPageSourceView,
): ReceptionPagePacketRawInput => {
  const raw: {
    display_name: string;
    tagline: string;
    avatar_url?: string;
    preferred_contact_methods: ReadonlyArray<ReceptionPagePreferredContactMethod>;
    tz_label: string;
    response_time_estimate?: string;
    section_config?: ReceptionPageSectionConfig;
    linked_endpoints?: ReceptionPageLinkedEndpoints;
  } = {
    display_name: source.display_name,
    tagline: source.tagline,
    preferred_contact_methods: source.preferred_contact_methods,
    tz_label: source.tz_label,
  };
  if (source.avatar_url !== undefined) raw.avatar_url = source.avatar_url;
  if (source.response_time_estimate !== undefined) {
    raw.response_time_estimate = source.response_time_estimate;
  }
  if (source.section_config !== undefined) raw.section_config = source.section_config;
  if (source.linked_endpoints !== undefined) raw.linked_endpoints = source.linked_endpoints;
  return raw;
};

/** P4 assembler — produce a source view from a stored
 *  `ReceptionPageConfig`. The config is the single source of truth at
 *  v1 (the user-profile substrate is not yet wired; once it lands a
 *  fallback chain — `display_overrides.<field>` ?? `user_profile.<field>`
 *  ?? substrate placeholder — will slot in here without changing the
 *  consumer side).
 *
 *  Returns `null` when the config is structurally invalid (e.g. the
 *  metadata blob was hand-edited to remove `display_overrides`). The
 *  caller falls back to the substrate placeholder. */
export const assembleReceptionPageSourceView = (
  config: ReceptionPageConfig,
): ReceptionPageSourceView | null => {
  const d = config.display_overrides;
  if (!d || typeof d.display_name !== 'string' || d.display_name.length === 0) {
    return null;
  }
  if (typeof d.tz_label !== 'string' || d.tz_label.length === 0) return null;
  // Codex review P2 fold (2026-05-13 P4) — section toggles are applied
  // at the assembler boundary so the visitor-facing packet only carries
  // the fields the user explicitly enabled. Pre-fold, the assembler
  // forwarded every configured field regardless of the toggle, so
  // `sections_enabled.contact_methods === false` with a populated
  // `preferred_contact_methods` still rendered the "Reach me via" chips.
  // The substrate-side projector still gates CTAs on the per-CTA
  // toggle (`availability_cta` / `intake_cta` / `drop_cta`); the
  // contact-card / contact-methods toggles need their own gate here
  // because the projector doesn't see those bits.
  const contactMethods =
    config.sections_enabled.contact_methods === true
      ? d.preferred_contact_methods ?? []
      : [];
  // Contact-card toggle gates display_name + tagline + avatar +
  // response_time_estimate. Setting it false produces the placeholder
  // body (the renderer falls through to the sections-empty branch when
  // every other section is also empty); preserve display_name regardless
  // because the substrate validator requires it non-empty, but blank
  // the tagline + avatar + response_time so they don't surface.
  const showContactCard = config.sections_enabled.contact_card !== false;
  const out: {
    display_name: string;
    tagline: string;
    tz_label: string;
    preferred_contact_methods: ReadonlyArray<ReceptionPagePreferredContactMethod>;
    avatar_url?: string;
    response_time_estimate?: string;
    section_config?: ReceptionPageSectionConfig;
    linked_endpoints?: ReceptionPageLinkedEndpoints;
  } = {
    display_name: d.display_name,
    tagline: showContactCard && typeof d.tagline === 'string' ? d.tagline : '',
    tz_label: d.tz_label,
    preferred_contact_methods: contactMethods,
    section_config: config.sections_enabled,
    linked_endpoints: config.linked_endpoints,
  };
  if (showContactCard && d.avatar_url !== undefined) out.avatar_url = d.avatar_url;
  if (showContactCard && d.response_time_estimate !== undefined) {
    out.response_time_estimate = d.response_time_estimate;
  }
  return out;
};
