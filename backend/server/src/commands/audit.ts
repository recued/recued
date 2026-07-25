/** `recued-server audit [sub]` — read-only views over the audit log.
 *
 *  Sub-forms:
 *    (no arg)     recent 30 runs, one line each
 *    clear        wipe entries + activities
 *    export       full log as JSON
 *    activities   recent 50 activities
 *    <id>         try as run_id first (full detail), then as
 *                 recipe_id (filtered run list); 1 on no match
 */

import type { AuditLogStore } from '@recued/storage';

export interface AuditCommandDeps {
  auditLog: AuditLogStore;
}

export async function cmdAudit(deps: AuditCommandDeps, sub?: string): Promise<void> {
  const { auditLog } = deps;

  if (sub === 'clear') {
    await auditLog.clearAll();
    console.log('Audit log cleared.');
    return;
  }

  if (sub === 'export') {
    const [entries, activities] = await Promise.all([
      auditLog.exportAll(),
      auditLog.exportActivities(),
    ]);
    console.log(JSON.stringify({ entries, activities }, null, 2));
    return;
  }

  if (sub === 'activities') {
    const activities = await auditLog.listActivities(50);
    if (activities.length === 0) { console.log('No activities.'); return; }
    for (const a of activities) {
      const time = new Date(a.timestamp).toISOString().slice(0, 19);
      console.log(`  ${time}  ${a.action.padEnd(20)}  ${a.target}${a.detail ? `  ${a.detail}` : ''}`);
    }
    return;
  }

  if (sub) {
    // Try as run_id first
    const entry = await auditLog.get(sub);
    if (entry) {
      console.log(JSON.stringify(entry, null, 2));
      return;
    }
    // Then as recipe_id filter
    const byRecipe = await auditLog.listByRecipe(sub, 30);
    if (byRecipe.length > 0) {
      for (const e of byRecipe) {
        const time = new Date(e.started_at).toISOString().slice(0, 19);
        const status = e.commit_status === 'succeeded' ? 'ok' : 'FAIL';
        const src = (e as { trigger_source?: string }).trigger_source ?? 'manual';
        console.log(`  ${e.run_id}  ${time}  ${status.padEnd(4)}  ${String(e.duration_ms).padStart(6)}ms  ${src.padEnd(15)}  ${e.recipe_id}`);
      }
      return;
    }
    console.error(`No audit entries for '${sub}'.`);
    process.exit(1);
  }

  // Default: recent
  const entries = await auditLog.listRecent(30);
  if (entries.length === 0) { console.log('No audit entries.'); return; }
  for (const e of entries) {
    const time = new Date(e.started_at).toISOString().slice(0, 19);
    const status = e.commit_status === 'succeeded' ? 'ok' : 'FAIL';
    const src = (e as { trigger_source?: string }).trigger_source ?? 'manual';
    const inst = ((e as { instance_id?: string }).instance_id ?? '').slice(0, 8);
    console.log(`  ${e.run_id}  ${time}  ${status.padEnd(4)}  ${String(e.duration_ms).padStart(6)}ms  ${src.padEnd(15)}  ${inst.padEnd(8)}  ${e.recipe_id}`);
  }
}
