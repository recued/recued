/** D-178 — the signed release manifest (spec § Release manifest).
 *
 *  ONE static, signed JSON at a stable CDN URL drives the docker + binary
 *  channels. It is the only thing a consumer fetches to decide an update; the
 *  version comparison + rollout eligibility happen LOCALLY (invariants I-1/I-7),
 *  and the whole document is covered by a detached minisign signature (I-2).
 *
 *  This module is the parse + shape boundary only — it validates structure and
 *  surfaces the typed manifest. Signature verification (minisign.ts), anti-replay
 *  / freshness / channel resolution / rollout (resolve, a later slice) layer on
 *  top; a consumer NEVER acts on a manifest it hasn't verified first.
 *
 *  Forward-compat (I-9): unknown fields are ignored; a hard reshape bumps
 *  `schema_version`, which a consumer refuses above its known max.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

/** Build/runtime target triples named in `artifacts`. */
export type Platform =
  | 'linux-x64'
  | 'linux-arm64'
  | 'macos-x64'
  | 'macos-arm64'
  | 'windows-x64'
  | 'windows-arm64';

export const PLATFORMS: readonly Platform[] = [
  'linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64', 'windows-arm64',
];

/** D-178 S1 rev 2 — the artifact key for a triple's native `lib/` sidecar.
 *  Derived from `Platform` rather than declared as its own union, so a new
 *  triple cannot be added with a binary and silently no sidecar slot. */
export type LibKey = `lib-${Platform}`;

/** The sidecar key for a triple. The ONE place the naming lives — the builder,
 *  the resolver, and both installers must agree, and a hand-written
 *  `'lib-' + triple` in any of them is how they would drift apart. */
export const libKeyFor = (platform: Platform): LibKey => `lib-${platform}`;

/** Is this artifact key a native sidecar? Kept beside `libKeyFor` so the
 *  recogniser and the generator cannot disagree. */
export const isLibKey = (key: string): key is LibKey =>
  key.startsWith('lib-') && (PLATFORMS as readonly string[]).includes(key.slice(4));

/** A downloadable binary artifact: URL + checksum + detached minisign sig. The
 *  sig is the integrity boundary; the sha256 is a fast-fail convenience that
 *  travels with the (signed) manifest. */
export interface BinaryArtifact {
  url: string;
  sha256: string;
  sig: string;
}

/** A container artifact — pinned by immutable digest (rev 2: docker pulls live
 *  INSIDE the signature boundary; notify/docs always render `image@sha256:…`). */
export interface DockerArtifact {
  image: string;
  digest: string;
}

export type Artifact = BinaryArtifact | DockerArtifact;

export const isDockerArtifact = (a: Artifact): a is DockerArtifact =>
  typeof (a as DockerArtifact).digest === 'string';

export interface ChannelRelease {
  version: string;
  released_at: string;
  /** Installs older than this get an URGENT notify; never used to brick. */
  min_supported: string;
  /** This release migrates the SQLite schema on boot (rollback rule input). */
  migration: boolean;
  /** Staged rollout, evaluated LOCALLY: eligible iff sha256(salt) % 100 < this. */
  rollout_pct: number;
  notes_url: string;
  artifacts: Partial<Record<Platform, BinaryArtifact>> & Partial<Record<LibKey, BinaryArtifact>> & {
    'docker-baked'?: DockerArtifact;
    'docker-thin'?: DockerArtifact;
    /** D-178 S1 rev 2 — the per-triple NATIVE SIDECAR archive: the externals
     *  the SEA binary cannot embed (`better_sqlite3.node` + `nodemailer` +
     *  `ws` + `imapflow`), packed and signed exactly like the webclient bundle
     *  and unpacked to `lib/` beside the binary.
     *
     *  ⛔ PLATFORM-SPECIFIC, unlike `webclient` — it carries a compiled
     *  `.node`, so there is one per triple and they are NOT interchangeable.
     *
     *  ⚠ An installer that fetches `<triple>` and skips `lib-<triple>` produces
     *  an executable that cannot open its own database. The pairing is a
     *  REQUIREMENT, not an enhancement — see `libKeyFor`. */
    /** D-152 § A.16 / R26.2 Delta 3 — the arch-neutral, version-matched webclient
     *  bundle archive. Shaped like a binary artifact (url + sha256 + detached
     *  minisig); the file it points to is a `webclient-<version>.bundle.json`
     *  (see `webclient-archive.ts`) that the `:managed` self-updater downloads,
     *  verifies, and extracts to `RECUED_WEBCLIENT_DIR` so the embedded webclient
     *  stays in sync across in-place server updates (the baked `:vX.Y.Z` image
     *  bakes its own; this artifact keeps the self-updating channel matched). One
     *  per channel — the webclient PWA is platform-independent. */
    'webclient'?: BinaryArtifact;
  };
}

