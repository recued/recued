/** 24-word BIP39 recovery key.
 *
 *  256 bits of entropy → 24 English words. Human-writable, speakable,
 *  and audit-trail-safe. The recovery key unlocks Master DEK directly
 *  via HKDF (see kdf.ts) — no password pass needed because the entropy
 *  is already cryptographic.
 *
 *  English-only in v1. BIP39 supports other wordlists but adding them
 *  is a product decision (which locale? how does the user pick? what's
 *  the recovery flow if they wrote it down in one locale and someone
 *  else tries to restore it?). Defer until there's a concrete ask.
 */

import {
  generateMnemonic,
  mnemonicToEntropy,
  entropyToMnemonic,
  validateMnemonic,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { randomBytes } from './kdf.js';

/** 256-bit entropy → 24 words. */
const ENTROPY_BITS = 256;
const ENTROPY_BYTES = ENTROPY_BITS / 8;

/** Generate a fresh 24-word recovery key. Returns both the mnemonic
 *  string (user-facing) and the entropy bytes (what KDF consumes).
 *  Return them together so callers don't re-parse the mnemonic. */
export const generateRecoveryKey = (): { mnemonic: string; entropy: Uint8Array } => {
  const entropy = randomBytes(ENTROPY_BYTES);
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  return { mnemonic, entropy };
};

/** Parse a user-provided mnemonic into entropy bytes.
 *  Throws if the mnemonic is malformed or the checksum fails. */
export const recoveryKeyToEntropy = (mnemonic: string): Uint8Array => {
  const trimmed = mnemonic.trim().split(/\s+/).join(' ').toLowerCase();
  if (!validateMnemonic(trimmed, wordlist)) {
    throw new Error('recovery: invalid mnemonic (wrong word count, typo, or bad checksum)');
  }
  return mnemonicToEntropy(trimmed, wordlist);
};

/** Validate without throwing. Useful for live-typed input where the
 *  user may still be entering words. */
export const isValidRecoveryKey = (mnemonic: string): boolean => {
  const trimmed = mnemonic.trim().split(/\s+/).join(' ').toLowerCase();
  return validateMnemonic(trimmed, wordlist);
};

/** Words per recovery key. v1 = 24. */
export const RECOVERY_KEY_WORD_COUNT = 24;

// Re-export generateMnemonic for callers who want BIP39 directly.
export { generateMnemonic };
