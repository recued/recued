/** D-213 Track A / A2 — bounded decrypt-and-scan interaction backend. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSubDEK } from '@recued/crypto';
import type { ExecutionSource } from '@recued/contracts';

import type { OwnerRecallCorpusScope } from '../chat-recall-scope.js';
import {
  RECALL_QUERY_MAX_BYTES,
  createRecallSearchBackend,
  normalizeRecallQuery,
} from '../chat-recall-search.js';
import {
  CHAT_MESSAGE_RECALL_ELIGIBILITY,
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';

const fixedMaster = (): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes.fill(42);
  return bytes;
};

const picker = {
  display_name: 'Self',
  signature: {
    server_kind: 'recued' as const,
    version: '1.0.0',
    instance_id: 'd213-a2',
  },
};
const model = { provider: 'test', model_id: 'test/model' };

const ownerSource = (session_id: string): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: session_id,
  user_id: 'local',
});

const messengerSource: ExecutionSource = {
  channel: 'messenger',
  actor: 'user_self',
  vendor: 'slack',
  from: 'coworker',
};

const SCOPE: OwnerRecallCorpusScope = {
  governing_contract_id: 'user_self',
  row_eligibility:
    CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
};

describe('D-213 A2 — interaction decrypt-and-scan', () => {
  let db: Database.Database;
  let store: ChatStore;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    const key = deriveSubDEK(fixedMaster(), 'chat');
    store = createChatStore(db, () => key);
    store.createSession({ id: 'current', now: 1_000 });
    store.createSession({ id: 'prior', now: 1_000 });
  });

  afterEach(() => db.close());

  const append = async (input: {
    id: string;
    session_id?: string;
    role?: 'user' | 'assistant';
    content: string;
    ts: number;
    source?: ExecutionSource;
  }): Promise<void> => {
    const session_id = input.session_id ?? 'prior';
    await store.appendMessage({
      id: input.id,
      session_id,
      role: input.role ?? 'user',
      content: input.content,
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source: input.source ?? ownerSource(session_id),
      ts: input.ts,
    });
  };

  it('recovers NFKC/case/punctuation/whitespace, CJK, and mixed-language facts', async () => {
    await append({
      id: 'latin',
      content: 'ＡＣＭＥ — Project   North launches Friday.',
      ts: 1_100,
    });
    await append({
      id: 'cjk',
      content: 'Please call 東京支社 about invoice 42 tomorrow.',
      ts: 1_200,
    });
    const backend = createRecallSearchBackend(store, {
      continuation_secret: new Uint8Array(32),
    });

    const latin = await backend.search({
      query: normalizeRecallQuery('acme, project north'),
      scope: SCOPE,
    });
    expect(latin.complete).toBe(true);
    expect(latin.matches.map((match) => match.item_id)).toEqual(['latin']);
    expect(latin.matches[0]?.content).toBe(
      'ＡＣＭＥ — Project   North launches Friday.',
    );

    const cjk = await backend.search({
      query: normalizeRecallQuery('東京支社 invoice'),
      scope: SCOPE,
    });
    expect(cjk.complete).toBe(true);
    expect(cjk.matches.map((match) => match.item_id)).toEqual(['cjk']);
  });

  it('filters messenger rows before decryption and never searches chat_egress', async () => {
    await append({
      id: 'owner',
      content: 'The launch code is cedar.',
      ts: 1_100,
    });
    await append({
      id: 'messenger',
      content: 'The launch code is attacker.',
      ts: 1_200,
      source: messengerSource,
    });
    await append({
      id: 'assistant',
      role: 'assistant',
      content: 'Ordinary assistant response.',
      ts: 1_300,
    });
    await store.appendEgress('prior', 'assistant', [
      {
        call_index: 0,
        prompt: 'egress-only-secret',
        model_id: 'test/model',
        ts: 1_301,
      },
    ]);

    const backend = createRecallSearchBackend(store);
    const owner = await backend.search({
      query: normalizeRecallQuery('launch code'),
      scope: SCOPE,
    });
    expect(owner.matches.map((match) => match.item_id)).toEqual(['owner']);

    const egress = await backend.search({
      query: normalizeRecallQuery('egress-only-secret'),
      scope: SCOPE,
    });
    expect(egress.matches).toEqual([]);
    expect(egress.complete).toBe(true);
  });

  it('applies kind and visible-item exclusions without widening the row scope', async () => {
    await append({
      id: 'user',
      role: 'user',
      content: 'shared marker',
      ts: 1_100,
    });
    await append({
      id: 'assistant',
      role: 'assistant',
      content: 'shared marker',
      ts: 1_200,
    });
    const backend = createRecallSearchBackend(store);
    const result = await backend.search({
      query: normalizeRecallQuery('shared marker'),
      scope: SCOPE,
      kinds: new Set(['assistant']),
      excluded_item_ids: new Set(['assistant']),
    });
    expect(result.matches).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('returns a sealed continuation on a wall-clock frontier and resumes after it', async () => {
    for (let index = 0; index < 4; index += 1) {
      await append({
        id: `message-${index}`,
        content: `continuation marker ${index}`,
        ts: 2_000 + index,
      });
    }
    let tick = 0;
    const scanPage = vi.spyOn(store, 'scanRecallMessagesPage');
    const backend = createRecallSearchBackend(store, {
      now: () => tick++,
      continuation_secret: new Uint8Array(32).fill(7),
      page_size: 1,
    });

    const first = await backend.search({
      query: normalizeRecallQuery('continuation marker'),
      scope: SCOPE,
      max_ms: 1,
    });
    expect(first.complete).toBe(false);
    expect(first.continuation).toBeTypeOf('string');
    expect(first.matches.map((match) => match.item_id)).toEqual(['message-3']);
    expect(scanPage).toHaveBeenCalledTimes(1);
    const tokenPieces = first.continuation!.split('.');
    expect(tokenPieces).toHaveLength(4);
    for (const piece of tokenPieces.slice(1)) {
      expect(Buffer.from(piece, 'base64url').toString('utf8')).not.toContain(
        'message-3',
      );
    }

    const resumed = await backend.search({
      query: normalizeRecallQuery('continuation marker'),
      scope: SCOPE,
      continuation: first.continuation,
      max_ms: 100,
    });
    expect(resumed.complete).toBe(true);
    expect(resumed.matches.map((match) => match.item_id)).toEqual([
      'message-2',
      'message-1',
      'message-0',
    ]);

    const tampered = await backend.search({
      scope: SCOPE,
      continuation: `${first.continuation}x`,
    });
    expect(tampered.invalid_continuation).toBe(true);
    expect(tampered.matches).toEqual([]);

    const changedCiphertext = [...tokenPieces];
    changedCiphertext[2] = `${
      changedCiphertext[2]!.startsWith('A') ? 'B' : 'A'
    }${changedCiphertext[2]!.slice(1)}`;
    const authenticatedTamper = await backend.search({
      scope: SCOPE,
      continuation: changedCiphertext.join('.'),
    });
    expect(authenticatedTamper.invalid_continuation).toBe(true);
    expect(authenticatedTamper.matches).toEqual([]);

    // Node's base64url decoder silently ignores these suffixes. The recall
    // verifier must enforce canonical encoding before decoding or a mutated
    // token would still authenticate.
    for (const suffix of ['!', '%', '=', '\n']) {
      const nonCanonical = await backend.search({
        scope: SCOPE,
        continuation: `${first.continuation}${suffix}`,
      });
      expect(nonCanonical.invalid_continuation).toBe(true);
      expect(nonCanonical.matches).toEqual([]);
    }
  });

  it('reports unreadable authorized rows as incomplete without inventing content', async () => {
    await append({
      id: 'readable',
      content: 'coverage marker one',
      ts: 1_100,
    });
    await append({
      id: 'corrupt',
      content: 'coverage marker two',
      ts: 1_200,
    });
    db.prepare(
      "UPDATE chat_messages SET content_encrypted = X'00' WHERE message_id = 'corrupt'",
    ).run();

    const backend = createRecallSearchBackend(store);
    const result = await backend.search({
      query: normalizeRecallQuery('coverage marker'),
      scope: SCOPE,
    });
    expect(result.complete).toBe(false);
    expect(result.continuation).toBeUndefined();
    expect(result.matches.map((match) => match.item_id)).toEqual(['readable']);
  });

  it('exact-fetches only eligible authoritative rows', async () => {
    await append({
      id: 'eligible',
      content: 'exact owner body',
      ts: 1_100,
    });
    await append({
      id: 'excluded',
      content: 'exact messenger body',
      ts: 1_200,
      source: messengerSource,
    });
    const backend = createRecallSearchBackend(store);

    await expect(backend.fetchExact('eligible', SCOPE)).resolves.toMatchObject({
      status: 'ok',
      match: { content: 'exact owner body' },
    });
    await expect(backend.fetchExact('excluded', SCOPE)).resolves.toEqual({
      status: 'not_found',
    });
    await expect(backend.fetchExact('missing', SCOPE)).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('materializes only the content source columns, never unrelated message blobs', async () => {
    await append({
      id: 'narrow-source',
      content: 'narrow projection marker',
      ts: 1_100,
    });
    db.function(
      'd213_forbidden_message_column',
      { deterministic: true },
      () => {
        throw new Error('a non-source message column was materialized');
      },
    );
    db.exec(`
      ALTER TABLE chat_messages
      ADD COLUMN forbidden_message_blob TEXT
      GENERATED ALWAYS AS (d213_forbidden_message_column()) VIRTUAL
    `);

    const backend = createRecallSearchBackend(store);
    await expect(backend.search({
      query: normalizeRecallQuery('narrow projection marker'),
      scope: SCOPE,
    })).resolves.toMatchObject({
      complete: true,
      matches: [{ item_id: 'narrow-source' }],
    });
    await expect(
      backend.fetchExact('narrow-source', SCOPE),
    ).resolves.toMatchObject({
      status: 'ok',
      match: { item_id: 'narrow-source' },
    });
  });

  it('follows the authoritative session cascade and creates no term index', async () => {
    await append({
      id: 'to-delete',
      content: 'cascade-only marker',
      ts: 1_100,
    });
    const backend = createRecallSearchBackend(store);
    expect(store.deleteSession('prior')).toBe(true);

    await expect(backend.fetchExact('to-delete', SCOPE)).resolves.toEqual({
      status: 'not_found',
    });
    await expect(backend.search({
      query: normalizeRecallQuery('cascade-only marker'),
      scope: SCOPE,
    })).resolves.toMatchObject({
      matches: [],
      complete: true,
    });
    const auxiliary = db.prepare(`
      SELECT name
        FROM sqlite_master
       WHERE type IN ('table', 'index', 'view')
         AND (
           lower(name) LIKE '%recall%term%'
           OR lower(name) LIKE '%recall%fts%'
         )
    `).all();
    expect(auxiliary).toEqual([]);
  });

  it('caps the normalized model query at 512 UTF-8 bytes without splitting code points', () => {
    const query = normalizeRecallQuery('界'.repeat(400));
    expect(query).toBeDefined();
    expect(Buffer.byteLength(query!.text, 'utf8')).toBeLessThanOrEqual(
      RECALL_QUERY_MAX_BYTES,
    );
    expect(query!.text.endsWith('界')).toBe(true);
  });
});

describe('R7 — a recalled piece never becomes a searchable corpus (no endless loop)', () => {
  // ⛔ THE CONSTRAINT (owner, 2026-07-25): `context_read` must not return
  // `context_read`'s own result, or recall feeds itself.
  //
  // The 2026-07-25 join ruling (D-213 §3.8) says pieceA of
  // sessionA JOINS sessionB. This test pins the half of that ruling which keeps
  // R7 intact: only the scoped PII **kv** joins B durably. The **content** is
  // turn-local, so a later recall over B cannot return it and hand it to a third
  // session. Search reads `content_encrypted`; candidates live in their own
  // column and are never searched — that separation IS the loop guard.
  let db: Database.Database;
  let store: ChatStore;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    const key = deriveSubDEK(fixedMaster(), 'chat');
    store = createChatStore(db, () => key);
    store.createSession({ id: 'B', now: 1_000 });
  });

  afterEach(() => db.close());

  it('cannot find a value that entered the session only as a joined PII candidate', async () => {
    // sessionB recalled pieceA, which was about John Adams. Under the join rule
    // his value lands on B's row as a CANDIDATE. B's own authored content never
    // mentions him.
    await store.appendMessage({
      id: 'b1',
      session_id: 'B',
      role: 'assistant',
      content: 'I followed up with the vendor about the renewal.',
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source: ownerSource('B'),
      ts: 1_100,
      retained_alias_candidates: [{ value: 'John Adams', kind: 'name' }],
    });

    const backend = createRecallSearchBackend(store);
    const found = await backend.search({
      query: normalizeRecallQuery('John Adams'),
      scope: SCOPE,
    });

    // ⛔ If this ever returns a match, a third session could recall B and be
    // handed sessionA's material — the loop the constraint forbids.
    expect(found.matches).toEqual([]);

    // Control: B's OWN authored content is still findable, so the assertion
    // above is about the candidate column and not a broken search.
    const control = await backend.search({
      query: normalizeRecallQuery('renewal'),
      scope: SCOPE,
    });
    expect(control.matches.map((m) => m.item_id)).toEqual(['b1']);
  });
});
