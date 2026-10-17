/** The consumer proof (scripts/release-consumer-proof.mjs): after a publish, the
 *  live install.sh installs the release and the previous release updates itself
 *  to it. The legs are driven here against a fake feed and fake processes; the
 *  publisher's wiring (planned in a dry run, skipped loudly, a typo refused, and
 *  where in the publish it runs) is driven in
 *  d-178-release-publish-signing-gate.test.ts.
 *
 *  ⛔ NOTHING HERE MAY READ THE PUBLISHER. This file ships to the public tree,
 *  where `release-publish.mjs` is omitted (private release tooling), and a read
 *  of it by relative URL is invisible to the export's omission scanner: it
 *  failed the 26.10.17 cut's exported suite at step 5. The real install and
 *  the real drive need a live release, which is the point of running them only
 *  after a publish. */

import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  artifactTrustedComment,
  assembleManifest,
  generateKeypair,
  manifestTrustedComment,
  serializeManifest,
  sign,
  type Keypair,
  type ReleaseManifest,
} from '@recued/release';

import {
  CONSUMER_PROOF_ORIGIN,
  LIVE_INSTALLER_URL,
  SEED_SCRIPT,
  UPDATE_DRIVE_CONFIG,
  UPDATE_DRIVE_SPEC,
  WEBCLIENT_INSTALL_STAMP,
  checkInstalledRelease,
  checkWebclientTree,
  consumerEnv,
  consumerProofSetting,
  describeConsumerProofPlan,
  diffFingerprints,
  driveReportVerdict,
  findPreviousRelease,
  hostFingerprint,
  planConsumerProof,
  runConsumerProof,
  type ConsumerProofIo,
  type ConsumerProofPlan,
  type ConsumerProofRunRequest,
} from '../../scripts/release-consumer-proof.mjs';

const ORIGIN = CONSUMER_PROOF_ORIGIN;
const TRIPLE = 'macos-arm64';
const VERSION = '26.10.16';
const PREVIOUS = '26.10.14';
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

let scratch: string;
let key: Keypair;
let otherKey: Keypair;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'consumer-proof-'));
  key = generateKeypair();
  otherKey = generateKeypair();
});
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const fresh = (name: string) => mkdtempSync(join(scratch, `${name}-`));

const signed = (content: Buffer, comment: string, by: Keypair = key) =>
  sign({ content, secretSeed: by.secretSeed, keyId: by.keyId, trustedComment: comment });

type Release = {
  manifest: ReleaseManifest;
  bytes: Buffer;
  sig: string;
  binary: Buffer;
  addon: Buffer;
  bundle: Buffer | null;
  /** Every artifact's bytes by its hosted URL. */
  hosted: Map<string, Buffer>;
};

const webclientBundle = (version: string): Buffer => {
  const files = [
    ['index.html', `<html>${version}</html>`],
    ['assets/app.js', `console.log(${JSON.stringify(version)})`],
  ].map(([path, text]) => ({
    path, sha256: sha256(text), base64: Buffer.from(text).toString('base64'),
  }));
  return Buffer.from(JSON.stringify({ files }));
};

/** A release as release-build.mjs makes one: every artifact under its sequence
 *  namespace, the manifest assembled and checked by the consumer's own parser,
 *  then signed over its exact bytes. */
