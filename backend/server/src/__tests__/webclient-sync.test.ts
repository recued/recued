/** D-178 + D-152 § A.16 — webclient bundle self-sync (download → verify →
 *  unpack → atomic extract). Real minisign + real archive, mock download. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateKeypair,
  packWebclientArchive,
  signWebclientArchive,
  webclientArchiveFileName,
} from '@recued/release';
import { verifyArtifactFile } from '../update/binary-apply-executor.js';
import { syncWebclientBundle, type WebclientSyncDeps } from '../update/webclient-sync.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const FILES = [
  { path: 'webclient-bundle-manifest.json', bytes: enc('{"files":[{"path":"index.html","sha256":"x"}]}') },
  { path: 'index.html', bytes: enc('<title>v-new</title>') },
];

/** Build a signed archive over `text`; returns the pieces the deps need. */
const signed = (text: string) => {
  const kp = generateKeypair();
  const version = '1.0.0';
  const sig = signWebclientArchive({
    content: Buffer.from(text),
    fileName: webclientArchiveFileName(version),
    version,
    key: { secretSeed: kp.secretSeed, keyId: kp.keyId },
  });
  return { text, sig, sha256: sha(Buffer.from(text)), pubkey: kp.publicKeyText };
};

const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'wc-sync-'));
  return { root, targetDir: join(root, 'webclient'), stagingPath: join(root, 'webclient.archive.staged') };
};

const deps = (over: Partial<WebclientSyncDeps>): WebclientSyncDeps => ({
  download: async () => {},
  verifyArtifact: verifyArtifactFile,
  trustedPubkey: '',
  targetDir: undefined,
  stagingPath: '',
  ...over,
});

describe('syncWebclientBundle', () => {
  it('downloads → verifies → extracts to the target dir, then cleans staging', async () => {
    const s = signed(packWebclientArchive({ version: '1.0.0', files: FILES }));
    const { targetDir, stagingPath } = scratch();
    const res = await syncWebclientBundle(
      deps({
        download: async (_url, dest) => writeFileSync(dest, s.text),
        trustedPubkey: s.pubkey,
        targetDir,
        stagingPath,
      }),
      { url: 'https://x/wc', sha256: s.sha256, sig: s.sig },
    );
    expect(res).toMatchObject({ ok: true, version: '1.0.0' });
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe('<title>v-new</title>');
    expect(existsSync(join(targetDir, 'webclient-bundle-manifest.json'))).toBe(true);
    expect(existsSync(stagingPath)).toBe(false); // staging cleaned up
  });

  it('ATOMICALLY replaces a prior bundle (stale files gone, new files present)', async () => {
    const s = signed(packWebclientArchive({ version: '1.0.0', files: FILES }));
    const { targetDir, stagingPath } = scratch();
    // Seed a prior bundle with a stale file NOT in the new archive.
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'stale-old-asset.js'), 'old');
    writeFileSync(join(targetDir, 'index.html'), '<title>v-old</title>');
    const res = await syncWebclientBundle(
      deps({ download: async (_u, d) => writeFileSync(d, s.text), trustedPubkey: s.pubkey, targetDir, stagingPath }),
      { url: 'u', sha256: s.sha256, sig: s.sig },
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe('<title>v-new</title>');
    expect(existsSync(join(targetDir, 'stale-old-asset.js'))).toBe(false); // replaced, not merged
  });

  it('best-effort: a download failure leaves the prior bundle intact', async () => {
    const s = signed(packWebclientArchive({ version: '1.0.0', files: FILES }));
    const { targetDir, stagingPath } = scratch();
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'index.html'), '<title>v-old</title>');
    const res = await syncWebclientBundle(
      deps({
        download: async () => {
          throw new Error('HTTP 503');
        },
        trustedPubkey: s.pubkey,
        targetDir,
        stagingPath,
      }),
      { url: 'u', sha256: s.sha256, sig: s.sig },
    );
    expect(res).toMatchObject({ ok: false, reason: 'download_failed' });
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe('<title>v-old</title>'); // untouched
  });

  it('bounds a HANGING download (times out → download_failed, never wedges)', async () => {
    const s = signed(packWebclientArchive({ version: '1.0.0', files: FILES }));
    const { targetDir, stagingPath } = scratch();
    const res = await syncWebclientBundle(
      deps({
        download: () => new Promise<void>(() => {}), // never settles
        downloadTimeoutMs: 20,
        trustedPubkey: s.pubkey,
        targetDir,
        stagingPath,
      }),
      { url: 'u', sha256: s.sha256, sig: s.sig },
    );
    expect(res).toMatchObject({ ok: false, reason: 'download_failed' });
    expect(existsSync(targetDir)).toBe(false);
  });

  it('rejects a bad signature (wrong key) and leaves the prior bundle', async () => {
    const s = signed(packWebclientArchive({ version: '1.0.0', files: FILES }));
    const other = generateKeypair(); // verify against the WRONG pinned key
    const { targetDir, stagingPath } = scratch();
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'index.html'), '<title>v-old</title>');
    const res = await syncWebclientBundle(
      deps({ download: async (_u, d) => writeFileSync(d, s.text), trustedPubkey: other.publicKeyText, targetDir, stagingPath }),
      { url: 'u', sha256: s.sha256, sig: s.sig },
    );
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/^verify_failed/);
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe('<title>v-old</title>');
    expect(existsSync(stagingPath)).toBe(false);
  });

  it('rejects a validly-SIGNED but unpack-invalid archive (schema), no write', async () => {
    // Signed over a document `unpackWebclientArchive` refuses → minisig passes,
    // the second gate catches it.
    const bad = JSON.stringify({ schema: 99, version: '1.0.0', files: [{ path: 'a', sha256: 'x', base64: 'YQ==' }] });
    const s = signed(bad);
    const { targetDir, stagingPath } = scratch();
    const res = await syncWebclientBundle(
      deps({ download: async (_u, d) => writeFileSync(d, s.text), trustedPubkey: s.pubkey, targetDir, stagingPath }),
      { url: 'u', sha256: s.sha256, sig: s.sig },
    );
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/^unpack_failed/);
    expect(existsSync(targetDir)).toBe(false);
  });

  it('skips when no target dir resolves / no trusted key configured (never writes)', async () => {
    const s = signed(packWebclientArchive({ version: '1.0.0', files: FILES }));
    const noDir = await syncWebclientBundle(deps({ trustedPubkey: s.pubkey, targetDir: undefined }), {
      url: 'u',
      sha256: s.sha256,
      sig: s.sig,
    });
    expect(noDir).toMatchObject({ ok: false, reason: 'no_target_dir' });

    const { targetDir, stagingPath } = scratch();
    const noKey = await syncWebclientBundle(deps({ trustedPubkey: '', targetDir, stagingPath }), {
      url: 'u',
      sha256: s.sha256,
      sig: s.sig,
    });
    expect(noKey).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(existsSync(targetDir)).toBe(false);
  });
});
