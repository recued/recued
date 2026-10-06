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
 * consumer-facing object is requested from the public origin the way consumers
 * request it (no query string, no cache-bypass header):
 *   · each manifest pair path (every channel, plus the flat legacy path) is
 *     downloaded and byte-compared, as a plain request, as a server update check,
 *     and on a channel path as an installer. These are the only objects that
 *     change in place, so the only ones a stale cache can serve; they are a few
 *     KB. The User-Agent is part of the request that a cache key or a rule can
 *     depend on, so each family is sampled with a value the fleet really sends
 *     (`updateCheckUserAgent` in src/update/release-config.ts, and
 *     `recued-install/1 (<triple>; <channel>)` in both installers).
 *   · each hosted artifact and its detached signature is proven by a HEAD, as a
 *     plain request (the installers' own downloads carry no User-Agent): the
 *     exact Content-Length, and an ETag equal to the candidate file's MD5. R2
 *     computes that MD5 over every byte of a single-part upload, and the CDN
 *     serves the ETag of whatever it holds, so this proves the whole content —
 *     measured on 26.9.30's real objects, 146 MB binaries included — without
 *     downloading ~830 MB. An ETag that is not a plain MD5 (a multipart upload's
 *     `<hash>-<parts>`, a weak W/ one, none at all) proves nothing, so that
 *     object alone is downloaded and compared instead.
 * A mismatch is retried, because the edge converges, and then fails the publish.
 *
 * ⚠ A SAMPLE, NOT A CENSUS. A cache keyed on the User-Agent holds one entry per
 * value, and servers send one per version, platform and distribution. The proof
 * catches a stale or misrouted variant of the kind the fleet requests; it
 * cannot enumerate every one.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const PUBLIC_PROOF_MANIFEST = 'manifest.json';
export const PUBLIC_PROOF_MANIFEST_SIG = 'manifest.json.minisig';
/** Metadata and HEADs are tiny; a full artifact download (the ETag fallback) is
 *  bounded like the installers' own download. */
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
          method: 'get',
          headers: variant.headers,
          timeoutSeconds: PUBLIC_PROOF_METADATA_TIMEOUT_SECONDS,
        });
      }
    }
  }
  for (const { basename, url } of artifacts) {
    for (const [file, fileUrl] of [[basename, url], [`${basename}.minisig`, `${url}.minisig`]]) {
      targets.push({
        label: file,
        url: fileUrl,
        file,
        method: 'head',
        headers: [],
        timeoutSeconds: PUBLIC_PROOF_METADATA_TIMEOUT_SECONDS,
        fallbackTimeoutSeconds: PUBLIC_PROOF_ARTIFACT_TIMEOUT_SECONDS,
      });
    }
  }
  return targets;
};

/** A digest in chunks: a server binary is ~150 MB, and nothing here holds it. */
const digestOfFile = (algorithm, path) => {
  const hash = createHash(algorithm);
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
export const sha256OfFile = (path) => digestOfFile('sha256', path);
/** What R2 reports as a single-part upload's ETag. */
export const md5OfFile = (path) => digestOfFile('md5', path);

/** The MD5 an ETag carries, or null when it carries none. A multipart upload's
 *  ETag is `<hash>-<parts>`, and a weak one (`W/"…"`) describes a transformed
 *  response, so neither says anything about these bytes. */
export const etagMd5 = (etag) => {
  const m = /^"?([0-9a-f]{32})"?$/i.exec(String(etag ?? '').trim());
  return m ? m[1].toLowerCase() : null;
};

/** Run a command without blocking the event loop, so requests can overlap. */
const runAsync = (command, args) => new Promise((settle) => {
  let settled = false;
  const done = (result) => { if (!settled) { settled = true; settle(result); } };
  const child = spawn(command, args);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => done({ status: null, stdout, stderr, error }));
  child.on('close', (status) => done({ status, stdout, stderr }));
});

/** `fn` over `items`, at most `limit` at a time, results in order.
 *
 *  ⛔ WHY CONCURRENT. A check is one `curl` process, and each pays a fresh TLS
 *  handshake: measured 0.9–1.5 s of a ~1.5 s request on 2026-09-30, against 3 ms
 *  to connect. One at a time, 42 proof requests took 68 s; the requests do not
 *  depend on each other. */
export const mapWithConcurrency = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
};

/** The real request: the exact URL, streamed to `destination`, redirects followed
 *  as the installers follow them. No `-f`, so an HTTP error still reports its
 *  status code rather than only a curl exit. */
