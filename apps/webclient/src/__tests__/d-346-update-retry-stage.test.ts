/** D-346 C — a staged update refused for a pack it needs ("Install every dependency
 *  separately first…", `preparePackUpdate`) is tried again when the owner comes back
 *  from installing that pack with its row's Install… (`retryStage`, which the packs
 *  panel calls on the way back, `returnFromDependency`). A refused staging records
 *  nothing on the server, so the same request is simply asked again. */
import { describe, expect, it, vi } from 'vitest';
import { RpcError, type PackUpdateStage, type PackUpdateView } from '@recued/contracts';

import { createPackUpdatePanel } from '../settings/pack-update-panel.js';
import type { PackUpdateCaller } from '../settings/pack-update-caller.js';
import { FakeEl, allOf, settle } from '../kitchen/__tests__/kitchen-fake-dom.js';

/** The kitchen fake, with the little more this panel touches. */
class PanelEl extends FakeEl {
  tabIndex = 0;
  querySelector(): null { return null; }
  focus(): void {}
}
const doc = { createElement: (tag: string) => new PanelEl(tag) } as unknown as Document;

const HASH = 'a'.repeat(64);
const view = (over: Partial<PackUpdateView> = {}): PackUpdateView => ({
  pack_slug: 'invoice-book', managed: false, revision: 0, installed_version: 1,
  candidate: null, qualification: null, applied: false, ...over,
});
const staged = view({
  revision: 1,
  candidate: { version: 2, name: 'Invoice Book', manifest_hash: HASH, digest: 'd', source: 'bundled', recipes: [] },
});

const buttonNamed = (root: FakeEl, text: string): (FakeEl & { onclick?: () => void }) | undefined =>
  allOf(root).find((el) => el.tag === 'button' && el.textContent === text) as (FakeEl & { onclick?: () => void }) | undefined;
const statusOf = (root: FakeEl): string | undefined =>
  allOf(root).find((el) => el.attrs.has('data-pack-update-status'))?.textContent;

describe('D-346 C — retryStage', () => {
  it('tries a refused staging again, with the same request, once; nothing when none was refused', async () => {
    const stages: PackUpdateStage[] = [];
    let refuse = true;
    const caller = {
      get: vi.fn(async () => view()),
      stage: vi.fn(async (args: PackUpdateStage) => {
        stages.push(structuredClone(args));
        if (refuse) {
          throw new RpcError('pack_update_unsupported',
            'Install every dependency separately first; grouped updates require newer versions of installed packs from the same publishers.', 409);
        }
        return staged;
      }),
    } as unknown as PackUpdateCaller;
    const panel = createPackUpdatePanel({
      document: doc, packSlug: 'invoice-book', manifestHash: HASH, source: 'bundled', managed: false,
      caller, changed: () => {},
    });
    const root = panel.element as unknown as FakeEl;
    await settle();

    // Nothing refused yet: the way back retries nothing.
    panel.retryStage();
    await settle();
    expect(stages).toHaveLength(0);

    buttonNamed(root, 'Stage update and protect pack')!.onclick!();
    await settle();
    expect(stages).toHaveLength(1);
    expect(statusOf(root)).toContain('Install every dependency separately first');
    expect(buttonNamed(root, 'Retry staging update')).toBeDefined();

    // The owner installed the pack it named, with Install…, and came back.
    refuse = false;
    panel.retryStage();
    await settle();
    expect(stages).toHaveLength(2);
    expect(stages[1]).toEqual(stages[0]);
    expect(statusOf(root)).toContain('Update staged.');

    // Staged: nothing left to retry.
    panel.retryStage();
    await settle();
    expect(stages).toHaveLength(2);
    panel.dispose();
  });
});
