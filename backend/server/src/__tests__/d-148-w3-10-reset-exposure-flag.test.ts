/** D-148 W3.10 — `--reset-exposure` boot-flag failsafe acceptance.
 *
 *  Covers the recovery surface for the per-path exposure state machine.
 *  The boot flag wraps the W3.9 SQLite store so an operator can recover
 *  from a /ws lockout (Mary typed the disconnect phrase + applied
 *  maintenance preset; no other admin channel) by restarting with
 *  `recued serve --reset-exposure`.
 *
 *  Coverage:
 *    1. resetRequested=false + empty store → bootstrap saved as new row;
 *       reset flag returns false.
 *    2. resetRequested=false + existing row → existing state returned
 *       verbatim; reset flag false.
 *    3. resetRequested=true + existing lockout row → row overwritten
 *       with bootstrap shape + CLI-reset metadata; reset flag true.
 *    4. resetRequested=true + empty store → bootstrap saved with
 *       CLI-reset metadata; reset flag true.
 *    5. CLI-reset metadata: `changed_by_client_id = 'system:cli_reset'`;
 *       `reason = '--reset-exposure boot flag'`; `last_changed_at`
 *       uses injected clock.
 *    6. Audit emit: single high-assurance row with action
 *       `exposure_reset_via_cli` carrying the resolved resolution.
 *    7. Audit emit failure tolerance: a throwing recordAudit does NOT
 *       block the recovery — the store still updates + the helper
 *       reports reset=true.
 *    8. Closed-list ratchet: action membership in
 *       HIGH_ASSURANCE_AUDIT_KINDS + ActivityAction union.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  HIGH_ASSURANCE_AUDIT_KINDS,
  type ExposureState,
} from '@recued/contracts';
import { isReserveAction } from '@recued/storage';
import {
  createSqliteExposureStore,
  ensureExposureSchema,
} from '../exposure/sqlite-store.js';
import {
  applyResetExposureBoot,
  CLI_RESET_CLIENT_ID,
  CLI_RESET_REASON,
  EXPOSURE_RESET_AUDIT_ACTION,
  type ResetAuditPayload,
} from '../exposure/reset-flag.js';
import {
  createInMemoryExposureStore,
  DEFAULT_EXPOSURE_STATE,
} from '../exposure/index.js';
import { deriveBootstrapDerivedExposureState } from '../exposure/bootstrap.js';
import { getFlag } from '../cli/parse.js';

const BOOTSTRAP_AT_TEST_START = 1_700_000_000_000;

const makeBootstrap = (): ExposureState =>
  deriveBootstrapDerivedExposureState({
    webhook_port: 0,
    public_reachable: false,
  });

const lockoutShape = (): ExposureState => ({
  resolution: {
    health: { lan: false, public: false },
    ws: { lan: false, public: false },
    mcp: { lan: false, public: false },
    llm_gateway: { lan: false, public: false },
    webhooks: { lan: false, public: false },
    reception: { lan: false, public: false },
    oauth: { lan: false, public: false },
    ask: { lan: false, public: false },
    webclient: { lan: false, public: false },
  },
  derived_preset_label: 'maintenance',
  public_mcp_acknowledgement: { acknowledged: false },
  last_changed_at: BOOTSTRAP_AT_TEST_START - 1_000,
  changed_by_client_id: 'admin-1',
  reason: 'maintenance window',
});

describe('W3.10 — applyResetExposureBoot (no-reset path)', () => {
  it('resetRequested=false + empty store saves bootstrap + returns reset=false', async () => {
    const store = createInMemoryExposureStore();
    const bootstrap = makeBootstrap();
    const outcome = await applyResetExposureBoot({
      store,
      bootstrap,
      resetRequested: false,
    });
    expect(outcome.reset).toBe(false);
    expect(outcome.persisted).toEqual(bootstrap);
    expect(await store.load()).toEqual(bootstrap);
  });

  it('resetRequested=false + existing row returns loaded state verbatim', async () => {
    const existing = lockoutShape();
    const store = createInMemoryExposureStore(existing);
    const outcome = await applyResetExposureBoot({
      store,
      bootstrap: makeBootstrap(),
      resetRequested: false,
    });
    expect(outcome.reset).toBe(false);
    expect(outcome.persisted).toEqual(existing);
  });

  it('resetRequested=false never emits an audit row', async () => {
    const store = createInMemoryExposureStore(lockoutShape());
    const audits: ResetAuditPayload[] = [];
    await applyResetExposureBoot({
      store,
      bootstrap: makeBootstrap(),
      resetRequested: false,
      recordAudit: async (p) => {
        audits.push(p);
      },
    });
    expect(audits).toHaveLength(0);
  });
});

describe('W3.10 — applyResetExposureBoot (reset path)', () => {
  it('resetRequested=true + lockout row overwrites with bootstrap shape', async () => {
    const store = createInMemoryExposureStore(lockoutShape());
    const bootstrap = makeBootstrap();
    const outcome = await applyResetExposureBoot({
      store,
      bootstrap,
      resetRequested: true,
      now: () => BOOTSTRAP_AT_TEST_START,
    });
    expect(outcome.reset).toBe(true);
    // /ws.lan recovered (Mary's admin channel restored).
    expect(outcome.persisted.resolution.ws.lan).toBe(true);
    // Public MCP demoted (bootstrap never carries an ack).
    expect(outcome.persisted.public_mcp_acknowledgement.acknowledged).toBe(false);
    expect(outcome.persisted.resolution.mcp.public).toBe(false);
    // Store reflects the saved state.
    expect(await store.load()).toEqual(outcome.persisted);
  });

  it('resetRequested=true forces changed_by_client_id + reason + uses injected clock', async () => {
    const store = createInMemoryExposureStore(lockoutShape());
    const outcome = await applyResetExposureBoot({
      store,
      bootstrap: makeBootstrap(),
      resetRequested: true,
      now: () => BOOTSTRAP_AT_TEST_START,
    });
    expect(outcome.persisted.changed_by_client_id).toBe(CLI_RESET_CLIENT_ID);
    expect(outcome.persisted.reason).toBe(CLI_RESET_REASON);
    expect(outcome.persisted.last_changed_at).toBe(BOOTSTRAP_AT_TEST_START);
  });

  it('resetRequested=true emits one audit row with action exposure_reset_via_cli', async () => {
    const store = createInMemoryExposureStore(lockoutShape());
    const audits: ResetAuditPayload[] = [];
    await applyResetExposureBoot({
      store,
      bootstrap: makeBootstrap(),
      resetRequested: true,
      now: () => BOOTSTRAP_AT_TEST_START,
      recordAudit: async (p) => {
        audits.push(p);
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe(EXPOSURE_RESET_AUDIT_ACTION);
    expect(audits[0]!.changed_by_client_id).toBe(CLI_RESET_CLIENT_ID);
    expect(audits[0]!.reason).toBe(CLI_RESET_REASON);
    expect(audits[0]!.applied_at).toBe(BOOTSTRAP_AT_TEST_START);
    expect(audits[0]!.resolution.ws.lan).toBe(true);
  });

  it('resetRequested=true on an empty store still saves bootstrap with CLI-reset metadata', async () => {
    const store = createInMemoryExposureStore();
    const audits: ResetAuditPayload[] = [];
    const outcome = await applyResetExposureBoot({
      store,
      bootstrap: makeBootstrap(),
      resetRequested: true,
      now: () => BOOTSTRAP_AT_TEST_START,
      recordAudit: async (p) => {
        audits.push(p);
      },
    });
    expect(outcome.reset).toBe(true);
    expect(outcome.persisted.changed_by_client_id).toBe(CLI_RESET_CLIENT_ID);
    expect(audits).toHaveLength(1);
  });

  it('audit emit failure does NOT block the reset', async () => {
    const store = createInMemoryExposureStore(lockoutShape());
    const logs: string[] = [];
    const outcome = await applyResetExposureBoot({
      store,
      bootstrap: makeBootstrap(),
      resetRequested: true,
      now: () => BOOTSTRAP_AT_TEST_START,
      recordAudit: async () => {
        throw new Error('audit substrate wedged');
      },
      log: (m) => logs.push(m),
    });
    expect(outcome.reset).toBe(true);
    expect(outcome.persisted.resolution.ws.lan).toBe(true);
    // The store reflects the recovery; only the audit emit failed.
    expect(await store.load()).toEqual(outcome.persisted);
    // Helper logged the audit-emit failure.
    expect(logs.some((m) => m.includes('audit emit failed'))).toBe(true);
  });

  it('store.save throw propagates (recovery must visibly fail when persistence fails)', async () => {
    const store = {
      load: async () => null,
      save: async () => {
        throw new Error('disk full');
      },
    };
    await expect(
      applyResetExposureBoot({
        store,
        bootstrap: makeBootstrap(),
        resetRequested: true,
      }),
    ).rejects.toThrow('disk full');
  });
});

// ────────────────────────────────────────────────────────────────
// SQLite end-to-end — bin.ts wiring shape
// ────────────────────────────────────────────────────────────────

describe('W3.10 — SQLite end-to-end recovery', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureExposureSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('a real SQLite lockout row is overwritten by --reset-exposure', async () => {
    const store = createSqliteExposureStore(db);
    // Pre-seed a lockout row that would brick Mary's admin access.
    await store.save(lockoutShape());
    // Confirm the lockout is persisted.
    const before = await store.load();
    expect(before?.resolution.ws.lan).toBe(false);
    expect(before?.resolution.ws.public).toBe(false);

    // Mary restarts with --reset-exposure.
    const bootstrap = makeBootstrap();
    const audits: ResetAuditPayload[] = [];
    const outcome = await applyResetExposureBoot({
      store,
      bootstrap,
      resetRequested: true,
      now: () => BOOTSTRAP_AT_TEST_START,
      recordAudit: async (p) => {
        audits.push(p);
      },
    });
    expect(outcome.reset).toBe(true);

    // Fresh read confirms the row is now the recovered shape.
    const fresh = createSqliteExposureStore(db);
    const after = await fresh.load();
    expect(after?.resolution.ws.lan).toBe(true);
    expect(after?.changed_by_client_id).toBe(CLI_RESET_CLIENT_ID);
    expect(after?.reason).toBe(CLI_RESET_REASON);
    expect(audits).toHaveLength(1);
  });

  it('subsequent boot without the flag loads the recovered state normally', async () => {
    const store = createSqliteExposureStore(db);
    await store.save(lockoutShape());
    await applyResetExposureBoot({
      store,
      bootstrap: makeBootstrap(),
      resetRequested: true,
      now: () => BOOTSTRAP_AT_TEST_START,
    });
    // Simulate a restart: fresh store, fresh helper, NO reset flag.
    const restart = createSqliteExposureStore(db);
    const outcome = await applyResetExposureBoot({
      store: restart,
      bootstrap: makeBootstrap(),
      resetRequested: false,
    });
    expect(outcome.reset).toBe(false);
    expect(outcome.persisted.resolution.ws.lan).toBe(true);
    expect(outcome.persisted.changed_by_client_id).toBe(CLI_RESET_CLIENT_ID);
  });
});

// ────────────────────────────────────────────────────────────────
// Closed-list ratchet
// ────────────────────────────────────────────────────────────────

describe('W3.10 — closed-list ratchet', () => {
  it('exposure_reset_via_cli is in HIGH_ASSURANCE_AUDIT_KINDS', () => {
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has(EXPOSURE_RESET_AUDIT_ACTION)).toBe(true);
  });

  it('exposure_reset_via_cli is a reserve-class action', () => {
    expect(isReserveAction(EXPOSURE_RESET_AUDIT_ACTION)).toBe(true);
  });

  it('CLI_RESET_CLIENT_ID + CLI_RESET_REASON are stable string literals', () => {
    // Locked at the type level via `as const`; pin the values too so
    // downstream auditors / log scrapers don't need to chase renames.
    expect(CLI_RESET_CLIENT_ID).toBe('system:cli_reset');
    expect(CLI_RESET_REASON).toBe('--reset-exposure boot flag');
    expect(EXPOSURE_RESET_AUDIT_ACTION).toBe('exposure_reset_via_cli');
  });
});

// ────────────────────────────────────────────────────────────────
// Default-state sanity (DEFAULT_EXPOSURE_STATE has /ws.lan true)
// ────────────────────────────────────────────────────────────────

describe('W3.10 — bootstrap discipline', () => {
  it('DEFAULT_EXPOSURE_STATE has /ws.lan true (recovery target sanity)', () => {
    expect(DEFAULT_EXPOSURE_STATE.resolution.ws.lan).toBe(true);
  });

  it('deriveBootstrapDerivedExposureState({webhook_port:0,public_reachable:false}) also has /ws.lan true', () => {
    const b = deriveBootstrapDerivedExposureState({
      webhook_port: 0,
      public_reachable: false,
    });
    expect(b.resolution.ws.lan).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Codex W3.10 P1 fold — daemon arg forwarding
// ────────────────────────────────────────────────────────────────

describe('W3.10 Codex P1 fold — daemon dispatch forwards --reset-exposure', () => {
  // Replays the bin.ts switch shape: when --reset-exposure is in the
  // operator's args, the daemon's extraArgs must carry it so the
  // spawned child boots with the flag and the helper sees
  // resetRequested=true. Without this fold, `recued-server start
  // --reset-exposure` and `restart --reset-exposure` would dispatch
  // to daemonStart/daemonRestart with extraArgs=[] and the child's
  // cmdServe would never observe the flag.
  it('extraArgs carries --reset-exposure when getFlag matches', () => {
    const args = ['start', '--reset-exposure'];
    const extraArgs: string[] = [];
    if (getFlag(args, 'reset-exposure')) extraArgs.push('--reset-exposure');
    expect(extraArgs).toEqual(['--reset-exposure']);
  });

  it('extraArgs stays empty when the flag is absent', () => {
    const args = ['start'];
    const extraArgs: string[] = [];
    if (getFlag(args, 'reset-exposure')) extraArgs.push('--reset-exposure');
    expect(extraArgs).toEqual([]);
  });

  it('extraArgs forwards on `restart` too (not just `start`)', () => {
    const args = ['restart', '--reset-exposure'];
    const extraArgs: string[] = [];
    if (getFlag(args, 'reset-exposure')) extraArgs.push('--reset-exposure');
    expect(extraArgs).toEqual(['--reset-exposure']);
  });
});

/** ⚠ FOUND BY MUTATION (2026-09-17). 16 mutations of `reset-flag.ts`; 12 were
 *  caught. The four that survived were all of one kind — the helper's three
 *  defensive copies and the identity of its timestamp — because no existing
 *  test keeps a reference across the call or advances the clock during it.
 *
 *  This helper is the LOCKOUT RECOVERY path: its return value seeds the live
 *  state machine, and its audit payload is the only forensic record of what
 *  the operator recovered to. Structure shared between those two and the
 *  caller's own bootstrap means a later write to any one of them silently
 *  edits the others. */
