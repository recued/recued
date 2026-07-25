/** D-149 P5 § A.5.2 — `scheduling_link_packet` transformation +
 *  config parser.
 *
 *  Source layer:
 *
 *    - `parseSchedulingLinkConfig(metadata_blob)` — defensively parses
 *      the registry row's metadata blob into a typed
 *      `SchedulingLinkConfig`. Wraps `validateSchedulingLinkConfig` so
 *      a corrupt blob returns `null` (handler renders the placeholder)
 *      instead of throwing.
 *
 *    - `buildSchedulingLinkPacketRawInput(source)` — packs a typed
 *      source view into the raw input shape the substrate
 *      `boundaryTransformByKind.scheduling_link_packet` consumes.
 *
 *  Standing Instructions integration (§ A.5.2 line 654): the SI
 *  evaluation is engine-side (reactive trigger consumes the new
 *  `reception_form_submission` row → engine path → SI evaluation →
 *  auto-confirm or review). The substrate / handler path here does
 *  NOT consult SIs — that would break the substrate's "no engine code
 *  in the request thread" invariant (Must Hold I-12). The handler
 *  reads only the `standing_instructions_ref` STRING from the config
 *  (it's just an opaque identifier from the substrate's POV); the
 *  reactive engine path resolves the row at fire time. */

import {
  validateSchedulingLinkConfig,
  type AvailabilityRawCalendarEvent,
  type SchedulingLinkConfig,
  type SchedulingLinkPacketRawInput,
  type SchedulingLinkVisitorFieldRequirements,
} from '@recued/contracts';

/** Source view — slim typed shape over the registry-side data the
 *  handler assembles. Stays pure; tests + engine paths can synthesize
 *  one directly. */
export interface SchedulingLinkSourceView {
  readonly calendar_events: ReadonlyArray<AvailabilityRawCalendarEvent>;
  readonly window_start: number;
  readonly window_end: number;
  readonly tz: string;
  readonly duration_options: ReadonlyArray<number>;
  readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements;
  readonly min_advance_notice_hours: number;
  readonly max_lead_time_days: number;
}

/** Pack a source view into the raw-input shape the substrate consumes.
 *  Pure function. The substrate computes `free_windows` from
 *  `calendar_events + window_start + window_end` at build time; raw
 *  event titles / attendees / agendas never reach the payload. */
export const buildSchedulingLinkPacketRawInput = (
  source: SchedulingLinkSourceView,
): SchedulingLinkPacketRawInput => ({
  calendar_events: source.calendar_events,
  window_start: source.window_start,
  window_end: source.window_end,
  tz: source.tz,
  duration_options: source.duration_options,
  required_visitor_fields: source.required_visitor_fields,
  min_advance_notice_hours: source.min_advance_notice_hours,
  max_lead_time_days: source.max_lead_time_days,
});

/** Parse + validate the registry row's `metadata` blob → typed config.
 *  Returns `null` when the blob is structurally invalid (corrupt JSON,
 *  validator failures, missing required fields) so the GET handler
 *  can fall back to the placeholder render rather than 500ing. */
export const parseSchedulingLinkConfig = (
  metadata: Readonly<Record<string, unknown>>,
): SchedulingLinkConfig | null => {
  const failures = validateSchedulingLinkConfig(metadata);
  if (failures.length > 0) return null;
  return metadata as unknown as SchedulingLinkConfig;
};