export type ChannelName = 'stable' | 'edge';

export interface ReleaseManifest {
  schema_version: number;
  /** Monotonic publish counter (one across channels) — the I-10 anti-replay
   *  half; a consumer refuses a sequence ≤ its highest accepted. */
  sequence: number;
  /** Freshness horizon (~14 d) — past it, surface a "stale release feed" notify
   *  rather than "no update". */
  expires_at: string;
  /** A launcher below this stops applying + notifies "recreate from digest"
   *  (I-9 escape hatch for verification-contract breaks). */
  min_launcher_version: number;
  channels: Partial<Record<ChannelName, ChannelRelease>>;
}

export class ManifestError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const reqStr = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v !== 'string' || v.length === 0) throw new ManifestError(`manifest: "${k}" must be a non-empty string`);
  return v;
};
const reqNum = (o: Record<string, unknown>, k: string): number => {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ManifestError(`manifest: "${k}" must be a number`);
  return v;
};

/** A counter field: a non-negative safe INTEGER, not merely "a number".
 *
 *  ⛔ `reqNum` ACCEPTED 200.7, AND EVERY CONSUMER OF THESE TREATS THEM AS
 *  INTEGERS. `sequence` becomes a persisted anti-replay floor and is compared
 *  with `<`; `min_launcher_version` is compared against an integer the launcher
 *  reports; `rollout_pct` indexes a 0–99 bucket. A fraction is not a value any of
 *  them has a meaning for — it is a malformed field that every one of them
 *  silently coerced. Same shape as the `migration` boolean two functions down,
 *  and as the version grammar beside it: the field's TYPE was checked, its
 *  GRAMMAR was not. */
const reqInt = (o: Record<string, unknown>, k: string, max?: number): number => {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || (max !== undefined && v > max)) {
    throw new ManifestError(
      `manifest: "${k}" must be a non-negative integer${max === undefined ? '' : ` no greater than ${max}`}`,
    );
  }
  return v;
};

