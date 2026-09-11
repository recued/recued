/** D-262 § B12.3 — transcription is metered in its OWN units, and capped.
 *
 *  ⛔ THE UNIT IS THE WHOLE DESIGN. Providers bill by audio seconds; the
 *  multipart endpoints report a duration only in their verbose response format
 *  and Gemini's `generateContent` reports none at all. So seconds are recorded
 *  when offered and never relied on, bytes are always exact, and the CAP counts
 *  requests — the one quantity that is always known. Converting any of them
 *  into "tokens" would put a fabricated number into the same column as measured
 *  ones, where no reader could tell them apart.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { transcribe } from '../transcribe.js';
import { createQuotaTracker } from '../quota.js';
import type { LLMConfig } from '../types.js';
import type { TranscriptionAdapterRegistry } from '../adapters/transcription.js';

const slot = { provider: 'openai' as const, model: 'whisper-1', api_key: 'sk-t' };
const audio = new Uint8Array(1_500);

const adapters = (over: { duration_s?: number } = {}): TranscriptionAdapterRegistry =>
  (key) => ({
    provider: key,
    async transcribe() {
      return { text: 'heard it', ...(over.duration_s !== undefined ? { duration_s: over.duration_s } : {}) };
    },
  });

const failing: TranscriptionAdapterRegistry = (key) => ({
  provider: key,
  async transcribe() { throw new Error('provider exploded'); },
});

const run = async (config: LLMConfig, quota = createQuotaTracker(), reg = adapters()) =>
  transcribe({ audio, mime_type: 'audio/ogg' }, { config, adapters: reg, quota });

afterEach(() => { vi.useRealTimers(); });

describe('D-262 § B12.3 — what gets recorded', () => {
  it('records requests and BYTES on every call — both always exact', async () => {
    const quota = createQuotaTracker();
    await run({ transcription_slot: slot }, quota);
    await run({ transcription_slot: slot }, quota);
    expect(quota.transcriptionRequestsToday('transcription_slot')).toBe(2);
    expect(quota.transcriptionBytesToday('transcription_slot')).toBe(3_000);
  });

  it('records seconds ONLY when the provider reported a duration', async () => {
    const quota = createQuotaTracker();
    await run({ transcription_slot: slot }, quota, adapters({ duration_s: 12.5 }));
    expect(quota.transcriptionSecondsToday('transcription_slot')).toBe(12.5);

    // ⚠ A provider that reports none leaves the counter untouched rather than
    // adding an estimate. An under-count you can explain beats a figure that
    // looks measured and is not.
    await run({ transcription_slot: slot }, quota, adapters());
    expect(quota.transcriptionSecondsToday('transcription_slot')).toBe(12.5);
    expect(quota.transcriptionRequestsToday('transcription_slot')).toBe(2);
  });

  it('⛔ NEVER touches the token bucket — audio seconds are not tokens', async () => {
    const quota = createQuotaTracker();
    await run({ transcription_slot: slot }, quota, adapters({ duration_s: 30 }));
    // `tokensToday` feeds `daily_budget_tokens` cutoffs for chat and embeddings.
    // Anything written here would silently move those budgets.
    expect(quota.tokensToday('transcription_slot')).toBe(0);
    expect(quota.embeddingsTokensToday('transcription_slot')).toBe(0);
  });

  it('does NOT charge a failed call against the allowance', async () => {
    const quota = createQuotaTracker();
    await expect(run({ transcription_slot: slot }, quota, failing)).rejects.toThrow();
    // Recorded after success, matching how chat records usage — an owner should
    // not lose their daily allowance to the provider having a bad minute.
    expect(quota.transcriptionRequestsToday('transcription_slot')).toBe(0);
    expect(quota.transcriptionBytesToday('transcription_slot')).toBe(0);
  });

  it('survives a snapshot round-trip, and stays out of tokens_today there too', async () => {
    const quota = createQuotaTracker();
    await run({ transcription_slot: slot }, quota, adapters({ duration_s: 4 }));
    const snap = quota.snapshot();
    expect(snap.transcription_requests_today).toEqual({ transcription_slot: 1 });
    expect(snap.transcription_bytes_today).toEqual({ transcription_slot: 1_500 });
    expect(snap.transcription_seconds_today).toEqual({ transcription_slot: 4 });
    expect(snap.tokens_today).toEqual({});

    const rehydrated = createQuotaTracker(snap);
    expect(rehydrated.transcriptionRequestsToday('transcription_slot')).toBe(1);
  });

  it('omits the transcription keys entirely when nothing has transcribed', () => {
    const snap = createQuotaTracker().snapshot();
    expect(snap.transcription_requests_today).toBeUndefined();
    expect(snap.transcription_bytes_today).toBeUndefined();
  });
});

describe('D-262 § B12.3 — the daily cap', () => {
  const capped = (limit: number): LLMConfig => ({
    transcription_slot: slot,
    transcription_daily_requests: limit,
  });

  it('⛔ REFUSES BEFORE THE CALL once the cap is reached', async () => {
    const quota = createQuotaTracker();
    let calls = 0;
    const counting: TranscriptionAdapterRegistry = (key) => ({
      provider: key,
      async transcribe() { calls += 1; return { text: 'ok' }; },
    });
    await run(capped(2), quota, counting);
    await run(capped(2), quota, counting);
    await expect(run(capped(2), quota, counting)).rejects.toMatchObject({
      code: 'AI_TOKEN_BUDGET_EXCEEDED',
    });
    // ⛔ Two, not three. A budget enforced only on the way OUT would let the
    // very call it exists to prevent happen first.
    expect(calls).toBe(2);
  });

  it('says how much was used and what the limit is', async () => {
    const quota = createQuotaTracker();
    await run(capped(1), quota);
    const err = await run(capped(1), quota).catch((e: unknown) => e);
    expect((err as { details?: Record<string, unknown> }).details)
      .toMatchObject({ used: 1, limit: 1 });
    expect(String((err as Error).message)).toContain('1/1');
  });

  it('⛔⛔ THE CAP CLEARS AT THE UTC DAY BOUNDARY — the message promises it does', async () => {
    // The refusal says "It resets at 00:00 UTC". That is a promise, and the
    // only thing that can keep it is the tracker rolling its day bucket.
    //
    // ⛔ THE TRAP THIS COVERS: the cap is enforced on a READ
    // (`transcriptionRequestsToday`), and the pure reads deliberately do NOT
    // roll the day — `tokensToday` / `embeddingsTokensToday` document that the
    // next WRITE will clear the bucket. That reasoning holds for chat, whose
    // reads are informational and whose `statusFor` rolls on every selection.
    // ⇒ It does NOT hold here: the read IS the gate, it refuses before any
    // write, and slice 3 removed `matchLLM` from this path so nothing calls
    // `statusFor` either. A cap reached on day 1 would never clear — and the
    // only thing that could clear it is the call the cap is blocking.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    const quota = createQuotaTracker();
    await run(capped(1), quota);
    await expect(run(capped(1), quota)).rejects.toMatchObject({
      code: 'AI_TOKEN_BUDGET_EXCEEDED',
    });

    // Next UTC day, and NOTHING has written to the tracker in between.
    vi.setSystemTime(new Date('2026-09-07T00:30:00Z'));
    await expect(run(capped(1), quota)).resolves.toMatchObject({ text: 'heard it' });
    expect(quota.transcriptionRequestsToday('transcription_slot')).toBe(1);
  });

  it('⛔ and the boundary is the only thing that clears it — same day still refuses', async () => {
    // The inverse, so the fix cannot be "always return 0". Crossing 23:59 to
    // 23:59 of the SAME day must still refuse.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T00:10:00Z'));
    const quota = createQuotaTracker();
    await run(capped(1), quota);
    vi.setSystemTime(new Date('2026-09-06T23:59:00Z'));
    await expect(run(capped(1), quota)).rejects.toMatchObject({
      code: 'AI_TOKEN_BUDGET_EXCEEDED',
    });
  });

  it('⛔ treats absent and non-positive as UNLIMITED, never as "block everything"', async () => {
    // A cap of 0 meaning "refuse all" would turn a fat-fingered field into a
    // silently disabled feature, indistinguishable from a broken slot.
    for (const config of [
      { transcription_slot: slot },
      { transcription_slot: slot, transcription_daily_requests: 0 },
    ] as LLMConfig[]) {
      const quota = createQuotaTracker();
      for (let i = 0; i < 5; i += 1) await run(config, quota);
      expect(quota.transcriptionRequestsToday('transcription_slot')).toBe(5);
    }
  });
});

describe('D-262 § B12.3 — the embeddings budget the same slice fixes', () => {
  it('⛔ enforces `daily_budget_tokens` on the embeddings slot, which nothing did before', async () => {
    const { buildEmbeddingsAvailability } = await import('../embeddings/availability.js');
    const embSlot = { provider: 'openai' as const, model: 'text-embedding-3-small', api_key: 'sk-e', daily_budget_tokens: 1_000 };
    const quota = createQuotaTracker();

    expect(buildEmbeddingsAvailability({ config: { embeddings_slot: embSlot }, quota })
      .embeddings_slot.available).toBe(true);

    // D-131 has recorded embeddings tokens under this key all along; only the
    // comparison was missing, so the owner's cap was a field that did nothing.
    quota.recordEmbeddingsUsage('embeddings_slot', 1_000);
    const after = buildEmbeddingsAvailability({ config: { embeddings_slot: embSlot }, quota })
      .embeddings_slot;
    expect(after.available).toBe(false);
    expect(after.available === false && after.reason).toBe('quota_exhausted');
  });

  it('treats an absent budget as unlimited, not as zero', async () => {
    const { buildEmbeddingsAvailability } = await import('../embeddings/availability.js');
    const embSlot = { provider: 'openai' as const, model: 'text-embedding-3-small', api_key: 'sk-e' };
    const quota = createQuotaTracker();
    quota.recordEmbeddingsUsage('embeddings_slot', 10_000_000);
    expect(buildEmbeddingsAvailability({ config: { embeddings_slot: embSlot }, quota })
      .embeddings_slot.available).toBe(true);
  });
});
