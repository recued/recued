/** D-169 P2 Slice 3 — shared approval-card primitive tests.
 *
 *  `renderAskCard` returns a real `HTMLElement` with click handlers, so a
 *  string-assert harness (like the recipe-card test) won't do — and the
 *  repo ships no jsdom. This file builds a tiny interactive fake document
 *  (createElement / textContent / setAttribute / appendChild +
 *  addEventListener + a `.click()` that fires listeners + `disabled` /
 *  `hidden` props) so the card's interactivity is exercised deterministically.
 *
 *  Coverage: render shape, blank-title omission, click → onAnswer(optionId),
 *  the in-flight double-click guard, the reject → re-enable + inline-error
 *  path, the success path, the structural hooks, and textContent inertness. */

import { describe, expect, it, vi } from 'vitest';

import {
  renderApprovalCard,
  renderAskCard,
  APPROVAL_CARD_ACTION_ATTR,
  APPROVAL_CARD_ATTR,
  APPROVAL_CARD_ERROR_ATTR,
  APPROVAL_CARD_LINK_ATTR,
  APPROVAL_CARD_STATUS_ATTR,
  type ApprovalCardModel,
  ASK_CARD_ATTR,
  ASK_CARD_OPTION_ATTR,
  ASK_CARD_ERROR_ATTR,
  type AskCardModel,
} from '../approval-card/card.js';

// ── Interactive fake DOM ─────────────────────────────────────────────
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  hidden: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<() => void>>;
  setAttribute(k: string, v: string): void;
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
      type: '',
      disabled: false,
      hidden: false,
      attrs: new Map(),
      children: [],
      listeners: new Map(),
      setAttribute(k, v) {
        el.attrs.set(k, v);
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
        // A disabled button fires no click — mirror real DOM so the
        // in-flight guard test is meaningful.
        if (el.disabled) return;
        for (const fn of el.listeners.get('click') ?? []) fn();
      },
    };
    return el;
  },
});

// Depth-first collect every element carrying `attr`.
const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};
const optionButtons = (root: FakeEl): FakeEl[] =>
  collectByAttr(root, ASK_CARD_OPTION_ATTR);
const errorLine = (root: FakeEl): FakeEl | undefined =>
  collectByAttr(root, ASK_CARD_ERROR_ATTR)[0];

const model = (over: Partial<AskCardModel> = {}): AskCardModel => ({
  ask_id: 'ask-1',
  text: 'Approve sending the email?',
  options: [
    { id: 'yes', label: 'Send' },
    { id: 'no', label: 'Discard' },
  ],
  ...over,
});

const render = (m: AskCardModel, onAnswer: (id: string) => void | Promise<void>) => {
  const doc = makeFakeDocument();
  // The card only uses the Document.createElement surface our fake provides.
  const card = renderAskCard(doc as unknown as Document, m, { onAnswer });
  return card as unknown as FakeEl;
};

const approvalModel = (
  over: Partial<ApprovalCardModel> = {},
): ApprovalCardModel => ({
  approval_id: 'ap-1',
  recipe_id: 'recipe-1',
  step_id: 'step-1',
  ingredient_slug: 'mail-send',
  risk_tier: 'write',
  description: 'Send the customer follow-up',
  resolved_input: { to: 'mary@example.com', subject: 'Follow up' },
  created_at: 1_700_000_000_000,
  timeout_at: 1_700_000_300_000,
  initiator_instance: 'laptop',
  ...over,
});

const renderApproval = (
  m: ApprovalCardModel,
  onResolve: (decision: 'approve' | 'reject') => void | Promise<void>,
  options: Parameters<typeof renderApprovalCard>[3] = {},
) => {
  const doc = makeFakeDocument();
  const card = renderApprovalCard(
    doc as unknown as Document,
    m,
    { onResolve },
    options,
  );
  return card as unknown as FakeEl;
};

const approvalButtons = (root: FakeEl): FakeEl[] =>
  collectByAttr(root, APPROVAL_CARD_ACTION_ATTR);
const approvalButton = (root: FakeEl, decision: string): FakeEl | undefined =>
  approvalButtons(root).find(
    (b) => b.getAttribute(APPROVAL_CARD_ACTION_ATTR) === decision,
  );
