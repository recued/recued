/** D-247 slice 5 — the seed and the purge, on one seam.
 *
 *  ⛔⛔ THE THREE EDGES THAT FAIL SILENTLY, each pinned here:
 *   1. `user_authored` defaulting to `false` — hides every recipe the owner
 *      wrote in Kitchen, while every pack-install test stays green.
 *   2. An UPSERT instead of insert-if-absent — a pack update, a pair sync, or a
 *      re-save reopens a recipe the owner turned off, and D14's "an owner's
 *      revoke survives every update" becomes a fiction.
 *   3. The delete branch not purging — a grant outlives its subject, which is
 *      verbatim the condition D14 says must not exist. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isRecipeGrantEntry,
  OWNER_CONTRACT_ID,
  recipeGrantEntry,
  type RecipeDefinition,
} from '@recued/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRecipeStore } from '../recipe-store.js';
import {
  installRecipeGrantSeed, syncRecipeGrant, seedExistingRecipeCorpus, seedPackRecipeGrants,
} from '../recipe-grant-seed.js';
import { reconcileOwnerGrants } from '../owner-grant-reconcile.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

const NOW = 1_750_000_000_000;

const recipe = (recipe_id: string, chat_exposed?: boolean): RecipeDefinition => ({
  recipe_id, version: 1, ttl: 300,
  ...(chat_exposed === undefined ? {} : { chat_exposed }),
  metadata: {
    name: recipe_id, description: 'seed fixture', author: 'recued-core',
    supported_platforms: ['test'], tags: ['test'],
  },
  variables: {}, prefetch_steps: [], steps: [], output: { sidebar: [] },
} as RecipeDefinition);

const KEY = (id: string) => recipeGrantEntry('recued-core', id);

describe('D-247 slice 5 — seed + purge on the store mutation seam', () => {
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createRecipeStore>;
  let grants: ReturnType<typeof createContractGrantEntryStore>;
  let deps: { store: typeof store; grants: typeof grants; now: () => number };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd247-seed-'));
    db = new Database(':memory:');
    store = createRecipeStore(dir, db);
    grants = createContractGrantEntryStore(createContractStore(db, { now: () => NOW }));
    deps = { store, grants, now: () => NOW };
    installRecipeGrantSeed(deps);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('a PACK recipe with chat_exposed:true seeds GRANTED', () => {
    store.save(recipe('exposed', true), 'recued-core', 'pair-sync', NOW, 'pk');
    expect(grants.get(OWNER_CONTRACT_ID, KEY('exposed'))).toBe(true);
  });

  it('a PACK recipe with no flag seeds CLOSED — pack content defaults false', () => {
    store.save(recipe('quiet'), 'recued-core', 'pair-sync', NOW, 'pk');
    expect(grants.get(OWNER_CONTRACT_ID, KEY('quiet'))).toBe(false);
  });

  it('⛔ a KITCHEN-AUTHORED save seeds EXPOSED — the user_authored re-read', () => {
    // The seam carries only an id; `user_authored` comes from `source === 'inline'`.
    // Defaulting it to false hides every recipe the owner writes, and no
    // pack-install test would ever notice.
    store.save(recipe('mine'), 'recued-core', 'inline', NOW);
    expect(grants.get(OWNER_CONTRACT_ID, KEY('mine'))).toBe(true);
  });

  it('⛔ INSERT-IF-ABSENT: a re-save does not reopen an owner revoke', () => {
    store.save(recipe('exposed', true), 'recued-core', 'pair-sync', NOW, 'pk');
    grants.set(OWNER_CONTRACT_ID, KEY('exposed'), false, NOW);   // the owner turns it off
    store.save(recipe('exposed', true), 'recued-core', 'pair-sync', NOW, 'pk'); // pack update
    expect(grants.get(OWNER_CONTRACT_ID, KEY('exposed'))).toBe(false);
  });

  it('⛔ INSERT-IF-ABSENT: a re-save does not disturb an owner GRANT either', () => {
    store.save(recipe('quiet'), 'recued-core', 'pair-sync', NOW, 'pk');
    grants.set(OWNER_CONTRACT_ID, KEY('quiet'), true, NOW);      // the owner turns it on
    store.save(recipe('quiet'), 'recued-core', 'pair-sync', NOW, 'pk');
    expect(grants.get(OWNER_CONTRACT_ID, KEY('quiet'))).toBe(true);
  });

  it('⛔ DELETE PURGES the row — a grant may not outlive its subject (D14)', () => {
    store.save(recipe('gone', true), 'recued-core', 'pair-sync', NOW, 'pk');
    expect(grants.get(OWNER_CONTRACT_ID, KEY('gone'))).toBe(true);
    store.delete('gone');
    expect(grants.get(OWNER_CONTRACT_ID, KEY('gone'))).toBeUndefined();
  });

  it('a reinstall after delete lands CLOSED — a reinstall is a first install', () => {
    store.save(recipe('cycle', true), 'recued-core', 'pair-sync', NOW, 'pk');
    grants.set(OWNER_CONTRACT_ID, KEY('cycle'), false, NOW);   // owner revokes
    store.delete('cycle');                                      // uninstall purges
    store.save(recipe('cycle'), 'recued-core', 'pair-sync', NOW, 'pk'); // reinstall, no flag
    // Nothing stale survived: it re-seeds from chat_exposed, which for pack
    // content is false. Indistinguishable from a never-installed pack.
    expect(grants.get(OWNER_CONTRACT_ID, KEY('cycle'))).toBe(false);
  });

  it('a recipe with NO resolvable publisher gets no row — never a guessed address', () => {
    const anon = { ...recipe('anon', true), metadata: undefined } as unknown as RecipeDefinition;
    store.register(anon);
    expect(syncRecipeGrant(deps, 'anon')).toBe('no_identity');
  });
});

describe('D-247 slice 5 — the corpus pass is idempotent', () => {
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createRecipeStore>;
  let grants: ReturnType<typeof createContractGrantEntryStore>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd247-corpus-'));
    db = new Database(':memory:');
    store = createRecipeStore(dir, db);
    grants = createContractGrantEntryStore(createContractStore(db, { now: () => NOW }));
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('seeds recipes that predate the seam, then writes nothing on a second run', () => {
    // The day-one-empty failure this exists to prevent: a server that already
    // holds recipes must not lose its whole catalog on the boot after upgrade.
    store.save(recipe('pre-a', true), 'recued-core', 'pair-sync', NOW, 'pk');
    store.save(recipe('pre-b'), 'recued-core', 'pair-sync', NOW, 'pk');
    const deps = { store, grants, now: () => NOW };
    expect(seedExistingRecipeCorpus(deps)).toBe(2);
    expect(grants.get(OWNER_CONTRACT_ID, KEY('pre-a'))).toBe(true);
    expect(grants.get(OWNER_CONTRACT_ID, KEY('pre-b'))).toBe(false);
    // ⛔ Idempotent WITHOUT a marker, and this is the property that replaces one:
    // a second pass writes nothing because every row already exists.
    expect(seedExistingRecipeCorpus(deps)).toBe(0);
  });

  it('a second pass does not resurrect a purged grant', () => {
    // The hazard a one-time marker was drafted to prevent. It cannot arise: a
    // purge only accompanies the recipe LEAVING the store, so the scan — which
    // walks `store.ids()` — never sees it again.
    const deps = { store, grants, now: () => NOW };
    store.save(recipe('temp', true), 'recued-core', 'pair-sync', NOW, 'pk');
    seedExistingRecipeCorpus(deps);
    installRecipeGrantSeed(deps);
    store.delete('temp');
    expect(grants.get(OWNER_CONTRACT_ID, KEY('temp'))).toBeUndefined();
    seedExistingRecipeCorpus(deps);
    expect(grants.get(OWNER_CONTRACT_ID, KEY('temp'))).toBeUndefined();
  });
});

/** ⛔⛔ THE WIRING RATCHET, and it exists because the seed shipped on ONE of two
 *  boot paths and the gap was invisible to every runtime test.
 *
 *  `compose-app-context.ts` (serve) and `cli-context/mcp.ts` (stdio MCP) both
 *  open the same database and both call `reconcileOwnerGrants`. Seeding on only
 *  one means a recipe saved under one binary carries no grant row until the other
 *  happens to open the same file — and "which binary started last" is not a thing
 *  the owner's catalog should depend on.
 *
 *  ⚠ Counts BOOT PATHS, not files: the unit the rule applies to is "a place that
 *  reconciles owner grants at startup", so the next one added fails here rather
 *  than shipping a half-seeded install. */
