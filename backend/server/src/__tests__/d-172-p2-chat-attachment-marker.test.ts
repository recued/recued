/** D-172 P2 — the chat tail names the files it carries.
 *
 *  Before this the model was never told a dropped file existed: attachments
 *  are persisted on the message row and `buildChatTail` mapped to
 *  `{role, content}`, so the only file that ever reached a model was the
 *  voice-only transcript. This is the discovery half; `file.search` is the
 *  lookup half, and `CHAT_TAIL_LIMIT` is the seam between them.
 *
 *  ⛔ The load-bearing rule is REAL FILENAMES OR NOTHING. The substrate-bench
 *  measured shape-without-values at ~5.5x fabrication odds — a model fills the
 *  slot it can see — so a marker that announces files it cannot name is worse
 *  than no marker at all.
 */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { buildChatTail, renderAttachmentMarker } from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const names = (entries: Array<[string, string]>): ReadonlyMap<string, string> =>
  new Map(entries);

describe('D-172 P2 — attachment marker', () => {
  it('names each file and carries its id for direct use', () => {
    const marker = renderAttachmentMarker(
      [{ file_id: 'file:abc' }],
      names([['file:abc', 'signed-contract.pdf']]),
    );
    // The id rides with the name so the model can pass it to a recipe without
    // a lookup round-trip. Naming is free; reading is separately gated.
    expect(marker).toBe('\n[files attached to this message: signed-contract.pdf (file:abc)]');
  });

  it('lists several files in order', () => {
    const marker = renderAttachmentMarker(
      [{ file_id: 'file:a' }, { file_id: 'file:b' }],
      names([['file:a', 'one.pdf'], ['file:b', 'two.png']]),
    );
    expect(marker).toContain('one.pdf (file:a), two.png (file:b)');
  });

  it('⛔ OMITS a file it cannot name — never emits a bare id', () => {
    const marker = renderAttachmentMarker(
      [{ file_id: 'file:gone' }],
      names([]),
    );
    // A since-deleted file must vanish from the marker. Listing `file:gone`
    // with no name would invite the model to offer an attachment that
    // resolves to nothing.
    expect(marker).toBe('');
    expect(marker).not.toContain('file:gone');
  });

  it('⛔ emits NOTHING rather than a count when no file resolves', () => {
    const marker = renderAttachmentMarker(
      [{ file_id: 'file:x' }, { file_id: 'file:y' }],
      names([]),
    );
    // This is the shape-without-values case measured at ~5.5x fabrication
    // odds: "[2 files attached]" announces files and invites invented names.
    expect(marker).toBe('');
    expect(marker).not.toMatch(/\d/u);
  });

  it('drops only the unresolvable ones from a mixed set', () => {
    const marker = renderAttachmentMarker(
      [{ file_id: 'file:a' }, { file_id: 'file:gone' }, { file_id: 'file:b' }],
      names([['file:a', 'one.pdf'], ['file:b', 'two.png']]),
    );
    expect(marker).toContain('one.pdf (file:a), two.png (file:b)');
    expect(marker).not.toContain('gone');
  });

  it('is empty for a message with no attachments', () => {
    expect(renderAttachmentMarker([], names([['file:a', 'x.pdf']]))).toBe('');
  });

  it('opens on a newline so it cannot be read as part of what the person typed', () => {
    const marker = renderAttachmentMarker(
      [{ file_id: 'file:a' }],
      names([['file:a', 'x.pdf']]),
    );
    expect(marker.startsWith('\n[')).toBe(true);
  });

  it('carries a filename verbatim, including spaces and punctuation', () => {
    const marker = renderAttachmentMarker(
      [{ file_id: 'file:a' }],
      names([['file:a', 'Q3 forecast (final), v2.xlsx']]),
    );
    // The model has to be able to match what the owner will say out loud.
    expect(marker).toContain('Q3 forecast (final), v2.xlsx (file:a)');
  });
});

