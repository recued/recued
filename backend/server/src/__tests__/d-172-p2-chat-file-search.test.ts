/** D-172 P2 — `file.search`: session-scoped by default, identity only.
 *
 *  The load-bearing test in this file is "omitting `scope` does NOT reach the
 *  owner's whole file store". Scope is an argument, so the MODEL picks it — and
 *  the model is routinely reading text a stranger wrote. If saying nothing
 *  meant "everything", a prompt-injected line would widen the search for free.
 *  So the default is driven with the input that would expose the difference:
 *  a store holding a file the session never saw.
 */

import { describe, expect, it } from 'vitest';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';

const OWNER_ONLY_FILE = 'file:taxreturn';
const SESSION_FILE = 'file:contract';
const VISITOR_FILE = 'file:visitordrop';

const record = (
  id: string,
  filename: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  record_id: id,
  received_at: 1_700_000_000_000,
  size_bytes: 1024,
  hot_fields: {
    filename,
    media_class: 'document',
    size: 1024,
    origin: 'webclient_upload',
    scan_status: 'clean',
    ...extra,
  },
});

const STORE: ReadonlyMap<string, Record<string, unknown>> = new Map([
  [SESSION_FILE, record(SESSION_FILE, 'signed-contract.pdf')],
  [OWNER_ONLY_FILE, record(OWNER_ONLY_FILE, 'tax-return-2025.pdf')],
  [VISITOR_FILE, record(VISITOR_FILE, 'from-a-stranger.pdf', {
    origin: 'reception_drop',
    scan_status: 'unscanned',
  })],
]);

interface HarnessOptions {
  sessionFileIds?: readonly string[];
  withChatStore?: boolean;
}

const handler = (opts: HarnessOptions = {}) => {
  const sessionFileIds = opts.sessionFileIds ?? [SESSION_FILE];
  const collection = {
    get: (id: string) => STORE.get(id) ?? null,
    list: () => [...STORE.values()],
  };
  const deps = {
    getContactStore: () => undefined,
    getCollectionRegistry: () => ({
      get: (platform: string, slug: string) =>
        platform === 'file' && slug === 'received' ? collection : undefined,
    }),
    ...(opts.withChatStore === false ? {} : {
      getChatStore: () => ({
        listMessages: async () => [
          { attachments: sessionFileIds.map((file_id) => ({ file_id })) },
        ],
      }),
    }),
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({}),
    getExecutorConfig: () => ({}),
  } as unknown as Parameters<typeof buildChatTier1Handlers>[0];
  return buildChatTier1Handlers(deps)['file.search'];
};

const ctx = { session_id: 'sess-1' } as never;

const filesOf = (res: unknown): Array<Record<string, unknown>> =>
  ((res as { result?: { files?: Array<Record<string, unknown>> } }).result?.files ?? []);

describe('D-172 P2 — file.search default scope is the containment', () => {
  it('OMITTING scope returns only this session\'s files', async () => {
    const res = await handler()({}, ctx);
    const names = filesOf(res).map((f) => f.filename);
    expect(names).toEqual(['signed-contract.pdf']);
    // The store HOLDS the owner's other files — this is the input that would
    // expose a wrong default, not a store that happens to be empty.
    expect(STORE.has(OWNER_ONLY_FILE)).toBe(true);
    expect(names).not.toContain('tax-return-2025.pdf');
  });

  it('states the scope back on every result, not only when widened', async () => {
    const res = await handler()({}, ctx);
    const r = (res as { result: { scope: string; hint: string } }).result;
    expect(r.scope).toBe('session');
    // A model that forgot which set it searched would otherwise report an
    // absence it never established.
    expect(r.hint).toContain('THIS conversation');
  });

  it('scope:"all" widens — the opt-in works, so the default is a choice', async () => {
    const res = await handler()({ scope: 'all' }, ctx);
    const names = filesOf(res).map((f) => f.filename);
    expect(names).toContain('tax-return-2025.pdf');
    expect((res as { result: { scope: string } }).result.scope).toBe('all');
  });

  it('an UNRECOGNIZED scope falls back to session, never to all', async () => {
    // A typo, or a model emitting `"everything"`, must not be the thing that
    // widens a search whose whole point is being narrow.
    for (const bad of ['everything', 'ALL', '', 'owner', 'all ']) {
      const res = await handler()({ scope: bad }, ctx);
      expect(filesOf(res).map((f) => f.filename), bad).toEqual(['signed-contract.pdf']);
    }
  });

  it('no chat store ⇒ session scope returns EMPTY with a reason, never falls through', async () => {
    const res = await handler({ withChatStore: false })({}, ctx);
    expect(filesOf(res)).toEqual([]);
    expect((res as { result: { hint: string } }).result.hint).toContain('no session context');
  });

  it('a turn with no session id ⇒ empty, not the whole store', async () => {
    const res = await handler()({}, {} as never);
    expect(filesOf(res)).toEqual([]);
  });
});