/** D-247 open item 1 — THE OTHER HALF OF THE SEEDING RULE.
 *
 *  Recipe rows are written on the store's mutation seam plus an idempotent
 *  corpus pass, and are NEVER boot-reconciled. `reconcileOwnerGrants`
 *  materialises from COMPILED registries precisely because their id space
 *  changes only on a server update; recipes arrive at runtime, from seven
 *  producers.
 *
 *  ⛔⛔ A `recipe` row appearing in the reconcile would re-grant on EVERY BOOT
 *  what D14's purge removed and what an owner's revoke closed — silently, and on
 *  a schedule nobody looks at. The corpus pass survives that danger by being
 *  insert-if-absent over `store.ids()`; the reconcile would not, because it
 *  materialises from a registry rather than from what exists.
 *
 *  🔑 Asserted against what the reconcile WRITES, not against its source text: a
 *  future `for (const r of …) ensure(recipeGrantEntry(…))` fails here even if it
 *  spells the call some way a grep would miss. */
describe('D-247 open item 1 — the boot reconcile never touches the recipe kind', () => {
  let db: Database.Database;
  let contractStore: ReturnType<typeof createContractStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    contractStore = createContractStore(db, { now: () => 1_700_000_000_000 });
  });
  afterEach(() => db.close());

  it('⛔ a fresh reconcile writes ZERO `recipe.*` rows', () => {
    const result = reconcileOwnerGrants(contractStore, () => 1_700_000_000_000);
    // The reconcile must actually have done something, or "no recipe rows" is
    // vacuously true and this test is decoration.
    expect(result.seeded).toBeGreaterThan(0);
    const rows = createContractGrantEntryStore(contractStore).listForContract(
      OWNER_CONTRACT_ID,
    );
    expect(rows.length).toBe(result.seeded);
    const recipeRows = rows.filter((r) => isRecipeGrantEntry(r.entry_key));
    expect(recipeRows.map((r) => r.entry_key)).toEqual([]);
  });

  it('⛔⛔ and a SECOND reconcile does not resurrect a recipe grant the owner revoked', () => {
    // The failure this guards is not "the reconcile writes a recipe row once" —
    // it is that it would do so on every boot, undoing the owner each time.
    const grants = createContractGrantEntryStore(contractStore);
    const revoked = recipeGrantEntry('recued-core', 'refund-payment-square');
    grants.set(OWNER_CONTRACT_ID, revoked, false, 1_700_000_000_000);

    reconcileOwnerGrants(contractStore, () => 1_700_000_000_001);
    reconcileOwnerGrants(contractStore, () => 1_700_000_000_002);

    expect(grants.get(OWNER_CONTRACT_ID, revoked)).toBe(false);
  });
});