// ────────────────────────────────────────────────────────────────
// THE SEAM. Every test above passes whether or not `buildChatTail` calls the
// marker at all — that is the "two suites either side of one boundary" shape,
// and it is why these exist.
// ────────────────────────────────────────────────────────────────

const storeWith = (
  messages: Array<{ role: string; content: string; attachments?: Array<{ file_id: string }> }>,
) => ({
  listRecentConversational: async () =>
    messages.map((m, i) => ({ ...m, id: `m${i}` })),
}) as never;

describe('D-172 P2 — the tail actually carries the marker', () => {
  it('appends the marker to a message that has attachments', async () => {
    const tail = await buildChatTail(
      storeWith([
        { role: 'user', content: 'send this to Bob', attachments: [{ file_id: 'file:a' }] },
      ]),
      'sess-1',
      () => new Map([['file:a', 'signed-contract.pdf']]),
    );
    expect(tail.messages[0].content).toBe(
      'send this to Bob\n[files attached to this message: signed-contract.pdf (file:a)]',
    );
  });

  it('leaves a message with no attachments byte-identical', async () => {
    const tail = await buildChatTail(
      storeWith([{ role: 'user', content: 'just text' }]),
      'sess-1',
      () => new Map([['file:a', 'x.pdf']]),
    );
    // The overwhelming majority of turns carry no file; they must not pay a
    // single byte, and must not change shape at all.
    expect(tail.messages[0].content).toBe('just text');
  });

  it('omits the marker entirely when no resolver is wired', async () => {
    const tail = await buildChatTail(
      storeWith([
        { role: 'user', content: 'send this', attachments: [{ file_id: 'file:a' }] },
      ]),
      'sess-1',
    );
    // A dbless / partial harness degrades to silence, never to a nameless
    // announcement.
    expect(tail.messages[0].content).toBe('send this');
  });

  it('resolves each distinct id ONCE across the window', async () => {
    const asked: string[][] = [];
    await buildChatTail(
      storeWith([
        { role: 'user', content: 'a', attachments: [{ file_id: 'file:a' }] },
        { role: 'user', content: 'b', attachments: [{ file_id: 'file:a' }, { file_id: 'file:b' }] },
      ]),
      'sess-1',
      (ids) => { asked.push([...ids]); return new Map(ids.map((i) => [i, `${i}.pdf`])); },
    );
    // One batched lookup, deduped — not one per message, and not one per
    // attachment. This runs on every turn.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(['file:a', 'file:b']);
  });

  it('does not mutate the stored message content', async () => {
    const messages = [
      { role: 'user', content: 'original', attachments: [{ file_id: 'file:a' }] },
    ];
    await buildChatTail(
      storeWith(messages),
      'sess-1',
      () => new Map([['file:a', 'x.pdf']]),
    );
    // Chat history must still render what the person typed — the marker is on
    // the model's COPY only.
    expect(messages[0].content).toBe('original');
  });
});

// ────────────────────────────────────────────────────────────────
// The drop-then-ask loop, over a REAL chat store.
//
// ⛔ `buildChatTail` reads `listRecentConversational`, which is NOT the query
// the media-drop tests assert on (`listMessages`). Two different SELECTs over
// the same table is exactly the near-miss worth pinning: the drop test proves
// the row was written with its attachments, and the marker tests prove a row
// WITH attachments gets marked, and neither proves the tail's own query
// hydrates them.
// ────────────────────────────────────────────────────────────────

