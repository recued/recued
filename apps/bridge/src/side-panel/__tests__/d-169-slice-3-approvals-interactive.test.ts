/** D-169 P2 Slice 3 — approvals section goes interactive.
 *
 *  Slice 1 rendered the approvals section read-only; Slice 3 renders each
 *  open ask via the shared `@recued/ui-shared` approval card (I-12) when an
 *  `onAnswer` handler is wired, and falls back to the read-only list when
 *  it is not. The shared card uses real click handlers, so this test builds
 *  an interactive fake document (the side-panel views' own FakeElement has
 *  no addEventListener). */

import { describe, expect, it, vi } from 'vitest';

import { renderApprovalsSection } from '../views.js';
import {
  ASK_CARD_AGE_ATTR,
  ASK_CARD_ATTR,
  ASK_CARD_LINK_ATTR,
  ASK_CARD_NOTE_ATTR,
  ASK_CARD_OPTION_ATTR,
} from '@recued/ui-shared/approval-card';
import type { SidePanelStoreState } from '../store/local-store.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  hidden: boolean;
  /** D-234 § 234.4e — the `<textarea>` surface the note field uses. */
  value: string;
  maxLength: number;
  required: boolean;
  rows: number;
  placeholder: string;
  id: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<() => void>>;
  /** Every real element has it; the card focuses the note field on a
   *  required-note refusal. */
  focus(): void;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
}

const makeFakeDocument = (): { createElement(tag: string): FakeEl } => ({
  createElement(tag: string): FakeEl {
    const el: FakeEl = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      // D-234 § 234.4e — a real `<textarea>` has these; a double weaker than the
      // real thing manufactures false reds (the card reads `.value`).
      value: '',
      focus() { /* real elements all have one; the card calls it on refusal */ },
      maxLength: 0,
      required: false,
      rows: 0,
      placeholder: '',
      id: '',
      type: '',
      disabled: false,
      hidden: false,
      attrs: new Map(),
      children: [],
      listeners: new Map(),
      setAttribute(k, v) {
        el.attrs.set(k, v);
      },
      removeAttribute(k) {
        el.attrs.delete(k);
      },
      getAttribute(k) {
        return el.attrs.get(k) ?? null;
      },
      appendChild(c) {
        el.children.push(c);
        return c;
      },
      addEventListener(type, fn) {
        const list = el.listeners.get(type) ?? [];
        list.push(fn);
        el.listeners.set(type, list);
      },
      click() {
        if (el.disabled) return;
        for (const fn of el.listeners.get('click') ?? []) fn();
      },
    };
    return el;
  },
});

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};
const allText = (root: FakeEl, acc: string[] = []): string[] => {
  if (root.textContent) acc.push(root.textContent);
  for (const c of root.children) allText(c, acc);
  return acc;
};

const NOW = 10_000;

const frame = (
  items: SidePanelStoreState['approvals']['items'],
): SidePanelStoreState['approvals'] => ({
  items,
  fetched_at: NOW,
  error: null,
});

const ask = {
  ask_id: 'ask-7',
  title: 'Approval needed',
  text: 'Send the follow-up email to Alice?',
  options: [
    { id: 'send', label: 'Send' },
    { id: 'hold', label: 'Hold' },
  ],
  created_at: NOW - 5_000,
};

describe('D-169 P2 Slice 3 — interactive approvals section', () => {
  it('renders an interactive card per open ask when onAnswer is wired', () => {
    const onAnswer = vi.fn();
    const doc = makeFakeDocument();
    const section = renderApprovalsSection(
      doc as unknown as Document,
      frame([ask]),
      NOW,
      { onAnswer },
    ) as unknown as FakeEl;
    // One shared approval card, carrying the ask_id.
    const cards = collectByAttr(section, ASK_CARD_ATTR);
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute(ASK_CARD_ATTR)).toBe('ask-7');
    // Two option buttons.
    expect(collectByAttr(section, ASK_CARD_OPTION_ATTR)).toHaveLength(2);
  });

  it("dates the card by the panel's clock, not the wall clock", () => {
    // The store screenshots render at a FIXED clock. With the card falling back
    // to `Date.now()`, the listing's approval said "Waiting 6w" beside "4m ago",
    // older with every day it was rebuilt. A clock decades from today makes the
    // two impossible to confuse.
    const panelNow = 1_000_000_000_000;
    const doc = makeFakeDocument();
    const section = renderApprovalsSection(
      doc as unknown as Document,
      { ...frame([{ ...ask, created_at: panelNow - 11 * 60_000 }]), fetched_at: panelNow },
      panelNow,
      { onAnswer: vi.fn() },
    ) as unknown as FakeEl;
    expect(collectByAttr(section, ASK_CARD_AGE_ATTR)[0]?.textContent).toBe('Waiting 11m');
  });

  it('clicking an option calls onAnswer(ask_id, option_id)', () => {
    const onAnswer = vi.fn();
    const doc = makeFakeDocument();
    const section = renderApprovalsSection(
      doc as unknown as Document,
      frame([ask]),
      NOW,
      { onAnswer },
    ) as unknown as FakeEl;
    const buttons = collectByAttr(section, ASK_CARD_OPTION_ATTR);
    buttons[0].click(); // "Send"
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('ask-7', 'send');
  });

  it('falls back to a read-only list (no cards) when no onAnswer is wired', () => {
    const doc = makeFakeDocument();
    const section = renderApprovalsSection(
      doc as unknown as Document,
      frame([ask]),
      NOW,
    ) as unknown as FakeEl;
    // No interactive card primitive in the read-only fallback.
    expect(collectByAttr(section, ASK_CARD_ATTR)).toHaveLength(0);
    expect(collectByAttr(section, ASK_CARD_OPTION_ATTR)).toHaveLength(0);
    // The read-only fallback still surfaces the option labels as text.
    expect(allText(section).join(' ')).toContain('Send');
  });

  it('renders the empty-state copy (no cards) when there are no asks', () => {
    const onAnswer = vi.fn();
    const doc = makeFakeDocument();
    const section = renderApprovalsSection(
      doc as unknown as Document,
      frame([]),
      NOW,
      { onAnswer },
    ) as unknown as FakeEl;
    expect(collectByAttr(section, ASK_CARD_ATTR)).toHaveLength(0);
    expect(allText(section).join(' ')).toContain('No pending approvals');
    expect(onAnswer).not.toHaveBeenCalled();
  });
});