/** The ONLY shape a manifest timestamp may take — a canonical RFC 3339 instant in
 *  UTC, `YYYY-MM-DDTHH:MM:SS[.mmm]Z`.
 *
 *  ⛔⛔ THE ORIGINAL REASON IS HISTORY NOW, AND THE FIELD IS STILL VALIDATED.
 *  `reqStr` accepted any non-empty string, so `expires_at: "not-a-date"` parsed,
 *  `resolve.ts` got NaN from `Date.parse`, and its `Number.isFinite` guard
 *  SKIPPED the staleness check altogether — a freshness gate failing OPEN on
 *  exactly the input it existed to catch. That was fixed; then the gate itself
 *  was withdrawn (D-260, 2026-09-01), so nothing decides on this value any more.
 *
 *  🔑 SO WHY KEEP IT STRICT. Because a published, signed field that nobody
 *  validates is one that quietly rots: `expires_at` remains reference data on
 *  every manifest, and a future design that wants freshness back should find
 *  well-formed instants there rather than a decade of whatever the pipeline
 *  happened to emit. Validating a value you do not act on is cheap; discovering
 *  it is garbage when you finally need it is not.
 *
 *  ⚠ IT IS NO LONGER A CROSS-CONSUMER CONTRACT. `install.sh` used to compare this
 *  field lexically with `sort`, which made the canonical shape load-bearing in
 *  two places at once. The installer no longer reads it at all. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const reqInstant = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v !== 'string' || !INSTANT.test(v) || !Number.isFinite(Date.parse(v))) {
    throw new ManifestError(
      `manifest: "${k}" must be a canonical RFC 3339 UTC instant (YYYY-MM-DDTHH:MM:SSZ)`,
    );
  }
  return v;
};

/** Validate the KNOWN artifact entries so a parsed manifest can't hand a
 *  consumer a binary artifact missing its detached `sig` (the integrity
 *  boundary, I-2) or a docker artifact missing its pinned `digest` (rev 2).
 *  Unknown keys are left untouched (forward-compat, I-9). */
const validateArtifacts = (raw: Record<string, unknown>, channel: string): ChannelRelease['artifacts'] => {
  const reqEntryStr = (entry: Record<string, unknown>, key: string, field: string): void => {
    const v = entry[field];
    if (typeof v !== 'string' || v.length === 0) {
      throw new ManifestError(`manifest: channel "${channel}" artifact "${key}" missing "${field}"`);
    }
  };
  for (const key of Object.keys(raw)) {
    const entry = raw[key];
    const isBinary = (PLATFORMS as readonly string[]).includes(key);
    const isDocker = key === 'docker-baked' || key === 'docker-thin';
    // The webclient archive is arch-neutral but shaped exactly like a binary
    // artifact (url + sha256 + detached minisig over a signed .bundle.json).
    const isWebclient = key === 'webclient';
    // D-178 S1 rev 2 — the per-triple native sidecar. Same shape as the
    // webclient archive; validated rather than skipped, because a `lib-*` entry
    // missing its `sig` would otherwise fall through the forward-compat
    // `continue` below and reach a consumer as an unverifiable download.
    const isLib = isLibKey(key);
    if (!isBinary && !isDocker && !isWebclient && !isLib) continue; // forward-compat: ignore unknown artifact kinds
    if (!isObj(entry)) throw new ManifestError(`manifest: channel "${channel}" artifact "${key}" must be an object`);
    if (isBinary || isWebclient || isLib) {
      reqEntryStr(entry, key, 'url');
      reqEntryStr(entry, key, 'sha256');
      reqEntryStr(entry, key, 'sig');
    } else {
      reqEntryStr(entry, key, 'image');
      reqEntryStr(entry, key, 'digest');
      const image = (entry as Record<string, unknown>).image as string;
      if (/\s|@|:\/\//.test(image)) {
        throw new ManifestError(
          `manifest: channel "${channel}" artifact "${key}" image must be a registry repository `
            + 'without a scheme, whitespace, or an embedded digest; the signed digest is a separate field',
        );
      }
      // ⛔⛔ A DIGEST IS THE WHOLE POINT OF A DOCKER ARTIFACT, AND "non-empty
      // string" IS NOT A DIGEST. A docker pull here is digest-anchored precisely
      // so the image cannot be swapped under a tag (I-2, rev 2) — and the
      // placeholder `sha256:REPLACE_WITH_REAL_DIGEST` that ships in
      // `release.config.example.json` satisfied a non-empty check exactly as well
      // as a real one. A manifest naming an unpullable image is a channel that
      // fails at apply time, on every server, after the release is irreversible.
      const digest = (entry as Record<string, unknown>).digest as string;
      if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
        throw new ManifestError(
          `manifest: channel "${channel}" artifact "${key}" digest "${digest}" is not a `
            + 'sha256 digest (expected sha256: followed by 64 lowercase hex). A tag is not a '
            + 'pin, and the example config\'s REPLACE_WITH_REAL_DIGEST placeholder passed the '
            + 'old non-empty check.',
        );
      }
    }
  }
  return raw as ChannelRelease['artifacts'];
};

