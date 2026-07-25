/** D-148 § A.5.3 / § A.6.5 — `generateCsr` PKCS#10 emitter tests.
 *
 *  Verifies the production Node-side CSR emitter that backs the
 *  `AcmeDomainRenewerOptions.generateCsr` seam. Coverage:
 *
 *    - Output is a PEM `CERTIFICATE REQUEST` block (header + base64
 *      body + footer; 64-char lines per RFC 7468).
 *    - Output NEVER carries a PRIVATE KEY block — defending the
 *      renewer's defensive pre-flight gate from upstream.
 *    - The CSR parses back through Node's TLS substrate (round-trip
 *      via `createPublicKey` over the embedded SPKI) — proves the
 *      DER is structurally valid.
 *    - CN + SAN both match the input domain (the cloud ACME helper
 *      validates both — § A.5.3).
 *    - The Ed25519 signature verifies against the embedded public key.
 *    - Non-Ed25519 keys (RSA / EC) reject with the typed code.
 *    - Malformed PEM rejects.
 *    - Empty / non-ASCII / oversized domains reject.
 *    - Composing with `createAcmeDomainRenewer` exercises the full
 *      issue path with a real CSR.
 *
 *  Spec: `docs/d-148-spec.md` § A.5.3 + § A.6.5. */

import { describe, expect, it } from 'vitest';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify as nodeVerify,
} from 'node:crypto';
import type {
  TLSDomainCertChain,
  TLSDomainUploadResult,
} from '@recued/contracts';

import {
  generateCsr,
  GENERATE_CSR_ERRORS,
} from '../keys/rotation/generate-csr.js';
import {
  createAcmeDomainRenewer,
  type AcmeCertIssuer,
} from '../keys/rotation/acme-domain-renewer.js';
import type { SqliteTlsDomainStore } from '../tls/domain-store.js';

// ────────────────────────────────────────────────────────────────
// Scaffolding
// ────────────────────────────────────────────────────────────────

const newEd25519PrivateKeyPem = (): string => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
};

const newRsaPrivateKeyPem = (): string => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
};

const newEcPrivateKeyPem = (): string => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
};

// ────────────────────────────────────────────────────────────────
// DER minimal parser — enough to read back the CSR shape we emit
// without pulling another dep. Walks SEQUENCEs, extracts the CRI
// fields, finds the SAN block, verifies the signature.
// ────────────────────────────────────────────────────────────────

interface DerNode {
  tag: number;
  contentStart: number;
  contentLength: number;
  totalLength: number;
}

const readDer = (buf: Buffer, offset: number): DerNode => {
  const tag = buf[offset];
  if (tag === undefined) {
    throw new Error('der_truncated_tag');
  }
  let lenByte = buf[offset + 1];
  if (lenByte === undefined) {
    throw new Error('der_truncated_length');
  }
  let lenLen = 1;
  let contentLength: number;
  if ((lenByte & 0x80) === 0) {
    contentLength = lenByte;
  } else {
    const count = lenByte & 0x7f;
    contentLength = 0;
    for (let i = 0; i < count; i++) {
      const b = buf[offset + 2 + i];
      if (b === undefined) {
        throw new Error('der_truncated_long_length');
      }
      contentLength = contentLength * 256 + b;
    }
    lenLen = 1 + count;
  }
  return {
    tag,
    contentStart: offset + 1 + lenLen,
    contentLength,
    totalLength: 1 + lenLen + contentLength,
  };
};

const pemBodyToDer = (pem: string, label: string): Buffer => {
  const beginMarker = `-----BEGIN ${label}-----`;
  const endMarker = `-----END ${label}-----`;
  const begin = pem.indexOf(beginMarker);
  const end = pem.indexOf(endMarker);
  if (begin < 0 || end < 0) {
    throw new Error(`pem_missing_${label.toLowerCase().replace(/ /g, '_')}`);
  }
  const body = pem.slice(begin + beginMarker.length, end);
  return Buffer.from(body.replace(/\s+/g, ''), 'base64');
};

