/** A Records pack whose RECIPES moved at the SAME pack version reaches the owners
 *  who already have it.
 *
 *  ⛔⛔ FOUND BY BOOTING THE CURRENT SERVER ON A 26.9.21 REALM. D-292 moved the
 *  bank importer 1 → 4 inside `statement-import` without a pack version bump
 *  (a pack version bump realigns every recipe's `expected_version` — see
 *  `records-expected-version-coupling.test.ts`). `packs.list` answered
 *  `installed: true` on the namespace's VERSION alone, offered nothing, and Pack
 *  Use kept running the 26.9.21 body — no guided import, and the per-upload
 *  `source_file` that refused every re-upload's overlapping lines. Every test was
 *  green: each one installed the CURRENT pack into an empty database.
 *
 *  🔑 The update itself was never missing — recipe bodies are in the artifact
 *  digest, so the review builder already answers a same-version recipe change
 *  with a transition. Only the list never asked. This file installs the REAL
 *  26.9.21 bodies (`fixtures/statement-import-26.9.21`, copied from the release
 *  worktree at 3024e7f03), puts a line in the namespace, and drives what the
 *  owner's Packs panel does: list → review → install → list.
 *
 *  ⛔ THE SAME-VERSION PACK IS BUILT HERE, NOT READ FROM THE CORPUS. The corpus
 *  holds the scenario only until a release cut: the cut bumps every pack changed
 *  since the last publish (`scripts/bump-changed-since-publish.mjs`), and
 *  `statement-import` goes 1 → 2, after which the corpus shows an ordinary version
 *  update. So the test takes a later manifest and gives it the released number.
 *
 *  ⚠ THE LATER SIDE IS FROZEN TOO, at 26.10.9 (`fixtures/statement-import-26.10.9`,
 *  `git show v26.10.9:…`). v3 added the `account_balance` entity (2026-10-10), so
 *  the corpus pack's STORAGE moved as well as its recipes, and a storage change at
 *  one version is not a state this path can meet. 26.10.9 is the last release whose
 *  composition is 26.9.21's, with its recipes moved: exactly this scenario.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BULK_PACK_INSTALL_PERMISSION,
  D165_CONTRACT_SCHEMA,
  parseBulkPackManifest,
  type BulkPackManifest,
  type RecordsExecutionBinding,
} from '@recued/contracts';
import { recordsCatalogSlug } from '@recued/ingredient-authoring';

import { createLocalManifestStore, type LocalManifestStore } from '../../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry } from '../../manifest-loader.js';
import { handlePacksList } from '../../pack-list-handler.js';
import { handlePacksInstall, type PackInstallRpcDeps } from '../../pack-install-handler.js';
import { createRecipeStore, type RecipeStore } from '../../recipe-store.js';
import { createContractDefinitionStore } from '../../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../../storage/contract-grant-entry-store.js';
import { createContractStore, type ContractStore } from '../../storage/contract-store.js';
import { createRecordsStore, type RecordsStore } from '../store.js';

const RELEASED = resolve(import.meta.dirname, '../../__tests__/fixtures/statement-import-26.9.21');
/** The upgraded server's bundle: 26.10.9's manifest and bodies (see above). */
const LATER = resolve(import.meta.dirname, '../../__tests__/fixtures/statement-import-26.10.9');
const CURRENT_PACKS = resolve(LATER, 'packs');
const CURRENT_RECIPES = resolve(LATER, 'recipes');
const OWNER = { publisher: 'recued-core', pack_slug: 'statement-import' } as const;
const readManifest = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(dir, 'statement-import.json'), 'utf8')) as Record<string, unknown>;
/** Parsed as the server parses it — `recipes` exists only on a parsed manifest. */
const parsed = (raw: unknown): BulkPackManifest => {
  const result = parseBulkPackManifest(raw);
  if (!result.ok) throw new Error(result.issues[0]?.message);
  return result.manifest;
};
const RELEASED_RAW = readManifest(resolve(RELEASED, 'packs'));
const RELEASED_PACK = parsed(RELEASED_RAW);
/** The later manifest, its recipe pins, at the RELEASED pack version. */
const SAME_VERSION_RAW = { ...readManifest(CURRENT_PACKS), version: RELEASED_RAW.version };
const SAME_VERSION_PACK = parsed(SAME_VERSION_RAW);

