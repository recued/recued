/** Phase G (D-109) — human-readable labels for every `ActivityAction`.
 *
 *  The Server → Feed UI renders activity rows using this label map so
 *  copy stays consistent across the extension, MCP server logs, and
 *  external tooling (compliance export viewers, CI dashboards).
 *  Keep labels terse (≤ 40 chars) — they read best as a verb phrase
 *  in a chronological feed ("Server booted", "Crash halt toggled").
 *
 *  The set intentionally mirrors `ActivityAction` in
 *  `packages/storage/src/audit.ts`. When a new action lands there,
 *  extend this map; the TypeScript `satisfies` clause ensures the
 *  compiler catches a missing entry. */

// `ActivityAction` lives in `@recued/storage`, not contracts, to avoid
// a cycle. The label keys line up 1:1 with every code in that union;
// a test in `@recued/storage` asserts the pairing at runtime.
type PhaseGActionLabels = {
  // Phase 1 core
  install: string;
  uninstall: string;
  vault_set: string;
  vault_clear: string;
  approval_allow: string;
  approval_deny: string;
  schedule_create: string;
  schedule_update: string;
  schedule_delete: string;
  sync_connect: string;
  sync_disconnect: string;
  sync_push: string;
  sync_pull: string;
  mcp_dispatch: string;
  account_set: string;
  account_clear: string;
  // D-103 Phase A
  shared_write: string;
  shared_delete: string;
  shared_delete_prefix: string;
  pressure_state_change: string;
  crash_halt_toggle: string;
  // D-188 — master "Pause server" engage/release.
  server_pause_toggle: string;
  // D-202 — Switch A/B quality kill-switch engage/release.
  quality_gate_switch_toggle: string;
  account_mismatch_rejected: string;
  quota_exceeded: string;
  tier_limit_exceeded: string;
  // D-104 Phase B
  pressure_eviction_run: string;
  audit_retention_prune: string;
  // D-105 Phase C
  server_boot: string;
  server_shutdown: string;
  server_restart: string;
  server_crashed: string;
  drain_started: string;
  drain_completed: string;
  drain_aborted: string;
  crash_loop_detected: string;
  crash_loop_reset: string;
  lock_conflict: string;
  signal_received: string;
  config_hot_reloaded: string;
  // D-178 — release self-update lifecycle (replayed from the update ledger).
  update_applied: string;
  update_rolled_back: string;
  // D-106 Phase D
  collection_sync_start: string;
  collection_sync_complete: string;
  collection_sync_error: string;
  collection_record_created: string;
  collection_record_updated: string;
  collection_record_deleted: string;
  collection_retention_prune: string;
  file_content_read: string;
  webhook_received: string;
  webhook_rejected_auth: string;
  // D-109 Phase G
  trigger_fired: string;
  trigger_auto_disabled: string;
  // Event-trigger binder — warehouse-event-driven triggers.
  event_trigger_backpressure: string;
  event_trigger_auto_disabled: string;
  archive_export_start: string;
  archive_export_complete: string;
  archive_import_start: string;
  archive_import_complete: string;
  audit_export: string;
  // D-119 Phase 13 — annotation + link warehouse writes.
  annotation_write: string;
  annotation_delete: string;
  link_write: string;
  link_delete: string;
  // D-125 Phase 3.2 — connection adapter dispatch breadcrumbs.
  connection_api: string;
  connection_mcp: string;
  connection_notification: string;
  // D-127 Phase 1.7 — one row per `MailCollection.send` call. Distinct
  // from `connection_notification` so the activity feed surfaces
  // recipe-driven deliverables separately from notification fan-outs.
  mail_send: string;
  // D-145 PB1.5 — capacity_spec walker emission.
  'capacity_check.ok': string;
  'capacity_check.gap': string;
};

/** Public label map. Lookups are `ACTIVITY_LABELS[action]`. Unknown
 *  actions (e.g. from a newer server that added an action this ext
 *  doesn't know yet) fall through to `resolveActivityLabel` below,
 *  which returns the raw string snake_case-to-Title-Case converted. */
