import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAuditLogStore,
  createInMemoryCollection,
  newRunId,
  buildAuditEntry,
  type AuditLogStore,
  type AuditEntry,
  type AuditEntryInput,
} from '../index.js';
import type { RecipeError } from '@recued/contracts';

const mkEntry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: overrides.run_id ?? newRunId(),
  recipe_id: 'test-recipe',
  recipe_hash: 'abcd1234',
  started_at: 1_000_000,
  finished_at: 1_001_000,
  duration_ms: 1000,
  commit_status: 'succeeded',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: null,
  instance_id: null,
  ...overrides,
});

const mkError = (overrides: Partial<RecipeError> = {}): RecipeError => ({
  error_id: 'err-1',
  code: 'NETWORK_ERROR',
  message: 'fetch failed',
  severity: 'error',
  source: { recipe_id: 'test', step_id: null, ingredient_slug: null },
  details: {},
  timestamp: new Date().toISOString(),
  retryable: false,
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// newRunId
// ────────────────────────────────────────────────────────────────

describe('newRunId', () => {
  it('produces a unique id per call', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(newRunId());
    expect(ids.size).toBe(100);
  });

  it('uses UTC timestamp + random suffix format', () => {
    const id = newRunId(1_700_000_000_000); // arbitrary epoch
    expect(id).toMatch(/^\d{8}T\d{9}-[0-9a-z]{6}$/);
  });

  it('timestamp component is deterministic for a given now', () => {
    const a = newRunId(1_700_000_000_000);
    const b = newRunId(1_700_000_000_000);
    // Different suffixes, same timestamp prefix
    expect(a.slice(0, 17)).toBe(b.slice(0, 17));
    expect(a).not.toBe(b); // random suffix differs
  });
});

// ────────────────────────────────────────────────────────────────
// createAuditLogStore
// ────────────────────────────────────────────────────────────────

describe('AuditLogStore', () => {
  let store: AuditLogStore;

  beforeEach(() => {
    store = createAuditLogStore(createInMemoryCollection<AuditEntry>());
  });

  it('append → get roundtrip', async () => {
    // ⚠ Compared MINUS the two fields the write path omits when empty
    // (`trigger_url: null`, `errors: []` — 4.4% of a real row, spent entirely
    // on key names to say "nothing here"). Absent and empty are the same fact,
    // so the round trip is intact; the omission itself is pinned separately in
    // `audit-entry-omits-empties.test.ts`, including that a REAL url or error
    // survives.
    const entry = mkEntry({ run_id: 'run-1' });
    await store.append(entry);
    const fetched = await store.get('run-1');

    const { trigger_url: _url, errors: _errs, ...meaningful } = entry;
    expect(fetched).toEqual(meaningful);
    // ...and the omitted pair reads back as its empty equivalent.
    expect(fetched?.trigger_url ?? null).toBeNull();
    expect(fetched?.errors ?? []).toEqual([]);
  });

  it('append throws when run_id is missing', async () => {
    const entry = mkEntry({ run_id: '' });
    await expect(store.append(entry)).rejects.toThrow(/run_id is required/);
  });

  it('get returns null for missing entry', async () => {
    expect(await store.get('nonexistent')).toBe(null);
  });

  it('size reflects append count', async () => {
    expect(await store.size()).toBe(0);
    await store.append(mkEntry({ run_id: 'a' }));
    await store.append(mkEntry({ run_id: 'b' }));
    expect(await store.size()).toBe(2);
  });

  it('listRecent returns entries sorted newest-first', async () => {
    await store.append(mkEntry({ run_id: 'old', started_at: 100 }));
    await store.append(mkEntry({ run_id: 'new', started_at: 300 }));
    await store.append(mkEntry({ run_id: 'mid', started_at: 200 }));
    const recent = await store.listRecent(10);
    expect(recent.map((e) => e.run_id)).toEqual(['new', 'mid', 'old']);
  });

  it('listRecent respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(mkEntry({ run_id: `r${i}`, started_at: i * 100 }));
    }
    const recent = await store.listRecent(2);
    expect(recent.map((e) => e.run_id)).toEqual(['r4', 'r3']);
  });

  it('listRecent with zero or negative limit returns empty', async () => {
    await store.append(mkEntry({ run_id: 'a' }));
    expect(await store.listRecent(0)).toEqual([]);
    expect(await store.listRecent(-1)).toEqual([]);
  });

  it('listByRecipe filters by recipe_id and sorts', async () => {
    await store.append(mkEntry({ run_id: 'a', recipe_id: 'foo', started_at: 100 }));
    await store.append(mkEntry({ run_id: 'b', recipe_id: 'bar', started_at: 200 }));
    await store.append(mkEntry({ run_id: 'c', recipe_id: 'foo', started_at: 300 }));
    const foo = await store.listByRecipe('foo');
    expect(foo.map((e) => e.run_id)).toEqual(['c', 'a']);
  });

  it('listByRecipe respects optional limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(mkEntry({ run_id: `r${i}`, recipe_id: 'foo', started_at: i * 100 }));
    }
    const limited = await store.listByRecipe('foo', 2);
    expect(limited.length).toBe(2);
    expect(limited[0].run_id).toBe('r4');
  });

  it('clearOlderThan removes entries before cutoff', async () => {
    await store.append(mkEntry({ run_id: 'old', started_at: 100 }));
    await store.append(mkEntry({ run_id: 'mid', started_at: 500 }));
    await store.append(mkEntry({ run_id: 'new', started_at: 1000 }));
    const deleted = await store.clearOlderThan(600);
    expect(deleted).toBe(2);
    expect(await store.size()).toBe(1);
    expect((await store.get('new'))?.run_id).toBe('new');
    expect(await store.get('old')).toBe(null);
    expect(await store.get('mid')).toBe(null);
  });

  it('clearByRecipe removes entries for one recipe only', async () => {
    await store.append(mkEntry({ run_id: 'a', recipe_id: 'foo' }));
    await store.append(mkEntry({ run_id: 'b', recipe_id: 'bar' }));
    await store.append(mkEntry({ run_id: 'c', recipe_id: 'foo' }));
    const deleted = await store.clearByRecipe('foo');
    expect(deleted).toBe(2);
    expect(await store.size()).toBe(1);
    expect((await store.get('b'))?.recipe_id).toBe('bar');
  });

  it('exportAll returns all entries newest-first', async () => {
    await store.append(mkEntry({ run_id: 'a', started_at: 100 }));
    await store.append(mkEntry({ run_id: 'b', started_at: 300 }));
    const all = await store.exportAll();
    expect(all.map((e) => e.run_id)).toEqual(['b', 'a']);
  });

  it('clearAll wipes everything', async () => {
    await store.append(mkEntry({ run_id: 'a' }));
    await store.append(mkEntry({ run_id: 'b' }));
    await store.clearAll();
    expect(await store.size()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// buildAuditEntry
// ────────────────────────────────────────────────────────────────

describe('buildAuditEntry', () => {
  it('converts minimal ExecutionResult-shaped input into a complete AuditEntry', () => {
    const entry = buildAuditEntry({
      recipe_id: 'test',
      recipe_hash: 'abcd1234',
      commit_status: 'succeeded',
      duration_ms: 500,
      errors: [],
      now: 1_000_000,
    });
    expect(entry.recipe_id).toBe('test');
    expect(entry.recipe_hash).toBe('abcd1234');
    expect(entry.commit_status).toBe('succeeded');
    expect(entry.duration_ms).toBe(500);
    expect(entry.finished_at).toBe(1_000_000);
    expect(entry.started_at).toBe(999_500);
    expect(entry.run_id).toMatch(/^\d{8}T/);
  });

  it('auto-generates run_id when omitted', () => {
    const entry = buildAuditEntry({
      recipe_id: 'x', recipe_hash: 'y', commit_status: 'succeeded',
      duration_ms: 0, errors: [],
    });
    expect(entry.run_id).toBeTruthy();
  });

  it('uses supplied run_id when provided', () => {
    const entry = buildAuditEntry({
      recipe_id: 'x', recipe_hash: 'y', commit_status: 'succeeded',
      duration_ms: 0, errors: [],
      run_id: 'custom-id',
    });
    expect(entry.run_id).toBe('custom-id');
  });

  it('persists budget_ms when caller supplies it (operator tuning signal)', () => {
    const entry = buildAuditEntry({
      recipe_id: 'x', recipe_hash: 'y', commit_status: 'succeeded',
      duration_ms: 1200, errors: [],
      budget_ms: 2000,
    });
    expect(entry.budget_ms).toBe(2000);
    expect(entry.duration_ms).toBe(1200);
  });

  it('omits budget_ms when the recipe did not declare one', () => {
    const entry = buildAuditEntry({
      recipe_id: 'x', recipe_hash: 'y', commit_status: 'succeeded',
      duration_ms: 1200, errors: [],
    });
    expect('budget_ms' in entry).toBe(false);
  });

  it('preserves error details (no redaction — diagnostic data)', () => {
    const err = mkError({ message: 'timeout after 30s' });
    const entry = buildAuditEntry({
      recipe_id: 'x', recipe_hash: 'y', commit_status: 'failed',
      duration_ms: 30000,
      errors: [err],
    });
    expect(entry.errors).toEqual([err]);
  });

  it('passes through the D-181 §12 error_category when supplied', () => {
    const entry = buildAuditEntry({
      recipe_id: 'x', recipe_hash: 'y', commit_status: 'killed',
      duration_ms: 50, errors: [],
      error_category: 'killed',
    });
    expect(entry.error_category).toBe('killed');
  });

  it('omits error_category when not supplied (ordinary run)', () => {
    const entry = buildAuditEntry({
      recipe_id: 'x', recipe_hash: 'y', commit_status: 'failed',
      duration_ms: 50, errors: [],
    });
    expect('error_category' in entry).toBe(false);
  });

  it('clones config_snapshot (defensive copy)', () => {
    const config = { threshold: 7 };
    const entry = buildAuditEntry({
      recipe_id: 'x', recipe_hash: 'y', commit_status: 'succeeded',
      duration_ms: 0, errors: [],
      config_snapshot: config,
    });
    expect(entry.config_snapshot).toEqual({ threshold: 7 });
    expect(entry.config_snapshot).not.toBe(config); // not the same reference
  });

  it('empty config_snapshot when omitted', () => {
    const entry = buildAuditEntry({
      recipe_id: 'x', recipe_hash: 'y', commit_status: 'succeeded',
      duration_ms: 0, errors: [],
    });
    expect(entry.config_snapshot).toEqual({});
  });

  it('trigger_url defaults to null', () => {
    const entry = buildAuditEntry({
      recipe_id: 'x', recipe_hash: 'y', commit_status: 'succeeded',
      duration_ms: 0, errors: [],
    });
    expect(entry.trigger_url).toBe(null);
  });

  it('trigger_url is passed through when supplied', () => {
    const entry = buildAuditEntry({
      recipe_id: 'x', recipe_hash: 'y', commit_status: 'succeeded',
      duration_ms: 0, errors: [],
      trigger_url: 'https://app.hubspot.com/deals/123',
    });
    expect(entry.trigger_url).toBe('https://app.hubspot.com/deals/123');
  });

  it('built entry can round-trip through append and get', async () => {
    const store = createAuditLogStore(createInMemoryCollection<AuditEntry>());
    const entry = buildAuditEntry({
      recipe_id: 'deal-risk',
      recipe_hash: 'abcd1234',
      commit_status: 'succeeded',
      duration_ms: 150,
      errors: [],
      config_snapshot: { verbose: false },
      trigger_url: 'https://app.hubspot.com/deal/42',
    });
    await store.append(entry);
    const fetched = await store.get(entry.run_id);
    expect(fetched).not.toBeNull();
    expect(fetched?.recipe_id).toBe('deal-risk');
    expect(fetched?.trigger_url).toBe('https://app.hubspot.com/deal/42');
    expect(fetched?.config_snapshot).toEqual({ verbose: false });
  });
});

// ────────────────────────────────────────────────────────────────
// Auto-trim
// ────────────────────────────────────────────────────────────────

describe('AuditLogStore — auto-trim', () => {
  it('trims entries past maxEntries on append', async () => {
    const backing = createInMemoryCollection<AuditEntry>();
    const store = createAuditLogStore(backing, undefined, { maxEntries: 3 });

    for (let i = 0; i < 5; i++) {
      await store.append(mkEntry({ run_id: `run-${i}`, started_at: i }));
    }
    // Allow non-blocking trim to settle
    await new Promise((r) => setTimeout(r, 10));
    const size = await store.size();
    expect(size).toBeLessThanOrEqual(3);
  });

  it('keeps the newest entries when trimming', async () => {
    const backing = createInMemoryCollection<AuditEntry>();
    const store = createAuditLogStore(backing, undefined, { maxEntries: 2 });

    await store.append(mkEntry({ run_id: 'old', started_at: 100 }));
    await store.append(mkEntry({ run_id: 'mid', started_at: 200 }));
    await store.append(mkEntry({ run_id: 'new', started_at: 300 }));
    await new Promise((r) => setTimeout(r, 10));

    const remaining = await store.listRecent(10);
    const ids = remaining.map((e) => e.run_id);
    expect(ids).toContain('new');
    expect(ids).toContain('mid');
    expect(ids).not.toContain('old');
  });
});

// ────────────────────────────────────────────────────────────────
// buildAuditEntry — trigger_source / instance_id passthrough
// ────────────────────────────────────────────────────────────────

describe('buildAuditEntry — optional context fields', () => {
  const basicInput: AuditEntryInput = {
    recipe_id: 'x', recipe_hash: 'y', commit_status: 'succeeded',
    duration_ms: 0, errors: [],
  };

  it('trigger_source defaults to null and passes through when supplied', () => {
    expect(buildAuditEntry({ ...basicInput }).trigger_source).toBe(null);
    expect(buildAuditEntry({ ...basicInput, trigger_source: 'scheduled' }).trigger_source)
      .toBe('scheduled');
  });

  it('instance_id defaults to null and passes through when supplied', () => {
    expect(buildAuditEntry({ ...basicInput }).instance_id).toBe(null);
    expect(buildAuditEntry({ ...basicInput, instance_id: 'inst-abc' }).instance_id)
      .toBe('inst-abc');
  });

  it('process_id is omitted when not supplied (non-reactive runs)', () => {
    expect(buildAuditEntry({ ...basicInput }).process_id).toBeUndefined();
  });

  it('process_id passes through for reactive runs', () => {
    const entry = buildAuditEntry({ ...basicInput, process_id: 'pid-abc' });
    expect(entry.process_id).toBe('pid-abc');
  });

  it('defaults finished_at to Date.now() when now is omitted', () => {
    const before = Date.now();
    const entry = buildAuditEntry({ ...basicInput, duration_ms: 50 });
    const after = Date.now();
    expect(entry.finished_at).toBeGreaterThanOrEqual(before);
    expect(entry.finished_at).toBeLessThanOrEqual(after);
    expect(entry.started_at).toBe(entry.finished_at - 50);
  });
});

// ────────────────────────────────────────────────────────────────
// AuditLogStore — edge cases
// ────────────────────────────────────────────────────────────────

describe('AuditLogStore — listByRecipe edge cases', () => {
  let store: AuditLogStore;
  beforeEach(() => {
    store = createAuditLogStore(createInMemoryCollection<AuditEntry>());
  });

  it('returns all matching entries when limit is negative (treated as unlimited)', async () => {
    for (let i = 0; i < 4; i++) {
      await store.append(mkEntry({ run_id: `r${i}`, recipe_id: 'foo', started_at: i * 100 }));
    }
    const r = await store.listByRecipe('foo', -1);
    expect(r).toHaveLength(4);
  });

  it('returns empty for a recipe with no entries', async () => {
    await store.append(mkEntry({ run_id: 'a', recipe_id: 'foo' }));
    expect(await store.listByRecipe('bar')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Activity log
// ────────────────────────────────────────────────────────────────

describe('AuditLogStore — activity log (in-memory fallback)', () => {
  let store: AuditLogStore;
  beforeEach(() => {
    store = createAuditLogStore(createInMemoryCollection<AuditEntry>());
  });

  it('logActivity auto-generates activity_id when missing', async () => {
    await store.logActivity({
      activity_id: '',
      timestamp: 1000,
      action: 'install',
      target: 'recipe-a',
    });
    const activities = await store.listActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0].activity_id).not.toBe('');
    expect(activities[0].activity_id.length).toBeGreaterThan(0);
  });

  it('preserves a supplied activity_id', async () => {
    await store.logActivity({
      activity_id: 'act-custom',
      timestamp: 1000,
      action: 'install',
      target: 'recipe-a',
    });
    const activities = await store.listActivities();
    expect(activities[0].activity_id).toBe('act-custom');
  });

  it('listActivities sorts by timestamp descending', async () => {
    await store.logActivity({ activity_id: 'a', timestamp: 100, action: 'install', target: 'r-a' });
    await store.logActivity({ activity_id: 'c', timestamp: 300, action: 'install', target: 'r-c' });
    await store.logActivity({ activity_id: 'b', timestamp: 200, action: 'install', target: 'r-b' });
    const r = await store.listActivities();
    expect(r.map(a => a.activity_id)).toEqual(['c', 'b', 'a']);
  });

  it('listActivities respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.logActivity({ activity_id: `a${i}`, timestamp: i * 10, action: 'install', target: 't' });
    }
    const r = await store.listActivities(2);
    expect(r).toHaveLength(2);
  });

  it('listActivities with undefined limit returns everything (no slice)', async () => {
    for (let i = 0; i < 3; i++) {
      await store.logActivity({ activity_id: `a${i}`, timestamp: i, action: 'install', target: 't' });
    }
    expect(await store.listActivities()).toHaveLength(3);
  });

  it('exportActivities returns everything sorted descending', async () => {
    await store.logActivity({ activity_id: 'a', timestamp: 100, action: 'install', target: 't' });
    await store.logActivity({ activity_id: 'b', timestamp: 300, action: 'vault_set', target: 't' });
    const r = await store.exportActivities();
    expect(r.map(a => a.activity_id)).toEqual(['b', 'a']);
  });

  it('clearAll wipes both audit entries and activities', async () => {
    await store.append(mkEntry({ run_id: 'x' }));
    await store.logActivity({ activity_id: 'act', timestamp: 1, action: 'install', target: 't' });
    await store.clearAll();
    expect(await store.size()).toBe(0);
    expect(await store.listActivities()).toEqual([]);
  });
});

describe('AuditLogStore — activity log (explicit backing)', () => {
  it('uses the injected activity collection when supplied', async () => {
    const auditBacking = createInMemoryCollection<AuditEntry>();
    const activityBacking = createInMemoryCollection<import('../audit.js').ActivityEntry>();
    const store = createAuditLogStore(auditBacking, activityBacking);

    await store.logActivity({ activity_id: 'a', timestamp: 10, action: 'install', target: 'r' });
    // Direct check on the injected backing proves we aren't falling back to the in-memory store.
    const direct = await activityBacking.get('a');
    expect(direct?.target).toBe('r');
  });
});

// ────────────────────────────────────────────────────────────────
// Phase B — reserve classification
// ────────────────────────────────────────────────────────────────

import { isReserveAction, RESERVE_ACTIONS } from '../audit.js';

describe('isReserveAction / RESERVE_ACTIONS', () => {
  it('classifies pressure + kill-switch + quota actions as reserve', () => {
    expect(isReserveAction('pressure_state_change')).toBe(true);
    expect(isReserveAction('pressure_eviction_run')).toBe(true);
    expect(isReserveAction('crash_halt_toggle')).toBe(true);
    expect(isReserveAction('quota_exceeded')).toBe(true);
    expect(isReserveAction('tier_limit_exceeded')).toBe(true);
    expect(isReserveAction('account_mismatch_rejected')).toBe(true);
    expect(isReserveAction('audit_retention_prune')).toBe(true);
  });

  it('classifies user-class actions as non-reserve', () => {
    expect(isReserveAction('install')).toBe(false);
    expect(isReserveAction('vault_set')).toBe(false);
    expect(isReserveAction('schedule_create')).toBe(false);
    expect(isReserveAction('shared_write')).toBe(false);
  });

  it('classifies Phase C lifecycle events as reserve (forensic ledger)', () => {
    // Low-volume, forensically critical — a crash-loop diagnosis
    // needs the full boot/crash sequence even after retention prunes
    // the user-class rows around it.
    expect(isReserveAction('server_boot')).toBe(true);
    expect(isReserveAction('server_shutdown')).toBe(true);
    expect(isReserveAction('server_restart')).toBe(true);
    expect(isReserveAction('server_crashed')).toBe(true);
    expect(isReserveAction('drain_started')).toBe(true);
    expect(isReserveAction('drain_completed')).toBe(true);
    expect(isReserveAction('drain_aborted')).toBe(true);
    expect(isReserveAction('crash_loop_detected')).toBe(true);
    expect(isReserveAction('crash_loop_reset')).toBe(true);
    expect(isReserveAction('lock_conflict')).toBe(true);
    expect(isReserveAction('config_hot_reloaded')).toBe(true);
  });

  it('signal_received stays user-class (high volume; redundant with action codes)', () => {
    // SIGHUP / SIGUSR1 fire often and the follow-up action code
    // (config_hot_reloaded / etc.) already reserves the real event.
    expect(isReserveAction('signal_received')).toBe(false);
  });

  it('classifies Phase D security + forensic events as reserve', () => {
    // Retention prunes survive eviction so the ledger retains what
    // got dropped and when. Auth-rejected webhook deliveries are the
    // security signal — low-volume and high-value for spotting
    // credential stuffing / HMAC probing.
    expect(isReserveAction('collection_retention_prune')).toBe(true);
    expect(isReserveAction('webhook_rejected_auth')).toBe(true);
  });

  it('classifies Phase D high-volume churn codes as non-reserve', () => {
    // Reserve would starve the retention floor — these fire on every
    // sync tick / record change / webhook delivery. The lifecycle
    // codes above already reserve what matters for forensics.
    expect(isReserveAction('collection_sync_start')).toBe(false);
    expect(isReserveAction('collection_sync_complete')).toBe(false);
    expect(isReserveAction('collection_sync_error')).toBe(false);
    expect(isReserveAction('collection_record_created')).toBe(false);
    expect(isReserveAction('collection_record_updated')).toBe(false);
    expect(isReserveAction('collection_record_deleted')).toBe(false);
    expect(isReserveAction('webhook_received')).toBe(false);
  });

  it('exports a read-only Set of the exact reserve action codes', () => {
    expect(RESERVE_ACTIONS.has('pressure_state_change')).toBe(true);
    expect(RESERVE_ACTIONS.has('install')).toBe(false);
  });
});

describe('AuditLogStore — activity reserve auto-classification', () => {
  let store: AuditLogStore;
  let backing: ReturnType<typeof createInMemoryCollection<import('../audit.js').ActivityEntry>>;
  beforeEach(() => {
    backing = createInMemoryCollection<import('../audit.js').ActivityEntry>();
    store = createAuditLogStore(createInMemoryCollection<AuditEntry>(), backing);
  });

  it('auto-classifies reserve-class action as reserve=true', async () => {
    await store.logActivity({
      activity_id: 'x',
      timestamp: 100,
      action: 'pressure_state_change',
      target: 'cache',
    });
    const stored = await backing.get('x');
    expect(stored?.reserve).toBe(true);
  });

  it('keeps non-reserve action without reserve flag (default undefined)', async () => {
    await store.logActivity({
      activity_id: 'x',
      timestamp: 100,
      action: 'install',
      target: 'r',
    });
    const stored = await backing.get('x');
    expect(stored?.reserve).toBeUndefined();
  });

  it('explicit options.reserve=true overrides non-reserve action', async () => {
    await store.logActivity(
      { activity_id: 'x', timestamp: 100, action: 'install', target: 'r' },
      { reserve: true },
    );
    const stored = await backing.get('x');
    expect(stored?.reserve).toBe(true);
  });

  it('explicit options.reserve=false overrides reserve-class action', async () => {
    await store.logActivity(
      { activity_id: 'x', timestamp: 100, action: 'pressure_state_change', target: 'cache' },
      { reserve: false },
    );
    const stored = await backing.get('x');
    expect(stored?.reserve).toBe(false);
  });

  it('ignores inherited options.reserve for activity classification', async () => {
    await store.logActivity(
      { activity_id: 'x', timestamp: 100, action: 'pressure_state_change', target: 'cache' },
      Object.create({ reserve: false }),
    );
    const stored = await backing.get('x');
    expect(stored?.reserve).toBe(true);
  });

  it('entry-level reserve field takes precedence over auto-classification', async () => {
    await store.logActivity({
      activity_id: 'x',
      timestamp: 100,
      action: 'install',
      target: 'r',
      reserve: true,
    });
    expect((await backing.get('x'))?.reserve).toBe(true);
  });
});

describe('AuditLogStore — audit-entry reserve field', () => {
  it('append preserves reserve=true when entry sets it', async () => {
    const backing = createInMemoryCollection<AuditEntry>();
    const store = createAuditLogStore(backing);
    await store.append(mkEntry({ run_id: 'r1', reserve: true }));
    expect((await backing.get('r1'))?.reserve).toBe(true);
  });

  it('append with options.reserve overrides entry.reserve', async () => {
    const backing = createInMemoryCollection<AuditEntry>();
    const store = createAuditLogStore(backing);
    await store.append(mkEntry({ run_id: 'r1', reserve: false }), { reserve: true });
    expect((await backing.get('r1'))?.reserve).toBe(true);
  });

  it('append ignores inherited options.reserve', async () => {
    const backing = createInMemoryCollection<AuditEntry>();
    const store = createAuditLogStore(backing);
    await store.append(
      mkEntry({ run_id: 'r1', reserve: false }),
      Object.create({ reserve: true }),
    );
    expect((await backing.get('r1'))?.reserve).toBe(false);
  });

  it('append leaves reserve undefined when neither entry nor options set it', async () => {
    const backing = createInMemoryCollection<AuditEntry>();
    const store = createAuditLogStore(backing);
    await store.append(mkEntry({ run_id: 'r1' }));
    expect((await backing.get('r1'))?.reserve).toBeUndefined();
  });
});

describe('AuditLogStore — retention skips reserve rows', () => {
  it('clearOlderThan skips reserve rows', async () => {
    const store = createAuditLogStore(createInMemoryCollection<AuditEntry>());
    await store.append(mkEntry({ run_id: 'old-user', started_at: 100, reserve: false }));
    await store.append(mkEntry({ run_id: 'old-reserve', started_at: 100, reserve: true }));
    await store.append(mkEntry({ run_id: 'new-user', started_at: 1000 }));

    const removed = await store.clearOlderThan(500);
    expect(removed).toBe(1);
    expect(await store.get('old-user')).toBeNull();
    expect(await store.get('old-reserve')).not.toBeNull();
    expect(await store.get('new-user')).not.toBeNull();
  });

  it('auto-trim never evicts reserve rows even past maxEntries', async () => {
    const backing = createInMemoryCollection<AuditEntry>();
    const store = createAuditLogStore(backing, undefined, { maxEntries: 2 });

    // Write 3 reserve rows first — all three must survive.
    await store.append(mkEntry({ run_id: 'r1', started_at: 100, reserve: true }));
    await store.append(mkEntry({ run_id: 'r2', started_at: 200, reserve: true }));
    await store.append(mkEntry({ run_id: 'r3', started_at: 300, reserve: true }));
    // Plus 3 user rows — trim should keep the 2 newest user rows.
    await store.append(mkEntry({ run_id: 'u1', started_at: 150 }));
    await store.append(mkEntry({ run_id: 'u2', started_at: 250 }));
    await store.append(mkEntry({ run_id: 'u3', started_at: 350 }));
    await new Promise((r) => setTimeout(r, 10));

    const ids = (await store.exportAll()).map((e) => e.run_id);
    // All reserves survive + the 2 newest user rows.
    expect(ids).toContain('r1');
    expect(ids).toContain('r2');
    expect(ids).toContain('r3');
    expect(ids).toContain('u3');
    expect(ids).toContain('u2');
    expect(ids).not.toContain('u1');
  });

  it('clearOldestEntries returns oldest non-reserve first', async () => {
    const store = createAuditLogStore(createInMemoryCollection<AuditEntry>());
    await store.append(mkEntry({ run_id: 'u1', started_at: 100 }));
    await store.append(mkEntry({ run_id: 'r1', started_at: 50, reserve: true }));
    await store.append(mkEntry({ run_id: 'u2', started_at: 200 }));

    const removed = await store.clearOldestEntries(10);
    expect(removed).toBe(2);
    expect(await store.get('r1')).not.toBeNull();
    expect(await store.get('u1')).toBeNull();
    expect(await store.get('u2')).toBeNull();
  });

  it('clearOldestActivities skips reserve activities', async () => {
    const store = createAuditLogStore(createInMemoryCollection<AuditEntry>());
    await store.logActivity({ activity_id: 'u1', timestamp: 100, action: 'install', target: 't' });
    await store.logActivity({ activity_id: 'r1', timestamp: 50, action: 'pressure_state_change', target: 'cache' });
    await store.logActivity({ activity_id: 'u2', timestamp: 200, action: 'install', target: 't' });

    const removed = await store.clearOldestActivities(10);
    expect(removed).toBe(2);
    const survivors = (await store.listActivities()).map((e) => e.activity_id);
    expect(survivors).toContain('r1');
    expect(survivors).not.toContain('u1');
    expect(survivors).not.toContain('u2');
  });

  it('countReserveEntries + countReserveActivities expose reserve totals', async () => {
    const store = createAuditLogStore(createInMemoryCollection<AuditEntry>());
    await store.append(mkEntry({ run_id: 'r1', reserve: true }));
    await store.append(mkEntry({ run_id: 'u1' }));
    await store.logActivity({ activity_id: 'a-r', timestamp: 1, action: 'quota_exceeded', target: 't' });
    await store.logActivity({ activity_id: 'a-u', timestamp: 2, action: 'install', target: 't' });

    expect(await store.countReserveEntries()).toBe(1);
    expect(await store.countReserveActivities()).toBe(1);
  });

  it('clearOldestEntries with limit 0 returns 0 and removes nothing', async () => {
    const store = createAuditLogStore(createInMemoryCollection<AuditEntry>());
    await store.append(mkEntry({ run_id: 'u1', started_at: 100 }));
    expect(await store.clearOldestEntries(0)).toBe(0);
    expect(await store.get('u1')).not.toBeNull();
  });

  it('clearByRecipe also removes reserve entries (explicit user intent)', async () => {
    const store = createAuditLogStore(createInMemoryCollection<AuditEntry>());
    await store.append(mkEntry({ run_id: 'u', recipe_id: 'foo' }));
    await store.append(mkEntry({ run_id: 'r', recipe_id: 'foo', reserve: true }));

    const removed = await store.clearByRecipe('foo');
    expect(removed).toBe(2);
    expect(await store.size()).toBe(0);
  });
});
