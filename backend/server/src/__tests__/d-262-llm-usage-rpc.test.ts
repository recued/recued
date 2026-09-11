/** D-262 follow-on — `server.getLLMUsage`.
 *
 *  ⛔ EVERY BUDGET IN THIS SYSTEM WAS ENFORCED AND INVISIBLE. A pool entry's
 *  `daily_cap_tokens`, a slot's `daily_budget_tokens`, the embeddings cutoff
 *  and the transcription cap each decided whether a call could proceed, and
 *  nothing anywhere showed the number they decided on — so a refused owner
 *  could not tell a spent budget from a bad key.
 *
 *  ⚠ The unit tests here are the point. Chat spends TOKENS and transcription
 *  spends REQUESTS; a surface that folded them into one figure would be
 *  publishing a conversion nobody performed.
 */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { createQuotaTracker } from '@recued/llm';
import type { ServerLlmUsageResponse } from '@recued/contracts';
import { createLLMConfigManager } from '../llm-config.js';
import { makeConfigHandlers } from '../config-schema.js';

const slot = (over: Record<string, unknown> = {}) => ({
  provider: 'openai' as const, model: 'gpt-4.1-mini', api_key: 'sk',
  speed: 'fast' as const, supports_json: true, ...over,
});

const setup = () => {
  const db = new Database(':memory:');
  const llmManager = createLLMConfigManager(db, {});
  const quota = createQuotaTracker();
  const slice = makeConfigHandlers(llmManager, undefined, {
    adapters: (() => ({})) as never,
    quota,
  });
  if (!slice) throw new Error('config slice not built');
  const handlers = slice.handlers as unknown as Record<string, (args?: unknown) => Promise<unknown>>;
  const usage = async (): Promise<ServerLlmUsageResponse> =>
    (await handlers['server.getLLMUsage']!(undefined)) as ServerLlmUsageResponse;
  return { db, llmManager, quota, usage };
};

