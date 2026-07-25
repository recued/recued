/** D-145 PB7 — Transparency Stream substrate (UNIFIED) — engine barrel.
 *
 *  Spec: § B.8. */

export {
  TRANSPARENCY_COMPOSER_ISSUE_KINDS,
  TRANSPARENCY_COMPOSER_ISSUE_KIND_SET,
  composeTransparencyEvent,
  composeTransparencyEventWithAudit,
  renderTransparencyEnvelope,
} from './composer.js';
export type {
  TransparencyComposerIssueKind,
  TransparencyComposerIssue,
  ComposeTransparencyEventInput,
  ComposeTransparencyEventResult,
} from './composer.js';

export { mapDispatchedEventToTransparency } from './extraction-mapping.js';