/** The ONLY shape a release version may take: `yy.m.d` or a same-day hotfix
 *  `yy.m.d.n`. Exactly three or four numeric segments, no leading zeros, and a
 *  fourth segment that is a POSITIVE ordinal.
 *
 *  ⛔⛔ THE COMPARATOR CANNOT BE THE GRAMMAR, AND FOR ONE RELEASE IT WAS THE ONLY
 *  CHECK. `compareVersions` slices to four segments and `parseInt`s each, so
 *  every malformed version quietly became a NUMBER instead of an error. Measured
 *  against the version they should have been distinguishable from:
 *
 *    26.9.1.0     == 26.9.1    (a zero ordinal is not an ordinal)
 *    26.9.1.dev   == 26.9.1    (parseInt('dev') → NaN → coerced to 0)
 *    26.9.1.1.1   == 26.9.1.1  (the fifth segment is sliced off, not rejected)
 *    26.9.1-rc.1   > 26.9.1    (parseInt('1-rc') → 1; the ordinal then wins)
 *
 *  Each of the first three would SILENTLY HIDE a release — the same failure D-258
 *  exists to prevent, arriving through the parser instead of the comparator. The
 *  last is worse: a prerelease sorts ABOVE the final release it precedes, so
 *  `26.9.1-rc.1` would be installed over `26.9.1`.
 *
 *  🔑 A version scheme is a GRAMMAR plus an ordering. D-258 shipped the ordering
 *  and left `reqStr` — "a non-empty string" — as the grammar. */
/** ⛔ SEGMENTS ARE BOUNDED TO 9 DIGITS, AND THE BOUND IS THE POINT.
 *  An unbounded `\d*` is only orderable in a runtime with unbounded integers,
 *  and not one of the three that compare these strings has them:
 *
 *    JS       `parseInt` → a double. `26.9.1.9007199254740992` and `…993` are
 *             both valid and compare EQUAL (past 2^53 the doubles collide), and
 *             a 400-digit ordinal parses to `Infinity`, so `Infinity - Infinity`
 *             is `NaN`, `!== 0` is false, and it compares EQUAL to `26.9.1`.
 *    PowerShell  `[int]::TryParse` is signed 32-bit; anything larger fails to
 *             parse and silently reads as 0.
 *    POSIX sh  platform integer arithmetic, typically 64-bit, undefined beyond.
 *
 *  Measured, all three above. ⇒ the GRAMMAR bounds the domain so every runtime
 *  that compares agrees, rather than each clamping differently. 9 digits keeps
 *  every segment below 2^31 (so int32 is safe) and exactly representable as a
 *  double (so JS is exact) — and a calendar version needs 2. */
export const MAX_VERSION_SEGMENT_DIGITS = 9;

export const RELEASE_VERSION_RE = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:\.[1-9]\d{0,8})?$/;

/** Is this a well-formed release version? */
export const isValidReleaseVersion = (v: string): boolean => RELEASE_VERSION_RE.test(v);

/** Read a version-shaped field, rejecting anything the comparator would silently
 *  coerce. Applied to BOTH `version` and `min_supported`: a malformed floor is a
 *  malformed gate, and `min_supported` decides who is locked out of updating. */
const reqVersion = (o: Record<string, unknown>, k: string, channel: string): string => {
  const v = reqStr(o, k);
  if (!isValidReleaseVersion(v)) {
    throw new ManifestError(
      `manifest: channel "${channel}" ${k} "${v}" is not a release version — expected `
        + 'yy.m.d or a same-day hotfix yy.m.d.n (3 or 4 numeric segments, no leading '
        + 'zeros, positive ordinal). The comparator would coerce this to a number '
        + 'rather than refuse it, and silently mis-order the release.',
    );
  }
  return v;
};

