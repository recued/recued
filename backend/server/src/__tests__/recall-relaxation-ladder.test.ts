/** The interaction lane's relaxation ladder.
 *
 *  ⛔⛔ WHAT THIS PINS, AND WHY IT IS NOT A UNIT-TEST FORMALITY. Until
 *  2026-09-02 `lexicalScore` returned `null` unless EVERY query term appeared,
 *  so `recall.search` was AND-only. Measured live over the bench corpus, on
 *  queries that ALL contained `Ravenscourt` AND `renewal` — both present in the
 *  target row — the hit rate fell monotonically with query length:
 *  2 terms 1/1 · 3 terms 1/2 · 4 terms 1/5 · **5 terms 0/4**.
 *  Because a longer conversation makes the model write longer queries, recall
 *  got strictly worse exactly where conversation history matters most.
 *
 *  The same defect was already found and fixed on the FTS side — `@recued/fts`'s
 *  `toFtsMatchLadder` records *"`refund policy` hit the right entry, `What is
 *  your refund policy?` returned ZERO"* — and `memory.search` got the substring
 *  analogue. This lane never did. These tests are the ladder's regression fence.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSubDEK } from '@recued/crypto';
import type { ExecutionSource } from '@recued/contracts';

import type { OwnerRecallCorpusScope } from '../chat-recall-scope.js';
import {
  createRecallSearchBackend,
  normalizeRecallQuery,
} from '../chat-recall-search.js';
import {
  CHAT_MESSAGE_RECALL_ELIGIBILITY,
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';

const fixedMaster = (): Uint8Array => new Uint8Array(32).fill(42);
const picker = {
  display_name: 'Self',
  signature: { server_kind: 'recued' as const, version: '1.0.0', instance_id: 'ladder' },
};
const model = { provider: 'test', model_id: 'test/model' };
const ownerSource = (session_id: string): ExecutionSource => ({
  channel: 'chat', actor: 'user_self', chat_session_id: session_id, user_id: 'local',
});
const SCOPE: OwnerRecallCorpusScope = {
  governing_contract_id: 'user_self',
  row_eligibility: CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
  recall_contract_id: null,
};

/** The exact sentence the live bench planted at turn 1. */
const TARGET =
  'We are dropping Ravenscourt from the renewal list. '
  + 'The landlord wants a turnover rent and we will not wear that.';

describe('recall.search relaxation ladder', () => {
  let db: Database.Database;
  let store: ChatStore;
  let backend: ReturnType<typeof createRecallSearchBackend>;

  beforeEach(async () => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    store = createChatStore(db, () => deriveSubDEK(fixedMaster(), 'chat'));
    store.createSession({ id: 's', now: 1_000 });
    await store.appendMessage({
      id: 'target', session_id: 's', role: 'user', content: TARGET,
      target_server: 'self', picker_at_send: picker, model_used: model,
      execution_source: ownerSource('s'), ts: 1_100,
    });
    backend = createRecallSearchBackend(store, { continuation_secret: new Uint8Array(32) });
  });
  afterEach(() => db.close());

  const search = async (q: string) =>
    (await backend.search({ query: normalizeRecallQuery(q), scope: SCOPE })).matches;

  it('still finds the row when every term is present, and calls it exact', async () => {
    const m = await search('Ravenscourt renewal');
    expect(m.map((x) => x.item_id)).toEqual(['target']);
    expect(m[0]?.match).toBe('exact');
  });

  it('THE REGRESSION — extra terms no longer empty the result', async () => {
    // Every one of these was measured returning ZERO on the AND-only lane while
    // containing two terms that are plainly in the row. Table-driven so a future
    // change cannot quietly re-break one length while another keeps passing.
    for (const q of [
      'Ravenscourt renewal round',
      'Ravenscourt renewal decision landed',
      'Ravenscourt renewal round land',
      'Ravenscourt renewal round land decision',
      'Ravenscourt renewal decision outcome landed',
      'Ravenscourt renewal where we landed',
    ]) {
      const m = await search(q);
      expect(m.map((x) => x.item_id), `query: ${q}`).toEqual(['target']);
    }
  });

  it('labels a partial match as loose, never as exact', async () => {
    // ⛔ THE SAFETY HALF. Relaxing WITHOUT saying so trades an empty answer for a
    // confident wrong one. A row admitted on some-terms must announce itself.
    const [m] = await search('Ravenscourt renewal round land decision');
    expect(m?.match).toBe('loose');
  });

  it('drops function words before it drops precision (relaxed before loose)', async () => {
    // `the`/`for`/`of` are stopwords, so removing them leaves a conjunction that
    // still matches — that is `relaxed`, and it must be preferred over `loose`.
    const [m] = await search('the Ravenscourt renewal of the turnover rent');
    expect(m?.match).toBe('relaxed');
  });

  it('a single content term still cannot match everything', async () => {
    // ⛔ `loose` needs >1 content term or it degenerates into "any word matches
    // any row" — the noise mode that makes an index useless. One unrelated word
    // must still return nothing.
    expect(await search('bicycle')).toEqual([]);
  });

  it('ranks exact above relaxed above loose, so relaxation never displaces a real hit',
    async () => {
      await store.appendMessage({
        id: 'decoy', session_id: 's', role: 'user',
        content: 'Ravenscourt badges are ready at reception.',
        target_server: 'self', picker_at_send: picker, model_used: model,
        execution_source: ownerSource('s'), ts: 1_200,
      });
      // `decoy` is NEWER, so under the old score-then-recency ordering it would
      // win any tie. It matches only `ravenscourt`; the target matches more.
      const m = await search('Ravenscourt renewal turnover rent');
      expect(m[0]?.item_id).toBe('target');
      expect(m[0]?.match).toBe('exact');
      expect(m.find((x) => x.item_id === 'decoy')?.match).toBe('loose');
    });
});
