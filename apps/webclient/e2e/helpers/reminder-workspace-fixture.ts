import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { defaultQuietHoursPolicy, type ReminderListRequest } from '@recued/contracts';
import { createReminderStore } from '../../../../backend/server/src/storage/reminder-store.js';
import { createReminderDispatchers } from '../../../../backend/server/src/reminders/reminder-service.js';
import { makeReminderHandlers } from '../../../../backend/server/src/reminders/reminder-rpc-handler.js';

export const REMINDER_WORKSPACE_NOW = Date.parse('2026-11-01T15:00:00Z');
export const REMINDER_WORKSPACE_ZONE = 'America/New_York';

/** Real owner RPC handlers and SQLite; only transport timing is controlled. */
export const installReminderWorkspaceFixture = async (page: Page, empty = false) => {
  const db = new Database(':memory:'), store = createReminderStore(db);
  const now = REMINDER_WORKSPACE_NOW, zone = REMINDER_WORKSPACE_ZONE;
  const service = createReminderDispatchers({ store, now: () => now, timeZone: () => zone,
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
  const reads: ReminderListRequest[] = [];
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
        const result = await handlers['reminder.list'](args, client);
        if (holdQuery !== null && args.page?.query === holdQuery) {
          holdQuery = null;
          await new Promise<void>(done => { release = done; });
        }
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
      ['server.timezone.get', 'reminder.list', 'reminder.create', 'reminder.update', 'reminder.cancel'].includes(method)
        ? (window as unknown as { __reminderWorkspaceRpc(method: string, args: unknown): Promise<unknown> }).__reminderWorkspaceRpc(method, args)
        : Promise.resolve(undefined) });
  });
  return { reads, creates, pendingCount: () => store.countPending(),
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
    dispose: () => { release?.(); releaseCreate?.(); db.close(); },
  };
};
