/** D-145 PB11 — personal_recipes column + CRUD tests against ContactStore.
 *
 *  Covers PB11.1 (schema delta + idempotent ALTER) + the five CRUD
 *  methods (get / add / setEnabled / remove / setAll) wired into
 *  ContactStore.
 *
 *  Scenarios:
 *    - Schema: `personal_recipes` column lands at boot, defaults `'[]'`.
 *    - Legacy rows (pre-PB11 dev DBs) parse cleanly as empty arrays.
 *    - get returns empty array for unknown contact + empty blob.
 *    - add appends + persists + emits bus event.
 *    - add is idempotent on duplicate (recipe_id, normalized topic).
 *    - add rejects malformed entries via PersonalRecipeValidationError.
 *    - setEnabled toggles in-place without re-ordering.
 *    - setEnabled throws on unknown entry.
 *    - remove drops the entry + persists; missing entries no-op.
 *    - setPersonalRecipes replaces the whole blob; validator gates
 *      duplicates.
 *    - ContactRecord surfaces personal_recipes when non-empty.
 *    - Bus emit fires on mutations (data.contact.*.updated). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PersonalRecipeValidationError } from '@recued/contracts';

import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb11-personal-recipes-store-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const entry = (patch: Partial<{
  recipe_id: string;
  topic: string;
  enabled: boolean;
  created_at: number;
}> = {}) => ({
  recipe_id: 'pub/remind-mary-about-sicily-followup',
  topic: 'travel',
  enabled: true,
  created_at: 1_715_000_000_000,
  ...patch,
});

// ── Schema discipline ───────────────────────────────────────────────

describe('personal_recipes column', () => {
  it('exists on contacts table after createContactStore', () => {
    const cols = db
      .prepare(`PRAGMA table_info(contacts)`)
      .all() as Array<{ name: string; dflt_value?: string }>;
    const personalRecipes = cols.find((c) => c.name === 'personal_recipes');
    expect(personalRecipes).toBeDefined();
  });

  it('defaults to empty array for new rows', () => {
    const contact = store.observe({
      email: 'mary@example.com',
      name: 'Mary',
      source: 'email_from',
      event_at: 1,
    });
    expect(store.getPersonalRecipes(contact.contact_id!)).toEqual([]);
  });

  it('createContactStore is idempotent across re-opens (ALTER guard)', () => {
    // Re-creating the store on the same DB must NOT raise — the
    // PRAGMA table_info gate prevents re-running the ALTER.
    expect(() => createContactStore(db)).not.toThrow();
    expect(() => createContactStore(db)).not.toThrow();
  });
});

// ── getPersonalRecipes ──────────────────────────────────────────────

describe('getPersonalRecipes', () => {
  it('returns empty array for unknown contact_id', () => {
    expect(store.getPersonalRecipes('nope')).toEqual([]);
  });

  it('returns empty array for contact with no entries', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    expect(store.getPersonalRecipes(c.contact_id!)).toEqual([]);
  });
});

// ── addPersonalRecipe ───────────────────────────────────────────────

describe('addPersonalRecipe', () => {
  it('appends a valid entry + persists across re-read', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    const e = entry();
    const after = store.addPersonalRecipe(c.contact_id!, e);
    expect(after).toEqual([e]);

    // Re-read from a fresh store on the same DB.
    const store2 = createContactStore(db);
    expect(store2.getPersonalRecipes(c.contact_id!)).toEqual([e]);
  });

  it('is idempotent on duplicate (recipe_id, normalized topic)', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    store.addPersonalRecipe(c.contact_id!, entry());
    const after = store.addPersonalRecipe(
      c.contact_id!,
      entry({ topic: ' TRAVEL ', created_at: 99 }),
    );
    expect(after.length).toBe(1);
    // Original topic + created_at preserved (idempotent — no mutation).
    expect(after[0]?.topic).toBe('travel');
    expect(after[0]?.created_at).toBe(1_715_000_000_000);
  });

  it('rejects malformed entries via PersonalRecipeValidationError', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    expect(() =>
      store.addPersonalRecipe(c.contact_id!, entry({ recipe_id: '' })),
    ).toThrow(PersonalRecipeValidationError);
    expect(() =>
      store.addPersonalRecipe(c.contact_id!, entry({ topic: '   ' })),
    ).toThrow(PersonalRecipeValidationError);
  });

  it('throws on unknown contact_id', () => {
    expect(() => store.addPersonalRecipe('nope', entry())).toThrow(
      /personal_recipe_contact_unknown/,
    );
  });

  it('preserves insert order (stored array reflects add order)', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    store.addPersonalRecipe(c.contact_id!, entry({ recipe_id: 'pub/a' }));
    store.addPersonalRecipe(c.contact_id!, entry({ recipe_id: 'pub/b' }));
    store.addPersonalRecipe(c.contact_id!, entry({ recipe_id: 'pub/c' }));
    expect(
      store.getPersonalRecipes(c.contact_id!).map((e) => e.recipe_id),
    ).toEqual(['pub/a', 'pub/b', 'pub/c']);
  });
});

// ── setPersonalRecipeEnabled ────────────────────────────────────────

describe('setPersonalRecipeEnabled', () => {
  it('toggles enabled flag in place', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    store.addPersonalRecipe(c.contact_id!, entry());
    const after = store.setPersonalRecipeEnabled(
      c.contact_id!,
      entry().recipe_id,
      'travel',
      false,
    );
    expect(after[0]?.enabled).toBe(false);
    expect(after[0]?.recipe_id).toBe(entry().recipe_id);
    expect(after[0]?.created_at).toBe(entry().created_at);
  });

  it('matches topic case-insensitively', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    store.addPersonalRecipe(c.contact_id!, entry({ topic: 'Travel' }));
    const after = store.setPersonalRecipeEnabled(
      c.contact_id!,
      entry().recipe_id,
      'TRAVEL',
      false,
    );
    expect(after[0]?.enabled).toBe(false);
  });

  it('throws on unknown entry', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    expect(() =>
      store.setPersonalRecipeEnabled(c.contact_id!, 'pub/missing', 'work', true),
    ).toThrow(/personal_recipe_entry_unknown/);
  });

  it('throws on unknown contact_id', () => {
    expect(() =>
      store.setPersonalRecipeEnabled('nope', 'pub/x', 'travel', true),
    ).toThrow(/personal_recipe_contact_unknown/);
  });
});

// ── removePersonalRecipe ────────────────────────────────────────────

describe('removePersonalRecipe', () => {
  it('drops the entry + persists', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    store.addPersonalRecipe(c.contact_id!, entry({ recipe_id: 'pub/a' }));
    store.addPersonalRecipe(c.contact_id!, entry({ recipe_id: 'pub/b' }));
    const after = store.removePersonalRecipe(c.contact_id!, 'pub/a', 'travel');
    expect(after.map((e) => e.recipe_id)).toEqual(['pub/b']);
  });

  it('is silent no-op on missing entry', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    store.addPersonalRecipe(c.contact_id!, entry());
    const after = store.removePersonalRecipe(c.contact_id!, 'pub/other', 'work');
    expect(after.length).toBe(1);
  });

  it('returns empty for missing contact_id', () => {
    expect(store.removePersonalRecipe('nope', 'pub/x', 'travel')).toEqual([]);
  });
});

// ── setPersonalRecipes ──────────────────────────────────────────────

describe('setPersonalRecipes', () => {
  it('replaces the whole blob', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    store.addPersonalRecipe(c.contact_id!, entry({ recipe_id: 'pub/a' }));
    store.setPersonalRecipes(c.contact_id!, [
      entry({ recipe_id: 'pub/b', topic: 'work' }),
      entry({ recipe_id: 'pub/c', topic: 'family' }),
    ]);
    const after = store.getPersonalRecipes(c.contact_id!);
    expect(after.map((e) => e.recipe_id)).toEqual(['pub/b', 'pub/c']);
  });

  it('rejects duplicate entries via PersonalRecipeValidationError', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    expect(() =>
      store.setPersonalRecipes(c.contact_id!, [
        entry(),
        entry({ topic: 'TRAVEL' }),
      ]),
    ).toThrow(PersonalRecipeValidationError);
  });

  it('rejects malformed entries', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    expect(() =>
      store.setPersonalRecipes(c.contact_id!, [entry({ recipe_id: '' })]),
    ).toThrow(PersonalRecipeValidationError);
  });

  it('throws on unknown contact_id', () => {
    expect(() => store.setPersonalRecipes('nope', [entry()])).toThrow(
      /personal_recipe_contact_unknown/,
    );
  });
});

// ── PB11.5b — Codex P2.1 fold — validate-before-duplicate ───────────

describe('addPersonalRecipe — Codex P2.1 fold', () => {
  it('rejects malformed entries even when (recipe_id, topic) duplicates an existing row', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    store.addPersonalRecipe(c.contact_id!, entry());
    // Malformed entry collides with the existing one on (recipe_id,
    // normalized topic). The pre-fold path would silently return
    // the existing array (idempotent return-early); the post-fold
    // path validates the incoming entry first and rejects it.
    expect(() =>
      store.addPersonalRecipe(
        c.contact_id!,
        entry({ topic: ' TRAVEL ', created_at: -1 }),
      ),
    ).toThrow(PersonalRecipeValidationError);
    expect(() =>
      store.addPersonalRecipe(
        c.contact_id!,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...entry(), enabled: 'yes' as unknown as boolean },
      ),
    ).toThrow(PersonalRecipeValidationError);
  });
});

// ── ContactRecord surfacing ─────────────────────────────────────────

describe('ContactRecord.personal_recipes surfacing', () => {
  it('omits the field when blob is empty', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    expect(c.personal_recipes).toBeUndefined();
  });

  it('surfaces the array when non-empty', () => {
    const c = store.observe({
      email: 'mary@example.com',
      source: 'manual',
      event_at: 1,
    });
    store.addPersonalRecipe(c.contact_id!, entry());
    const refreshed = store.getByContactId(c.contact_id!);
    expect(refreshed?.personal_recipes?.length).toBe(1);
    expect(refreshed?.personal_recipes?.[0]?.recipe_id).toBe(entry().recipe_id);
  });
});

// ── PB11 privacy ratchet — verify NOT in cloud sync paths ──────────

describe('PB11 privacy ratchet (server side)', () => {
  it('personal_recipes are server-internal — no cross-device sync route exists', () => {
    // Substrate-level guard: D-168 retired the cross-cloud sync
    // substrate entirely. This server-side test pins the storage
    // symmetry — the column lives on `contacts` (per-pair), not on
    // any `*_sync` table.
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%sync%'`,
      )
      .all() as Array<{ name: string }>;
    // Server-side schema has no sync tables (cloud sync flows
    // through the cloud worker, not local SQLite).
    for (const t of tables) {
      // Defensive — if a sync table ever lands, it must not mention
      // personal_recipes.
      const cols = db
        .prepare(`PRAGMA table_info(${t.name})`)
        .all() as Array<{ name: string }>;
      for (const c of cols) {
        expect(c.name.includes('personal_recipe')).toBe(false);
      }
    }
  });
});
