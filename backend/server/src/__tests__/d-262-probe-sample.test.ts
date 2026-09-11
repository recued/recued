/** D-262 § B7 — the bundled probe clip, and the honesty of its absence.
 *
 *  ⛔ THE SECOND TEST IS THE ONE THAT MATTERS. A probe that answered `ok`
 *  without sending anything would be a "verified" badge for a request that
 *  never left the process — and it would be indistinguishable, on screen, from
 *  a genuinely working slot. So the empty-clip path must report a distinct
 *  verdict, and it must not be `ok`.
 */

import { describe, expect, it } from 'vitest';

import { probeTranscriptionSource } from '@recued/llm';
import type { TranscriptionAdapterRegistry } from '@recued/llm';

import {
  transcriptionProbeSample,
  TRANSCRIPTION_PROBE_SAMPLE_PROVENANCE,
  TRANSCRIPTION_PROBE_SAMPLE_TEXT,
} from '../transcription-probe-sample.js';

const slot = { provider: 'openai' as const, model: 'whisper-1', api_key: 'sk-t' };

const stubAdapters = (heard: string): TranscriptionAdapterRegistry => (key) => ({
  provider: key,
  async transcribe() { return { text: heard }; },
});

describe('D-262 § B7 — the bundled sample clip', () => {
  it('decodes to a real Ogg stream, not a truncated or empty constant', () => {
    const sample = transcriptionProbeSample();
    expect(sample).toBeDefined();
    // ⛔ The container matters: `looksLikeAudio` recognises the `OggS`
    // signature, and every transcription endpoint in the adapter registry
    // accepts Ogg/Opus. A base64 constant that lost its tail would still be a
    // Buffer — only the magic bytes prove it survived the paste.
    expect(Buffer.from(sample!.bytes.subarray(0, 4)).toString('ascii')).toBe('OggS');
    expect(sample!.mime_type).toBe('audio/ogg');
    // Big enough to be speech, small enough to ride the build. A few hundred
    // bytes would mean the constant was clipped.
    expect(sample!.bytes.length).toBeGreaterThan(2_000);
    expect(sample!.bytes.length).toBeLessThan(64_000);
  });

  it('records where it came from, because a bundled binary with no provenance is a licence question nobody can answer later', () => {
    expect(TRANSCRIPTION_PROBE_SAMPLE_PROVENANCE).toContain('Apache-2.0');
    expect(TRANSCRIPTION_PROBE_SAMPLE_PROVENANCE.length).toBeGreaterThan(40);
  });

  it('⛔ NEVER says the product name — a brand a model cannot spell makes a WORKING slot look broken', () => {
    // Every provider mangles something outside its vocabulary differently
    // (recused / re-cued / rescued), and the owner is SHOWN this transcript.
    expect(TRANSCRIPTION_PROBE_SAMPLE_TEXT.toLowerCase()).not.toContain('recued');
    expect(TRANSCRIPTION_PROBE_SAMPLE_TEXT).toMatch(/microphone test/i);
  });

  it('drives the real probe end to end and returns what was heard', async () => {
    const result = await probeTranscriptionSource({
      adapters: stubAdapters('This is a transcript microphone test.'),
      slot,
      sample: transcriptionProbeSample()!,
    });
    expect(result.ok).toBe(true);
    expect(result.diagnosis).toBe('ok');
    // Shown, never asserted against the expected line: models, accents and
    // punctuation differ, and it is what reveals a mis-set language pin.
    expect(result.transcript).toContain('microphone test');
  });

  it('⛔ answers `no_sample` — NOT `ok` — when no clip is bundled', async () => {
    const result = await probeTranscriptionSource({
      adapters: stubAdapters('should never be reached'),
      slot,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnosis).toBe('no_sample');
    expect(result.diagnosis).not.toBe('ok');
  });
});