interface CsrShape {
  /** The base64-decoded DER bytes of the full CertificationRequest. */
  csrDer: Buffer;
  /** The base64-decoded DER bytes of CertificationRequestInfo (the
   *  signed-over portion). */
  criDer: Buffer;
  /** The SubjectPublicKeyInfo bytes (DER) — feeds `createPublicKey`. */
  spkiDer: Buffer;
  /** Common-name value (UTF-8 decoded). */
  commonName: string;
  /** SAN dNSName entries. */
  sanDnsNames: string[];
  /** Outer signature bytes (Ed25519: 64 bytes). */
  signature: Buffer;
}

const parseCsr = (pem: string): CsrShape => {
  const csrDer = pemBodyToDer(pem, 'CERTIFICATE REQUEST');
  // Outer SEQUENCE
  const outer = readDer(csrDer, 0);
  expect(outer.tag).toBe(0x30);
  // CertificationRequestInfo (first child) — full TLV is what's signed.
  const criNode = readDer(csrDer, outer.contentStart);
  expect(criNode.tag).toBe(0x30);
  const criDer = csrDer.subarray(
    outer.contentStart,
    outer.contentStart + criNode.totalLength,
  );
  // CRI children: INTEGER version, SEQUENCE subject, SEQUENCE spki, [0] attributes
  const versionNode = readDer(csrDer, criNode.contentStart);
  expect(versionNode.tag).toBe(0x02);
  const subjectNode = readDer(
    csrDer,
    criNode.contentStart + versionNode.totalLength,
  );
  expect(subjectNode.tag).toBe(0x30);
  const spkiNode = readDer(
    csrDer,
    criNode.contentStart + versionNode.totalLength + subjectNode.totalLength,
  );
  expect(spkiNode.tag).toBe(0x30);
  const attributesNode = readDer(
    csrDer,
    criNode.contentStart +
      versionNode.totalLength +
      subjectNode.totalLength +
      spkiNode.totalLength,
  );
  expect(attributesNode.tag).toBe(0xa0);
  const spkiDer = csrDer.subarray(
    criNode.contentStart + versionNode.totalLength + subjectNode.totalLength,
    criNode.contentStart +
      versionNode.totalLength +
      subjectNode.totalLength +
      spkiNode.totalLength,
  );
  // Extract CN: subject → RDN(SET) → AttributeTypeAndValue(SEQUENCE) → OID + UTF8String
  const rdnNode = readDer(csrDer, subjectNode.contentStart);
  expect(rdnNode.tag).toBe(0x31);
  const atvNode = readDer(csrDer, rdnNode.contentStart);
  expect(atvNode.tag).toBe(0x30);
  const oidNode = readDer(csrDer, atvNode.contentStart);
  expect(oidNode.tag).toBe(0x06);
  const cnNode = readDer(csrDer, atvNode.contentStart + oidNode.totalLength);
  expect(cnNode.tag).toBe(0x0c);
  const commonName = csrDer
    .subarray(cnNode.contentStart, cnNode.contentStart + cnNode.contentLength)
    .toString('utf8');
  // Extract SAN: attributes [0] → extensionRequest(SEQUENCE { OID, SET { SEQUENCE { SEQUENCE { OID, OCTET STRING } } } })
  const extReqNode = readDer(csrDer, attributesNode.contentStart);
  expect(extReqNode.tag).toBe(0x30);
  // skip the extensionRequest OID
  const extReqOidNode = readDer(csrDer, extReqNode.contentStart);
  expect(extReqOidNode.tag).toBe(0x06);
  const extReqSetNode = readDer(
    csrDer,
    extReqNode.contentStart + extReqOidNode.totalLength,
  );
  expect(extReqSetNode.tag).toBe(0x31);
  const extensionsSeq = readDer(csrDer, extReqSetNode.contentStart);
  expect(extensionsSeq.tag).toBe(0x30);
  const sanExtNode = readDer(csrDer, extensionsSeq.contentStart);
  expect(sanExtNode.tag).toBe(0x30);
  const sanOidNode = readDer(csrDer, sanExtNode.contentStart);
  expect(sanOidNode.tag).toBe(0x06);
  const sanValueNode = readDer(
    csrDer,
    sanExtNode.contentStart + sanOidNode.totalLength,
  );
  expect(sanValueNode.tag).toBe(0x04);
  // Inside the OCTET STRING is a SEQUENCE OF GeneralName
  const generalNamesNode = readDer(csrDer, sanValueNode.contentStart);
  expect(generalNamesNode.tag).toBe(0x30);
  const sanDnsNames: string[] = [];
  let cursor = generalNamesNode.contentStart;
  const sanEnd = generalNamesNode.contentStart + generalNamesNode.contentLength;
  while (cursor < sanEnd) {
    const entry = readDer(csrDer, cursor);
    if (entry.tag === 0x82) {
      sanDnsNames.push(
        csrDer
          .subarray(entry.contentStart, entry.contentStart + entry.contentLength)
          .toString('ascii'),
      );
    }
    cursor += entry.totalLength;
  }
  // Outer children after CRI: signatureAlgorithm + signature BIT STRING
  const sigAlgNode = readDer(
    csrDer,
    outer.contentStart + criNode.totalLength,
  );
  expect(sigAlgNode.tag).toBe(0x30);
  const sigBitsNode = readDer(
    csrDer,
    outer.contentStart + criNode.totalLength + sigAlgNode.totalLength,
  );
  expect(sigBitsNode.tag).toBe(0x03);
  // BIT STRING content starts with a `unusedBits` byte (0 for Ed25519)
  const unusedBits = csrDer[sigBitsNode.contentStart];
  expect(unusedBits).toBe(0);
  const signature = csrDer.subarray(
    sigBitsNode.contentStart + 1,
    sigBitsNode.contentStart + sigBitsNode.contentLength,
  );
  return { csrDer, criDer, spkiDer, commonName, sanDnsNames, signature };
};

