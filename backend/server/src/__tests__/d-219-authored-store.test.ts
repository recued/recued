/** D-219 — the authored-recipe link store.
 *
 *  The question this answers: the owner turns a learned case into a recipe, and
 *  nothing anywhere records that it happened. So the list cannot say "you
 *  already made one of these", and the case keeps reaching the model as
 *  precedent after a recipe exists that does the job properly.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createExecutionCaseAuthoredStore,
  ensureExecutionCaseAuthoredSchema,
  recordAuthoredLink,
  resolveAuthoredState,
} from '../storage/execution-case-authored-store.js';

const open = () => new Database(':memory:');
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const store = () => {
  const db = open();
  dbs.push(db);
  return { db, store: createExecutionCaseAuthoredStore(db) };
};

const link = (over: Partial<Parameters<
  ReturnType<typeof store>['store']['record']
>[0]> = {}) => ({
  case_key: 'key_alpha',
  recipe_id: 'weekly-summary',
  recipe_hash: 'sha-1',
  authored_at: 1_000,
  ...over,
});

describe('D-219 — authored-recipe links', () => {
  it('records a link and reads it back for the case', () => {
    const f = store();
    f.store.record(link());
    expect(f.store.listForKey('key_alpha')).toEqual([link()]);
    expect(f.store.listForKey('key_other')).toEqual([]);
  });

  it('⛔ is idempotent per (case_key, recipe_id) — re-saving is not a second recipe', () => {
    // The owner edits the draft and saves again. That is the SAME authored
    // thing, at a new hash; accumulating rows would make the panel claim they
    // made three recipes from one case.
    const f = store();
    f.store.record(link());
    f.store.record(link({ recipe_hash: 'sha-2', authored_at: 2_000 }));
    const rows = f.store.listForKey('key_alpha');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipe_hash).toBe('sha-2');
    expect(rows[0]!.authored_at).toBe(2_000);
  });

  it('keeps genuinely different recipes from the same case', () => {
    // The permitting witness for the idempotence above: without it that test
    // would pass against a store that only ever holds one row per case.
    const f = store();
    f.store.record(link());
    f.store.record(link({ recipe_id: 'monthly-summary', authored_at: 3_000 }));
    expect(f.store.listForKey('key_alpha').map((row) => row.recipe_id))
      .toEqual(['weekly-summary', 'monthly-summary']);
  });

  it('reads many cases in one pass, omitting those with no link', () => {
    const f = store();
    f.store.record(link());
    f.store.record(link({ case_key: 'key_beta', recipe_id: 'r2' }));
    const found = f.store.listForKeys(['key_alpha', 'key_beta', 'key_none']);
    expect([...found.keys()].sort()).toEqual(['key_alpha', 'key_beta']);
    expect(found.get('key_none')).toBeUndefined();
  });

  it('⛔ the PROVENANCE guard: a draft must have been issued for the case', () => {
    // ⛔⛔ THE HOLE THIS CLOSES. Verifying that a case and a recipe each EXIST is
    // not verifying that one came from the other — a paired script could pair
    // any two and Settings would report it as authored. `wasDrafted` makes the
    // claim cost a real model call, which is the part a script cannot fake.
    const f = store();
    expect(f.store.wasDrafted('key_alpha')).toBe(false);
    f.store.recordDraftIssued('key_alpha', 500);
    expect(f.store.wasDrafted('key_alpha')).toBe(true);
    // ⚠ Permitting witness: it is PER CASE, not a global "some draft happened".
    expect(f.store.wasDrafted('key_beta')).toBe(false);
  });

  it('⚠ is NOT one-shot — the owner may edit and save repeatedly', () => {
    // Each save is the same authored thing at a new hash. Consuming the fact on
    // first use would silently stop annotating every save after the first.
    const f = store();
    f.store.recordDraftIssued('key_alpha', 500);
    f.store.record(link());
    expect(f.store.wasDrafted('key_alpha')).toBe(true);
    f.store.record(link({ recipe_hash: 'sha-2' }));
    expect(f.store.wasDrafted('key_alpha')).toBe(true);
  });

  it('survives re-ensure, and keeps the drafted fact', () => {
    const f = store();
    f.store.recordDraftIssued('key_alpha', 500);
    ensureExecutionCaseAuthoredSchema(f.db);
    expect(f.store.wasDrafted('key_alpha')).toBe(true);
  });

  it('⛔⛔ carries NO explicit index — A22 pending the D-213 §6.4 bar', () => {
    // ⛔ `d-214-execution-case-integration` ratchets that nothing matching
    // `%execution_case%` has an index other than `sqlite_autoindex%`, and no
    // FTS/virtual table. This asserts the same thing at the source, so adding a
    // `CREATE INDEX` here fails in the file that added it rather than in a
    // suite three directories away.
    const f = store();
    const objects = f.db.prepare(`
      SELECT type, name, sql FROM sqlite_master
       WHERE name LIKE '%execution_case_authored%'
          OR name LIKE '%execution_case_drafted%'
    `).all() as Array<{ type: string; name: string; sql: string | null }>;
    // The table itself is there — otherwise this passes vacuously.
    expect(objects.some((row) => row.type === 'table')).toBe(true);
    expect(objects.filter((row) =>
      row.type === 'index' && !row.name.startsWith('sqlite_autoindex')))
      .toEqual([]);
    expect(objects.some((row) =>
      /fts|virtual table|tokenize/iu.test(row.sql ?? ''))).toBe(false);
  });

  it('is safe to ensure twice — boot runs it on an existing realm', () => {
    const f = store();
    f.store.record(link());
    expect(() => ensureExecutionCaseAuthoredSchema(f.db)).not.toThrow();
    // ⚠ And it does not truncate: `IF NOT EXISTS` must not be a reset.
    expect(f.store.listForKey('key_alpha')).toHaveLength(1);
  });

  it('deleteForKey drops only that case\'s links', () => {
    const f = store();
    f.store.record(link());
    f.store.record(link({ case_key: 'key_beta', recipe_id: 'r2' }));
    expect(f.store.deleteForKey('key_alpha')).toBe(1);
    expect(f.store.listForKey('key_alpha')).toEqual([]);
    expect(f.store.listForKey('key_beta')).toHaveLength(1);
  });
});

describe('D-219 — recordAuthoredLink, the guard the composition delegates to', () => {
  const rig = (over: { drafted?: boolean; caseKey?: string | undefined;
    hash?: string | undefined } = {}) => {
    const f = store();
    if (over.drafted !== false) f.store.recordDraftIssued('key_alpha', 500);
    return {
      f,
      deps: {
        loadCaseKey: async () => ('caseKey' in over ? over.caseKey : 'key_alpha'),
        loadRecipeHash: () => ('hash' in over ? over.hash : 'sha-live'),
        store: f.store,
        now: () => 9_000,
      },
    };
  };

  it('records when the case was drafted from, with the SERVER\'s hash', async () => {
    const r = rig();
    expect(await recordAuthoredLink(r.deps as never,
      { case_id: 'c', recipe_id: 'weekly' })).toEqual({ recorded: true });
    expect(r.f.store.listForKey('key_alpha')).toEqual([{
      case_key: 'key_alpha', recipe_id: 'weekly',
      recipe_hash: 'sha-live', authored_at: 9_000,
    }]);
  });

  it('⛔⛔ REFUSES when no draft was ever issued for the case', async () => {
    // ⛔ The mutation that survived before this existed. The store test proved
    // `wasDrafted` worked and the dispatch test used a stubbed dep, so deleting
    // the check from the composition left everything green. This is the witness.
    const r = rig({ drafted: false });
    expect(await recordAuthoredLink(r.deps as never,
      { case_id: 'c', recipe_id: 'weekly' })).toEqual({ recorded: false });
    expect(r.f.store.listForKey('key_alpha')).toEqual([]);
  });

  it('refuses a missing case, and a missing recipe, without throwing', async () => {
    // ⚠ Never a throw: the save already happened. Losing an annotation must not
    // surface to the owner as losing their recipe.
    const noCase = rig({ caseKey: undefined });
    await expect(recordAuthoredLink(noCase.deps as never,
      { case_id: 'c', recipe_id: 'weekly' })).resolves.toEqual({ recorded: false });
    const noRecipe = rig({ hash: undefined });
    await expect(recordAuthoredLink(noRecipe.deps as never,
      { case_id: 'c', recipe_id: 'gone' })).resolves.toEqual({ recorded: false });
  });
});

describe('D-219 — the stored hash is READ, not just written', () => {
  it('resolves unchanged / edited / gone against the live recipe', () => {
    // ⛔ The hash was WRITE-ONLY: the store claimed it told "the recipe you made"
    // from "a recipe of that name today", and nothing ever compared it — so a
    // deleted recipe left an annotation the owner could not act on.
    const link = { recipe_id: 'weekly', recipe_hash: 'sha-1' };
    expect(resolveAuthoredState(link, () => 'sha-1')).toBe('unchanged');
    expect(resolveAuthoredState(link, () => 'sha-2')).toBe('edited');
    // ⚠ `gone` is the one that matters: the annotation is actively misleading
    // on its own when the recipe is not there any more.
    expect(resolveAuthoredState(link, () => undefined)).toBe('gone');
  });
});
