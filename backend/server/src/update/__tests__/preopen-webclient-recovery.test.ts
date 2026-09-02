import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recoverAbortedWebclientBeforeServe } from '../preopen-webclient-recovery.js';
import { createUpdateLedger } from '../update-ledger.js';
import { webclientApplyJournalPath } from '../webclient-sync.js';

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'preopen-webclient-recovery-'));
  const targetDir = join(dir, 'webclient');
  mkdirSync(targetDir);
  mkdirSync(`${targetDir}.old`);
  writeFileSync(join(targetDir, 'index.html'), 'new-ui');
  writeFileSync(join(`${targetDir}.old`, 'index.html'), 'old-ui');
  writeFileSync(webclientApplyJournalPath(targetDir), `${JSON.stringify({
    schema: 1,
    releaseIdentity: 'stable:2.0.0',
    operationId: 'apply-op',
    effect: 'bundle-replaced',
  })}\n`);
  const ledger = createUpdateLedger(join(dir, 'updates.log'));
  ledger.append({
    id: 'apply-op',
    kind: 'apply_started',
    at: 1,
    from_version: '1.0.0',
    to_version: '2.0.0',
    channel: 'stable',
    trigger: 'manual',
    release_identity: 'stable:2.0.0',
  });
  return { ledger, targetDir };
};

describe('recoverAbortedWebclientBeforeServe', () => {
  it('restores an aborted promotion before the old server can load it', () => {
    const f = fixture();

    expect(recoverAbortedWebclientBeforeServe({
      ledger: f.ledger,
      currentVersion: '1.0.0',
      targetDir: f.targetDir,
    })).toEqual({ action: 'recovered', releaseIdentity: 'stable:2.0.0' });
    expect(readFileSync(join(f.targetDir, 'index.html'), 'utf8')).toBe('old-ui');
    expect(existsSync(webclientApplyJournalPath(f.targetDir))).toBe(false);
  });

  it('does not undo the UI when the target binary proves the swap completed', () => {
    const f = fixture();

    expect(recoverAbortedWebclientBeforeServe({
      ledger: f.ledger,
      currentVersion: '2.0.0',
      targetDir: f.targetDir,
    })).toEqual({ action: 'none' });
    expect(readFileSync(join(f.targetDir, 'index.html'), 'utf8')).toBe('new-ui');
    expect(existsSync(webclientApplyJournalPath(f.targetDir))).toBe(true);
  });

  it('restores a terminalized compensation failure before the old server serves', () => {
    const f = fixture();
    f.ledger.append({
      id: 'apply-reverted',
      kind: 'apply_reverted',
      at: 2,
      from_version: '1.0.0',
      to_version: '2.0.0',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:2.0.0',
      webclient_recovery_pending: true,
    });

    expect(recoverAbortedWebclientBeforeServe({
      ledger: f.ledger,
      currentVersion: '1.0.0',
      targetDir: f.targetDir,
    })).toEqual({ action: 'recovered', releaseIdentity: 'stable:2.0.0' });
    expect(readFileSync(join(f.targetDir, 'index.html'), 'utf8')).toBe('old-ui');
    expect(existsSync(webclientApplyJournalPath(f.targetDir))).toBe(false);
  });

  it('refuses to serve while a terminalized compensation still cannot recover', () => {
    const f = fixture();
    f.ledger.append({
      id: 'apply-reverted',
      kind: 'apply_reverted',
      at: 2,
      from_version: '1.0.0',
      to_version: '2.0.0',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:2.0.0',
      webclient_recovery_pending: true,
    });
    rmSync(f.targetDir, { recursive: true, force: true });
    rmSync(`${f.targetDir}.old`, { recursive: true, force: true });

    expect(recoverAbortedWebclientBeforeServe({
      ledger: f.ledger,
      currentVersion: '1.0.0',
      targetDir: f.targetDir,
    })).toMatchObject({
      action: 'refused',
      releaseIdentity: 'stable:2.0.0',
    });
    expect(existsSync(webclientApplyJournalPath(f.targetDir))).toBe(true);
  });

  it('clears only the journal when inline compensation already restored the UI', () => {
    const f = fixture();
    writeFileSync(join(f.targetDir, 'index.html'), 'old-ui-restored');
    writeFileSync(join(`${f.targetDir}.old`, 'index.html'), 'older-rollback-ui');
    f.ledger.append({
      id: 'apply-reverted',
      kind: 'apply_reverted',
      at: 2,
      from_version: '1.0.0',
      to_version: '2.0.0',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:2.0.0',
    });

    expect(recoverAbortedWebclientBeforeServe({
      ledger: f.ledger,
      currentVersion: '1.0.0',
      targetDir: f.targetDir,
    })).toEqual({ action: 'recovered', releaseIdentity: 'stable:2.0.0' });
    expect(readFileSync(join(f.targetDir, 'index.html'), 'utf8')).toBe('old-ui-restored');
    expect(readFileSync(join(`${f.targetDir}.old`, 'index.html'), 'utf8'))
      .toBe('older-rollback-ui');
    expect(existsSync(webclientApplyJournalPath(f.targetDir))).toBe(false);
  });

  it('refuses a journal owned by a different operation without serving through it', () => {
    const f = fixture();
    writeFileSync(webclientApplyJournalPath(f.targetDir), `${JSON.stringify({
      schema: 1,
      releaseIdentity: 'stable:2.0.0',
      operationId: 'other-op',
      effect: 'bundle-replaced',
    })}\n`);

    expect(recoverAbortedWebclientBeforeServe({
      ledger: f.ledger,
      currentVersion: '1.0.0',
      targetDir: f.targetDir,
    })).toMatchObject({ action: 'refused', releaseIdentity: 'stable:2.0.0' });
    expect(readFileSync(join(f.targetDir, 'index.html'), 'utf8')).toBe('new-ui');
    expect(existsSync(webclientApplyJournalPath(f.targetDir))).toBe(true);
  });

  it('is wired before the serve graph can capture bundle bytes', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const bin = readFileSync(resolve(here, '..', '..', 'bin.ts'), 'utf8');
    const recovery = bin.indexOf('const webclientRecovery = recoverAbortedWebclientBeforeServe({');
    const serveImport = bin.indexOf("bootTrace.markImport('./serve-entry.js')");
    expect(recovery).toBeGreaterThan(-1);
    expect(serveImport).toBeGreaterThan(recovery);
  });
});
