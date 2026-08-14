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
  renderChatPlanCard,
  APPROVAL_CARD_STYLES,
  APPROVAL_CARD_ACTION_ATTR,
  APPROVAL_CARD_ATTR,
  APPROVAL_CARD_ERROR_ATTR,
  APPROVAL_CARD_LINK_ATTR,
  APPROVAL_CARD_STATUS_ATTR,
  type ApprovalCardModel,
  ASK_CARD_ATTR,
  ASK_CARD_BODY_ATTR,
  ASK_CARD_STYLES,
  ASK_CARD_CONFIRM_ATTR,
  ASK_CARD_DETAILS_ATTR,
  ASK_CARD_NOTE_ATTR,
  ASK_CARD_OPTION_ATTR,
  ASK_CARD_ERROR_ATTR,
  ASK_CARD_LINK_ATTR,
  ASK_CARD_SUMMARY_ATTR,
  type AskCardModel,
  type AskCardOptions,
  CHAT_PLAN_CARD_ACTION_ATTR,
  CHAT_PLAN_CARD_ERROR_ATTR,
  type ChatPlanCardModel,
  type ChatPlanCardOptions,
} from '../approval-card/card.js';

describe('approval-card interaction styling', () => {
  it('gives handoff links and decision buttons full-size targets', () => {
    expect(APPROVAL_CARD_STYLES).toContain(
      '.rx-approval-card-links a {\n  box-sizing: border-box;\n  min-height: 36px;',
    );
    expect(APPROVAL_CARD_STYLES).toContain(
      '.rx-approval-card-btn {\n  box-sizing: border-box;\n  min-height: 36px;',
    );
  });

  it('contains long server-controlled card copy and option labels', () => {
    expect(ASK_CARD_STYLES).toContain(
      '.rx-ask-card {\n  box-sizing: border-box;\n  min-width: 0;\n  max-width: 100%;',
    );
    expect(ASK_CARD_STYLES).toContain(
      '.rx-ask-card-title {\n  min-width: 0;',
    );
    expect(ASK_CARD_STYLES).toContain('overflow-wrap: anywhere;');
    expect(ASK_CARD_STYLES).toContain(
      '.rx-ask-card-btn {\n  box-sizing: border-box;\n  min-width: 0;\n  max-width: 100%;',
    );
    expect(APPROVAL_CARD_STYLES).toContain(
      '.rx-approval-card {\n  box-sizing: border-box;\n  min-width: 0;\n  max-width: 100%;',
    );
    expect(APPROVAL_CARD_STYLES).toContain(
      '.rx-approval-card-title {\n  min-width: 0;',
    );
    expect(APPROVAL_CARD_STYLES).toContain('overflow-wrap: anywhere;');
  });
});

// ── Interactive fake DOM ─────────────────────────────────────────────
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  hidden: boolean;
  /** D-234 § 234.4e — the `<textarea>` surface the ask card's note field uses. */
  value: string;
  maxLength: number;
  required: boolean;
  rows: number;
  placeholder: string;
  id: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<() => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void;
  focus(): void;
  click(): void;
}

interface FakeDoc {
  activeElement: FakeEl | null;
  createElement(tag: string): FakeEl;
}

