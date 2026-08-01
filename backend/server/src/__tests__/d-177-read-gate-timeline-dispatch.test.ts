/** D-177 read-gate — END-TO-END wiring proof for the `recued_dataTimeline`
 *  meta-tool. Closes the codex INFO from the resolver slice: the unit tests
 *  prove the pure pieces (the read-grant checker's per-collection grants, the
 *  `handleTimelineRequest` filter, and the checker in isolation), but NONE
 *  proved that the mcp-server timeline DISPATCH actually wires them together.
 *  This drives `_testing.handleToolCall('recued_dataTimeline', …)` with a
 *  `contractOverlay` whose `resolveReadGrantChecker` returns a mail-only fence
 *  and asserts the door is fenced off a `contact:` entity — so removing the
 *  read-grant assignment in the timeline case (or the
 *  `resolveMcpDoorScopeRestrictions` wiring) would fail this test. */

import { describe, expect, it, vi } from 'vitest';
import {
  isReadableCollection,
  parseGrantEntry,
  type TimelineEntry,
} from '@recued/contracts';

import { _testing } from '../mcp-server.js';
import type { GrantEntryResolver } from '../contract-grant-resolve.js';
import { createReadGrantChecker } from '../read-grant-checker.js';

type HandleToolCallDeps = Parameters<typeof _testing.handleToolCall>[1];

const mailEntry = (): TimelineEntry => ({
  ts: 1_000,
  source: 'mail',
  kind: 'record',
  payload: { _id: 'msg-1' },
});

// D-187 slice 5/6 — a door fenced to a collection subset is expressed DIRECTLY as grant
// rows: the listed collections GRANTED, every other GOVERNED collection REVOKED (a
// non-governed collection defers to its own gate).
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

/** Minimal deps that reach the `recued_dataTimeline` case: no
 *  `inboundTokenAuthorize` (skips the per-token gate), no `internalRegistry`
 *  (skips the registry block); `contractOverlay.shouldMeterUse` is false so
 *  `admitMcpDirectDispatch` proceeds without metering; D-187 AMENDMENT —
 *  `resolveReadGrantChecker` supplies the door's read-grant checker (built from the
 *  door's collection grant rows) for the timeline read gate; `loadCollectionRecord`
 *  stands in for the raw-record source. `undefined` grants ⇒ no checker (owner /
 *  older resolver). */
const makeDeps = (
  grantedCollections: readonly string[] | undefined,
  loadCollectionRecord: ReturnType<typeof vi.fn>,
): HandleToolCallDeps =>
  ({
    loadCollectionRecord,
    // D-228 slice 6 — this suite's subject is the READ GATE / dispatch body,
    // which only runs once the tool gate admits. An absent checklist now
    // denies, so the owner principal is declared rather than implied.
    ownerAdmitAll: true,
    contractOverlay: {
      shouldMeterUse: () => false,
      recordUse: () => {},
      isContractLive: () => false,
      ...(grantedCollections !== undefined
        ? {
            resolveReadGrantChecker: () =>
              createReadGrantChecker(collectionFence(grantedCollections), undefined),
          }
        : {}),
    },
  }) as unknown as HandleToolCallDeps;

const parseEntries = (response: unknown): TimelineEntry[] => {
  const text = (response as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  const parsed = JSON.parse(text ?? '{}') as { entries?: TimelineEntry[] };
  return parsed.entries ?? [];
};

describe('D-177 read-gate — recued_dataTimeline dispatch honors the door fence', () => {
  it('a mail-only door is FENCED off a contact: entity (empty feed, loader never called)', async () => {
    const loader = vi.fn(async () => mailEntry());
    const response = await _testing.handleToolCall(
      { name: 'recued_dataTimeline', arguments: { entity_id: 'contact:bob@example.com' } },
      makeDeps(['mail'], loader),
    );
    expect(parseEntries(response)).toEqual([]);
    expect(loader).not.toHaveBeenCalled(); // short-circuit BEFORE any store access
  });

  it('the same mail-only door READS a mail: entity (loader runs, entry surfaces)', async () => {
    const loader = vi.fn(async () => mailEntry());
    const response = await _testing.handleToolCall(
      { name: 'recued_dataTimeline', arguments: { entity_id: 'mail:msg-1' } },
      makeDeps(['mail'], loader),
    );
    expect(loader).toHaveBeenCalledWith('mail', 'msg-1');
    expect(parseEntries(response)).toHaveLength(1);
  });

  it('no resolveReadGrantChecker (owner / older resolver) → admit-all, contact reads', async () => {
    const loader = vi.fn(async () => mailEntry());
    const response = await _testing.handleToolCall(
      { name: 'recued_dataTimeline', arguments: { entity_id: 'contact:bob@example.com' } },
      makeDeps(undefined, loader),
    );
    expect(loader).toHaveBeenCalled(); // no fence ⇒ the read proceeds
  });
});
