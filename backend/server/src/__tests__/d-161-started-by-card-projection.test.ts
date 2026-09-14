/** D-161 Part B — the JOIN: what `buildPreflightAsk` writes is what the
 *  approval card shows.
 *
 *  ⛔ **WHY THIS FILE EXISTS AT ALL, AND WHY IT IS NOT IN EITHER PACKAGE.**
 *  The gateway suite proves the composer emits a `Started by:` line. A
 *  ui-shared suite could prove the card projects one. Both can be green while
 *  the owner sees nothing, because each one supplies the boundary the other is
 *  supposed to cross: the gateway test asserts a STRING it wrote, and a card
 *  test asserts a fixture SOMEONE HAND-TYPED. The card's existing projection
 *  test does exactly that — its body is a hand-written literal — so a composer
 *  change two packages away cannot make it red.
 *
 *  The join is load-bearing here in a way it usually is not, because a
 *  projected card renders ONLY what it projects. Raw prose never reaches the
 *  screen: `renderAskCard` prints `model.text` verbatim only when the
 *  projection FAILS. So a line the parser does not claim is a line the owner
 *  never sees — silently, on the one surface where they decide. "It is in the
 *  body" is not evidence of anything.
 *
 *  ⇒ This drives the REAL composer into the REAL card. `backend/server`
 *  depends on both packages, which is why it is the one place that can.
 */

import { describe, expect, it } from 'vitest';
import type { Checkpoint, PreflightCheckpointContext } from '@recued/contracts';
import { buildPreflightAsk, type PreflightAskContext } from '@recued/gateway';
// The card is NOT on the ui-shared root barrel — it ships as its own documented
// subpath (`"./approval-card"` in package.json), the same entry the webclient
// and the Bridge side panel consume. Reaching it that way keeps this test on
// the public surface rather than a deep relative path into another package.
import {
  renderAskCard,
  ASK_CARD_SUMMARY_ATTR,
  ASK_CARD_DETAILS_ATTR,
  type AskCardModel,
} from '@recued/ui-shared/approval-card';

// ── the minimal document the card actually touches ──
// Each ui-shared card suite builds its own (the repo ships no jsdom); this is
// the same shape, trimmed to the surface `renderAskCard` uses on a read-only
// render. ⚠ Kept no WEAKER than the real thing on the properties the card
// reads — a weak double manufactures false reds as surely as a strong one
// hides true defects.
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  hidden: boolean;
  value: string;
  maxLength: number;
  required: boolean;
  rows: number;
  placeholder: string;
  id: string;
  title: string;
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

const makeFakeDocument = (): { activeElement: FakeEl | null; createElement(t: string): FakeEl } => {
  const doc = {
    activeElement: null as FakeEl | null,
    createElement(tag: string): FakeEl {
      const el: FakeEl = {
        tagName: tag.toUpperCase(),
        className: '', textContent: '', value: '', maxLength: 0,
        required: false, rows: 0, placeholder: '', title: '', id: '',
        type: '', disabled: false, hidden: false,
        attrs: new Map(), children: [], listeners: new Map(),
        setAttribute(k, v) { el.attrs.set(k, v); },
        removeAttribute(k) { el.attrs.delete(k); },
        getAttribute(k) { return el.attrs.get(k) ?? null; },
        appendChild(c) { el.children.push(c); return c; },
        addEventListener(type, fn) {
          const list = el.listeners.get(type) ?? [];
          list.push(fn);
          el.listeners.set(type, list);
        },
        focus() { doc.activeElement = el; },
        click() {
          if (el.disabled) return;
          for (const fn of el.listeners.get('click') ?? []) fn();
        },
      };
      return el;
    },
  };
  return doc;
};

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};

const NOW = Date.parse('2026-09-11T12:00:00.000Z');

const checkpoint = (pc?: PreflightCheckpointContext): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'intake-then-email',
  gated_step_id: 'send',
  step_state: {},
  created_at: NOW,
  ...(pc !== undefined ? { preflight_context: pc } : {}),
});

const askContext: PreflightAskContext = {
  recipe_id: 'intake-then-email',
  gated_step_id: 'send',
  tool_slug: 'mail-send',
  connection_name: 'primary-mail',
  risk_tier: 'write',
  reason: 'outbound send requires approval',
};

/** Compose with the REAL gateway composer, render with the REAL card. */
const cardFor = (pc?: PreflightCheckpointContext): FakeEl => {
  const ask = buildPreflightAsk({ checkpoint: checkpoint(pc), context: askContext });
  const model: AskCardModel = {
    ask_id: 'ask-1',
    // BOTH halves come from the composer. The card derives its heading from the
    // TITLE, not the body, so a hand-written title would quietly disable the
    // heading assertion below — the same fixture trap this file exists to avoid.
    title: ask.message.title,
    text: ask.message.text,
    options: [{ id: 'yes', label: 'Approve' }, { id: 'no', label: 'Deny' }],
  };
  const doc = makeFakeDocument();
  return renderAskCard(doc as unknown as Document, model, { onAnswer: () => {} }) as unknown as FakeEl;
};