export const ACTIVITY_LABELS = {
  install: 'Recipe installed',
  uninstall: 'Recipe uninstalled',
  vault_set: 'Vault key set',
  vault_clear: 'Vault key cleared',
  approval_allow: 'Approval allowed',
  approval_deny: 'Approval denied',
  schedule_create: 'Schedule created',
  schedule_update: 'Schedule updated',
  schedule_delete: 'Schedule deleted',
  sync_connect: 'Sync connected',
  sync_disconnect: 'Sync disconnected',
  sync_push: 'Sync pushed',
  sync_pull: 'Sync pulled',
  mcp_dispatch: 'MCP dispatched',
  account_set: 'Account set',
  account_clear: 'Account cleared',
  shared_write: 'Shared key written',
  shared_delete: 'Shared key deleted',
  shared_delete_prefix: 'Shared prefix deleted',
  pressure_state_change: 'Pressure state changed',
  crash_halt_toggle: 'Crash halt toggled',
  server_pause_toggle: 'Server pause toggled',
  quality_gate_switch_toggle: 'Quality kill-switch toggled',
  account_mismatch_rejected: 'Account mismatch rejected',
  quota_exceeded: 'Quota exceeded',
  tier_limit_exceeded: 'Tier limit reached',
  pressure_eviction_run: 'Pressure reclaim ran',
  audit_retention_prune: 'Audit retention pruned',
  server_boot: 'Server booted',
  server_shutdown: 'Server shut down',
  server_restart: 'Server restarted',
  server_crashed: 'Server crashed',
  drain_started: 'Drain started',
  drain_completed: 'Drain completed',
  drain_aborted: 'Drain aborted',
  crash_loop_detected: 'Crash loop detected',
  crash_loop_reset: 'Crash loop reset',
  lock_conflict: 'Lock conflict',
  signal_received: 'Signal received',
  config_hot_reloaded: 'Config hot-reloaded',
  update_applied: 'Update applied',
  update_rolled_back: 'Update rolled back',
  collection_sync_start: 'Collection sync started',
  collection_sync_complete: 'Collection sync completed',
  collection_sync_error: 'Collection sync errored',
  collection_record_created: 'Record created',
  collection_record_updated: 'Record updated',
  collection_record_deleted: 'Record deleted',
  collection_retention_prune: 'Collection retention pruned',
  file_content_read: 'File content read',
  webhook_received: 'Webhook received',
  webhook_rejected_auth: 'Webhook auth rejected',
  trigger_fired: 'Trigger fired',
  trigger_auto_disabled: 'Trigger auto-disabled',
  event_trigger_backpressure: 'Event trigger dropped (backpressure)',
  event_trigger_auto_disabled: 'Event trigger auto-disabled',
  archive_export_start: 'Archive export started',
  archive_export_complete: 'Archive export completed',
  archive_import_start: 'Archive import started',
  archive_import_complete: 'Archive import completed',
  audit_export: 'Audit exported',
  annotation_write: 'Annotation written',
  annotation_delete: 'Annotation deleted',
  link_write: 'Link written',
  link_delete: 'Link deleted',
  connection_api: 'API connection called',
  connection_mcp: 'MCP connection called',
  connection_notification: 'Notification connection called',
  mail_send: 'Mail sent',
  'capacity_check.ok': 'Capacity check passed',
  'capacity_check.gap': 'Capacity gap detected',
} as const satisfies PhaseGActionLabels;

/** Type helper exposing the key set for renderers that want to
 *  exhaustively check support. */
export type KnownActivityAction = keyof typeof ACTIVITY_LABELS;

/** Resolve an action code to a human label. Falls back to a
 *  snake_case→Title Case transform for unknown codes so a newer server
 *  never renders a blank row. */
export const resolveActivityLabel = (action: string): string => {
  const known = (ACTIVITY_LABELS as Record<string, string>)[action];
  if (known) return known;
  if (!action) return 'Unknown';
  return action
    .split('_')
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
    .join(' ');
};
