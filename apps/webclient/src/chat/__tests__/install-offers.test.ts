/** D-323 — the links under a chat answer to the install pages of what the
 *  marketplace has for a request nothing installed could do. */

import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@recued/contracts';

import {
  buildChatInstallOffers,
  CHAT_INSTALL_OFFER_ATTR,
  CHAT_INSTALL_OFFERS_ATTR,
  chatInstallOfferLinks,
} from '../install-offers.js';

const PACK = { kind: 'pack' as const, slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: ['Collect the rent', 'Collection sheet'] };
const RECIPE = { kind: 'recipe' as const, slug: 'summarize-pdf', name: 'Summarize a PDF', publisher: 'recued-core', recipes: ['Summarize a PDF'] };
const answer = (install_offers: unknown): Pick<ChatMessage, 'role' | 'install_offers'> =>
  ({ role: 'assistant', install_offers } as Pick<ChatMessage, 'role' | 'install_offers'>);

describe('the links', () => {
  it('a pack to its page, a standalone recipe to its install dialog', () => {
    expect(chatInstallOfferLinks(answer([PACK, RECIPE]))).toEqual([
      { kind: 'pack', slug: 'rental-book', href: '#packs/rental-book', label: 'Get Rental Book', detail: 'Collect the rent · Collection sheet' },
      { kind: 'recipe', slug: 'summarize-pdf', href: '#recipes/install/summarize-pdf', label: 'Get Summarize a PDF', detail: '' },
    ]);
  });

  it('none for an owner’s message, an answer without offers, or offers that are not offers', () => {
    expect(chatInstallOfferLinks({ role: 'user', install_offers: [PACK] })).toEqual([]);
    expect(chatInstallOfferLinks(answer(undefined))).toEqual([]);
    expect(chatInstallOfferLinks(answer([{ ...PACK, slug: 'javascript:alert(1)' }]))).toEqual([]);
  });
});

interface FakeNode {
  tagName: string;
  attributes: Map<string, string>;
  children: FakeNode[];
  textContent: string;
  href?: string;
  className?: string;
  setAttribute(name: string, value: string): void;
  appendChild(child: FakeNode): FakeNode;
}
const makeNode = (tagName: string): FakeNode => {
  const node: FakeNode = {
    tagName, attributes: new Map(), children: [], textContent: '',
    setAttribute: (name, value) => { node.attributes.set(name, value); },
    appendChild: (child) => { node.children.push(child); return child; },
  };
  return node;
};
const doc = { createElement: (tag: string) => makeNode(tag.toUpperCase()) } as unknown as Document;

describe('the block under the answer', () => {
  it('says what they are, and is a list of plain links, never a button', () => {
    const root = buildChatInstallOffers(doc, chatInstallOfferLinks(answer([PACK, RECIPE]))) as unknown as FakeNode;
    expect(root.attributes.has(CHAT_INSTALL_OFFERS_ATTR)).toBe(true);
    expect(root.children[0]!.textContent).toBe('From the marketplace, not installed yet:');
    const items = root.children[1]!.children;
    expect(items.map((item) => item.children[0]!.tagName)).toEqual(['A', 'A']);
    expect(items.map((item) => item.children[0]!.href)).toEqual(['#packs/rental-book', '#recipes/install/summarize-pdf']);
    expect(items.map((item) => item.children[0]!.attributes.get(CHAT_INSTALL_OFFER_ATTR))).toEqual(['rental-book', 'summarize-pdf']);
    expect(items[0]!.children[1]!.textContent).toBe('Collect the rent · Collection sheet');
    expect(items[1]!.children).toHaveLength(1);
  });
});