describe('D-234 § 234.4e — the written reason survives the Bridge chain', () => {
  const notedAsk = { ...ask, note_prompt: 'required' as const };

  it('⛔ RENDERS NO FIELD on an ordinary ask — every existing card is unchanged', () => {
    const doc = makeFakeDocument();
    const section = renderApprovalsSection(
      doc as unknown as Document, frame([ask]), NOW, { onAnswer: vi.fn() },
    ) as unknown as FakeEl;
    expect(collectByAttr(section, ASK_CARD_NOTE_ATTR)).toHaveLength(0);
  });

  it('renders the field when the ask invites one, and FORWARDS what was typed', () => {
    // ⛔ THE POINT OF THIS TEST IS THE THIRD ARGUMENT. The reason crosses four
    // hops on Bridge — card → views → entry → SW message → rpc — and each is an
    // enumerating copier that drops silently. If any of them loses it the answer
    // still SUCCEEDS, minus the thing the reviewer was asked for.
    const onAnswer = vi.fn();
    const doc = makeFakeDocument();
    const section = renderApprovalsSection(
      doc as unknown as Document, frame([notedAsk]), NOW, { onAnswer },
    ) as unknown as FakeEl;
    const box = collectByAttr(section, ASK_CARD_NOTE_ATTR)[0];
    expect(box).toBeDefined();
    box.value = 'the penalty clause is not fine';
    collectByAttr(section, ASK_CARD_OPTION_ATTR)[0].click();
    expect(onAnswer).toHaveBeenCalledWith(
      'ask-7', 'send', 'the penalty clause is not fine',
    );
  });

  it('⛔⛔ a REQUIRED ask does not submit bare — the server would silently no-op it', () => {
    const onAnswer = vi.fn();
    const doc = makeFakeDocument();
    const section = renderApprovalsSection(
      doc as unknown as Document, frame([notedAsk]), NOW, { onAnswer },
    ) as unknown as FakeEl;
    collectByAttr(section, ASK_CARD_OPTION_ATTR)[0].click();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('⛔⛔ § 234.3 — RENDERS THE "read it here" LINK, which Bridge silently dropped', () => {
    // THE REGRESSION THIS TEST EXISTS FOR ALREADY HAPPENED, and nothing caught
    // it: the store's item type and both copiers omitted `link_url`, so the
    // affordance § 234.3 exists to provide has never appeared on Bridge. For a
    // peer review that is the whole point — the card carries the question, the
    // link carries the thing being reviewed. Pinned here because the field is
    // reachable only through an enumerating copier, which fails silently.
    const doc = makeFakeDocument();
    const section = renderApprovalsSection(
      doc as unknown as Document,
      frame([{ ...ask, link_url: 'https://app.recued.com/#/review/7' }]),
      NOW,
      { onAnswer: vi.fn() },
    ) as unknown as FakeEl;
    const link = collectByAttr(section, ASK_CARD_LINK_ATTR)[0];
    expect(link).toBeDefined();
    expect(link.getAttribute('href')).toBe('https://app.recued.com/#/review/7');
  });

  it('⚠ a note-less answer keeps the TWO-ARGUMENT call shape', () => {
    // Passing an explicit `undefined` third argument is a silent behaviour
    // change to every Bridge approval card; a shipped test caught it once here.
    const onAnswer = vi.fn();
    const doc = makeFakeDocument();
    const section = renderApprovalsSection(
      doc as unknown as Document, frame([ask]), NOW, { onAnswer },
    ) as unknown as FakeEl;
    collectByAttr(section, ASK_CARD_OPTION_ATTR)[0].click();
    expect(onAnswer).toHaveBeenCalledWith('ask-7', 'send');
  });
});
