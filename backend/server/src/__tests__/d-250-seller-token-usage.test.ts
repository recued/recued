/** D-250 § D — the seller can see what a plan priced in TURNS actually COST.
 *
 *  ⛔ WHY THIS MATTERS MORE THAN THE REST OF THE SLICE. The gateway is the one
 *  path where the owner pays a provider bill on someone else's behalf. A plan
 *  bounds `tool_call` / `chat_turn` counts and `rate_limit_per_minute` — those
 *  are the only two dimensions `resolveSellerCustomerUsagePolicy` parses — so a
 *  customer inside a 1,000-turn allowance can burn wildly different token
 *  volumes, and the seller's exposure is unbounded inside a bounded plan. The
 *  real number was captured at the gateway and thrown away, which meant the
 *  seller could not price the plan even in hindsight.
 *
 *  ⛔⛔ A MEASUREMENT, NEVER A METER, AND THE TESTS BELOW PIN THAT DISTINCTION.
 *  Tokens are knowable only AFTER a call returns, so they can never gate that
 *  call; `units` stays the only enforceable dimension. The danger of putting
 *  them on the same row is that a token write moves a billing count — so
 *  `units` is asserted UNCHANGED across a token write.
 *
 *  ⚠ AND NOT A NEW `usage_kind`. That column carries a SQL CHECK baked into
 *  CREATE TABLE, and `CREATE TABLE IF NOT EXISTS` leaves an existing database on
 *  its OLD constraint — so a new kind would pass on a fresh install and fail
 *  every INSERT on every server already running. Self-hosted: there is no
 *  deploy order anyone controls. The additive-column test below is what proves
 *  the chosen route survives an old database.
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TokenUsageReport } from '@recued/contracts';

import {
  createSellerStore,
  SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE,
  type SellerStore,
} from '../storage/seller-store.js';

const CONTRACT = 'ctr_customer_1';
const PERIOD_START = Date.UTC(2026, 7, 24);

const usage = (over: Partial<TokenUsageReport> = {}): TokenUsageReport => ({
  input_tokens: 1_000,
  output_tokens: 250,
  total_tokens: 1_250,
  provider_calls: 1,
  ...over,
});

let db: Database.Database;
let store: SellerStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = createSellerStore(db);
});

const meter = (units: number): void => {
  store.recordUsage({
    contract_id: CONTRACT,
    usage_kind: 'chat_turn',
    period_granularity: 'day',
    period_start: PERIOD_START,
    units,
    now: PERIOD_START + 1,
  });
};

const measure = (report: TokenUsageReport): void => {
  store.recordTokenUsage({
    contract_id: CONTRACT,
    usage_kind: 'chat_turn',
    period_granularity: 'day',
    period_start: PERIOD_START,
    usage: report,
    now: PERIOD_START + 2,
  });
};

const read = () => store.getUsageRollup({
  contract_id: CONTRACT,
  usage_kind: 'chat_turn',
  period_granularity: 'day',
  period_start: PERIOD_START,
});

describe('D-250 § D — measured tokens land beside the metered units', () => {
  it('⛔ THE MEASUREMENT DOES NOT MOVE THE METER — units are untouched', () => {
    meter(1);
    expect(read()?.units).toBe(1);
    measure(usage());
    // The single most important assertion in this file: a cost write must never
    // change a billing count.
    expect(read()?.units).toBe(1);
    expect(read()?.tokens_total).toBe(1_250);
  });

  it('both accumulate across a period, independently', () => {
    meter(1); measure(usage());
    meter(1); measure(usage());
    const row = read();
    expect(row?.units).toBe(2);
    expect(row?.tokens_total).toBe(2_500);
    expect(row?.tokens_input).toBe(2_000);
    expect(row?.tokens_output).toBe(500);
    expect(row?.provider_calls).toBe(2);
  });

  it('⛔ A TOOL-LOOP TURN COUNTS ITS CALLS — one turn is not one call', () => {
    // The reason `usage_report` is carried beside the OpenAI-shaped `usage`:
    // the wire shape has no `provider_calls`, so a four-call turn would look
    // like a one-call turn and "tokens per call" would be wrong by the depth.
    meter(1);
    measure(usage({ provider_calls: 4, total_tokens: 8_000 }));
    const row = read();
    expect(row?.units).toBe(1);
    expect(row?.provider_calls).toBe(4);
  });

  it('⛔ NEVER MEASURED IS ABSENT, NOT ZERO', () => {
    // A metered period whose cost nothing recorded must not read as "this
    // customer cost nothing" — that is a bill, silently wrong in the
    // seller's favour to state and in their disfavour to believe.
    meter(3);
    const row = read();
    expect(row?.units).toBe(3);
    expect(row?.tokens_total).toBeUndefined();
    expect(row?.provider_calls).toBeUndefined();
  });

  it('a MEASURED zero is retained and is a different fact', () => {
    meter(1);
    measure(usage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }));
    expect(read()?.tokens_total).toBe(0);
    expect(read()?.provider_calls).toBe(1);
  });

  it('⚠ a malformed count is DROPPED, never summed as NaN', () => {
    // A NaN folded into a billing-adjacent column is a confident wrong number,
    // and this is the surface where that is most expensive.
    meter(1);
    measure(usage({ total_tokens: Number.NaN }));
    expect(read()?.tokens_total).toBe(0);
    expect(Number.isFinite(read()?.tokens_input ?? Number.NaN)).toBe(true);
  });

  it('a token write with no prior meter creates the row at units 0', () => {
    // The INSERT arm. `units: 0` is honest — this write metered nothing.
    measure(usage());
    expect(read()?.units).toBe(0);
    expect(read()?.tokens_total).toBe(1_250);
  });

  it('two contracts never mix', () => {
    meter(1); measure(usage());
    store.recordTokenUsage({
      contract_id: 'ctr_other',
      usage_kind: 'chat_turn',
      period_granularity: 'day',
      period_start: PERIOD_START,
      usage: usage({ total_tokens: 99 }),
      now: PERIOD_START + 3,
    });
    expect(read()?.tokens_total).toBe(1_250);
  });
});

describe('D-250 § D — the columns reach an OLD database', () => {
  it('⛔⛔ AN EXISTING ROLLUP TABLE GAINS THEM BY ALTER, NOT BY RE-CREATE', () => {
    // Simulate a server that has been running since before this shipped:
    // the pre-D-250 table, with a row already in it.
    const old = new Database(':memory:');
    old.exec(`
      CREATE TABLE ${SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE} (
        contract_id        TEXT NOT NULL,
        usage_kind         TEXT NOT NULL CHECK (usage_kind IN ('tool_call','chat_turn')),
        period_granularity TEXT NOT NULL CHECK (period_granularity IN ('day','month')),
        period_start       INTEGER NOT NULL,
        units              INTEGER NOT NULL CHECK (units >= 0),
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        PRIMARY KEY (contract_id, usage_kind, period_granularity, period_start)
      );
      INSERT INTO ${SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE}
        VALUES ('${CONTRACT}', 'chat_turn', 'day', ${PERIOD_START}, 7, 1, 1);
    `);

    // Booting the store must migrate rather than fail, and must not disturb the
    // row that is already there.
    const migrated = createSellerStore(old);
    const before = migrated.getUsageRollup({
      contract_id: CONTRACT,
      usage_kind: 'chat_turn',
      period_granularity: 'day',
      period_start: PERIOD_START,
    });
    expect(before?.units).toBe(7);
    // ⚠ The pre-existing row reads ABSENT, never 0 — its cost was never
    // measured and a backfill cannot invent it.
    expect(before?.tokens_total).toBeUndefined();

    migrated.recordTokenUsage({
      contract_id: CONTRACT,
      usage_kind: 'chat_turn',
      period_granularity: 'day',
      period_start: PERIOD_START,
      usage: usage(),
      now: PERIOD_START + 9,
    });
    const after = migrated.getUsageRollup({
      contract_id: CONTRACT,
      usage_kind: 'chat_turn',
      period_granularity: 'day',
      period_start: PERIOD_START,
    });
    expect(after?.units).toBe(7);
    expect(after?.tokens_total).toBe(1_250);
    old.close();
  });
});
