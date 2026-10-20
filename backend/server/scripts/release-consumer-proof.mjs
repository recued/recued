#!/usr/bin/env node
/**
 * The consumer proof: after a publish, install the release the way an owner
 * installs it, and update the previous release to it the way an owner updates.
 *
 * ⛔ THE PUBLIC PROOF SAYS WHAT THE CDN SERVES. THIS SAYS WHAT A CONSUMER CAN DO
 * WITH IT. release-public-proof.mjs proves every consumer URL returns the signed
 * candidate bytes. That is not an install: the live installer can still fail on
 * the live manifest, leave the native addon or the web app out, or record the
 * wrong sequence floor, and a feed every byte of which is right can still be one
 * an installed server will not update to. Those were proven by hand after each
 * publish, as a step of its own in internal design notes, which is the step a long release day
 * skips. So the publish ends here, in two legs:
 *
 *   1. INSTALL. The live `install.sh` installs into a throwaway prefix, with
 *      autostart and the shell-profile edit turned off. The binary, the addon
 *      and every web app file must be the candidate's bytes, `--version` must
 *      print the candidate's version, the sequence floor must be the
 *      candidate's sequence, and nothing outside the prefix may change.
 *   2. UPDATE. The previous release on the channel is fetched from its
 *      immutable `artifacts/<sequence>/` namespace and checked against its own
 *      signed manifest. It mints a realm, then updates itself from the live
 *      feed on every path of `apps/webclient/e2e/live-update-path.spec.ts`:
 *      stopped, running, supervised and unsupervised.
 *
 * ⛔ IT RUNS AFTER THE POINTERS COMMIT, SO A FAILURE IS NOT A ROLLBACK. The update
 * leg cannot run earlier: a server can only update to a version the feed
 * serves. What it buys is that a publish never ends in "release live" for a
 * release nobody could install or update to. Everything it needs is checked
 * BEFORE the first upload (`planConsumerProof`), so a proof that cannot run
 * stops the publish while nothing has moved.
 *
 * ⚠ IT RUNS ON THE OPERATOR'S OWN MACHINE, usually beside their own server. The
 * installer gets RECUED_AUTOSTART=0 and RECUED_NO_MODIFY_PATH=1, because
 * without them it arms a launchd/systemd unit and edits the shell profile for a
 * directory this deletes. Every child gets an environment with the consumer-
 * steering and credential-bearing variables removed (`consumerEnv`), and the
 * drive uses its own ports. `hostFingerprint` is the check that all of it held.
 *
 * Standalone, `npm run release:proof` repeats both legs against the live feed
 * for the candidate in `dist/release` (or RECUED_RELEASE_OUT). It needs no
 * Cloudflare credential, which is what makes it the re-run after a failure.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  compareVersions,
  libKeyFor,
  parseManifest,
  resolvePlatformTriple,
  verify,
} from '@recued/release';

import { sha256OfFile } from './release-public-proof.mjs';

export const CONSUMER_PROOF_SKIP_FLAG = '--skip-consumer-proof';
export const CONSUMER_PROOF_ENV = 'RECUED_RELEASE_CONSUMER_PROOF';
/** The proof covers the production feed only: the previous release it updates
 *  FROM pins the production key and asks the production origin. */
export const CONSUMER_PROOF_ORIGIN = 'https://releases.recued.com';
export const LIVE_INSTALLER_URL = 'https://recued.com/install.sh';
export const CONSUMER_PROOF_CHANNEL = 'stable';
/** How far back to look for a lower version. A same-version republish (a
 *  rollout or notes change) keeps the version, so the previous VERSION can sit
 *  more than one sequence back. */
export const PREVIOUS_RELEASE_SEARCH_DEPTH = 12;
export const UPDATE_DRIVE_SPEC = 'apps/webclient/e2e/live-update-path.spec.ts';
export const UPDATE_DRIVE_CONFIG = 'apps/webclient/e2e/playwright.config.ts';
export const SEED_SCRIPT = 'backend/server/scripts/make-e2e-seed.mjs';
/** The installer's version stamp beside the web app; the one file it adds. */
export const WEBCLIENT_INSTALL_STAMP = '.recued-installed-version';

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_TIMEOUT_SECONDS = 15 * 60;
const SEED_TIMEOUT_MS = 10 * 60_000;
const DRIVE_TIMEOUT_MS = 45 * 60_000;

