import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import { createPreflightAnswerHandler, type PreflightResumer } from '@recued/gateway';
import { createAuditLogStore, createCheckpointStore, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createNoAskRelease } from '../reception-inbox-no-ask-release.js';
import { handleReceptionInboxApprove, handleReceptionInboxList, type ReceptionInboxDeps } from '../reception-inbox-handler.js';
import { sweepAwaitingCheckpoints } from '../preflight-boot-sweep.js';
import { createReceptionInboxSubviewStore } from '../storage/reception-inbox-subview-store.js';

const NOW = 1_700_000_000_000;
const ADMIN = { instance_id: 'owner' };
const checkpoint: Checkpoint = { checkpoint_id: 'held', run_id: 'run', recipe_id: 'booking',
  gated_step_id: 'materialize', created_at: NOW - 1000,
  step_state: { materialize: { input: { title: 'Original title', connection_name: 'calendar-A', payload: { note: 'Original' } } } },
  approved_target: { ingredient_slug: 'calendar', operation_id: 'calendar.create', connection_name: 'calendar-A' },
};
const anchor = (): AuditEntry => ({ run_id: 'run', recipe_id: 'booking', recipe_hash: 'hash',
  started_at: NOW - 1000, finished_at: NOW - 1000, duration_ms: 0, commit_status: 'awaiting_approval',
  checkpoint_id: 'held', config_snapshot: {}, errors: [], trigger_url: null, trigger_source: 'reactive', instance_id: null });

describe('notify-only approval edit isolation', () => {
  let directory: string;
  let db: Database.Database;
  const open = () => {
    db = new Database(join(directory, 'pair.sqlite'));
    const auditLog = createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'runs'), createSQLiteCollection<ActivityEntry>(db, 'activities'));
    const checkpointStore = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
    const resumed: Checkpoint[] = [];
    const resumer: PreflightResumer = { resumeRun: async cp => { resumed.push(structuredClone(cp)); }, denyRun: async () => {} };
    const deps: ReceptionInboxDeps = { auditLog, checkpointStore, subviewStore: createReceptionInboxSubviewStore(db),
      releaseWithoutAsk: createNoAskRelease({ resumer, checkpointStore }),
      resolveArgEditSchema: () => ({ fields: [
        { key: 'title', type: 'string', label: 'Title' },
        { key: 'connection_name', type: 'string', label: 'Calendar', affects_target: true },
        { key: 'payload', type: 'json', label: 'Payload' },
      ] }), isReceptionOrigin: () => true,
      resolveSource: ({ checkpoint: cp }) => ({ top_tier_kind: 'booking', source: { kind: 'scheduling_link', record_ref: 'booking-1' },
        args: (cp.step_state.materialize as { input: Record<string, unknown> }).input,
        preview: { title: 'Booking' }, proposed_action: 'Create booking' }),
      broadcast: () => {}, now: () => NOW,
    };
    return { deps, resumer, resumed };
  };
  const seed = async (env: ReturnType<typeof open>) => {
    await env.deps.auditLog.append(anchor()); await env.deps.checkpointStore.write(checkpoint);
  };
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'notify-approval-sqlite-')); });
  afterEach(() => { if (db?.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it.each(['before_audit_commit', 'after_audit_commit', 'before_dispatch'] as const)(
    'keeps the original hold through %s, SQLite reopen and a recovered plain approval', async phase => {
      let env = open(); await seed(env);
      if (phase === 'before_dispatch') env.resumer.resumeRun = async () => { throw new Error('Controlled approval failure'); };
      else {
        const log = env.deps.auditLog.logActivity.bind(env.deps.auditLog);
        env.deps.auditLog.logActivity = async row => {
          if (String(row.action) === 'reception.inbox.approved') {
            if (phase === 'after_audit_commit') await log(row);
            throw new Error('Controlled approval failure');
          }
          await log(row);
        };
      }
      await expect(handleReceptionInboxApprove(env.deps, { hold_id: 'held', edits: {
        title: 'Failed title', connection_name: 'calendar-B', payload: { note: 'Failed payload' },
      } }, ADMIN)).rejects.toThrow('Controlled approval failure');
      expect(await env.deps.checkpointStore.get('held')).toEqual(checkpoint);
      expect(env.resumed).toEqual([]);
      db.close(); env = open();
      let payload: Record<string, unknown> | undefined;
      expect(await sweepAwaitingCheckpoints({ checkpointStore: env.deps.checkpointStore, auditLog: env.deps.auditLog,
        resolveInboxFanoutMode: () => 'approval', listUnresolvedAsks: async () => [],
        notifier: { registerAskHandler: () => {}, notify: async () => {},
          ask: async (_message, _options, handler) => { payload = handler.payload; return { ask_id: 'recovered' }; } },
      })).toMatchObject({ raised: 1, failed: 0 });
      const shown = (await handleReceptionInboxList(env.deps, undefined, ADMIN)).items[0]!;
      expect(shown.args).toEqual({ title: 'Original title', connection_name: 'calendar-A', payload: { note: 'Original' } });
      expect(payload).toBeDefined();
      await createPreflightAnswerHandler({ checkpointStore: env.deps.checkpointStore, resumer: env.resumer })
        (payload!, { option: 'approve', answered_at: NOW + 1000 });
      expect(env.resumed).toHaveLength(1);
      expect(env.resumed[0]!.arg_overrides).toBeUndefined();
      expect(env.resumed[0]!.approved_target?.connection_name).toBe(shown.args.connection_name);
      expect((env.resumed[0]!.step_state.materialize as { input: unknown }).input).toEqual(shown.args);
      expect(await env.deps.checkpointStore.get('held')).toBeNull();
    },
  );

  it('holds an isolated reviewed payload while audit I/O waits, then consumes the original hold', async () => {
    const env = open(); await seed(env);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const log = env.deps.auditLog.logActivity.bind(env.deps.auditLog);
    env.deps.auditLog.logActivity = async row => { entered(); await gate; await log(row); };
    const edits = { payload: { note: 'Reviewed payload' }, connection_name: 'calendar-B' };
    const approval = handleReceptionInboxApprove(env.deps, { hold_id: 'held', edits }, ADMIN);
    try {
      await waiting;
      expect(await env.deps.checkpointStore.get('held')).toEqual(checkpoint);
      edits.payload.note = 'Changed while audit was pending';
      release();
      expect(await approval).toMatchObject({ released: true });
      expect(env.resumed).toEqual([expect.objectContaining({
        arg_overrides: { payload: { note: 'Reviewed payload' }, connection_name: 'calendar-B' },
        approved_target: expect.objectContaining({ connection_name: 'calendar-B' }),
      })]);
      expect(await env.deps.checkpointStore.get('held')).toBeNull();
    } finally { release(); await Promise.allSettled([approval]); }
  });
});
