/** D-178 + D-152 § A.16 — webclient bundle self-sync (download → verify →
 *  unpack → atomic extract). Real minisign + real archive, mock download. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateKeypair,
  packWebclientArchive,
  signWebclientArchive,
  webclientArchiveFileName,
} from '@recued/release';
import { verifyArtifactFile } from '../update/binary-apply-executor.js';
import {
  recoverAbortedWebclientSync,
  readWebclientApplyJournal,
  syncWebclientBundle,
  undoWebclientSync,
  webclientApplyJournalPath,
  WEBCLIENT_ABORT_ASIDE,
  WEBCLIENT_ABSENT_MARKER,
  type WebclientSyncDeps,
} from '../update/webclient-sync.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const INDEX_BYTES = enc('<title>v-new</title>');
const FILES = [
  {
    path: 'webclient-bundle-manifest.json',
    bytes: enc(JSON.stringify({ files: [{ path: 'index.html', sha256: sha(INDEX_BYTES) }] })),
  },
  { path: 'index.html', bytes: INDEX_BYTES },
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
  applyIdentity: { releaseIdentity: 'stable:1.0.0', operationId: 'op-1' },
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

  it('rejects a signed archive whose inner manifest lies about served bytes', async () => {
    const badFiles = [
      {
        path: 'webclient-bundle-manifest.json',
        bytes: enc(JSON.stringify({ files: [{ path: 'index.html', sha256: '0'.repeat(64) }] })),
      },
      { path: 'index.html', bytes: INDEX_BYTES },
    ];
    const s = signed(packWebclientArchive({ version: '1.0.0', files: badFiles }));
    const { targetDir, stagingPath } = scratch();
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'index.html'), '<title>v-old</title>');
    const res = await syncWebclientBundle(
      deps({ download: async (_u, d) => writeFileSync(d, s.text), trustedPubkey: s.pubkey, targetDir, stagingPath }),
      { url: 'u', sha256: s.sha256, sig: s.sig },
    );
    expect(res).toMatchObject({ ok: false });
    expect((res as { reason: string }).reason).toMatch(/^inner_manifest_invalid:/);
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe('<title>v-old</title>');
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

describe('the backup is bound to the sync that just succeeded', () => {
  /** ⛔ THE REPORTED REPRODUCTION. The backup used to be cleared only on the
   *  SUCCESS path, so a sync that failed early left the PREVIOUS generation's
   *  backup in place — and the rollback, which restores any `<targetDir>.old` it
   *  finds, then restored the wrong generation:
   *
   *      R1 backup, R2 live UI, R3 sync FAILS  ->  rollback R3->R2
   *      gave an R2 server with an R1 UI.
   *
   *  Clearing at ENTRY makes the backup mean exactly "the bundle displaced by the
   *  sync that just succeeded", which is the only thing a rollback can use. */
  it('a FAILED sync describes its parked backup so an apply abort can restore it', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wc-stale-'));
    const target = join(d, 'webclient');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'index.html'), 'R2-UI');
    // A backup left by the PREVIOUS (R1 -> R2) sync.
    mkdirSync(`${target}.old`, { recursive: true });
    writeFileSync(join(`${target}.old`, 'index.html'), 'R1-UI');

    const res = await syncWebclientBundle(
      {
        download: async () => { throw new Error('network'); },
        verifyArtifact: () => ({ ok: true } as never),
        trustedPubkey: 'pk',
        targetDir: target,
        stagingPath: join(d, 'staged.json'),
        applyIdentity: { releaseIdentity: 'stable:1.0.0', operationId: 'op-stale' },
      } as never,
      { url: 'http://x/b.json', sha256: 'h', sig: 's' },
    );

    expect(res).toMatchObject({ ok: false, effect: 'backup-parked' });
    expect(existsSync(`${target}.old`), 'the stale slot is cleared for this attempt').toBe(false);
    expect(readFileSync(join(`${target}.apply-aside`, 'index.html'), 'utf8')).toBe('R1-UI');
    expect(readFileSync(join(target, 'index.html'), 'utf8'), 'the live bundle is untouched')
      .toBe('R2-UI');
    expect(undoWebclientSync(target, res.effect)).toBe(true);
    expect(readFileSync(join(`${target}.old`, 'index.html'), 'utf8')).toBe('R1-UI');
    rmSync(d, { recursive: true, force: true });
  });
});