export class ConsumerProofError extends Error {
  constructor(message, { scratchDir = null } = {}) {
    super(message);
    this.name = 'ConsumerProofError';
    this.scratchDir = scratchDir;
  }
}

/** Whether to run. ⛔ A mistyped value is refused rather than read as either
 *  answer: the publisher asks this before its first upload, so a typo stops the
 *  run while nothing is live instead of quietly skipping the proof. */
export const consumerProofSetting = ({ args = [], env = process.env } = {}) => {
  const raw = env[CONSUMER_PROOF_ENV];
  const value = (raw ?? '').trim();
  if (value !== '' && value !== 'skip') {
    throw new ConsumerProofError(
      `${CONSUMER_PROOF_ENV} must be empty or "skip" (got ${JSON.stringify(raw)})`,
    );
  }
  if (args.includes(CONSUMER_PROOF_SKIP_FLAG)) return { skip: true, reason: CONSUMER_PROOF_SKIP_FLAG };
  if (value === 'skip') return { skip: true, reason: `${CONSUMER_PROOF_ENV}=skip` };
  return { skip: false };
};

/** The child environment: the operator's, minus everything that would steer a
 *  consumer or hand it a credential, plus what this run sets.
 *
 *  ⛔ REMOVED BY PATTERN, NOT BY LIST. A feed URL (RECUED_MANIFEST_URL,
 *  RECUED_RELEASE_MANIFEST_URL), a key (RECUED_RELEASE_PUBKEY), RECUED_INSECURE,
 *  RECUED_FORCE or an update mode (RECUED_SELF_UPDATE) left in the operator's
 *  shell would change what is being proven, and a list is closed: the next knob
 *  would leak in unnoticed. The publish shell also holds Cloudflare tokens, and
 *  the installer is a downloaded script. */
const DROPPED_ENV = [
  /^RECUED_/, /^E2E_/, /^PLAYWRIGHT_/, /^CLOUDFLARE_/, /^CF_/, /^SUPABASE_/,
  /(TOKEN|SECRET|PASSWORD|PASSPHRASE|_KEY|_SEED)$/i,
];
export const consumerEnv = (base, set = {}) => {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || DROPPED_ENV.some((pattern) => pattern.test(name))) continue;
    env[name] = value;
  }
  return { ...env, ...set };
};

// ── Processes and downloads ────────────────────────────────────────────────

/** Run a command to completion without blocking the event loop (the publisher's
 *  signal handlers stay live). Output goes to `logPath`; `echo` also prints each
 *  line, and the last few KB come back for an error message. */
export const runLogged = ({ command, args, cwd, env, logPath, timeoutMs, echo = null }) =>
  new Promise((settle) => {
    mkdirSync(dirname(logPath), { recursive: true });
    const log = openSync(logPath, 'a');
    let tail = '';
    let pending = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (echo && pending) echo(pending);
      closeSync(log);
      settle({ ...result, timedOut, tail });
    };
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      done({ status: null, error });
      return;
    }
    const onData = (chunk) => {
      writeSync(log, chunk);
      const text = chunk.toString('utf8');
      tail = `${tail}${text}`.slice(-4000);
      if (echo) {
        const lines = `${pending}${text}`.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) echo(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.on('error', (error) => done({ status: null, error }));
    child.on('close', (status, signal) => done({ status, signal }));
  });