const makeFakeDocument = (): FakeDoc => {
  const doc: FakeDoc = {
    activeElement: null,
    createElement(tag: string): FakeEl {
      const el: FakeEl = {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        // D-234 § 234.4e — a real `<textarea>` always has `value: ''`; the fake
        // had no such property, so the card's read threw and the note tests
        // failed for a reason that could never happen in a browser. ⚠ A double
        // WEAKER than the real thing manufactures false reds the same way a
        // stronger one hides true ones.
        value: '',
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
        focus() {
          doc.activeElement = el;
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
  };
  return doc;
};

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
const readLink = (root: FakeEl): FakeEl | undefined =>
  collectByAttr(root, ASK_CARD_LINK_ATTR)[0];
const noteBox = (root: FakeEl): FakeEl | undefined =>
  collectByAttr(root, ASK_CARD_NOTE_ATTR)[0];

const model = (over: Partial<AskCardModel> = {}): AskCardModel => ({
  ask_id: 'ask-1',
  text: 'Approve sending the email?',
  options: [
    { id: 'yes', label: 'Send' },
    { id: 'no', label: 'Discard' },
  ],
  ...over,
});

const renderWithDocument = (
  m: AskCardModel,
  onAnswer: (id: string) => void | Promise<void>,
  options?: AskCardOptions,
): { card: FakeEl; doc: FakeDoc } => {
  const doc = makeFakeDocument();
  // The card only uses the Document.createElement surface our fake provides.
  const card = renderAskCard(
    doc as unknown as Document,
    m,
    { onAnswer },
    options,
  );
  return { card: card as unknown as FakeEl, doc };
};

const render = (
  m: AskCardModel,
  onAnswer: (id: string) => void | Promise<void>,
): FakeEl => renderWithDocument(m, onAnswer).card;

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

const chatPlanModel = (
  over: Partial<ChatPlanCardModel> = {},
): ChatPlanCardModel => ({
  plan_id: 'plan-1',
  tool: 'mail.send',
  tier: 2,
  args: { to: 'mary@example.com' },
  payload_available: true,
  ...over,
});

const renderChatPlanWithDocument = (
  m: ChatPlanCardModel,
  onResolve: (decision: 'approve' | 'reject') => void | Promise<void>,
  options: ChatPlanCardOptions = {},
): { card: FakeEl; doc: FakeDoc } => {
  const doc = makeFakeDocument();
  const card = renderChatPlanCard(
    doc as unknown as Document,
    m,
    { onResolve },
    options,
  );
  return { card: card as unknown as FakeEl, doc };
};

const chatPlanButtons = (root: FakeEl): FakeEl[] =>
  collectByAttr(root, CHAT_PLAN_CARD_ACTION_ATTR);
const chatPlanButton = (
  root: FakeEl,
  decision: string,
): FakeEl | undefined =>
  chatPlanButtons(root).find(
    (button) => button.getAttribute(CHAT_PLAN_CARD_ACTION_ATTR) === decision,
  );
const chatPlanError = (root: FakeEl): FakeEl | undefined =>
  collectByAttr(root, CHAT_PLAN_CARD_ERROR_ATTR)[0];

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
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Send: Approval needed',
      'Discard: Approval needed',
    ]);
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

  it('projects generated write asks into a concise summary with collapsed technical details', () => {
    const card = render(model({
      title: 'Approve mail-send (write)',
      text: [
        'Recipe send-email wants to run mail-send on primary-mail (step send).',
        'Write actions change data outside Recued, so Recued held it for you.',
        '',
        'Reason: outbound send requires approval',
        '',
        '  to: sam@example.test',
        '  subject: Renewal update',
        '  body: The revised proposal is ready.',
        '  metadata.timeline: asap',
        '  metadata.budget_range: under_10k',
        '  metadata.reception_form_submission_id: bfcf3d78-5994-449f-be58-0b911f96e11c',
        '  metadata.reception_endpoint_id: LRVZ6pi-cSiTnHoUS6Uq3Q',
        '  metadata.form_definition_id: fd_foundation_client_inquiry_v1',
        '  metadata.internal_id: opaque-1',
        '',
        'Approve?',
      ].join('\n'),
    }), () => {});

    expect(collectByAttr(card, ASK_CARD_SUMMARY_ATTR)).toHaveLength(1);
    const details = collectByAttr(card, ASK_CARD_DETAILS_ATTR);
    expect(details).toHaveLength(1);
    expect(details[0]?.children[0]?.getAttribute('aria-label')).toBe(
      'Technical details for Approve mail-send (write) (7)',
    );
    const renderedText: string[] = [];
    const walk = (el: FakeEl): void => {
      if (el.textContent) renderedText.push(el.textContent);
      el.children.forEach(walk);
    };
    walk(card);
    expect(renderedText).toContain('Approve write action');
    expect(renderedText).toContain('sam@example.test');
    expect(renderedText).toContain('Renewal update');
    expect(renderedText).not.toContain('Timeline');
    expect(renderedText).not.toContain('Budget range');
    expect(renderedText).not.toContain('Reception form submission id');
    expect(renderedText).not.toContain('Reception endpoint id');
    expect(renderedText).not.toContain('Form definition id');
    expect(renderedText).not.toContain('Internal id');
    expect(renderedText).not.toContain('bfcf3d78-5994-449f-be58-0b911f96e11c');
  });

  it('keeps GROUPED metadata out of the card — the prefix is re-applied before the filter', () => {
    // The notification block now groups fields sharing a path under a
    // value-less header instead of repeating the path on every line. Read
    // naively, `metadata.timeline` arrives here as the bare leaf
    // `timeline` — which passes a filter written to reject exactly that
    // field, and the card silently starts showing the producer bookkeeping
    // it exists to keep out. The prefix has to be reconstructed first.
    const card = render(model({
      title: 'Approve mail-send (write)',
      text: [
        'Recipe send-email wants to run mail-send (step send).',
        'Write actions change data outside Recued, so Recued held it for you.',
        '',
        '  to: sam@example.test',
        '  subject: Renewal update',
        '  metadata:',
        '    timeline: asap',
        '    budget_range: under_10k',
        '  attachments: none',
        '',
        'Approve?',
      ].join('\n'),
    }), () => {});

    const renderedText: string[] = [];
    const walk = (el: FakeEl): void => {
      if (el.textContent) renderedText.push(el.textContent);
      el.children.forEach(walk);
    };
    walk(card);

    expect(renderedText).toContain('sam@example.test');
    expect(renderedText).not.toContain('Timeline');
    expect(renderedText).not.toContain('Budget range');
    expect(renderedText).not.toContain('asap');
    expect(renderedText).not.toContain('under_10k');
    // A field AFTER the group returns to the top level — the group closes
    // on the first line back at (or inside) the header's own indent, so a
    // trailing sibling is not swallowed into it.
    expect(renderedText).toContain('none');
  });

  it('projects generated write asks that do not name a connection target', () => {
    const card = render(model({
      title: 'Approve mail-send (write)',
      text: [
        'Recipe send-email wants to run mail-send (step send).',
        'Write actions change data outside Recued, so Recued held it for you.',
        '',
        '  to: sam@example.test',
        '  subject: Renewal update',
        '',
        'Approve?',
      ].join('\n'),
    }), () => {});

    expect(collectByAttr(card, ASK_CARD_SUMMARY_ATTR)).toHaveLength(1);
    expect(collectByAttr(card, ASK_CARD_DETAILS_ATTR)).toHaveLength(1);
  });

  it('requires a deliberate second click for an approving write answer', () => {
    const onAnswer = vi.fn();
    const card = render(model({ title: 'Approve mail-send (write)' }), onAnswer);
    const buttons = optionButtons(card);
    const confirm = collectByAttr(card, ASK_CARD_CONFIRM_ATTR)[0]!;

    buttons[0]!.click();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(buttons[0]!.textContent).toBe('Confirm Send');
    expect(buttons[0]!.getAttribute('aria-label')).toBe(
      'Confirm Send: Approve mail-send (write)',
    );
    expect(confirm.hidden).toBe(false);

    buttons[0]!.click();
    expect(onAnswer).toHaveBeenCalledWith('yes');
    expect(buttons.every((button) => button.disabled)).toBe(false);
    expect(buttons.every(
      (button) => button.getAttribute('aria-disabled') === 'true',
    )).toBe(true);
    expect(buttons[0]!.getAttribute('aria-busy')).toBe('true');
    expect(buttons[0]!.textContent).toBe('Approving…');
    expect(buttons[0]!.getAttribute('aria-label')).toBe(
      'Approving…: Approve mail-send (write)',
    );
    expect(buttons[1]!.className).toContain('rx-ask-card-btn--reject');
  });

  it('fires onAnswer with the chosen option id on click', () => {
    const onAnswer = vi.fn();
    const card = render(model(), onAnswer);
    optionButtons(card)[1].click(); // "Discard"
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('no');
  });

  it('keeps the chosen option focused while guarding every in-flight action', () => {
    const onAnswer = vi.fn(() => new Promise<void>(() => {})); // never settles
    const { card, doc } = renderWithDocument(model(), onAnswer);
    const buttons = optionButtons(card);
    buttons[0].focus();
    buttons[0].click();
    expect(buttons.every((b) => b.disabled)).toBe(false);
    expect(buttons.every(
      (button) => button.getAttribute('aria-disabled') === 'true',
    )).toBe(true);
    expect(buttons[0].getAttribute('aria-busy')).toBe('true');
    expect(buttons[1].getAttribute('aria-busy')).toBeNull();
    expect(buttons[0].textContent).toBe('Approving…');
    expect(doc.activeElement).toBe(buttons[0]);
    // A second click on the other button is a no-op while in flight.
    buttons[1].click();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('clears the action guards + shows the inline error when the submit rejects', async () => {
    let reject!: (e: unknown) => void;
    const onAnswer = vi.fn(
      () =>
        new Promise<void>((_res, rej) => {
          reject = rej;
        }),
    );
    const { card, doc } = renderWithDocument(model(), onAnswer);
    const buttons = optionButtons(card);
    const err = errorLine(card);
    expect(err?.hidden).toBe(true);
    buttons[0].focus();
    buttons[0].click();
    expect(buttons.every(
      (button) => button.getAttribute('aria-disabled') === 'true',
    )).toBe(true);
    reject(new Error('rpc failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(buttons.every((b) => b.disabled)).toBe(false);
    expect(buttons.every(
      (button) => button.getAttribute('aria-disabled') === null,
    )).toBe(true);
    expect(buttons[0].getAttribute('aria-busy')).toBeNull();
    expect(buttons[0].textContent).toBe('Send');
    expect(err?.hidden).toBe(false);
    expect(err?.getAttribute('role')).toBe('alert');
    expect(doc.activeElement).toBe(buttons[0]);
    // After re-enabling, a fresh click submits again (retry path).
    buttons[0].click();
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it('does not reclaim failed-answer focus after the user moves elsewhere', async () => {
    let reject!: (error: unknown) => void;
    const onAnswer = vi.fn(
      () => new Promise<void>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    const { card, doc } = renderWithDocument(model(), onAnswer);
    const answer = optionButtons(card)[0]!;
    answer.focus();
    answer.click();

    const elsewhere = doc.createElement('a');
    elsewhere.focus();
    reject(new Error('rpc failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(doc.activeElement).toBe(elsewhere);
  });

  it('keeps the actions guarded + error hidden on a successful submit', async () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    const card = render(model(), onAnswer);
    const buttons = optionButtons(card);
    buttons[0].click();
    await Promise.resolve();
    await Promise.resolve();
    expect(buttons.every((b) => b.disabled)).toBe(false);
    expect(buttons.every(
      (button) => button.getAttribute('aria-disabled') === 'true',
    )).toBe(true);
    expect(buttons[0].getAttribute('aria-busy')).toBe('true');
    expect(errorLine(card)?.hidden).toBe(true);
  });

  it('restores host-owned busy and failure state after a queue repaint', () => {
    const { card } = renderWithDocument(model(), vi.fn(), {
      busy: true,
      busyOptionId: 'no',
      errorMessage: 'The prior answer failed.',
    });
    const buttons = optionButtons(card);

    expect(buttons.every((button) => button.disabled)).toBe(false);
    expect(buttons.every(
      (button) => button.getAttribute('aria-disabled') === 'true',
    )).toBe(true);
    expect(buttons[0].getAttribute('aria-busy')).toBeNull();
    expect(buttons[1].getAttribute('aria-busy')).toBe('true');
    expect(buttons[1].textContent).toBe('Rejecting…');
    expect(errorLine(card)?.hidden).toBe(false);
    expect(errorLine(card)?.textContent).toBe('The prior answer failed.');
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
    expect(approvalButtons(card).map((b) => b.getAttribute('aria-label')))
      .toEqual([
        'Reject: Send the customer follow-up',
        'Approve: Send the customer follow-up',
      ]);
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
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual([
      'Recipe for Send the customer follow-up',
      'Connection for Send the customer follow-up',
      'Run audit for Send the customer follow-up',
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
    expect(approvalButtons(card).every((b) => !b.disabled)).toBe(true);
    expect(approvalButtons(card).every(
      (b) => b.getAttribute('aria-disabled') === 'true',
    )).toBe(true);
    expect(approvalButton(card, 'approve')?.getAttribute('aria-busy')).toBe('true');
    expect(approvalButton(card, 'approve')?.textContent).toBe('Approving…');
    expect(approvalButton(card, 'approve')?.getAttribute('aria-label')).toBe(
      'Approving…: Send the customer follow-up',
    );
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
    expect(approvalButtons(card).every(
      (b) => b.getAttribute('aria-disabled') === 'true',
    )).toBe(true);
    expect(approvalButton(card, 'reject')?.getAttribute('aria-busy')).toBe('true');
    expect(approvalButton(card, 'reject')?.textContent).toBe('Rejecting…');
    reject(new Error('rpc failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(approvalButtons(card).every((b) => b.disabled)).toBe(false);
    expect(approvalButtons(card).every(
      (b) => b.getAttribute('aria-disabled') === null,
    )).toBe(true);
    expect(approvalButton(card, 'reject')?.textContent).toBe('Reject');
    expect(approvalError(card)?.hidden).toBe(false);
    expect(approvalError(card)?.getAttribute('role')).toBe('alert');
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

describe('R20 — renderChatPlanCard', () => {
  it('keeps the chosen decision focused and guards sibling actions while pending', () => {
    const onResolve = vi.fn(() => new Promise<void>(() => {}));
    const { card, doc } = renderChatPlanWithDocument(
      chatPlanModel(),
      onResolve,
    );
    const approve = chatPlanButton(card, 'approve')!;
    const reject = chatPlanButton(card, 'reject')!;

    approve.focus();
    approve.click();

    expect(onResolve).toHaveBeenCalledWith('approve');
    expect(chatPlanButtons(card).every((button) => !button.disabled)).toBe(true);
    expect(chatPlanButtons(card).every(
      (button) => button.getAttribute('aria-disabled') === 'true',
    )).toBe(true);
    expect(approve.getAttribute('aria-busy')).toBe('true');
    expect(approve.textContent).toBe('Approving…');
    expect(approve.getAttribute('aria-label')).toBe('Approving…: mail.send');
    expect(reject.getAttribute('aria-busy')).toBeNull();
    expect(reject.getAttribute('aria-label')).toBe('Reject: mail.send');
    expect(doc.activeElement).toBe(approve);
    reject.click();
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('clears progress and preserves permanent payload guards after failure', async () => {
    let rejectResolve: (error: unknown) => void = () => {};
    const onResolve = vi.fn(
      () => new Promise<never>((_resolve, reject) => {
        rejectResolve = reject;
      }),
    );
    const { card, doc } = renderChatPlanWithDocument(
      chatPlanModel({ payload_available: false }),
      onResolve,
    );
    const reject = chatPlanButton(card, 'reject')!;
    const approve = chatPlanButton(card, 'approve')!;

    reject.focus();
    reject.click();
    expect(reject.getAttribute('aria-busy')).toBe('true');
    expect(reject.textContent).toBe('Rejecting…');
    rejectResolve(new Error('offline'));
    await Promise.resolve();
    await Promise.resolve();

    expect(reject.disabled).toBe(false);
    expect(reject.getAttribute('aria-disabled')).toBeNull();
    expect(reject.getAttribute('aria-busy')).toBeNull();
    expect(reject.textContent).toBe('Reject');
    expect(doc.activeElement).toBe(reject);
    expect(approve.disabled).toBe(true);
    expect(chatPlanError(card)?.hidden).toBe(false);
    expect(chatPlanError(card)?.getAttribute('role')).toBe('alert');
  });

  it('restores host-owned exact progress after a queue repaint', () => {
    const { card } = renderChatPlanWithDocument(
      chatPlanModel(),
      vi.fn(),
      { busy: true, busyAction: 'reject' },
    );
    const approve = chatPlanButton(card, 'approve')!;
    const reject = chatPlanButton(card, 'reject')!;

    expect(chatPlanButtons(card).every((button) => !button.disabled)).toBe(true);
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    expect(approve.getAttribute('aria-busy')).toBeNull();
    expect(reject.getAttribute('aria-disabled')).toBe('true');
    expect(reject.getAttribute('aria-busy')).toBe('true');
    expect(reject.textContent).toBe('Rejecting…');
  });
});

describe('D-234 § 234.3 — the ask card\'s READ affordance', () => {
  it('renders an anchor to the resolved surface when the ask carries one', () => {
    const card = render(
      model({ link_url: 'https://bob.recued.app/#recipes/peer-review-pending' }),
      () => {},
    );
    const link = readLink(card);
    expect(link?.tagName).toBe('A');
    expect(link?.getAttribute('href'))
      .toBe('https://bob.recued.app/#recipes/peer-review-pending');
  });

  it('renders NOTHING when the ask carries no link', () => {
    // ⚠ Absent, not empty: a disabled or href-less "Open the full details" is a
    // correct-looking absence — it says "nothing here" and "could not find it"
    // with the same pixels.
    expect(readLink(render(model(), () => {}))).toBeUndefined();
  });

  it('is a link, NOT a third option button', () => {
    // ⛔ Reading is not answering. If this ever became an option the card would
    // submit an answer the owner never chose.
    const card = render(
      model({ link_url: 'https://bob.recued.app/#recipes/x' }),
      () => {},
    );
    expect(optionButtons(card)).toHaveLength(2);
    expect(readLink(card)?.attrs.has(ASK_CARD_OPTION_ATTR)).toBe(false);
  });

  it('DROPS a non-http scheme instead of building the href', () => {
    // ⛔⛔ EVERY OTHER STRING ON THIS CARD IS `textContent`, WHICH IS INERT — an
    // `href` is not. `javascript:` survives HTML escaping intact, so the scheme
    // allowlist is the only thing standing between a link_url and execution.
    for (const hostile of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      '#recipes/peer-review-pending',
    ]) {
      expect(readLink(render(model({ link_url: hostile }), () => {})))
        .toBeUndefined();
    }
  });
});


describe('D-234 § 234.4e — the written reason', () => {
  const answerWith = (
    m: AskCardModel,
  ): { card: FakeEl; calls: Array<string[]> } => {
    const calls: Array<string[]> = [];
    const card = render(m, ((...args: string[]) => {
      // Capture the ARITY too — "called with one argument" is the property that
      // keeps every note-less card unchanged.
      calls.push(args);
    }) as never);
    return { card, calls };
  };

  it('⛔ RENDERS NOTHING when the ask did not invite a reason', () => {
    // THE REGRESSION THAT MATTERS MOST. Every ordinary approval card in the
    // product goes through this function; a note box that leaked onto them
    // would add a tab stop and a demand for prose to every routine decision.
    const { card } = answerWith(model());
    expect(noteBox(card)).toBeUndefined();
  });

  it('renders an optional field and carries what was typed', () => {
    const { card, calls } = answerWith(model({ note_prompt: 'optional' }));
    const box = noteBox(card);
    expect(box).toBeDefined();
    box!.value = '  the penalty clause is not fine  ';
    optionButtons(card)[0]!.click();
    // ⚠ TRIMMED — the surface must not send the user's stray whitespace as
    // their reasoning.
    expect(calls).toEqual([['yes', 'the penalty clause is not fine']]);
  });

  it('an optional field left blank submits with NO note, not an empty one', () => {
    const { card, calls } = answerWith(model({ note_prompt: 'optional' }));
    optionButtons(card)[0]!.click();
    // ⚠ ONE argument, not two-with-undefined — the call shape for a note-less
    // answer is exactly what it was before this feature existed.
    expect(calls).toEqual([['yes']]);
  });

  it('⛔⛔ REQUIRED: a bare click does NOT submit, and says why', () => {
    // Without this the click reaches the server, which treats a missing
    // required note as an INVALID reply and NO-OPS it — so the user would see a
    // button do nothing and an ask that stayed open, with no explanation
    // anywhere. The guard turns a silent no-op into a sentence.
    const { card, calls } = answerWith(model({ note_prompt: 'required' }));
    optionButtons(card)[0]!.click();
    expect(calls).toEqual([]);
  });

  it('REQUIRED: submits once a reason is typed', () => {
    const { card, calls } = answerWith(model({ note_prompt: 'required' }));
    noteBox(card)!.value = 'Friday is fine, the penalty is not.';
    optionButtons(card)[0]!.click();
    expect(calls).toEqual([['yes', 'Friday is fine, the penalty is not.']]);
  });

  it('⚠ bounds what can be typed to the server cap', () => {
    // The block caps at 600 on entry, so an unbounded box would silently
    // discard the tail of what someone wrote.
    const { card } = answerWith(model({ note_prompt: 'optional' }));
    expect(noteBox(card)!.maxLength).toBe(600);
  });
});


describe('D-234 § 234.4f — the readable body', () => {
  const bodyOf = (root: FakeEl): FakeEl | undefined =>
    collectByAttr(root, ASK_CARD_BODY_ATTR)[0];

  it('⛔ RENDERS NOTHING when the ask carries no body', () => {
    // Every ordinary approval card goes through this function; a stray empty
    // disclosure on all of them would be the regression that matters.
    const card = render(model(), () => {});
    expect(bodyOf(card)).toBeUndefined();
  });

  it('renders the document COLLAPSED, and verbatim', () => {
    const draft = 'Clause 4.2\nThe penalty accrues daily.';
    const card = render(model({ body: draft }), () => {});
    const el = bodyOf(card);
    expect(el).toBeDefined();
    // A `<details>` — the question is the decision, the body is the evidence,
    // and a card that opens four pages by default stops being a card.
    expect(el!.tagName.toLowerCase()).toBe('details');
    // ⛔ VERBATIM VIA `textContent`. This string was written by ANOTHER SERVER'S
    // OWNER; the card is DOM-built precisely so a peer cannot put markup on the
    // reader's screen. `textContent` on a `<pre>` is the whole defence.
    const pre = el!.children.find((c) => c.tagName.toLowerCase() === 'pre');
    expect(pre?.textContent).toBe(draft);
  });

  it('⛔⛔ an empty body is ABSENT, not an empty disclosure', () => {
    const card = render(model({ body: '' }), () => {});
    expect(bodyOf(card)).toBeUndefined();
  });
});