const release = ({
  sequence, version, triple = TRIPLE, withWebclient = true, by = key,
}: { sequence: number; version: string; triple?: string; withWebclient?: boolean; by?: Keypair }): Release => {
  const binary = Buffer.from(`binary ${triple} ${version}`);
  const addon = Buffer.from(`addon ${triple} ${version}`);
  const bundle = withWebclient ? webclientBundle(version) : null;
  const hosted = new Map<string, Buffer>();
  const artifact = (name: string, content: Buffer) => {
    const url = `${ORIGIN}/artifacts/${sequence}/${name}`;
    hosted.set(url, content);
    return { url, sha256: sha256(content), sig: signed(content, artifactTrustedComment(name, version), by) };
  };
  const manifest = assembleManifest({
    sequence,
    expires_at: '2036-10-13T00:00:00Z',
    min_launcher_version: 2,
    channels: {
      stable: {
        version,
        released_at: '2026-10-16T00:00:00Z',
        min_supported: '26.10.12',
        migration: false,
        rollout_pct: 0,
        notes_url: 'https://recued.com/changelog',
        binaries: { [triple]: artifact(`recued-${triple}`, binary) } as never,
        libs: { [`lib-${triple}`]: artifact(`better_sqlite3-${triple}.node`, addon) } as never,
        ...(bundle ? { webclient: artifact(`webclient-${version}.bundle.json`, bundle) } : {}),
      },
    },
  });
  const bytes = Buffer.from(serializeManifest(manifest));
  return { manifest, bytes, sig: signed(bytes, manifestTrustedComment(sequence), by), binary, addon, bundle, hosted };
};

/** The public feed's immutable namespace: what `artifacts/<sequence>/` serves. */
const feed = (...releases: Release[]) => {
  const objects = new Map<string, Buffer>();
  for (const r of releases) {
    const base = `${ORIGIN}/artifacts/${r.manifest.sequence}`;
    objects.set(`${base}/manifest.json`, r.bytes);
    objects.set(`${base}/manifest.json.minisig`, Buffer.from(r.sig));
    for (const [url, bytes] of r.hosted) objects.set(url, bytes);
  }
  const requested: string[] = [];
  const fetchBytes = async (url: string) => {
    requested.push(url);
    const bytes = objects.get(url);
    return bytes
      ? { ok: true as const, bytes }
      : { ok: false as const, reason: 'curl: (22) The requested URL returned error: 404' };
  };
  return { objects, requested, fetchBytes };
};

/** A checkout with the three files the proof runs. */
const checkout = () => {
  const root = fresh('checkout');
  for (const path of [UPDATE_DRIVE_SPEC, UPDATE_DRIVE_CONFIG, SEED_SCRIPT]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), '');
  }
  return root;
};

const planFor = async (candidate: Release, live: ReturnType<typeof feed>, overrides: Record<string, unknown> = {}) =>
  planConsumerProof({
    manifest: candidate.manifest,
    version: candidate.manifest.channels.stable!.version,
    origin: ORIGIN,
    prefix: '',
    pubkey: key.publicKeyText,
    trustedPubkey: key.publicKeyText,
    repoRoot: checkout(),
    platform: 'darwin',
    arch: 'arm64',
    fetchBytes: live.fetchBytes,
    hasPlaywright: () => true,
    ...overrides,
  });

describe('consumerProofSetting', () => {
  it('runs by default, skips by flag or by RECUED_RELEASE_CONSUMER_PROOF=skip, and names which', () => {
    expect(consumerProofSetting({ args: [], env: {} })).toEqual({ skip: false });
    expect(consumerProofSetting({ args: [], env: { RECUED_RELEASE_CONSUMER_PROOF: '' } })).toEqual({ skip: false });
    expect(consumerProofSetting({ args: ['--skip-consumer-proof'], env: {} }))
      .toEqual({ skip: true, reason: '--skip-consumer-proof' });
    expect(consumerProofSetting({ args: [], env: { RECUED_RELEASE_CONSUMER_PROOF: 'skip' } }))
      .toEqual({ skip: true, reason: 'RECUED_RELEASE_CONSUMER_PROOF=skip' });
  });

  it('refuses any other value, so a typo neither runs nor skips by accident', () => {
    for (const value of ['0', 'no', 'false', 'off', 'SKIP ME']) {
      expect(() => consumerProofSetting({ args: [], env: { RECUED_RELEASE_CONSUMER_PROOF: value } }))
        .toThrow(`RECUED_RELEASE_CONSUMER_PROOF must be empty or "skip" (got ${JSON.stringify(value)})`);
    }
  });
});