describe('a records pack whose recipes moved at the same pack version', () => {
  let db: Database.Database;
  let contractStore: ContractStore;
  let localManifestStore: LocalManifestStore;
  let recordsStore: RecordsStore;
  let released: RecipeStore;
  let current: RecipeStore;
  let listDir: string;

  const depsWith = (recipeStore: RecipeStore, packDir: string): PackInstallRpcDeps => ({
    recipeStore,
    contractStore,
    localManifestStore,
    registry: createManifestRegistry('/nonexistent-same-version-update-registry'),
    recordsStore,
    packDir,
    now: () => 1_900_000_000_000,
  });

  /** What the owner's Packs panel is told about statement-import. The list runs
   *  over a dir holding only this pack — the full corpus is 1,000+ manifests — and
   *  the same dir is the bundle the installs read: the same-version pack. */
  const listed = async () => {
    const result = await handlePacksList({
      recipeStore: current, contractStore, recordsStore, packDir: listDir, localManifestStore,
    });
    return result.packs.find((row) => row.slug === 'statement-import')!;
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    contractStore = createContractStore(db, { now: () => 1_900_000_000_000 });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    localManifestStore = createLocalManifestStore(db);
    let clock = 1_900_000_000_000;
    recordsStore = createRecordsStore(db, { now: () => clock++ });
    // An agreement the owner shares the pack with (D-294).
    createContractDefinitionStore(contractStore, { now: () => 1_900_000_000_000, newId: () => 'door-bookkeeper' })
      .mint({
        minted_by: 'user:1',
        display_name: 'Bookkeeper',
        scope: { channels: ['mcp'], actors: ['contracted_user'] },
      });
    // The released server: its own recipe bodies, its own manifest.
    released = createRecipeStore(resolve(RELEASED, 'recipes'), db);
    const installed = await handlePacksInstall(
      depsWith(released, resolve(RELEASED, 'packs')),
      {
        manifest: RELEASED_PACK,
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        install_scope: {
          access: 'write',
          audience: { owner: true, all_customers: false, all_other_contracts: true },
        },
      },
      'recued-core',
    );
    if (!installed.result.ok) throw new Error(installed.result.failure?.message);
    // The upgraded server: same database, today's bundled bodies.
    current = createRecipeStore(CURRENT_RECIPES, db);
    listDir = mkdtempSync(join(tmpdir(), 'same-version-recipe-update-'));
    writeFileSync(join(listDir, 'statement-import.json'), JSON.stringify(SAME_VERSION_RAW, null, 2));
  });

  afterEach(() => {
    db.close();
    rmSync(listDir, { recursive: true, force: true });
  });

  it('is the scenario: same pack version, a recipe the released server had at an older version', () => {
    expect(SAME_VERSION_PACK.version).toBe(RELEASED_PACK.version);
    const pin = (m: BulkPackManifest) => m.recipes.find((r) => r.slug === 'import-bank-statement')!.version;
    expect(pin(SAME_VERSION_PACK)).toBeGreaterThan(pin(RELEASED_PACK));
    expect(current.getStored('import-bank-statement')?.version).toBe(pin(RELEASED_PACK));
    // Today's pins are today's bodies: the recipes the update would land are bundled.
    for (const ref of SAME_VERSION_PACK.recipes) {
      expect(current.getBundled(ref.slug)?.version, ref.slug).toBe(ref.version);
    }
    // ⚠ Only the pack's number is set back. A Records pack's update recipes author
    // the pack version as `expected_version`, and a bump moves those literals with
    // it; were one of these recipes to author one, it would hold the bumped number
    // and this would no longer be the pack a same-version change ships.
    for (const ref of SAME_VERSION_PACK.recipes) {
      const body = readFileSync(resolve(CURRENT_RECIPES, `${ref.slug}.json`), 'utf8');
      expect(body.includes('"expected_version"'), `${ref.slug} authors expected_version`).toBe(false);
    }
  });

  it('⛔⛔ is OFFERED the update — and taking it lands today\'s recipes, keeps the owner\'s lines, and settles', async () => {
    // A line the owner imported under the released server.
    const catalogId = await recordsCatalogSlug(OWNER);
    const executes = localManifestStore.getManifest(catalogId)!
      .surfaces!.records!.executes as Record<string, RecordsExecutionBinding>;
    const importKey = Object.keys(executes).find((key) => key.endsWith('.import'))!;
    recordsStore.execute({
      binding: executes[importKey]!,
      principal: 'owner',
      args: {
        csv: 'Date,Description,Amount\n2026-08-01,Coffee,-3.50\n',
        spec: {
          columns: [
            { column: 'Date', field: 'posted_on' },
            { column: 'Description', field: 'description' },
            { column: 'Amount', field: 'amount' },
          ],
          numeric_fields: ['amount'],
          dedup_on: ['posted_on', 'description', 'amount'],
          scope: 'acct-1',
          defaults: {
            account_label: 'acct-1', currency: 'GBP', source_file: 'file/v1-upload',
            counterparty: '', category: '',
          },
        },
      },
    } as never);
    // Read straight out of SQLite: the update must not touch a stored row at all.
    const rows = () => db.prepare('select * from core_records').all();
    const before = rows();
    expect(before).toHaveLength(1);

    // ── What the Packs panel is told: an update, with its review.
    const offered = await listed();
    expect(offered.installed, 'an installed pack with older recipes is NOT current').toBe(false);
    expect(offered.installed_any_version).toBe(true);
    expect(offered.records_review).toMatchObject({
      current_version: RELEASED_PACK.version, target_version: RELEASED_PACK.version, estimated_rows: 1,
    });
    expect(typeof offered.manifest_review_hash).toBe('string');
    // ⛔ The operation diff lines up with the STAMPED catalog — its six
    // `statement_line` operations under the derived `records-<hash>` id — so an
    // update that did not touch them says so. Keyed by the composition's authored
    // slug instead (D-211's review), all six would read as added: nothing matched.
    expect(offered.operation_diff).toEqual({ items: [], unchanged: 6 });
    // ⛔ …and the Access choice starts where the owner left it. This pack was
    // installed "Read + write"; the dialog used to start at "Read only", and an
    // update REPLACES the grants — Update without re-picking took the
    // importer's writes away (`operation_not_granted`, driven live).
    expect(offered.current_access).toBe('write');
    // ⛔ …and "Who may use it" at who has it now: the Bookkeeper agreement. The
    // share is stamped with the derived catalog id, not the pack slug — keyed by
    // the slug it would read back as "only you" and the update would withdraw it.
    expect(offered.current_audience).toEqual({ owner: true, all_customers: false, all_other_contracts: true });
    const bookkeeper = () => createContractGrantEntryStore(contractStore).listForContract('door-bookkeeper')
      .filter((row) => row.source_pack === catalogId && row.granted);
    const sharedBefore = bookkeeper().map((row) => row.entry_key);
    expect(sharedBefore.length, 'the install shared operations with the Bookkeeper').toBeGreaterThan(0);

    // ── The owner takes it, exactly as the panel submits it: the Access and
    // audience it started at, untouched.
    const taken = await handlePacksInstall(
      depsWith(current, listDir),
      {
        manifest: SAME_VERSION_PACK,
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        install_scope: { access: offered.current_access!, audience: offered.current_audience! },
        expected_manifest_hash: offered.manifest_review_hash!,
      },
      'recued-core',
    );
    if (!taken.result.ok) throw new Error(taken.result.failure?.message);

    // Today's recipe runs now — the guided import's declaration included.
    const stored = current.getStored('import-bank-statement');
    expect(stored?.version).toBe(SAME_VERSION_PACK.recipes.find((r) => r.slug === 'import-bank-statement')!.version);
    // `get()` is what a run resolves (a stored row wins over the bundled file).
    expect(current.get('import-bank-statement')?.metadata?.spreadsheet_import).toBeDefined();
    // The owner's line survived, and the namespace is still the one they had.
    expect(rows()).toEqual(before);
    expect(recordsStore.getNamespace(OWNER)?.state).toMatchObject({ state: 'ready', version: 1 });
    // The Bookkeeper still has exactly what it had.
    expect(bookkeeper().map((row) => row.entry_key)).toEqual(sharedBefore);

    // ── And it SETTLES: the list reads current, with nothing left to offer.
    const after = await listed();
    expect(after.installed, `still offered after taking it: ${JSON.stringify(after.records_review ?? null)}`).toBe(true);
    expect(after.records_review).toBeUndefined();
  });

  it('an OLDER bundle never offers a downgrade over newer installed recipes', async () => {
    // Today's recipes installed; then a server whose bundle is the 26.9.21 one
    // lists the same pack. Its pins are older than what is stored — that is not
    // an update, and offering it would move the owner BACKWARDS.
    const taken = await handlePacksInstall(
      depsWith(current, listDir),
      {
        manifest: SAME_VERSION_PACK,
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        install_scope: { access: 'write', scope: 'owner' },
        expected_manifest_hash: (await listed()).manifest_review_hash!,
      },
      'recued-core',
    );
    if (!taken.result.ok) throw new Error(taken.result.failure?.message);
    const olderDir = mkdtempSync(join(tmpdir(), 'same-version-recipe-update-older-'));
    try {
      copyFileSync(resolve(RELEASED, 'packs/statement-import.json'), join(olderDir, 'statement-import.json'));
      const result = await handlePacksList({ recipeStore: released, contractStore, recordsStore, packDir: olderDir });
      const row = result.packs.find((entry) => entry.slug === 'statement-import')!;
      expect(row.installed).toBe(true);
      expect(row.records_review).toBeUndefined();
    } finally {
      rmSync(olderDir, { recursive: true, force: true });
    }
  });

  it('a pack whose recipes are all current is not offered anything', async () => {
    const taken = await handlePacksInstall(
      depsWith(current, listDir),
      {
        manifest: SAME_VERSION_PACK,
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        install_scope: { access: 'write', scope: 'owner' },
        expected_manifest_hash: (await listed()).manifest_review_hash!,
      },
      'recued-core',
    );
    if (!taken.result.ok) throw new Error(taken.result.failure?.message);
    const row = await listed();
    expect(row.installed).toBe(true);
    expect(row.records_review).toBeUndefined();
  });
});