const runCapture = (command, args, { timeoutMs = 60_000 } = {}) => new Promise((settle) => {
  const out = [];
  let err = '';
  let child;
  try {
    child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    settle({ status: null, stdout: Buffer.alloc(0), stderr: String(error?.message ?? error) });
    return;
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
  child.on('error', (error) => { clearTimeout(timer); settle({ status: null, stdout: Buffer.concat(out), stderr: `${err}${error.message}` }); });
  child.on('close', (status) => { clearTimeout(timer); settle({ status, stdout: Buffer.concat(out), stderr: err }); });
});

const curlReason = (r) => (r.stderr.trim() || `curl exited ${r.status}`).split('\n').at(-1).slice(0, 200);

/** A small public object, as bytes. `-f`, so an HTTP error is a failure with its
 *  status in the reason rather than an error page read as content. */
export const curlFetchBytes = async (url, { timeoutSeconds = 30 } = {}) => {
  const r = await runCapture('curl', ['-fsSL', '-m', String(timeoutSeconds), url], {
    timeoutMs: (timeoutSeconds + 5) * 1000,
  });
  return r.status === 0 ? { ok: true, bytes: r.stdout } : { ok: false, reason: curlReason(r) };
};

/** A large public object, streamed to `destination`. */
export const curlDownload = async (url, destination, { timeoutSeconds = DOWNLOAD_TIMEOUT_SECONDS } = {}) => {
  rmSync(destination, { force: true });
  const r = await runCapture('curl', ['-fsSL', '-m', String(timeoutSeconds), '-o', destination, url], {
    timeoutMs: (timeoutSeconds + 5) * 1000,
  });
  return r.status === 0 ? { ok: true } : { ok: false, reason: curlReason(r) };
};

const versionOf = async (exe) => {
  const r = await runCapture(exe, ['--version'], { timeoutMs: 60_000 });
  return r.status === 0 ? r.stdout.toString('utf8').trim().split('\n')[0] ?? '' : `(exited ${r.status}) ${r.stderr.trim()}`;
};

/** `pgrep -q`: the answer and nothing else. ⛔ Never `-l`/`-a`: a process's
 *  arguments and environment can carry credentials.
 *  ⚠ BOTH SPELLINGS OF THE PATH. On macOS the temp folder is `/var/folders/…`
 *  and also `/private/var/folders/…` (a symlink), and `-f` matches the
 *  arguments as typed, so a process started under the other spelling would
 *  look absent. */
const processRunningFrom = async (path) => {
  let real = path;
  try { real = realpathSync(path); } catch { /* gone: the given spelling only */ }
  for (const spelling of new Set([path, real])) {
    if ((await runCapture('pgrep', ['-q', '-f', spelling])).status === 0) return true;
  }
  return false;
};

/** Everything the legs do to the outside world, injectable for tests. */
export const realConsumerProofIo = {
  fetchBytes: curlFetchBytes,
  download: curlDownload,
  run: runLogged,
  version: versionOf,
  processRunningFrom,
};

// ── The plan (before anything is uploaded) ─────────────────────────────────

/** The newest release on `channel` before `sequence` whose version is lower
 *  than `version`, read from its immutable signed manifest. Null only for the
 *  first release. ⛔ FAILS CLOSED: an unreadable or unverifiable manifest is an
 *  error, never a reason to look further back for one that verifies. */
export const findPreviousRelease = async ({
  origin,
  sequence,
  channel,
  version,
  triple,
  pubkey,
  fetchBytes = curlFetchBytes,
  depth = PREVIOUS_RELEASE_SEARCH_DEPTH,
}) => {
  if (sequence <= 1) return null;
  const lowest = Math.max(1, sequence - depth);
  for (let s = sequence - 1; s >= lowest; s -= 1) {
    const url = `${origin}/artifacts/${s}/manifest.json`;
    const body = await fetchBytes(url);
    if (!body.ok) throw new ConsumerProofError(`cannot read the release at sequence ${s} (${url}): ${body.reason}`);
    const sig = await fetchBytes(`${url}.minisig`);
    if (!sig.ok) throw new ConsumerProofError(`cannot read the signature of the release at sequence ${s}: ${sig.reason}`);
    const checked = verify({
      content: new Uint8Array(body.bytes),
      signatureText: Buffer.from(sig.bytes).toString('utf8'),
      publicKeyText: pubkey,
    });
    if (!checked.ok) {
      throw new ConsumerProofError(`the release at sequence ${s} does not verify against the pinned key (${checked.reason})`);
    }
    let previous;
    try {
      previous = parseManifest(Buffer.from(body.bytes).toString('utf8'));
    } catch (error) {
      throw new ConsumerProofError(`the release at sequence ${s} is not a manifest servers read: ${error?.message ?? error}`);
    }
    if (previous.sequence !== s) {
      throw new ConsumerProofError(`${url} names sequence ${previous.sequence}, not ${s}`);
    }
    const release = previous.channels?.[channel];
    if (!release || compareVersions(release.version, version) >= 0) continue;
    const binary = release.artifacts?.[triple];
    const addon = release.artifacts?.[libKeyFor(triple)];
    if (!binary?.url || !binary?.sha256 || !addon?.url || !addon?.sha256) {
      throw new ConsumerProofError(`${release.version} (sequence ${s}) published no ${triple} binary and addon to update from`);
    }
    return {
      version: release.version,
      sequence: s,
      binary: { url: binary.url, sha256: binary.sha256 },
      addon: { url: addon.url, sha256: addon.sha256 },
    };
  }
  throw new ConsumerProofError(
    `no ${channel} release older than ${version} in the ${sequence - lowest} sequence(s) before ${sequence}`,
  );
};

const playwrightInstalled = (repoRoot) => {
  try {
    createRequire(join(repoRoot, 'package.json')).resolve('@playwright/test/package.json');
    return true;
  } catch {
    return false;
  }
};

/** Everything the proof needs, decided before the first upload. Throws a
 *  ConsumerProofError naming what is missing; the publisher fails on it while
 *  nothing is live. */
export const planConsumerProof = async ({
  manifest,
  version,
  origin,
  prefix,
  pubkey,
  trustedPubkey,
  repoRoot,
  platform = process.platform,
  arch = process.arch,
  fetchBytes = curlFetchBytes,
  hasPlaywright = playwrightInstalled,
}) => {
  if (origin !== CONSUMER_PROOF_ORIGIN || prefix !== '') {
    throw new ConsumerProofError(
      `it proves the production feed (${CONSUMER_PROOF_ORIGIN}/), and this publish targets ${origin}/${prefix}`,
    );
  }
  if (!pubkey || pubkey !== trustedPubkey) {
    throw new ConsumerProofError(
      'this release is verified against a key other than the one installed servers pin, so no installed server could update to it',
    );
  }
  const triple = resolvePlatformTriple(platform, arch);
  if (!triple || triple.startsWith('windows-')) {
    throw new ConsumerProofError(`it installs with install.sh, which runs on macOS and Linux; this host is ${platform}-${arch}`);
  }
  const channel = CONSUMER_PROOF_CHANNEL;
  const release = manifest.channels?.[channel];
  if (!release || release.version !== version) {
    throw new ConsumerProofError(
      `it proves the ${channel} channel, and this manifest puts ${release ? release.version : 'nothing'} there, not ${version}`,
    );
  }
  const binary = release.artifacts?.[triple];
  const addon = release.artifacts?.[libKeyFor(triple)];
  if (!binary?.sha256 || !addon?.sha256) {
    throw new ConsumerProofError(`this release publishes no ${triple} binary and addon, and this host can only install ${triple}`);
  }
  const missing = [UPDATE_DRIVE_SPEC, UPDATE_DRIVE_CONFIG, SEED_SCRIPT]
    .filter((path) => !existsSync(join(repoRoot, path)));
  if (missing.length > 0) {
    throw new ConsumerProofError(`this checkout has no ${missing.join(', ')}`);
  }
  if (!hasPlaywright(repoRoot)) {
    throw new ConsumerProofError('@playwright/test is not installed in this checkout (run `npm ci` at its root)');
  }
  const webclient = release.artifacts?.webclient;
  const previous = await findPreviousRelease({
    origin, sequence: manifest.sequence, channel, version, triple, pubkey, fetchBytes,
  });
  return {
    version,
    sequence: manifest.sequence,
    channel,
    triple,
    installerUrl: LIVE_INSTALLER_URL,
    binary: { sha256: binary.sha256 },
    addon: { sha256: addon.sha256 },
    webclient: webclient?.url
      ? { file: basename(new URL(webclient.url).pathname), sha256: webclient.sha256 }
      : null,
    previous,
  };
};

export const describeConsumerProofPlan = (plan) =>
  `install ${plan.version} with ${plan.installerUrl} on ${plan.triple}, then `
  + (plan.previous
    ? `update ${plan.previous.version} (sequence ${plan.previous.sequence}) to it on every update path (about 15 minutes in all)`
    : 'no update leg: this is the first release on the channel');

// ── Checks ─────────────────────────────────────────────────────────────────

const listFiles = (root) => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return files;
};