describe('D-247 — every boot path that reconciles owner grants also seeds recipes', () => {
  const BOOT_PATHS = [
    'backend/server/src/serve/compose-app-context.ts',
    'backend/server/src/cli-context/mcp.ts',
  ];

  it('both known boot paths call installRecipeGrantSeed', async () => {
    const { readFileSync } = await import('node:fs');
    for (const rel of BOOT_PATHS) {
      const src = readFileSync(new URL(`../../../../${rel}`, import.meta.url), 'utf8');
      // ⚠ WORD-BOUNDARY, not `toContain`. The first version of this assertion
      // used `toContain('installRecipeGrantSeed(')` and a mutation renaming the
      // call to `XinstallRecipeGrantSeed(` left it GREEN — the substring is still
      // there. A ratchet that cannot fail is worse than none, because it reads as
      // coverage.
      expect(src, `${rel} calls reconcileOwnerGrants`).toMatch(/\breconcileOwnerGrants\(/);
      expect(src, `${rel} must also seed recipe grants`).toMatch(/\binstallRecipeGrantSeed\(/);
    }
  });

  it('no OTHER file calls reconcileOwnerGrants without seeding', async () => {
    // The completion criterion: if someone adds a third boot path, this fails
    // rather than the catalog quietly being empty on that surface.
    const { execSync } = await import('node:child_process');
    const out = execSync(
      "grep -rln 'reconcileOwnerGrants(' --include='*.ts' backend/server/src | grep -v __tests__ | grep -v owner-grant-reconcile.ts || true",
      { encoding: 'utf8', cwd: new URL('../../../../', import.meta.url).pathname },
    ).trim();
    const callers = out.length === 0 ? [] : out.split('\n');
    expect(callers.sort()).toEqual([...BOOT_PATHS].sort());
  });
});

/** ⛔⛔ CODEX REVIEW FINDINGS 3 + 5 — the bundled shadow, and the stale publisher.
 *
 *  Both are cases where the seam's INPUT lied about what happened: `store.get`
 *  falls back to the bundled body after the row is deleted (so the purge branch
 *  was never taken), and the hook carries only an id (so a publisher change left
 *  the old address behind). Neither produced a failing test until one was written
 *  for it — the happy paths stayed green throughout. */
describe('D-247 — the seam’s two identity traps', () => {
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createRecipeStore>;
  let grants: ReturnType<typeof createContractGrantEntryStore>;
  let deps: { store: typeof store; grants: typeof grants; now: () => number };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd247-traps-'));
    db = new Database(':memory:');
    store = createRecipeStore(dir, db);
    grants = createContractGrantEntryStore(createContractStore(db, { now: () => NOW }));
    deps = { store, grants, now: () => NOW };
    installRecipeGrantSeed(deps);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('a pack row shadowing a BUNDLED recipe re-seeds from the bundle on delete', () => {
    // The pack-era grant must not survive over a different body. After uninstall
    // the server should sit where a never-installed one sits: the bundled body,
    // seeded from its own chat_exposed.
    store.save(recipe('shadowed', true), 'recued-core', 'pair-sync', NOW, 'pk');
    // The pack-era grant. Set explicitly because the in-memory `register` below
    // takes precedence over the DB row in `get`, so seeding it through the save
    // would assert the store's resolution order rather than this fix.
    grants.set(OWNER_CONTRACT_ID, KEY('shadowed'), true, NOW);
    store.register(recipe('shadowed'));                       // the bundled body, no flag
    store.delete('shadowed');                                  // pack uninstall
    // Still resolvable from the bundle — so NOT purged, but re-seeded closed.
    expect(store.get('shadowed')).not.toBeNull();
    expect(grants.get(OWNER_CONTRACT_ID, KEY('shadowed'))).toBe(false);
  });

  it('a publisher change clears the row at the OLD address', () => {
    store.save(recipe('moved', true), 'pub-a', 'pair-sync', NOW, 'pk');
    expect(grants.get(OWNER_CONTRACT_ID, 'recipe.pub-a/moved')).toBe(true);
    store.save(recipe('moved', true), 'pub-b', 'pair-sync', NOW, 'pk');
    // The old address must not linger — otherwise revoking the new identity and
    // saving back under the old one reattaches a `true` nobody decided.
    expect(grants.get(OWNER_CONTRACT_ID, 'recipe.pub-a/moved')).toBeUndefined();
    expect(grants.get(OWNER_CONTRACT_ID, 'recipe.pub-b/moved')).toBe(true);
  });
});

/** ⛔ CODEX REVIEW FINDING 4 — insert-if-absent was a read followed by an
 *  overwriting upsert, and the two boot paths share a WAL database. */
describe('D-247 — the seed write is atomic', () => {
  it('setIfAbsent does not overwrite a row written between the check and the write', () => {
    const db = new Database(':memory:');
    const grants = createContractGrantEntryStore(createContractStore(db, { now: () => NOW }));
    const key = KEY('racy');
    // Simulates the losing interleaving directly: the revoke lands first, and the
    // seed's write must be a no-op rather than an upsert.
    grants.set(OWNER_CONTRACT_ID, key, false, NOW);
    expect(grants.setIfAbsent(OWNER_CONTRACT_ID, key, true, NOW)).toBe(false);
    expect(grants.get(OWNER_CONTRACT_ID, key)).toBe(false);
    db.close();
  });

  it('setIfAbsent writes, and reports that it wrote, when nothing is there', () => {
    const db = new Database(':memory:');
    const grants = createContractGrantEntryStore(createContractStore(db, { now: () => NOW }));
    expect(grants.setIfAbsent(OWNER_CONTRACT_ID, KEY('fresh'), true, NOW)).toBe(true);
    expect(grants.get(OWNER_CONTRACT_ID, KEY('fresh'))).toBe(true);
    db.close();
  });
});

/** D-247 D15.1 — the install's chosen ACCESS CEILING reaches the seed.
 *
 *  ⛔⛔ THE ORDERING IS THE MECHANISM. The ordinary seed rides the store's
 *  mutation hook, which knows only a `recipe_id` — the install dialog's answer is
 *  nowhere in scope there. Writing FIRST, and letting the hook's
 *  insert-if-absent no-op afterwards, is what carries the answer across without
 *  threading ambient install state through the store. */
describe('D-247 D15.1 — the access ceiling gates the pack seed', () => {
  const packRecipe = (recipe_id: string, chat_exposed: boolean, op: string) => ({
    recipe_id,
    publisher_id: 'recued-core',
    recipe: {
      recipe_id, version: 1, ttl: 300, chat_exposed,
      metadata: { name: recipe_id, description: 'd', author: 'recued-core' },
      variables: {}, prefetch_steps: [],
      steps: [{ id: 's', op, input: {} }],
      output: { sidebar: [] },
    } as never,
  });

  const seedWith = (access: 'read' | 'write' | 'all', recipes: ReturnType<typeof packRecipe>[]) => {
    const db = new Database(':memory:');
    const grants = createContractGrantEntryStore(createContractStore(db, { now: () => NOW }));
    const dir = mkdtempSync(join(tmpdir(), 'd247-ceiling-'));
    const store = createRecipeStore(dir, db);
    seedPackRecipeGrants({ store, grants, now: () => NOW }, recipes, access);
    return {
      granted: (id: string) => grants.get(OWNER_CONTRACT_ID, KEY(id)),
      close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
    };
  };

  it('⛔ "Read only" does NOT enable a chat_exposed WRITE recipe', () => {
    // The defect this closes: the picker priced every recipe at read, so an
    // owner answering "Read only" could be handed a write — or a destructive —
    // tool they never agreed to make reachable.
    const h = seedWith('read', [packRecipe('sender', true, 'core.mail.send')]);
    expect(h.granted('sender')).toBe(false);
    h.close();
  });

  it('"+Write" enables it', () => {
    const h = seedWith('write', [packRecipe('sender', true, 'core.mail.send')]);
    expect(h.granted('sender')).toBe(true);
    h.close();
  });

  it('"Read only" still enables a chat_exposed READ recipe', () => {
    // The ceiling narrows; it must not close what the owner did agree to.
    const h = seedWith('read', [packRecipe('peeker', true, 'core.mail.get')]);
    expect(h.granted('peeker')).toBe(true);
    h.close();
  });

  it('a HIDDEN recipe stays closed at every tier — the flag is still the seed', () => {
    for (const tier of ['read', 'write', 'all'] as const) {
      const h = seedWith(tier, [packRecipe('quiet', false, 'core.mail.get')]);
      expect(h.granted('quiet'), tier).toBe(false);
      h.close();
    }
  });

  it('an UNDERIVABLE closure is not covered below "All" — unknown is not safe', () => {
    const dyn = packRecipe('dyn', true, 'core.mail.get');
    (dyn.recipe as { steps: unknown[] }).steps = [
      { id: 's', ingredient: '{{config.slug}}', input: {} },
    ];
    const low = seedWith('write', [dyn]);
    expect(low.granted('dyn')).toBe(false);
    low.close();
    const all = seedWith('all', [dyn]);
    expect(all.granted('dyn')).toBe(true);
    all.close();
  });

  it('⛔ INSERT-IF-ABSENT here too — a reinstall does not reopen an owner revoke', () => {
    const db = new Database(':memory:');
    const grants = createContractGrantEntryStore(createContractStore(db, { now: () => NOW }));
    const dir = mkdtempSync(join(tmpdir(), 'd247-ceiling2-'));
    const store = createRecipeStore(dir, db);
    grants.set(OWNER_CONTRACT_ID, KEY('peeker'), false, NOW);   // the owner said no
    seedPackRecipeGrants(
      { store, grants, now: () => NOW },
      [packRecipe('peeker', true, 'core.mail.get')],
      'all',
    );
    expect(grants.get(OWNER_CONTRACT_ID, KEY('peeker'))).toBe(false);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

/** ⛔⛔⛔ THE CORPUS PASS OVER A **BUNDLED** CORPUS — the case every test above
 *  missed, because they all used `store.save` (SQLite rows) where production is
 *  overwhelmingly bundled.
 *
 *  Measured on the real 2,264-recipe corpus before this was fixed: pass 1 wrote
 *  2,264 rows in 1.7s and pass 2 wrote all 2,264 AGAIN in 3.3s. Not idempotent at
 *  all — so every boot wiped the owner's revoke of a bundled recipe and reseeded
 *  the author default, and the boot cost O(recipes × grant-rows).
 *
 *  Cause: the purge-by-subject sweep ran for the BUNDLED case too, clearing the
 *  row it was about to re-add. Two correct-looking pieces composing into a lie —
 *  purge stale addresses, then seed — with nothing between them to notice. */
describe('D-247 — the corpus pass over BUNDLED recipes', () => {
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createRecipeStore>;
  let grants: ReturnType<typeof createContractGrantEntryStore>;
  let deps: { store: typeof store; grants: typeof grants; now: () => number };

  beforeEach(async () => {
    const { writeFileSync } = await import('node:fs');
    dir = mkdtempSync(join(tmpdir(), 'd247-bundled-corpus-'));
    // Real bundled recipes: files the store loads from its community dir. NOT
    // `register` (memoryOverrides), which has no production caller.
    writeFileSync(join(dir, 'shown.json'), JSON.stringify(recipe('shown', true)));
    writeFileSync(join(dir, 'hidden.json'), JSON.stringify(recipe('hidden', false)));
    db = new Database(':memory:');
    store = createRecipeStore(dir, db);
    grants = createContractGrantEntryStore(createContractStore(db, { now: () => NOW }));
    deps = { store, grants, now: () => NOW };
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('seeds bundled recipes on the first pass and writes NOTHING on the second', () => {
    expect(store.getStored('shown')).toBeNull();      // genuinely bundled
    expect(seedExistingRecipeCorpus(deps)).toBe(2);
    expect(grants.get(OWNER_CONTRACT_ID, KEY('shown'))).toBe(true);
    expect(grants.get(OWNER_CONTRACT_ID, KEY('hidden'))).toBe(false);
    // ⛔ The idempotence the marker was dropped in favour of. If this is >0 the
    // pass is rewriting rows every boot.
    expect(seedExistingRecipeCorpus(deps)).toBe(0);
  });

  it('⛔ an owner REVOKE of a bundled recipe survives the next boot', () => {
    // The security-direction failure: a revoke silently reopened on restart.
    seedExistingRecipeCorpus(deps);
    grants.set(OWNER_CONTRACT_ID, KEY('shown'), false, NOW);
    seedExistingRecipeCorpus(deps);
    expect(grants.get(OWNER_CONTRACT_ID, KEY('shown'))).toBe(false);
  });

  it('⛔ an owner GRANT of a hidden bundled recipe survives too', () => {
    seedExistingRecipeCorpus(deps);
    grants.set(OWNER_CONTRACT_ID, KEY('hidden'), true, NOW);
    seedExistingRecipeCorpus(deps);
    expect(grants.get(OWNER_CONTRACT_ID, KEY('hidden'))).toBe(true);
  });

  it('the pass does not clear a row it is about to re-add', () => {
    // Directly pins the composed-lie shape: purge-then-seed left the row absent
    // between the two steps, so any observer mid-pass saw it gone.
    seedExistingRecipeCorpus(deps);
    const before = grants.listForContract(OWNER_CONTRACT_ID).length;
    seedExistingRecipeCorpus(deps);
    expect(grants.listForContract(OWNER_CONTRACT_ID)).toHaveLength(before);
  });
});
