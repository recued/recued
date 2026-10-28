/** D-333 — Kitchen home: start something, or pick up work in progress from anywhere. */
import { describe, expect, it, vi } from 'vitest';
import type { IngredientDraftSummary, KitchenWorkItem } from '@recued/contracts';
import { editedAgo, KITCHEN_HOME_ITEM_ATTR, mountKitchenHomeRoute } from '../kitchen-home-route.js';
import { allOf, byText, FakeEl, fakeDocument, rpcError, settle, statusOf } from './kitchen-fake-dom.js';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const work = (over: Partial<KitchenWorkItem>): KitchenWorkItem => ({
  draft_id: 'w1', kind: 'recipe', title: 'Morning briefing', revision: 3, created_at: NOW - 600_000,
  updated_at: NOW - 120_000, from: 'Kitchen', ready: true, problems: 0, ...over,
});
const pack = (over: Partial<IngredientDraftSummary>): IngredientDraftSummary => ({
  draft_id: 'p1', title: 'Bookings', slug: 'bookings', surface: null, operation_count: 2,
  created_at: NOW - 7_200_000, updated_at: NOW - 3_600_000, ...over,
});
const rows = (root: FakeEl): FakeEl[] => allOf(root).filter((el) => el.attrs.has(KITCHEN_HOME_ITEM_ATTR));

const mount = (over: {
  items?: KitchenWorkItem[]; drafts?: IngredientDraftSummary[];
  listWork?: () => Promise<{ items: KitchenWorkItem[] }>;
  confirm?: () => boolean;
} = {}) => {
  const root = new FakeEl('main');
  const discardWork = vi.fn(async () => ({ discarded: true }));
  const discardPack = vi.fn(async () => ({ ok: true }));
  mountKitchenHomeRoute({
    root: root as unknown as HTMLElement,
    listWork: over.listWork ?? (async () => ({ items: over.items ?? [] })),
    listPacks: async () => ({ drafts: over.drafts ?? [] }),
    discardWork, discardPack,
    confirm: over.confirm ?? (() => true),
    now: () => NOW,
    document: fakeDocument(),
  });
  return { root, discardWork, discardPack };
};

describe('Kitchen home (D-333)', () => {
  it('starts new work and points at the saved things, not at drafts', async () => {
    const { root } = mount();
    expect(byText(root, 'a', 'New recipe').getAttribute('href')).toBe('#kitchen/new/recipe');
    expect(byText(root, 'a', 'New pack').getAttribute('href')).toBe('#kitchen/pack');
    expect(byText(root, 'a', 'Recipes').getAttribute('href')).toBe('#recipes');
    expect(byText(root, 'a', 'Packs').getAttribute('href')).toBe('#packs');
    await settle();
    expect(statusOf(root)).toBe('Nothing in progress.');
    expect(allOf(root).some((el) => el.tag === 'h2')).toBe(false);
  });

  it('lists work in progress from every origin, newest first, by what it is and who started it', async () => {
    const { root } = mount({
      items: [
        work({}),
        work({ draft_id: 'w2', title: 'HubSpot follow-ups', from: 'VS Code', updated_at: NOW - 86_400_000 - 3_600_000, ready: false, problems: 3 }),
      ],
      drafts: [pack({})],
    });
    await settle();
    const listed = rows(root);
    expect(listed.map((row) => row.attrs.get(KITCHEN_HOME_ITEM_ATTR))).toEqual(['work:w1', 'pack:p1', 'work:w2']);
    expect(listed[0]!.textContent).toContain('New recipe · edited 2 min ago');
    expect(listed[0]!.textContent).toContain('Ready to save');
    expect(listed[1]!.textContent).toContain('New pack · edited 1 h ago');
    expect(listed[2]!.textContent).toContain('From VS Code · edited yesterday');
    expect(listed[2]!.textContent).toContain('3 problems to fix');
    expect(byText(listed[0]!, 'a', 'Continue').getAttribute('href')).toBe('#kitchen/import/w1');
    expect(byText(listed[1]!, 'a', 'Continue').getAttribute('href')).toBe('#kitchen/pack/p1');
  });

  it('labels a draft of changes to an installed pack', async () => {
    const { root } = mount({ drafts: [pack({ draft_id: 'p2', title: 'Acme CRM', base_pack_slug: 'acme-crm' })] });
    await settle();
    const [row] = rows(root);
    expect(row!.textContent).toContain('Changes to your pack · edited 1 h ago');
    expect(byText(row!, 'a', 'Continue').getAttribute('href')).toBe('#kitchen/pack/p2');
  });

  it('continues changes to a saved recipe on the recipe itself', async () => {
    const { root } = mount({ items: [work({ draft_id: 'w3', title: 'Daily brief', base: { recipe_id: 'daily-brief', version: 2 } })] });
    await settle();
    const [row] = rows(root);
    expect(row!.textContent).toContain('Changes to your recipe · edited 2 min ago');
    expect(byText(row!, 'a', 'Continue').getAttribute('href')).toBe('#kitchen/recipe/daily-brief');
  });

  it('discards an item from either store after confirming, and says when nothing is left', async () => {
    const { root, discardWork, discardPack } = mount({ items: [work({})], drafts: [pack({})] });
    await settle();
    byText(rows(root)[0]!, 'button', 'Discard').click();
    await settle();
    expect(discardWork).toHaveBeenCalledWith('w1', 3);
    byText(rows(root)[0]!, 'button', 'Discard').click();
    await settle();
    expect(discardPack).toHaveBeenCalledWith('p1');
    expect(rows(root)).toHaveLength(0);
    expect(statusOf(root)).toBe('Nothing in progress.');
  });

  it('keeps the item when the owner cancels', async () => {
    const { root, discardWork } = mount({ items: [work({})], confirm: () => false });
    await settle();
    byText(rows(root)[0]!, 'button', 'Discard').click();
    await settle();
    expect(discardWork).not.toHaveBeenCalled();
    expect(rows(root)).toHaveLength(1);
  });

  it('still shows pack work on a server without the In progress list', async () => {
    const { root } = mount({ listWork: async () => { throw rpcError('unknown_method'); }, drafts: [pack({})] });
    await settle();
    expect(rows(root).map((row) => row.attrs.get(KITCHEN_HOME_ITEM_ATTR))).toEqual(['pack:p1']);
  });

  it('words the age coarsely', () => {
    expect(editedAgo(NOW - 5_000, NOW)).toBe('edited just now');
    expect(editedAgo(NOW - 90_000, NOW)).toBe('edited 2 min ago');
    expect(editedAgo(NOW - 5 * 3_600_000, NOW)).toBe('edited 5 h ago');
    expect(editedAgo(NOW - 30 * 3_600_000, NOW)).toBe('edited yesterday');
  });
});