/** The installed web app against the candidate's signed bundle: the same paths,
 *  the same bytes, and only the installer's version stamp besides. */
export const checkWebclientTree = ({ installedDir, bundle, version }) => {
  if (!existsSync(installedDir)) return [`no web app was installed (${installedDir} does not exist)`];
  const want = new Map((bundle?.files ?? []).map((file) => [file.path, file.sha256]));
  if (want.size === 0) return ['the candidate web app bundle lists no files'];
  const have = new Map(listFiles(installedDir).map((path) => [path, sha256OfFile(join(installedDir, path))]));
  const issues = [];
  const sample = (paths) => `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''}`;
  const missing = [...want.keys()].filter((path) => !have.has(path));
  const differ = [...want].filter(([path, sha]) => have.has(path) && have.get(path) !== sha).map(([path]) => path);
  const extra = [...have.keys()].filter((path) => !want.has(path) && path !== WEBCLIENT_INSTALL_STAMP);
  if (missing.length > 0) issues.push(`the web app is missing ${missing.length} file(s): ${sample(missing)}`);
  if (differ.length > 0) issues.push(`${differ.length} web app file(s) differ from the signed bundle: ${sample(differ)}`);
  if (extra.length > 0) issues.push(`the web app has ${extra.length} file(s) the bundle does not list: ${sample(extra)}`);
  const stampPath = join(installedDir, WEBCLIENT_INSTALL_STAMP);
  const stamp = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : null;
  if (stamp !== version) {
    issues.push(`the web app's version stamp is ${stamp === null ? 'missing' : JSON.stringify(stamp)}, not ${version}`);
  }
  return issues;
};