describe('D-172 P2 — a wordless drop is visible on the NEXT turn', () => {
  it('hydrates attachments through the tail query and marks them', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const store = createChatStore(db);
      store.createSession({ id: 'sess-drop', now: 1_000 });

      // Turn 1: the wordless drop. This is what the messenger short-circuit
      // persists before replying "Stored …. What would you like me to do?".
      await store.appendMessage({
        id: 'm1',
        session_id: 'sess-drop',
        role: 'user',
        content: '',
        ts: 2_000,
        target_server: 'self',
        picker_at_send: {
          display_name: 'test',
          signature: { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-test' },
        },
        model_used: { provider: 'test', model_id: 'test-model' },
        attachments: [{ file_id: 'file:abc', media_class: 'document' }],
      });

      // Turn 2 reads the tail before appending, so it sees turn 1.
      const tail = await buildChatTail(
        store,
        'sess-drop',
        () => new Map([['file:abc', 'signed-contract.pdf']]),
      );

      expect(tail.messages).toHaveLength(1);
      expect(tail.messages[0].content).toBe(
        '\n[files attached to this message: signed-contract.pdf (file:abc)]',
      );
    } finally {
      db.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// The WORDLESS drop, on the webclient chat path — mirroring messenger.
// ────────────────────────────────────────────────────────────────

describe('D-172 P2 — a wordless drop in webclient chat', () => {
  const build = async () => {
    const { createChatOrchestrator } = await import('../chat-orchestrator.js');
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const chatStore = createChatStore(db);
    chatStore.createSession({ id: 'sess-w', now: 1_000 });
    const executeAiCall = vi.fn(async () => ({
      body: { response: 'should not happen', events: [], tool_calls: [] },
    }));
    const orchestrator = createChatOrchestrator({
      chatStore,
      registry: {
        list: () => [], listByTier: () => [], getByName: () => null,
        dispatch: vi.fn(), subscribeRefresh: () => () => undefined,
      },
      selfSignature: { server_kind: 'recued', version: '1.0.0', instance_id: 'i' },
      executeAiCall,
      resolveFileNames: () => new Map([['file:abc', 'signed-contract.pdf']]),
    } as never);
    return { db, chatStore, orchestrator, executeAiCall };
  };

  it('stores the file, ASKS, and spends no AI call', async () => {
    const { db, chatStore, orchestrator, executeAiCall } = await build();
    try {
      await (orchestrator as { runTurn: (i: unknown) => Promise<unknown> }).runTurn({
        session_id: 'sess-w',
        message: '',
        picker_state: { current: 'self' },
        attachments: [{ file_id: 'file:abc', media_class: 'document' }],
      });

      // ⛔ A file arriving is not a question. Running a turn would spend a
      // provider call guessing an intent nobody has stated.
      expect(executeAiCall).not.toHaveBeenCalled();

      const messages = await chatStore.listMessages('sess-w');
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: 'user',
        content: '',
        attachments: [{ file_id: 'file:abc', media_class: 'document' }],
      });
      // ⚠ A real assistant ROW, not a banner: the thread renders from stored
      // messages, so a banner would vanish on the next repaint and leave the
      // person with a file and no trace of having been asked anything.
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: 'Stored signed-contract.pdf. What would you like me to do with it?',
      });
      // ⛔ The ORDER above is not self-enforcing: the read breaks a `ts` tie on
      // a randomUUID `message_id`, so with both rows in one millisecond the two
      // assertions above passed on a COIN FLIP (measured 7/12). Name the
      // invariant that actually holds them apart, or a regression comes back as
      // a flake nobody trusts rather than a failure.
      expect(messages[1]!.ts).toBeGreaterThan(messages[0]!.ts);
    } finally {
      db.close();
    }
  });

  it('a turn WITH text still runs normally', async () => {
    const { db, orchestrator, executeAiCall } = await build();
    try {
      await (orchestrator as { runTurn: (i: unknown) => Promise<unknown> }).runTurn({
        session_id: 'sess-w',
        message: 'send this to Bob',
        picker_state: { current: 'self' },
        attachments: [{ file_id: 'file:abc', media_class: 'document' }],
      });
      // The short-circuit is for a WORDLESS drop only — a stated intent must
      // reach the model, with the file named on the same turn.
      expect(executeAiCall).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
