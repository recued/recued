/** D-315 §6.4 — the trigger → run link.
 *
 *  The mail-facts list shows, per fact, each recipe its events started, with the
 *  outcome, and opens the run. The one place a triggering record's id was
 *  written — the dispatcher's `trigger_fired` entry — carried no run id and was
 *  written on a clean success only, so a failed or held run was invisible. It
 *  now names the run and is written for every run a fire started. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { ActivityEntry } from '@recued/storage';

import type { MailFactTypeId, MailTemplateDefinition } from '@recued/contracts';

import { createMailFactWriter } from '../mail-facts/fact-writer.js';
import { mailFactRunLinkOf } from '../mail-facts/run-link.js';
import { linkMailFactRuns } from '../mail-facts/screens-wiring.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';
import { createEventTriggersStore } from '../triggers/store.js';
import { createEventTriggerDispatcher, type TriggerFire } from '../triggers/dispatcher.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

const flush = (): Promise<void> => new Promise((r) => { setImmediate(r); });

const mk = (runRecipe: ReturnType<typeof vi.fn>, onFired?: (fire: TriggerFire) => void) => {
  const store = createEventTriggersStore(db);
  const bus = createWarehouseEventBus();
  const activities: ActivityEntry[] = [];
  store.create({
    trigger_id: 't-1', recipe_id: 'r-1', publisher_id: 'local',
    pattern: 'data.mail_fact.shipment.thing.*', enabled: true, created_at: 1_000,
  } as never);
  const dispatcher = createEventTriggerDispatcher({
    bus,
    store,
    runtime: { runRecipe },
    now: () => 10_000,
    auditLog: { logActivity: async (entry: ActivityEntry) => { activities.push(entry); } },
    ...(onFired ? { onFired } : {}),
  } as never);
  dispatcher.rebuild();
  const event = {
    platform: 'mail_fact', slug: 'shipment', entity_type: 'thing',
    event_kind: 'updated', record_id: 'mthing_1', at: 9_500,
    record: { thing_id: 'mthing_1', fact: { fact_id: 'mfact_1', email: { slug: 'work', record_id: 'mail:abc' } } },
  } as never;
  const fire = async (extra: Record<string, unknown> = {}): Promise<void> => {
    bus.emit({
      platform: 'mail_fact', slug: 'shipment', entity_type: 'thing',
      event_kind: 'updated', record_id: 'mthing_1', at: 9_500,
      record: { thing_id: 'mthing_1', fact: { fact_id: 'mfact_1', email: { slug: 'work', record_id: 'mail:abc' } } },
      ...extra,
    } as never);
    await flush();
  };
  const fired = (): Partial<ActivityEntry>[] =>
    activities
      .filter((a) => a.action === 'trigger_fired')
      .map(({ target, detail, run_id, recipe_id }) => ({ target, detail, run_id, recipe_id }));
  return { fire, fired, store, dispatcher, event };
};

const coded = (code: string, run_id?: string): Error =>
  Object.assign(new Error('no'), { code }, run_id !== undefined ? { run_id } : {});

describe('trigger_fired names the run, for every outcome', () => {
  it('a completed run', async () => {
    const { fire, fired } = mk(vi.fn().mockResolvedValue({ run_id: 'run-1' }));
    await fire();
    expect(fired()).toEqual([{ target: 't-1|mthing_1', detail: 'completed', run_id: 'run-1', recipe_id: 'r-1' }]);
  });

  it('a run held for approval, and one whose own gate declined', async () => {
    const held = mk(vi.fn().mockResolvedValue({ run_id: 'run-2', held: true }));
    await held.fire();
    expect(held.fired()).toMatchObject([{ detail: 'held', run_id: 'run-2' }]);

    db = new Database(':memory:');
    const declined = mk(vi.fn().mockResolvedValue({ run_id: 'run-3', declined: true }));
    await declined.fire();
    expect(declined.fired()).toMatchObject([{ detail: 'declined', run_id: 'run-3' }]);
  });

  it('a failed run — the failure that used to leave no link at all', async () => {
    const { fire, fired, store } = mk(vi.fn().mockRejectedValue(coded('NETWORK_ERROR', 'run-4')));
    await fire();
    expect(fired()).toEqual([{ target: 't-1|mthing_1', detail: 'failed', run_id: 'run-4', recipe_id: 'r-1' }]);
    expect(store.get('t-1')!.last_error).toBe('no');
  });

  it('a tripped guard is declined, not failed', async () => {
    const { fire, fired } = mk(vi.fn().mockRejectedValue(coded('RECIPE_GUARD_TRIGGERED', 'run-5')));
    await fire();
    expect(fired()).toMatchObject([{ detail: 'declined', run_id: 'run-5' }]);
  });

  it('a run that refused every item', async () => {
    const { fire, fired } = mk(vi.fn().mockResolvedValue({ total_refusal: true, run_id: 'run-6' }));
    await fire();
    expect(fired()).toMatchObject([{ detail: 'total_refusal', run_id: 'run-6' }]);
  });

  it('a failure before any run existed is still written, without a run', async () => {
    const { fire, fired } = mk(vi.fn().mockRejectedValue(coded('RECIPE_NOT_FOUND')));
    await fire();
    expect(fired()).toEqual([{ target: 't-1|mthing_1', detail: 'failed', run_id: undefined, recipe_id: 'r-1' }]);
  });

  it('a skipped fire started no run and writes nothing', async () => {
    const { fire, fired } = mk(vi.fn().mockResolvedValue({ skipped: true }));
    await fire();
    expect(fired()).toEqual([]);
  });
});

describe('the fire observer the facts list links runs through (§6.4)', () => {
  it('is told what trigger_fired records, for a run and for a failure before any run', async () => {
    const seen: TriggerFire[] = [];
    const ok = mk(vi.fn().mockResolvedValue({ run_id: 'run-1' }), (fire) => seen.push(fire));
    await ok.fire();
    db = new Database(':memory:');
    const failed = mk(vi.fn().mockRejectedValue(coded('RECIPE_NOT_FOUND')), (fire) => seen.push(fire));
    await failed.fire();
    expect(seen.map(({ trigger, event, run_id, outcome, at }) => [trigger.trigger_id, event.record_id, run_id, outcome, at]))
      .toEqual([
        ['t-1', 'mthing_1', 'run-1', 'completed', 10_000],
        ['t-1', 'mthing_1', undefined, 'failed', 10_000],
      ]);
  });

  it('is not told of a skipped fire', async () => {
    const seen: TriggerFire[] = [];
    const { fire } = mk(vi.fn().mockResolvedValue({ skipped: true }), (f) => seen.push(f));
    await fire();
    expect(seen).toEqual([]);
  });

  it('never touches the fire when it throws', async () => {
    const { fire, fired, store } = mk(vi.fn().mockResolvedValue({ run_id: 'run-1' }), () => {
      throw new Error('observer broke');
    });
    await fire();
    expect(fired()).toMatchObject([{ detail: 'completed', run_id: 'run-1' }]);
    expect(store.get('t-1')).toMatchObject({ last_error: null, last_fired_at: 10_000 });
  });

  it('links a fact’s run to the email the event’s fact came from, not only the thing', async () => {
    const seen: TriggerFire[] = [];
    const { fire } = mk(vi.fn().mockResolvedValue({ run_id: 'run-1', held: true }), (f) => seen.push(f));
    await fire();
    expect(mailFactRunLinkOf(seen[0]!)).toEqual({
      email: { slug: 'work', record_id: 'mail:abc' },
      thing_id: 'mthing_1',
      trigger_id: 't-1',
      recipe_id: 'r-1',
      run_id: 'run-1',
      outcome: 'held',
      at: 10_000,
    });
  });

  /** A UPS email read with `may_trigger`, and a fire of its event whose run
   *  ends only after what the test does next. */
  const upsRun = (type: MailFactTypeId = 'shipment') => {
    const store = createMailFactStore(db, { now: () => 1_000 });
    const emitted: unknown[] = [];
    const writer = createMailFactWriter({ store, emit: (event) => emitted.push(event), now: () => 1_000 });
    if (type !== 'shipment') {
      store.saveCustomType({
        id: type, name: 'Parcel', description: 'A parcel.',
        variables: [{ name: 'tracking_number', kind: 'id', required: true }],
        states: [], notices: [], identity: [['tracking_number']],
      });
    }
    const template = store.createTemplate({
      definition: {
        name: 'UPS', type,
        entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: ['tracking_number'] },
        rules: [{ target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } }],
        html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const read = (record_id: string): void => {
      writer.write({
        ref: { slug: 'work', record_id },
        email: { subject: 'UPS Update', body_text: 'Tracking Number: 1Z0000000000000001\n', html: null, from_address: 'pkginfo@ups.com',
          from_name: 'UPS', headers: {}, labels: ['INBOX'], relationships: [], attachments: [] },
        email_at: 900, content_fingerprint: 'c', may_trigger: true, count_health: true,
      });
    };
    read('mail:old');
    const fire = { trigger: { trigger_id: 't-1', recipe_id: 'r-1' }, event: emitted[0], run_id: 'run-1', outcome: 'completed', at: 1 } as never as TriggerFire;
    return { store, writer, read, fire, template };
  };

  it('tells the screens a run was linked, so the Facts view shows it now', () => {
    const { store, fire } = upsRun();
    const linked = vi.fn();
    linkMailFactRuns(store, linked)(fire);
    expect(store.runsForEmail({ slug: 'work', record_id: 'mail:old' })).toMatchObject([{ run_id: 'run-1' }]);
    expect(linked).toHaveBeenCalledTimes(1);
    // Nothing to link, nothing told.
    linkMailFactRuns(store, linked)({ ...fire, event: { platform: 'mail', record_id: 'x', record: {} } } as never);
    expect(linked).toHaveBeenCalledTimes(1);
  });

  it('links a run that ends after its email moved to the email as it is now', () => {
    const store = createMailFactStore(db, { now: () => 1_000 });
    const emitted: unknown[] = [];
    const writer = createMailFactWriter({ store, emit: (event) => emitted.push(event), now: () => 1_000 });
    const ups: MailTemplateDefinition = {
      name: 'UPS', type: 'shipment',
      entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: ['tracking_number'] },
      rules: [{ target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } }],
      html: false, ai: { enabled: false },
    };
    store.createTemplate({ definition: ups, origin: { kind: 'owner' } });
    writer.write({
      ref: { slug: 'work', record_id: 'mail:old' },
      email: { subject: 'UPS Update', body_text: 'Tracking Number: 1Z0000000000000001\n', html: null, from_address: 'pkginfo@ups.com',
        from_name: 'UPS', headers: {}, labels: ['INBOX'], relationships: [], attachments: [] },
      email_at: 900, content_fingerprint: 'c', may_trigger: true, count_health: true,
    });
    // The fire's snapshot names the email as it was when the run started.
    const fire = { trigger: { trigger_id: 't-1', recipe_id: 'r-1' }, event: emitted[0], run_id: 'run-1', outcome: 'completed', at: 1 } as never as TriggerFire;
    // The email moved while the run went on.
    writer.rekeyEmail('work', 'mail:old', 'mail:new');
    linkMailFactRuns(store)(fire);
    expect(store.runsForEmail({ slug: 'work', record_id: 'mail:new' })).toMatchObject([{ run_id: 'run-1' }]);
    expect(store.runsForEmail({ slug: 'work', record_id: 'mail:old' })).toEqual([]);
  });

  it('links no run to an email deleted while the run went on: nothing names it after', () => {
    const { store, writer, read, fire } = upsRun();
    // Another email about the parcel keeps its thing.
    read('mail:later');
    writer.removeEmails('work', ['mail:old']);
    const linked = vi.fn();
    linkMailFactRuns(store, linked)(fire);
    expect(store.runsForEmail({ slug: 'work', record_id: 'mail:old' })).toEqual([]);
    // Nothing here names the deleted email: no link waits for a sweep.
    expect(store.emailIdsOf('work', null, 10)).toEqual(['mail:later']);
    expect(linked).not.toHaveBeenCalled();
  });

  it('links a run whose email moved onto an id already read to that id, on its fact’s row', () => {
    const { store, writer, read, fire } = upsRun();
    // The sync read the moved copy under its new id first; the move comes after.
    read('mail:new');
    writer.rekeyEmail('work', 'mail:old', 'mail:new');
    linkMailFactRuns(store)(fire);
    const runs = store.runsForEmail({ slug: 'work', record_id: 'mail:new' });
    expect(runs).toMatchObject([{ run_id: 'run-1' }]);
    expect(store.runsForEmail({ slug: 'work', record_id: 'mail:old' })).toEqual([]);
    // The facts list shows it: the new id's fact is of the run's thing.
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:new' }).map((fact) => fact.thing_id)).toEqual([runs[0]!.thing_id]);
  });

  it('follows every move of the email, and none to an email deleted after it moved', () => {
    const { store, writer, read, fire } = upsRun();
    read('mail:mid');
    writer.rekeyEmail('work', 'mail:old', 'mail:mid');
    writer.rekeyEmail('work', 'mail:mid', 'mail:new');
    linkMailFactRuns(store)(fire);
    expect(store.runsForEmail({ slug: 'work', record_id: 'mail:new' })).toMatchObject([{ run_id: 'run-1' }]);

    writer.removeEmails('work', ['mail:new']);
    linkMailFactRuns(store)({ ...fire, run_id: 'run-2' } as TriggerFire);
    expect(store.emailIdsOf('work', null, 10)).toEqual([]);
    // No old id leads to the deleted email.
    expect(store.emailMovedTo({ slug: 'work', record_id: 'mail:old' })).toBeNull();
    expect(store.emailMovedTo({ slug: 'work', record_id: 'mail:mid' })).toBeNull();
  });

  it('keeps no move away from where the email is now: moved back, it is home', () => {
    const { store, writer } = upsRun();
    writer.rekeyEmail('work', 'mail:old', 'mail:new');
    expect(store.emailMovedTo({ slug: 'work', record_id: 'mail:old' })).toEqual({ slug: 'work', record_id: 'mail:new' });
    writer.rekeyEmail('work', 'mail:new', 'mail:old');
    expect(store.emailMovedTo({ slug: 'work', record_id: 'mail:old' })).toBeNull();
    expect(store.emailMovedTo({ slug: 'work', record_id: 'mail:new' })).toEqual({ slug: 'work', record_id: 'mail:old' });
    // A move of an email nothing here knows is not kept.
    writer.rekeyEmail('work', 'mail:other', 'mail:else');
    expect(store.emailMovedTo({ slug: 'work', record_id: 'mail:other' })).toBeNull();
  });

  it('links no run of a kind deleted while it ran: the deletion took its things’ runs', () => {
    const { store, fire, template } = upsRun('custom_parcel');
    store.deleteTemplate(template.template_id);
    store.deleteCustomType('custom_parcel');
    linkMailFactRuns(store)(fire);
    expect(store.runsForEmail({ slug: 'work', record_id: 'mail:old' })).toEqual([]);
  });

  it('links nothing for another platform’s event, or a fact event with no email', () => {
    const fire = (event: object): TriggerFire =>
      ({ trigger: { trigger_id: 't-1', recipe_id: 'r-1' }, event, outcome: 'completed', at: 1 }) as never;
    expect(mailFactRunLinkOf(fire({ platform: 'mail', record_id: 'mail:abc', record: {} }))).toBeNull();
    expect(mailFactRunLinkOf(fire({ platform: 'mail_fact', record_id: 'mthing_1', record: { fact: {} } }))).toBeNull();
  });
});

