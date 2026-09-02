/** ⛔⛔⛔ A WEB CLICK MUST NOT BE ABLE TO OVERWRITE THE OWNER'S NODE.
 *
 *  On the `binary` channel the apply target is `process.execPath`. That is the
 *  recued SEA only when this process IS the SEA; from a source checkout, an npm
 *  install, or Homebrew — whose formula says outright that it "wraps the npm
 *  package — no standalone binary is produced" and depends on Node — it is the
 *  owner's node executable. An apply would download a recued release and rename
 *  it over their node.
 *
 *  🔑 THE RULE EXISTED AT THE WRONG END. `cli-context/update.ts` has carried this
 *  check for the CLI verb since it was written, with a comment saying the target
 *  "would be the owner's node runtime". The server/web composition — the path a
 *  single click and every AUTOMATIC apply take — had none. These tests are on the
 *  shared BUILDER, so a future third caller inherits the refusal instead of
 *  having to remember it.
 *
 *  ⚠ AND THE CHANNEL CANNOT ANSWER IT. `RECUED_DISTRIBUTION_CHANNEL` defaults to
 *  `binary` when unset and nothing in production stamps it, so it reports
 *  "packaged" on exactly the installs that are not. Hence `node:sea`. */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyOrchestratorDeps } from '../update/release-config.js';
import type { ReleaseCheckDeps } from '../update/release-check.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'recued-self-target-'));
  dirs.push(d);
  return d;
};
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const build = (over: {
  channel?: string;
  packaged?: boolean;
  binaryPath?: string;
}) => {
  const releaseCheckDeps = {
    trustedPubkey: 'pk',
    channel: 'stable',
    currentVersion: '1.0.0',
  } as unknown as ReleaseCheckDeps;
  return buildApplyOrchestratorDeps({
    db: new Database(join(tmp(), 'realm.db')),
    releaseCheckDeps,
    requestRestart: () => {},
    isQuiesced: () => true,
    env: { RECUED_DISTRIBUTION_CHANNEL: over.channel ?? 'binary' },
    isPackagedBinary: () => over.packaged ?? false,
    ...(over.binaryPath === undefined ? {} : { binaryPath: over.binaryPath }),
  });
};

describe('the self-update target guard', () => {
  it('⛔ REFUSES when the target would be process.execPath and we are NOT the SEA', () => {
    // The Homebrew / npm / source-checkout shape. Undefined here resolves
    // `update.apply` and `update.rollback` to `not-applicable`, which is the
    // honest answer: this install cannot update itself in place.
    expect(build({ channel: 'binary', packaged: false })).toBeUndefined();
  });

  it('allows it when this process IS the packaged binary', () => {
    expect(build({ channel: 'binary', packaged: true })).toBeDefined();
  });

  it('allows an explicit binaryPath — that target is the caller\'s own', () => {
    // Every existing wiring test passes one; the hazard is specifically the
    // FALLBACK to process.execPath, not a caller naming its own file.
    expect(build({ channel: 'binary', packaged: false, binaryPath: join(tmp(), 'recued') }))
      .toBeDefined();
  });

  it('does not disturb docker-thin, whose target is never execPath', () => {
    // There the launcher execs a binary on the data volume, so `process.execPath`
    // is Node BY DESIGN and the resolved target is `${RECUED_BIN_DIR}/recued`.
    expect(build({ channel: 'docker-thin', packaged: false })).toBeDefined();
  });

  it('⛔ an UNSET channel is treated as binary, and therefore also refuses', () => {
    // This is the shape that makes the finding critical rather than theoretical:
    // no production package stamps the variable, so unset is the common case.
    const deps = buildApplyOrchestratorDeps({
      db: new Database(join(tmp(), 'realm.db')),
      releaseCheckDeps: { trustedPubkey: 'pk', channel: 'stable', currentVersion: '1.0.0' } as unknown as ReleaseCheckDeps,
      requestRestart: () => {},
      isQuiesced: () => true,
      env: {},                       // nothing stamped
      isPackagedBinary: () => false,
    });
    expect(deps).toBeUndefined();
  });
});
