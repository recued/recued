import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTRACT_DEFINITION_SCOPE, D165_CONTRACT_SCHEMA, type ExecutionSource, type UsageCapPeriod } from '@recued/contracts';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractStore } from '../storage/contract-store.js';
import type { GrantChildInput } from './helpers/session-grant-child.js';

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
const handles: Database.Database[] = [];
const fixture = (period: UsageCapPeriod = 'total') => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-use-refunds-')); dirs.push(dir);
  const database = join(dir, 'realm.sqlite');
  let clock = NOW;
  const open = () => {
    const db = new Database(database); handles.push(db); db.pragma('journal_mode = WAL');
    const store = createContractStore(db, { now: () => clock }); store.seedSchema(D165_CONTRACT_SCHEMA);
    const definitions = createContractDefinitionStore(store, { now: () => clock });
    const overlay = createContractOverlayResolver({ definitionStore: definitions, now: () => clock });
    return { db, store, definitions, overlay };
  };
  const env = open();
  const contract = env.definitions.mint({ minted_by: 'owner', display_name: 'Refund fixture', scope: { channels: ['mcp'] },
    door_types: ['mcp'], max_uses: 1, ...(period === 'total' ? {} : { use_period: period }) });
  const source: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'fixture-agent',
    tool_call_id: 'fixture-call', mcp_token_id: 'http_fixture', contract_id: contract.contract_id };
  const take = () => env.overlay.takeDispatchUse!(source, 'fixture-tool');
  const spend = (count = 1) => {
    for (let i = 0; i < count; i++) {
      const taken = take(); expect(taken.kind).toBe('taken'); env.overlay.settleDispatchUse!(taken, true);
    }
  };
  return { ...env, dir, database, contract, source, open, take, spend,
    advanceTo: (time: number) => { clock = time; }, left: () => env.definitions.get(contract.contract_id)?.uses_remaining };
};
afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('contract use refunds', () => {
  it.each(['day', 'month', 'owner-reset', 'owner-reset-back'] as const)('an old refund cannot add capacity after %s', kind => {
    const f = fixture(kind === 'day' || kind === 'month' ? kind : 'total');
    const oldTake = f.take(); expect(oldTake.kind).toBe('taken');
    let currentBudget = 1;
    if (kind === 'day') f.advanceTo(Date.UTC(2023, 10, 15, 1));
    else if (kind === 'month') f.advanceTo(Date.UTC(2023, 11, 1, 1));
    else {
      const other = f.open();
      other.definitions.setLimits(f.contract.contract_id, { max_uses: 2, use_period: 'total', expiry_at: null });
      currentBudget = 2;
      if (kind === 'owner-reset-back') {
        other.definitions.setLimits(f.contract.contract_id, { max_uses: 1, use_period: 'total', expiry_at: null });
        currentBudget = 1;
      }
    }
    f.spend(currentBudget);
    expect(f.take().kind).toBe('refused');
    f.overlay.settleDispatchUse!(oldTake, false);
    expect(f.left()).toBe(0);
    expect(f.take().kind).toBe('refused');
  });

  it('retains a legitimate refund when only expiry, read spheres and door types change', () => {
    const f = fixture(); const taken = f.take(); expect(taken.kind).toBe('taken');
    f.definitions.setLimits(f.contract.contract_id, { max_uses: 1, use_period: 'total', expiry_at: NOW + 60_000 });
    f.definitions.setReadSpheres(f.contract.contract_id, ['personal']);
    f.definitions.setDoorTypes(f.contract.contract_id, ['mcp_chat']);
    f.overlay.settleDispatchUse!(taken, false);
    expect(f.definitions.get(f.contract.contract_id)).toMatchObject({ uses_remaining: 1,
      expiry_at: NOW + 60_000, read_spheres: ['personal'], door_types: ['mcp_chat'] });
  });

  it('changing the period back still replaces the original budget', () => {
    const f = fixture(); const taken = f.take(); expect(taken.kind).toBe('taken');
    const other = f.open();
    other.definitions.setLimits(f.contract.contract_id, { max_uses: 1, use_period: 'day', expiry_at: null });
    other.definitions.setLimits(f.contract.contract_id, { max_uses: 1, use_period: 'total', expiry_at: null });
    f.spend(); f.overlay.settleDispatchUse!(taken, false);
    expect(f.left()).toBe(0);
    expect(f.take().kind).toBe('refused');
  });

  it('a monthly reservation still refunds after a day changes within its month', () => {
    const f = fixture('month'); const taken = f.take(); expect(taken.kind).toBe('taken');
    f.advanceTo(Date.UTC(2023, 10, 15, 1));
    f.overlay.settleDispatchUse!(taken, false);
    expect(f.left()).toBe(1);
    expect(f.take().kind).toBe('taken');
  });

  it('refuses missing and foreign refund receipts without changing either budget', () => {
    const f = fixture(); const first = f.definitions.reserveDispatchUse!(f.contract.contract_id)!;
    const other = f.definitions.mint({ minted_by: 'owner', display_name: 'Other agreement', scope: {}, max_uses: 1 });
    f.definitions.reserveDispatchUse!(other.contract_id);
    expect(f.definitions.releaseDispatchUse!(f.contract.contract_id)).toBe(false);
    expect(f.definitions.releaseDispatchUse!(other.contract_id, first.refund)).toBe(false);
    expect(f.left()).toBe(0);
    expect(f.definitions.get(other.contract_id)?.uses_remaining).toBe(0);
    expect(f.definitions.releaseDispatchUse!(f.contract.contract_id, first.refund)).toBe(true);
    expect(f.left()).toBe(1);
  });

  it('a rolled-back replacement does not invalidate a legitimate refund', () => {
    const f = fixture(); const taken = f.take(); expect(taken.kind).toBe('taken');
    expect(() => f.store.transaction(() => {
      f.definitions.setLimits(f.contract.contract_id, { max_uses: 2, use_period: 'total', expiry_at: null });
      throw new Error('Outer write failed');
    })).toThrow('Outer write failed');
    f.overlay.settleDispatchUse!(taken, false);
    expect(f.left()).toBe(1);
  });

  it('a failed native refund write remains atomic and can be retried', () => {
    const f = fixture(); const reserved = f.definitions.reserveDispatchUse!(f.contract.contract_id)!;
    f.db.exec(`CREATE TRIGGER fail_refund BEFORE UPDATE OF value_inline ON contract_store
      WHEN NEW.scope = '${CONTRACT_DEFINITION_SCOPE}' BEGIN SELECT RAISE(ABORT, 'Refund failed'); END`);
    expect(() => f.definitions.releaseDispatchUse!(f.contract.contract_id, reserved.refund)).toThrow('Refund failed');
    expect(f.left()).toBe(0); expect(f.db.inTransaction).toBe(false);
    f.db.exec('DROP TRIGGER fail_refund');
    expect(f.definitions.releaseDispatchUse!(f.contract.contract_id, reserved.refund)).toBe(true);
    expect(f.left()).toBe(1);
  });

  it('does not spend a use when storing its first refund version fails', () => {
    const f = fixture();
    f.db.exec("CREATE TRIGGER fail_version BEFORE INSERT ON contract_use_budget_versions BEGIN SELECT RAISE(ABORT, 'Version write failed'); END");
    expect(() => f.take()).toThrow('Version write failed');
    expect(f.left()).toBe(1); expect(f.db.inTransaction).toBe(false);
    f.db.exec('DROP TRIGGER fail_version');
    const taken = f.take(); expect(taken.kind).toBe('taken');
    f.overlay.settleDispatchUse!(taken, false); expect(f.left()).toBe(1);
  });

  it('rolls back a replacement if its version write fails and retains the original refund', () => {
    const f = fixture(); const taken = f.take(); expect(taken.kind).toBe('taken');
    f.db.exec("CREATE TRIGGER fail_version BEFORE UPDATE ON contract_use_budget_versions BEGIN SELECT RAISE(ABORT, 'Version write failed'); END");
    expect(() => f.definitions.setLimits(f.contract.contract_id,
      { max_uses: 2, use_period: 'total', expiry_at: null })).toThrow('Version write failed');
    expect(f.definitions.get(f.contract.contract_id)).toMatchObject({ max_uses: 1, uses_remaining: 0 });
    expect(f.db.inTransaction).toBe(false);
    f.overlay.settleDispatchUse!(taken, false); expect(f.left()).toBe(1);
  });

  it('keeps a valid refund binding when the native store is reopened', () => {
    const f = fixture(); const reserved = f.definitions.reserveDispatchUse!(f.contract.contract_id)!;
    f.db.close(); const reopened = f.open();
    expect(reopened.definitions.releaseDispatchUse!(f.contract.contract_id, reserved.refund)).toBe(true);
    expect(reopened.definitions.get(f.contract.contract_id)?.uses_remaining).toBe(1);
  });

  it('does not refund a replacement budget changed back by another process', () => {
    const f = fixture(); const taken = f.take(); expect(taken.kind).toBe('taken');
    for (const count of [2, 1]) {
      const marker = join(f.dir, 'edit-' + count);
      const input: GrantChildInput = { database: f.database, contract_id: f.contract.contract_id,
        operation: { kind: 'limits', limits: { max_uses: count, use_period: 'total', expiry_at: null } },
        marker, start: marker + '.start', release: marker + '.release', pause: false, now: NOW + 1 };
      const config = marker + '.json'; writeFileSync(config, JSON.stringify(input)); writeFileSync(input.start, '');
      const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/session-grant-child.ts', import.meta.url)), config], {
        cwd: process.cwd(), env: { ...process.env, TSX_TSCONFIG_PATH: resolve('tsconfig.base.json') }, encoding: 'utf8', timeout: 15_000,
      });
      expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(readFileSync(marker + '.result', 'utf8'))).toHaveProperty('value.max_uses', count);
    }
    f.spend(); f.overlay.settleDispatchUse!(taken, false);
    expect(f.left()).toBe(0);
    expect(f.take().kind).toBe('refused');
  });
});
