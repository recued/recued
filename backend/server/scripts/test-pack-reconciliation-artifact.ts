#!/usr/bin/env -S npx tsx
/**
 * D-259 packaged-artifact boot rehearsal.
 *
 * This is deliberately not a source-level integration test. It checks out one
 * exact source commit, installs its locked dependencies, builds + packs the npm
 * server, extracts that tarball into a deployment-shaped directory with no
 * `community/`, and boots `dist/bin.js` from there.
 *
 * The realm is the one a launch-era owner has: all four historical v1 packs
 * installed. Three of them are in the D-259 ledger; codex-pack left it at v5.
 *
 * Three arms prove the launch boundary:
 *   1. HTTP serve: the three ledger packs are on their reviewed target by the
 *      first accepted /health response, codex-pack is left exactly as installed
 *      and named to the owner, authority rows on both survive byte-for-byte,
 *      and a second boot is a quiet no-op.
 *   2. stdio MCP: an initialize/tools-list exchange queued at process spawn is
 *      answered only after the same three migrations are durable.
 *   3. held source: an unreviewed v1 body of a ledger pack is not overwritten,
 *      HTTP still comes up, and the owner is notified with a Packs deep link.
 *
 * Run from the repository root under Node 24:
 *   npm run test:pack-reconciliation-artifact -- --source HEAD
 */

import assert from 'node:assert/strict';
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import {
  D165_CONTRACT_SCHEMA,
  normalizeBulkPackInstallPlan,
  parseBulkPackManifest,
  type BulkPackManifest,
  type CompositionIngredient,
  type EntitySchemaIngredientInput,
  type IngredientManifest,
} from '@recued/contracts';
import { decomposeComposition } from '@recued/ingredient-authoring';

import { bootServerIdentity } from '../src/identity/boot.js';
import { createLocalManifestStore } from '../src/ingredient-authoring/local-manifest-store.js';
import { recordPackInventory } from '../src/pack-inventory.js';
import { createConnectionCatalogBindingStore } from '../src/storage/connection-catalog-binding-store.js';
import { createContractGrantEntryStore } from '../src/storage/contract-grant-entry-store.js';
import { createContractGrantStore } from '../src/storage/contract-grant-store.js';
import { createContractStore, type ContractRow } from '../src/storage/contract-store.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..', '..');

/** The parent of `8917a62b3` (Implement D-259 execution semantics). These are
 * the exact v1 files an already-installed launch realm could have persisted. */
const HISTORICAL_V1_SOURCE = 'a468cc3b554b0d5cc75ed314085a065ecbaf1fed';

/** The packs the D-259 ledger repairs at boot. Each must land on its reviewed
 *  target before the first request is answered.
 *
 *  ⛔ MEMBERSHIP IS A COPY TOO. codex-pack left the ledger at v5 (`1815a8944`)
 *  and stayed listed here, so the 26.10.8 cut failed on `codex-pack candidate
 *  target version 6 !== 3`. `assertLedgerMembership` now compares this list
 *  with the candidate's embedded targets before anything is built. */
const LEDGER_PACKS = ['yt-dlp', 'cloudflared', 'ollama'] as const;
/** Installed at launch, outside the ledger now. The boot must leave each exactly
 *  as installed and name it to the owner: its update needs the reviewed install
 *  dialog, never a silent rewrite. */
const OUT_OF_LEDGER_PACKS = ['codex-pack'] as const;
const PACKS = [...LEDGER_PACKS, ...OUT_OF_LEDGER_PACKS] as const;
type PackSlug = (typeof PACKS)[number];

const isLedgerPack = (slug: PackSlug): boolean =>
  (LEDGER_PACKS as readonly string[]).includes(slug);

const CATALOG_SLUG: Readonly<Record<PackSlug, string>> = {
  'codex-pack': 'codex',
  'yt-dlp': 'yt-dlp',
  cloudflared: 'cloudflared',
  ollama: 'ollama',
};

/** Owner choices a normal reinstall would replace or clear. They sit on a pack
 *  the ledger MIGRATES (the apply path must preserve them) and on the pack it
 *  must not touch at all. The group and operation names are the v1 bodies'. */
interface OwnerAuthority {
  pack: PackSlug;
  catalog: string;
  connection: string;
  group: string;
  operation: string;
}

const AUDIENCE_CONTRACT = 'ct_artifact_rehearsal';
const OWNER_AUTHORITY: readonly OwnerAuthority[] = [
  {
    pack: 'yt-dlp',
    catalog: 'yt-dlp',
    connection: 'artifact-owner-picked-media-account',
    group: 'yt-dlp.media.write',
    operation: 'recued-core/yt-dlp.media.download',
  },
  {
    pack: 'codex-pack',
    catalog: 'codex',
    connection: 'artifact-owner-picked-account',
    group: 'codex.codex.write',
    operation: 'recued-core/codex.codex.review',
  },
];

interface AuthorityKey {
  scope: string;
  segments: readonly string[];
}

const authorityKeys = (fixtures: readonly { slug: PackSlug }[]): AuthorityKey[] =>
  OWNER_AUTHORITY
    .filter((owner) => fixtures.some((fixture) => fixture.slug === owner.pack))
    .flatMap((owner) => [
      { scope: 'grant', segments: [owner.pack, owner.catalog, owner.connection, owner.group] },
      { scope: 'connection_catalog_binding', segments: [owner.connection] },
      { scope: 'contract_grant', segments: [AUDIENCE_CONTRACT, owner.operation] },
    ]);

