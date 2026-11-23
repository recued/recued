import type { Page } from '@playwright/test';
import { installTaskReaderFixture } from './task-reader-fixture.js';
import { installCalendarRecoveryFixture } from './calendar-recovery-fixture.js';

/** Both RPC entry points route to real owners, independent of init-script
 * ordering. Each owner keeps its own SQLite database across browser reload. */
export const installTaskCalendarFixture = async (page: Page) => {
  const task = await installTaskReaderFixture(page);
  try {
    const calendar = await installCalendarRecoveryFixture(page, (method, args) =>
      method.startsWith('work_entity.') || method.startsWith('contact.') ? task.rpc(method, args) : undefined);
    task.fixtureCaller((method, args) =>
      method.startsWith('collection.') || method === 'server.timezone.get' ? calendar.rpc(method, args) : undefined);
    return { task, calendar, async dispose() { await calendar.dispose(); task.dispose(); } };
  } catch (error) { task.dispose(); throw error; }
};