describe('W3.10 — the recovery result shares no mutable structure', () => {
  it('⛔ neither the caller\'s bootstrap nor the audit payload aliases the persisted state', async () => {
    const bootstrap = makeBootstrap();
    let seen: ResetAuditPayload | null = null;
    const outcome = await applyResetExposureBoot({
      store: createInMemoryExposureStore(),
      bootstrap,
      resetRequested: true,
      recordAudit: async (payload) => {
        seen = payload;
      },
      now: () => BOOTSTRAP_AT_TEST_START,
    });
    expect(outcome.reset).toBe(true);
    const wsLanAtReset = outcome.persisted.resolution.ws.lan;
    const ackAtReset = outcome.persisted.public_mcp_acknowledgement.acknowledged;
    expect(seen).not.toBeNull();

    // The caller keeps its own bootstrap object and is entitled to reuse it.
    bootstrap.resolution.ws.lan = !wsLanAtReset;
    bootstrap.public_mcp_acknowledgement.acknowledged = !ackAtReset;
    expect(
      outcome.persisted.resolution.ws.lan,
      'writing to the caller\'s bootstrap changed the recovered state',
    ).toBe(wsLanAtReset);
    expect(
      outcome.persisted.public_mcp_acknowledgement.acknowledged,
      'writing to the caller\'s bootstrap changed the recovered acknowledgement',
    ).toBe(ackAtReset);

    // An audit writer that batches or normalises holds its payload.
    const payload = seen as unknown as ResetAuditPayload;
    payload.resolution.ws.lan = !wsLanAtReset;
    expect(
      outcome.persisted.resolution.ws.lan,
      'the audit writer wrote through its payload into the recovered state',
    ).toBe(wsLanAtReset);
  });

  it('⛔ the audit row is stamped at the SAME instant as the state it records', async () => {
    // ⚠ Every existing test injects a CONSTANT clock, so `applied_at: at` and
    // a second `now()` call are indistinguishable — the mutation survived.
    // With a moving clock they are not: the forensic trail would place the
    // reset at a different instant than the state it recorded, and this is
    // the one row saying how the operator got out of a lockout.
    let t = BOOTSTRAP_AT_TEST_START;
    let seen: ResetAuditPayload | null = null;
    const outcome = await applyResetExposureBoot({
      store: createInMemoryExposureStore(),
      bootstrap: makeBootstrap(),
      resetRequested: true,
      recordAudit: async (payload) => {
        seen = payload;
      },
      now: () => ++t,
    });
    const payload = seen as unknown as ResetAuditPayload;
    expect(payload.applied_at).toBe(outcome.persisted.last_changed_at);
  });
});