describe('a backfill’s fire (§6.3)', () => {
  it('reaches the runtime with its origin, so the run is stamped as a backfill; an ordinary fire does not', async () => {
    const runRecipe = vi.fn().mockResolvedValue({ run_id: 'run-1' });
    const { fire } = mk(runRecipe);
    await fire({ origin: 'backfill' });
    expect(runRecipe.mock.calls[0]?.[0]).toMatchObject({ origin: 'backfill' });
    await fire();
    expect(runRecipe).toHaveBeenCalledTimes(2);
    expect(runRecipe.mock.calls[1]?.[0]).not.toHaveProperty('origin');
  });
});

describe('a fire the pre-approval recovery clock runs itself (§6.4)', () => {
  it('goes on the same books as a queued fire: the entry, the observer, the row', async () => {
    const seen: TriggerFire[] = [];
    const runRecipe = vi.fn();
    const { dispatcher, event, fired, store } = mk(runRecipe, (fire) => seen.push(fire));
    const run = vi.fn(async (trigger: unknown) => {
      expect(trigger).toMatchObject({ trigger_id: 't-1', recipe_id: 'r-1' });
      return { run_id: 'run-7', held: true as const };
    });
    await dispatcher.settleFire('t-1', event, run);
    expect(run).toHaveBeenCalledTimes(1);
    // The queue's runtime is not how it ran.
    expect(runRecipe).not.toHaveBeenCalled();
    expect(fired()).toEqual([{ target: 't-1|mthing_1', detail: 'held', run_id: 'run-7', recipe_id: 'r-1' }]);
    expect(mailFactRunLinkOf(seen[0]!)).toMatchObject({ email: { slug: 'work', record_id: 'mail:abc' }, run_id: 'run-7', outcome: 'held' });
    expect(store.get('t-1')).toMatchObject({ last_fired_at: 10_000, last_error: null });
  });

  it('records its failure, and nothing for a run that did not happen', async () => {
    const { dispatcher, event, fired, store } = mk(vi.fn());
    await dispatcher.settleFire('t-1', event, async () => ({ skipped: true as const }));
    expect(fired()).toEqual([]);
    await dispatcher.settleFire('t-1', event, async () => { throw coded('NETWORK_ERROR', 'run-8'); });
    expect(fired()).toEqual([{ target: 't-1|mthing_1', detail: 'failed', run_id: 'run-8', recipe_id: 'r-1' }]);
    expect(store.get('t-1')!.last_error).toBe('no');
  });

  it('still runs for a row that is gone, and keeps no books for it', async () => {
    const { dispatcher, event, fired, store } = mk(vi.fn());
    store.remove('t-1');
    const run = vi.fn(async (trigger: unknown) => {
      expect(trigger).toBeNull();
    });
    await dispatcher.settleFire('t-1', event, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(fired()).toEqual([]);
  });
});
