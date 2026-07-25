/** D-177 N.11 rule 5 — slice C server flow: the scoped-proposal store's
 *  state machine, `mintScopedSessionGrant`'s fail-loud vocabulary + the
 *  minted row's compatibility with the slice-A matcher/consume arms, the
 *  parse middleware's file-and-emit path (with its no-op boundaries), and
 *  the accept/dismiss rpc family (live connection validation, tighten-only
 *  bounds, at-least-once idempotence, orphan heal). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  D165_CONTRACT_SCHEMA,
  SCOPED_GRANT_MAX_USES_CEILING,
  SCOPED_GRANT_MAX_USES_DEFAULT,
  SCOPED_GRANT_SUGGESTION_SCOPE,
  SCOPED_GRANT_TTL_MS_CEILING,
  matchesSessionGrant,
  scopedGrantSuggestionKeyHash,
  type ApiExecutionBinding,
  type IngredientManifest,
  type OperationRiskTier,
  type OperationSpec,
  type ProviderSurfaces,
  type ScopedGrantSuggestionRow,
  type ScopedGrantSuggestionSnapshot,
  type SessionGrantMatchContext,
} from '@recued/contracts';
import { RpcError } from '@recued/contracts';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import type { Middleware, TurnContext } from '@recued/middleware';

import {
  ScopedGrantMintError,
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintScopedSessionGrantInput,
} from '../storage/contract-definition-store.js';
import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import {
  createScopedGrantSuggestionStore,
  type ScopedGrantSuggestionStore,
} from '../storage/scoped-grant-suggestion-store.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import {
  listScopedConnectionCandidates,
  resolveScopedCatalogBinding,
} from '../scoped-grant-binding.js';
import {
  createScopedGrantParseSource,
  type ScopedGrantParseDeps,
} from '../chat-scoped-grant-middleware.js';
import { makeContractHandlers } from '../contract-handler.js';
import type { WsClient } from '../ws-server.js';

const NOW = 1_800_300_000_000;
const HOUR_MS = 60 * 60 * 1000;
const REQUEST = 'auto-approve replying to each email I forward this afternoon';

// ── Fixtures ─────────────────────────────────────────────────────

const operation = (
  operation_id: string,
  risk_tier: OperationRiskTier,
): OperationSpec => ({ operation_id, risk_tier, groups: ['recued-core/test'] });

const restBinding = (): ApiExecutionBinding => ({
  kind: 'rest',
  method: 'POST',
  path_template: '/reply',
});

const surfacesWith = (opKey: string): ProviderSurfaces => ({
  api: {
    transport: 'rest',
    default_base_url: 'https://api.example.com',
    auth: { kind: 'none' },
    executes: { [opKey]: restBinding() },
  },
});

const catalogManifest = (
  slug: string,
  opKey: string,
  risk_tier: OperationRiskTier = 'write',
): IngredientManifest => ({
  slug,
  name: `Catalog ${slug}`,
  description: 'rule-5 slice C test catalog',
  author: 'recued-core',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { [opKey]: operation(opKey, risk_tier) },
  surfaces: surfacesWith(opKey),
});

const MAIL_CATALOG = catalogManifest('mailbox-catalog', 'mail.reply', 'write');

const snapshot = (
  overrides: Partial<ScopedGrantSuggestionSnapshot> = {},
): ScopedGrantSuggestionSnapshot => ({
  channel: 'chat',
  channel_session_id: 'chat:s-1',
  ingredient_id: 'mailbox-catalog',
  operation_id: 'mail.reply',
  risk_tier: 'write',
  scoped_source: 'forwarded_item_sender',
  ttl_ms: 4 * HOUR_MS,
  entity: 'mail',
  action: 'reply',
  ...overrides,
});

const mintInput = (
  overrides: Partial<MintScopedSessionGrantInput> = {},
): MintScopedSessionGrantInput => ({
  minted_by: 'owner',
  display_name: 'Scoped grant — mail.reply',
  scope: {
    channels: ['chat'],
    ingredient_ids: ['mailbox-catalog'],
    operation_ids: ['mail.reply'],
    connection_names: ['mailbox-1'],
  },
  channel_session_id: 'chat:s-1',
  risk_tier: 'write',
  scoped_source: 'forwarded_item_sender',
  approved_action_ref: 'key-1',
  expiry_at: NOW + 4 * HOUR_MS,
  max_uses: 10,
  ...overrides,
});

// ── Shared harness ───────────────────────────────────────────────

let db: Database.Database;
let store: ContractStore;
let defStore: ContractDefinitionStore;
let suggestionStore: ScopedGrantSuggestionStore;
let now: number;

beforeEach(() => {
  db = new Database(':memory:');
  now = NOW;
  store = createContractStore(db);
  store.seedSchema(D165_CONTRACT_SCHEMA);
  defStore = createContractDefinitionStore(store, { now: () => now });
  suggestionStore = createScopedGrantSuggestionStore(store, { now: () => now });
});

afterEach(() => {
  db.close();
});

// ════════════════════════════════════════════════════════════════
describe('scoped-grant suggestion store — state machine', () => {
  const seed = (s = snapshot()) => {
    const key_hash = scopedGrantSuggestionKeyHash(s);
    const outcome = suggestionStore.upsertOpen({
      key_hash,
      snapshot: s,
      triggering_excerpt: REQUEST,
      connection_candidates: ['mailbox-1'],
    });
    return { key_hash, outcome };
  };

  it('creates, refreshes only on material change, and suppresses resolved rows', () => {
    const { key_hash, outcome } = seed();
    expect(outcome).toBe('created');
    // identical re-utterance — unchanged, updated_at stays
    expect(
      suggestionStore.upsertOpen({
        key_hash,
        snapshot: snapshot(),
        triggering_excerpt: REQUEST,
        connection_candidates: ['mailbox-1'],
      }),
    ).toBe('unchanged');
    // new duration — same key (ttl out of the key), updated in place
    now += 1_000;
    expect(
      suggestionStore.upsertOpen({
        key_hash,
        snapshot: snapshot({ ttl_ms: HOUR_MS }),
        triggering_excerpt: REQUEST,
        connection_candidates: ['mailbox-1'],
      }),
    ).toBe('updated');
    expect(suggestionStore.get(key_hash)?.snapshot.ttl_ms).toBe(HOUR_MS);
    // resolved — the parse never overrides the human
    expect(suggestionStore.setState(key_hash, 'dismissed').outcome).toBe('changed');
    expect(
      suggestionStore.upsertOpen({
        key_hash,
        snapshot: snapshot(),
        triggering_excerpt: REQUEST,
        connection_candidates: ['mailbox-1'],
      }),
    ).toBe('suppressed');
  });

  it('refuses cross-resolution flips and is idempotent on same-state retries', () => {
    const { key_hash } = seed();
    expect(suggestionStore.setState(key_hash, 'accepted').outcome).toBe('changed');
    expect(suggestionStore.setState(key_hash, 'accepted').outcome).toBe('unchanged');
    expect(suggestionStore.setState(key_hash, 'dismissed').outcome).toBe('refused');
    expect(suggestionStore.setState('missing', 'dismissed').outcome).toBe('absent');
  });
});

// ════════════════════════════════════════════════════════════════
describe('mintScopedSessionGrant — fail-loud vocabulary + matcher compatibility', () => {
  it('mints a session/scoped row that the slice-A matcher admits', () => {
    const grant = defStore.mintScopedSessionGrant(mintInput());
    expect(grant.grant_kind).toBe('session');
    expect(grant.grant_mode).toBe('scoped');
    expect(grant.scoped_source).toBe('forwarded_item_sender');
    expect(grant.bound_recipe).toBeUndefined();
    expect(grant.arg_shape_hash).toBeUndefined();
    expect(grant.uses_remaining).toBe(10);

    const ctx: SessionGrantMatchContext = {
      channel: 'chat',
      actor: 'user_self',
      channel_session_id: 'chat:s-1',
      ingredient_slug: 'mailbox-catalog',
      operation_id: 'mail.reply',
      connection_name: 'mailbox-1',
      recipe_id: 'r-any',
      recipe_hash: 'h-any',
      risk_tier: 'write',
      pre_lift_approval: 'ask',
      arg_shape_hash: 'shape-any',
      canonical_payload_hash: 'payload-any',
      destination_emails: ['vendor@x.com'],
      scoped_sender_candidates: [
        { email: 'vendor@x.com', contributed_at: NOW + 1_000 },
      ],
    };
    expect(matchesSessionGrant(grant, ctx, NOW + 2_000)).toBe(true);
    // a destination outside the candidate index falls through to ask
    expect(
      matchesSessionGrant(
        grant,
        { ...ctx, destination_emails: ['attacker@evil.com'] },
        NOW + 2_000,
      ),
    ).toBe(false);
    // and the consume arm re-verifies containment before spending
    expect(
      defStore.consumeSessionGrant(grant.contract_id, {
        canonical_payload_hash: 'payload-any',
        destination_emails: ['vendor@x.com'],
        scoped_sender_candidates: [
          { email: 'vendor@x.com', contributed_at: NOW + 1_000 },
        ],
      }),
    ).toBe(true);
    expect(defStore.get(grant.contract_id)?.uses_remaining).toBe(9);
  });

  it.each<[string, Partial<MintScopedSessionGrantInput>]>([
    ['empty session', { channel_session_id: '' }],
    ['unbound ingredient axis', { scope: { ...mintInput().scope, ingredient_ids: [] } }],
    ['unbound operation axis', { scope: { ...mintInput().scope, operation_ids: [] } }],
    ['unbound connection axis', { scope: { ...mintInput().scope, connection_names: [] } }],
    ['destructive tier', { risk_tier: 'destructive' }],
    [
      'off-vocabulary source',
      { scoped_source: 'session_user_items' as MintScopedSessionGrantInput['scoped_source'] },
    ],
    ['empty anchor', { approved_action_ref: '' }],
    ['past expiry', { expiry_at: NOW - 1 }],
    ['over-ceiling expiry', { expiry_at: NOW + SCOPED_GRANT_TTL_MS_CEILING + 1 }],
    ['zero uses', { max_uses: 0 }],
    ['over-ceiling uses', { max_uses: SCOPED_GRANT_MAX_USES_CEILING + 1 }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => defStore.mintScopedSessionGrant(mintInput(overrides))).toThrow(
      ScopedGrantMintError,
    );
  });

  it('D-211 permits a bounded read-tier scoped session grant', () => {
    expect(defStore.mintScopedSessionGrant(
      mintInput({ risk_tier: 'read' }),
    ).risk_tier).toBe('read');
  });
});

// ════════════════════════════════════════════════════════════════
describe('resolveScopedCatalogBinding + connection candidates (5.b)', () => {
  it('resolves exactly one declaring catalog at a grantable tier', () => {
    expect(resolveScopedCatalogBinding([MAIL_CATALOG], 'mail', 'reply')).toEqual({
      ingredient_id: 'mailbox-catalog',
      operation_id: 'mail.reply',
      risk_tier: 'write',
    });
    // off-catalog action
    expect(resolveScopedCatalogBinding([MAIL_CATALOG], 'mail', 'send')).toBeUndefined();
    // D-211 Slice 3: read-tier session grants use the same scoped binding.
    expect(
      resolveScopedCatalogBinding(
        [catalogManifest('c2', 'mail.reply', 'read')],
        'mail',
        'reply',
      ),
    ).toEqual({
      ingredient_id: 'c2',
      operation_id: 'mail.reply',
      risk_tier: 'read',
    });
    // two declaring catalogs — ambiguous, no guess
    expect(
      resolveScopedCatalogBinding(
        [MAIL_CATALOG, catalogManifest('c2', 'mail.reply', 'write')],
        'mail',
        'reply',
      ),
    ).toBeUndefined();
  });

  it('enumerates connections via the binding store', () => {
    const bindingStore = createConnectionCatalogBindingStore(store);
    bindingStore.bind('mailbox-1', 'mailbox-catalog', 'pack-1');
    bindingStore.bind('other-conn', 'other-catalog', 'pack-1');
    const connectionStore = {
      list: () => [
        { name: 'mailbox-1', config_json: '{}', subtype: null },
        { name: 'other-conn', config_json: '{}', subtype: null },
      ],
    } as never;
    expect(
      listScopedConnectionCandidates(connectionStore, bindingStore, 'mailbox-catalog'),
    ).toEqual(['mailbox-1']);
  });
});

// ════════════════════════════════════════════════════════════════
describe('scoped-grant parse middleware (5.c)', () => {
  const buildCtx = (
    overrides: Partial<Pick<TurnContext, 'surface' | 'session_id'>> & {
      userText?: string;
    } = {},
  ): TurnContext =>
    ({
      session_id: overrides.session_id ?? 's-1',
      surface: overrides.surface ?? 'chat',
      turn_index: 0,
      turn_id: 't-1',
      history: [
        {
          session_id: overrides.session_id ?? 's-1',
          surface: 'chat',
          role: 'user',
          text: overrides.userText ?? REQUEST,
          ts: NOW,
        },
      ],
      prompt: { contribute: () => {} },
      interjections: [],
      capacity: {},
      out: {},
      state: new Map<string, unknown>(),
      resolve: () => {},
    }) as unknown as TurnContext;

  const buildDeps = (): {
    deps: ScopedGrantParseDeps;
    emitted: unknown[];
  } => {
    const bindingStore = createConnectionCatalogBindingStore(store);
    bindingStore.bind('mailbox-1', 'mailbox-catalog', 'pack-1');
    const emitted: unknown[] = [];
    return {
      emitted,
      deps: {
        suggestionStore,
        listManifests: () => [MAIL_CATALOG],
        connectionStore: {
          list: () => [{ name: 'mailbox-1', config_json: '{}', subtype: null }],
        } as never,
        bindingStore,
        emit: (event) => emitted.push(event),
      },
    };
  };

  const runPrompt = (middleware: Middleware, ctx: TurnContext): void => {
    middleware.prompt?.(ctx);
  };

  it('files an open proposal + emits on creation; idempotent re-utterance is silent', () => {
    const { deps, emitted } = buildDeps();
    const middleware = createScopedGrantParseSource(() => deps);
    runPrompt(middleware, buildCtx());
    const rows = suggestionStore.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('open');
    expect(rows[0].snapshot.channel_session_id).toBe('chat:s-1');
    expect(rows[0].snapshot.operation_id).toBe('mail.reply');
    expect(rows[0].triggering_excerpt).toBe(REQUEST);
    expect(rows[0].connection_candidates).toEqual(['mailbox-1']);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: 'contract.scoped_grant_suggested',
      key_hash: rows[0].key_hash,
      chat_session_id: 's-1',
    });
    // re-utterance — no second row, no second emit
    runPrompt(middleware, buildCtx());
    expect(suggestionStore.list()).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it.each([
    ['non-chat surface', { surface: 'messenger-telegram' as TurnContext['surface'] }],
    ['plain turn (no intent)', { userText: 'reply to my emails please' }],
    [
      'request embedded in forwarded content',
      {
        userText: [
          'fyi',
          '---------- Forwarded message ---------',
          'From: a@b.com',
          'Date: Mon',
          'Subject: x',
          REQUEST,
        ].join('\n'),
      },
    ],
  ])('no-op: %s', (_label, overrides) => {
    const { deps, emitted } = buildDeps();
    const middleware = createScopedGrantParseSource(() => deps);
    runPrompt(middleware, buildCtx(overrides));
    expect(suggestionStore.list()).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it('no-op when deps are absent and never throws on a broken store', () => {
    const noDeps = createScopedGrantParseSource(() => undefined);
    expect(() => runPrompt(noDeps, buildCtx())).not.toThrow();
    const { deps } = buildDeps();
    const broken = createScopedGrantParseSource(() => ({
      ...deps,
      suggestionStore: {
        ...deps.suggestionStore,
        upsertOpen: () => {
          throw new Error('boom');
        },
      },
    }));
    expect(() => runPrompt(broken, buildCtx())).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
describe('scoped-grant rpc family (5.c accept/dismiss)', () => {
  type ContractHandlers = NonNullable<ReturnType<typeof makeContractHandlers>>['handlers'];
  const CLIENT = { display_name: 'Bob MacBook' } as WsClient;

  let handlers: ContractHandlers;
  let auditRows: ActivityEntry[];
  let broadcasts: unknown[];
  let connectionNames: string[];

  const buildHandlers = (): void => {
    auditRows = [];
    broadcasts = [];
    const auditLog = {
      logActivity: async (entry: ActivityEntry) => {
        auditRows.push(entry);
        return entry;
      },
    } as unknown as AuditLogStore;
    const slice = makeContractHandlers({
      store,
      getManifest: () => null,
      listManifests: () => [MAIL_CATALOG],
      broadcast: (event) => broadcasts.push(event),
      now: () => now,
      auditLog,
      getConnectionStore: () =>
        ({
          list: () =>
            connectionNames.map((name) => ({ name, config_json: '{}', subtype: null })),
        }) as never,
    });
    expect(slice).toBeDefined();
    handlers = slice!.handlers;
  };

  const seedProposal = (
    overrides: Partial<ScopedGrantSuggestionRow> = {},
  ): ScopedGrantSuggestionRow => {
    const snap = overrides.snapshot ?? snapshot();
    const key_hash = overrides.key_hash ?? scopedGrantSuggestionKeyHash(snap);
    const row: ScopedGrantSuggestionRow = {
      key_hash,
      state: 'open',
      snapshot: snap,
      triggering_excerpt: REQUEST,
      connection_candidates: ['mailbox-1'],
      created_at: NOW,
      updated_at: NOW,
      ...overrides,
    };
    store.put(SCOPED_GRANT_SUGGESTION_SCOPE, [row.key_hash], row);
    return row;
  };

  beforeEach(() => {
    connectionNames = ['mailbox-1'];
    const bindingStore = createConnectionCatalogBindingStore(store);
    bindingStore.bind('mailbox-1', 'mailbox-catalog', 'pack-1');
    buildHandlers();
  });

  const accept = (args: { key_hash: string; connection_name?: string; ttl_ms?: number; max_uses?: number }) =>
    handlers['collection.contract.acceptScopedGrantSuggestion'](args, CLIENT) as Promise<{
      grant: { contract_id: string; lifecycle_state: string };
      suggestion: ScopedGrantSuggestionRow;
      sentence: string;
    }>;
  const dismiss = (args: { key_hash: string }) =>
    handlers['collection.contract.dismissScopedGrantSuggestion'](args, CLIENT) as Promise<{
      suggestion: ScopedGrantSuggestionRow;
    }>;

  it('accepts: auto-fills the sole live candidate, mints, flips, audits, broadcasts', async () => {
    const row = seedProposal();
    const result = await accept({ key_hash: row.key_hash });
    expect(result.grant.lifecycle_state).toBe('active');
    expect(result.suggestion.state).toBe('accepted');
    expect(result.sentence).toContain('mail.reply on mailbox-1');
    const minted = defStore.get(result.grant.contract_id);
    expect(minted?.grant_mode).toBe('scoped');
    expect(minted?.scope.connection_names).toEqual(['mailbox-1']);
    expect(minted?.approved_action_ref).toBe(row.key_hash);
    expect(auditRows.map((r) => r.action)).toContain('scoped_grant_minted');
    expect(broadcasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'contract.contract_definition_changed' }),
        expect.objectContaining({
          kind: 'contract.scoped_grant_suggestion_resolved',
          resolution: 'accepted',
        }),
      ]),
    );
    // tightened bounds land on the row
    expect(minted?.expiry_at).toBe(now + snapshot().ttl_ms);
    expect(minted?.max_uses).toBe(SCOPED_GRANT_MAX_USES_DEFAULT);
  });

  it('accept is idempotent across retries (twin found by anchor)', async () => {
    const row = seedProposal();
    const first = await accept({ key_hash: row.key_hash });
    const second = await accept({ key_hash: row.key_hash });
    expect(second.grant.contract_id).toBe(first.grant.contract_id);
    expect(defStore.listSessionGrants('chat:s-1')).toHaveLength(1);
  });

  it('requires connection_name with multiple live candidates and validates membership', async () => {
    connectionNames = ['mailbox-1', 'mailbox-2'];
    const bindingStore = createConnectionCatalogBindingStore(store);
    bindingStore.bind('mailbox-2', 'mailbox-catalog', 'pack-1');
    const row = seedProposal();
    await expect(accept({ key_hash: row.key_hash })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(
      accept({ key_hash: row.key_hash, connection_name: 'unrelated' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    const result = await accept({
      key_hash: row.key_hash,
      connection_name: 'mailbox-2',
    });
    expect(
      defStore.get(result.grant.contract_id)?.scope.connection_names,
    ).toEqual(['mailbox-2']);
  });

  it('refuses unmintable (zero live candidates) even when the parse-time snapshot had one', async () => {
    connectionNames = [];
    const row = seedProposal();
    await expect(accept({ key_hash: row.key_hash })).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(suggestionStore.get(row.key_hash)?.state).toBe('open');
  });

  it('enforces tighten-only bounds against the card', async () => {
    const row = seedProposal();
    await expect(
      accept({ key_hash: row.key_hash, ttl_ms: snapshot().ttl_ms + 1 }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      accept({
        key_hash: row.key_hash,
        max_uses: SCOPED_GRANT_MAX_USES_DEFAULT + 1,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    const result = await accept({
      key_hash: row.key_hash,
      ttl_ms: HOUR_MS,
      max_uses: 2,
    });
    const minted = defStore.get(result.grant.contract_id);
    expect(minted?.expiry_at).toBe(now + HOUR_MS);
    expect(minted?.max_uses).toBe(2);
    expect(result.sentence).toContain('for 1 hour, up to 2 times?');
  });

  it('refuses a snapshot that does not derive its key (malformed row)', async () => {
    const row = seedProposal();
    const tampered = {
      ...row,
      snapshot: { ...row.snapshot, operation_id: 'mail.other' },
    };
    db.prepare(
      'UPDATE contract_store SET value_inline = ? WHERE scope = ? AND seg_key = ?',
    ).run(JSON.stringify(tampered), SCOPED_GRANT_SUGGESTION_SCOPE, row.key_hash);
    await expect(accept({ key_hash: row.key_hash })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('dismiss is permanent + idempotent; an accepted key refuses with a revoke pointer', async () => {
    const row = seedProposal();
    await dismiss({ key_hash: row.key_hash });
    expect(suggestionStore.get(row.key_hash)?.state).toBe('dismissed');
    // idempotent retry
    await dismiss({ key_hash: row.key_hash });
    // a dismissed key never accepts
    await expect(accept({ key_hash: row.key_hash })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('dismiss heals an orphan (mint landed, flip crashed) to accepted and refuses', async () => {
    const row = seedProposal();
    // simulate the crash window: mint with the anchor but leave the row open
    defStore.mintScopedSessionGrant(mintInput({ approved_action_ref: row.key_hash }));
    await expect(dismiss({ key_hash: row.key_hash })).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(suggestionStore.get(row.key_hash)?.state).toBe('accepted');
  });

  it('lists every state for the panel', async () => {
    const a = seedProposal();
    const b = seedProposal({
      snapshot: snapshot({ channel_session_id: 'chat:s-2' }),
    });
    await dismiss({ key_hash: b.key_hash });
    const result = (await handlers['collection.contract.listScopedGrantSuggestions'](
      undefined,
      CLIENT,
    )) as { suggestions: ScopedGrantSuggestionRow[] };
    expect(result.suggestions.map((s) => s.key_hash).sort()).toEqual(
      [a.key_hash, b.key_hash].sort(),
    );
  });
});
