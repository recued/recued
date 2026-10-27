/** `recued --mcp` steps aside when the realm's database is needed alone.
 *
 *  ⛔⛔ THIS PROCESS SHARES THE DATABASE WITH THE SERVER, AND NOTHING KNEW. An AI
 *  app such as Claude Desktop starts `recued --mcp`, which opens the realm itself
 *  (`runMcpProfile`) and holds no instance lock and no update lease. So an update
 *  could not see it: the server closed its own connection, found this one's
 *  `-wal` still there, and refused its pre-migration snapshot — every update
 *  that migrates the database failed while the app was open (2026-10-26, found
 *  by audit). Rollbacks and the boot's own repairs assume no other holder too.
 *
 *  The update lease is the one signal all of them share: an apply, a rollback, a
 *  supervisor revert and the server's boot each claim it before they touch the
 *  binary or the database (`update/update-lease.ts`). So this process refuses to
 *  start while it is held, and, once running, closes its database and exits as
 *  soon as another process claims it. The app reconnects by starting it again —
 *  the same as any client after a restart.
 *
 *  ⛔ EXCEPT THE BOOT'S CLAIM (`BOOT_RECONCILE_LEASE_OPERATION`). Every start of a
 *  packaged server holds the lease for its first seconds, through opening the
 *  database, so stepping aside for it would close the AI app's connection on
 *  every restart. It protects nothing either: the one boot step that replaces
 *  the database (finishing an interrupted manual rollback) runs milliseconds
 *  after the claim, long before a once-a-second poll could see it. The boot
 *  opens the database the way this process does.
 *
 *  ⚠ stderr only: stdout is the MCP protocol stream.
 *
 *  Here, not in `cli-context/`: a profile loads only its own context module
 *  there (`bin-router.test.ts`, the profile boundary). */

import { BOOT_RECONCILE_LEASE_OPERATION } from './early-boot-update-lease.js';
import { inspectUpdateLease, type UpdateLeaseHolder } from './update-lease.js';

/** Another live process's claim on the lease, or null. This process's own pid
 *  is never a reason to step aside, nor is a server's boot (above), and no
 *  lease path (a source run) means no install to coordinate with. */
export const mcpLeaseHolder = (
  leasePath: string | null,
  pid: number = process.pid,
  inspect: (leasePath: string) => UpdateLeaseHolder | null = inspectUpdateLease,
): UpdateLeaseHolder | null => {
  if (leasePath === null) return null;
  const holder = inspect(leasePath);
  return holder !== null && holder.pid !== pid && holder.operation !== BOOT_RECONCILE_LEASE_OPERATION
    ? holder : null;
};

export const mcpStartRefusal = (holder: UpdateLeaseHolder): string =>
  '[recued mcp] Recued needs its database to itself right now (it is updating or rolling back: '
  + `${holder.operation}, pid ${holder.pid}), so this connection did not start. `
  + 'Start it again from your AI app in a moment.';

export const mcpStepAsideNotice = (holder: UpdateLeaseHolder): string =>
  '[recued mcp] Recued needs its database to itself (it is updating or rolling back: '
  + `${holder.operation}, pid ${holder.pid}), so this connection closed. `
  + 'Start it again from your AI app in a moment.';

export interface WatchUpdateLeaseOptions {
  leasePath: string | null;
  /** Called once, when another live process holds the lease. */
  onStepAside: (holder: UpdateLeaseHolder) => void;
  pid?: number;
  inspect?: (leasePath: string) => UpdateLeaseHolder | null;
  /** How often the lease file is read. A read is one small file. */
  pollMs?: number;
}

/** Watch the lease and step aside once. Returns a stop function. The timer is
 *  unref'd, so watching never keeps this process alive on its own. */
export const watchUpdateLease = (opts: WatchUpdateLeaseOptions): (() => void) => {
  if (opts.leasePath === null) return () => {};
  let done = false;
  const timer = setInterval(() => {
    if (done) return;
    let holder: UpdateLeaseHolder | null;
    try {
      holder = mcpLeaseHolder(opts.leasePath, opts.pid, opts.inspect);
    } catch {
      return; // an unreadable lease is retried on the next tick
    }
    if (holder === null) return;
    done = true;
    clearInterval(timer);
    opts.onStepAside(holder);
  }, opts.pollMs ?? 1_000);
  timer.unref?.();
  return () => {
    done = true;
    clearInterval(timer);
  };
};
