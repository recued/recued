import { describe, expect, it } from 'vitest';
import { readSearchNavigationReturn, saveSearchNavigationReturn, trackSearchNavigationRoute } from '../shell/search-navigation-return.js';

describe('search return from recipes and packs', () => {
  it('keeps the query, type and result visit across Back/Forward, isolated by document and connection', () => {
    const doc = {} as Document, otherDoc = {} as Document, owner = {}, otherOwner = {};
    const value = { destinationHash: '#recipes/review', returnHash: '#views/research', state: { query: 'renewal', type: 'capability' },
      focus: { action: 'open-recipe', attribute: 'data-recipe', id: 'review' }, scrollTop: 400 };
    saveSearchNavigationReturn(doc, owner, value);
    expect(readSearchNavigationReturn(doc, otherOwner)).toBeUndefined();
    expect(readSearchNavigationReturn(otherDoc, owner)).toBeUndefined();
    for (const hash of [value.destinationHash, value.returnHash, value.destinationHash]) {
      trackSearchNavigationRoute(doc, owner, hash); expect(readSearchNavigationReturn(doc, owner)).toEqual(value);
    }
    trackSearchNavigationRoute(doc, owner, '#recipes/another');
    expect(readSearchNavigationReturn(doc, owner)).toBeUndefined();
  });
});


it('retains only an explicitly registered canonical route alias and clears the visit on another record', () => {
  const doc = {} as Document, owner = {};
  saveSearchNavigationReturn(doc, owner, { destinationHash: '#data/contact/canonical', destinationAliases: ['#data/contact/riley%40example.test'],
    returnHash: '#data/search', state: { query: 'copied contact link' }, focus: { action: 'open', attribute: 'id', id: 'canonical' }, scrollTop: 20 });
  trackSearchNavigationRoute(doc, owner, '#data/contact/riley%40example.test'); expect(readSearchNavigationReturn(doc, owner)).toBeDefined();
  trackSearchNavigationRoute(doc, owner, '#data/contact/another'); expect(readSearchNavigationReturn(doc, owner)).toBeUndefined();
});
