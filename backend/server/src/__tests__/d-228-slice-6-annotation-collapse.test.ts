/** D-228 slice 6 — THE MCP CONNECTION ANNOTATION COLLAPSES TO WHAT THE OWNER
 *  TYPED.
 *
 *  ⛔ THIS FILE REPLACES `d-137-phase-5-chat-mode-annotation.test.ts` (333 lines,
 *  21 cases), and the replacement is deliberate rather than a deletion. That
 *  suite proved the annotation's `chat_mode` round-tripped through the validator
 *  and the store: `null` clears, absent preserves, an object replaces, a
 *  corrupted blob narrows to null. Every one of those properties was about a
 *  field this slice removed, so the tests could not be re-aimed — but a suite
 *  removed in silence is how a field grows back and nobody notices.
 *
 *  What went, and where its meaning lives now:
 *
 *  - **`chat_mode`** — what a PEER advertised about its chat AI. Read by the MCP
 *    scope-picker, which slice 5 retired for having no client on either end.
 *  - **`recued_signature`** — the peer's `recued`/version/instance fingerprint.
 *    Same reader, same fate. ⚠ The TYPE survives with other tenants
 *    (`deps.selfSignature`, `picker_at_send`); only the annotation field went.
 *  - **`tools_list_cache`** — a snapshot of the peer's `tools/list`. Superseded
 *    by the generated pack: `probeMintableDescriptors` reads the live list at
 *    mint, so the cache was a second, staler copy of the same fact.
 *
 *  🔑 THE CODEX P2 FAIL-CLOSED FOLD WAS CHECKED BEFORE CUTTING, NOT ASSUMED. Two
 *  of the deleted cases pinned a real safety property — a malformed
 *  `session_cap` must collapse the whole `chat_mode` to null rather than degrade
 *  to "offered, uncapped". That property has its OWN implementation on the
 *  inbound side (`chat-inbound-token-store.ts`, the surface that actually
 *  enforces a cap) with its own cases in `d-137-phase-5-inbound-tokens.test.ts`
 *  § "Codex review P2 fold". Deleting the outbound twin orphans nothing.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES,
  buildDefaultConnectionMcpAnnotation,
  validateConnectionMcpAnnotationInput,
} from '@recued/contracts';
import {
  LEGACY_OVERRIDES,
  createChatConnectionMcpStore,
  ensureChatConnectionMcpAnnotationSchema,
  legacyToolOverrides,
} from '../storage/chat-connection-mcp-store.js';

/** Every key the three retired fields ever occupied on the wire, in a shape a
 *  cached older webclient would actually have sent. */
const LEGACY_WIRE_KEYS = {
  tool_overrides: { search: { enabled: true, classification: 'read' } },
  tools_list_cache: { tools: [{ name: 'search' }], cached_at: 99 },
  recued_signature: { server_kind: 'recued', version: '26.8.13', instance_id: 'abc' },
  chat_mode: { offered: true, session_cap: { per_day: 10, concurrent: 2 } },
} as const;

describe('D-228 slice 6 — the annotation shape', () => {
  it('⛔ is EXACTLY connection + topic tags + updated_at', () => {
    // The closed-list ratchet for this slice. An added key is a visible diff.
    expect(Object.keys(buildDefaultConnectionMcpAnnotation('exa')).sort())
      .toEqual(['connection_name', 'topic_tags', 'updated_at']);
  });
});

