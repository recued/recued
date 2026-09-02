import { describe, expect, it } from 'vitest';
import { generateKeypair } from '@recued/release';
import {
  signCandidateProvenance,
  verifyCandidateProvenance,
} from '../../scripts/release-candidate-provenance.mjs';

const SOURCE = 'a'.repeat(40);

describe('release candidate provenance', () => {
  it('custody-signs the exact manifest bytes and source revision', () => {
    const keypair = generateKeypair();
    const manifestBytes = Buffer.from('{"schema":1,"sequence":42}\n');
    const signed = signCandidateProvenance({
      sourceRevision: SOURCE,
      manifestBytes,
      version: '26.9.1.1',
      sequence: 42,
      key: keypair,
    });

    expect(verifyCandidateProvenance({
      provenanceBytes: Buffer.from(signed.json),
      signatureText: signed.sig,
      publicKeyText: keypair.publicKeyText,
      expectedSourceRevision: SOURCE,
      manifestBytes,
      version: '26.9.1.1',
      sequence: 42,
    })).toMatchObject({
      schema_version: 1,
      source_revision: SOURCE,
      sequence: 42,
    });
  });

  it('rejects a retained directory paired with different manifest bytes or source', () => {
    const keypair = generateKeypair();
    const manifestBytes = Buffer.from('{"sequence":42}\n');
    const signed = signCandidateProvenance({
      sourceRevision: SOURCE,
      manifestBytes,
      version: '26.9.1.1',
      sequence: 42,
      key: keypair,
    });
    const common = {
      provenanceBytes: Buffer.from(signed.json),
      signatureText: signed.sig,
      publicKeyText: keypair.publicKeyText,
      version: '26.9.1.1',
      sequence: 42,
    };

    expect(() => verifyCandidateProvenance({
      ...common,
      expectedSourceRevision: 'b'.repeat(40),
      manifestBytes,
    })).toThrow(/source revision/);
    expect(() => verifyCandidateProvenance({
      ...common,
      expectedSourceRevision: SOURCE,
      manifestBytes: Buffer.from('{"sequence":43}\n'),
    })).toThrow(/exact manifest/);
  });
});
