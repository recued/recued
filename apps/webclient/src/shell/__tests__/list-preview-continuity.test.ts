import { describe, expect, it } from 'vitest';
import { readSearchAssetReturn, saveSearchAssetReturn, trackSearchAssetRoute } from '../search-asset-return.js';

import {
  readListContinuity,
  restoreListScroll,
  updateListContinuity,
} from '../list-preview-continuity.js';

describe('list preview continuity', () => {
  it('keeps an asset search return within its document, server, addressed asset and originating view', () => {
    const doc = {} as Document, otherDoc = {} as Document, server = {}, otherServer = {};
    const saved = { assetId: 'passport/ana', returnHash: '#views/travel', state: { query: 'passport', ids: ['one', 'passport/ana'] }, scroll: { top: 840, left: 0 } };
    saveSearchAssetReturn(doc, server, saved);
    expect(readSearchAssetReturn(otherDoc, server)).toBeUndefined();
    expect(readSearchAssetReturn(doc, otherServer)).toBeUndefined();
    trackSearchAssetRoute(doc, server, '#yours/asset/passport%2Fana');
    trackSearchAssetRoute(doc, server, '#views/travel');
    expect(readSearchAssetReturn(doc, server)).toEqual(saved);
    trackSearchAssetRoute(doc, server, '#yours/asset/other');
    expect(readSearchAssetReturn(doc, server)).toBeUndefined();
    saveSearchAssetReturn(doc, server, saved);
    trackSearchAssetRoute(doc, server, '#data/search');
    expect(readSearchAssetReturn(doc, server)).toBeUndefined();
  });
  it('merges model and view ownership only within the current document', () => {
    const first = {} as Document;
    const second = {} as Document;

    updateListContinuity(first, 'recipes:installed', {
      filter: { query: 'invoice', trigger: 'manual' },
      page: 3,
    });
    updateListContinuity(first, 'recipes:installed', {
      focusedId: 'send-invoice',
      scroll: { top: 740, left: 8 },
    });

    expect(readListContinuity(first, 'recipes:installed')).toEqual({
      filter: { query: 'invoice', trigger: 'manual' },
      page: 3,
      focusedId: 'send-invoice',
      scroll: { top: 740, left: 8 },
    });
    expect(readListContinuity(second, 'recipes:installed')).toBeNull();
  });

  it('returns a defensive scroll copy and restores both axes', () => {
    const document = {} as Document;
    updateListContinuity(document, 'packs:browse', {
      scroll: { top: 320, left: 14 },
    });
    const first = readListContinuity(document, 'packs:browse')!;
    (first.scroll as { top: number }).top = 0;
    expect(readListContinuity(document, 'packs:browse')?.scroll?.top).toBe(320);

    const root = { scrollTop: 0, scrollLeft: 0 } as HTMLElement;
    restoreListScroll(root, { top: 320, left: 14 });
    expect({ top: root.scrollTop, left: root.scrollLeft }).toEqual({
      top: 320,
      left: 14,
    });
  });
});
