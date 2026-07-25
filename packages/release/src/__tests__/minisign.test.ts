import { describe, expect, it } from 'vitest';
import { generateKeypair, parsePublicKey, parseSignature, sign, verify } from '../minisign.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('minisign round-trip', () => {
  const kp = generateKeypair();
  const content = enc('recued-linux-x64 v1.4.2 artifact bytes');
  const tc = 'file:recued-linux-x64 version:1.4.2';

  it('verifies a freshly-signed artifact (prehashed default) + returns the trusted comment', () => {
    const sig = sign({ content, secretSeed: kp.secretSeed, keyId: kp.keyId, trustedComment: tc });
    const res = verify({ content, signatureText: sig, publicKeyText: kp.publicKeyText });
    expect(res.ok).toBe(true);
    expect(res.trustedComment).toBe(tc);
  });

  it('verifies the legacy non-prehashed (Ed) form too', () => {
    const sig = sign({ content, secretSeed: kp.secretSeed, keyId: kp.keyId, trustedComment: tc, prehash: false });
    expect(parseSignature(sig)?.algorithm).toBe('Ed');
    expect(verify({ content, signatureText: sig, publicKeyText: kp.publicKeyText }).ok).toBe(true);
  });

  it('parses the public key id + 32-byte key', () => {
    const pub = parsePublicKey(kp.publicKeyText);
    expect(pub?.keyId.equals(kp.keyId)).toBe(true);
    expect(pub?.key.length).toBe(32);
  });
});

describe('minisign tamper detection (fail-closed)', () => {
  const kp = generateKeypair();
  const content = enc('artifact');
  const sig = sign({ content, secretSeed: kp.secretSeed, keyId: kp.keyId, trustedComment: 'file:a version:1' });

  it('rejects tampered content', () => {
    const res = verify({ content: enc('artifact!'), signatureText: sig, publicKeyText: kp.publicKeyText });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/content signature/);
  });

  it('rejects a signature verified against a different key (id mismatch)', () => {
    const other = generateKeypair();
    const res = verify({ content, signatureText: sig, publicKeyText: other.publicKeyText });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/key id/);
  });

  it('rejects a trusted-comment swap (global signature binds it)', () => {
    // Take a valid sig and substitute its trusted-comment line for an attacker's.
    const swapped = sig.replace(/^trusted comment:.*$/m, 'trusted comment: file:evil version:9.9.9');
    const res = verify({ content, signatureText: swapped, publicKeyText: kp.publicKeyText });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/trusted-comment signature/);
  });

  it('rejects a content-sig replayed under a different key id pinned to the wrong pub', () => {
    // Re-sign the SAME content with a different key but keep the victim's key id
    // bytes in the line — the content sig won't verify against the victim's pub.
    const attacker = generateKeypair();
    const forged = sign({ content, secretSeed: attacker.secretSeed, keyId: kp.keyId, trustedComment: 'file:a version:1' });
    const res = verify({ content, signatureText: forged, publicKeyText: kp.publicKeyText });
    expect(res.ok).toBe(false); // key id matches but the signature is from a foreign key
    expect(res.reason).toMatch(/content signature/);
  });

  it('returns ok:false (never throws) on malformed inputs', () => {
    expect(verify({ content, signatureText: 'garbage', publicKeyText: kp.publicKeyText }).ok).toBe(false);
    expect(verify({ content, signatureText: sig, publicKeyText: 'garbage' }).ok).toBe(false);
    expect(parsePublicKey('nope')).toBeNull();
    expect(parseSignature('nope')).toBeNull();
  });

  it('rejects base64 lines with embedded junk (strict decode)', () => {
    // Corrupt the pubkey body with a non-base64 char of the same length class.
    const dirtyPub = kp.publicKeyText.replace(/\n([^\n]+)\n?$/, '\n!!!!garbage!!!!\n');
    expect(parsePublicKey(dirtyPub)).toBeNull();
    expect(verify({ content, signatureText: sig, publicKeyText: dirtyPub }).ok).toBe(false);
  });

  it('guards non-byte content without throwing', () => {
    // @ts-expect-error — exercising the runtime fail-closed guard at the boundary
    expect(verify({ content: 'not bytes', signatureText: sig, publicKeyText: kp.publicKeyText }).ok).toBe(false);
  });
});
