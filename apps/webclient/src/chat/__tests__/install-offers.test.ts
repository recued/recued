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
import { CHAT_ASK_AGAIN_ATTR } from '../chat-fixes.js';

const PACK = { kind: 'pack' as const, slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: ['Collect the rent', 'Collection sheet'] };
const RECIPE = { kind: 'recipe' as const, slug: 'summarize-pdf', name: 'Summarize a PDF', publisher: 'recued-core', recipes: ['Summarize a PDF'] };
const answer = (install_offers: unknown): Pick<ChatMessage, 'role' | 'install_offers'> =>
  ({ role: 'assistant', install_offers } as Pick<ChatMessage, 'role' | 'install_offers'>);

describe('the links', () => {
  it('a pack to its page, a standalone recipe to its install dialog', () => {
    expect(chatInstallOfferLinks(answer([PACK, RECIPE]))).toEqual([
      { kind: 'pack', slug: 'rental-book', name: 'Rental Book', href: '#packs/rental-book', label: 'Get Rental Book', detail: 'Collect the rent · Collection sheet',
        hint: { key: 'offer:pack:rental-book', label: 'Get Rental Book' } },
      { kind: 'recipe', slug: 'summarize-pdf', name: 'Summarize a PDF', href: '#recipes/install/summarize-pdf', label: 'Get Summarize a PDF', detail: '',
        hint: { key: 'offer:recipe:summarize-pdf', label: 'Get Summarize a PDF' } },
    ]);
  });

  // D-404 slice B2 (D-323's P6) — from a stored answer, an offer's link carries it, a pack's and a recipe's.
  it('an offer\'s link carries its answer, when the answer has one', () => {
    const links = chatInstallOfferLinks({ role: 'assistant', id: 'm1', session_id: 's1', install_offers: [PACK, RECIPE] } as never);
    expect(links.map((link) => link.href)).toEqual(['#packs/rental-book/return/chat/s1/m1', '#recipes/install/summarize-pdf/return/chat/s1/m1']);
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
  listeners: Map<string, () => void>;
  setAttribute(name: string, value: string): void;
  appendChild(child: FakeNode): FakeNode;
  addEventListener(kind: string, fn: () => void): void;
}
const makeNode = (tagName: string): FakeNode => {
  const node: FakeNode = {
    tagName, attributes: new Map(), children: [], textContent: '', listeners: new Map(),
    setAttribute: (name, value) => { node.attributes.set(name, value); },
    appendChild: (child) => { node.children.push(child); return child; },
    addEventListener: (kind, fn) => { node.listeners.set(kind, fn); },
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

// D-404 slice B1 — once an offer is installed, its line says so, and the block offers Ask again.
describe('an offer installed (D-404)', () => {
  const all = (node: FakeNode): FakeNode[] => [node, ...node.children.flatMap(all)];
  const draw = (landed: string[], askAgain = async () => {}) => buildChatInstallOffers(doc, chatInstallOfferLinks(answer([PACK, RECIPE])),
    { messageId: 'm-offers', landed: new Set(landed), askAgain, repaint: () => {} }) as unknown as FakeNode;

  it('reads "<name> is installed." in place of its link, and ends with Ask again', () => {
    const root = draw(['pack:rental-book']);
    const texts = all(root).map((node) => node.textContent);
    expect(texts).toContain('Rental Book is installed.');
    expect(all(root).filter((node) => node.tagName === 'A').map((node) => node.textContent)).toEqual(['Get Summarize a PDF']);
    expect(all(root).filter((node) => node.attributes.has(CHAT_ASK_AGAIN_ATTR))).toHaveLength(1);
  });

  it('no Ask again while nothing it offered is installed, nor without the chat to send it', () => {
    expect(all(draw([])).some((node) => node.attributes.has(CHAT_ASK_AGAIN_ATTR))).toBe(false);
    const bare = buildChatInstallOffers(doc, chatInstallOfferLinks(answer([PACK]))) as unknown as FakeNode;
    expect(all(bare).some((node) => node.attributes.has(CHAT_ASK_AGAIN_ATTR))).toBe(false);
    expect(all(bare).map((node) => node.textContent)).not.toContain('Rental Book is installed.');
  });
});