/** ⛔⛔ THE BUNDLE'S PRIOR GENERATION IS PARKED, NOT DELETED.
 *
 *  `<dir>.old` was cleared at the START of every sync, so an apply that synced
 *  successfully and then ABORTED (a failed drain, a failed snapshot) restored the
 *  previous bundle over the live one and left the release behind it with no
 *  rollback UI at all — removed by a run that changed nothing else. */
describe('syncWebclientBundle keeps the generation behind the one it displaces', () => {
  const syncOver = async (targetDir: string, stagingPath: string) => {
    const s = signed(packWebclientArchive({ version: '1.0.0', files: FILES }));
    return syncWebclientBundle(
      deps({ download: async (_u, d) => writeFileSync(d, s.text), trustedPubkey: s.pubkey, targetDir, stagingPath }),
      { url: 'u', sha256: s.sha256, sig: s.sig },
    );
  };

  it('⛔ moves an existing `.old` to the aside instead of deleting it', async () => {
    const { targetDir, stagingPath } = scratch();
    mkdirSync(`${targetDir}.old`, { recursive: true });
    writeFileSync(join(`${targetDir}.old`, 'index.html'), 'UI-R1');

    expect(await syncOver(targetDir, stagingPath)).toMatchObject({ ok: true });
    expect(
      readFileSync(join(`${targetDir}.apply-aside`, 'index.html'), 'utf8'),
      'the generation behind the one being displaced must survive the sync',
    ).toBe('UI-R1');
  });

  it('and clears a STALE aside first, so at most one is ever kept', async () => {
    // The arm that stops the fix becoming an unbounded pile of ~30 MB bundles.
    // The aside is cleared at the start of each sync rather than by a commit-time
    // hook the sync does not have.
    const { targetDir, stagingPath } = scratch();
    mkdirSync(`${targetDir}.apply-aside`, { recursive: true });
    writeFileSync(join(`${targetDir}.apply-aside`, 'index.html'), 'UI-R0');
    mkdirSync(`${targetDir}.old`, { recursive: true });
    writeFileSync(join(`${targetDir}.old`, 'index.html'), 'UI-R1');

    expect(await syncOver(targetDir, stagingPath)).toMatchObject({ ok: true });
    expect(
      readFileSync(join(`${targetDir}.apply-aside`, 'index.html'), 'utf8'),
      'the aside holds the CURRENT prior generation, not an accumulation',
    ).toBe('UI-R1');
  });

  it('⛔ a first-install promotion reports creation, whose abort removes it', async () => {
    const { targetDir, stagingPath } = scratch();
    const result = await syncOver(targetDir, stagingPath);
    expect(result).toMatchObject({ ok: true, effect: 'bundle-created' });
    expect(existsSync(targetDir)).toBe(true);
    expect(existsSync(join(`${targetDir}.old`, WEBCLIENT_ABSENT_MARKER))).toBe(true);
    expect(undoWebclientSync(targetDir, result.effect)).toBe(true);
    expect(existsSync(targetDir)).toBe(false);
    expect(existsSync(`${targetDir}.old`)).toBe(false);
  });

  it('durably recovers a promoted replacement after process death before the binary swap', async () => {
    const { targetDir, stagingPath } = scratch();
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'index.html'), 'UI-old');
    const result = await syncOver(targetDir, stagingPath);
    expect(result).toMatchObject({ ok: true, effect: 'bundle-replaced' });
    expect(readWebclientApplyJournal(targetDir)).toMatchObject({
      releaseIdentity: 'stable:1.0.0',
      operationId: 'op-1',
      effect: 'bundle-replaced',
    });

    expect(recoverAbortedWebclientSync(targetDir, {
      releaseIdentity: 'stable:1.0.0',
      operationId: 'op-1',
    })).toBe(true);
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe('UI-old');
    expect(readWebclientApplyJournal(targetDir)).toBeNull();
  });

  it('retries a replacement undo without rolling the restored UI back twice', () => {
    const { targetDir } = scratch();
    const identity = { releaseIdentity: 'stable:1.0.0', operationId: 'op-1' };
    for (const [path, body] of [
      [targetDir, 'UI-R2-restored'],
      [`${targetDir}.old`, 'UI-R1-rollback-target'],
      [`${targetDir}${WEBCLIENT_ABORT_ASIDE}`, 'UI-R3-aborted'],
    ] as const) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'index.html'), body);
    }
    writeFileSync(webclientApplyJournalPath(targetDir), `${JSON.stringify({
      schema: 1,
      ...identity,
      effect: 'bundle-replaced',
    })}\n`);

    expect(undoWebclientSync(targetDir, 'bundle-replaced', identity)).toBe(true);
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe('UI-R2-restored');
    expect(readFileSync(join(`${targetDir}.old`, 'index.html'), 'utf8'))
      .toBe('UI-R1-rollback-target');
    expect(existsSync(`${targetDir}${WEBCLIENT_ABORT_ASIDE}`)).toBe(false);
    expect(readWebclientApplyJournal(targetDir)).toBeNull();
  });

  it('retries a first-install undo without deleting a restored real backup', () => {
    const { targetDir } = scratch();
    const identity = { releaseIdentity: 'stable:1.0.0', operationId: 'op-1' };
    mkdirSync(`${targetDir}.old`, { recursive: true });
    writeFileSync(join(`${targetDir}.old`, 'index.html'), 'UI-older-real-generation');
    writeFileSync(webclientApplyJournalPath(targetDir), `${JSON.stringify({
      schema: 1,
      ...identity,
      effect: 'bundle-created',
    })}\n`);

    expect(undoWebclientSync(targetDir, 'bundle-created', identity)).toBe(true);
    expect(existsSync(targetDir)).toBe(false);
    expect(readFileSync(join(`${targetDir}.old`, 'index.html'), 'utf8'))
      .toBe('UI-older-real-generation');
    expect(readWebclientApplyJournal(targetDir)).toBeNull();
  });

  it('removes a first-install sentinel directory left before its marker write', () => {
    const { targetDir } = scratch();
    mkdirSync(`${targetDir}.old`, { recursive: true });
    writeFileSync(webclientApplyJournalPath(targetDir), `${JSON.stringify({
      schema: 1,
      releaseIdentity: 'stable:1.0.0',
      operationId: 'op-1',
      effect: 'bundle-created',
    })}\n`);

    expect(recoverAbortedWebclientSync(targetDir, {
      releaseIdentity: 'stable:1.0.0',
      operationId: 'op-1',
    })).toBe(true);
    expect(existsSync(`${targetDir}.old`)).toBe(false);
    expect(readWebclientApplyJournal(targetDir)).toBeNull();
  });

  it('never consumes a journal owned by another operation', async () => {
    const { targetDir, stagingPath } = scratch();
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'index.html'), 'UI-old');
    expect(await syncOver(targetDir, stagingPath)).toMatchObject({ ok: true });

    expect(recoverAbortedWebclientSync(targetDir, {
      releaseIdentity: 'stable:1.0.1',
      operationId: 'other-op',
    })).toBe(false);
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe('<title>v-new</title>');
    expect(readWebclientApplyJournal(targetDir)).not.toBeNull();
  });
});