// ────────────────────────────────────────────────────────────────
// Shape
// ────────────────────────────────────────────────────────────────

describe('generateCsr — output shape', () => {
  it('produces a PEM CERTIFICATE REQUEST block', () => {
    const key_pem = newEd25519PrivateKeyPem();
    const csr_pem = generateCsr({
      domain: 'alice.recued.net',
      private_key_pem: key_pem,
    });
    expect(csr_pem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----\n/);
    expect(csr_pem).toMatch(/-----END CERTIFICATE REQUEST-----\n$/);
  });

  it('NEVER embeds a PRIVATE KEY block in the output', () => {
    const key_pem = newEd25519PrivateKeyPem();
    const csr_pem = generateCsr({
      domain: 'alice.recued.net',
      private_key_pem: key_pem,
    });
    expect(csr_pem).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });

  it('wraps base64 body at 64 chars per RFC 7468', () => {
    const key_pem = newEd25519PrivateKeyPem();
    const csr_pem = generateCsr({
      domain: 'alice.recued.net',
      private_key_pem: key_pem,
    });
    const body = csr_pem
      .replace('-----BEGIN CERTIFICATE REQUEST-----\n', '')
      .replace('-----END CERTIFICATE REQUEST-----\n', '');
    const lines = body.split('\n').filter((l) => l.length > 0);
    for (let i = 0; i < lines.length - 1; i++) {
      expect(lines[i]!.length).toBe(64);
    }
    expect(lines[lines.length - 1]!.length).toBeLessThanOrEqual(64);
  });

  it('parses as valid DER end-to-end', () => {
    const key_pem = newEd25519PrivateKeyPem();
    const csr_pem = generateCsr({
      domain: 'alice.recued.net',
      private_key_pem: key_pem,
    });
    expect(() => parseCsr(csr_pem)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// CN + SAN match the input domain
// ────────────────────────────────────────────────────────────────

describe('generateCsr — CN + SAN matching', () => {
  it('sets CN to the input domain', () => {
    const key_pem = newEd25519PrivateKeyPem();
    const csr_pem = generateCsr({
      domain: 'alice.recued.net',
      private_key_pem: key_pem,
    });
    const shape = parseCsr(csr_pem);
    expect(shape.commonName).toBe('alice.recued.net');
  });

  it('sets SAN dNSName to the input domain', () => {
    const key_pem = newEd25519PrivateKeyPem();
    const csr_pem = generateCsr({
      domain: 'alice.recued.net',
      private_key_pem: key_pem,
    });
    const shape = parseCsr(csr_pem);
    expect(shape.sanDnsNames).toEqual(['alice.recued.net']);
  });

  it('handles BYO domain (not under .recued.net)', () => {
    const key_pem = newEd25519PrivateKeyPem();
    const csr_pem = generateCsr({
      domain: 'home.example.org',
      private_key_pem: key_pem,
    });
    const shape = parseCsr(csr_pem);
    expect(shape.commonName).toBe('home.example.org');
    expect(shape.sanDnsNames).toEqual(['home.example.org']);
  });

  it('handles long subdomain chains', () => {
    const key_pem = newEd25519PrivateKeyPem();
    const csr_pem = generateCsr({
      domain: 'a.b.c.d.e.f.example.org',
      private_key_pem: key_pem,
    });
    const shape = parseCsr(csr_pem);
    expect(shape.commonName).toBe('a.b.c.d.e.f.example.org');
    expect(shape.sanDnsNames).toEqual(['a.b.c.d.e.f.example.org']);
  });
});

// ────────────────────────────────────────────────────────────────
// Cryptographic correctness — embedded SPKI + signature verify
// ────────────────────────────────────────────────────────────────

describe('generateCsr — signature verifies', () => {
  it('embedded SPKI matches the keypair public half', () => {
    const key_pem = newEd25519PrivateKeyPem();
    const csr_pem = generateCsr({
      domain: 'alice.recued.net',
      private_key_pem: key_pem,
    });
    const shape = parseCsr(csr_pem);
    // Load the embedded SPKI as a Node KeyObject — proves it's a
    // structurally-valid Ed25519 SubjectPublicKeyInfo.
    const csrPublicKey = createPublicKey({
      key: shape.spkiDer,
      format: 'der',
      type: 'spki',
    });
    expect(csrPublicKey.asymmetricKeyType).toBe('ed25519');

    // Derive the same SPKI from the original private key — must match
    // byte-for-byte (the CSR's SPKI is the public half of the input
    // key, not a fresh keypair).
    const originalPublicKey = createPublicKey(
      createPrivateKey(key_pem),
    );
    const originalSpkiDer = originalPublicKey.export({
      type: 'spki',
      format: 'der',
    }) as Buffer;
    expect(Buffer.compare(shape.spkiDer, originalSpkiDer)).toBe(0);
  });

  it('outer signature verifies against the embedded public key', () => {
    const key_pem = newEd25519PrivateKeyPem();
    const csr_pem = generateCsr({
      domain: 'alice.recued.net',
      private_key_pem: key_pem,
    });
    const shape = parseCsr(csr_pem);
    const publicKey = createPublicKey({
      key: shape.spkiDer,
      format: 'der',
      type: 'spki',
    });
    const ok = nodeVerify(null, shape.criDer, publicKey, shape.signature);
    expect(ok).toBe(true);
  });

  it('signature is 64 bytes (Ed25519)', () => {
    const key_pem = newEd25519PrivateKeyPem();
    const csr_pem = generateCsr({
      domain: 'alice.recued.net',
      private_key_pem: key_pem,
    });
    const shape = parseCsr(csr_pem);
    expect(shape.signature.length).toBe(64);
  });

  it('different keypairs produce different signatures', () => {
    const csr_a = generateCsr({
      domain: 'alice.recued.net',
      private_key_pem: newEd25519PrivateKeyPem(),
    });
    const csr_b = generateCsr({
      domain: 'alice.recued.net',
      private_key_pem: newEd25519PrivateKeyPem(),
    });
    expect(csr_a).not.toBe(csr_b);
  });
});

// ────────────────────────────────────────────────────────────────
// Input rejection — non-Ed25519, malformed PEM, bad domains
// ────────────────────────────────────────────────────────────────

describe('generateCsr — input rejection', () => {
  it('rejects RSA private key with KEY_NOT_ED25519', () => {
    expect(() =>
      generateCsr({
        domain: 'alice.recued.net',
        private_key_pem: newRsaPrivateKeyPem(),
      }),
    ).toThrow(GENERATE_CSR_ERRORS.KEY_NOT_ED25519);
  });

  it('rejects EC (P-256) private key with KEY_NOT_ED25519', () => {
    expect(() =>
      generateCsr({
        domain: 'alice.recued.net',
        private_key_pem: newEcPrivateKeyPem(),
      }),
    ).toThrow(GENERATE_CSR_ERRORS.KEY_NOT_ED25519);
  });

  it('rejects garbled PEM with KEY_PARSE_FAILED', () => {
    expect(() =>
      generateCsr({
        domain: 'alice.recued.net',
        private_key_pem: '-----BEGIN PRIVATE KEY-----\nGARBAGE\n-----END PRIVATE KEY-----',
      }),
    ).toThrow(GENERATE_CSR_ERRORS.KEY_PARSE_FAILED);
  });

  it('rejects empty domain', () => {
    expect(() =>
      generateCsr({
        domain: '',
        private_key_pem: newEd25519PrivateKeyPem(),
      }),
    ).toThrow(GENERATE_CSR_ERRORS.EMPTY_DOMAIN);
  });

  it('rejects non-ASCII domain', () => {
    expect(() =>
      generateCsr({
        domain: 'café.example.com',
        private_key_pem: newEd25519PrivateKeyPem(),
      }),
    ).toThrow(GENERATE_CSR_ERRORS.DOMAIN_NOT_ASCII);
  });

  it('rejects oversized domain', () => {
    // 254 chars — one over RFC 1035 limit
    const oversize = 'a'.repeat(254);
    expect(() =>
      generateCsr({
        domain: oversize,
        private_key_pem: newEd25519PrivateKeyPem(),
      }),
    ).toThrow(GENERATE_CSR_ERRORS.DOMAIN_TOO_LONG);
  });
});

// ────────────────────────────────────────────────────────────────
// Integration with createAcmeDomainRenewer
// ────────────────────────────────────────────────────────────────

describe('generateCsr — integration with createAcmeDomainRenewer', () => {
  /** Build a stub store + capture the CSR that lands at the issuer. */
  const captureIssuance = async () => {
    const key_pem = newEd25519PrivateKeyPem();
    const chain: TLSDomainCertChain = {
      domain: 'alice.recued.net',
      cert_pem: 'OLD_CERT',
      private_key_pem: key_pem,
      fingerprint: 'OLDFP',
      expires_at: 1_700_000_000_000,
      source: 'pro_acme',
    };
    const chains = new Map<string, TLSDomainCertChain>([
      [chain.domain, chain],
    ]);
    const store: Pick<SqliteTlsDomainStore, 'lookup' | 'upload'> = {
      lookup: (domain: string) => chains.get(domain) ?? null,
      upload: async (args): Promise<TLSDomainUploadResult> => {
        chains.set(args.domain, {
          domain: args.domain,
          cert_pem: args.cert_pem,
          private_key_pem: args.private_key_pem,
          fingerprint: 'NEWFP',
          expires_at: 2_700_000_000_000,
          source: args.source,
          ...(args.chain_pem !== undefined ? { chain_pem: args.chain_pem } : {}),
        });
        return {
          fingerprint: 'NEWFP',
          expires_at: 2_700_000_000_000,
          san: [args.domain],
        };
      },
    };
    let captured_csr: string | null = null;
    const issuer: AcmeCertIssuer = {
      issueCert: async ({ csr_pem }) => {
        captured_csr = csr_pem;
        return {
          cert_pem: 'NEW_CERT',
          issuer_chain_pem: 'NEW_CHAIN',
          expires_at: 2_700_000_000_000,
          renewal_recommended_at: 2_650_000_000_000,
        };
      },
    };
    const renewer = createAcmeDomainRenewer({
      acme: issuer,
      store,
      generateCsr,
    });
    const result = await renewer.renewDomain({
      domain: 'alice.recued.net',
    });
    return { result, captured_csr, key_pem };
  };

  it('renewer success path passes a valid CSR to the issuer', async () => {
    const { result, captured_csr, key_pem } = await captureIssuance();
    expect(result).toEqual({ ok: true, new_fingerprint: 'NEWFP' });
    expect(captured_csr).not.toBeNull();
    // CSR must be parseable + signature must verify against the same
    // private key the store handed in.
    const shape = parseCsr(captured_csr!);
    expect(shape.commonName).toBe('alice.recued.net');
    expect(shape.sanDnsNames).toEqual(['alice.recued.net']);
    const publicKey = createPublicKey(createPrivateKey(key_pem));
    const ok = nodeVerify(null, shape.criDer, publicKey, shape.signature);
    expect(ok).toBe(true);
  });

  it('renewer defensive gate rejects nothing on a real CSR (no PRIVATE KEY block)', async () => {
    const { captured_csr } = await captureIssuance();
    // The renewer rejects CSRs containing a PRIVATE KEY block. The
    // real emitter never emits one — proving the pre-flight gate is
    // crossed cleanly is the integration claim here.
    expect(captured_csr).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});
