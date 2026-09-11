/** D-262 § B5 — the one-time derivation, and the trap in its trigger.
 *
 *  ⛔⛔ THE OBVIOUS TRIGGER IS WRONG. Keying the derivation on "the slot is
 *  absent" runs it on EVERY boot, so an owner who deliberately clears the slot
 *  finds it silently restored on the next restart — a default they cannot
 *  remove, which reads as the setting being ignored. The marker is what makes
 *  it genuinely one-time, and the third test here is the one that would catch a
 *  regression to the naive form.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createLLMConfigManager } from '../llm-config.js';

const poolEntry = (over: Record<string, unknown> = {}) => ({
  id: 'free-1',
  type: 'api' as const,
  provider: 'openai-compatible' as const,
  model: 'llama-3.1',
  api_key: 'gsk-test',
  base_url: 'https://api.groq.com/openai',
  speed: 'fast' as const,
  supports_json: true,
  enabled: true,
  ...over,
});

const managerWithPool = (entries: ReturnType<typeof poolEntry>[]) => {
  const db = new Database(':memory:');
  const manager = createLLMConfigManager(db, {});
  if (entries.length > 0) manager.setPool(entries as never);
  return { db, manager };
};

describe('D-262 § B5 — deriving the transcription slot from a pool entry', () => {
  it('derives from an entry that declared a transcription model, preserving the OLD resolution', async () => {
    const { db, manager } = managerWithPool([
      poolEntry({ transcription_model: 'whisper-large-v3' }),
    ]);
    try {
      expect(manager.deriveTranscriptionSlotOnce()).toBe('derived');
      const slot = manager.getConfig().transcription_slot;
      // Credentials the owner already had, and the model the retired pool path
      // would have resolved — preserving behaviour is the entire point.
      expect(slot).toMatchObject({
        provider: 'openai-compatible',
        model: 'whisper-large-v3',
        api_key: 'gsk-test',
        base_url: 'https://api.groq.com/openai',
      });
    } finally { db.close(); }
  });

  it('derives from an entry that declared only `modalities.audio`, via the provider default', async () => {
    const { db, manager } = managerWithPool([
      poolEntry({ modalities: { audio: true } }),
    ]);
    try {
      expect(manager.deriveTranscriptionSlotOnce()).toBe('derived');
      expect(manager.getConfig().transcription_slot?.model).toBe('whisper-large-v3');
    } finally { db.close(); }
  });

  it('⛔⛔ NEVER restores a slot the owner deliberately cleared', async () => {
    const { db, manager } = managerWithPool([
      poolEntry({ transcription_model: 'whisper-large-v3' }),
    ]);
    try {
      expect(manager.deriveTranscriptionSlotOnce()).toBe('derived');
      manager.setTranscriptionSlot(null);
      expect(manager.getConfig().transcription_slot).toBeUndefined();

      // The pool entry is still there and the slot is absent — which is exactly
      // the state the naive "derive when absent" trigger would re-fire on, on
      // every restart, forever.
      expect(manager.deriveTranscriptionSlotOnce()).toBe('already_marked');
      expect(manager.getConfig().transcription_slot).toBeUndefined();
    } finally { db.close(); }
  });

  it('leaves an already-configured slot alone, and marks so it is never revisited', async () => {
    const { db, manager } = managerWithPool([
      poolEntry({ transcription_model: 'whisper-large-v3' }),
    ]);
    try {
      manager.setTranscriptionSlot({
        provider: 'openai', model: 'whisper-1', api_key: 'sk-mine',
      });
      expect(manager.deriveTranscriptionSlotOnce()).toBe('already_marked');
      // The owner's own choice survives — the migration never overwrites.
      expect(manager.getConfig().transcription_slot?.api_key).toBe('sk-mine');
    } finally { db.close(); }
  });

  it('⚠ marks even when there was NOTHING to derive, so it is one-time and not a standing rule', async () => {
    const { db, manager } = managerWithPool([poolEntry()]); // no audio, no transcription model
    try {
      expect(manager.deriveTranscriptionSlotOnce()).toBe('no_candidate');
      // Adding an audio entry LATER is configuring, not migrating — a slot must
      // not appear months after the upgrade because the pool changed.
      manager.setPool([poolEntry({ transcription_model: 'whisper-large-v3' })] as never);
      expect(manager.deriveTranscriptionSlotOnce()).toBe('already_marked');
      expect(manager.getConfig().transcription_slot).toBeUndefined();
    } finally { db.close(); }
  });

  it('⛔ derives from an audio-capable BYOK SLOT when the pool has nothing — the gap the first cut missed', async () => {
    // `transcribe` used to match over slot_1 / slot_2 / free_pool alike, so an
    // owner whose transcription ran off a BYOK slot had a working setup. The
    // first version of this migration looked only at the pool, so that owner
    // would have found voice notes simply stopped — with a correctly marked
    // migration reporting `no_candidate`, which is the worst kind of silence.
    const db = new Database(':memory:');
    const manager = createLLMConfigManager(db, {});
    try {
      manager.setSlot1({
        provider: 'openai', model: 'gpt-4.1-mini', api_key: 'sk-byok',
        speed: 'fast', supports_json: true, modalities: { audio: true },
      } as never);
      expect(manager.deriveTranscriptionSlotOnce()).toBe('derived');
      expect(manager.getConfig().transcription_slot).toMatchObject({
        provider: 'openai',
        // No transcription model was named, so the provider default stands —
        // the same resolution the retired pool path applied.
        model: 'whisper-1',
        api_key: 'sk-byok',
      });
    } finally { db.close(); }
  });

  it('⚠ PREFERS THE POOL over a BYOK slot, because that is the order the old routing resolved in', async () => {
    // Deriving the paid slot where the free pool used to answer would start
    // billing an owner who was not being billed. Preserving WHICH source served
    // transcription matters as much as preserving that one did.
    const db = new Database(':memory:');
    const manager = createLLMConfigManager(db, {});
    try {
      manager.setSlot1({
        provider: 'openai', model: 'gpt-4.1-mini', api_key: 'sk-paid',
        speed: 'fast', supports_json: true, modalities: { audio: true },
      } as never);
      manager.setPool([poolEntry({ modalities: { audio: true } })] as never);
      expect(manager.deriveTranscriptionSlotOnce()).toBe('derived');
      expect(manager.getConfig().transcription_slot?.api_key).toBe('gsk-test');
    } finally { db.close(); }
  });

  it('ignores a slot with no audio capability at all', async () => {
    const db = new Database(':memory:');
    const manager = createLLMConfigManager(db, {});
    try {
      manager.setSlot1({
        provider: 'openai', model: 'gpt-4.1-mini', api_key: 'sk',
        speed: 'fast', supports_json: true,
      } as never);
      expect(manager.deriveTranscriptionSlotOnce()).toBe('no_candidate');
    } finally { db.close(); }
  });

  it('ignores a DISABLED pool entry — a disabled source is the owner saying "not this"', async () => {
    const { db, manager } = managerWithPool([
      poolEntry({ enabled: false, transcription_model: 'whisper-large-v3' }),
    ]);
    try {
      expect(manager.deriveTranscriptionSlotOnce()).toBe('no_candidate');
    } finally { db.close(); }
  });

  it('is idempotent across repeated boots', async () => {
    const { db, manager } = managerWithPool([
      poolEntry({ transcription_model: 'whisper-large-v3' }),
    ]);
    try {
      expect(manager.deriveTranscriptionSlotOnce()).toBe('derived');
      expect(manager.deriveTranscriptionSlotOnce()).toBe('already_marked');
      expect(manager.deriveTranscriptionSlotOnce()).toBe('already_marked');
    } finally { db.close(); }
  });
});

// ── the locked upgrade ─────────────────────────────────────────────
//
// ⛔⛔ REVIEW FINDING (2026-09-07). "NOTHING TO FIND" AND "COULD NOT LOOK" ARE
// DIFFERENT ANSWERS, AND THE MIGRATION READ THEM AS THE SAME ONE. On a locked
// server the pool blob is encrypted with no DEK available, and `getPool()`
// deliberately returns `[]` rather than throwing — right for SERVING (a locked
// pool is simply no source right now), wrong for a ONE-TIME migration. The
// derivation saw an empty pool, concluded `no_candidate`, and wrote the marker
// that says it already ran. Unlocking and restarting could never recover it:
// the owner's audio pool entry stays underived forever, and nothing reports it.
//
// ⚠ `getPool()`'s own comment names the fix — "mutating ops use `readPoolStrict`
// instead so a locked write surfaces the 423" — and the migration is a mutating
// op. The rule was written down and this caller did not follow it.
describe('D-262 § B5 — a LOCKED server defers the migration instead of burning it', () => {
  const KEY = Buffer.alloc(32, 7);

  /** Write an encrypted pool with a DEK, then reopen with none — a server that
   *  was configured while unlocked and has now rebooted locked. */
  const lockedWithEncryptedPool = () => {
    const db = new Database(':memory:');
    const unlocked = createLLMConfigManager(db, {
      getEncryptionKey: () => KEY,
    });
    unlocked.setPool([poolEntry({ transcription_model: 'whisper-large-v3' })] as never);
    const locked = createLLMConfigManager(db, {});
    return { db, locked, reopened: () => createLLMConfigManager(db, { getEncryptionKey: () => KEY }) };
  };

  it('the premise: a locked read reports an EMPTY pool rather than failing', () => {
    const { db, locked } = lockedWithEncryptedPool();
    try {
      // Not a bug on its own — this is what makes the migration's read blind.
      expect(locked.getPool()).toEqual([]);
    } finally { db.close(); }
  });

  it('⛔ defers rather than concluding `no_candidate`', () => {
    const { db, locked } = lockedWithEncryptedPool();
    try {
      expect(locked.deriveTranscriptionSlotOnce()).toBe('deferred_locked');
    } finally { db.close(); }
  });

  it('⛔⛔ AND THE NEXT BOOT AFTER AN UNLOCK STILL DERIVES — the marker was not spent', () => {
    const { db, locked, reopened } = lockedWithEncryptedPool();
    try {
      expect(locked.deriveTranscriptionSlotOnce()).toBe('deferred_locked');
      // The owner unlocks and restarts. This is the assertion that fails
      // without the fix: the marker would already say "ran", and the audio
      // entry would never be derived however many times they reboot.
      const after = reopened();
      expect(after.deriveTranscriptionSlotOnce()).toBe('derived');
      expect(after.getConfig().transcription_slot?.model).toBe('whisper-large-v3');
    } finally { db.close(); }
  });

  it('⚠ and an UNLOCKED server with a genuinely empty pool still concludes `no_candidate`', () => {
    // The inverse, so the fix cannot be "always defer": a real absence must
    // still spend the one-time run, or the migration never completes.
    const db = new Database(':memory:');
    try {
      expect(createLLMConfigManager(db, {}).deriveTranscriptionSlotOnce()).toBe('no_candidate');
    } finally { db.close(); }
  });
});
