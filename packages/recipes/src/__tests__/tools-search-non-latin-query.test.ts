import { describe, expect, it } from 'vitest';
import type { ToolEntry } from '@recued/contracts';
import { searchToolCatalog } from '../chat-catalog.js';

/** `tools.search` tokenizes with `split(/[^a-z0-9]+/)`, so every character
 *  outside `[a-z0-9]` is a SEPARATOR rather than content. For a script with no
 *  Latin characters that leaves zero terms, and `searchToolCatalog` returns []
 *  on zero terms — so the search does not merely rank badly, it cannot match.
 *
 *  ⛔ THAT IS LOAD-BEARING UNDER THE SHIPPING DEFAULT. When the resolved catalog
 *  mode omits Tier-2 entries (`lean-core` does), `tools.search` is the ONLY
 *  route to a recipe — so an owner writing in a non-Latin script can reach no
 *  installed recipe at all through chat. */
const entry = (name: string, description: string, topic_tags: string[]): ToolEntry =>
  ({ name, description, tier: 2, topic_tags, args_schema: {} }) as unknown as ToolEntry;

const CATALOG: ToolEntry[] = [
  entry('recued-core/list-buildings', 'List the buildings in your rental book.', ['rental', 'building']),
  entry('recued-core/overdue-invoice-chase', 'Chase overdue invoices.', ['invoice', 'finance']),
];

describe('tools.search — non-Latin queries', () => {
  it('matches an English query', () => {
    expect(searchToolCatalog(CATALOG, 'list my buildings', 5).length).toBeGreaterThan(0);
  });

  it('⛔ returns NOTHING for every non-Latin script — not "fewer", zero', () => {
    // Each of these is a plain, correct way to ask for the first recipe.
    for (const [script, query] of [
      ['Japanese', '建物を一覧して'],
      ['Chinese', '列出我的建筑'],
      ['Korean', '건물 목록'],
      ['Russian', 'список зданий'],
      ['Greek', 'λίστα κτιρίων'],
      ['Arabic', 'قائمة المباني'],
      ['Hebrew', 'רשימת בניינים'],
      ['Thai', 'รายการอาคาร'],
      ['Hindi', 'इमारतों की सूची'],
    ] as Array<[string, string]>) {
      expect(searchToolCatalog(CATALOG, query, 5), `${script}: ${query}`).toEqual([]);
    }
  });

  it('⚠ accented Latin degrades rather than fails — the diacritic splits the word', () => {
    // `bâtiments` -> ['b', 'timents'] and the 1-char fragment is dropped, so
    // recall survives only where the surviving fragment happens to hit.
    expect(searchToolCatalog(CATALOG, 'facturas atrasadas', 5)).toEqual([]);
    expect(searchToolCatalog(CATALOG, 'overdue facturas', 5).length).toBeGreaterThan(0);
  });
});
