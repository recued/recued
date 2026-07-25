/** D-177 read-gating analog — slice 3: the timeline handler is a PURE
 *  filter over the read-grant checker's per-collection grants. The handler
 *  fences the entity's own collection (single-entity timeline) BEFORE any
 *  DB / store access.
 *
 *  DB-free: a `loadCollectionRecord` stub stands in for the raw-record
 *  source, so a fenced read returns EMPTY (and the stub is never called
 *  — proving the fence short-circuits before access), while an admitted
 *  read surfaces the stub's entry. */

import { describe, expect, it, vi } from 'vitest';
import {
  isReadableCollection,
  parseGrantEntry,
  type TimelineEntry,
} from '@recued/contracts';
import { handleTimelineRequest, type TimelineDeps } from '../mcp/timeline.js';
import type { GrantEntryResolver } from '../contract-grant-resolve.js';
import { createReadGrantChecker } from '../read-grant-checker.js';

/** A valid raw-record timeline entry (`source` MUST be a TimelineSource;
 *  `mail` is one). The stub returns it for whatever entity it's asked
 *  about — the test cares about whether the loader RUNS, not the entity
 *  match. */
const mailEntry = (): TimelineEntry => ({
  ts: 1_000,
  source: 'mail',
  kind: 'record',
  payload: { _id: 'msg-1' },
});

// D-187 slice 5/6 — the raw-collection fence is a `data.<collection>` grant lookup via the
// read-grant checker (gated by `gateMcpPrivate`, set by the native MCP tool). A door fenced
// to a subset is expressed DIRECTLY as grant rows: the listed collections GRANTED, every
// other GOVERNED collection REVOKED (a non-governed collection defers to its own gate). The
// grant-row replacement for the retired `scope_restrictions` author-default.
const collectionFence = (granted: readonly string[]): GrantEntryResolver => {
  const allow = new Set(granted);
  return {
    isGranted: (_c, entry, authorDefault) => {
      const parsed = parseGrantEntry(entry);
      if (parsed.kind === 'collection')
        return isReadableCollection(parsed.value) ? allow.has(parsed.value) : authorDefault;
      return authorDefault;
    },
  };
};

// `undefined` grants ⇒ no checker ⇒ the timeline's author-default fallback admits all (the
// owner / stdio path).
const depsWith = (
  loadCollectionRecord: TimelineDeps['loadCollectionRecord'],
  grantedCollections?: readonly string[],
): TimelineDeps => ({
  ...(loadCollectionRecord ? { loadCollectionRecord } : {}),
  gateMcpPrivate: true,
  ...(grantedCollections !== undefined
    ? {
        readGrantChecker: createReadGrantChecker(
          collectionFence(grantedCollections),
          undefined,
        ),
      }
    : {}),
});

describe('D-177 read-gate — timeline handler fences the entity collection', () => {
  it('FENCED collection → empty feed, loader never called (no access)', async () => {
    const loader = vi.fn(async () => mailEntry());
    const res = await handleTimelineRequest(
      // door granted mail only — contact NOT granted (revoked)
      depsWith(loader, ['mail']),
      { entity_id: 'contact:bob@example.com' },
    );
    expect(res.entries).toEqual([]);
    expect(loader).not.toHaveBeenCalled(); // short-circuit BEFORE the loaders
  });

  it('ADMITTED collection → the loader runs + its entry surfaces', async () => {
    const loader = vi.fn(async () => mailEntry());
    const res = await handleTimelineRequest(
      depsWith(loader, ['contact', 'mail']),
      { entity_id: 'mail:msg-1' },
    );
    expect(loader).toHaveBeenCalledWith('mail', 'msg-1');
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]?.source).toBe('mail');
  });

  it('NO checker (owner / stdio path) → no fence, full feed', async () => {
    const loader = vi.fn(async () => mailEntry());
    const res = await handleTimelineRequest(
      depsWith(loader, undefined), // owner — no read-collection fence
      { entity_id: 'mail:msg-1' },
    );
    expect(loader).toHaveBeenCalled();
    expect(res.entries).toHaveLength(1);
  });

  it('NO collections granted (read-nothing door) → every governed entity fenced', async () => {
    // The grant-row way to express "read nothing": no governed collection is granted, so
    // every governed entity is revoked (the author-default is admit-all, narrowed by the
    // explicit revokes the empty allow-set implies).
    const loader = vi.fn(async () => mailEntry());
    const res = await handleTimelineRequest(
      depsWith(loader, []),
      { entity_id: 'mail:msg-1' },
    );
    expect(res.entries).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
  });

  it('a collection OUTSIDE the grant jurisdiction is NOT fenced here', async () => {
    // An enrichment-scope entity is gated by MCP visibility, not this grant; the checker
    // defers a non-`READABLE_COLLECTIONS` key to its own gate (author-default admit), so
    // the handler does not fence it even under a restrictive grant set.
    const loader = vi.fn(async () => mailEntry());
    const res = await handleTimelineRequest(
      depsWith(loader, ['mail']),
      { entity_id: 'connection.api.hubspot.contact:deal_42' },
    );
    // Not short-circuited by the read-collection fence (deferred to its own
    // gate); the loader runs.
    expect(loader).toHaveBeenCalled();
  });
});