/** The installed release against the plan: what an owner's server would run. */
export const checkInstalledRelease = async ({ prefix, plan, bundlePath, readVersion }) => {
  const exe = join(prefix, 'recued');
  const addon = join(prefix, 'lib', 'better_sqlite3.node');
  if (!existsSync(exe)) return [`no binary at ${exe}`];
  const issues = [];
  const printed = (await readVersion(exe)).trim();
  if (printed !== plan.version) issues.push(`\`recued --version\` prints ${JSON.stringify(printed)}, not ${plan.version}`);
  if (sha256OfFile(exe) !== plan.binary.sha256) {
    issues.push(`the installed binary is not the ${plan.triple} artifact the manifest names`);
  }
  if (!existsSync(addon)) {
    issues.push('the native addon (lib/better_sqlite3.node) is missing: the server would die at its first database open');
  } else if (sha256OfFile(addon) !== plan.addon.sha256) {
    issues.push(`the installed addon is not the ${libKeyFor(plan.triple)} artifact the manifest names`);
  }
  const floorPath = join(prefix, '.release-sequence');
  const floor = existsSync(floorPath) ? readFileSync(floorPath, 'utf8').trim() : null;
  if (floor !== String(plan.sequence)) {
    issues.push(`the sequence floor is ${floor === null ? 'missing' : JSON.stringify(floor)}, not ${plan.sequence}`);
  }
  if (plan.webclient) {
    if (!bundlePath || !existsSync(bundlePath)) {
      issues.push(`the candidate web app bundle is not at ${bundlePath} to compare with`);
    } else if (sha256OfFile(bundlePath) !== plan.webclient.sha256) {
      issues.push(`${bundlePath} is not the web app bundle the manifest names`);
    } else {
      issues.push(...checkWebclientTree({
        installedDir: join(prefix, 'webclient'),
        bundle: JSON.parse(readFileSync(bundlePath, 'utf8')),
        version: plan.version,
      }));
    }
  }
  return issues;
};

const describeHostFile = (path, { hash }) => {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 'absent';
  }
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = readlinkSync(path); } catch { /* unreadable link */ }
    return `symlink -> ${target}`;
  }
  if (!st.isFile()) return st.isDirectory() ? 'directory' : 'other';
  if (!hash) return `size=${st.size} mtime=${Math.round(st.mtimeMs)}`;
  try {
    return `sha256=${sha256OfFile(path).slice(0, 16)}`;
  } catch {
    return `unreadable size=${st.size}`;
  }
};

const namesIn = (dir) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/** What an installer could touch outside its prefix, without printing any
 *  file's content: shell profiles by hash, Recued's launchd/systemd units by
 *  hash, and the default install locations by size and mtime.
 *
 *  ⚠ ONLY WHAT AN INSTALLER WRITES. The operator's own server keeps writing its
 *  data folder throughout the proof, so a data folder here would fail the proof
 *  for something it did not do. Other apps' units are left out for the same
 *  reason. */
