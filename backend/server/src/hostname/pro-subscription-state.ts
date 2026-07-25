/** D-152 P5 - minimal server-local Pro lifecycle state for DDNS soft holds. */

import { randomUUID } from 'node:crypto';

import { normalizeHostname } from '@recued/contracts';
import type Database from 'better-sqlite3';

export const PRO_DDNS_SOFT_HOLD_MS = 30 * 24 * 60 * 60 * 1000;

export const PRO_SUBSCRIPTION_STATE_TABLES = ['pro_subscription_state'] as const;

export type ProSubscriptionStateTableName =
  (typeof PRO_SUBSCRIPTION_STATE_TABLES)[number];

export type ProSubscriptionStatus = 'active' | 'soft_hold' | 'released';

export interface ProSubscriptionStateRow {
  state_id: string;
  publisher_id: string;
  hostname_normalized: string;
  status: ProSubscriptionStatus;
  soft_hold_until?: number;
  canceled_at?: number;
  released_at?: number;
  created_at: number;
  updated_at: number;
}

export const ensureProSubscriptionStateSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pro_subscription_state (
      state_id TEXT PRIMARY KEY,
      publisher_id TEXT NOT NULL,
      hostname_normalized TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'soft_hold', 'released')),
      soft_hold_until INTEGER,
      canceled_at INTEGER,
      released_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pro_subscription_state_by_status
      ON pro_subscription_state(status);
    CREATE INDEX IF NOT EXISTS pro_subscription_state_by_soft_hold_until
      ON pro_subscription_state(soft_hold_until);
  `);
};

export type ProSubscriptionStateErrorCode = 'invalid_hostname' | 'not_found';

export class ProSubscriptionStateError extends Error {
  constructor(
    public readonly code: ProSubscriptionStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProSubscriptionStateError';
  }
}

export interface BeginSoftHoldInput {
  publisher_id: string;
  hostname: string;
  canceled_at?: number;
}

export interface MarkReleasedInput {
  hostname: string;
  released_at?: number;
}

export interface MarkActiveInput {
  publisher_id: string;
  hostname: string;
  activated_at?: number;
}

export interface ProSubscriptionStateStore {
  beginSoftHold(input: BeginSoftHoldInput): ProSubscriptionStateRow;
  markReleased(input: MarkReleasedInput): ProSubscriptionStateRow | null;
  markActive(input: MarkActiveInput): ProSubscriptionStateRow;
  get(hostname: string): ProSubscriptionStateRow | null;
  listExpiredSoftHolds(now: number): ReadonlyArray<ProSubscriptionStateRow>;
  list(): ReadonlyArray<ProSubscriptionStateRow>;
}

export interface CreateProSubscriptionStateStoreOptions {
  now?: () => number;
  newId?: () => string;
}

interface ProSubscriptionStateDbRow {
  state_id: string;
  publisher_id: string;
  hostname_normalized: string;
  status: string;
  soft_hold_until: number | null;
  canceled_at: number | null;
  released_at: number | null;
  created_at: number;
  updated_at: number;
}

const normalizeOrThrow = (hostname: string): string => {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    throw new ProSubscriptionStateError(
      'invalid_hostname',
      `pro subscription state: invalid hostname '${hostname}'`,
    );
  }
  return normalized;
};

const rowToState = (row: ProSubscriptionStateDbRow): ProSubscriptionStateRow => {
  const out: ProSubscriptionStateRow = {
    state_id: row.state_id,
    publisher_id: row.publisher_id,
    hostname_normalized: row.hostname_normalized,
    status: row.status as ProSubscriptionStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.soft_hold_until !== null) out.soft_hold_until = row.soft_hold_until;
  if (row.canceled_at !== null) out.canceled_at = row.canceled_at;
  if (row.released_at !== null) out.released_at = row.released_at;
  return out;
};

export const createProSubscriptionStateStore = (
  db: Database.Database,
  options: CreateProSubscriptionStateStoreOptions = {},
): ProSubscriptionStateStore => {
  ensureProSubscriptionStateSchema(db);
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => randomUUID());

  const getByHostnameStmt = db.prepare<{ hostname_normalized: string }>(`
    SELECT * FROM pro_subscription_state WHERE hostname_normalized = @hostname_normalized
  `);
  const listStmt = db.prepare(`
    SELECT * FROM pro_subscription_state ORDER BY hostname_normalized ASC
  `);
  const listExpiredSoftHoldsStmt = db.prepare<{ now: number }>(`
    SELECT * FROM pro_subscription_state
     WHERE status = 'soft_hold'
       AND soft_hold_until IS NOT NULL
       AND soft_hold_until <= @now
     ORDER BY soft_hold_until ASC, hostname_normalized ASC
  `);
  const upsertStmt = db.prepare(`
    INSERT INTO pro_subscription_state (
      state_id, publisher_id, hostname_normalized, status,
      soft_hold_until, canceled_at, released_at, created_at, updated_at
    ) VALUES (
      @state_id, @publisher_id, @hostname_normalized, @status,
      @soft_hold_until, @canceled_at, @released_at, @created_at, @updated_at
    )
    ON CONFLICT(hostname_normalized) DO UPDATE SET
      publisher_id = excluded.publisher_id,
      status = excluded.status,
      soft_hold_until = excluded.soft_hold_until,
      canceled_at = excluded.canceled_at,
      released_at = excluded.released_at,
      updated_at = excluded.updated_at
  `);
  const markReleasedStmt = db.prepare<{
    hostname_normalized: string;
    released_at: number;
    updated_at: number;
  }>(`
    UPDATE pro_subscription_state
       SET status = 'released',
           released_at = @released_at,
           updated_at = @updated_at
     WHERE hostname_normalized = @hostname_normalized
  `);

  const readState = (hostname_normalized: string): ProSubscriptionStateRow | null => {
    const row = getByHostnameStmt.get({ hostname_normalized }) as
      | ProSubscriptionStateDbRow
      | undefined;
    return row ? rowToState(row) : null;
  };

  return {
    beginSoftHold(input) {
      const hostname_normalized = normalizeOrThrow(input.hostname);
      const at = input.canceled_at ?? now();
      const existing = getByHostnameStmt.get({ hostname_normalized }) as
        | ProSubscriptionStateDbRow
        | undefined;
      upsertStmt.run({
        state_id: existing?.state_id ?? newId(),
        publisher_id: input.publisher_id,
        hostname_normalized,
        status: 'soft_hold',
        soft_hold_until: at + PRO_DDNS_SOFT_HOLD_MS,
        canceled_at: at,
        released_at: null,
        created_at: existing?.created_at ?? at,
        updated_at: at,
      });
      const out = readState(hostname_normalized);
      if (!out) throw new Error('pro subscription state: soft hold did not persist');
      return out;
    },
    markReleased(input) {
      const hostname_normalized = normalizeOrThrow(input.hostname);
      const at = input.released_at ?? now();
      const result = markReleasedStmt.run({
        hostname_normalized,
        released_at: at,
        updated_at: at,
      });
      return result.changes > 0 ? readState(hostname_normalized) : null;
    },
    markActive(input) {
      const hostname_normalized = normalizeOrThrow(input.hostname);
      const at = input.activated_at ?? now();
      const existing = getByHostnameStmt.get({ hostname_normalized }) as
        | ProSubscriptionStateDbRow
        | undefined;
      upsertStmt.run({
        state_id: existing?.state_id ?? newId(),
        publisher_id: input.publisher_id,
        hostname_normalized,
        status: 'active',
        soft_hold_until: null,
        canceled_at: null,
        released_at: null,
        created_at: existing?.created_at ?? at,
        updated_at: at,
      });
      const out = readState(hostname_normalized);
      if (!out) throw new Error('pro subscription state: active state did not persist');
      return out;
    },
    get(hostname) {
      return readState(normalizeOrThrow(hostname));
    },
    listExpiredSoftHolds(now_) {
      return (listExpiredSoftHoldsStmt.all({ now: now_ }) as ProSubscriptionStateDbRow[])
        .map(rowToState);
    },
    list() {
      return (listStmt.all() as ProSubscriptionStateDbRow[]).map(rowToState);
    },
  };
};