describe('D-262 — server.getLLMUsage', () => {
  it('reports a chat slot\'s tokens against its daily budget', async () => {
    const { db, llmManager, quota, usage } = setup();
    try {
      llmManager.setSlot1(slot({ daily_budget_tokens: 1_000 }) as never);
      quota.recordUsage('slot_1', 400);

      const row = (await usage()).sources.find((s) => s.id === 'slot_1');
      expect(row).toMatchObject({
        kind: 'chat_slot', tokens_today: 400, limit: 1_000,
        limit_unit: 'tokens', over_limit: false,
      });
    } finally { db.close(); }
  });

  it('marks a slot over its budget — the state an owner needs to SEE, not infer from a refusal', async () => {
    const { db, llmManager, quota, usage } = setup();
    try {
      llmManager.setSlot1(slot({ daily_budget_tokens: 500 }) as never);
      quota.recordUsage('slot_1', 500);
      const row = (await usage()).sources.find((s) => s.id === 'slot_1');
      expect(row?.over_limit).toBe(true);
    } finally { db.close(); }
  });

  it('⛔ reports transcription in REQUESTS, never tokens', async () => {
    const { db, llmManager, quota, usage } = setup();
    try {
      llmManager.setTranscriptionSlot({ provider: 'openai', model: 'whisper-1', api_key: 'sk' } as never);
      llmManager.setTranscriptionDailyRequests(50);
      quota.recordTranscriptionUsage('transcription_slot', { bytes: 4_096, seconds: 11 });

      const row = (await usage()).sources.find((s) => s.id === 'transcription_slot');
      expect(row).toMatchObject({
        kind: 'transcription_slot',
        transcription_requests_today: 1,
        transcription_bytes_today: 4_096,
        transcription_seconds_today: 11,
        limit: 50,
        limit_unit: 'requests',
      });
      // ⛔ No token figure at all. Publishing one would mean inventing a
      // conversion from audio, and every reader would inherit the invention.
      expect(row?.tokens_today).toBeUndefined();
    } finally { db.close(); }
  });

  it('lists every pool entry with its own cap', async () => {
    const { db, llmManager, quota, usage } = setup();
    try {
      llmManager.setPool([
        { id: 'groq', type: 'api', provider: 'openai-compatible', model: 'x', api_key: 'g',
          speed: 'fast', supports_json: true, enabled: true, daily_cap_tokens: 2_000 },
        { id: 'gem', type: 'api', provider: 'google', model: 'y', api_key: 'k',
          speed: 'fast', supports_json: true, enabled: true },
      ] as never);
      quota.recordUsage('groq', 2_000);

      const rows = (await usage()).sources.filter((s) => s.kind === 'pool_entry');
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === 'groq')).toMatchObject({ tokens_today: 2_000, over_limit: true });
      // An uncapped entry reports spend with NO limit, rather than a zero that
      // would read as "no allowance left".
      expect(rows.find((r) => r.id === 'gem')).toMatchObject({ over_limit: false });
      expect(rows.find((r) => r.id === 'gem')?.limit).toBeUndefined();
    } finally { db.close(); }
  });

  it('⚠ keeps a COOLDOWN distinct from being over budget', async () => {
    const { db, llmManager, quota, usage } = setup();
    try {
      llmManager.setSlot1(slot() as never);
      quota.markRateLimited('slot_1', 60_000);
      const row = (await usage()).sources.find((s) => s.id === 'slot_1');
      // The provider said no; the owner's budget did not. They resolve
      // differently — one waits minutes, the other waits for midnight — so
      // merging them would send people to the wrong fix.
      expect(row).toMatchObject({ in_cooldown: true, over_limit: false });
    } finally { db.close(); }
  });

  it('reports the server aggregate SEPARATELY from the per-source figures', async () => {
    const { db, llmManager, quota, usage } = setup();
    try {
      llmManager.setSlot1(slot() as never);
      llmManager.setBudget(10_000);
      llmManager.addUsage(750);
      quota.recordUsage('slot_1', 400);

      const out = await usage();
      expect(out.server_tokens_today).toBe(750);
      expect(out.server_budget_tokens).toBe(10_000);
      // ⚠ NOT the sum of the sources: it is counted independently and includes
      // calls the per-source counters do not attribute. Presenting it as a
      // total would be arithmetic nobody did.
      expect(out.sources.find((s) => s.id === 'slot_1')?.tokens_today).toBe(400);
    } finally { db.close(); }
  });

  it('agrees with the tracker about which DAY it is reporting', async () => {
    const { db, llmManager, usage, quota } = setup();
    try {
      llmManager.setSlot1(slot() as never);
      expect((await usage()).day).toBe(quota.currentDay());
    } finally { db.close(); }
  });

  it('⛔⛔ ADVANCES THE DAY LABEL WITH THE COUNTERS, not with the last write', async () => {
    // ⛔ THE ASSERTION ABOVE CANNOT CATCH THIS ON ITS OWN. It compares the
    // surface to the tracker, so when both read the same stale source it
    // passes while reporting yesterday's date. The property that matters is
    // that the label moves WITH the numbers.
    //
    // Spend on day 1, then cross midnight with no further write: the counters
    // are day-aware and read 0, so a label taken from `snapshot()` —
    // `daily_reset_at`, the day the buckets were last written — would date
    // today's empty numbers as yesterday.
    const { db, llmManager, usage, quota } = setup();
    try {
      llmManager.setSlot1(slot() as never);
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2030-01-01T12:00:00Z'));
      quota.recordUsage('slot_1', 400);
      expect((await usage()).day).toBe('2030-01-01');
      expect((await usage()).sources.find((x) => x.id === 'slot_1')?.tokens_today).toBe(400);

      vi.setSystemTime(new Date('2030-01-02T00:30:00Z'));
      const next = await usage();
      expect(next.day).toBe('2030-01-02');
      expect(next.sources.find((x) => x.id === 'slot_1')?.tokens_today).toBe(0);
      // ⚠ The stale key is still there, which is why the label had to stop
      // coming from it.
      expect(quota.snapshot().daily_reset_at).toBe('2030-01-01');
    } finally { vi.useRealTimers(); db.close(); }
  });

  it('answers `unavailable` rather than pretending, when no tracker is wired', async () => {
    const db = new Database(':memory:');
    try {
      const slice = makeConfigHandlers(createLLMConfigManager(db, {}), undefined);
      if (!slice) throw new Error('config slice not built');
      const handlers = slice.handlers as unknown as Record<string, (args?: unknown) => Promise<unknown>>;
      await expect(handlers['server.getLLMUsage']!(undefined)).rejects.toMatchObject({
        code: 'unavailable',
      });
    } finally { db.close(); }
  });
});
