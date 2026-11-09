/** D-346 B — the reviewed removal of a pack other packs use warns what stops,
 *  by pack and by action, and until when (ruling 2). The server names them
 *  (`PackRemovalPlan.stops`); this is the sentence the review shows before the
 *  confirm. */
import { describe, expect, it } from 'vitest';
import type { PackRemovalPlan } from '@recued/contracts';

import { removalStopsWarning } from '../settings/pack-removal-review.js';

const pack = { inventory_key: 'github-repos', pack_slug: 'github-repos', publisher: 'recued-core' };

describe('removalStopsWarning', () => {
  it('says what stops, by pack and by action, in names where the server has them', () => {
    const plan: Pick<PackRemovalPlan, 'pack' | 'stops'> = {
      pack,
      stops: [
        { pack_slug: 'codex-issue-pipeline', name: 'Codex Issue Pipeline', actions: [
          { recipe_id: 'work-github-issues', name: 'Work GitHub issues' },
          { recipe_id: 'close-done-issues' },
        ] },
        { pack_slug: 'lists-only', actions: [] },
        { pack_slug: null, actions: [{ recipe_id: 'my-check', name: 'My own check' }] },
      ],
    };
    expect(removalStopsWarning(plan)).toEqual({
      lead: 'Removing github-repos stops these actions until you install it again. Their packs’ other actions keep working.',
      items: [
        'Codex Issue Pipeline: Work GitHub issues, close-done-issues',
        'lists-only: lists it as a pack it needs, with no action that calls it',
        'Your own recipes: My own check',
      ],
    });
  });

  it('says nothing when nothing stops, or from a server before D-346, which blocks instead', () => {
    expect(removalStopsWarning({ pack, stops: [] })).toBeNull();
    expect(removalStopsWarning({ pack })).toBeNull();
  });
});
