/** D-213 §3.8 — the scoped-join candidate contributor.
 *
 * The unit of join is the RETURNED PIECE. These tests pin the two properties
 * that makes load-bearing: a source is read only UP TO the matched row, and only
 * PII the matched CONTENT contains crosses into the recalling session. */

import { describe, expect, it, vi } from 'vitest';

import {
  createCandidateContributor,
  PII_JOIN_MAX_SOURCE_SESSIONS,
  PII_REHARVEST_MAX_CANDIDATES,
  PII_REHARVEST_MAX_MS,
} from '../chat-pii-candidate-contributor.js';
import type { RecallJoinRef } from '../chat-recall-search-tool.js';
import type {
  ChatPiiSourceHarvest,
  ChatRecallSourceCursor,
  ChatStore,
  RetainedAliasCandidate,
} from '../storage/chat-store.js';

interface SourceRow {
  readonly message_id: string;
  readonly ts: number;
  readonly content: string;
  readonly candidates: readonly RetainedAliasCandidate[];
}

/** A store whose harvest honours the `until` prefix bound, so a test can assert
 *  that rows AFTER the matched one never reach the contributor. */
const storeOver = (
  sessions: Readonly<Record<string, readonly SourceRow[]>>,
  seen?: Array<{ session_id: string; until?: ChatRecallSourceCursor }>,
): ChatStore => ({
  harvestPiiSources: vi.fn(async (input: {
    session_id: string;
    until?: ChatRecallSourceCursor;
  }): Promise<ChatPiiSourceHarvest> => {
    seen?.push({ session_id: input.session_id, until: input.until });
    const all = sessions[input.session_id] ?? [];
    const rows = input.until === undefined
      ? all
      : all.filter((row) =>
        row.ts < input.until!.ts
        || (row.ts === input.until!.ts
          && row.message_id <= input.until!.message_id));
    return {
      session_id: input.session_id,
      content_revision: 1,
      rows: rows.map((row) => ({
        message_id: row.message_id,
        content: row.content,
        candidates: row.candidates,
        source_lifecycle: 'finalized' as const,
      })),
      partial: false,
      decrypted_rows: rows.length,
      decrypted_bytes: 10 * rows.length,
    };
  }),
} as unknown as ChatStore);

const piece = (
  session_id: string,
  message_id: string,
  ts: number,
  content: string,
): RecallJoinRef => ({ session_id, message_id, ts, content });

const values = (
  result: { candidates: readonly { value: string }[] },
): readonly string[] => result.candidates.map((c) => c.value);

