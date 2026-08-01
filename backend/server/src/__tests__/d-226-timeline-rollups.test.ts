/** D-226 — rollups on `data.timeline`.
 *
 *  Two properties matter more than the plumbing:
 *
 *  ⛔ A rollup is NOT an entry. The feed is a chronology; a rollup is a standing
 *  aggregate with no event time. If it were pushed into `entries` it would
 *  either claim a moment it did not happen at, or sort as permanently the
 *  newest thing in the feed.
 *
 *  ⛔ It must sit BEHIND the same grant fence as the feed. The aggregate is
 *  derived from the same records the entries come from, so a caller refused the
 *  timeline must not read the numbers through a side door. */
import { describe, expect, it } from 'vitest';
import { handleTimelineRequest, type TimelineDeps } from '../mcp/timeline.js';
import { handleDataTimeline } from '../timeline-rpc-handler.js';
import type { TimelineRollup } from '@recued/contracts';

const ROLLUPS: TimelineRollup[] = [
  {
    publisher: 'recued-core', pack_slug: 'billable-hours', label: 'Unbilled time',
    value: { unbilled_minutes: 135, entry_count: 3, last_task: 'ENG-502' }, complete: true,
  },
  {
    publisher: 'recued-core', pack_slug: 'job-status-board', label: 'Open jobs',
    value: { job_count: 2 }, complete: false, incomplete_reason: 'more than 100 job rows reach this root',
  },
];

/** Deps with no feed sources wired: every entry source skips, so the response
 *  is entries:[] and the rollup behaviour is isolated from the merge. */
const depsWith = (
  rollupsForEntity?: TimelineDeps['rollupsForEntity'],
  extra: Partial<TimelineDeps> = {},
): TimelineDeps => ({ ...(rollupsForEntity ? { rollupsForEntity } : {}), ...extra });

const ask = (deps: TimelineDeps, entity_id = 'contact:bob@acme.test', rest = {}) =>
  handleTimelineRequest(deps, { entity_id, ...rest });

describe('rollups ride alongside the chronology', () => {
  it('attaches every pack that declares onto the identity', async () => {
    const res = await ask(depsWith(() => ROLLUPS));
    expect(res.rollups).toEqual(ROLLUPS);
  });

  it('⛔ never enters `entries` — a standing aggregate has no place in a feed', async () => {
    const res = await ask(depsWith(() => ROLLUPS));
    expect(res.entries).toEqual([]);
    // and nothing in the feed carries a rollup's shape
    expect(JSON.stringify(res.entries)).not.toContain('unbilled_minutes');
  });

  it('carries completeness through, so a bounded walk stays visible to the AI', async () => {
    const res = await ask(depsWith(() => ROLLUPS));
    expect(res.rollups![0]!.complete).toBe(true);
    expect(res.rollups![1]!.complete).toBe(false);
    expect(res.rollups![1]!.incomplete_reason).toMatch(/more than/);
  });

  it('is ABSENT (not empty) when no loader is wired — a file has no rollup surface', async () => {
    const res = await ask(depsWith(undefined));
    expect(res.rollups).toBeUndefined();
    expect('rollups' in res).toBe(false);
  });

  it('is an EMPTY array when the loader runs and nothing declares onto the identity', async () => {
    // Distinguishable from the line above on purpose: "no pack has anything to
    // say about Bob" is a different answer from "this surface does not apply".
    const res = await ask(depsWith(() => []));
    expect(res.rollups).toEqual([]);
  });

  it('passes the parsed id, not the raw entity_id', async () => {
    const seen: string[] = [];
    await ask(depsWith((collection, id) => { seen.push(`${collection}|${id}`); return []; }));
    expect(seen).toEqual(['contact|bob@acme.test']);
  });

  it('⚠ is NOT clipped by the page window — since/until/limit bound the CHRONOLOGY', async () => {
    // Clipping would answer "what have I not billed Bob for" with "…in the last
    // 30 days" — a different question wearing the same words.
    const res = await ask(depsWith(() => ROLLUPS), 'contact:bob@acme.test',
      { since: 1, until: 2, limit: 1 });
    expect(res.rollups).toEqual(ROLLUPS);
  });
});

describe('⛔ the grant fence covers rollups too', () => {
  /** A checker that refuses the collection read, exactly as a door without the
   *  contact grant would. */
  const refusing: TimelineDeps['readGrantChecker'] = {
    isVerbOpGranted: () => true,
    isCollectionReadGranted: () => false,
    isTopicReadGranted: () => false,
  } as unknown as TimelineDeps['readGrantChecker'];

  const permitting: TimelineDeps['readGrantChecker'] = {
    isVerbOpGranted: () => true,
    isCollectionReadGranted: () => true,
    isTopicReadGranted: () => true,
  } as unknown as TimelineDeps['readGrantChecker'];

  it('a caller refused the feed gets NO rollups — not the aggregate as a consolation', async () => {
    let called = false;
    const res = await ask(depsWith(() => { called = true; return ROLLUPS; },
      { readGrantChecker: refusing, gateMcpPrivate: true }));
    expect(res.rollups).toBeUndefined();
    expect(res.entries).toEqual([]);
    // ⛔ and the loader must not even RUN — refusing after computing would still
    // have walked the user's pack rows on behalf of a caller with no grant.
    expect(called, 'the rollup loader ran for a refused caller').toBe(false);
  });

  it('a caller granted the feed gets them', async () => {
    const res = await ask(depsWith(() => ROLLUPS,
      { readGrantChecker: permitting, gateMcpPrivate: true }));
    expect(res.rollups).toEqual(ROLLUPS);
  });
});

/** ⚠ The rpc handler PROJECTS named fields onto the wire, so a field it does
 *  not list simply never leaves the server — the same enumerating-copier shape
 *  that hid `select` from the op digest. This pins the wire, not the query. */
describe('the paired-client wire carries rollups', () => {
  it('reaches the client rather than being dropped by the projection', async () => {
    const res = await handleDataTimeline(
      { timelineDeps: { rollupsForEntity: () => ROLLUPS } },
      { entity_id: 'contact:bob@acme.test' },
    );
    expect(res.rollups).toEqual(ROLLUPS);
  });

  it('omits the field entirely when there is nothing to carry', async () => {
    const res = await handleDataTimeline({ timelineDeps: {} }, { entity_id: 'contact:bob@acme.test' });
    expect('rollups' in res).toBe(false);
  });
});
