/**
 * The public release proof: what consumers actually receive.
 *
 * ⛔ A COMMITTED POINTER AND A SUCCESSFUL PURGE ARE NOT DELIVERY. The publisher
 * reads every object back from R2 and purges each URL, and neither asks the
 * question every consumer asks: what does the exact URL return, through the CDN?
 * 26.8.5 seq 7 (2026-08-06) is the measured gap: the edge served the previous
 * Windows binaries for 85 minutes (`cf-cache-status: HIT`) while the manifest
 * named the new hashes, so every Windows install failed closed on its sha256
 * check, and nothing on the publisher's side could see it.
 *
 * So after the purge, and before the publisher says "release live", every
 * consumer-facing object is fetched from the public origin the way consumers
 * fetch it (no query string, no cache-bypass header), streamed to disk, and
 * compared by size and sha256 with the candidate bytes:
 *   · each manifest pair path (every channel, plus the flat legacy path), as a
 *     plain request, as a server update check, and on a channel path as an
 *     installer. The User-Agent is part of the request that a cache key or a
 *     rule can depend on, so each family is sampled with a value the fleet
 *     really sends (`updateCheckUserAgent` in src/update/release-config.ts, and
 *     `recued-install/1 (<triple>; <channel>)` in both installers).
 *   · each hosted artifact and its detached signature, as a plain request. The
 *     installers' own artifact downloads carry no User-Agent.
 * A mismatch is retried, because the edge converges, and then fails the publish.
 *
 * ⚠ A SAMPLE, NOT A CENSUS. A cache keyed on the User-Agent holds one entry per
 * value, and servers send one per version, platform and distribution. The proof
 * catches a stale or misrouted variant of the kind the fleet requests; it
 * cannot enumerate every one.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const PUBLIC_PROOF_MANIFEST = 'manifest.json';
export const PUBLIC_PROOF_MANIFEST_SIG = 'manifest.json.minisig';
/** Metadata is tiny; an artifact is bounded like the installers' own download. */
export const PUBLIC_PROOF_METADATA_TIMEOUT_SECONDS = 20;
export const PUBLIC_PROOF_ARTIFACT_TIMEOUT_SECONDS = 600;

const ATTEMPTS_VAR = 'RECUED_RELEASE_PUBLIC_PROOF_ATTEMPTS';
const DELAY_VAR = 'RECUED_RELEASE_PUBLIC_PROOF_DELAY_MS';
const DEFAULT_ATTEMPTS = 8;
const MAX_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 1_000;
const MAX_DELAY_MS = 10_000;

/** The retry budget. ⛔ A mistyped value is refused, not defaulted: the
 *  publisher reads this before its first upload, so a typo stops the run while
 *  nothing is live instead of changing how long a live release is checked. */