const parseChannel = (raw: unknown, name: string): ChannelRelease => {
  if (!isObj(raw)) throw new ManifestError(`manifest: channel "${name}" must be an object`);
  const rollout = reqInt(raw, 'rollout_pct', 100);
  if (!isObj(raw.artifacts)) throw new ManifestError(`manifest: channel "${name}" missing artifacts`);
  // `migration` drives the rollback/snapshot rule — a malformed value must not
  // silently read as "no migration"; require an explicit boolean.
  if (typeof raw.migration !== 'boolean') throw new ManifestError(`manifest: channel "${name}" "migration" must be a boolean`);
  return {
    version: reqVersion(raw, 'version', name),
    // ⚠ DELIBERATELY NOT `reqInstant`, AND THE ASYMMETRY IS THE POINT. `expires_at`
    // is a GATE: a malformed one turned the freshness check off, so strictness
    // there protects. `released_at` is DISPLAY — nothing parses it — so refusing a
    // signed feed over its shape would take the whole release out of reach to fix
    // a cosmetic string. Fail closed where it protects; not where it only breaks.
    // ⇒ If anything ever starts PARSING this, tighten it here first.
    released_at: reqStr(raw, 'released_at'),
    min_supported: reqVersion(raw, 'min_supported', name),
    migration: raw.migration,
    rollout_pct: rollout,
    notes_url: typeof raw.notes_url === 'string' ? raw.notes_url : '',
    artifacts: validateArtifacts(raw.artifacts, name),
  };
};

/** Parse + structurally validate a manifest JSON string. Throws `ManifestError`
 *  on a malformed document or an unknown (too-new) `schema_version`. Unknown
 *  fields are ignored (forward-compat, I-9). */
export const parseManifest = (json: string): ReleaseManifest => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ManifestError('manifest: invalid JSON');
  }
  if (!isObj(raw)) throw new ManifestError('manifest: root must be an object');

  // ⛔ `schema_version` IS A COUNTER TOO, AND IT WAS THE ONE LEFT ON `reqNum`.
  // `sequence`, `min_launcher_version` and `rollout_pct` were tightened to
  // `reqInt` on the rule that every consumer treats them as integers — this field
  // is compared with `>` against an integer constant and is exactly the same
  // kind, but kept the looser check. Measured: `schema_version: 0.5` and `-1`
  // both PARSED as a supported schema, and the parser then walked the document
  // field-by-field on the assumption the shape held.
  //
  // 🔑 AND IT MADE THE SHELL STRICTER THAN THE CANONICAL PARSER. `install.sh`
  // already refuses a non-digit `schema_version` outright ("no usable
  // schema_version — refusing"), so a manifest existed that the installer
  // rejected and `parseManifest` accepted. That divergence is the thing the
  // freshness work above exists to prevent; it just pointed the other way.
  const schemaVersion = reqInt(raw, 'schema_version');
  if (schemaVersion > MANIFEST_SCHEMA_VERSION) {
    throw new ManifestError(`manifest: schema_version ${schemaVersion} is newer than supported (${MANIFEST_SCHEMA_VERSION})`);
  }
  if (!isObj(raw.channels)) throw new ManifestError('manifest: "channels" must be an object');

  const channels: ReleaseManifest['channels'] = {};
  for (const name of ['stable', 'edge'] as const) {
    if (raw.channels[name] !== undefined) channels[name] = parseChannel(raw.channels[name], name);
  }
  if (!channels.stable && !channels.edge) throw new ManifestError('manifest: no known channels present');

  return {
    schema_version: schemaVersion,
    sequence: reqInt(raw, 'sequence'),
    expires_at: reqInstant(raw, 'expires_at'),
    min_launcher_version: reqInt(raw, 'min_launcher_version'),
    channels,
  };
};
