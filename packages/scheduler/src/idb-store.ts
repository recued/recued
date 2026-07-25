/** IDB-backed schedule store. Wraps a Collection<Schedule> so
 *  schedules survive service worker restarts. */

import type { Schedule, ScheduleStore } from './types.js';

/** Minimal Collection interface — matches @recued/storage's Collection. */
export interface ScheduleCollection {
  get(key: string): Promise<Schedule | null>;
  set(key: string, value: Schedule): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<Schedule[]>;
}

export const createIDBScheduleStore = (collection: ScheduleCollection): ScheduleStore => ({
  async list() {
    return collection.list();
  },

  async get(schedule_id) {
    return collection.get(schedule_id);
  },

  async getByRecipe(recipe_id, publisher_id) {
    const all = await collection.list();
    return all.find(
      (s) => s.recipe_id === recipe_id && s.publisher_id === publisher_id,
    ) ?? null;
  },

  async set(schedule) {
    await collection.set(schedule.schedule_id, schedule);
  },

  async delete(schedule_id) {
    await collection.delete(schedule_id);
  },
});