describe('consumerEnv', () => {
  it('drops what would steer a consumer or hand it a credential, keeps the rest, and sets its own', () => {
    const env = consumerEnv({
      PATH: '/usr/bin',
      HOME: '/Users/someone',
      RECUED_INSECURE: '1',
      RECUED_RELEASE_MANIFEST_URL: 'https://elsewhere.example/manifest.json',
      RECUED_SELF_UPDATE: 'auto',
      E2E_SEED_DIR: '/stale',
      PLAYWRIGHT_JSON_OUTPUT_FILE: '/stale.json',
      CLOUDFLARE_API_TOKEN: 'x',
      CLOUDFLARE_ACCOUNT_ID: 'x',
      SUPABASE_PRODUCTION_URL: 'x',
      GITHUB_TOKEN: 'x',
      SOME_SECRET: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      NOT_SET: undefined,
    }, { RECUED_PREFIX: '/tmp/prefix' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/someone', RECUED_PREFIX: '/tmp/prefix' });
  });
});

describe('findPreviousRelease', () => {
  const find = (live: ReturnType<typeof feed>, sequence = 41, depth?: number) => findPreviousRelease({
    origin: ORIGIN, sequence, channel: 'stable', version: VERSION, triple: TRIPLE,
    pubkey: key.publicKeyText, fetchBytes: live.fetchBytes, ...(depth ? { depth } : {}),
  });

  it('reads the previous release from its immutable namespace, with its artifacts and their hashes', async () => {
    const previous = release({ sequence: 40, version: PREVIOUS });
    const found = await find(feed(previous));
    expect(found).toEqual({
      version: PREVIOUS,
      sequence: 40,
      binary: { url: `${ORIGIN}/artifacts/40/recued-${TRIPLE}`, sha256: sha256(previous.binary) },
      addon: { url: `${ORIGIN}/artifacts/40/better_sqlite3-${TRIPLE}.node`, sha256: sha256(previous.addon) },
    });
  });

  it('looks past a republish of the same version to the release before it', async () => {
    const found = await find(feed(release({ sequence: 40, version: VERSION }), release({ sequence: 39, version: PREVIOUS })));
    expect(found?.sequence).toBe(39);
    expect(found?.version).toBe(PREVIOUS);
  });

  it('fails closed on a manifest that does not verify, and does not look further back for one that does', async () => {
    const live = feed(release({ sequence: 40, version: PREVIOUS, by: otherKey }), release({ sequence: 39, version: '26.10.13' }));
    await expect(find(live)).rejects.toThrow(/the release at sequence 40 does not verify against the pinned key/);
    expect(live.requested.some((url) => url.includes('/artifacts/39/'))).toBe(false);
  });

  it('fails closed on a release it cannot read', async () => {
    await expect(find(feed())).rejects.toThrow(
      /cannot read the release at sequence 40 \(https:\/\/releases\.recued\.com\/artifacts\/40\/manifest\.json\): curl: \(22\)/,
    );
  });

  it('refuses a manifest whose own sequence is not the namespace it was served from', async () => {
    const misplaced = release({ sequence: 38, version: PREVIOUS });
    const live = feed();
    live.objects.set(`${ORIGIN}/artifacts/40/manifest.json`, misplaced.bytes);
    live.objects.set(`${ORIGIN}/artifacts/40/manifest.json.minisig`, Buffer.from(misplaced.sig));
    await expect(find(live)).rejects.toThrow(/artifacts\/40\/manifest\.json names sequence 38, not 40/);
  });

  it('refuses a previous release that published nothing this host can run', async () => {
    await expect(find(feed(release({ sequence: 40, version: PREVIOUS, triple: 'linux-x64' }))))
      .rejects.toThrow(`${PREVIOUS} (sequence 40) published no ${TRIPLE} binary and addon to update from`);
  });

  it('gives up after its depth rather than walking the whole feed', async () => {
    const live = feed(release({ sequence: 40, version: VERSION }), release({ sequence: 39, version: VERSION }));
    await expect(find(live, 41, 2)).rejects.toThrow(`no stable release older than ${VERSION} in the 2 sequence(s) before 41`);
  });

  it('answers null for the first release, which has nothing to update from', async () => {
    await expect(find(feed(), 1)).resolves.toBeNull();
  });
});

describe('planConsumerProof', () => {
  it('plans both legs from the candidate and the verified previous release', async () => {
    const candidate = release({ sequence: 41, version: VERSION });
    const plan = await planFor(candidate, feed(release({ sequence: 40, version: PREVIOUS })));
    expect(plan).toMatchObject({
      version: VERSION,
      sequence: 41,
      channel: 'stable',
      triple: TRIPLE,
      installerUrl: LIVE_INSTALLER_URL,
      binary: { sha256: sha256(candidate.binary) },
      addon: { sha256: sha256(candidate.addon) },
      webclient: { file: `webclient-${VERSION}.bundle.json`, sha256: sha256(candidate.bundle!) },
      previous: { version: PREVIOUS, sequence: 40 },
    });
    expect(describeConsumerProofPlan(plan)).toBe(
      `install ${VERSION} with ${LIVE_INSTALLER_URL} on ${TRIPLE}, then update ${PREVIOUS} (sequence 40) to it `
        + 'on every update path (about 15 minutes in all)',
    );
  });

  it('refuses what it cannot prove, naming why, before anything is uploaded', async () => {
    const candidate = release({ sequence: 41, version: VERSION });
    const live = feed(release({ sequence: 40, version: PREVIOUS }));
    const cases: Array<[Record<string, unknown>, string | RegExp]> = [
      [{ origin: 'https://staging.example' }, 'it proves the production feed (https://releases.recued.com/), and this publish targets https://staging.example/'],
      [{ prefix: 'canary/' }, 'this publish targets https://releases.recued.com/canary/'],
      [{ trustedPubkey: otherKey.publicKeyText }, 'this release is verified against a key other than the one installed servers pin'],
      [{ platform: 'win32', arch: 'x64' }, 'it installs with install.sh, which runs on macOS and Linux; this host is win32-x64'],
      [{ platform: 'darwin', arch: 'ia32' }, 'this host is darwin-ia32'],
      [{ platform: 'linux', arch: 'x64' }, 'this release publishes no linux-x64 binary and addon, and this host can only install linux-x64'],
      [{ version: '26.10.17' }, `it proves the stable channel, and this manifest puts ${VERSION} there, not 26.10.17`],
      [{ repoRoot: fresh('bare') }, /this checkout has no apps\/webclient\/e2e\/live-update-path\.spec\.ts, .*make-e2e-seed\.mjs/],
      [{ hasPlaywright: () => false }, '@playwright/test is not installed in this checkout'],
    ];
    for (const [overrides, reason] of cases) {
      await expect(planFor(candidate, live, overrides), JSON.stringify(Object.keys(overrides))).rejects.toThrow(reason);
    }
  });

  it('plans no update leg for the first release', async () => {
    const plan = await planFor(release({ sequence: 1, version: VERSION }), feed());
    expect(plan.previous).toBeNull();
    expect(describeConsumerProofPlan(plan)).toContain('no update leg: this is the first release on the channel');
  });
});

describe('checkWebclientTree', () => {
  const bundle = JSON.parse(webclientBundle(VERSION).toString('utf8')) as {
    files: Array<{ path: string; sha256: string; base64: string }>;
  };
  const install = (edit: (dir: string) => void = () => {}) => {
    const dir = fresh('webclient');
    for (const file of bundle.files) {
      mkdirSync(dirname(join(dir, file.path)), { recursive: true });
      writeFileSync(join(dir, file.path), Buffer.from(file.base64, 'base64'));
    }
    writeFileSync(join(dir, WEBCLIENT_INSTALL_STAMP), `${VERSION}\n`);
    edit(dir);
    return dir;
  };
  const check = (dir: string) => checkWebclientTree({ installedDir: dir, bundle, version: VERSION });

  it('accepts the bundle exactly, plus the installer\'s version stamp', () => {
    expect(check(install())).toEqual([]);
  });

  it('names a missing, a changed and an unlisted file, and a stale stamp', () => {
    expect(check(install((d) => rmSync(join(d, 'assets/app.js'))))).toEqual(['the web app is missing 1 file(s): assets/app.js']);
    expect(check(install((d) => writeFileSync(join(d, 'index.html'), 'tampered'))))
      .toEqual(['1 web app file(s) differ from the signed bundle: index.html']);
    expect(check(install((d) => writeFileSync(join(d, 'stray.js'), '')))).toEqual(['the web app has 1 file(s) the bundle does not list: stray.js']);
    expect(check(install((d) => writeFileSync(join(d, WEBCLIENT_INSTALL_STAMP), '26.10.14'))))
      .toEqual([`the web app's version stamp is "26.10.14", not ${VERSION}`]);
    expect(check(install((d) => rmSync(join(d, WEBCLIENT_INSTALL_STAMP))))).toEqual([`the web app's version stamp is missing, not ${VERSION}`]);
  });

  it('refuses an install with no web app at all', () => {
    expect(check(join(scratch, 'no-such-webclient'))).toEqual([
      `no web app was installed (${join(scratch, 'no-such-webclient')} does not exist)`,
    ]);
  });
});

/** What install.sh leaves in its prefix: the binary, the addon beside it under
 *  lib/, the sequence floor, and the web app with its stamp. */
const writeInstall = (prefix: string, r: Release, edit: (prefix: string) => void = () => {}) => {
  mkdirSync(join(prefix, 'lib'), { recursive: true });
  writeFileSync(join(prefix, 'recued'), r.binary);
  writeFileSync(join(prefix, 'lib', 'better_sqlite3.node'), r.addon);
  writeFileSync(join(prefix, '.release-sequence'), `${r.manifest.sequence}\n`);
  const bundle = JSON.parse(r.bundle!.toString('utf8')) as { files: Array<{ path: string; base64: string }> };
  for (const file of bundle.files) {
    mkdirSync(dirname(join(prefix, 'webclient', file.path)), { recursive: true });
    writeFileSync(join(prefix, 'webclient', file.path), Buffer.from(file.base64, 'base64'));
  }
  writeFileSync(join(prefix, 'webclient', WEBCLIENT_INSTALL_STAMP), r.manifest.channels.stable!.version);
  edit(prefix);
};

describe('checkInstalledRelease', () => {
  let candidate: Release;
  let plan: ConsumerProofPlan;
  let out: string;
  beforeAll(async () => {
    candidate = release({ sequence: 41, version: VERSION });
    plan = await planFor(candidate, feed(release({ sequence: 40, version: PREVIOUS })));
    out = fresh('out');
    writeFileSync(join(out, plan.webclient!.file), candidate.bundle!);
  });
  const check = (edit?: (prefix: string) => void, printed = VERSION) => {
    const prefix = fresh('prefix');
    writeInstall(prefix, candidate, edit);
    return checkInstalledRelease({ prefix, plan, bundlePath: join(out, plan.webclient!.file), readVersion: async () => printed });
  };

  it('accepts what the manifest names', async () => {
    await expect(check()).resolves.toEqual([]);
  });

  it('names each way an install can be wrong while the installer still exits 0', async () => {
    await expect(check(undefined, '26.10.14')).resolves.toEqual([`\`recued --version\` prints "26.10.14", not ${VERSION}`]);
    await expect(check((p) => writeFileSync(join(p, 'recued'), 'other bytes'))).resolves
      .toEqual([`the installed binary is not the ${TRIPLE} artifact the manifest names`]);
    await expect(check((p) => rmSync(join(p, 'lib', 'better_sqlite3.node')))).resolves.toEqual([
      'the native addon (lib/better_sqlite3.node) is missing: the server would die at its first database open',
    ]);
    await expect(check((p) => writeFileSync(join(p, 'lib', 'better_sqlite3.node'), 'other bytes'))).resolves
      .toEqual([`the installed addon is not the lib-${TRIPLE} artifact the manifest names`]);
    await expect(check((p) => writeFileSync(join(p, '.release-sequence'), '40'))).resolves
      .toEqual(['the sequence floor is "40", not 41']);
    await expect(check((p) => rmSync(join(p, 'webclient', 'index.html')))).resolves
      .toEqual(['the web app is missing 1 file(s): index.html']);
  });

  it('compares the web app only with the bundle the manifest names', async () => {
    const prefix = fresh('prefix');
    writeInstall(prefix, candidate);
    const wrong = join(fresh('out'), plan.webclient!.file);
    writeFileSync(wrong, webclientBundle('26.10.15'));
    await expect(checkInstalledRelease({ prefix, plan, bundlePath: wrong, readVersion: async () => VERSION }))
      .resolves.toEqual([`${wrong} is not the web app bundle the manifest names`]);
  });
});

describe('hostFingerprint', () => {
  it('sees an edited profile, a Recued unit and a replaced default install, and ignores other apps\' units', () => {
    const home = fresh('home');
    writeFileSync(join(home, '.zshrc'), 'export PATH=$PATH\n');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    const before = hostFingerprint({ home });
    expect(diffFingerprints(before, hostFingerprint({ home }))).toEqual([]);

    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.example.updater.plist'), '<plist/>');
    expect(diffFingerprints(before, hostFingerprint({ home }))).toEqual([]);

    appendFileSync(join(home, '.zshrc'), 'export PATH="/tmp/x/bin:$PATH"  # Added by the Recued installer\n');
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.recued.server.plist'), '<plist/>');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync('/tmp/x/prefix/recued', join(home, '.local', 'bin', 'recued'));
    const changed = diffFingerprints(before, hostFingerprint({ home }));
    expect(changed.filter((line) => line.includes('profile ~/.zshrc'))).toHaveLength(2);
    expect(changed).toContainEqual(expect.stringMatching(/^now: unit .*com\.recued\.server\.plist sha256=/));
    expect(changed).toContainEqual(`was: install ${join(home, '.local/bin/recued')} absent`);
    expect(changed).toContainEqual(`now: install ${join(home, '.local/bin/recued')} symlink -> /tmp/x/prefix/recued`);
    expect(changed.some((line) => line.includes('com.example.updater'))).toBe(false);
  });

  it('prints no file content, only a hash prefix', () => {
    const home = fresh('home');
    writeFileSync(join(home, '.zshrc'), 'export SECRET_THING=do-not-print\n');
    expect(hostFingerprint({ home }).join('\n')).not.toContain('do-not-print');
  });
});

describe('driveReportVerdict', () => {
  const report = (stats: Record<string, number>, extra: Record<string, unknown> = {}) => JSON.stringify({
    stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0, ...stats },
    suites: [{
      title: 'live-update-path.spec.ts',
      suites: [{
        title: 'the update path, against the live feed',
        specs: ['STOPPED: a', 'RUNNING: b', 'SUPERVISED: c', 'UNSUPERVISED: d'].map((title) => ({
          title, tests: [{ results: [{ status: 'passed' }] }],
        })),
      }],
    }],
    errors: [],
    ...extra,
  });

  it('passes only every arm passing, and names each', () => {
    expect(driveReportVerdict(report({ expected: 4 }))).toEqual({
      ok: true,
      passed: 4,
      summary: '4 passed, 0 failed, 0 flaky, 0 skipped (STOPPED passed, RUNNING passed, SUPERVISED passed, UNSUPERVISED passed)',
    });
  });

  it('fails a failed, flaky or SKIPPED arm, a run of nothing, and an error outside any test', () => {
    expect(driveReportVerdict(report({ expected: 3, unexpected: 1 })).ok).toBe(false);
    expect(driveReportVerdict(report({ expected: 3, flaky: 1 })).ok).toBe(false);
    expect(driveReportVerdict(report({ expected: 3, skipped: 1 })).ok).toBe(false);
    expect(driveReportVerdict(report({}, { suites: [] })).ok).toBe(false);
    const thrown = driveReportVerdict(report({}, {
      suites: [], errors: [{ message: 'Error: E2E_REQUIRE_LIVE=1 but the update leg is not configured: x\n    at …' }],
    }));
    expect(thrown.ok).toBe(false);
    expect(thrown.summary).toContain('E2E_REQUIRE_LIVE=1 but the update leg is not configured: x');
    expect(driveReportVerdict(null)).toEqual({ ok: false, summary: 'the drive wrote no report' });
    expect(driveReportVerdict('{not json')).toEqual({ ok: false, summary: 'the drive report is not JSON' });
  });
});

describe('runConsumerProof', () => {
  type Scenario = {
    install?: (prefix: string, home: string) => void;
    driveReport?: string;
    previousBinary?: Buffer;
  };
  const passingReport = JSON.stringify({
    stats: { expected: 4, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [{ title: 's', specs: ['STOPPED: a', 'RUNNING: b', 'SUPERVISED: c', 'UNSUPERVISED: d']
      .map((title) => ({ title, tests: [{ results: [{ status: 'passed' }] }] })) }],
    errors: [],
  });

  const prove = async (scenario: Scenario = {}, { first = false } = {}) => {
    const candidate = release({ sequence: first ? 1 : 41, version: VERSION });
    const previous = release({ sequence: 40, version: PREVIOUS });
    const live = feed(previous);
    const plan = await planFor(candidate, live);
    const out = fresh('out');
    writeFileSync(join(out, plan.webclient!.file), candidate.bundle!);
    const home = fresh('home');
    writeFileSync(join(home, '.zshrc'), 'export PATH=$PATH\n');
    const scratchRoot = fresh('scratch');
    const calls: ConsumerProofRunRequest[] = [];
    const io: ConsumerProofIo = {
      fetchBytes: live.fetchBytes,
      download: async (url, destination) => {
        mkdirSync(dirname(destination), { recursive: true });
        if (url === LIVE_INSTALLER_URL) writeFileSync(destination, '#!/bin/sh\n');
        else if (url.endsWith(`/recued-${TRIPLE}`)) writeFileSync(destination, scenario.previousBinary ?? previous.binary);
        else if (live.objects.has(url)) writeFileSync(destination, live.objects.get(url)!);
        else return { ok: false, reason: 'curl: (22) 404' };
        return { ok: true };
      },
      run: async (request) => {
        calls.push(request);
        if (request.command === 'sh') {
          writeInstall(request.env.RECUED_PREFIX!, candidate);
          scenario.install?.(request.env.RECUED_PREFIX!, home);
        }
        if (request.command === 'npx') {
          writeFileSync(request.env.PLAYWRIGHT_JSON_OUTPUT_FILE!, scenario.driveReport ?? passingReport);
        }
        return { status: 0, timedOut: false, tail: '' };
      },
      version: async () => VERSION,
      processRunningFrom: async () => false,
    };
    const lines: string[] = [];
    const run = runConsumerProof({
      plan,
      out,
      repoRoot: checkout(),
      env: { PATH: process.env.PATH, RECUED_INSECURE: '1', CLOUDFLARE_API_TOKEN: 'x' },
      home,
      io,
      log: (line) => lines.push(line),
      scratchRoot,
    });
    return { run, calls, lines, scratchRoot, plan };
  };

  it('installs with the live script, then drives the update from the previous release, and cleans up', async () => {
    const { run, calls, lines, scratchRoot } = await prove();
    const { summary } = await run;
    expect(summary).toBe(
      `installed ${VERSION} with the live install.sh: binary, addon and web app are the signed bytes, sequence floor 41, `
        + `nothing outside the prefix changed; updated ${PREVIOUS} → ${VERSION}: 4 passed, 0 failed, 0 flaky, 0 skipped `
        + '(STOPPED passed, RUNNING passed, SUPERVISED passed, UNSUPERVISED passed)',
    );
    expect(calls.map((c) => c.command)).toEqual(['sh', process.execPath, 'npx']);
    const [install, seed, drive] = calls;
    // ⛔ The two opt-outs that keep the operator's machine untouched, and none
    // of the operator's consumer-steering or credential variables.
    expect(install.env).toMatchObject({ RECUED_AUTOSTART: '0', RECUED_NO_MODIFY_PATH: '1', RECUED_CHANNEL: 'stable' });
    for (const call of calls) {
      expect(call.env.RECUED_INSECURE).toBeUndefined();
      expect(call.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    }
    expect(seed.args).toEqual(expect.arrayContaining(['--binary', '--sidecar', '--force']));
    expect(drive.args).toEqual(['--no-install', 'playwright', 'test', '-c', UPDATE_DRIVE_CONFIG, 'live-update-path', '--reporter=list,json']);
    expect(drive.env).toMatchObject({
      E2E_REQUIRE_LIVE: '1',
      E2E_RECUED_BINARY: join(install.env.RECUED_PREFIX!, 'recued'),
      E2E_RECUED_SIDECAR: join(install.env.RECUED_PREFIX!, 'lib', 'better_sqlite3.node'),
      E2E_SEED_DIR: seed.args[seed.args.indexOf('--out') + 1],
    });
    expect(lines.some((line) => line.startsWith(`updating ${PREVIOUS} (sequence 40) to ${VERSION}`))).toBe(true);
    // Removed on success: nothing of the throwaway install outlives the proof.
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it('stops at a broken install, keeps its logs, and never starts the drive', async () => {
    const { run, calls } = await prove({ install: (prefix) => rmSync(join(prefix, 'lib', 'better_sqlite3.node')) });
    const error = await run.then(() => null, (e: unknown) => e as { message: string; scratchDir: string });
    expect(error?.message).toMatch(/^install leg: the native addon \(lib\/better_sqlite3\.node\) is missing/);
    expect(error?.message).toContain(`logs: ${error?.scratchDir}`);
    expect(existsSync(error!.scratchDir)).toBe(true);
    expect(calls.map((c) => c.command)).toEqual(['sh']);
  });

  it('fails an install that changed the operator\'s shell profile', async () => {
    const { run } = await prove({ install: (_prefix, home) => appendFileSync(join(home, '.zshrc'), 'export PATH=/x:$PATH\n') });
    await expect(run).rejects.toThrow(/install leg: the installer changed something outside its prefix:\n\s+was: profile ~\/\.zshrc/);
  });

  it('fails the update leg on a skipped arm, though the drive exited 0', async () => {
    const skipped = JSON.stringify({ stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 1 }, suites: [], errors: [] });
    await expect((await prove({ driveReport: skipped })).run).rejects.toThrow(/^update leg: the update drive exited 0: 3 passed, 0 failed, 0 flaky, 1 skipped/);
  });

  it('refuses a previous binary that is not the file its signed manifest names', async () => {
    const { run, calls } = await prove({ previousBinary: Buffer.from('tampered') });
    await expect(run).rejects.toThrow(
      `update leg: ${ORIGIN}/artifacts/40/recued-${TRIPLE} is not the file the signed ${PREVIOUS} manifest names`,
    );
    expect(calls.map((c) => c.command)).toEqual(['sh']);
  });

  it('runs only the install leg for the first release', async () => {
    const { run, calls } = await prove({}, { first: true });
    const { summary } = await run;
    expect(summary).toMatch(/; no update leg: this is the first release on the channel$/);
    expect(calls.map((c) => c.command)).toEqual(['sh']);
  });
});
