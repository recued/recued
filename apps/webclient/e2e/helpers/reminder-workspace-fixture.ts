import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { defaultQuietHoursPolicy, type ReminderListRequest, type ReminderState, type ReminderTriageApplyRequest } from '@recued/contracts';
import { createReminderStore } from '../../../../backend/server/src/storage/reminder-store.js';
import { createReminderDispatchers } from '../../../../backend/server/src/reminders/reminder-service.js';
import { makeReminderHandlers } from '../../../../backend/server/src/reminders/reminder-rpc-handler.js';

export const REMINDER_WORKSPACE_NOW = Date.parse('2026-11-01T15:00:00Z');
export const REMINDER_WORKSPACE_ZONE = 'America/New_York';

/** Real owner RPC handlers and SQLite; only transport timing is controlled. */
export const installReminderWorkspaceFixture = async (page: Page, empty = false) => {
  const db = new Database(':memory:'), store = createReminderStore(db);
  const now = REMINDER_WORKSPACE_NOW;
  let clock = now, zone = REMINDER_WORKSPACE_ZONE;
  const service = createReminderDispatchers({ store, now: () => clock, timeZone: () => zone,
    quietHours: () => ({ ...defaultQuietHoursPolicy(), enabled: true, from_minute: 22 * 60, to_minute: 7 * 60 }) });
  const handlers = makeReminderHandlers({ dispatchers: service })!.handlers;
  const client = { instance_id: 'reminders-browser', client_kind: 'webclient' } as never;
  if (!empty) {
    for (let index = 0; index < 10; index++) store.create({ text: 'Manual follow up ' + index,
      at: now + 3_600_000 + index * 60_000, time_zone: zone, origin: {} }, now);
    for (let index = 0; index < 225; index++) store.ensureClock({ text: 'Meter check ' + index,
      at: now + (index + 1) * 3_600_000, time_zone: zone, origin: {},
      clock: { occurrence_id: 'occ-' + index, point_key: 'point-' + index, ask_id: 'ask-' + index } }, now);
  }
  const triageWrites: ReminderTriageApplyRequest[] = [];
  let loseTriage = false, holdTriage = false, releaseTriage: (() => void) | undefined;
  let holdTriageReview = false, releaseTriageReview: (() => void) | undefined;
  const reads: ReminderListRequest[] = [];
  const readReplies: ReminderListRequest[] = [];
  let legacySearch = false;
  const detailReads: string[] = [];
  const detailReplies: string[] = [];
  let failDetail = false, holdDetail: string | null = null;
  let releaseDetail: (() => void) | undefined;
  const creates: { text: string; at: number; creation_id: string }[] = [];
  let loseCreate = false, failRead = false, holdQuery: string | null = null;
  let latestCreated: string | undefined;
  let holdCreate = false, releaseCreate: (() => void) | undefined;
  let release: (() => void) | undefined;
  await page.exposeFunction('__reminderWorkspaceRpc', async (method: string, raw: never) => {
    try {
      if (method === 'server.timezone.get') return { result: { resolved_zone: zone } };
      if (method === 'reminder.list') {
        const args = raw as ReminderListRequest;
        reads.push(structuredClone(args));
        if (failRead) { failRead = false; return { error: { code: 'unavailable', message: 'The reminder refresh was interrupted.' } }; }
        const result = await handlers['reminder.list'](legacySearch && args.page?.state !== undefined
          ? { ...args, page: { ...args.page, state: undefined } } : args, client);
        if (holdQuery !== null && args.page?.query === holdQuery) {
          holdQuery = null;
          await new Promise<void>(done => { release = done; });
        }
        readReplies.push(structuredClone(args));
        return { result };
      }
      if (method === 'reminder.get') {
        const args = raw as { reminder_id: string };
        detailReads.push(args.reminder_id);
        if (failDetail) { failDetail = false; return { error: { code: 'unavailable', message: 'The reminder detail read was interrupted.' } }; }
        const result = await handlers['reminder.get'](args, client);
        if (holdDetail === args.reminder_id) {
          holdDetail = null;
          await new Promise<void>(done => { releaseDetail = done; });
        }
        detailReplies.push(args.reminder_id);
        return { result };
      }
      if (method === 'reminder.create') {
        creates.push(structuredClone(raw));
        const result = await handlers['reminder.create'](raw, client);
        latestCreated = result.reminder.reminder_id;
        if (holdCreate) {
          holdCreate = false;
          await new Promise<void>(done => { releaseCreate = done; });
        }
        if (loseCreate) { loseCreate = false; return { error: { code: 'timeout', message: 'The creation reply was lost.' } }; }
        return { result };
      }
      if (method === 'reminder.triage.preview') {
        const result = await handlers['reminder.triage.preview'](raw, client);
        if (holdTriageReview) { holdTriageReview = false; await new Promise<void>(done => { releaseTriageReview = done; }); }
        return { result };
      }
      if (method === 'reminder.triage.apply') {
        triageWrites.push(structuredClone(raw));
        const result = await handlers['reminder.triage.apply'](raw, client);
        if (holdTriage) { holdTriage = false; await new Promise<void>(done => { releaseTriage = done; }); }
        if (loseTriage) { loseTriage = false; return { error: { code: 'timeout', message: 'The reminder change reply was lost.' } }; }
        return { result };
      }
      if (method === 'reminder.update') return { result: await handlers['reminder.update'](raw, client) };
      if (method === 'reminder.cancel') return { result: await handlers['reminder.cancel'](raw, client) };
      return undefined;
    } catch (error) {
      return { error: { code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unavailable',
        message: error instanceof Error ? error.message : String(error) } };
    }
  });
  await page.addInitScript(() => {
    Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
      ['server.timezone.get', 'reminder.list', 'reminder.get', 'reminder.create', 'reminder.update', 'reminder.cancel', 'reminder.triage.preview', 'reminder.triage.apply'].includes(method)
        ? (window as unknown as { __reminderWorkspaceRpc(method: string, args: unknown): Promise<unknown> }).__reminderWorkspaceRpc(method, args)
        : Promise.resolve(undefined) });
  });
  return { reads, readReplies, detailReads, detailReplies, creates, triageWrites,
    holdNextTriageReview: () => { holdTriageReview = true; },
    triageReviewPending: () => releaseTriageReview !== undefined,
    releaseTriageReview: () => { if (!releaseTriageReview) throw new Error('No triage review is waiting.'); const done = releaseTriageReview; releaseTriageReview = undefined; done(); },
    loseNextTriageReply: () => { loseTriage = true; },
    holdNextTriageReply: () => { holdTriage = true; },
    triagePending: () => releaseTriage !== undefined,
    releaseTriage: () => { if (!releaseTriage) throw new Error('No triage reply is waiting.'); const done = releaseTriage; releaseTriage = undefined; done(); },
    failTriageFor: (id: string) => {
      db.exec(`CREATE TRIGGER refuse_triage BEFORE UPDATE ON reminders WHEN OLD.reminder_id='${id.replaceAll("'", "''")}' BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
    },
    allowTriage: () => { db.exec('DROP TRIGGER IF EXISTS refuse_triage'); },
    edit: (id: string, text: string) => store.update(id, { text }, clock),
    setLegacySearch: (value: boolean) => { legacySearch = value; },
    seed: (input: { text: string; at?: number; state?: ReminderState; managed?: boolean; finishedAt?: number; timeZone?: string }) => {
      const managedClock = input.managed ? { occurrence_id: 'occ-detail-' + input.text, point_key: 'point', ask_id: 'ask-detail-' + input.text } : undefined;
      const row = managedClock ? store.ensureClock({ text: input.text, at: input.at ?? now + 3_600_000, time_zone: input.timeZone ?? zone, origin: {}, clock: managedClock }, now)
        : store.create({ text: input.text, at: input.at ?? now + 3_600_000, time_zone: input.timeZone ?? zone, origin: {} }, now);
      if (input.state === 'delivered') store.markDelivered(row.reminder_id, input.finishedAt ?? now, ['in_app']);
      if (input.state === 'cancelled') store.cancel(row.reminder_id, input.finishedAt ?? now);
      return row.reminder_id;
    },
    get: (id: string) => store.get(id),
    deliver: (id: string) => store.markDelivered(id, clock, ['in_app']),
    setNow: (at: number) => { clock = at; },
    setZone: (value: string) => { zone = value; },
    createdId: () => latestCreated,
    failNextDetailRead: () => { failDetail = true; },
    holdNextDetailRead: (id: string) => { holdDetail = id; },
    detailReadPending: () => releaseDetail !== undefined,
    releaseDetailRead: () => { if (!releaseDetail) throw new Error('No detail read is waiting.'); const done = releaseDetail; releaseDetail = undefined; done(); },
    pendingCount: () => store.countPending(),
    loseNextCreate: () => { loseCreate = true; },
    holdNextCreate: () => { holdCreate = true; },
    createPending: () => releaseCreate !== undefined,
    releaseCreate: () => { if (!releaseCreate) throw new Error('No creation reply is waiting.'); const done = releaseCreate; releaseCreate = undefined; done(); },
    cancelLatestCreated: async () => {
      if (!latestCreated) throw new Error('No reminder has been created.');
      await handlers['reminder.cancel']({ reminder_id: latestCreated }, client);
    },
    failNextRead: () => { failRead = true; },
    holdNextQuery: (query: string) => { holdQuery = query; },
    readPending: () => release !== undefined,
    releaseRead: () => { if (!release) throw new Error('No reminder read is waiting.'); const done = release; release = undefined; done(); },
    dispose: () => { releaseTriageReview?.(); releaseTriage?.(); release?.(); releaseCreate?.(); releaseDetail?.(); db.close(); },
  };
};
