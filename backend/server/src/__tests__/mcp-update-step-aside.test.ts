/** `recued --mcp` steps aside for the update lease.
 *
 *  ⛔ It opened the realm itself and held no lock, so an update could not see it
 *  and refused its pre-migration snapshot while Claude Desktop was open
 *  (2026-10-26). These pin the two halves: no start while the lease is held, and
 *  one step-aside once another process claims it. */
import { describe, expect, it, vi } from 'vitest';

import {
  mcpLeaseHolder,
  mcpStartRefusal,
  mcpStepAsideNotice,
  watchUpdateLease,
} from '../update/mcp-step-aside.js';
import { BOOT_RECONCILE_LEASE_OPERATION } from '../update/early-boot-update-lease.js';
import type { UpdateLeaseHolder } from '../update/update-lease.js';

const holder = (pid: number, operation = 'apply'): UpdateLeaseHolder =>
  ({ pid, operation, at: 1, token: 't' });

describe('mcpLeaseHolder', () => {
  it('reports another live process holding the lease', () => {
    expect(mcpLeaseHolder('/x/lease', 100, () => holder(200))).toEqual(holder(200));
  });

  it('never steps aside for its own pid, an empty lease, or no install', () => {
    expect(mcpLeaseHolder('/x/lease', 100, () => holder(100))).toBeNull();
    expect(mcpLeaseHolder('/x/lease', 100, () => null)).toBeNull();
    const inspect = vi.fn(() => holder(200));
    expect(mcpLeaseHolder(null, 100, inspect)).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('⛔ never steps aside for a server\'s boot: every packaged start holds the lease for its first seconds', () => {
    expect(BOOT_RECONCILE_LEASE_OPERATION).toBe('boot-reconcile');
    expect(mcpLeaseHolder('/x/lease', 100, () => holder(200, BOOT_RECONCILE_LEASE_OPERATION))).toBeNull();
    // A rollback or a supervisor's revert is not a boot.
    expect(mcpLeaseHolder('/x/lease', 100, () => holder(200, 'rollback'))).toEqual(holder(200, 'rollback'));
  });

  it('says what holds it, on both messages', () => {
    for (const text of [mcpStartRefusal(holder(7, 'rollback')), mcpStepAsideNotice(holder(7, 'rollback'))]) {
      expect(text).toContain('rollback, pid 7');
      expect(text).toContain('Start it again from your AI app');
    }
  });
});

describe('watchUpdateLease', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('steps aside once, when another process claims the lease', async () => {
    let current: UpdateLeaseHolder | null = null;
    const onStepAside = vi.fn();
    const stop = watchUpdateLease({ leasePath: '/x/lease', pid: 100, pollMs: 5, inspect: () => current, onStepAside });
    await wait(30);
    expect(onStepAside).not.toHaveBeenCalled();
    current = holder(200, 'update');
    await wait(30);
    expect(onStepAside).toHaveBeenCalledTimes(1);
    expect(onStepAside).toHaveBeenCalledWith(holder(200, 'update'));
    await wait(30);
    expect(onStepAside).toHaveBeenCalledTimes(1);
    stop();
  });

  it('ignores its own claim and an unreadable lease, and stops when told', async () => {
    const onStepAside = vi.fn();
    let reads = 0;
    const stop = watchUpdateLease({
      leasePath: '/x/lease', pid: 100, pollMs: 5, onStepAside,
      inspect: () => {
        reads += 1;
        if (reads === 1) throw new Error('EACCES');
        return holder(100);
      },
    });
    await wait(30);
    stop();
    const after = reads;
    await wait(30);
    expect(onStepAside).not.toHaveBeenCalled();
    expect(reads).toBe(after);
  });
});