export const hostFingerprint = ({ home = homedir() } = {}) => {
  const lines = [];
  for (const rel of ['.zshrc', '.zprofile', '.zshenv', '.bash_profile', '.bashrc', '.profile', '.config/fish/config.fish']) {
    lines.push(`profile ~/${rel} ${describeHostFile(join(home, rel), { hash: true })}`);
  }
  for (const dir of [
    join(home, 'Library/LaunchAgents'),
    '/Library/LaunchAgents',
    '/Library/LaunchDaemons',
    join(home, '.config/systemd/user'),
    '/etc/systemd/system',
  ]) {
    for (const name of namesIn(dir).filter((n) => /recued/i.test(n))) {
      lines.push(`unit ${join(dir, name)} ${describeHostFile(join(dir, name), { hash: true })}`);
    }
  }
  for (const path of [
    join(home, '.local/lib/recued/recued'),
    join(home, '.local/bin/recued'),
    '/usr/local/lib/recued/recued',
    '/usr/local/bin/recued',
    '/opt/homebrew/bin/recued',
  ]) {
    lines.push(`install ${path} ${describeHostFile(path, { hash: false })}`);
  }
  return lines;
};

export const diffFingerprints = (before, after) => {
  const was = new Set(before);
  const now = new Set(after);
  return [
    ...before.filter((line) => !now.has(line)).map((line) => `was: ${line}`),
    ...after.filter((line) => !was.has(line)).map((line) => `now: ${line}`),
  ];
};

/** The drive's JSON report, read for what a green exit code cannot say. ⛔ A
 *  skipped arm is a FAILURE here: a skip nobody reads is how a dead check stays
 *  green, and with E2E_REQUIRE_LIVE=1 nothing in this drive should skip. */