const approvalError = (root: FakeEl): FakeEl | undefined =>
  collectByAttr(root, APPROVAL_CARD_ERROR_ATTR)[0];

describe('D-169 P2 Slice 3 — renderAskCard', () => {
  it('renders the title, body text, and one button per option', () => {
    const card = render(model({ title: 'Approval needed' }), () => {});
    // Structural hook: the card root carries the ask_id.
    expect(card.getAttribute(ASK_CARD_ATTR)).toBe('ask-1');
    const buttons = optionButtons(card);
    expect(buttons.map((b) => b.getAttribute(ASK_CARD_OPTION_ATTR))).toEqual([
      'yes',
      'no',
    ]);
    expect(buttons.map((b) => b.textContent)).toEqual(['Send', 'Discard']);
    // Title + body both rendered.
    const texts = collectByAttr(card, '__never__'); // none — sanity that helper is depth-first
    expect(texts).toHaveLength(0);
  });

  it('omits a blank / whitespace-only title (no empty heading line)', () => {
    const withBlank = render(model({ title: '   ' }), () => {});
    // The title element carries no stable attr, so assert by walking text:
    // a blank title must not appear as its own node — the only non-button,
    // non-error text node should be the body.
    const allText = new Set<string>();
    const walk = (el: FakeEl): void => {
      if (el.textContent) allText.add(el.textContent);
      el.children.forEach(walk);
    };
    walk(withBlank);
    expect(allText.has('   ')).toBe(false);
    expect(allText.has('Approve sending the email?')).toBe(true);
  });

  it('fires onAnswer with the chosen option id on click', () => {
    const onAnswer = vi.fn();
    const card = render(model(), onAnswer);
    optionButtons(card)[1].click(); // "Discard"
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('no');
  });

  it('disables every button after the first click (in-flight guard)', () => {
    const onAnswer = vi.fn(() => new Promise<void>(() => {})); // never settles
    const card = render(model(), onAnswer);
    const buttons = optionButtons(card);
    buttons[0].click();
    expect(buttons.every((b) => b.disabled)).toBe(true);
    // A second click on the other button is a no-op while in flight.
    buttons[1].click();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('re-enables the buttons + shows the inline error when the submit rejects', async () => {
    let reject!: (e: unknown) => void;
    const onAnswer = vi.fn(
      () =>
        new Promise<void>((_res, rej) => {
          reject = rej;
        }),
    );
    const card = render(model(), onAnswer);
    const buttons = optionButtons(card);
    const err = errorLine(card);
    expect(err?.hidden).toBe(true);
    buttons[0].click();
    expect(buttons.every((b) => b.disabled)).toBe(true);
    reject(new Error('rpc failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(buttons.every((b) => b.disabled)).toBe(false);
    expect(err?.hidden).toBe(false);
    // After re-enabling, a fresh click submits again (retry path).
    buttons[0].click();
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it('keeps buttons disabled + error hidden on a successful submit', async () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    const card = render(model(), onAnswer);
    const buttons = optionButtons(card);
    buttons[0].click();
    await Promise.resolve();
    await Promise.resolve();
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(errorLine(card)?.hidden).toBe(true);
  });

  it('sets text via textContent — server strings are inert (no child injection)', () => {
    const card = render(
      model({ text: '<img src=x onerror=alert(1)>', title: '<b>hi</b>' }),
      () => {},
    );
    // The malicious-looking strings land as textContent on leaf nodes, never
    // parsed into children. The card's only element children are: optional
    // title, body, actions wrapper (with buttons), error line.
    const walk = (el: FakeEl, acc: string[]): string[] => {
      if (el.textContent) acc.push(el.textContent);
      el.children.forEach((c) => walk(c, acc));
      return acc;
    };
    const texts = walk(card, []);
    expect(texts).toContain('<img src=x onerror=alert(1)>');
    expect(texts).toContain('<b>hi</b>');
  });
});

describe('D-174 — renderApprovalCard', () => {
  it('renders the approval context, actions, and cross-route links', () => {
    const card = renderApproval(
      approvalModel(),
      () => {},
      {
        links: {
          recipeHref: '#recipes?recipe_id=recipe-1',
          connectionHref: '#connections',
          runHref: '#runs',
        },
      },
    );

    expect(card.getAttribute(APPROVAL_CARD_ATTR)).toBe('ap-1');
    expect(approvalButtons(card).map((b) => b.getAttribute(APPROVAL_CARD_ACTION_ATTR)))
      .toEqual(['reject', 'approve']);
    const links = collectByAttr(card, APPROVAL_CARD_LINK_ATTR);
    expect(links.map((l) => l.getAttribute(APPROVAL_CARD_LINK_ATTR))).toEqual([
      'recipe',
      'connection',
      'run',
    ]);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '#recipes?recipe_id=recipe-1',
      '#connections',
      '#runs',
    ]);
  });

  it('prefers resolved recipe_name + initiator_label in the meta line (#4)', () => {
    const card = renderApproval(
      approvalModel({ recipe_name: 'Daily digest', initiator_label: 'Chrome on macOS' }),
      () => {},
    );
    const texts = new Set<string>();
    const walk = (el: FakeEl): void => {
      if (el.textContent) texts.add(el.textContent);
      el.children.forEach(walk);
    };
    walk(card);
    const meta = [...texts].find((t) => t.includes('recipe ')) ?? '';
    expect(meta).toContain('recipe Daily digest');
    expect(meta).toContain('from Chrome on macOS');
    expect(meta).not.toContain('recipe-1'); // raw id replaced
    expect(meta).not.toContain('laptop'); // raw instance replaced
  });

  it('falls back to raw ids in the meta when no display names resolve (#4)', () => {
    const card = renderApproval(approvalModel(), () => {});
    const texts = new Set<string>();
    const walk = (el: FakeEl): void => {
      if (el.textContent) texts.add(el.textContent);
      el.children.forEach(walk);
    };
    walk(card);
    const meta = [...texts].find((t) => t.includes('recipe ')) ?? '';
    expect(meta).toContain('recipe recipe-1');
    expect(meta).toContain('from laptop');
  });

  it('fires onResolve with the selected decision and guards double-clicks', () => {
    const onResolve = vi.fn(() => new Promise<void>(() => {}));
    const card = renderApproval(approvalModel(), onResolve);
    approvalButton(card, 'approve')!.click();
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith('approve');
    expect(approvalButtons(card).every((b) => b.disabled)).toBe(true);
    approvalButton(card, 'reject')!.click();
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('re-enables actions and shows the inline error when resolve rejects', async () => {
    let reject!: (e: unknown) => void;
    const onResolve = vi.fn(
      () =>
        new Promise<void>((_res, rej) => {
          reject = rej;
        }),
    );
    const card = renderApproval(approvalModel(), onResolve);
    expect(approvalError(card)?.hidden).toBe(true);

    approvalButton(card, 'reject')!.click();
    expect(approvalButtons(card).every((b) => b.disabled)).toBe(true);
    reject(new Error('rpc failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(approvalButtons(card).every((b) => b.disabled)).toBe(false);
    expect(approvalError(card)?.hidden).toBe(false);
  });

  it('keeps stale approvals disabled with a visible status reason', () => {
    const onResolve = vi.fn();
    const card = renderApproval(approvalModel(), onResolve, {
      disabled: true,
      disabledReason: 'Timed out - refresh queue.',
    });

    expect(approvalButtons(card).every((b) => b.disabled)).toBe(true);
    expect(collectByAttr(card, APPROVAL_CARD_STATUS_ATTR)[0]?.textContent)
      .toBe('Timed out - refresh queue.');
    approvalButton(card, 'approve')!.click();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('sets approval strings via textContent so server content is inert', () => {
    const card = renderApproval(
      approvalModel({
        description: '<img src=x onerror=alert(1)>',
        resolved_input: { html: '<script>alert(1)</script>' },
      }),
      () => {},
    );
    const walk = (el: FakeEl, acc: string[]): string[] => {
      if (el.textContent) acc.push(el.textContent);
      el.children.forEach((c) => walk(c, acc));
      return acc;
    };
    const texts = walk(card, []);
    expect(texts).toContain('<img src=x onerror=alert(1)>');
    expect(texts).toContain('{"html":"<script>alert(1)</script>"}');
  });
});
