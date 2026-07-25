/** D-178 — minisign signature verification + signing (the frozen, embeddable
 *  integrity boundary for the release chain; invariant I-2).
 *
 *  minisign was chosen (spec § Signing) precisely because its format is tiny,
 *  decade-stable, and verifiable with native crypto in ~100 LoC — no external
 *  tool, nothing for the dumb launcher (I-9) to track. This module is the single
 *  TS implementation shared by the two Node consumers (the server self-updater
 *  and the thin-image launcher); the curl/ps1 installer carries its own verify
 *  (a later slice) but reads the SAME signature files.
 *
 *  Format (minisign):
 *    public key  : "untrusted comment: …\n" + base64( "Ed" + keyId[8] + pub[32] )
 *    signature   : "untrusted comment: …\n" + base64( alg[2] + keyId[8] + sig[64] )
 *                  + "\ntrusted comment: <tc>\n" + base64( globalSig[64] )
 *  `alg` is "Ed" (signs the raw content) or "ED" (signs BLAKE2b-512(content) —
 *  minisign's prehashed default). The global signature signs `sig || tc`, so the
 *  trusted comment (which binds filename + version — see § Signing) cannot be
 *  swapped onto another artifact. keyId pins which key signed.
 *
 *  Fail-closed: every malformed input, key-id mismatch, or bad signature returns
 *  `{ ok: false, reason }` — never throws, never returns a partial trust signal.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';

// Raw-key ↔ DER wrappers for Ed25519 (node:crypto needs SPKI/PKCS8, not raw bytes).
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // 12 bytes → +32 pub
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex'); // 16 bytes → +32 seed

const rawToPublicKey = (raw32: Uint8Array) =>
  createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw32)]), format: 'der', type: 'spki' });

const rawSeedToPrivateKey = (seed32: Uint8Array) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed32)]), format: 'der', type: 'pkcs8' });

const blake2b512 = (data: Uint8Array): Buffer => createHash('blake2b512').update(data).digest();

/** Strict base64 decode — `Buffer.from(x, 'base64')` silently drops non-base64
 *  junk, which violates fail-closed parsing (a line with embedded garbage could
 *  still decode to the right length). Reject anything that isn't clean base64
 *  with correct padding before decoding; return null on malformation. */