describe('D-172 P2 — file.search returns identity, never content', () => {
  it('carries the fields a sender needs and no bytes', async () => {
    const [file] = filesOf(await handler()({}, ctx));
    expect(file).toEqual({
      file_id: SESSION_FILE,
      filename: 'signed-contract.pdf',
      media_class: 'document',
      size_bytes: 1024,
      origin: 'webclient_upload',
      scan_status: 'clean',
      received_at: 1_700_000_000_000,
    });
    // ⛔ Content egress stays on the Gateway-gated `data-file-read`. The
    // `toEqual` above is the real guarantee (an extra field fails it); this
    // names the specific keys that would mean bytes leaked, so a future field
    // added to the projection trips a test that says WHY.
    // ⚠ Matching /bytes/ would flag `size_bytes`, which is a legitimate
    // identity field — the first cut did exactly that and failed on itself.
    for (const leaky of ['bytes_b64', 'content', 'blob_hash', 'body', 'text']) {
      expect(Object.hasOwn(file, leaky), leaky).toBe(false);
    }
  });

  it('surfaces provenance for a visitor upload rather than flattening it', async () => {
    const res = await handler({ sessionFileIds: [VISITOR_FILE] })({}, ctx);
    const [file] = filesOf(res);
    expect(file.origin).toBe('reception_drop');
    expect(file.scan_status).toBe('unscanned');
  });

  it('an absent scan status reads as unscanned, never as clean', async () => {
    const bare = new Map(STORE);
    bare.set('file:bare', {
      record_id: 'file:bare',
      hot_fields: { filename: 'bare.pdf' },
    });
    const collection = { get: (id: string) => bare.get(id) ?? null, list: () => [...bare.values()] };
    const h = buildChatTier1Handlers({
      getCollectionRegistry: () => ({ get: () => collection }),
      getChatStore: () => ({
        listMessages: async () => [{ attachments: [{ file_id: 'file:bare' }] }],
      }),
    } as unknown as Parameters<typeof buildChatTier1Handlers>[0])['file.search'];
    const [file] = filesOf(await h({}, ctx));
    // Telling a reader "clean" about a file nobody checked is the one wrong
    // default here — it is the field they'd rely on before sending it out.
    expect(file.scan_status).toBe('unscanned');
  });
});

describe('D-172 P2 — file.search query + shape', () => {
  it('empty query lists everything in scope', async () => {
    const res = await handler({ sessionFileIds: [SESSION_FILE, VISITOR_FILE] })({}, ctx);
    expect(filesOf(res)).toHaveLength(2);
  });

  it('query filters by filename, case-insensitively', async () => {
    const res = await handler({ sessionFileIds: [SESSION_FILE, VISITOR_FILE] })(
      { query: 'CONTRACT' }, ctx,
    );
    expect(filesOf(res).map((f) => f.filename)).toEqual(['signed-contract.pdf']);
  });

  it('a referenced file whose record is gone is skipped, not returned as a bare id', async () => {
    const res = await handler({ sessionFileIds: [SESSION_FILE, 'file:vanished'] })({}, ctx);
    // An entry the model cannot describe is one it will describe wrongly.
    expect(filesOf(res).map((f) => f.file_id)).toEqual([SESSION_FILE]);
  });

  it('dedups a file attached across several turns', async () => {
    const res = await handler({ sessionFileIds: [SESSION_FILE, SESSION_FILE] })({}, ctx);
    expect(filesOf(res)).toHaveLength(1);
  });
});
