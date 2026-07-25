/** D-145 PB6 — AIOutput composer pipeline.
 *
 *  Per § B.7. The composer is the substrate's transformation from a
 *  raw `AIOutput` returned by the AI provider into a `ComposedAIOutput`
 *  ready for rendering by PB7's Transparency Stream + by the per-
 *  event confirmation / undo surfaces.
 *
 *  Pipeline stages (each stage is a pure pass — no IO, no side
 *  effects):
 *
 *    1. Validate top-level AIOutput shape (`validateAIOutput`) +
 *       per-event `kind` + `confidence` (`validateExtractionEvent`).
 *       Composer halts cleanly with closed-list `ComposerIssueKind`
 *       when invalid — orchestrator stamps the matching plan status.
 *
 *    2. Order events per § B.7.8 — resolutions before extractions
 *       before derived effects; stable order within class.
 *
 *    3. Dispatch each event per § B.7.7 — high → auto_save,
 *       medium → queue_for_confirm, low → annotate_only. Each event
 *       gets a stable per-event undo token (§ B.7.9).
 *
 *    4. Apply noise control per § B.7.10 — group by source_message_id;
 *       collapse to summary when count ≥ MULTI_EVENT_COLLAPSE_THRESHOLD.
 *
 *    5. Batch medium-confidence events per § B.7.11 — group
 *       queue_for_confirm events by source_message_id into
 *       confirmation groups for the per-event-undo + bulk-confirm UX.
 *
 *  The composer NEVER mutates the AI provider's bytes — `events` flow
 *  through unchanged; the composer only adds dispatch / undo / group
 *  metadata. PB7 reads the composed output to render Recued-voiced
 *  templates; PB13 Dry Run threads through unchanged for preview;
 *  the agent loop's output lands at the composer.
 *
 *  Spec: § B.7. */

import {
  validateAIOutput,
  validateExtractionEvent,
  type AIOutput,
  type AIOutputValidationIssue,
  type ExtractionEvent,
  type ExtractionEventValidationIssue,
} from '@recued/contracts';

import {
  batchForConfirmation,
  type ConfirmationGroup,
} from './confirmation-queue.js';
import {
  dispatchEvents,
  type DispatchedEvent,
} from './dispatch.js';
import {
  applyNoiseControl,
  type NoiseGroup,
} from './noise-control.js';
import { orderEvents } from './ordering.js';

/** Closed-list composer issue kinds. PB6 ratchet pins membership.
 *  Each kind maps to either an `AIOutputValidationIssue.kind` or an
 *  `ExtractionEventValidationIssue.kind` so the orchestrator can
 *  stamp the right plan status / failure_class. */
export const AI_OUTPUT_COMPOSER_ISSUE_KINDS = [
  /** Top-level AIOutput shape failed (`validateAIOutput`). */
  'ai_output_shape_invalid',
  /** Per-event `kind` / `confidence` failed
   *  (`validateExtractionEvent`). */
  'extraction_event_invalid',
] as const;
export type AIOutputComposerIssueKind =
  (typeof AI_OUTPUT_COMPOSER_ISSUE_KINDS)[number];
export const AI_OUTPUT_COMPOSER_ISSUE_KIND_SET: ReadonlySet<AIOutputComposerIssueKind> =
  new Set(AI_OUTPUT_COMPOSER_ISSUE_KINDS);

export interface AIOutputComposerIssue {
  readonly kind: AIOutputComposerIssueKind;
  /** Index into AIOutput.events — only set for `extraction_event_invalid`. */
  readonly event_index?: number;
  /** Sub-issue from the contracts-side validators. */
  readonly detail:
    | AIOutputValidationIssue
    | ExtractionEventValidationIssue;
}