export const driveReportVerdict = (text) => {
  if (text === null || text === undefined) return { ok: false, summary: 'the drive wrote no report' };
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return { ok: false, summary: 'the drive report is not JSON' };
  }
  const stats = report?.stats ?? {};
  const count = (name) => (Number.isSafeInteger(stats[name]) ? stats[name] : 0);
  const passed = count('expected');
  const failed = count('unexpected');
  const flaky = count('flaky');
  const skipped = count('skipped');
  const titles = [];
  const walk = (suite) => {
    for (const spec of suite?.specs ?? []) {
      const status = spec.tests?.[0]?.results?.at(-1)?.status ?? 'not run';
      titles.push(`${spec.title.split(':')[0]} ${status}`);
    }
    for (const child of suite?.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  const errors = (report?.errors ?? []).map((e) => String(e?.message ?? e).split('\n')[0]);
  const summary = `${passed} passed, ${failed} failed, ${flaky} flaky, ${skipped} skipped`
    + `${titles.length ? ` (${titles.join(', ')})` : ''}${errors.length ? `; ${errors.join('; ')}` : ''}`;
  return { ok: passed > 0 && failed === 0 && flaky === 0 && skipped === 0 && errors.length === 0, passed, summary };
};

// ── The legs (after the pointers commit) ───────────────────────────────────

const indent = (text) => text.trim().split('\n').slice(-25).map((line) => `      ${line}`).join('\n');

const installLeg = async ({ plan, dir, out, io, env, home }) => {
  const prefix = join(dir, 'prefix');
  const script = join(dir, 'install.sh');
  mkdirSync(dir, { recursive: true });
  const before = hostFingerprint({ home });
  const got = await io.download(plan.installerUrl, script, { timeoutSeconds: 60 });
  if (!got.ok) throw new Error(`cannot fetch ${plan.installerUrl}: ${got.reason}`);
  const ran = await io.run({
    command: 'sh',
    args: [script],
    cwd: dir,
    env: consumerEnv(env, {
      RECUED_PREFIX: prefix,
      RECUED_BINDIR: join(dir, 'bin'),
      RECUED_AUTOSTART: '0',
      RECUED_NO_MODIFY_PATH: '1',
      RECUED_CHANNEL: plan.channel,
    }),
    logPath: join(dir, 'install.log'),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (ran.status !== 0) {
    throw new Error(`the live install.sh ${ran.timedOut ? 'timed out' : `exited ${ran.status ?? ran.error?.message}`}:\n${indent(ran.tail)}`);
  }
  const issues = await checkInstalledRelease({
    prefix,
    plan,
    bundlePath: plan.webclient ? join(out, plan.webclient.file) : null,
    readVersion: io.version,
  });
  const changed = diffFingerprints(before, hostFingerprint({ home }));
  if (changed.length > 0) issues.push(`the installer changed something outside its prefix:\n${changed.map((c) => `      ${c}`).join('\n')}`);
  if (await io.processRunningFrom(prefix)) issues.push('a process is still running from the throwaway prefix');
  if (issues.length > 0) throw new Error(issues.join('\n    '));
  return { exe: join(prefix, 'recued'), addon: join(prefix, 'lib', 'better_sqlite3.node') };
};

const updateLeg = async ({ plan, dir, installed, repoRoot, io, env, log }) => {
  const prevExe = join(dir, 'previous', 'recued');
  const prevAddon = join(dir, 'previous', 'lib', 'better_sqlite3.node');
  mkdirSync(dirname(prevAddon), { recursive: true });
  for (const [artifact, destination] of [[plan.previous.binary, prevExe], [plan.previous.addon, prevAddon]]) {
    const got = await io.download(artifact.url, destination, { timeoutSeconds: DOWNLOAD_TIMEOUT_SECONDS });
    if (!got.ok) throw new Error(`cannot download ${artifact.url}: ${got.reason}`);
    if (sha256OfFile(destination) !== artifact.sha256) {
      throw new Error(`${artifact.url} is not the file the signed ${plan.previous.version} manifest names`);
    }
  }
  chmodSync(prevExe, 0o755);
  const seedDir = join(dir, 'seed');
  const seeded = await io.run({
    command: process.execPath,
    args: [join(repoRoot, SEED_SCRIPT), '--out', seedDir, '--binary', prevExe, '--sidecar', prevAddon, '--force'],
    cwd: join(repoRoot, 'backend', 'server'),
    env: consumerEnv(env),
    logPath: join(dir, 'seed.log'),
    timeoutMs: SEED_TIMEOUT_MS,
  });
  if (seeded.status !== 0) {
    throw new Error(`${plan.previous.version} could not mint a realm to update:\n${indent(seeded.tail)}`);
  }
  const reportPath = join(dir, 'drive-report.json');
  const drive = await io.run({
    command: 'npx',
    args: ['--no-install', 'playwright', 'test', '-c', UPDATE_DRIVE_CONFIG, 'live-update-path', '--reporter=list,json'],
    cwd: repoRoot,
    env: consumerEnv(env, {
      E2E_REQUIRE_LIVE: '1',
      E2E_RECUED_BINARY: installed.exe,
      E2E_RECUED_SIDECAR: installed.addon,
      E2E_RECUED_PREV_BINARY: prevExe,
      E2E_RECUED_PREV_SIDECAR: prevAddon,
      E2E_SEED_DIR: seedDir,
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
    }),
    logPath: join(dir, 'drive.log'),
    timeoutMs: DRIVE_TIMEOUT_MS,
    echo: (line) => log(`  │ ${line}`),
  });
  const verdict = driveReportVerdict(existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null);
  if (drive.status !== 0 || !verdict.ok) {
    throw new Error(
      `the update drive ${drive.timedOut ? 'timed out' : `exited ${drive.status ?? drive.error?.message}`}: ${verdict.summary}`,
    );
  }
  return verdict;
};

const elapsed = (start) => `${Math.round((Date.now() - start) / 1000)} s`;

/** Both legs. Resolves with a one-line summary, or throws a ConsumerProofError
 *  naming the leg that failed and the folder holding its logs (kept on failure,
 *  removed on success). */
export const runConsumerProof = async ({
  plan,
  out,
  repoRoot,
  env = process.env,
  home = homedir(),
  io = realConsumerProofIo,
  log = console.log,
  scratchRoot = tmpdir(),
}) => {
  const scratch = mkdtempSync(join(scratchRoot, `recued-consumer-proof-${plan.version}-`));
  const leg = async (name, fn) => {
    try {
      return await fn();
    } catch (error) {
      throw new ConsumerProofError(`${name} leg: ${error?.message ?? error}\n    logs: ${scratch}`, { scratchDir: scratch });
    }
  };

  let start = Date.now();
  log(`installing ${plan.version} with ${plan.installerUrl} into a throwaway prefix (autostart and profile edits off)…`);
  const installed = await leg('install', () => installLeg({ plan, dir: join(scratch, 'install'), out, io, env, home }));
  const installSummary = `installed ${plan.version} with the live install.sh: binary, addon`
    + `${plan.webclient ? ' and web app' : ''} are the signed bytes, sequence floor ${plan.sequence}, nothing outside the prefix changed`;
  log(`${installSummary} (${elapsed(start)})`);

  let updateSummary = 'no update leg: this is the first release on the channel';
  if (plan.previous) {
    start = Date.now();
    log(`updating ${plan.previous.version} (sequence ${plan.previous.sequence}) to ${plan.version} on every update path (about 12 minutes)…`);
    const verdict = await leg('update', () => updateLeg({ plan, dir: join(scratch, 'update'), installed, repoRoot, io, env, log }));
    updateSummary = `updated ${plan.previous.version} → ${plan.version}: ${verdict.summary}`;
    log(`${updateSummary} (${elapsed(start)})`);
  }
  rmSync(scratch, { recursive: true, force: true });
  return { summary: `${installSummary}; ${updateSummary}` };
};

// ── Standalone: `npm run release:proof` ────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const say = (m) => console.log(`[release-proof] ${m}`);
  const stop = (m) => { console.error(`[release-proof] ${m}`); process.exit(1); };
  const { TRUSTED_RELEASE_PUBKEY } = await import('../src/update/trusted-release-pubkey.js');
  const repoRoot = resolve(SCRIPT_DIR, '..', '..', '..');
  const out = resolve(process.env.RECUED_RELEASE_OUT ?? 'dist/release');
  const manifestPath = join(out, 'manifest.json');
  if (!existsSync(manifestPath) || !existsSync(`${manifestPath}.minisig`)) {
    stop(`no signed candidate in ${out} (set RECUED_RELEASE_OUT to the published release's directory)`);
  }
  const bytes = readFileSync(manifestPath);
  const checked = verify({
    content: new Uint8Array(bytes),
    signatureText: readFileSync(`${manifestPath}.minisig`, 'utf8'),
    publicKeyText: TRUSTED_RELEASE_PUBKEY,
  });
  if (!checked.ok) stop(`${manifestPath} does not verify against the pinned key (${checked.reason})`);
  const manifest = parseManifest(bytes.toString('utf8'));
  const version = manifest.channels?.[CONSUMER_PROOF_CHANNEL]?.version ?? '';
  // ⛔ THE LIVE FEED MUST BE THIS CANDIDATE. The proof installs and updates to
  // whatever the feed serves, so against any other feed it would prove a
  // release that is not the one in this folder.
  const live = await curlFetchBytes(`${CONSUMER_PROOF_ORIGIN}/${CONSUMER_PROOF_CHANNEL}/manifest.json`);
  if (!live.ok) stop(`cannot read the live ${CONSUMER_PROOF_CHANNEL} manifest: ${live.reason}`);
  if (!Buffer.from(live.bytes).equals(bytes)) {
    let liveSequence = '?';
    try { liveSequence = String(JSON.parse(Buffer.from(live.bytes).toString('utf8')).sequence); } catch { /* shown as ? */ }
    stop(`the live feed serves sequence ${liveSequence}, not this candidate (sequence ${manifest.sequence}); publish it first`);
  }
  let plan;
  try {
    plan = await planConsumerProof({
      manifest,
      version,
      origin: CONSUMER_PROOF_ORIGIN,
      prefix: '',
      pubkey: TRUSTED_RELEASE_PUBKEY,
      trustedPubkey: TRUSTED_RELEASE_PUBKEY,
      repoRoot,
    });
  } catch (error) {
    stop(`the consumer proof cannot run: ${error?.message ?? error}`);
  }
  say(`proving the live ${version} (sequence ${manifest.sequence}): ${describeConsumerProofPlan(plan)}`);
  try {
    const result = await runConsumerProof({ plan, out, repoRoot, log: (m) => say(m) });
    say(`ok — ${result.summary}`);
  } catch (error) {
    stop(`FAILED — ${error?.message ?? error}`);
  }
}
