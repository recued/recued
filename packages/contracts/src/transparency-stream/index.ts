/** D-145 PB7 — Transparency Stream substrate (UNIFIED) barrel.
 *
 *  Spec: § B.8. */

// Events — closed taxonomy + class registry + validation.
export {
  TRANSPARENCY_EVENT_KINDS,
  TRANSPARENCY_EVENT_KIND_SET,
  TRANSPARENCY_EVENT_CLASSES,
  TRANSPARENCY_EVENT_CLASS_SET,
  TRANSPARENCY_EVENT_CLASS_FOR_KIND,
  TRANSPARENCY_EVENT_VALIDATION_KINDS,
  TRANSPARENCY_EVENT_VALIDATION_KIND_SET,
  TRANSPARENCY_DRIFT_SEVERITIES,
  TRANSPARENCY_BRIDGE_STATUSES,
  TRANSPARENCY_PRIVACY_VIOLATION_CLASSES,
  TRANSPARENCY_COST_HALT_REASONS,
  TRANSPARENCY_DECODER_UNAVAILABLE_REASONS,
  TRANSPARENCY_DECODER_UNAVAILABLE_SITES,
  TRANSPARENCY_MULTI_TURN_ROUND_OUTCOMES,
  TRANSPARENCY_MULTI_TURN_TERMINATION_REASONS,
  TRANSPARENCY_FIXED_SLOT_VIOLATION_KINDS,
  TRANSPARENCY_STANDING_INSTRUCTION_CONFLICT_KINDS,
  isTransparencyEventKind,
  classForTransparencyEventKind,
  validateTransparencyEvent,
  assertTransparencyEventInvariants,
} from './events.js';
export type {
  TransparencyEvent,
  TransparencyEventKind,
  TransparencyEventClass,
  TransparencyEventValidationKind,
  TransparencyEventValidationIssue,
  TransparencyDriftSeverity,
  TransparencyBridgeStatus,
  TransparencyPrivacyViolationClass,
  TransparencyCostHaltReason,
  TransparencyDecoderUnavailableReason,
  TransparencyDecoderUnavailableSite,
  TransparencyMultiTurnRoundOutcome,
  TransparencyMultiTurnTerminationReason,
  TransparencyFixedSlotViolationKind,
  TransparencyStandingInstructionConflictKind,
} from './events.js';

// Templates — Recued voice slot substitution.
export {
  TRANSPARENCY_TEMPLATES_EN,
  renderTransparencyTemplate,
  assertTransparencyTemplatesComplete,
} from './templates.js';

// Redaction — per-event tier + envelope shape.
export {
  TRANSPARENCY_REDACTION_TIERS,
  TRANSPARENCY_REDACTION_TIER_SET,
  TRANSPARENCY_REDACTION_TIER_PRIORITY,
  TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND,
  defaultRedactionForKind,
  assertTransparencyRedactionInvariants,
} from './redaction.js';
export type {
  TransparencyRedactionTier,
  TransparencyEventEnvelope,
} from './redaction.js';

// Settings — visibility filter + builder helpers.
export {
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  applyVisibilityPolicy,
  transparencyStreamSettingsFromPrefs,
  withVisibleClasses,
  withEnabled,
  withMaxRedactionTier,
  withHiddenNetworkDomain,
  assertTransparencySettingsInvariants,
} from './settings.js';
export type {
  TransparencyStreamSettings,
  TransparencyClassVisibility,
  TransparencyMaxRedactionTier,
} from './settings.js';

// Audit — D-120 emission shape + builder.
export {
  TRANSPARENCY_AUDIT_SOURCES,
  TRANSPARENCY_AUDIT_SOURCE_SET,
  TRANSPARENCY_STREAM_AUDIT_ACTION,
  buildTransparencyAuditDetail,
  assertTransparencyAuditInvariants,
} from './audit.js';
export type {
  TransparencyAuditDetail,
  TransparencyAuditSource,
  TransparencyStreamAuditAction,
} from './audit.js';
