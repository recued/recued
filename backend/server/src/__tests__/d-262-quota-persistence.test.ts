/** D-262 follow-on — per-source budgets survive a restart.
 *
 *  ⛔ A DAILY CAP YOU CAN CLEAR BY RESTARTING IS NOT A CAP. The `QuotaTracker`
 *  holds the counters `statusFor` compares against a pool entry's
 *  `daily_cap_tokens`, `slotOverCutoff` compares against a slot's
 *  `daily_budget_tokens`, and the embeddings and transcription caps read. It
 *  was built unseeded and its `snapshot()` had no caller — so a self-hoster,
 *  who restarts on every update, began each day again.
 *
 *  ⚠ Distinct from `getUsage`/`addUsage`, which persist ONE AGGREGATE counter
 *  for the global budget. Two systems answering two questions; only the
 *  per-source one was volatile.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createQuotaTracker } from '@recued/llm';
import { createLLMConfigManager } from '../llm-config.js';

/** Boot a tracker the way `composeLlmSubstrate` does: hydrated from the
 *  manager, writing back through it. */
const bootTracker = (manager: ReturnType<typeof createLLMConfigManager>) =>
  createQuotaTracker(
    (manager.getQuotaSnapshot() ?? undefined) as never,
    { onChange: (snap) => { manager.setQuotaSnapshot(snap); } },
  );

describe('D-262 — the quota snapshot survives a restart', () => {
  it('⛔ carries per-source token spend across a reboot', () => {
    const db = new Database(':memory:');
    try {
      const manager = createLLMConfigManager(db, {});
      const first = bootTracker(manager);
      first.recordUsage('slot_1', 4_000);
      first.recordUsage('groq-free', 1_200);

      // Same database, new process.
      const second = bootTracker(createLLMConfigManager(db, {}));
      expect(second.tokensToday('slot_1')).toBe(4_000);
      expect(second.tokensToday('groq-free')).toBe(1_200);
    } finally { db.close(); }
  });

  it('⛔ a pool entry over its daily cap STAYS over it after a restart', () => {
    const db = new Database(':memory:');
    try {
      const entry = {
        id: 'groq', type: 'api' as const, provider: 'openai-compatible' as const,
        model: 'x', api_key: 'gsk', speed: 'fast' as const, supports_json: true,
        enabled: true, daily_cap_tokens: 1_000,
      };
      const first = bootTracker(createLLMConfigManager(db, {}));
      first.recordUsage('groq', 1_000);
      expect(first.statusFor(entry).available).toBe(false);

      // The behaviour this whole change exists for: restarting was a way to
      // clear a cap the owner set on themselves.
      const second = bootTracker(createLLMConfigManager(db, {}));
      expect(second.statusFor(entry).available).toBe(false);
    } finally { db.close(); }
  });

  it('carries embeddings and transcription counters too', () => {
    const db = new Database(':memory:');
    try {
      const first = bootTracker(createLLMConfigManager(db, {}));
      first.recordEmbeddingsUsage('embeddings_slot', 900);
      first.recordTranscriptionUsage('transcription_slot', { bytes: 2_048, seconds: 7 });

      const second = bootTracker(createLLMConfigManager(db, {}));
      expect(second.embeddingsTokensToday('embeddings_slot')).toBe(900);
      expect(second.transcriptionRequestsToday('transcription_slot')).toBe(1);
      expect(second.transcriptionBytesToday('transcription_slot')).toBe(2_048);
      expect(second.transcriptionSecondsToday('transcription_slot')).toBe(7);
    } finally { db.close(); }
  });

  it('⚠ does NOT restore a rate-limit cooldown — that belongs to a live process', () => {
    const db = new Database(':memory:');
    try {
      const first = bootTracker(createLLMConfigManager(db, {}));
      first.markRateLimited('slot_1', 60_000);
      expect(first.isInCooldown('slot_1')).toBe(true);

      // Restoring one would extend a provider's 60-second penalty across a
      // restart it never asked for.
      const second = bootTracker(createLLMConfigManager(db, {}));
      expect(second.isInCooldown('slot_1')).toBe(false);
    } finally { db.close(); }
  });

  it('⚠ starts the RPM window empty, which is what makes it in-memory by design', () => {
    const db = new Database(':memory:');
    try {
      const entry = {
        id: 'p', type: 'api' as const, provider: 'openai' as const, model: 'm',
        api_key: 'k', speed: 'fast' as const, supports_json: true, enabled: true,
        rpm_cap: 2,
      };
      const first = bootTracker(createLLMConfigManager(db, {}));
      first.registerRequest('p');
      first.registerRequest('p');
      expect(first.statusFor(entry).available).toBe(false);

      const second = bootTracker(createLLMConfigManager(db, {}));
      expect(second.statusFor(entry).available).toBe(true);
    } finally { db.close(); }
  });

  it('⛔ a MALFORMED stored blob reads as absent rather than breaking the boot', () => {
    const db = new Database(':memory:');
    try {
      const manager = createLLMConfigManager(db, {});
      manager.setQuotaSnapshot('not json at all' as never);
      db.prepare(`UPDATE llm_config SET value = '{{{' WHERE key = 'quota.snapshot'`).run();
      // Losing today's counters is a small over-allowance; refusing to boot
      // over them would be an unusable server.
      expect(() => bootTracker(createLLMConfigManager(db, {}))).not.toThrow();
      expect(bootTracker(createLLMConfigManager(db, {})).tokensToday('slot_1')).toBe(0);
    } finally { db.close(); }
  });

  it('rolls the day over rather than resurrecting yesterday\'s spend', () => {
    const db = new Database(':memory:');
    try {
      const manager = createLLMConfigManager(db, {});
      const first = bootTracker(manager);
      const yesterday = Date.UTC(2030, 0, 1, 12);
      const nextDay = Date.UTC(2030, 0, 2, 9);
      first.recordUsage('slot_1', 5_000, yesterday);
      expect(first.tokensToday('slot_1', yesterday)).toBe(5_000);

      // ⛔⛔ THE READ ALONE MUST SEE THE NEW DAY, BEFORE ANY WRITE. This is the
      // case that matters: `daily_budget_tokens` is enforced by READING this
      // counter and refusing, so a reboot that crossed midnight would meet a
      // budget still holding yesterday's 5,000 — and the only thing that could
      // have cleared it is the call the budget was refusing.
      const second = bootTracker(createLLMConfigManager(db, {}));
      expect(second.tokensToday('slot_1', nextDay)).toBe(0);
      // ⚠ …while the REHYDRATED snapshot still carries day 1, deliberately:
      // `daily_reset_at` records when the buckets were last written, and the
      // persisted cursors ride along with it. The day a surface should show
      // is `currentDay()`.
      expect(second.snapshot().daily_reset_at).toBe('2030-01-01');
      expect(second.currentDay(nextDay)).toBe('2030-01-02');

      // And the write still rolls it, so the owner is not billed twice for a
      // reboot that happened to cross midnight.
      second.recordUsage('slot_1', 10, nextDay);
      expect(second.tokensToday('slot_1', nextDay)).toBe(10);
    } finally { db.close(); }
  });
});
