#!/usr/bin/env node
/**
 * A distributed, conditional R2 lease for `release-publish.mjs`.
 *
 * R2 is strongly consistent, but concurrent writes to the same key are
 * last-writer-wins. That is exactly the wrong primitive for a signed release
 * pointer: two publishers can both validate sequence N, then a slower N+1 can
 * overwrite N+2 (or compensate back to N) after clients have accepted it.
 *
 * This helper uses R2's S3-compatible conditional PutObject support:
 *
 *   - a missing lock is acquired with `If-None-Match: *`;
 *   - a released lock is acquired with `If-Match: <etag>`; and
 *   - release itself is an `If-Match` transition owned by the exact token.
 *
 * There is deliberately no time-based lease expiry. A publisher that is merely
 * slow must never lose authority while it is changing feed pointers. If a host
 * dies without releasing, the next operator must inspect the recorded owner and
 * pass the recorded owner token to `--break-release-lease`; that takeover is
 * itself conditional on the exact ETag belonging to that inspected token, so
 * two recovery attempts cannot both win and a late recovery cannot steal a new
 * publisher it never inspected.
 *
 * ⚠ MEASURED 2026-09-03, against this bucket, because two successive guesses
 * about it were wrong: R2's PutObject DOES honour `If-Match`, and its PUT and
 * GET return byte-identical ETags. A 412 here is therefore about the object
 * generation, never about the store lacking the feature. (What WAS real: the
 * ownership check compared those ETags verbatim and is now spelling-insensitive
 * — that defect stranded 26.9.2's lock, and 26.9.3 released cleanly with it
 * fixed.)
 *
 * Production credentials are the standard R2 S3 credentials documented by
 * Cloudflare. The publisher continues using Wrangler for object transfer, but
 * conditional writes require this S3 surface because Wrangler's object command
 * does not expose If-Match/If-None-Match.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { AwsClient } from 'aws4fetch';

const die = (message) => {
  console.error(`[release-publish-lease] ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const command = args[0];
const valueAfter = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? '') : '';
};

const bucket = valueAfter('--bucket');
const key = valueAfter('--key');
const providedToken = valueAfter('--token');
const ownerToken = providedToken || randomUUID();
const version = valueAfter('--version');
const sequence = valueAfter('--sequence');
const expectedEtag = valueAfter('--etag');
const expectedBreakToken = valueAfter('--break-token');

if (!['acquire', 'release'].includes(command)) die('expected acquire or release');
if (!bucket || !key) die('--bucket and --key are required');
if (command === 'acquire' && (!version || !Number.isSafeInteger(Number(sequence)) || Number(sequence) < 1)) {
  die('acquire requires --version and a positive integer --sequence');
}

const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const etagOf = (bytes) => `"${createHash('md5').update(bytes).digest('hex')}"`;

/** ⛔⛔ AN ENTITY TAG IS COMPARED BY ITS OPAQUE VALUE, NOT BY ITS SPELLING.
 *
 *  The lease's identity check compares the etag recorded when the lock was
 *  WRITTEN against the etag read back when it is RELEASED — two different
 *  responses from the store. HTTP allows the same tag to be spelled several
 *  ways (`"abc"`, `W/"abc"`, and some implementations answer a bare `abc`), and
 *  a store is free to answer a PUT and a GET differently. Compared verbatim,
 *  that spelling difference reads as "somebody else owns this lock".
 *
 *  🔑 MEASURED, NOT SUPPOSED: 26.9.2 published successfully and then failed to
 *  release its lease with `ownership changed`, while the lock object was
 *  provably untouched — its `md5(body)` still equalled the store's etag, its
 *  `state` was `active`, and its `token` was the one that run generated. Every
 *  other conjunct held, so only the etag comparison could have failed, on a
 *  value that had not changed. The publish is fail-safe, so the release was
 *  live and correct; the cost was a lock stuck `active` and a manual takeover
 *  on the NEXT publish — every publish, forever.
 *
 *  ⚠ NORMALISE FOR COMPARISON ONLY. What goes out in `If-Match` stays exactly
 *  the bytes the store gave us: the server is the authority on its own tag
 *  syntax, and rewriting a validator we send would be inventing one. This
 *  weakens nothing — a weak validator is still only equal to the same opaque
 *  value, and a mismatched lock still refuses.
 *
 *  ⚠ AND THE TEST DOUBLE COULD NOT HAVE CAUGHT IT. `testRead` and
 *  `testConditionalPut` both derive their tag from `etagOf`, so the double is
 *  self-consistent by construction and cannot express two spellings of one
 *  tag. `RECUED_TEST_R2_ETAG_SKEW` exists to give it that vocabulary. */
