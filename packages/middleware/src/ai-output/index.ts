/** D-145 PB6 — AIOutput composer barrel.
 *
 *  Pure helpers used by PB7 (transparency-stream renderer) and PB13
 *  (Dry Run preview wrapper) to compose the closed `ExtractionEvent`
 *  taxonomy + AIOutput shape
 *  through the substrate's per-event dispatch + composer ordering +
 *  noise control + confirmation-queue batching pipeline.
 *
 *  Spec: § B.7. */

export {
  buildUndoToken,
  dispatchEvents,
  type DispatchEventsResult,
  type DispatchedEvent,
  type EventUndoToken,
} from './dispatch.js';

export {
  orderEvents,
  orderExtractionEvents,
} from './ordering.js';

export {
  applyNoiseControl,
  type NoiseControlResult,
  type NoiseGroup,
} from './noise-control.js';

export {
  batchForConfirmation,
  type BatchForConfirmationResult,
  type ConfirmationGroup,
} from './confirmation-queue.js';

export {
  composeAIOutput,
  AI_OUTPUT_COMPOSER_ISSUE_KINDS,
  AI_OUTPUT_COMPOSER_ISSUE_KIND_SET,
  type AIOutputComposerIssue,
  type AIOutputComposerIssueKind,
  type ComposedAIOutput,
  type ComposeAIOutputResult,
} from './composer.js';
