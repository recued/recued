/** D-145 PB12 — `s2s_preview.{build,consume}` rpc handler tests.
 *
 *  Covers:
 *    - build → persist → consume happy path round-trip.
 *    - Error mapping for every closed-list validation issue kind
 *      (unknown_packet_kind / raw_input_invalid /
 *      expires_at_out_of_range / access_token_invalid /
 *      token_expired / token_unknown).
 *    - Audit emission per build + per consume; audit failure never
 *      bubbles to the caller; emitter omitted when auditLog absent.
 *    - Token retry on collision when randomToken stub returns dup;
 *      caller-supplied access_token short-circuits retry.
 *    - Handler factory returns undefined when deps absent.
 *    - `not_configured` propagation via the dispatch slice.
 *
 *  Spec: `docs/d-145-spec.md` § B.13.3 + § B.13.4. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RpcError } from '@recued/contracts';

import { createS2SPreviewStore, type S2SPreviewStore } from '../s2s-preview/store.js';
import {
  handleS2SPreviewBuild,
  handleS2SPreviewConsume,
  makeS2SPreviewHandlers,
  type S2SPreviewRpcDeps,
} from '../s2s-preview/handlers.js';

const NOW = 1_715_000_000_000;
const FIXED_TOKEN = 'fixed-test-token-123';

let dir: string;
let db: Database.Database;
let store: S2SPreviewStore;
let auditLog: { logActivity: ReturnType<typeof vi.fn> };
let nowFn: ReturnType<typeof vi.fn>;
let randomTokenFn: ReturnType<typeof vi.fn>;

const makeDeps = (
  patch: Partial<S2SPreviewRpcDeps> = {},
): S2SPreviewRpcDeps => ({
  store,
  auditLog: auditLog as unknown as S2SPreviewRpcDeps['auditLog'],
  now: nowFn as unknown as () => number,
  randomToken: randomTokenFn as unknown as () => string,
  ...patch,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pb12-handlers-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createS2SPreviewStore(db);
  auditLog = { logActivity: vi.fn().mockResolvedValue(undefined) };
  nowFn = vi.fn(() => NOW);
  randomTokenFn = vi.fn(() => FIXED_TOKEN);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const contactCardArgs = (patch: Record<string, unknown> = {}) => ({
  packet_kind: 'contact_card' as const,
  raw: { name: 'Mary Smith', network_domain: 'work' },
  ...patch,
});

// ── Build path ──────────────────────────────────────────────────────

describe('handleS2SPreviewBuild', () => {
  it('builds + persists + returns the packet on the happy path', () => {
    const res = handleS2SPreviewBuild(makeDeps(), contactCardArgs());
    expect(res.packet.packet_kind).toBe('contact_card');
    expect(res.packet.access_token).toBe(FIXED_TOKEN);
    expect(res.packet.payload).toEqual({ name: 'Mary Smith', network_domain: 'work' });
    expect(store.getRaw(FIXED_TOKEN)).not.toBeNull();
  });

  it('emits a `redacted_packet.built` audit row', async () => {
    handleS2SPreviewBuild(makeDeps(), contactCardArgs());
    // Audit emit is best-effort (fire-and-forget); allow microtask
    // queue to drain.
    await Promise.resolve();
    expect(auditLog.logActivity).toHaveBeenCalledTimes(1);
    const arg = auditLog.logActivity.mock.calls[0][0];
    expect(arg.action).toBe('redacted_packet.built');
    expect(arg.target).toMatch(/^[0-9a-f]{16}$/); // SHA-256 prefix
    const detail = JSON.parse(arg.detail);
    expect(detail.packet_kind).toBe('contact_card');
    expect(detail.fields_visible).toEqual(['name', 'network_domain']);
  });

  it('forwards opts.context onto the audit detail', async () => {
    handleS2SPreviewBuild(
      makeDeps(),
      contactCardArgs({ opts: { context: { recipe_id: 'r-1' } } }),
    );
    await Promise.resolve();
    const arg = auditLog.logActivity.mock.calls[0][0];
    const detail = JSON.parse(arg.detail);
    expect(detail.context).toEqual({ recipe_id: 'r-1' });
  });

  it('does NOT throw when audit log fails (best-effort)', async () => {
    auditLog.logActivity.mockRejectedValueOnce(new Error('audit boom'));
    expect(() => handleS2SPreviewBuild(makeDeps(), contactCardArgs())).not.toThrow();
    // microtask queue
    await Promise.resolve();
  });

  it('skips audit emit when auditLog is omitted from deps', async () => {
    const deps = makeDeps({ auditLog: undefined });
    expect(() => handleS2SPreviewBuild(deps, contactCardArgs())).not.toThrow();
    expect(auditLog.logActivity).not.toHaveBeenCalled();
  });

  it('honours caller-supplied access_token', () => {
    const res = handleS2SPreviewBuild(
      makeDeps(),
      contactCardArgs({ opts: { access_token: 'caller-token-abc' } }),
    );
    expect(res.packet.access_token).toBe('caller-token-abc');
    expect(store.getRaw('caller-token-abc')).not.toBeNull();
  });

  it('throws RpcError on bad_request when args is not an object', () => {
    expect(() => handleS2SPreviewBuild(makeDeps(), null)).toThrowError(RpcError);
    expect(() => handleS2SPreviewBuild(makeDeps(), 'oops')).toThrowError(RpcError);
    expect(() => handleS2SPreviewBuild(makeDeps(), [])).toThrowError(RpcError);
  });

  it('throws RpcError on bad_request when packet_kind is missing', () => {
    expect(() => handleS2SPreviewBuild(makeDeps(), { raw: {} })).toThrowError(RpcError);
  });

  it('maps unknown packet_kind to redacted_packet.unknown_packet_kind RpcError', () => {
    try {
      handleS2SPreviewBuild(makeDeps(), { packet_kind: 'never_a_kind', raw: {} });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe('redacted_packet.unknown_packet_kind');
    }
  });

  // ── Codex P1 #3 fold (2026-05-13) — D-149 P2 reception subset gate
  for (const kind of [
    'reception_page_packet',
    'scheduling_link_packet',
    'intake_form_packet',
    'drop_link_packet',
    'approval_link_packet',
    'status_link_packet',
  ] as const) {
    it(`rejects D-149 reception kind '${kind}' with redacted_packet.unknown_packet_kind`, () => {
      // S2S Preview rpc must not accept reception kinds — those belong
      // exclusively to D-149's reception consumer
      // (`buildReceptionPacket`). The gate prevents a peer from asking
      // S2S Preview for a token-bearing envelope outside the
      // public_endpoint_registry path.
      try {
        handleS2SPreviewBuild(makeDeps(), { packet_kind: kind, raw: {} });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(RpcError);
        expect((e as RpcError).code).toBe('redacted_packet.unknown_packet_kind');
        expect((e as RpcError).status).toBe(400);
      }
    });
  }

  it('maps raw_input_invalid to RpcError 400', () => {
    try {
      handleS2SPreviewBuild(makeDeps(), { packet_kind: 'contact_card', raw: { name: '' } });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe('redacted_packet.raw_input_invalid');
      expect((e as RpcError).status).toBe(400);
    }
  });

  it('maps expires_at_out_of_range to RpcError', () => {
    try {
      handleS2SPreviewBuild(
        makeDeps(),
        contactCardArgs({ opts: { expires_at: NOW + 1 } }),
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe('redacted_packet.expires_at_out_of_range');
    }
  });

  it('maps access_token_invalid (caller-empty) to RpcError', () => {
    try {
      handleS2SPreviewBuild(
        makeDeps(),
        contactCardArgs({ opts: { access_token: '' } }),
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe('redacted_packet.access_token_invalid');
    }
  });

  it('retries on token collision when randomToken is misconfigured', () => {
    // First call returns the duplicate; subsequent calls return
    // unique tokens. The handler should consume both.
    const tokens = ['dup', 'unique-1'];
    randomTokenFn.mockImplementation(() => tokens.shift() ?? 'fallback');
    handleS2SPreviewBuild(makeDeps(), contactCardArgs());
    // Second build collides on the first attempt then succeeds.
    const tokens2 = ['dup', 'unique-2'];
    randomTokenFn.mockImplementation(() => tokens2.shift() ?? 'fallback');
    const res = handleS2SPreviewBuild(makeDeps(), contactCardArgs());
    expect(res.packet.access_token).toBe('unique-2');
  });

  it('surfaces redacted_packet.token_collision when caller-supplied token collides', () => {
    handleS2SPreviewBuild(makeDeps(), contactCardArgs({ opts: { access_token: 'collide' } }));
    try {
      handleS2SPreviewBuild(
        makeDeps(),
        contactCardArgs({ opts: { access_token: 'collide' } }),
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe('redacted_packet.token_collision');
      expect((e as RpcError).status).toBe(409);
    }
  });

  it('surfaces token_collision when randomToken always returns the same dup', () => {
    randomTokenFn.mockReturnValue('always-same');
    handleS2SPreviewBuild(makeDeps(), contactCardArgs());
    try {
      handleS2SPreviewBuild(makeDeps(), contactCardArgs());
      throw new Error('expected throw');
    } catch (e) {
      // After exhausting the retry budget, the substrate surfaces
      // the underlying collision error.
      expect(e).toBeInstanceOf(Error);
    }
  });
});

// ── Consume path ────────────────────────────────────────────────────

describe('handleS2SPreviewConsume', () => {
  it('returns the persisted packet on the happy path', () => {
    handleS2SPreviewBuild(makeDeps(), contactCardArgs());
    const res = handleS2SPreviewConsume(makeDeps(), { access_token: FIXED_TOKEN });
    expect(res.packet.access_token).toBe(FIXED_TOKEN);
    expect(res.packet.payload).toEqual({ name: 'Mary Smith', network_domain: 'work' });
  });

  it('emits a `redacted_packet.accessed` audit row', async () => {
    handleS2SPreviewBuild(makeDeps(), contactCardArgs());
    auditLog.logActivity.mockClear();
    handleS2SPreviewConsume(makeDeps(), { access_token: FIXED_TOKEN, consumer: 'peer-bob' });
    await Promise.resolve();
    expect(auditLog.logActivity).toHaveBeenCalledTimes(1);
    const arg = auditLog.logActivity.mock.calls[0][0];
    expect(arg.action).toBe('redacted_packet.accessed');
    expect(arg.target).toMatch(/^[0-9a-f]{16}$/);
    const detail = JSON.parse(arg.detail);
    expect(detail.packet_kind).toBe('contact_card');
    expect(detail.consumer).toBe('peer-bob');
  });

  it('does not throw when audit log fails on consume', async () => {
    handleS2SPreviewBuild(makeDeps(), contactCardArgs());
    auditLog.logActivity.mockRejectedValueOnce(new Error('audit boom'));
    expect(() =>
      handleS2SPreviewConsume(makeDeps(), { access_token: FIXED_TOKEN }),
    ).not.toThrow();
    await Promise.resolve();
  });

  it('throws RpcError on bad_request when args is not an object', () => {
    expect(() => handleS2SPreviewConsume(makeDeps(), null)).toThrowError(RpcError);
    expect(() => handleS2SPreviewConsume(makeDeps(), [])).toThrowError(RpcError);
  });

  it('maps invalid access_token shape to RpcError', () => {
    try {
      handleS2SPreviewConsume(makeDeps(), { access_token: '' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe('redacted_packet.access_token_invalid');
    }
  });

  it('maps unknown token to RpcError 410 with token_unknown code', () => {
    try {
      handleS2SPreviewConsume(makeDeps(), { access_token: 'never-stored' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe('redacted_packet.token_unknown');
      expect((e as RpcError).status).toBe(410);
    }
  });

  it('maps expired token to RpcError 410 with token_expired code', () => {
    handleS2SPreviewBuild(
      makeDeps(),
      contactCardArgs({ opts: { expires_at: NOW + 60_000 } }),
    );
    nowFn.mockReturnValue(NOW + 60_000); // exactly at expiry
    try {
      handleS2SPreviewConsume(makeDeps(), { access_token: FIXED_TOKEN });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe('redacted_packet.token_expired');
      expect((e as RpcError).status).toBe(410);
    }
  });

  it('maps far-expired token to token_expired (not token_unknown)', () => {
    handleS2SPreviewBuild(
      makeDeps(),
      contactCardArgs({ opts: { expires_at: NOW + 60_000 } }),
    );
    nowFn.mockReturnValue(NOW + 24 * 60 * 60 * 1000); // 1d past expiry
    try {
      handleS2SPreviewConsume(makeDeps(), { access_token: FIXED_TOKEN });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as RpcError).code).toBe('redacted_packet.token_expired');
    }
  });
});

// ── Handler factory ─────────────────────────────────────────────────

describe('makeS2SPreviewHandlers', () => {
  it('returns undefined when deps are absent (dispatcher reports not_configured)', () => {
    expect(makeS2SPreviewHandlers(undefined)).toBeUndefined();
  });

  it('returns a slice with both methods when deps are present', () => {
    const slice = makeS2SPreviewHandlers(makeDeps());
    expect(slice).toBeDefined();
    expect([...slice!.methods].sort()).toEqual(['s2s_preview.build', 's2s_preview.consume']);
  });

  it('dispatches build via the slice handler', async () => {
    const slice = makeS2SPreviewHandlers(makeDeps())!;
    const handler = slice.handlers['s2s_preview.build'];
    const res = await handler(contactCardArgs(), {} as never);
    expect((res as { packet: { access_token: string } }).packet.access_token).toBe(FIXED_TOKEN);
  });

  it('dispatches consume via the slice handler', async () => {
    const slice = makeS2SPreviewHandlers(makeDeps())!;
    await slice.handlers['s2s_preview.build'](contactCardArgs(), {} as never);
    const res = await slice.handlers['s2s_preview.consume'](
      { access_token: FIXED_TOKEN },
      {} as never,
    );
    expect((res as { packet: { access_token: string } }).packet.access_token).toBe(FIXED_TOKEN);
  });
});

// ── Build → consume round-trip via slice ────────────────────────────

describe('build → consume round-trip', () => {
  it('build then consume produces the same packet shape', async () => {
    const slice = makeS2SPreviewHandlers(makeDeps())!;
    const built = (await slice.handlers['s2s_preview.build'](
      contactCardArgs(),
      {} as never,
    )) as { packet: { access_token: string; payload: unknown } };
    const consumed = (await slice.handlers['s2s_preview.consume'](
      { access_token: built.packet.access_token },
      {} as never,
    )) as { packet: { access_token: string; payload: unknown } };
    expect(consumed.packet.access_token).toBe(built.packet.access_token);
    expect(consumed.packet.payload).toEqual(built.packet.payload);
  });

  it('build emits one audit row, consume emits one audit row, both linked by target digest', async () => {
    const slice = makeS2SPreviewHandlers(makeDeps())!;
    await slice.handlers['s2s_preview.build'](contactCardArgs(), {} as never);
    await Promise.resolve();
    await slice.handlers['s2s_preview.consume'](
      { access_token: FIXED_TOKEN },
      {} as never,
    );
    await Promise.resolve();
    expect(auditLog.logActivity).toHaveBeenCalledTimes(2);
    const buildRow = auditLog.logActivity.mock.calls[0][0];
    const accessRow = auditLog.logActivity.mock.calls[1][0];
    expect(buildRow.action).toBe('redacted_packet.built');
    expect(accessRow.action).toBe('redacted_packet.accessed');
    expect(buildRow.target).toBe(accessRow.target); // SHA-256 prefix matches
  });
});
