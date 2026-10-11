/** D-247 D15.1's install seed, over a pack recipe as install stores it: LOWERED.
 *
 *  ⛔⛔ WHY THIS EXISTS (2026-10-10). A door's grants now name a kernel step's `core.*`
 *  op, so a door built from a LOWERED recipe grants what the op-admission gate checks.
 *  That is a DOOR rule (`deriveResolvedRecipeCapability` opts in), and it must stay one.
 *  The install seed prices a recipe with `recipeTopRisk`, which derives with no catalog
 *  resolver, so a lowered recipe's catalog steps contribute no op there. Recording its
 *  kernel steps alone would price "read the mail, then unlock the front door" by the
 *  mail read — `read` — and "Read only" would switch on a recipe that unlocks a door.
 *  Unknown is not safe; a partial answer is worse. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  kernelOpBackingSlug,
  OWNER_CONTRACT_ID,
  recipeGrantEntry,
  type RecipeDefinition,
} from '@recued/contracts';

import { recipeTopRisk } from '../pack-install-preview.js';
import { createRecipeStore } from '../recipe-store.js';
import { seedPackRecipeGrants } from '../recipe-grant-seed.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractStore } from '../storage/contract-store.js';

const NOW = 1_760_000_000_000;
const MAIL_GET = kernelOpBackingSlug('core.mail.get')!;
// "Read the mail, then unlock the front door", lowered as a pack install stores it: the
// kernel step as its backing slug, the Home Assistant step as its catalog fetch.
const UNLOCKER = {
  recipe_id: 'mail-then-unlock',
  version: 1,
  ttl: 300,
  chat_exposed: true,
  metadata: { name: 'Mail, then unlock', description: 'd', author: 'recued-core' },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'mail', ingredient: MAIL_GET, input: { record_id: '{{context.mail}}' } },
    { id: 'unlock', ingredient: 'home-assistant', input: { operation: 'lock.unlock', args: { entity_id: 'lock.front' } } },
  ],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

describe('the install seed prices a lowered pack recipe', () => {
  it('never as read only when a catalog step it cannot see could write', () => {
    expect(MAIL_GET).toBe('mail-get');
    expect(recipeTopRisk(UNLOCKER, () => undefined)).not.toBe('read');

    const db = new Database(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'install-seed-lowered-'));
    cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    const grants = createContractGrantEntryStore(createContractStore(db, { now: () => NOW }));
    const store = createRecipeStore(dir, db);
    seedPackRecipeGrants(
      { store, grants, now: () => NOW },
      [{ recipe_id: UNLOCKER.recipe_id, publisher_id: 'recued-core', recipe: UNLOCKER }],
      'read',
    );
    expect(grants.get(OWNER_CONTRACT_ID, recipeGrantEntry('recued-core', UNLOCKER.recipe_id))).toBe(false);
  });
});
