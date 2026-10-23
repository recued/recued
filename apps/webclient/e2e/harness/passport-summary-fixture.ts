/** Synthetic export replies for the real backup route. Signing/provider work
 * is covered by server tests; browser tests qualify display and download bytes. */
export const passportSummaryFixture = (mode: string | null, exportedAt: number) => {
  if (!mode || !['healthy', 'attention', 'legacy', 'malformed'].includes(mode)) return undefined;
  const passport = { passport_version: '1', profile: 'support_redacted', exported_at: exportedAt, signature: 'fixture-signature',
    recovery: { backup_status: 'configured', filevault_recovery_key_status: 'absent' } };
  if (mode === 'legacy') return { passport };
  const evidence = { monitoring: 'active', backup_state: mode === 'attention' ? 'due' : 'current', recovery_test_state: 'current',
    integrity: { monitoring: 'active', state: mode === 'attention' ? 'partial' : 'completed' }, watchdog: {
      configured: true, enabled: true, state: mode === 'attention' ? 'blocked' : 'acknowledged',
      drill: { phase: 'completed', current_configuration: mode !== 'attention', owner_reported_alert: true, resumption_ping_acknowledged: true },
    } };
  return { passport: { ...passport, recovery: { ...passport.recovery, backup_evidence: mode === 'malformed'
    ? { ...evidence, backup_state: 'unknown-future-state', watchdog: { ...evidence.watchdog, drill: { ...evidence.watchdog.drill, owner_reported_alert: 'yes' } } }
    : evidence } } };
};