const normaliseEtag = (value) => {
  const trimmed = String(value ?? '').trim();
  const unweak = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
  return unweak.length >= 2 && unweak.startsWith('"') && unweak.endsWith('"')
    ? unweak.slice(1, -1)
    : unweak;
};

/** Do these two entity tags identify the same representation? Empty never
 *  matches — an absent tag is not agreement, and both call sites already refuse
 *  a missing one before reaching here. */
const etagMatches = (left, right) => {
  const a = normaliseEtag(left);
  const b = normaliseEtag(right);
  return a.length > 0 && a === b;
};

/** ⚠ TEST-STORE ONLY, and the reason it exists is above: the local double
 *  answered one spelling on both sides, so the release path's verbatim
 *  comparison passed there while failing against the real store. This lets a
 *  test answer a READ in a different (equally valid) spelling from the WRITE,
 *  which is the variation production actually met. */
const skewReadEtag = (etag) => {
  switch (process.env.RECUED_TEST_R2_ETAG_SKEW ?? '') {
    case 'weak': return `W/${etag}`;
    case 'unquoted': return normaliseEtag(etag);
    default: return etag;
  }
};
const activeBody = () => Buffer.from(canonicalJson({
  schema: 1,
  state: 'active',
  token: ownerToken,
  version,
  sequence: Number(sequence),
  pid: process.ppid,
  host: hostname(),
  acquired_at: new Date().toISOString(),
}));
const releasedBody = () => Buffer.from(canonicalJson({
  schema: 1,
  state: 'released',
  token: ownerToken,
  released_at: new Date().toISOString(),
}));

/** The integration suite uses the same filesystem as its fake Wrangler. This
 * branch is impossible outside NODE_ENV=test and a test-bucket, so it cannot be
 * turned into a production no-lock escape hatch. The per-key guard directory is
 * an atomic local mutex; the state transition beneath it mirrors R2 CAS. */
const testRoot = process.env.RECUED_TEST_R2_STORE;
const useTestStore = process.env.NODE_ENV === 'test'
  && bucket.startsWith('test-bucket')
  && typeof testRoot === 'string'
  && testRoot.length > 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTestGuard = async (path, fn) => {
  const guard = `${path}.cas-lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      mkdirSync(guard);
      try { return await fn(); } finally { rmSync(guard, { recursive: true, force: true }); }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await sleep(10);
    }
  }
  throw new Error(`timed out taking test CAS guard for ${path}`);
};

const testRead = (path) => {
  if (!existsSync(path)) return { kind: 'missing' };
  const bytes = readFileSync(path);
  return { kind: 'present', bytes, etag: skewReadEtag(etagOf(bytes)) };
};

const testConditionalPut = async (path, body, { ifMatch = '', ifNoneMatch = false } = {}) =>
  withTestGuard(path, async () => {
    const current = testRead(path);
    if (ifNoneMatch && current.kind !== 'missing') return { ok: false, precondition: true };
    if (ifMatch && (current.kind !== 'present' || !etagMatches(current.etag, ifMatch))) {
      return { ok: false, precondition: true };
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
    return { ok: true, etag: etagOf(body) };
  });

const encodedKey = key.split('/').map(encodeURIComponent).join('/');
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  ?? process.env.RECUED_RELEASE_R2_ACCESS_KEY_ID
  ?? '';
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  ?? process.env.RECUED_RELEASE_R2_SECRET_ACCESS_KEY
  ?? '';
const sessionToken = process.env.AWS_SESSION_TOKEN
  ?? process.env.RECUED_RELEASE_R2_SESSION_TOKEN;

let client;
let objectUrl;
if (!useTestStore) {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    die(
      'conditional release locking requires CLOUDFLARE_ACCOUNT_ID plus R2 S3 credentials '
        + '(AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or the RECUED_RELEASE_R2_* aliases)',
    );
  }
  client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    sessionToken,
    service: 's3',
    region: 'auto',
    retries: 2,
  });
  objectUrl = `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${encodedKey}`;
}

const readRemote = async () => {
  if (useTestStore) return testRead(join(testRoot, bucket, key));
  const response = await client.fetch(objectUrl, { method: 'GET' });
  if (response.status === 404) return { kind: 'missing' };
  if (!response.ok) {
    throw new Error(`GET ${objectUrl} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const etag = response.headers.get('etag') ?? '';
  if (!etag) throw new Error(`GET ${objectUrl} returned no ETag; cannot perform a conditional transition`);
  return { kind: 'present', bytes, etag };
};

