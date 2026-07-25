/** D-149 P7 § A.4 + § A.5.4 — `drop_link_packet` transformation helpers
 *  (server-side, per-kind).
 *
 *  Two responsibilities:
 *
 *    1. `buildDropLinkPacketRawInput(source)` — adapter the GET handler
 *       calls to project a stored `DropLinkConfig` into the redacted-
 *       packet raw input shape. Strips user-only fields at this
 *       boundary (storage path, blob ids,
 *       contact-scoping metadata, `auto_attach_to_*` flags); the
 *       redacted-packet substrate strict-picks `fields_visible` AGAIN
 *       at the build step (defense in depth).
 *
 *    2. `parseDropLinkConfig(metadata)` — typed parser for the per-
 *       endpoint config blob persisted in `public_endpoint_registry.
 *       metadata_blob`. Returns `null` when the blob doesn't validate
 *       (rpc-side gate already rejects; runtime falls back to
 *       placeholder on parse fail).
 *
 *  Pure module — no I/O.
 *
 *  Spec: `docs/d-149-spec.md` § A.5.4 + § Must Hold I-1. */

import {
  DROP_LINK_EXPIRY_DAYS_DEFAULT,
  validateDropLinkConfig,
  type DropLinkAllowedMimeType,
  type DropLinkConfig,
  type DropLinkPacketRawInput,
  type DropLinkVisitorFieldRequirements,
} from '@recued/contracts';

/** Minimal source view used to build the raw input. The substrate
 *  consumer rebuilds the visitor-facing payload from this closed shape
 *  + drops anything outside it. */
export interface DropLinkSourceView {
  readonly size_cap_bytes: number;
  readonly allowed_mime_types: ReadonlyArray<DropLinkAllowedMimeType>;
  readonly instructions: string;
  readonly required_visitor_fields: DropLinkVisitorFieldRequirements;
  readonly one_time_use: boolean;
  readonly expiry_display: string;
}

/** Adapter — produces the raw input the substrate transform consumes. */
export const buildDropLinkPacketRawInput = (
  source: DropLinkSourceView,
): DropLinkPacketRawInput => ({
  size_cap_bytes: source.size_cap_bytes,
  allowed_mime_types: source.allowed_mime_types,
  instructions: source.instructions,
  required_visitor_fields: source.required_visitor_fields,
  one_time_use: source.one_time_use,
  expiry_display: source.expiry_display,
});

/** Parse the stored `metadata_blob` of a `drop_link` registry row into
 *  a typed `DropLinkConfig`. Returns `null` when the blob fails the
 *  substrate validator (the rpc-side gate normally rejects invalid
 *  configs at create time; defense in depth at runtime). */
export const parseDropLinkConfig = (raw: unknown): DropLinkConfig | null => {
  const failures = validateDropLinkConfig(raw);
  if (failures.length > 0) return null;
  return raw as DropLinkConfig;
};

/** Build the source view from a parsed `DropLinkConfig`. The handler
 *  uses this directly; the bin.ts wiring composes the source-of-truth
 *  blob (config + Foundation pack template metadata). */
export const buildDropLinkSourceView = (
  config: DropLinkConfig,
): DropLinkSourceView => {
  return {
    size_cap_bytes: config.size_cap_bytes,
    allowed_mime_types: config.allowed_mime_types,
    instructions: config.instructions ?? '',
    required_visitor_fields: config.required_visitor_fields,
    one_time_use: config.link_kind === 'one_time',
    expiry_display: `${config.expiry_days ?? DROP_LINK_EXPIRY_DAYS_DEFAULT} days`,
  };
};