export const publicProofSettings = (env = process.env) => {
  const read = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be a whole number from ${min} to ${max} (got ${JSON.stringify(raw)})`);
    }
    return value;
  };
  return {
    attempts: read(ATTEMPTS_VAR, DEFAULT_ATTEMPTS, 1, MAX_ATTEMPTS),
    delayMs: read(DELAY_VAR, DEFAULT_DELAY_MS, 0, MAX_DELAY_MS),
  };
};

/** Every consumer request the proof makes. `manifestPaths[].channel` is null for
 *  the flat legacy path, which only older servers read, so it has no installer
 *  variant. `file` names the local candidate file the response must equal. */
export const publicProofTargets = ({
  origin,
  manifestPaths,
  artifacts,
  serverUserAgent,
  installerUserAgent,
}) => {
  const targets = [];
  for (const { channel, keyPrefix } of manifestPaths) {
    const variants = [
      { label: 'plain request', headers: [] },
      { label: 'server update check', headers: [`User-Agent: ${serverUserAgent}`] },
      ...(channel === null
        ? []
        : [{ label: 'installer', headers: [`User-Agent: ${installerUserAgent(channel)}`] }]),
    ];
    for (const file of [PUBLIC_PROOF_MANIFEST, PUBLIC_PROOF_MANIFEST_SIG]) {
      for (const variant of variants) {
        targets.push({
          label: `/${keyPrefix}${file} (${variant.label})`,
          url: `${origin}/${keyPrefix}${file}`,
          file,
          headers: variant.headers,
          timeoutSeconds: PUBLIC_PROOF_METADATA_TIMEOUT_SECONDS,
        });
      }
    }
  }
  for (const { basename, url } of artifacts) {
    targets.push({
      label: basename,
      url,
      file: basename,
      headers: [],
      timeoutSeconds: PUBLIC_PROOF_ARTIFACT_TIMEOUT_SECONDS,
    });
    targets.push({
      label: `${basename}.minisig`,
      url: `${url}.minisig`,
      file: `${basename}.minisig`,
      headers: [],
      timeoutSeconds: PUBLIC_PROOF_METADATA_TIMEOUT_SECONDS,
    });
  }
  return targets;
};

/** sha256 in chunks: a server binary is ~150 MB, and the proof holds none of it. */
export const sha256OfFile = (path) => {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
};

/** The real request: the exact URL, streamed to `destination`, redirects followed
 *  as the installers follow them. No `-f`, so an HTTP error still reports its
 *  status code rather than only a curl exit. */
export const curlFetchExact = ({ url, destination, maxBytes, timeoutSeconds, headers }) => {
  rmSync(destination, { force: true });
  const r = spawnSync(
    'curl',
    [
      '-sS', '-L',
      '-m', String(timeoutSeconds),
      '--max-filesize', String(maxBytes),
      '-o', destination,
      '-w', '%{http_code}',
      ...headers.flatMap((header) => ['-H', header]),
      url,
    ],
    { encoding: 'utf8' },
  );
  return {
    status: r.status,
    httpCode: (r.stdout ?? '').trim(),
    detail: `${r.stderr ?? ''}${r.error ? String(r.error.message) : ''}`.trim(),
  };
};

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Fetch every target until it matches or the attempts run out; only the ones
 *  still failing are fetched again. Each target carries `expectedSize` and
 *  `expectedSha256` of its candidate file. Returns the targets that never
 *  matched, each with the reason from its last attempt. */
export const provePublicRelease = ({
  targets,
  attempts,
  delayMs,
  scratchDir,
  fetchExact = curlFetchExact,
  sleep = sleepSync,
}) => {
  let pending = targets;
  let failures = [];
  let attemptsUsed = 0;
  while (pending.length > 0 && attemptsUsed < attempts) {
    attemptsUsed += 1;
    failures = [];
    for (const [index, target] of pending.entries()) {
      const destination = join(scratchDir, `${attemptsUsed}-${index}.public-object`);
      const fetched = fetchExact({
        url: target.url,
        destination,
        maxBytes: target.expectedSize,
        timeoutSeconds: target.timeoutSeconds,
        headers: target.headers,
      });
      let mismatch = '';
      if (fetched.status !== 0) {
        mismatch = `fetch failed${fetched.detail ? `: ${fetched.detail.slice(0, 160)}` : ''}`;
      } else if (!/^2\d\d$/.test(fetched.httpCode)) {
        mismatch = `HTTP ${fetched.httpCode || 'none'}`;
      } else if (!existsSync(destination)) {
        mismatch = 'no response body was written';
      } else {
        const size = statSync(destination).size;
        if (size !== target.expectedSize) {
          mismatch = `${size} bytes, expected ${target.expectedSize}`;
        } else {
          const sha256 = sha256OfFile(destination);
          if (sha256 !== target.expectedSha256) {
            mismatch = `sha256 ${sha256}, expected ${target.expectedSha256}`;
          }
        }
      }
      rmSync(destination, { force: true });
      if (mismatch) failures.push({ target, mismatch });
    }
    pending = failures.map(({ target }) => target);
    if (pending.length > 0 && attemptsUsed < attempts && delayMs > 0) sleep(delayMs);
  }
  return { failures, attemptsUsed };
};