describe('D-228 slice 6 — the retired keys are TOLERATED, not rejected', () => {
  it.each(Object.keys(LEGACY_WIRE_KEYS))(
    '⛔ accepts `%s` on the wire and drops it from the validated value',
    (key) => {
      // ⚠ WHAT YOU ACCEPT IS NOT WHAT YOU ADVERTISE. A self-hosted server has no
      // deploy order it controls: the owner's box updates on its own schedule
      // while a service-worker-cached webclient may still send the old payload.
      // Rejecting it would 400 a topic-tag edit over a key the server no longer
      // has an opinion about.
      const result = validateConnectionMcpAnnotationInput({
        connection_name: 'exa',
        topic_tags: ['web'],
        [key]: LEGACY_WIRE_KEYS[key as keyof typeof LEGACY_WIRE_KEYS],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(key in result.value).toBe(false);
      expect(result.value).toEqual({ connection_name: 'exa', topic_tags: ['web'] });
    },
  );

  it('⛔ accepts a MALFORMED legacy key — tolerance that still validates is not tolerance', () => {
    // The trap this closes: deleting the fields while LEAVING their shape checks
    // would drop the keys from the value and still 400 a malformed one. The
    // caller would be rejected over a field the server does not store.
    const result = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      topic_tags: [],
      tools_list_cache: 'not-an-object',
      recued_signature: { server_kind: 'nope' },
      chat_mode: { offered: 'yes', session_cap: { per_day: -1, concurrent: 1.5 } },
    });

    expect(result.ok).toBe(true);
  });

  it('still rejects what it actually validates', () => {
    // The permitting witness's sibling: "everything is accepted" would also pass
    // for a validator that had stopped checking anything at all.
    const result = validateConnectionMcpAnnotationInput({
      connection_name: '',
      topic_tags: ['a', 'a'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain('connection_name_invalid');
  });
});

describe('D-228 slice 6 — the issue-code vocabulary is DERIVED, not hand-written', () => {
  it('⛔⛔ every listed code is one the validator can actually emit, and vice versa', () => {
    // 🔑 THE RATCHET THAT WOULD HAVE CAUGHT THE ROT. Before this slice the list
    // carried 24 codes and the validator could emit 5 — slices 4 and 6 moved
    // four fields to tolerate-and-ignore, and a tolerated key raises nothing, so
    // 19 codes sat there naming rejections that had stopped happening.
    //
    // ⚠ Read from the SOURCE, not from a second hand-written list — a twin list
    // is exactly what drifted. This asserts BOTH directions: a code that stops
    // being emitted is as much a defect as one that is emitted but unlisted.
    const source = readFileSync(
      new URL('../../../../packages/contracts/src/chat.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('export const validateConnectionMcpAnnotationInput');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n};', start));
    const emitted = new Set(
      [...body.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]),
    );

    expect(emitted.size).toBeGreaterThan(0);
    expect([...emitted].sort())
      .toEqual([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES].sort());
  });
});

describe('D-228 slice 6 — the prior row is read unconditionally', () => {
  it('⛔⛔ a rewrite that mentions NOTHING else still preserves the legacy overrides', () => {
    // THE DEFECT THIS SLICE CLOSED BY CONSTRUCTION. The prior-row lookup used to
    // be gated on `!hasSig || !hasChatMode` — it existed for the two fields'
    // preserve-on-absent merge. Slice 4 then hung `legacyToolOverrides(prior)`
    // off the same `prior`, unconditionally, so a caller that sent BOTH fields
    // left `prior` null and silently rewrote the overrides column to `{}` — the
    // exact loss slice 4's note claims to prevent.
    //
    // ⚠ LATENT, NOT LIVE: both writers that would stamp the pair together
    // (`chat.picker.refresh`, the Settings → Tools panel) were clientless
    // surfaces. And 41 green store tests could not see it — the preservation
    // test writes a value OMITTING both fields, the only shape under which the
    // guard reads `prior` at all. A fixture that never takes the branch cannot
    // show what the branch breaks.
    const db = new Database(':memory:');
    try {
      ensureChatConnectionMcpAnnotationSchema(db);
      db.exec(`
        INSERT INTO chat_connection_mcp_annotations (connection_name, annotation_json, updated_at)
          VALUES ('exa', '{"topic_tags":[],"tool_overrides":{"search":{"enabled":true,"classification":"read"}},"updated_at":1}', 1)
      `);
      const store = createChatConnectionMcpStore(db);

      const written = store.setAnnotation({
        value: { connection_name: 'exa', topic_tags: ['web'] },
        now: 2_000,
      });

      // Survives on the returned value AND on the re-read row — the write path
      // and the parse path are two chances to drop it.
      expect(legacyToolOverrides(written))
        .toEqual({ search: { enabled: true, classification: 'read' } });
      expect(legacyToolOverrides(store.getAnnotation('exa')))
        .toEqual({ search: { enabled: true, classification: 'read' } });
      expect(store.getAnnotation('exa')?.topic_tags).toEqual(['web']);
    } finally {
      db.close();
    }
  });

  it('a first write against no prior row yields empty overrides, not a crash', () => {
    const db = new Database(':memory:');
    try {
      ensureChatConnectionMcpAnnotationSchema(db);
      const store = createChatConnectionMcpStore(db);

      const written = store.setAnnotation({
        value: { connection_name: 'fresh', topic_tags: [] },
        now: 1_000,
      });

      expect(legacyToolOverrides(written)).toEqual({});
      expect(LEGACY_OVERRIDES in (written as unknown as Record<string, unknown>)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('⛔ a persisted row carrying all three retired keys parses without them', () => {
    // The upgrade path: rows written before this slice still hold the keys. The
    // parse must ignore them rather than surface them — and must NOT carry them
    // forward on the next write (preserve what the owner typed, drop what the
    // machine cached).
    const db = new Database(':memory:');
    try {
      ensureChatConnectionMcpAnnotationSchema(db);
      db.exec(`
        INSERT INTO chat_connection_mcp_annotations (connection_name, annotation_json, updated_at)
          VALUES ('exa', '${JSON.stringify({ topic_tags: ['web'], ...LEGACY_WIRE_KEYS, updated_at: 1 })}', 1)
      `);
      const store = createChatConnectionMcpStore(db);

      const read = store.getAnnotation('exa');
      expect(read?.topic_tags).toEqual(['web']);
      for (const key of ['tools_list_cache', 'recued_signature', 'chat_mode']) {
        expect(key in (read as unknown as Record<string, unknown>)).toBe(false);
      }
      // ⚠ The owner-authored column is the ONE that survives the same rewrite.
      expect(legacyToolOverrides(read))
        .toEqual({ search: { enabled: true, classification: 'read' } });

      store.setAnnotation({ value: { connection_name: 'exa', topic_tags: [] }, now: 2 });
      const row = db
        .prepare('SELECT annotation_json FROM chat_connection_mcp_annotations WHERE connection_name = ?')
        .get('exa') as { annotation_json: string };
      const persisted = JSON.parse(row.annotation_json) as Record<string, unknown>;
      expect(Object.keys(persisted).sort())
        .toEqual(['tool_overrides', 'topic_tags', 'updated_at']);
    } finally {
      db.close();
    }
  });
});