const conditionalPut = async (body, { ifMatch = '', ifNoneMatch = false } = {}) => {
  if (useTestStore) return testConditionalPut(join(testRoot, bucket, key), body, { ifMatch, ifNoneMatch });
  const headers = new Headers({ 'content-type': 'application/json' });
  if (ifMatch) headers.set('if-match', ifMatch);
  if (ifNoneMatch) headers.set('if-none-match', '*');
  const response = await client.fetch(objectUrl, {
    method: 'PUT',
    headers,
    body,
    aws: { allHeaders: true },
  });
  if (response.status === 412) return { ok: false, precondition: true };
  if (!response.ok) {
    throw new Error(`PUT ${objectUrl} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const etag = response.headers.get('etag') ?? '';
  if (!etag) throw new Error(`PUT ${objectUrl} returned no ETag; cannot own the resulting lease`);
  return { ok: true, etag };
};

const parseLease = (state) => {
  if (state.kind !== 'present') return null;
  try { return JSON.parse(state.bytes.toString('utf8')); } catch { return null; }
};

const isValidLease = (lease) => {
  if (
    !lease
    || lease.schema !== 1
    || !['active', 'released'].includes(lease.state)
    || typeof lease.token !== 'string'
    || lease.token.length === 0
  ) return false;
  if (lease.state === 'released') return typeof lease.released_at === 'string';
  return typeof lease.version === 'string'
    && lease.version.length > 0
    && Number.isSafeInteger(lease.sequence)
    && lease.sequence > 0
    && Number.isSafeInteger(lease.pid)
    && lease.pid > 0
    && typeof lease.host === 'string'
    && lease.host.length > 0
    && typeof lease.acquired_at === 'string';
};

try {
  if (command === 'acquire') {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await readRemote();
      const prior = parseLease(current);
      if (current.kind === 'present' && !isValidLease(prior)) {
        die(`release lease at r2://${bucket}/${key} is malformed; refusing to overwrite custody evidence`);
      }
      if (current.kind === 'present' && prior.state === 'active') {
        // The operator authorizes the token they INSPECTED, not whichever active
        // owner happens to be present on this process's first GET. R2's If-Match
        // then binds that identity check to the exact object generation. If a
        // competing recovery already replaced it, its new token cannot be stolen.
        if (!expectedBreakToken || prior.token !== expectedBreakToken) {
          die(
            `another release publisher owns r2://${bucket}/${key}: `
              + `${prior.version || '?'} seq ${prior.sequence ?? '?'} on ${prior.host || '?'} `
              + `(pid ${prior.pid ?? '?'}, acquired ${prior.acquired_at || '?'}). `
              + 'If that host is definitively dead, inspect its token and re-run with '
              + '--break-release-lease <recorded-owner-token>.',
          );
        }
      } else if (expectedBreakToken) {
        // ⛔⛔ THREE DIFFERENT SITUATIONS USED TO PRINT ONE SENTENCE, and the
        // ambiguity actively misled: a takeover refused because the lock was
        // GONE read as a stale-token problem, while the real cause on 26.9.3 was
        // the conditional PUT below. An operator cannot act on "it changed" —
        // the three need different actions, so they need different messages.
        if (current.kind === 'missing') {
          die(
            `there is no release lease at r2://${bucket}/${key} to take over — it is ABSENT.\n`
              + '  A missing lock is acquired normally, so re-run WITHOUT --break-release-lease.\n'
              + '  (If you inspected a lock here, it has been removed since — check with another\n'
              + '  operator before publishing, because your inspection no longer describes the store.)',
          );
        }
        die(
          `the release lease at r2://${bucket}/${key} is already RELEASED `
            + `(token ${prior?.token ?? '?'}, released_at ${prior?.released_at ?? '?'}).\n`
            + '  Nothing holds it, so there is nothing to take over: re-run WITHOUT\n'
            + '  --break-release-lease and the ordinary acquire will claim it.',
        );
      }

      const result = current.kind === 'missing'
        ? await conditionalPut(activeBody(), { ifNoneMatch: true })
        : await conditionalPut(activeBody(), { ifMatch: current.etag });
      if (result.ok) {
        process.stdout.write(canonicalJson({ ok: true, token: ownerToken, etag: result.etag, key }));
        process.exit(0);
      }
      if (expectedBreakToken) {
        // ⛔ THE STORE REFUSED THE CONDITIONAL WRITE — a different failure from
        // either branch above, and the one that blocked a 26.9.3 takeover. The
        // lock was present, active, and carried exactly the inspected token;
        // what failed was the `If-Match` PUT.
        //
        // ⚠ AND "THE STORE DOES NOT SUPPORT If-Match" IS NOT THE EXPLANATION —
        // that was this comment's first guess and it is measured FALSE. Probed
        // against this bucket 2026-09-03: PUT and GET return byte-identical
        // ETags, and `If-Match` with the GET-returned value is ACCEPTED (200).
        // The 26.9.3 release then completed its own `If-Match` transition
        // cleanly. So a 412 here says something about THIS object generation,
        // not about the store.
        //
        // 🔑 ONE OBSERVED CASE REMAINS UNEXPLAINED: a takeover of a lock written
        // the previous day by a since-dead process, on an object nothing had
        // rewritten. Recorded rather than theorised — the last two theories were
        // both wrong, and a confident wrong cause here costs a release.
        die(
          `the store REFUSED the conditional write that would take over `
            + `r2://${bucket}/${key} (HTTP 412 on If-Match: ${current.etag}).\n`
            + '  The lock was present and carried the token you inspected, so this is not a\n'
            + '  stale inspection, and the store DOES honour If-Match (measured).\n'
            + '  Most likely another operator wrote this lock between the read and the write —\n'
            + '  re-read it and find out who before retrying.\n'
            + '  ⚠ If the recorded owner is unchanged and this repeats, you have hit the\n'
            + '  unexplained case: clear the lock out of band (`wrangler r2 object delete\n'
            + `  ${bucket}/${key} --remote\` — the --remote is NOT optional, without it\n`
            + '  wrangler deletes from LOCAL storage and reports success) and publish\n'
            + '  without --break-release-lease.',
        );
      }
      await sleep(25 * (attempt + 1));
    }
    die('release lease changed repeatedly while acquiring it; no publish authority was granted');
  }

  if (!expectedEtag || !providedToken) die('release requires --etag and --token');
  const current = await readRemote();
  const held = parseLease(current);
  // ⛔⛔ FOUR CONJUNCTS, ONE SENTENCE — and that is how a whole day went to the
  // wrong cause. "ownership changed" was printed while the object was provably
  // untouched, its state active and its token correct; only the etag differed.
  // Naming the failing conjunct is the difference between a diagnosis and a
  // guess, so each says what it found.
  if (current.kind !== 'present') {
    die(`the release lease at r2://${bucket}/${key} is GONE — it was removed while this `
      + 'publisher held it. The release itself is unaffected; nothing was rolled back.');
  }
  if (held?.state !== 'active') {
    die(`the release lease at r2://${bucket}/${key} is already ${held?.state ?? 'unreadable'}, `
      + 'not active — somebody released it on this publisher\'s behalf.');
  }
  if (held?.token !== ownerToken) {
    die(`the release lease at r2://${bucket}/${key} is held by a DIFFERENT owner now `
      + `(${held?.token ?? '?'} rather than this process's). Refusing to release a lock `
      + 'this process no longer owns.');
  }
  if (!etagMatches(current.etag, expectedEtag)) {
    die(`the release lease at r2://${bucket}/${key} still names this process as owner, but its `
      + `object generation moved (${expectedEtag} → ${current.etag}). The lock content is ours; `
      + 'the generation is not, so the conditional release cannot be proven safe.');
  }
  const result = await conditionalPut(releasedBody(), { ifMatch: expectedEtag });
  // ⛔ SAME REFUSAL AS THE TAKEOVER'S, AND THE SAME TWO CAUSES. Every conjunct
  // above passed, so the lock is ours and unchanged; what failed is the store
  // declining the conditional write. Say which, because "changed" sent a whole
  // day to the wrong cause once.
  if (!result.ok) {
    die(
      `the store REFUSED the conditional write that would release `
        + `r2://${bucket}/${key} (HTTP 412 on If-Match: ${expectedEtag}).\n`
        + '  ⚠ THE RELEASE ITSELF IS UNAFFECTED — whatever this publisher published is\n'
        + '  live and correct; only the lock is stranded, and it blocks the NEXT publish.\n'
        + '  The store DOES honour If-Match (measured 2026-09-03), and this transition has\n'
        + '  completed cleanly in production, so the object generation genuinely differs\n'
        + '  from the one this publisher acquired. Clear the lock out of band if it repeats:\n'
        + `  \`wrangler r2 object delete ${bucket}/${key} --remote\` — the --remote is NOT\n`
        + '  optional; without it wrangler deletes from LOCAL storage and prints success.',
    );
  }
  process.stdout.write(canonicalJson({ ok: true, released: true, etag: result.etag, key }));
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