/** ⚠ RETIRED BY D-259, AND KEPT SO ITS ABSENCE CAN BE ASSERTED. The ask this
 *  named no longer exists; arm 3 proves no row is minted rather than merely not
 *  looking for one. */
const ASK_KIND = 'packs.unrunnable.ping';
/** Title of the notification that replaced it. */
const NOTICE_TITLE = 'Packs need updating';
/** The ledger pack arm 3 holds. */
const HELD_PACK: PackSlug = 'yt-dlp';
const PACK_DETAIL_LINK = `https://home.example.net/#packs/${HELD_PACK}`;
const DEFAULT_TIMEOUT_MS = 90_000;

const say = (message: string): void => console.log(`[pack-artifact] ${message}`);
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
};

/** Match the local-manifest store's JSON persistence boundary: optional object
 * keys whose value is `undefined` do not survive the durable representation. */
const persistedClone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

const argValue = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
};

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

const runLive = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): void => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}`);
  }
};

interface DecomposedFixture {
  manifest: IngredientManifest;
  entitySchemas: EntitySchemaIngredientInput[];
}

interface PackFixture {
  slug: PackSlug;
  catalogSlug: string;
  legacy: DecomposedFixture;
  /** The reviewed body a ledger pack must land on; null for a pack outside the
   *  ledger, which must keep its legacy body. */
  target: DecomposedFixture | null;
}

const isComposition = (value: unknown): value is CompositionIngredient => {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.schema_version)
    && typeof value.slug === 'string'
    && Array.isArray(value.ingredients)
    && Array.isArray(value.operations);
};

const decompose = (
  composition: CompositionIngredient,
  label: string,
): DecomposedFixture => {
  const lower = decomposeComposition[composition.schema_version];
  if (lower === undefined) {
    throw new Error(`${label} uses unsupported composition schema ${composition.schema_version}`);
  }
  const artifacts = lower(composition);
  const manifest = artifacts.catalog ?? artifacts.ingredient;
  if (manifest === undefined) throw new Error(`${label} decomposed to no manifest`);
  return {
    manifest: persistedClone(manifest),
    entitySchemas: persistedClone(artifacts.entity_schemas ?? []),
  };
};

const compositionFromHistoricalPack = (slug: PackSlug): CompositionIngredient => {
  let raw: unknown;
  try {
    raw = JSON.parse(execFileSync(
      'git',
      ['show', `${HISTORICAL_V1_SOURCE}:community/packs/${slug}.json`],
      { cwd: repoRoot, encoding: 'utf8' },
    ));
  } catch (error) {
    throw new Error(
      `cannot read the pinned D-259 v1 fixture for ${slug}; this checkout needs commit `
        + `${HISTORICAL_V1_SOURCE} in its git history`,
      { cause: error },
    );
  }
  const pack = record(raw, `${slug} historical pack`);
  assert.equal(pack.slug, slug, `${slug} historical fixture slug`);
  assert.equal(pack.version, 1, `${slug} historical fixture version`);
  assert.ok(Array.isArray(pack.contents), `${slug} historical fixture contents`);
  const content = pack.contents.find((candidate) =>
    isRecord(candidate) && candidate.type === 'composition'
  );
  const composition = isRecord(content) ? content.composition : undefined;
  if (!isComposition(composition)) {
    throw new Error(`${slug} historical fixture has no usable composition`);
  }
  return composition;
};

/** The approved target version for every D-259 launch-safe recovery pack.
 *
 *  ⛔ THIS IS A SECOND COPY OF `to_version` IN `src/pack-reconciliation.ts`, and
 *  it went stale exactly the way a second copy does: D-259 moved the ledger to 3
 *  (`from_version: 1` became `from_versions: [1, 2]`), all four packs were
 *  republished at 3, and this literal stayed at 2 — through 62 commits and a
 *  green suite, because this harness is a RELEASE GATE and vitest never runs it.
 *  The ledger's own invariants are covered by `d-259-pack-reconciliation.test.ts`;
 *  what has no test is this file agreeing with them.
 *
 *  ⚠ It cannot import the ledger: `LAUNCH_SAFE_PACK_TRANSITIONS` is deliberately
 *  module-private ("adding an entry is a security decision"), and widening that
 *  to serve a harness trades a real boundary for a convenience. So it stays a
 *  literal — named, in one place, next to the reason it must track. When the
 *  ledger's `to_version` moves, move this with it. */
const LAUNCH_SAFE_TARGET_VERSION = 3;

const loadTargetPack = (worktree: string, slug: PackSlug): BulkPackManifest => {
  const path = join(worktree, 'community', 'packs', `${slug}.json`);
  const parsed = parseBulkPackManifest(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (!parsed.ok) throw new Error(`${slug} candidate target does not validate`);
  assert.equal(parsed.manifest.slug, slug, `${slug} candidate target slug`);
  assert.equal(
    parsed.manifest.version,
    LAUNCH_SAFE_TARGET_VERSION,
    `${slug} candidate target version`,
  );
  return parsed.manifest;
};

const compositionFromTarget = (pack: BulkPackManifest): CompositionIngredient => {
  const content = normalizeBulkPackInstallPlan(pack).contents.find(
    (candidate) => candidate.type === 'composition',
  );
  if (content?.type !== 'composition') {
    throw new Error(`${pack.slug} candidate target is not a composition pack`);
  }
  return content.composition;
};

const loadFixtures = (worktree: string): PackFixture[] => PACKS.map((slug) => ({
  slug,
  catalogSlug: CATALOG_SLUG[slug],
  legacy: decompose(compositionFromHistoricalPack(slug), `${slug} v1`),
  target: isLedgerPack(slug)
    ? decompose(
      compositionFromTarget(loadTargetPack(worktree, slug)),
      `${slug} v${LAUNCH_SAFE_TARGET_VERSION}`,
    )
    : null,
}));

/** Fail before the build, and say which list to change, when this rehearsal and
 *  the candidate disagree about who is in the ledger. The candidate's embedded
 *  target set is what its packaged server can repair without `community/`. */
const assertLedgerMembership = async (worktree: string): Promise<void> => {
  const generator = join(
    worktree,
    'backend',
    'server',
    'scripts',
    'gen-bundled-pack-reconciliation.mjs',
  );
  const loaded = record(
    await import(pathToFileURL(generator).href) as unknown,
    'candidate reconciliation target generator',
  );
  const slugs = loaded.PACK_RECONCILIATION_TARGET_SLUGS;
  if (!Array.isArray(slugs) || !slugs.every((slug) => typeof slug === 'string')) {
    throw new Error(`${generator} no longer exports PACK_RECONCILIATION_TARGET_SLUGS`);
  }
  const candidate = [...slugs].sort();
  const expected = [...LEDGER_PACKS].sort();
  assert.deepEqual(
    candidate,
    expected,
    `the candidate repairs ${candidate.join(', ')} at boot; this rehearsal expects `
      + `${expected.join(', ')}. Move a pack that left the ledger to OUT_OF_LEDGER_PACKS, `
      + 'and give a pack that joined it a v1 fixture in LEDGER_PACKS.',
  );
};

interface NpmPackResult {
  filename: string;
  files: Array<{ path: string; mode?: number }>;
}

interface ArtifactLayout {
  packageRoot: string;
  binPath: string;
}

const buildPackedArtifact = (worktree: string, tempRoot: string): ArtifactLayout => {
  const installEnv = { ...process.env, HUSKY: '0' };
  say('installing the candidate lockfile in the detached checkout');
  runLive('npm', ['ci', '--no-audit', '--no-fund'], { cwd: worktree, env: installEnv });

  say('building the candidate production server bundle');
  const serverRoot = join(worktree, 'backend', 'server');
  runLive(process.execPath, ['scripts/build.mjs'], { cwd: serverRoot, env: installEnv });

  const status = gitStatus(worktree);
  assert.equal(status, '', `candidate checkout became dirty:\n${status}`);

  const packedDir = join(tempRoot, 'packed');
  const extractedDir = join(tempRoot, 'extracted');
  mkdirSync(packedDir, { recursive: true });
  mkdirSync(extractedDir, { recursive: true });
  const output = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', `--pack-destination=${packedDir}`],
    { cwd: serverRoot, env: installEnv, encoding: 'utf8' },
  );
  const results: unknown = JSON.parse(output);
  assert.ok(Array.isArray(results) && results.length === 1, 'npm pack returned one artifact');
  const packed = record(results[0], 'npm pack result');
  const filename = packed.filename;
  if (typeof filename !== 'string') throw new Error('npm pack filename is not a string');
  assert.ok(Array.isArray(packed.files), 'npm pack file inventory');
  const packResult: NpmPackResult = {
    filename,
    files: packed.files.map((entry, index) => {
      const item = record(entry, `npm pack file ${index}`);
      const path = item.path;
      if (typeof path !== 'string') throw new Error(`npm pack file ${index} path is not a string`);
      return {
        path,
        ...(typeof item.mode === 'number' ? { mode: item.mode } : {}),
      };
    }),
  };
  const packedPaths = packResult.files.map((entry) => entry.path.replaceAll('\\', '/'));
  assert.ok(packedPaths.includes('dist/bin.js'), 'tarball contains dist/bin.js');
  assert.equal(
    packedPaths.some((path) => path === 'community' || path.startsWith('community/')),
    false,
    'tarball must omit community/',
  );
  assert.equal(
    packedPaths.some((path) => path === 'src' || path.startsWith('src/')),
    false,
    'tarball must omit server source',
  );

  runLive('tar', [
    '-xzf',
    join(packedDir, packResult.filename),
    '-C',
    extractedDir,
  ], { cwd: tempRoot });
  const extractedPackageRoot = join(extractedDir, 'package');
  const extractedBin = join(extractedPackageRoot, 'dist', 'bin.js');
  assert.ok(existsSync(extractedBin), 'extracted artifact contains dist/bin.js');
  assert.ok((statSync(extractedBin).mode & 0o111) !== 0, 'extracted dist/bin.js is executable');
  assert.equal(
    existsSync(join(extractedPackageRoot, 'community')),
    false,
    'extracted artifact has no community/',
  );
  assert.equal(
    existsSync(join(extractedPackageRoot, 'src')),
    false,
    'extracted artifact has no src/',
  );

  // Install the tarball AS A DEPENDENCY in an empty deployment root. Installing
  // inside the extracted package would make its workspace-only devDependencies
  // roots, while borrowing the candidate checkout's whole node_modules would
  // let an accidentally-unbundled @recued/* import work even though consumers
  // never receive it. This shape admits only dependencies the tarball declares.
  const deploymentDir = join(tempRoot, 'deployment');
  mkdirSync(deploymentDir, { recursive: true });
  say('installing the tarball into an empty production dependency tree');
  runLive('npm', [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    join(packedDir, packResult.filename),
  ], { cwd: deploymentDir, env: installEnv });
  const packageRoot = join(deploymentDir, 'node_modules', '@recued', 'server');
  const binPath = join(packageRoot, 'dist', 'bin.js');
  assert.ok(existsSync(binPath), 'installed artifact contains dist/bin.js');
  assert.ok((statSync(binPath).mode & 0o111) !== 0, 'installed dist/bin.js is executable');
  assert.equal(existsSync(join(packageRoot, 'community')), false, 'installed artifact has no community/');
  assert.equal(existsSync(join(packageRoot, 'src')), false, 'installed artifact has no src/');
  assert.deepEqual(
    readdirSync(join(deploymentDir, 'node_modules', '@recued')).sort(),
    ['server'],
    'production dependency tree must not supply bundled @recued/* workspaces',
  );
  say(`packed artifact ready (${packResult.filename}; clean production install; community/ absent)`);
  return { packageRoot, binPath };
};

const gitStatus = (worktree: string): string => execFileSync(
  'git',
  ['status', '--porcelain=v1', '--untracked-files=all'],
  { cwd: worktree, encoding: 'utf8' },
).trim();

interface PackState {
  slug: PackSlug;
  catalogSlug: string;
  inventory: ContractRow | null;
  ingredient: ContractRow | null;
  manifest: IngredientManifest | null;
  entitySchemas: EntitySchemaIngredientInput[];
}

interface AuthorityState extends AuthorityKey {
  row: ContractRow | null;
}

interface RealmState {
  packs: PackState[];
  authority: AuthorityState[];
}

const inspectRealm = (dbPath: string, fixtures: readonly PackFixture[]): RealmState => {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  try {
    const contracts = createContractStore(db);
    const local = createLocalManifestStore(db);
    return {
      packs: fixtures.map(({ slug, catalogSlug }) => ({
        slug,
        catalogSlug,
        inventory: contracts.get('installed_pack', [slug]),
        ingredient: contracts.get('installed_ingredient', [catalogSlug]),
        manifest: local.getManifest(catalogSlug),
        entitySchemas: local.getEntitySchemas(catalogSlug),
      })),
      authority: authorityKeys(fixtures).map(({ scope, segments }) => ({
        scope,
        segments,
        row: contracts.get(scope, segments),
      })),
    };
  } finally {
    db.close();
  }
};

const seedRealm = async (
  dbPath: string,
  fixtures: readonly PackFixture[],
  mutate?: (slug: PackSlug, manifest: IngredientManifest) => IngredientManifest,
): Promise<RealmState> => {
  mkdirSync(dirname(dbPath), { recursive: true });
  // Production opts into machine sealing only for a NEW keyfile. Pre-creating a
  // valid unsealed first-boot keyfile keeps this disposable rehearsal hermetic:
  // it cannot leave an entry in the developer's OS keychain.
  await bootServerIdentity({ dbPath, passphrase: null, env: {} });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  try {
    const contracts = createContractStore(db, { now: () => 7 });
    contracts.seedSchema(D165_CONTRACT_SCHEMA);
    const local = createLocalManifestStore(db);
    for (const fixture of fixtures) {
      const installed = mutate
        ? mutate(fixture.slug, structuredClone(fixture.legacy.manifest))
        : structuredClone(fixture.legacy.manifest);
      local.put({
        manifest: installed,
        entity_schemas: structuredClone(fixture.legacy.entitySchemas),
      });
      recordPackInventory(contracts, {
        pack_slug: fixture.slug,
        publisher: 'recued-core',
        pack_version: 1,
        contents: [],
        local_catalogs: [{
          ingredient_id: fixture.catalogSlug,
          version: installed.version ?? 1,
          catalog_kind: installed.catalog_kind ?? 'private_byo',
        }],
        installed_at: 1,
      });
    }

    for (const owner of OWNER_AUTHORITY) {
      if (!fixtures.some((fixture) => fixture.slug === owner.pack)) continue;
      createContractGrantStore(contracts).grantPackGroup(
        owner.pack,
        owner.catalog,
        owner.connection,
        owner.group,
      );
      createConnectionCatalogBindingStore(contracts).bind(
        owner.connection,
        owner.catalog,
        owner.pack,
      );
      createContractGrantEntryStore(contracts).set(
        AUDIENCE_CONTRACT,
        owner.operation,
        true,
        7,
        owner.pack,
      );
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  const seeded = inspectRealm(dbPath, fixtures);
  // ⚠ Every later comparison is `after` against this. A row that never got
  // written compares null to null and passes, so prove the seed first.
  for (const pack of seeded.packs) {
    requiredRow(pack.inventory, `${pack.slug} seeded inventory`);
    assert.ok(pack.manifest !== null, `${pack.slug} seeded manifest is missing`);
  }
  for (const authority of seeded.authority) {
    requiredRow(authority.row, `seeded ${authority.scope} ${authority.segments.join('/')}`);
  }
  assert.ok(seeded.authority.length > 0, 'the realm was seeded with no owner authority');
  return seeded;
};

const stateFor = (state: RealmState, slug: PackSlug): PackState => {
  const found = state.packs.find((row) => row.slug === slug);
  if (found === undefined) throw new Error(`realm state is missing ${slug}`);
  return found;
};

const requiredRow = (row: ContractRow | null, label: string): ContractRow => {
  if (row === null) throw new Error(`${label} row is missing`);
  return row;
};

const assertMigrated = (
  before: RealmState,
  after: RealmState,
  fixtures: readonly PackFixture[],
): void => {
  assert.deepEqual(after.authority, before.authority, 'owner authority rows changed');
  for (const fixture of fixtures) {
    const prior = stateFor(before, fixture.slug);
    const current = stateFor(after, fixture.slug);
    if (fixture.target === null) {
      assert.deepEqual(
        current,
        prior,
        `${fixture.slug} is outside the D-259 ledger and was changed at boot`,
      );
      continue;
    }
    const priorInventory = requiredRow(prior.inventory, `${fixture.slug} prior inventory`);
    const currentInventory = requiredRow(current.inventory, `${fixture.slug} current inventory`);
    assert.deepEqual(
      currentInventory.value,
      {
        ...record(priorInventory.value, `${fixture.slug} prior inventory value`),
        // ⚠ SECOND COPY OF THE SAME NUMBER, as a STRING — the inventory row
        // stores it that way. Fixing only the manifest assertion above left this
        // one behind and the rehearsal failed a second time on the same bump.
        version: String(LAUNCH_SAFE_TARGET_VERSION),
      },
      `${fixture.slug} inventory changed beyond the approved version bump`,
    );
    assert.deepEqual(
      current.ingredient,
      prior.ingredient,
      `${fixture.slug} ingredient ownership row changed`,
    );
    assert.deepEqual(
      current.manifest,
      fixture.target.manifest,
      `${fixture.slug} did not land on the reviewed v${LAUNCH_SAFE_TARGET_VERSION} body`,
    );
    assert.deepEqual(
      current.entitySchemas,
      fixture.target.entitySchemas,
      `${fixture.slug} entity schemas changed`,
    );
  }
};

interface CapturedProcess {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: () => string;
  stderr: () => string;
  output: () => string;
}

const activeProcesses = new Set<CapturedProcess>();

const runtimeEnvironment = (
  homeDir: string,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv => {
  const inherited = process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'SHELL',
    'TERM',
    'LANG',
    'LC_ALL',
    'TZ',
    'DYLD_LIBRARY_PATH',
    'LD_LIBRARY_PATH',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
  ]) {
    if (inherited[name] !== undefined) env[name] = inherited[name];
  }
  Object.assign(env, {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_DATA_HOME: join(homeDir, '.local', 'share'),
    TMPDIR: join(homeDir, 'tmp'),
    NODE_ENV: 'production',
    RECUED_DISTRIBUTION: 'server',
    RECUED_BOOT_TRACE: '1',
    ...overrides,
  });
  mkdirSync(env.TMPDIR!, { recursive: true });
  return env;
};

const startArtifact = (
  artifact: ArtifactLayout,
  args: string[],
  env: NodeJS.ProcessEnv,
): CapturedProcess => {
  const child = spawn(process.execPath, [artifact.binPath, ...args], {
    cwd: artifact.packageRoot,
    detached: process.platform !== 'win32',
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  const captured: CapturedProcess = {
    child,
    exit,
    stdout: () => stdout,
    stderr: () => stderr,
    output: () => `${stdout}\n${stderr}`,
  };
  activeProcesses.add(captured);
  void exit.then(() => activeProcesses.delete(captured));
  return captured;
};

const signalProcess = (processHandle: CapturedProcess, signal: NodeJS.Signals): void => {
  const pid = processHandle.child.pid;
  if (
    pid === undefined
    || processHandle.child.exitCode !== null
    || processHandle.child.signalCode !== null
  ) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The process may have exited between the check and the group signal.
    }
  }
  try { processHandle.child.kill(signal); } catch { /* already gone */ }
};

const waitForExit = async (processHandle: CapturedProcess, timeoutMs: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), timeoutMs);
  });
  const exited = processHandle.exit.then(() => true);
  const result = await Promise.race([exited, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
};

const stopArtifact = async (processHandle: CapturedProcess): Promise<void> => {
  if (
    processHandle.child.exitCode !== null
    || processHandle.child.signalCode !== null
  ) return;
  signalProcess(processHandle, 'SIGTERM');
  if (await waitForExit(processHandle, 15_000)) return;
  signalProcess(processHandle, 'SIGKILL');
  await waitForExit(processHandle, 5_000);
};

const freePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      reject(new Error('could not allocate an IPv4 test port'));
      return;
    }
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});

const pollUntil = async <T>(
  label: string,
  read: () => T | null | Promise<T | null>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== null) return value;
    } catch (error) {
      if (error instanceof TerminalPollError) throw error;
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(
    `timed out waiting for ${label}`
      + (lastError instanceof Error ? `: ${lastError.message}` : ''),
  );
};

class TerminalPollError extends Error {}

const waitForHealth = async (
  processHandle: CapturedProcess,
  port: number,
): Promise<void> => {
  await pollUntil('artifact /health', async () => {
    if (
      processHandle.child.exitCode !== null
      || processHandle.child.signalCode !== null
    ) {
      throw new TerminalPollError(
        `artifact exited early:\n${processHandle.output().slice(-4000)}`,
      );
    }
    const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
    if (response?.status !== 200) return null;
    const body: unknown = await response.json().catch(() => null);
    return isRecord(body) && body.status === 'ok' ? true : null;
  });
};

const configFor = (dir: string): string => {
  const path = join(dir, 'rehearsal-config.toml');
  writeFileSync(path, '[bootstrap]\nbind_host = "127.0.0.1"\n', 'utf8');
  return path;
};

const readPendingAsks = (dbPath: string): Record<string, unknown>[] => {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  try {
    const exists = db.prepare(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'pending_asks'`,
    ).get();
    if (exists === undefined) return [];
    const rows = db.prepare(`SELECT data FROM pending_asks ORDER BY key`).all() as Array<{
      data: string;
    }>;
    return rows.map((row, index) => record(
      JSON.parse(row.data) as unknown,
      `pending ask ${index}`,
    ));
  } finally {
    db.close();
  }
};

