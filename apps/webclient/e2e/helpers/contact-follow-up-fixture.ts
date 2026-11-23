import type { Page } from '@playwright/test';
import type { TimelineEntry, TimelineRequest } from '@recued/contracts';
import { installTaskReaderFixture } from './task-reader-fixture.js';

export const installContactFollowUpFixture = async (page: Page) => {
  const fixture = await installTaskReaderFixture(page), activityReads: TimelineRequest[] = [];
  const now = Date.parse('2026-10-31T18:00:00Z');
  fixture.registerSource('other.task', 'task'); fixture.registerSource('other.note', 'note');
  fixture.fixtureCaller((method, args) => {
    if (method === 'contact.source.list') return { result: { sources: [] } };
    if (method === 'contact.contributions') return { result: { contributions: [] } };
    if (method === 'data.timeline') {
      const request = args as unknown as TimelineRequest; activityReads.push(structuredClone(request));
      const entries: TimelineEntry[] = Array.from({ length: 240 }, (_, index) => ({ ts: now - index * 60_000,
        source: 'annotation', kind: `Contact activity ${index}`, origin_actor: index % 2 ? 'user_self' : 'system', payload: { id: `activity-${index}`, body: `Saved contact context ${index}.` } }));
      const filtered = entries.filter(row => (!request.origin_actors || request.origin_actors.includes(row.origin_actor!))
        && (request.since === undefined || row.ts >= request.since) && (request.until === undefined || row.ts < request.until));
      const before = request.cursor ? JSON.parse(Buffer.from(request.cursor, 'base64url').toString()).last_ts as number : Infinity;
      const available = filtered.filter(row => row.ts < before), rows = available.slice(0, request.limit ?? 50), last = rows.at(-1);
      return { result: { entries: rows, ...(last && rows.length < available.length ? { next_cursor: Buffer.from(JSON.stringify({ v: 'v1', last_ts: last.ts, last_key: `${last.source}:${last.kind}:${(last.payload as { id: string }).id}` })).toString('base64url') } : {}) } };
    }
    if (method === 'yours.today' || method === 'yours.read' || method === 'memory.claims') return { error: { code: 'unknown_method', message: 'No optional history fixture.' } };
    return undefined;
  });
  return { ...fixture, activityReads };
};