export const curlFetchExact = async ({ url, destination, maxBytes, timeoutSeconds, headers }) => {
  rmSync(destination, { force: true });
  const r = await runAsync(
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
  );
  return {
    status: r.status,
    httpCode: (r.stdout ?? '').trim(),
    detail: `${r.stderr ?? ''}${r.error ? String(r.error.message) : ''}`.trim(),
  };
};

/** The real HEAD. Redirects are followed as the installers follow them, and with
 *  `-L` every hop prints a header block, so the LAST block is the response that
 *  counts. */
export const curlHeadExact = async ({ url, timeoutSeconds, headers }) => {
  const r = await runAsync(
    'curl',
    ['-sS', '-I', '-L', '-m', String(timeoutSeconds), ...headers.flatMap((header) => ['-H', header]), url],
  );
  const blocks = (r.stdout ?? '').split(/\r?\n\r?\n/).map((block) => block.trim())
    .filter((block) => /^HTTP\//.test(block));
  const lines = (blocks.at(-1) ?? '').split(/\r?\n/);
  const field = (name) => {
    const line = lines.find((candidate) => candidate.toLowerCase().startsWith(`${name}:`));
    return line === undefined ? null : line.slice(name.length + 1).trim();
  };
  const length = field('content-length');
  return {
    status: r.status,
    httpCode: /^HTTP\/\S+\s+(\d{3})/.exec(lines[0] ?? '')?.[1] ?? '',
    contentLength: length === null || !/^\d+$/.test(length) ? null : Number(length),
    etag: field('etag'),
    detail: `${r.stderr ?? ''}${r.error ? String(r.error.message) : ''}`.trim(),
  };
};

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Check every target until it matches or the attempts run out; only the ones
 *  still failing are checked again. Each target carries `expectedSize`,
 *  `expectedSha256` and, for a HEAD target, `expectedMd5` of its candidate
 *  file. Returns the targets that never matched, each with the reason from its
 *  last attempt, and how many HEAD targets had to be downloaded instead. */
export const provePublicRelease = async ({
  targets,
  attempts,
  delayMs,
  scratchDir,
  fetchExact = curlFetchExact,
  headExact = curlHeadExact,
  sleep = sleepSync,
  concurrency = 8,
}) => {
  let fullDownloads = 0;
  /** Download the object and compare every byte: a GET target always, a HEAD
   *  target only when its ETag cannot prove the content. */
  const byDownload = async (target, destination, timeoutSeconds) => {
    const fetched = await fetchExact({
      url: target.url,
      destination,
      maxBytes: target.expectedSize,
      timeoutSeconds,
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
    return mismatch;
  };
  const byHead = async (target, destination) => {
    const head = await headExact({ url: target.url, timeoutSeconds: target.timeoutSeconds, headers: target.headers });
    if (head.status !== 0) {
      return `fetch failed${head.detail ? `: ${head.detail.slice(0, 160)}` : ''}`;
    }
    if (!/^2\d\d$/.test(head.httpCode)) return `HTTP ${head.httpCode || 'none'}`;
    if (head.contentLength !== null && head.contentLength !== target.expectedSize) {
      return `${head.contentLength} bytes, expected ${target.expectedSize}`;
    }
    const md5 = etagMd5(head.etag);
    if (head.contentLength === null || md5 === null) {
      // No length, or an ETag that is not a plain MD5: the headers prove
      // nothing, so this object alone is downloaded and compared.
      fullDownloads += 1;
      return await byDownload(target, destination, target.fallbackTimeoutSeconds ?? target.timeoutSeconds);
    }
    return md5 === target.expectedMd5 ? '' : `etag ${md5}, expected md5 ${target.expectedMd5}`;
  };

  let pending = targets;
  let failures = [];
  let attemptsUsed = 0;
  while (pending.length > 0 && attemptsUsed < attempts) {
    attemptsUsed += 1;
    const round = attemptsUsed;
    const mismatches = await mapWithConcurrency(pending, concurrency, (target, index) => {
      const destination = join(scratchDir, `${round}-${index}.public-object`);
      return target.method === 'head'
        ? byHead(target, destination)
        : byDownload(target, destination, target.timeoutSeconds);
    });
    failures = pending.map((target, index) => ({ target, mismatch: mismatches[index] }))
      .filter(({ mismatch }) => mismatch);
    pending = failures.map(({ target }) => target);
    if (pending.length > 0 && attemptsUsed < attempts && delayMs > 0) sleep(delayMs);
  }
  return { failures, attemptsUsed, fullDownloads };
};
