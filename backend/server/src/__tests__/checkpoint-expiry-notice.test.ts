/** An expired approval TELLS the owner.
 *
 *  ⛔ THE ONE OUTCOME THE OWNER COULD NOT INFER FROM AN ABSENCE. The staleness
 *  guard cancels the ask — and the close-broadcast WITHDRAWS the prompt from
 *  every channel — retires the run `'failed'` with `RECIPE_APPROVAL_TIMEOUT`,
 *  and deletes the checkpoint. So the card simply VANISHED from the approvals
 *  list and the run silently did not happen. That is byte-identical, from the
 *  owner's seat, to an ask they answered: in both cases the card is gone. The
 *  work not happening was recorded in the audit trail and surfaced nowhere.
 *
 *  This drives the real sweep through the real composer — a stale checkpoint
 *  goes in, the guard expires it, and the registered tick is invoked exactly as
 *  `backgroundServices` would invoke it.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import {
  buildAuditEntry,
  createAuditLogStore,
  createCheckpointStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import { composeRetentionPruners } from '../composition/bin/wire-retention-pruners.js';

const NOW = Date.parse('2026-06-10T18:00:00.000Z');
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
/** Comfortably past the window, so the fixture cannot pass on a boundary. */
const LONG_AGO = NOW - (WINDOW_DAYS + 5) * DAY_MS;

const checkpoint = (id: string): Checkpoint => ({
  checkpoint_id: `cp-${id}`,
  run_id: `run-${id}`,
  recipe_id: 'nightly-digest',
  gated_step_id: 'notify',
  step_state: {},
  created_at: LONG_AGO,
});

const anchor = (id: string): AuditEntry => buildAuditEntry({
  recipe_id: 'nightly-digest',
  recipe_hash: 'hash-1',
  commit_status: 'awaiting_approval',
  duration_ms: 50,
  errors: [],
  config_snapshot: {},
  trigger_url: null,
  trigger_source: 'manual',
  instance_id: 'server-1',
  run_id: `run-${id}`,
  now: LONG_AGO,
  checkpoint_id: `cp-${id}`,
  ask_id: `ask-${id}`,
});

/** Compose the real pruners and hand back the tick the registry captured. */
const drive = async (ids: string[], opts: { staleAfterDays?: number } = {}) => {
  const checkpointStore = createCheckpointStore(
    createInMemoryCollection<Checkpoint>(),
  );
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );
  for (const id of ids) {
    await checkpointStore.write(checkpoint(id));
    await auditLog.append(anchor(id));
  }

  const notify = vi.fn().mockResolvedValue(undefined);
  const ticks = new Map<string, () => Promise<void>>();

  composeRetentionPruners({
    backgroundServices: {
      registerInterval: (reg: { name: string; tick: () => Promise<void> }) => {
        ticks.set(reg.name, reg.tick);
      },
    },
    runtimeConfig: {
      get: (key: string) => {
        if (key === 'preflight.stale_after_days') {
          return opts.staleAfterDays ?? WINDOW_DAYS;
        }
        throw new Error(`unexpected key ${key}`);
      },
    },
    checkpointStore,
    auditLog,
    notificationBlock: {
      getAsk: vi.fn().mockResolvedValue({ status: 'open', handler_payload: {} }),
      cancelAsk: vi.fn().mockResolvedValue('cancelled'),
      pruneHandledAsks: vi.fn().mockResolvedValue(0),
      notify,
    },
    now: () => NOW,
  } as never);

  const tick = ticks.get('checkpoint-stale-prune');
  expect(tick, 'the stale-prune interval must be registered').toBeDefined();
  await tick!();
  return { notify, checkpointStore, auditLog };
};

describe('the staleness guard tells the owner', () => {
  it('one expired approval → one notification naming what happened', async () => {
    const { notify, checkpointStore, auditLog } = await drive(['a']);

    // The expiry really happened — otherwise the notification assertion below
    // would be asserting against a sweep that did nothing.
    expect(await checkpointStore.get('cp-a')).toBeNull();
    const retired = await auditLog.get('run-a');
    expect(retired?.commit_status).toBe('failed');
    expect(retired?.errors?.[0]?.code).toBe('RECIPE_APPROVAL_TIMEOUT');

    expect(notify).toHaveBeenCalledTimes(1);
    const msg = notify.mock.calls[0]![0] as { title: string; text: string };
    expect(msg.title).toBe('1 approval expired');
    // It must say the RUN did not complete — "your approval expired" alone
    // leaves the owner to guess whether the work happened anyway.
    expect(msg.text).toContain('did not complete');
    // …and what to do about it, since the expiry is not reversible.
    expect(msg.text).toContain('Re-run the recipe');
    // …and where the window lives, because the fix may be "stop reaping mine".
    expect(msg.text).toContain('staleness window');
  });

  it('⛔ FOURTEEN expired → ONE notification, not fourteen', async () => {
    // A sweep that finds a backlog must not fire once per row. That is the
    // shape that makes people mute the channel the approvals themselves
    // arrive on — losing far more than this notice was worth.
    const { notify } = await drive(['a', 'b', 'c', 'd', 'e']);

    expect(notify).toHaveBeenCalledTimes(1);
    const msg = notify.mock.calls[0]![0] as { title: string; text: string };
    expect(msg.title).toBe('5 approvals expired');
    expect(msg.text).toContain('5 pending approvals');
    // Plural agreement, because "5 approval was withdrawn" reads as a bug in
    // the thing reporting the bug.
    expect(msg.text).toContain('were withdrawn');
    expect(msg.text).toContain('their runs');
  });

  it('⚠ CONTROL — a quiet sweep says NOTHING', async () => {
    // Without this, "notifies on expiry" is unfalsifiable: a wiring that
    // notified on EVERY tick would pass both tests above and would ping the
    // owner hourly, forever, about nothing.
    const { notify } = await drive([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('⚠ CONTROL — nothing expires (and nothing is said) when the guard is OFF', async () => {
    // `preflight.stale_after_days: 0` disables the guard; the same stale rows
    // must survive AND stay silent. This separates "the notice follows the
    // expiry" from "the notice follows the sweep running".
    const { notify, checkpointStore } = await drive(['a'], { staleAfterDays: 0 });
    expect(await checkpointStore.get('cp-a')).not.toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });
});