const decodeBase64Strict = (s: string): Buffer | null => {
  const t = s.trim();
  if (t.length === 0 || t.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  return Buffer.from(t, 'base64');
};

export interface ParsedPublicKey {
  keyId: Buffer; // 8 bytes
  key: Buffer; // 32 bytes
}

/** Parse a minisign public-key file (or just its base64 body line). Returns null
 *  on any malformation. */
export const parsePublicKey = (text: string): ParsedPublicKey | null => {
  try {
    const body = lastNonCommentLine(text);
    if (!body) return null;
    const buf = decodeBase64Strict(body);
    // "Ed" (0x45 0x64) + keyId[8] + pub[32] = 42 bytes
    if (!buf || buf.length !== 42 || buf[0] !== 0x45 || buf[1] !== 0x64) return null;
    return { keyId: buf.subarray(2, 10), key: buf.subarray(10, 42) };
  } catch {
    return null;
  }
};

export interface ParsedSignature {
  algorithm: 'Ed' | 'ED';
  keyId: Buffer; // 8 bytes
  signature: Buffer; // 64 bytes
  trustedComment: string;
  globalSignature: Buffer; // 64 bytes
}

/** Parse a minisign `.minisig` file. Returns null on any malformation. */
export const parseSignature = (text: string): ParsedSignature | null => {
  try {
    const lines = text.split('\n');
    const sigLineIdx = lines.findIndex((l) => !l.startsWith('untrusted comment:') && l.trim().length > 0);
    if (sigLineIdx < 0) return null;
    const sigBuf = decodeBase64Strict(lines[sigLineIdx]);
    // alg[2] + keyId[8] + sig[64] = 74 bytes
    if (!sigBuf || sigBuf.length !== 74) return null;
    const alg = sigBuf.subarray(0, 2).toString('latin1');
    if (alg !== 'Ed' && alg !== 'ED') return null;

    const tcLine = lines.find((l) => l.startsWith('trusted comment:'));
    if (tcLine === undefined) return null;
    const trustedComment = tcLine.slice('trusted comment:'.length).replace(/^\s/, '');

    // The global signature is the first non-empty line AFTER the trusted-comment line.
    const tcIdx = lines.indexOf(tcLine);
    const globalLine = lines.slice(tcIdx + 1).find((l) => l.trim().length > 0);
    if (!globalLine) return null;
    const globalSignature = decodeBase64Strict(globalLine);
    if (!globalSignature || globalSignature.length !== 64) return null;

    return {
      algorithm: alg as 'Ed' | 'ED',
      keyId: sigBuf.subarray(2, 10),
      signature: sigBuf.subarray(10, 74),
      trustedComment,
      globalSignature,
    };
  } catch {
    return null;
  }
};

export interface VerifyResult {
  ok: boolean;
  /** Present only when ok — the caller asserts it binds the expected
   *  filename + version (§ Signing). */
  trustedComment?: string;
  reason?: string;
}

/** Verify `content` against a minisign signature + pinned public key. Fully
 *  fail-closed: returns `{ ok: false, reason }` for every failure path. */
export const verify = (args: {
  content: Uint8Array;
  signatureText: string;
  publicKeyText: string;
}): VerifyResult => {
  if (!(args.content instanceof Uint8Array)) return { ok: false, reason: 'content must be bytes' };
  const pub = parsePublicKey(args.publicKeyText);
  if (!pub) return { ok: false, reason: 'malformed public key' };
  const sig = parseSignature(args.signatureText);
  if (!sig) return { ok: false, reason: 'malformed signature' };
  if (!pub.keyId.equals(sig.keyId)) return { ok: false, reason: 'key id mismatch' };

  // Everything from here can touch native crypto / hashing — wrap it whole so a
  // malformed byte path can never escape the fail-closed contract (I-2).
  try {
    const keyObj = rawToPublicKey(pub.key);
    const signed = sig.algorithm === 'ED' ? blake2b512(args.content) : Buffer.from(args.content);
    if (!edVerify(null, signed, keyObj, sig.signature)) {
      return { ok: false, reason: 'content signature mismatch' };
    }
    // The global signature binds the trusted comment to the content signature.
    const globalMsg = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
    if (!edVerify(null, globalMsg, keyObj, sig.globalSignature)) {
      return { ok: false, reason: 'trusted-comment signature mismatch' };
    }
  } catch {
    return { ok: false, reason: 'verification error' };
  }
  return { ok: true, trustedComment: sig.trustedComment };
};

// ── Signing (CI / key-custody side; never shipped to consumers) ────

export interface Keypair {
  /** 32-byte Ed25519 seed (the secret). */
  secretSeed: Buffer;
  /** 8-byte key id, echoed into pubkey + every signature. */
  keyId: Buffer;
  /** minisign-format public-key file text (the embeddable pin). */
  publicKeyText: string;
}

/** Generate a minisign-compatible keypair. The secret is a raw Ed25519 seed
 *  (our CI holds it directly — we don't parse minisign's password-encrypted
 *  secret-key file). */
export const generateKeypair = (untrustedComment = 'recued release signing key'): Keypair => {
  const kp = generateKeyPairSync('ed25519');
  const privDer = kp.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const pubDer = kp.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const seed = Buffer.from(privDer.subarray(privDer.length - 32)); // raw Ed25519 seed
  const pubRaw = pubDer.subarray(pubDer.length - 32); // raw Ed25519 pub
  const keyId = randomBytes(8);
  return { secretSeed: seed, keyId, publicKeyText: publicKeyText(pubRaw, keyId, untrustedComment) };
};

/** Render a minisign public-key file from a raw 32-byte key + 8-byte id. */
export const publicKeyText = (rawKey32: Uint8Array, keyId: Uint8Array, untrustedComment = 'recued release signing key'): string => {
  const body = Buffer.concat([Buffer.from('Ed', 'latin1'), Buffer.from(keyId), Buffer.from(rawKey32)]).toString('base64');
  return `untrusted comment: ${untrustedComment}\n${body}\n`;
};

/** Produce a minisign `.minisig` over `content`. `prehash` (BLAKE2b, alg "ED")
 *  matches minisign's modern default; `trustedComment` should bind filename +
 *  version (§ Signing). */
export const sign = (args: {
  content: Uint8Array;
  secretSeed: Uint8Array;
  keyId: Uint8Array;
  trustedComment: string;
  untrustedComment?: string;
  prehash?: boolean;
}): string => {
  const priv = rawSeedToPrivateKey(args.secretSeed);
  const prehash = args.prehash !== false; // default true (minisign-compatible)
  const alg = prehash ? 'ED' : 'Ed';
  const signed = prehash ? blake2b512(args.content) : Buffer.from(args.content);
  const sig = edSign(null, signed, priv);
  const sigLine = Buffer.concat([Buffer.from(alg, 'latin1'), Buffer.from(args.keyId), sig]).toString('base64');
  const globalSig = edSign(null, Buffer.concat([sig, Buffer.from(args.trustedComment, 'utf8')]), priv);
  const untrusted = args.untrustedComment ?? 'signature from recued release signer';
  return `untrusted comment: ${untrusted}\n${sigLine}\ntrusted comment: ${args.trustedComment}\n${globalSig.toString('base64')}\n`;
};

/** Derive the minisign public-key text from a signing seed + key id. Lets the
 *  S2/S3 signer PROVE it is signing with the pinned key — derive the pubkey
 *  from the secret it holds and compare against `TRUSTED_RELEASE_PUBKEY`,
 *  catching a "signed with the wrong key" mistake before publish. */
export const publicKeyFromSeed = (
  secretSeed: Uint8Array,
  keyId: Uint8Array,
  untrustedComment = 'recued release signing key',
): string => {
  const priv = rawSeedToPrivateKey(secretSeed);
  const pubDer = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
  const pubRaw = pubDer.subarray(pubDer.length - 32);
  return publicKeyText(pubRaw, keyId, untrustedComment);
};

// ── helpers ────────────────────────────────────────────────────────

/** The last non-empty, non-`untrusted comment:` line — the base64 key body. */
const lastNonCommentLine = (text: string): string | null => {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('untrusted comment:'));
  return lines.length > 0 ? lines[lines.length - 1] : null;
};