const openPackPings = (dbPath: string): Record<string, unknown>[] =>
  readPendingAsks(dbPath).filter((candidate) =>
    candidate.status === 'open' && candidate.handler_kind === ASK_KIND
  );

/** Every `notification_fired` audit activity, oldest first, with its `detail`
 *  parsed.
 *
 *  ⛔ THIS IS WHERE DELIVERY BECAME OBSERVABLE. D-259 turned the boot pack
 *  finding from a durable ASK into a NOTIFICATION — there is nothing to approve
 *  on an error report, and the ask carried a single dismiss option, a fake
 *  choice. A notification persists no row of its own, so polling `pending_asks`
 *  for it waits forever; what it DOES leave is this audit activity, written by
 *  `wire-notification-block` carrying the title, text and link_url the owner
 *  actually saw. Asserting it proves DELIVERY, where the log line proves only
 *  DETECTION — and delivery is the whole point of the refactor. */
const readNotificationsFired = (dbPath: string): Record<string, unknown>[] => {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  try {
    const exists = db.prepare(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'audit_activities'`,
    ).get();
    if (exists === undefined) return [];
    const rows = db.prepare(`SELECT data FROM audit_activities ORDER BY key`).all() as Array<{
      data: string;
    }>;
    return rows
      .map((row, index) => record(JSON.parse(row.data) as unknown, `activity ${index}`))
      .filter((row) => row.action === 'notification_fired')
      .map((row, index) => record(
        JSON.parse(String(row.detail ?? '{}')) as unknown,
        `notification detail ${index}`,
      ));
  } finally {
    db.close();
  }
};

/** The boot pack finding's notifications, in fire order. */
const packNotices = (dbPath: string): Record<string, unknown>[] =>
  readNotificationsFired(dbPath).filter((row) => row.title === NOTICE_TITLE);

/** The reconciler's own account of a first boot: every ledger pack moved,
 *  nothing was held, and no pack outside the ledger is in the line at all. */
const assertLedgerReport = (output: string, label: string): void => {
  const updated = output.split('\n').find((line) =>
    line.includes('[packs] launch-safe reconciliation updated'));
  if (updated === undefined) {
    throw new Error(`${label} reported no ledger migration:\n${output.slice(-4000)}`);
  }
  assert.match(
    updated,
    new RegExp(`updated ${LEDGER_PACKS.length} pack\\(s\\):`),
    `${label} migrated the wrong number of packs: ${updated}`,
  );
  for (const slug of LEDGER_PACKS) {
    assert.ok(
      updated.includes(`${slug} v1→v${LAUNCH_SAFE_TARGET_VERSION}`),
      `${label} did not migrate ${slug}: ${updated}`,
    );
  }
  for (const slug of OUT_OF_LEDGER_PACKS) {
    assert.ok(!updated.includes(slug), `${label} migrated ${slug}, which is outside the ledger`);
  }
  assert.doesNotMatch(output, /launch-safe reconciliation held/, `${label} held a pack for review`);
};

const runServeArm = async (
  artifact: ArtifactLayout,
  fixtures: readonly PackFixture[],
  armRoot: string,
): Promise<void> => {
  say('arm 1/3: production serve boot + authority preservation + restart idempotence');
  const dbPath = join(armRoot, 'realm.db');
  const before = await seedRealm(dbPath, fixtures);
  const home = join(armRoot, 'home');
  const configPath = configFor(armRoot);
  const env = runtimeEnvironment(home);

  const firstPort = await freePort();
  const first = startArtifact(artifact, [
    'serve', '--db', dbPath, '--port', String(firstPort), '--config', configPath,
  ], env);
  try {
    await waitForHealth(first, firstPort);
    const atFirstIntake = inspectRealm(dbPath, fixtures);
    assertMigrated(before, atFirstIntake, fixtures);
    assertLedgerReport(first.output(), 'first artifact boot');
    // What the ledger leaves alone is still the owner's to update, so the boot
    // names it. This server has no public name and the notice carries no link:
    // a dead link reads as "nothing here".
    const notice = await pollUntil('out-of-ledger owner notification', () =>
      packNotices(dbPath).at(-1) ?? null, 20_000);
    for (const slug of OUT_OF_LEDGER_PACKS) {
      assert.match(String(notice.text ?? ''), new RegExp(slug), `owner notice does not name ${slug}`);
    }
    assert.equal(notice.link_url, undefined, 'a server with no public name linked the notice');
  } finally {
    await stopArtifact(first);
  }

  const afterFirst = inspectRealm(dbPath, fixtures);
  const secondPort = await freePort();
  const second = startArtifact(artifact, [
    'serve', '--db', dbPath, '--port', String(secondPort), '--config', configPath,
  ], env);
  try {
    await waitForHealth(second, secondPort);
    assert.deepEqual(
      inspectRealm(dbPath, fixtures),
      afterFirst,
      'second artifact boot rewrote reconciled pack or authority state',
    );
    assert.doesNotMatch(
      second.output(),
      /launch-safe reconciliation (?:updated|held)/,
      'idempotent restart emitted a reconciliation mutation',
    );
  } finally {
    await stopArtifact(second);
  }
  say(`arm 1/3 PASS: first intake saw v${LAUNCH_SAFE_TARGET_VERSION}; `
    + `${OUT_OF_LEDGER_PACKS.join(', ')} left as installed and named; authority survived; `
    + 'restart was quiet');
};

interface McpDriveResult {
  responses: Record<string, unknown>[];
  stateAtToolsList: RealmState;
  stderr: string;
  exitCode: number | null;
}

const driveMcp = (
  artifact: ArtifactLayout,
  dbPath: string,
  fixtures: readonly PackFixture[],
  env: NodeJS.ProcessEnv,
): Promise<McpDriveResult> => new Promise((resolveDrive, rejectDrive) => {
  const processHandle = startArtifact(artifact, ['--mcp', '--db', dbPath], env);
  const { child } = processHandle;
  const responses: Record<string, unknown>[] = [];
  let stdoutBuffer = '';
  let stateAtToolsList: RealmState | undefined;
  let settled = false;

  const finishError = (error: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    signalProcess(processHandle, 'SIGKILL');
    rejectDrive(error);
  };
  const send = (message: Record<string, unknown>): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  const consume = (message: Record<string, unknown>): void => {
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
    responses.push(message);
    if (message.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      return;
    }
    if (message.id === 2) {
      // Read while the artifact process is still serving stdio. This makes the
      // durable database state at the first tools/list response the assertion,
      // rather than state observed after process teardown.
      stateAtToolsList = inspectRealm(dbPath, fixtures);
      child.stdin?.end();
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        consume(record(parsed, 'MCP stdout message'));
      } catch (error) {
        finishError(new Error(`non-JSON MCP stdout ${JSON.stringify(line)}`, { cause: error }));
      }
    }
  });
  child.once('spawn', () => {
    // Queue intake immediately. The pipe can accept bytes before the profile is
    // composed; the artifact must not answer them until reconciliation finishes.
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  });
  child.once('error', (error) => finishError(error));
  void processHandle.exit.then(({ code }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (stateAtToolsList === undefined) {
      rejectDrive(new Error(
        `MCP artifact exited before tools/list:\n${processHandle.output().slice(-4000)}`,
      ));
      return;
    }
    resolveDrive({
      responses,
      stateAtToolsList,
      stderr: processHandle.stderr(),
      exitCode: code,
    });
  });
  const timeout = setTimeout(() => {
    finishError(new Error(`MCP artifact timed out:\n${processHandle.output().slice(-4000)}`));
  }, DEFAULT_TIMEOUT_MS);
});

const runMcpArm = async (
  artifact: ArtifactLayout,
  fixtures: readonly PackFixture[],
  armRoot: string,
): Promise<void> => {
  say('arm 2/3: production stdio MCP boot before first tools/list response');
  const dbPath = join(armRoot, 'realm.db');
  const before = await seedRealm(dbPath, fixtures);
  const drive = await driveMcp(
    artifact,
    dbPath,
    fixtures,
    runtimeEnvironment(join(armRoot, 'home')),
  );
  assert.equal(drive.exitCode, 0, `MCP artifact exit:\n${drive.stderr.slice(-4000)}`);
  const toolsList = drive.responses.find((message) => message.id === 2);
  assert.ok(toolsList !== undefined, 'MCP artifact answered tools/list');
  assert.equal('error' in toolsList, false, `MCP tools/list error: ${JSON.stringify(toolsList)}`);
  const result = record(toolsList.result, 'MCP tools/list result');
  assert.ok(Array.isArray(result.tools), 'MCP tools/list result carries tools[]');
  assertMigrated(before, drive.stateAtToolsList, fixtures);
  assertLedgerReport(drive.stderr, 'MCP artifact boot');
  say(`arm 2/3 PASS: queued MCP intake answered only after all ${LEDGER_PACKS.length} `
    + `v${LAUNCH_SAFE_TARGET_VERSION} bodies were durable`);
};

/** A local edit nobody reviewed: the download may now read the browser's
 *  cookies. The authority projection is unchanged (an argv is execution, not
 *  authority), so what holds it is the SOURCE fingerprint alone. The legacy
 *  detached declaration stays, so the current validator still rejects it. */
const makeHeldBody = (slug: PackSlug, body: IngredientManifest): IngredientManifest => {
  if (slug !== HELD_PACK) return body;
  const surfaces = record(body.surfaces, 'held yt-dlp surfaces');
  const connector = record(surfaces.connector, 'held yt-dlp connector');
  const executes = record(connector.executes, 'held yt-dlp executes');
  const binding = record(executes['media.download'], 'held yt-dlp download binding');
  const argv = binding.argv_template;
  assert.ok(
    Array.isArray(argv) && argv.includes('--no-cookies-from-browser'),
    'held yt-dlp fixture no longer carries the flag the edit removes',
  );
  binding.argv_template = argv.filter((arg) => arg !== '--no-cookies-from-browser');
  return body;
};

const runHeldArm = async (
  artifact: ArtifactLayout,
  heldFixture: PackFixture,
  armRoot: string,
): Promise<void> => {
  say('arm 3/3: unreviewed source is held while owner notification and HTTP intake survive');
  const fixtures = [heldFixture];
  const dbPath = join(armRoot, 'realm.db');
  const before = await seedRealm(dbPath, fixtures, makeHeldBody);
  const port = await freePort();
  const configPath = configFor(armRoot);
  const processHandle = startArtifact(artifact, [
    'serve', '--db', dbPath, '--port', String(port), '--config', configPath,
  ], runtimeEnvironment(join(armRoot, 'home'), {
    RECUED_PUBLIC_BASE_URL: 'https://home.example.net',
  }));
  try {
    await waitForHealth(processHandle, port);
    const atFirstIntake = inspectRealm(dbPath, fixtures);
    assert.deepEqual(
      atFirstIntake,
      before,
      'held artifact boot changed the unreviewed pack or owner authority',
    );
    const notice = await pollUntil('unrunnable-pack owner notification', () =>
      packNotices(dbPath).at(-1) ?? null, 20_000);
    assert.equal(notice.link_url, PACK_DETAIL_LINK, 'owner notification links to the held pack');
    assert.match(
      String(notice.text ?? ''),
      new RegExp(HELD_PACK),
      'owner notification names the held pack rather than "some packs"',
    );
    // ⛔ THE ASK IS RETIRED — ASSERT ITS ABSENCE, do not merely stop looking for
    // it. Without this the arm would pass just as happily if the notification AND
    // the ask were both raised, which is the state D-259 removed.
    assert.deepEqual(
      openPackPings(dbPath), [],
      'a retired unrunnable-pack ask was minted alongside the notification',
    );
    assert.match(
      processHandle.output(),
      new RegExp(`held 1 pack\\(s\\) for owner review: ${HELD_PACK} \\(source_body_not_approved\\)`),
      'artifact did not log the source-fingerprint hold',
    );
    // ⚠ THE VALIDATOR CODES MOVED, THEY DID NOT VANISH. They used to be read off
    // the ask's `handler_payload`; the durable half is now the `packs.unrunnable`
    // badge, which needs a paired client this harness has no reason to become.
    // The boot check logs them per pack on the same line as the slug, so the
    // coverage survives here rather than being quietly dropped with the ask.
    assert.match(
      processHandle.output(),
      /CLI_LEGACY_UNSUPERVISED_DETACH/,
      'artifact did not log the legacy-detach validator code',
    );
  } finally {
    await stopArtifact(processHandle);
  }

  const noticesBeforeRestart = packNotices(dbPath).length;
  const secondPort = await freePort();
  const second = startArtifact(artifact, [
    'serve', '--db', dbPath, '--port', String(secondPort), '--config', configPath,
  ], runtimeEnvironment(join(armRoot, 'second-home'), {
    RECUED_PUBLIC_BASE_URL: 'https://home.example.net',
  }));
  try {
    await waitForHealth(second, secondPort);
    // ⛔⛔ THIS ASSERTION INVERTED, IT DID NOT MOVE. It used to require the
    // restart NOT to re-raise, because a durable ask minted a fresh open row
    // every boot and had to be deduplicated. A notification persists no row, so
    // there is nothing to accumulate, and `compose-listeners` says why plainly:
    // "Re-announcing a condition that is still true on a restart is what a
    // notification is FOR." A harness still demanding silence here would be
    // pinning the behaviour the refactor deliberately removed.
    await pollUntil('the still-true finding re-announced after restart', () =>
      packNotices(dbPath).length > noticesBeforeRestart ? true : null
    );
    assert.deepEqual(
      openPackPings(dbPath), [],
      'a restart minted a retired unrunnable-pack ask',
    );
    assert.deepEqual(
      inspectRealm(dbPath, fixtures),
      before,
      'held restart changed the unreviewed pack or owner authority',
    );
  } finally {
    await stopArtifact(second);
  }
  say('arm 3/3 PASS: held bytes survived; health served; the owner was NOTIFIED with a live '
    + 'link, no retired ask was minted, and the still-true finding re-announced on restart');
};

const main = async (): Promise<void> => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: npm run test:pack-reconciliation-artifact -- [--source <git-ref>]');
    return;
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor !== 24) {
    throw new Error(
      `this rehearsal requires Node 24 so the SQLite ABI matches the release checkout; got ${process.version}`,
    );
  }

  const source = git('rev-parse', `${argValue('--source', 'HEAD')}^{commit}`);
  const tempRoot = mkdtempSync(join(tmpdir(), 'recued-pack-artifact-'));
  const worktree = join(tempRoot, 'source');
  let worktreeAdded = false;
  say(`candidate ${source.slice(0, 12)}; disposable root ${tempRoot}`);
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktree, source], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    worktreeAdded = true;
    assert.equal(gitStatus(worktree), '', 'detached candidate checkout starts clean');

    await assertLedgerMembership(worktree);
    const fixtures = loadFixtures(worktree);
    assert.deepEqual(fixtures.map((fixture) => fixture.slug), [...PACKS]);
    const artifact = buildPackedArtifact(worktree, tempRoot);

    await runServeArm(artifact, fixtures, join(tempRoot, 'serve-arm'));
    await runMcpArm(artifact, fixtures, join(tempRoot, 'mcp-arm'));
    const held = fixtures.find((fixture) => fixture.slug === HELD_PACK);
    if (held === undefined || held.target === null) {
      throw new Error(`${HELD_PACK} is not a ledger fixture`);
    }
    await runHeldArm(artifact, held, join(tempRoot, 'held-arm'));

    say(`PASS: ${source.slice(0, 12)} packaged reconciliation is launch-safe`);
  } finally {
    await Promise.allSettled([...activeProcesses].map((child) => stopArtifact(child)));
    if (worktreeAdded) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktree], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        console.warn(`[pack-artifact] cleanup warning: could not remove worktree: ${String(error)}`);
      }
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
};

main().catch((error: unknown) => {
  console.error(
    `[pack-artifact] FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
