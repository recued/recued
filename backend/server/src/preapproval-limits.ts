/** Realm-owner startup configuration. These settings have no kernel/RPC
 * setter and cannot be supplied by a recipe, request or requesting contract. */
import type Database from 'better-sqlite3';
import { PREAPPROVAL_LIMITS, type PreapprovalLimits } from '@recued/contracts';

const configurable = ['candidate_calls', 'plan_bytes', 'pending_per_origin', 'pending_per_realm', 'requests_per_minute'] as const;
type Key = typeof configurable[number];
export type PreapprovalRequestLimits = Pick<PreapprovalLimits, Key>;

export const preapprovalLimitsFromEnvironment = (env: Record<string, string | undefined>): Partial<PreapprovalRequestLimits> => {
  const result: Partial<PreapprovalRequestLimits> = {};
  for (const key of configurable) {
    const name = `RECUED_PREAPPROVAL_${key.toUpperCase()}`;
    const raw = env[name];
    if (raw === undefined) continue;
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > PREAPPROVAL_LIMITS[key]) {
      throw new Error(`${name} must be an integer from 1 to ${PREAPPROVAL_LIMITS[key]}.`);
    }
    result[key] = Number(raw);
  }
  return result;
};

export const createPreapprovalLimits = (db: Database.Database, overrides: Partial<PreapprovalRequestLimits> = {}) => {
  // Validate even host callers rather than relying on the environment parser.
  for (const [key, value] of Object.entries(overrides)) {
    if (!configurable.includes(key as Key) || !Number.isSafeInteger(value) || value < 1 || value > PREAPPROVAL_LIMITS[key as Key]) {
      throw new Error('Invalid owner pre-approval request limit.');
    }
  }
  db.exec('CREATE TABLE IF NOT EXISTS preapproval_limits (singleton INTEGER PRIMARY KEY CHECK(singleton=1), config_json TEXT NOT NULL)');
  const read = (): PreapprovalLimits => {
    const row = db.prepare('SELECT config_json FROM preapproval_limits WHERE singleton=1').get() as { config_json: string };
    return { ...PREAPPROVAL_LIMITS, ...JSON.parse(row.config_json) as PreapprovalRequestLimits };
  };
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO preapproval_limits(singleton,config_json) VALUES(1,'{}')").run();
    if (Object.keys(overrides).length) {
      const current = read();
      const selected = Object.fromEntries(configurable.map(key => [key, overrides[key] ?? current[key]]));
      db.prepare('UPDATE preapproval_limits SET config_json=? WHERE singleton=1').run(JSON.stringify(selected));
    }
  }).immediate();
  return read;
};
