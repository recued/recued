import { describe, it, expect } from 'vitest';
import {
  bundleToJSON, bundleFromJSON,
  bundleToQR, bundleFromQR,
  bundleToFile, bundleFromFile,
  QR_SCHEME, FILE_HEADER,
} from '../serialize.js';
import { createBundle, openBundleWithPassword } from '../bundle.js';

const FAST_ARGON2 = { t: 1, m: 1024, p: 1 };

describe('bundleToJSON / bundleFromJSON', () => {
  it('round-trips a bundle', async () => {
    const { bundle } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const json = bundleToJSON(bundle);
    const back = bundleFromJSON(json);
    expect(back).toEqual(bundle);
  });

  it('round-tripped bundle still opens with the same password', async () => {
    const { bundle, masterDEK } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const back = bundleFromJSON(bundleToJSON(bundle));
    const opened = await openBundleWithPassword(back, 'pw');
    expect(Array.from(opened)).toEqual(Array.from(masterDEK));
  });

  it('rejects malformed JSON', () => {
    expect(() => bundleFromJSON('not json')).toThrow('malformed');
  });

  it('rejects JSON missing required fields', () => {
    expect(() => bundleFromJSON(JSON.stringify({ version: 1 }))).toThrow('missing required');
  });

  it('rejects JSON with wrong field types', () => {
    expect(() => bundleFromJSON(JSON.stringify({
      version: 'oops', argon2: {}, salt_pw: '', salt_rec: '',
      wrapped_pw: '', wrapped_rec: '', updated_at: 0,
    }))).toThrow('missing required');
  });
});

describe('QR round-trip', () => {
  it('round-trips via QR payload', async () => {
    const { bundle } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const qr = bundleToQR(bundle);
    expect(qr.startsWith(QR_SCHEME)).toBe(true);
    const back = bundleFromQR(qr);
    expect(back).toEqual(bundle);
  });

  it('rejects QR without scheme prefix', async () => {
    const { bundle } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const json = bundleToJSON(bundle);
    expect(() => bundleFromQR(json)).toThrow('must start with');
  });
});

describe('File format round-trip', () => {
  it('round-trips via file contents', async () => {
    const { bundle } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const file = bundleToFile(bundle);
    expect(file.startsWith(FILE_HEADER)).toBe(true);
    const back = bundleFromFile(file);
    expect(back).toEqual(bundle);
  });

  it('rejects files without the header', async () => {
    const { bundle } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const body = bundleToJSON(bundle);
    expect(() => bundleFromFile(body)).toThrow('not a recued-bundle');
  });
});

// ────────────────────────────────────────────────────────────────
// isBundleShape — individual field-type rejection paths
// ────────────────────────────────────────────────────────────────

describe('bundleFromJSON — shape validation gaps', () => {
  const valid = {
    version: 1,
    argon2: { t: 1, m: 1024, p: 1 },
    salt_pw: 'salt-pw',
    salt_rec: 'salt-rec',
    wrapped_pw: 'w-pw',
    wrapped_rec: 'w-rec',
    updated_at: 123,
  };

  it('rejects non-object roots (number, string, null, array)', () => {
    expect(() => bundleFromJSON('42')).toThrow('missing required');
    expect(() => bundleFromJSON('"string"')).toThrow('missing required');
    expect(() => bundleFromJSON('null')).toThrow('missing required');
    // Arrays: typeof is 'object' but not the bundle shape.
    expect(() => bundleFromJSON('[]')).toThrow('missing required');
  });

  it('rejects each string field given the wrong type', () => {
    for (const field of ['salt_pw', 'salt_rec', 'wrapped_pw', 'wrapped_rec']) {
      expect(() => bundleFromJSON(JSON.stringify({
        ...valid, [field]: 42,
      }))).toThrow('missing required');
    }
  });

  it('rejects non-numeric updated_at', () => {
    expect(() => bundleFromJSON(JSON.stringify({
      ...valid, updated_at: 'nope',
    }))).toThrow('missing required');
  });

  it('rejects missing argon2 object', () => {
    expect(() => bundleFromJSON(JSON.stringify({
      ...valid, argon2: null,
    }))).toThrow('missing required');
  });

  it('rejects argon2 with non-object value', () => {
    expect(() => bundleFromJSON(JSON.stringify({
      ...valid, argon2: 'string',
    }))).toThrow('missing required');
  });

  it('rejects argon2 missing t/m/p', () => {
    for (const key of ['t', 'm', 'p']) {
      const argon2 = { ...valid.argon2 } as Record<string, unknown>;
      delete argon2[key];
      expect(() => bundleFromJSON(JSON.stringify({
        ...valid, argon2,
      }))).toThrow('missing required');
    }
  });

  it('rejects argon2 with non-numeric t/m/p', () => {
    for (const key of ['t', 'm', 'p']) {
      expect(() => bundleFromJSON(JSON.stringify({
        ...valid, argon2: { ...valid.argon2, [key]: 'big' },
      }))).toThrow('missing required');
    }
  });
});
