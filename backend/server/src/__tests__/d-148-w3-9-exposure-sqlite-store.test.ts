/** D-148 W3.9 — SQLite-backed `ExposureStateStore` acceptance.
 *
 *  Coverage:
 *    1. Schema: `ensureExposureSchema` is idempotent; the table lands
 *       with the closed-list shape; `EXPOSURE_TABLES` exposes exactly
 *       one name.
 *    2. CRUD round-trip: `load()` returns null on empty; `save(state)`
 *       upserts the singleton; subsequent `load()` returns the same
 *       shape; second `save()` replaces (no second row appears).
 *    3. Singleton CHECK: a manual write of `id = 2` is rejected by the
 *       table's CHECK constraint.
 *    4. Corrupted-row resilience: a row whose `state_json` is invalid
 *       JSON / fails the shape predicate returns `null` from `load()`;
 *       the next `save()` overwrites the bad row.
 *    5. State-machine integration: `createExposureStateMachine` wired
 *       to the SQLite store boots from `DEFAULT_EXPOSURE_STATE` on
 *       first call, persists transitions, and the persisted state
 *       round-trips through a fresh state machine + fresh store
 *       sharing the same db handle.
 *    6. Per-field optional handling: `reason` omission round-trips
 *       without a leaked `undefined`; `public_mcp_acknowledgement`
 *       extras (`acknowledged_at` / `acknowledged_by_client_id` /
 *       `free_text_confirmation`) round-trip when present.
 *    7. No-sync invariant: the table is per-pair only — surfaces in
 *       the `EXPOSURE_TABLES` closed-list inventory; never broadcast
 *       cross-cloud (D-097 / D-168).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  PATH_ROLES,
  type ExposureState,
} from '@recued/contracts';
import {
  EXPOSURE_TABLES,
  createSqliteExposureStore,
  ensureExposureSchema,
} from '../exposure/sqlite-store.js';
import {
  createExposureStateMachine,
  DEFAULT_EXPOSURE_STATE,
  type ActiveWsConnections,
  type DdnsAvailability,
  type ExposureSideEffects,
  type PathListenerCoordinator,
} from '../exposure/index.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  ensureExposureSchema(db);
});

afterEach(() => {
  db.close();
});

const cloneDefault = (): ExposureState => ({
  resolution: {
    health: { ...DEFAULT_EXPOSURE_STATE.resolution.health },
    ws: { ...DEFAULT_EXPOSURE_STATE.resolution.ws },
    mcp: { ...DEFAULT_EXPOSURE_STATE.resolution.mcp },
    llm_gateway: { ...DEFAULT_EXPOSURE_STATE.resolution.llm_gateway },
    webhooks: { ...DEFAULT_EXPOSURE_STATE.resolution.webhooks },
    reception: { ...DEFAULT_EXPOSURE_STATE.resolution.reception },
    oauth: { ...DEFAULT_EXPOSURE_STATE.resolution.oauth },
    ask: { ...DEFAULT_EXPOSURE_STATE.resolution.ask },
    webclient: { ...DEFAULT_EXPOSURE_STATE.resolution.webclient },
  },
  derived_preset_label: DEFAULT_EXPOSURE_STATE.derived_preset_label,
  public_mcp_acknowledgement: { ...DEFAULT_EXPOSURE_STATE.public_mcp_acknowledgement },
  last_changed_at: DEFAULT_EXPOSURE_STATE.last_changed_at,
  changed_by_client_id: DEFAULT_EXPOSURE_STATE.changed_by_client_id,
});

// ────────────────────────────────────────────────────────────────
// 1. Schema landing
// ────────────────────────────────────────────────────────────────

describe('W3.9 — ensureExposureSchema', () => {
  it('lands exactly the EXPOSURE_TABLES list', () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual([...EXPOSURE_TABLES].sort());
  });

  it('is idempotent — second call does not throw', () => {
    expect(() => ensureExposureSchema(db)).not.toThrow();
    expect(() => ensureExposureSchema(db)).not.toThrow();
  });

  it('CHECK rejects id != 1 (singleton invariant)', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (2, '{}', 0)`,
        )
        .run(),
    ).toThrow();
  });

  it('EXPOSURE_TABLES exposes exactly one table name', () => {
    expect([...EXPOSURE_TABLES]).toEqual(['exposure_state']);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. CRUD round-trip
// ────────────────────────────────────────────────────────────────

describe('W3.9 — load() / save() round-trip', () => {
  it('load() returns null on empty store', async () => {
    const store = createSqliteExposureStore(db);
    expect(await store.load()).toBeNull();
  });

  it('save() then load() returns the same shape', async () => {
    const store = createSqliteExposureStore(db);
    const state: ExposureState = {
      ...cloneDefault(),
      derived_preset_label: 'public',
      public_mcp_acknowledgement: {
        acknowledged: true,
        acknowledged_at: 1_700_000_000_000,
        acknowledged_by_client_id: 'admin-1',
        free_text_confirmation: 'enable public MCP',
      },
      resolution: {
        health: { lan: true, public: true },
        ws: { lan: true, public: true },
        mcp: { lan: true, public: true },
        llm_gateway: { lan: true, public: true },
        webhooks: { lan: true, public: true },
        reception: { lan: false, public: false },
        oauth: { lan: false, public: false },
        ask: { lan: false, public: false },
        webclient: { lan: true, public: false },
      },
      last_changed_at: 1_700_000_000_001,
      changed_by_client_id: 'admin-1',
      reason: 'open up to remote teammates',
    };
    await store.save(state);
    const loaded = await store.load();
    expect(loaded).toEqual(state);
  });

  it('second save() replaces — only one row in the table', async () => {
    const store = createSqliteExposureStore(db);
    await store.save({ ...cloneDefault(), last_changed_at: 1 });
    await store.save({ ...cloneDefault(), last_changed_at: 2 });
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM exposure_state`)
      .get() as { c: number };
    expect(count.c).toBe(1);
    const loaded = await store.load();
    expect(loaded?.last_changed_at).toBe(2);
  });

  it('round-trips a state without a `reason` (omission preserved)', async () => {
    const store = createSqliteExposureStore(db);
    const state = cloneDefault();
    await store.save(state);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect('reason' in (loaded as object)).toBe(false);
  });

  it('cross-instance load: a fresh store sharing the db handle observes the persisted row', async () => {
    const writer = createSqliteExposureStore(db);
    const state: ExposureState = {
      ...cloneDefault(),
      derived_preset_label: 'public',
      last_changed_at: 42,
      changed_by_client_id: 'admin-2',
    };
    await writer.save(state);
    const reader = createSqliteExposureStore(db);
    const loaded = await reader.load();
    expect(loaded).toEqual(state);
  });

  it('round-trips every PathRole — no role drops a bit on serialise', async () => {
    const store = createSqliteExposureStore(db);
    // The mcp.public bit here is paired with a well-formed acknowledged
    // ack so the W3.9 P1 fold's proof-invariant guard accepts the row.
    const state: ExposureState = {
      ...cloneDefault(),
      resolution: {
        health: { lan: true, public: false },
        ws: { lan: false, public: true },
        mcp: { lan: true, public: true },
        llm_gateway: { lan: true, public: false },
        webhooks: { lan: false, public: false },
        reception: { lan: true, public: false },
        oauth: { lan: false, public: false },
        ask: { lan: false, public: false },
        webclient: { lan: true, public: false },
      },
      public_mcp_acknowledgement: {
        acknowledged: true,
        free_text_confirmation: 'enable public MCP',
      },
    };
    await store.save(state);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    for (const role of PATH_ROLES) {
      expect(loaded!.resolution[role]).toEqual(state.resolution[role]);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Corrupted-row resilience
// ────────────────────────────────────────────────────────────────

describe('W3.9 — corrupted-row resilience', () => {
  it('load() returns null when state_json is invalid JSON', async () => {
    db.prepare(
      `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, '{not json', 1)`,
    ).run();
    const store = createSqliteExposureStore(db);
    expect(await store.load()).toBeNull();
  });

  it('load() returns null when state_json is valid JSON but missing required fields', async () => {
    db.prepare(
      `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, '{}', 1)`,
    ).run();
    const store = createSqliteExposureStore(db);
    expect(await store.load()).toBeNull();
  });

  it('load() returns null when derived_preset_label is not a known enum value', async () => {
    const bad = JSON.stringify({
      resolution: cloneDefault().resolution,
      derived_preset_label: 'bogus_label',
      public_mcp_acknowledgement: { acknowledged: false },
      last_changed_at: 0,
      changed_by_client_id: '',
    });
    db.prepare(
      `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, @s, 1)`,
    ).run({ s: bad });
    const store = createSqliteExposureStore(db);
    expect(await store.load()).toBeNull();
  });

  it('load() returns null when a path cell is missing', async () => {
    const partial = JSON.stringify({
      resolution: {
        health: { lan: true, public: false },
        ws: { lan: true, public: false },
        // mcp missing
        webhooks: { lan: false, public: false },
        reception: { lan: false, public: false },
      },
      derived_preset_label: 'lan_only',
      public_mcp_acknowledgement: { acknowledged: false },
      last_changed_at: 0,
      changed_by_client_id: '',
    });
    db.prepare(
      `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, @s, 1)`,
    ).run({ s: partial });
    const store = createSqliteExposureStore(db);
    expect(await store.load()).toBeNull();
  });

  it('⛔⛔ load() returns null when a path cell\'s bits are NOT BOOLEANS', async () => {
    // ⚠ FOUND BY MUTATION: relaxing `typeof lan === boolean && typeof public
    // === boolean` to `true` reddened nothing. Every existing corrupt-row case
    // removes or renames a field; none supplies one of the WRONG TYPE.
    //
    // ⛔ IT DECIDES WHAT REACHES THE INTERNET. A row saying `public: 1` or
    // `public: "no"` is truthy, so a hand-edited or half-migrated row would be
    // loaded as live exposure state and the listener would serve that path
    // publicly. Refusing the row falls back to the safe bootstrap instead.
    //
    // ⚠⚠ THE ROLE IS PART OF THE FIXTURE. A truthy-but-not-boolean `public` on
    // `mcp` is rejected by the public-MCP proof guard further down (truthy
    // `mcp.public` + ack off ⇒ null), so an `mcp` fixture passes this test
    // under a mutant that drops the `public` typecheck entirely — two rules
    // agreeing, and only one of them under test. The truthy cases therefore
    // sit on `ws`/`health`, which no later guard reads.
    for (const { role, cell } of [
      { role: 'ws', cell: { lan: true, public: 1 } },
      { role: 'ws', cell: { lan: true, public: 'false' } },
      { role: 'ws', cell: { lan: 1, public: true } },
      { role: 'health', cell: { lan: 'yes', public: false } },
      { role: 'health', cell: { lan: null, public: null } },
      { role: 'mcp', cell: { lan: true, public: 0 } },
    ] as const) {
      db.prepare('DELETE FROM exposure_state').run();
      const bad = JSON.stringify({
        resolution: { ...cloneDefault().resolution, [role]: cell },
        derived_preset_label: 'lan_only',
        public_mcp_acknowledgement: { acknowledged: false },
        last_changed_at: 0,
        changed_by_client_id: '',
      });
      db.prepare(
        `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, @s, 1)`,
      ).run({ s: bad });
      expect(
        await createSqliteExposureStore(db).load(),
        `${role} cell ${JSON.stringify(cell)} was loaded as live exposure state`,
      ).toBeNull();
    }
  });

  it('⛔⛔ load() returns null when `acknowledged` is not a boolean', async () => {
    // ⛔ THE MCP GATE READS THIS FIELD. A stored `acknowledged: "yes"` or `1` is
    // truthy, so a row that never carried a real acknowledgement would let the
    // public-MCP gate pass — the I-13 consent check satisfied by a type error.
    for (const ack of [
      { acknowledged: 'yes' },
      { acknowledged: 1 },
      { acknowledged: null },
      {},
    ]) {
      db.prepare('DELETE FROM exposure_state').run();
      const bad = JSON.stringify({
        resolution: cloneDefault().resolution,
        derived_preset_label: 'lan_only',
        public_mcp_acknowledgement: ack,
        last_changed_at: 0,
        changed_by_client_id: '',
      });
      db.prepare(
        `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, @s, 1)`,
      ).run({ s: bad });
      expect(
        await createSqliteExposureStore(db).load(),
        `an acknowledgement of ${JSON.stringify(ack)} was accepted`,
      ).toBeNull();
    }
  });

  it('next save() overwrites a corrupted row with valid shape', async () => {
    db.prepare(
      `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, '{not json', 1)`,
    ).run();
    const store = createSqliteExposureStore(db);
    expect(await store.load()).toBeNull();
    const fresh: ExposureState = { ...cloneDefault(), last_changed_at: 99 };
    await store.save(fresh);
    expect(await store.load()).toEqual(fresh);
  });
});

// ────────────────────────────────────────────────────────────────
// 3b. Codex W3.9 P1 fold — public-MCP proof invariant guards
// ────────────────────────────────────────────────────────────────

describe('W3.9 P1 fold — public-MCP proof invariant', () => {
  it('rejects a row whose ack is `acknowledged: true` but missing the phrase', async () => {
    const bad = JSON.stringify({
      resolution: cloneDefault().resolution,
      derived_preset_label: 'lan_only',
      public_mcp_acknowledgement: { acknowledged: true },
      last_changed_at: 0,
      changed_by_client_id: 'tampered',
    });
    db.prepare(
      `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, @s, 1)`,
    ).run({ s: bad });
    const store = createSqliteExposureStore(db);
    expect(await store.load()).toBeNull();
  });

  it('rejects a row whose ack has `acknowledged: true` with a non-canonical phrase', async () => {
    const bad = JSON.stringify({
      resolution: cloneDefault().resolution,
      derived_preset_label: 'lan_only',
      public_mcp_acknowledgement: {
        acknowledged: true,
        free_text_confirmation: 'enable public mcp now', // wrong phrase
      },
      last_changed_at: 0,
      changed_by_client_id: 'tampered',
    });
    db.prepare(
      `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, @s, 1)`,
    ).run({ s: bad });
    const store = createSqliteExposureStore(db);
    expect(await store.load()).toBeNull();
  });

  it('rejects a row whose `mcp.public: true` lacks an effectively-on ack', async () => {
    const tampered: ExposureState = {
      ...cloneDefault(),
      resolution: {
        health: { lan: true, public: false },
        ws: { lan: true, public: false },
        mcp: { lan: true, public: true }, // public bit on
        llm_gateway: { lan: true, public: false },
        webhooks: { lan: false, public: false },
        reception: { lan: false, public: false },
        oauth: { lan: false, public: false },
        ask: { lan: false, public: false },
        webclient: { lan: true, public: false },
      },
      public_mcp_acknowledgement: { acknowledged: false }, // but no ack
      derived_preset_label: 'custom',
      last_changed_at: 0,
      changed_by_client_id: 'tampered',
    };
    db.prepare(
      `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, @s, 1)`,
    ).run({ s: JSON.stringify(tampered) });
    const store = createSqliteExposureStore(db);
    expect(await store.load()).toBeNull();
  });

  it('accepts a row whose `mcp.public: true` carries a well-formed acknowledged ack', async () => {
    const good: ExposureState = {
      resolution: {
        health: { lan: true, public: true },
        ws: { lan: true, public: true },
        mcp: { lan: true, public: true },
        llm_gateway: { lan: true, public: true },
        webhooks: { lan: true, public: true },
        reception: { lan: false, public: false },
        oauth: { lan: false, public: false },
        ask: { lan: false, public: false },
        webclient: { lan: true, public: false },
      },
      derived_preset_label: 'public',
      public_mcp_acknowledgement: {
        acknowledged: true,
        acknowledged_at: 1_700_000_000_000,
        acknowledged_by_client_id: 'admin-1',
        free_text_confirmation: 'enable public MCP',
      },
      last_changed_at: 1_700_000_000_001,
      changed_by_client_id: 'admin-1',
    };
    db.prepare(
      `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, @s, 1)`,
    ).run({ s: JSON.stringify(good) });
    const store = createSqliteExposureStore(db);
    const loaded = await store.load();
    expect(loaded).toEqual(good);
  });

  it('a tampered row whose load() returns null causes the state machine to seed from DEFAULT_EXPOSURE_STATE on reapply()', async () => {
    const tampered = JSON.stringify({
      resolution: {
        health: { lan: true, public: true },
        ws: { lan: true, public: true },
        mcp: { lan: true, public: true },
        webhooks: { lan: true, public: true },
        reception: { lan: false, public: false },
      },
      derived_preset_label: 'public',
      public_mcp_acknowledgement: { acknowledged: true }, // no phrase
      last_changed_at: 0,
      changed_by_client_id: 'tampered',
    });
    db.prepare(
      `INSERT INTO exposure_state (id, state_json, updated_at) VALUES (1, @s, 1)`,
    ).run({ s: tampered });

    const store = createSqliteExposureStore(db);
    const machine = createExposureStateMachine({
      store,
      listener: makeListener(),
      effects: makeEffects(),
      ddns: makeDdns(true),
      bind_addresses: { lan: '192.168.1.42', public: '0.0.0.0' },
      activeWsConnections: makeActive(0),
    });
    // reapply() drives loadOrInit which seeds DEFAULT_EXPOSURE_STATE
    // when load() returns null. The tampered mcp.public bit cannot
    // survive — derived label collapses to lan_only.
    const state = await machine.reapply();
    expect(state.resolution.mcp.public).toBe(false);
    expect(state.public_mcp_acknowledgement.acknowledged).toBe(false);
    expect(state.derived_preset_label).toBe('lan_only');
  });
});

// ────────────────────────────────────────────────────────────────
// 4. State-machine integration
// ────────────────────────────────────────────────────────────────

const makeListener = (): PathListenerCoordinator => ({
  apply: async ({ resolution, bind_addresses }) => {
    const lanWanted = Object.values(resolution).some((r) => r.lan);
    const publicWanted = Object.values(resolution).some((r) => r.public);
    return {
      lan: {
        listening: lanWanted,
        bind_address: lanWanted ? bind_addresses.lan : null,
      },
      public: {
        listening: publicWanted,
        bind_address: publicWanted ? bind_addresses.public : null,
      },
    };
  },
});

const makeEffects = (): ExposureSideEffects => ({
  recordAudit: async () => {},
  broadcast: async () => {},
});

const makeDdns = (configured: boolean): DdnsAvailability => ({
  isConfigured: async () => configured,
});

const makeActive = (count: number): ActiveWsConnections => ({
  count: () => count,
});

describe('W3.9 — state machine + SQLite store integration', () => {
  it('first-boot machine seeds from DEFAULT_EXPOSURE_STATE when store is empty', async () => {
    const store = createSqliteExposureStore(db);
    const machine = createExposureStateMachine({
      store,
      listener: makeListener(),
      effects: makeEffects(),
      ddns: makeDdns(true),
      bind_addresses: { lan: '192.168.1.42', public: '0.0.0.0' },
      activeWsConnections: makeActive(0),
    });
    const state = await machine.current();
    expect(state.derived_preset_label).toBe('lan_only');
  });

  it('applyPreset transitions persist across a fresh machine + fresh store', async () => {
    const store = createSqliteExposureStore(db);
    const machine = createExposureStateMachine({
      store,
      listener: makeListener(),
      effects: makeEffects(),
      ddns: makeDdns(true),
      bind_addresses: { lan: '192.168.1.42', public: '0.0.0.0' },
      activeWsConnections: makeActive(0),
      clock: () => 12345,
    });
    const r = await machine.applyPreset({
      preset: 'lan_only',
      changed_by_client_id: 'admin-1',
      reason: 'baseline',
    });
    expect(r.ok).toBe(true);

    // Fresh store + fresh machine sharing the same db — the persisted
    // state from the first machine's save() must come back verbatim.
    const store2 = createSqliteExposureStore(db);
    const machine2 = createExposureStateMachine({
      store: store2,
      listener: makeListener(),
      effects: makeEffects(),
      ddns: makeDdns(true),
      bind_addresses: { lan: '192.168.1.42', public: '0.0.0.0' },
      activeWsConnections: makeActive(0),
    });
    const after = await machine2.current();
    expect(after.derived_preset_label).toBe('lan_only');
    expect(after.last_changed_at).toBe(12345);
    expect(after.changed_by_client_id).toBe('admin-1');
    expect(after.reason).toBe('baseline');
  });

  it('public_mcp_acknowledgement extras round-trip through the store', async () => {
    const store = createSqliteExposureStore(db);
    const machine = createExposureStateMachine({
      store,
      listener: makeListener(),
      effects: makeEffects(),
      ddns: makeDdns(true),
      bind_addresses: { lan: '192.168.1.42', public: '0.0.0.0' },
      activeWsConnections: makeActive(0),
      clock: () => 7777,
    });
    const ack = await machine.setPublicMcpAcknowledgement({
      acknowledge: true,
      free_text_confirmation: 'enable public MCP',
      changed_by_client_id: 'admin-2',
      reason: 'open up to remote teammates',
    });
    expect(ack.ok).toBe(true);

    const store2 = createSqliteExposureStore(db);
    const loaded = await store2.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.public_mcp_acknowledgement.acknowledged).toBe(true);
    expect(loaded!.public_mcp_acknowledgement.acknowledged_at).toBe(7777);
    expect(loaded!.public_mcp_acknowledgement.acknowledged_by_client_id).toBe('admin-2');
    expect(loaded!.public_mcp_acknowledgement.free_text_confirmation).toBe(
      'enable public MCP',
    );
  });
});