/** § B.7.7 + § B.7.10 + § B.7.11 — the composed-output shape.
 *  Downstream consumers (PB7, PB13) read these fields:
 *
 *    - `response`              — Recued voice (passthrough; PB7
 *                                templates may normalize tone)
 *    - `dispatched_events`     — every event with dispatch + undo
 *                                token, ordered per § B.7.8
 *    - `noise_groups`          — § B.7.10 inline-vs-collapsed groups
 *    - `confirmation_groups`   — § B.7.11 medium-confidence batches
 *    - `passthrough_events`    — auto-save + annotate-only (the
 *                                non-confirmation portion of dispatch)
 *    - `tool_calls`            — passthrough (orchestrator dispatches) */
export interface ComposedAIOutput {
  readonly response: string;
  readonly dispatched_events: ReadonlyArray<DispatchedEvent>;
  readonly noise_groups: ReadonlyArray<NoiseGroup>;
  readonly confirmation_groups: ReadonlyArray<ConfirmationGroup>;
  readonly passthrough_events: ReadonlyArray<DispatchedEvent>;
  readonly tool_calls: AIOutput['tool_calls'];
}

export interface ComposeAIOutputResult {
  readonly composed?: ComposedAIOutput;
  readonly issues: ReadonlyArray<AIOutputComposerIssue>;
}

/** § B.7 — full composer pipeline. Pure — no IO, no side effects.
 *
 *  Halts on the FIRST validation failure — either AIOutput shape OR
 *  any per-event kind/confidence issue. The composer never partially
 *  composes; downstream consumers can rely on `composed` being either
 *  fully populated or absent.
 *
 *  Per § B.7.13: cascade fan-out from a single source message is
 *  governed by the walk-cap budget (D-136), NOT the composer. PB6
 *  ships the per-source noise-control + confirmation-batching; the
 *  walk-cap budget enforcement activates once cascade events land
 *  (none emitted yet).
 *
 *  Codex P2 fold (2026-05-10) — `output` is `unknown` because the
 *  composer is the substrate's malformed-AI-output gate; AI provider
 *  output is parsed JSON and could carry `null` at top level OR `null`
 *  inside the events array. The widened gate keeps the substrate's
 *  "never throw on bad input" invariant intact. */
export const composeAIOutput = (
  output: unknown,
): ComposeAIOutputResult => {
  const issues: AIOutputComposerIssue[] = [];

  // Stage 1a — top-level AIOutput shape.
  const shapeIssues = validateAIOutput(output);
  for (const detail of shapeIssues) {
    issues.push({ kind: 'ai_output_shape_invalid', detail });
  }
  if (issues.length > 0) {
    return { issues };
  }

  // Shape gate passed → narrow once. The validator guarantees `output`
  // is a non-null object with the three required array / string fields;
  // per-event narrowing happens inside `validateExtractionEvent`.
  const validated = output as AIOutput;

  // Stage 1b — per-event kind/confidence. The events array may still
  // carry null / non-object entries (top-level shape gate only checked
  // `Array.isArray`); the widened `validateExtractionEvent(unknown)`
  // emits structured issues for those cases without throwing.
  const rawEvents = validated.events as ReadonlyArray<unknown>;
  for (let index = 0; index < rawEvents.length; index++) {
    const event = rawEvents[index];
    const eventIssues = validateExtractionEvent(event);
    for (const detail of eventIssues) {
      issues.push({
        kind: 'extraction_event_invalid',
        event_index: index,
        detail,
      });
    }
  }
  if (issues.length > 0) {
    return { issues };
  }

  // Stage 2 — composer ordering.
  const ordered: ReadonlyArray<ExtractionEvent> = orderEvents(
    validated.events,
    (event) => event.kind,
  );

  // Stage 3 — confidence-tier dispatch.
  const { dispatched } = dispatchEvents(ordered);

  // Stage 4 — multi-event noise control.
  const { groups: noise_groups } = applyNoiseControl(dispatched);

  // Stage 5 — confirmation queue batching.
  const { groups: confirmation_groups, passthrough: passthrough_events } =
    batchForConfirmation(dispatched);

  return {
    composed: {
      response: validated.response,
      dispatched_events: dispatched,
      noise_groups,
      confirmation_groups,
      passthrough_events,
      tool_calls: validated.tool_calls,
    },
    issues: [],
  };
};
