/** In-memory schedule store. Production uses IDB via a Collection wrapper. */

import type { Schedule, ScheduleStore } from './types.js';

export const createInMemoryScheduleStore = (): ScheduleStore => {
  const map = new Map<string, Schedule>();

  return {
    async list() { return [...map.values()]; },
    async get(id) { return map.get(id) ?? null; },
    async getByRecipe(recipe_id, publisher_id) {
      for (const s of map.values()) {
        if (s.recipe_id === recipe_id && s.publisher_id === publisher_id) return s;
      }
      return null;
    },
    async set(schedule) { map.set(schedule.schedule_id, schedule); },
    async delete(id) { map.delete(id); },
  };
};