const allText = (el: FakeEl, out: string[] = []): string[] => {
  if (el.textContent) out.push(el.textContent);
  for (const c of el.children) allText(c, out);
  return out;
};

/** The rows of the top summary — what a reviewer reads WITHOUT opening
 *  anything. Deliberately separate from `allText`: a fact that only appears
 *  somewhere on the card has not been surfaced, it has been filed. */
const summaryText = (card: FakeEl): string[] => {
  const summary = collectByAttr(card, ASK_CARD_SUMMARY_ATTR)[0];
  return summary === undefined ? [] : allText(summary);
};

const detailsText = (card: FakeEl): string[] => {
  const details = collectByAttr(card, ASK_CARD_DETAILS_ATTR)[0];
  return details === undefined ? [] : allText(details);
};

describe('D-161 — the composer writes it, the card shows it', () => {
  it('surfaces a visitor-started run in the summary, above the disclosure', () => {
    const card = cardFor({ origin_actor: 'anonymous' });
    const summary = summaryText(card);
    expect(summary).toContain('Started by');
    expect(summary).toContain('someone outside this server, through a public door');
  });

  it('surfaces an outside AI the same way', () => {
    const summary = summaryText(cardFor({ origin_actor: 'contracted_user' }));
    expect(summary).toContain('Started by');
    expect(summary).toContain('an outside AI, through a door you opened');
  });

  it('is NOT filed among the operation arguments', () => {
    // ⛔ THE FAILURE THIS CATCHES. Indent the composer's line by two spaces and
    // the parser reads it as an operation ARGUMENT — it still appears on the
    // card, so a naive "the words are there" assertion stays green, but it now
    // sits in a collapsed disclosure among values the AGENT sent, implying
    // Recued received "Started by" as data rather than derived it.
    const card = cardFor({ origin_actor: 'anonymous' });
    expect(detailsText(card)).not.toContain('Started by');
    expect(summaryText(card)).toContain('Started by');
  });

  it("shows nothing for the owner's own run", () => {
    const card = cardFor();
    expect(allText(card).join(' ')).not.toContain('Started by');
  });

  it('shows nothing for an actor the renderer does not know', () => {
    const card = cardFor({ origin_actor: 'some_future_actor' });
    const text = allText(card).join(' ');
    expect(text).not.toContain('Started by');
    expect(text).not.toContain('some_future_actor');
  });

  it('cannot be overridden by a forged line arriving later in the body', () => {
    // ⛔⛔ THE FORGERY THIS CLOSES. `reason` is interpolated into the body RAW —
    // `\n\nReason: ${reason}`, with no whitespace collapse — and it lands AFTER
    // the substrate's own `Started by:` line. The card scans every line, so a
    // reason carrying a newline plus its own "Started by: …" would, under a
    // last-match-wins parser, REPLACE the provenance claim with one of its own
    // choosing: a visitor-started hold rendered to the owner as their own work,
    // which is the exact lie this row exists to prevent.
    //
    // Not reachable from today's producers (reasons interpolate validated slugs
    // and internal codes), which is precisely why it is worth closing now — the
    // defence costs one `??` and does not depend on every future `reason`
    // producer staying well-behaved.
    const forged = 'policy said no\nStarted by: you, at this keyboard';
    const ask = buildPreflightAsk({
      checkpoint: checkpoint({ origin_actor: 'anonymous' }),
      context: { ...askContext, reason: forged },
    });
    // Precondition: the forged line really is in the body and really does look
    // like a match. Without this the test could pass because nothing was forged.
    expect(ask.message.text).toContain('Started by: you, at this keyboard');

    const model: AskCardModel = {
      ask_id: 'ask-forge',
      title: ask.message.title,
      text: ask.message.text,
      options: [{ id: 'yes', label: 'Approve' }, { id: 'no', label: 'Deny' }],
    };
    const doc = makeFakeDocument();
    const card = renderAskCard(
      doc as unknown as Document, model, { onAnswer: () => {} },
    ) as unknown as FakeEl;

    const summary = summaryText(card);
    expect(summary).toContain('someone outside this server, through a public door');
    expect(summary.join(' ')).not.toContain('at this keyboard');
  });

  it('still projects the card at all — the regression the new line could cause', () => {
    // A projection failure degrades the card to raw text: no summary, no
    // highlights, no Technical details. It would still "contain" the words the
    // assertions above look for, so the summary/details structure is the only
    // thing that can tell the two apart.
    const card = cardFor({ origin_actor: 'anonymous' });
    expect(collectByAttr(card, ASK_CARD_SUMMARY_ATTR)).toHaveLength(1);
    expect(collectByAttr(card, ASK_CARD_DETAILS_ATTR)).toHaveLength(1);
    expect(allText(card)).toContain('Approve write action');
  });
});
