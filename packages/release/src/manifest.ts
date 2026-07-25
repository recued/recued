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
  artifacts: Partial<Record<Platform, BinaryArtifact>> & {
    'docker-baked'?: DockerArtifact;
    'docker-thin'?: DockerArtifact;
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
    if (!isBinary && !isDocker && !isWebclient) continue; // forward-compat: ignore unknown artifact kinds
    if (!isObj(entry)) throw new ManifestError(`manifest: channel "${channel}" artifact "${key}" must be an object`);
    if (isBinary || isWebclient) {
      reqEntryStr(entry, key, 'url');
      reqEntryStr(entry, key, 'sha256');
      reqEntryStr(entry, key, 'sig');
    } else {
      reqEntryStr(entry, key, 'image');
      reqEntryStr(entry, key, 'digest');
    }
  }
  return raw as ChannelRelease['artifacts'];
};

const parseChannel = (raw: unknown, name: string): ChannelRelease => {
  if (!isObj(raw)) throw new ManifestError(`manifest: channel "${name}" must be an object`);
  const rollout = reqNum(raw, 'rollout_pct');
  if (rollout < 0 || rollout > 100) throw new ManifestError(`manifest: channel "${name}" rollout_pct out of range`);
  if (!isObj(raw.artifacts)) throw new ManifestError(`manifest: channel "${name}" missing artifacts`);
  // `migration` drives the rollback/snapshot rule — a malformed value must not
  // silently read as "no migration"; require an explicit boolean.
  if (typeof raw.migration !== 'boolean') throw new ManifestError(`manifest: channel "${name}" "migration" must be a boolean`);
  return {
    version: reqStr(raw, 'version'),
    released_at: reqStr(raw, 'released_at'),
    min_supported: reqStr(raw, 'min_supported'),
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

  const schemaVersion = reqNum(raw, 'schema_version');
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
    sequence: reqNum(raw, 'sequence'),
    expires_at: reqStr(raw, 'expires_at'),
    min_launcher_version: reqNum(raw, 'min_launcher_version'),
    channels,
  };
};