describe('D-213 §3.8 — the unit of join is the returned piece', () => {
  it('carries forward only PII the matched content contains', async () => {
    // sessionA knows three people. Recall returned ONE row, which mentions one
    // of them. The other two are sessionA's business and must not cross —
    // this is what stops a value sessionB already disclosed being retroactively
    // aliased by a source that merely happens to know it.
    const store = storeOver({
      current: [],
      A: [
        { message_id: 'a1', ts: 10, content: 'kickoff with Mary Chen', candidates: [{ value: 'Mary Chen', kind: 'name' }] },
        { message_id: 'a2', ts: 20, content: 'ping Zoe Park', candidates: [{ value: 'Zoe Park', kind: 'name' }] },
        { message_id: 'a3', ts: 30, content: 'John Adams owes a reply', candidates: [{ value: 'John Adams', kind: 'name' }] },
      ],
    });

    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store,
    }).contribute({
      joined_pieces: [piece('A', 'a3', 30, 'John Adams owes a reply')],
    });

    expect(values(result)).toEqual(['John Adams']);
    expect(result.joined_source_session_ids).toEqual(['A']);
  });

  it('reads the source only UP TO the matched row', async () => {
    // The prefix is why the read is not a single row: a matched row may mention
    // someone first attested EARLIER. Rows after the match are not the piece.
    const seen: Array<{ session_id: string; until?: ChatRecallSourceCursor }> = [];
    const store = storeOver({
      current: [],
      A: [
        // Attested at a1 as a structured contact; only NAMED at a2.
        { message_id: 'a1', ts: 10, content: 'contact record', candidates: [{ value: 'John Adams', kind: 'name' }] },
        { message_id: 'a2', ts: 20, content: 'John Adams owes a reply', candidates: [] },
        { message_id: 'a3', ts: 30, content: 'later: Zoe Park joined', candidates: [{ value: 'Zoe Park', kind: 'name' }] },
      ],
    }, seen);

    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store,
    }).contribute({
      joined_pieces: [piece('A', 'a2', 20, 'John Adams owes a reply')],
    });

    // Recovered from the PREFIX even though the matched row attested nothing…
    expect(values(result)).toEqual(['John Adams']);
    // …and the row AFTER the match was bounded out at the store.
    expect(seen.find((call) => call.session_id === 'A')?.until)
      .toEqual({ ts: 20, message_id: 'a2' });
  });

  it('reads one prefix per source session, bounded by its LATEST matched row', async () => {
    const seen: Array<{ session_id: string; until?: ChatRecallSourceCursor }> = [];
    const store = storeOver({
      current: [],
      A: [
        { message_id: 'a1', ts: 10, content: 'Mary Chen kickoff', candidates: [{ value: 'Mary Chen', kind: 'name' }] },
        { message_id: 'a2', ts: 20, content: 'John Adams owes a reply', candidates: [{ value: 'John Adams', kind: 'name' }] },
      ],
    }, seen);

    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store,
    }).contribute({
      joined_pieces: [
        piece('A', 'a1', 10, 'Mary Chen kickoff'),
        piece('A', 'a2', 20, 'John Adams owes a reply'),
      ],
    });

    const aCalls = seen.filter((call) => call.session_id === 'A');
    expect(aCalls).toHaveLength(1);
    expect(aCalls[0]?.until).toEqual({ ts: 20, message_id: 'a2' });
    expect([...values(result)].sort()).toEqual(['John Adams', 'Mary Chen']);
  });

  it('always reads the recalling session unscoped — its own material is not a join', async () => {
    const seen: Array<{ session_id: string; until?: ChatRecallSourceCursor }> = [];
    const store = storeOver({
      current: [
        { message_id: 'c1', ts: 5, content: 'my own note', candidates: [{ value: 'Own Person', kind: 'name' }] },
      ],
    }, seen);

    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store,
    }).contribute({ joined_pieces: [] });

    expect(values(result)).toEqual(['Own Person']);
    expect(seen).toEqual([{ session_id: 'current', until: undefined }]);
  });

  it('never re-reads the recalling session as if it were a foreign source', async () => {
    const seen: Array<{ session_id: string; until?: ChatRecallSourceCursor }> = [];
    const store = storeOver({
      current: [
        { message_id: 'c1', ts: 5, content: 'my own note', candidates: [{ value: 'Own Person', kind: 'name' }] },
      ],
    }, seen);

    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store,
    }).contribute({
      // Recall can legitimately return a piece of the CURRENT session.
      joined_pieces: [piece('current', 'c1', 5, 'my own note')],
    });

    expect(seen).toHaveLength(1);
    expect(result.joined_source_session_ids).toEqual([]);
  });

  it('caps distinct source sessions and reports the cut as partial', async () => {
    const sessions: Record<string, readonly SourceRow[]> = { current: [] };
    const pieces: RecallJoinRef[] = [];
    for (let n = 0; n <= PII_JOIN_MAX_SOURCE_SESSIONS; n += 1) {
      const id = `S${n}`;
      sessions[id] = [{
        message_id: 'm1', ts: 10, content: `Person ${n} Lastname`,
        candidates: [{ value: `Person ${n} Lastname`, kind: 'name' }],
      }];
      pieces.push(piece(id, 'm1', 10, `Person ${n} Lastname`));
    }
    const seen: Array<{ session_id: string; until?: ChatRecallSourceCursor }> = [];
    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store: storeOver(sessions, seen),
    }).contribute({ joined_pieces: pieces });

    expect(result.joined_source_session_ids).toHaveLength(
      PII_JOIN_MAX_SOURCE_SESSIONS,
    );
    expect(result.partial).toBe(true);
  });

  it('extracts deterministic identifiers from the prefix, still scoped to the piece', async () => {
    const store = storeOver({
      current: [],
      A: [
        { message_id: 'a1', ts: 10, content: 'ping bob@acme.com and dana@acme.com', candidates: [] },
        { message_id: 'a2', ts: 20, content: 'bob@acme.com never replied', candidates: [] },
      ],
    });

    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store,
    }).contribute({
      joined_pieces: [piece('A', 'a2', 20, 'bob@acme.com never replied')],
    });

    // `dana@` is in the prefix but NOT in the returned piece — it stays in A.
    expect(values(result)).toEqual(['bob@acme.com']);
  });

  it('never admits a BARE POSTCODE as a broad seed, in any locale, while retaining it', async () => {
    // D-167's `addressMatchForms({postal})` returns [] — a postcode alone is
    // never a match form, because `94043` is indistinguishable from an invoice
    // number and `SW1A 1AA` from a warehouse code. Replacing both with one alias
    // asserts a FALSE IDENTITY, which costs more than a miss.
    const postcodes = ['94043', 'SW1A 1AA', 'K1A 0B1', '1012 AB', 'D02 X285'];
    const content = `ship to ${postcodes.join(' / ')} via 1 Main Street, Mountain View, CA 94043`;
    const store = storeOver({
      current: [],
      A: [{
        message_id: 'a1', ts: 10, content,
        candidates: [
          ...postcodes.map((value) => ({ value, kind: 'address' as const })),
          { value: '1 Main Street', kind: 'address' as const },
          { value: 'Mountain View, CA 94043', kind: 'address' as const },
        ],
      }],
    });

    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store,
    }).contribute({ joined_pieces: [piece('A', 'a1', 10, content)] });

    expect(values(result)).toEqual([
      '1 Main Street',
      'Mountain View, CA 94043',
    ]);
  });

  it('gates common single tokens and ambiguous ids out of broad seeding', async () => {
    const content = 'Will and Alice Ada at Gap and Acme Corporation, ids 123456 and CONTACT-77';
    const store = storeOver({
      current: [],
      A: [{
        message_id: 'a1', ts: 10, content,
        candidates: [
          { value: 'Will', kind: 'name' },
          { value: 'Alice Ada', kind: 'name' },
          { value: 'Gap', kind: 'org' },
          { value: 'Acme Corporation', kind: 'org' },
          { value: '123456', kind: 'external_id' },
          { value: 'CONTACT-77', kind: 'external_id' },
        ],
      }],
    });

    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store,
    }).contribute({ joined_pieces: [piece('A', 'a1', 10, content)] });

    expect(values(result)).toEqual([
      'Alice Ada',
      'Acme Corporation',
      'CONTACT-77',
    ]);
  });

  it('reports partial and yields the baseline when a source read exceeds the wall clock', async () => {
    let clock = 0;
    const store = {
      harvestPiiSources: vi.fn(async () => {
        clock += PII_REHARVEST_MAX_MS * 2;
        return {
          session_id: 'A', content_revision: 1, rows: [], partial: false,
          decrypted_rows: 0, decrypted_bytes: 0,
        } satisfies ChatPiiSourceHarvest;
      }),
    } as unknown as ChatStore;

    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store,
      now: () => clock,
    }).contribute({
      joined_pieces: [piece('A', 'a1', 10, 'John Adams owes a reply')],
    });

    expect(result.partial).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it('degrades to the baseline rather than throwing when the store cannot harvest', async () => {
    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store: {} as unknown as ChatStore,
    }).contribute({
      joined_pieces: [piece('A', 'a1', 10, 'John Adams owes a reply')],
    });

    expect(result.partial).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it('caps total candidates and reports the cut', async () => {
    const rows: SourceRow[] = [];
    const names: string[] = [];
    for (let n = 0; n < PII_REHARVEST_MAX_CANDIDATES + 50; n += 1) {
      names.push(`Person${n} Lastname${n}`);
    }
    rows.push({
      message_id: 'a1', ts: 10, content: names.join(', '),
      candidates: names.map((value) => ({ value, kind: 'name' as const })),
    });
    const result = await createCandidateContributor({
      owner_session_id: 'current',
      store: storeOver({ current: [], A: rows }),
    }).contribute({
      joined_pieces: [piece('A', 'a1', 10, names.join(', '))],
    });

    expect(result.partial).toBe(true);
    expect(result.candidates.length).toBeLessThanOrEqual(
      PII_REHARVEST_MAX_CANDIDATES,
    );
  });

  it('ignores a malformed join ref rather than reading an unbounded source', async () => {
    const seen: Array<{ session_id: string; until?: ChatRecallSourceCursor }> = [];
    const store = storeOver({ current: [], A: [] }, seen);
    await createCandidateContributor({
      owner_session_id: 'current',
      store,
    }).contribute({
      joined_pieces: [
        { session_id: 'A', message_id: '', ts: 10, content: 'x' },
        { session_id: '', message_id: 'a1', ts: 10, content: 'x' },
        { session_id: 'A', message_id: 'a1', ts: Number.NaN, content: 'x' },
      ] as readonly RecallJoinRef[],
    });
    // Only the owner session was read; no ref survived validation.
    expect(seen).toEqual([{ session_id: 'current', until: undefined }]);
  });
});
