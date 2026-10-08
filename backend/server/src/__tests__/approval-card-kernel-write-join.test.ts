/** The JOIN for a held Recued built-in write: what the composer writes and the
 *  server resolves is what the approval card shows.
 *
 *  ⛔ Found on a live drive of the Calendar Invites pack (2026-10-07). Three
 *  approvals in a row — a booking, a commitment, an event on the local
 *  calendar — each said "This action changes data outside Recued.", which was
 *  false, and showed their times as millisecond counts. The composer, the
 *  resolver and the card each had a suite; none of them composed the others.
 *
 *  ⇒ The real composer, the real detail resolver and the real card, on the
 *  shape the drive held: a reactive run's SINGLE-MEMBER batch. */

import { describe, expect, it } from 'vitest';
import type { BatchedApprovalItem, Checkpoint } from '@recued/contracts';
import { buildPreflightAsk, type PreflightAskContext } from '@recued/gateway';
import {
  renderAskCard,
  ASK_CARD_DETAILS_ATTR,
  ASK_CARD_SUMMARY_ATTR,
  type AskCardModel,
} from '@recued/ui-shared/approval-card';

import { createAskCardDetailResolver } from '../ask-card-held-op-details.js';

interface FakeEl {
  tagName: string; className: string; textContent: string; type: string;
  disabled: boolean; hidden: boolean; value: string; maxLength: number;
  required: boolean; rows: number; placeholder: string; id: string; title: string;
  attrs: Map<string, string>; children: FakeEl[]; listeners: Map<string, Array<() => void>>;
  setAttribute(k: string, v: string): void; removeAttribute(k: string): void;
  getAttribute(k: string): string | null; appendChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void; focus(): void; click(): void;
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
const allText = (el: FakeEl, out: string[] = []): string[] => {
  if (el.textContent) out.push(el.textContent);
  for (const c of el.children) allText(c, out);
  return out;
};
const visibleText = (el: FakeEl, out: string[] = []): string[] => {
  if (el.hidden) return out;
  if (el.textContent) out.push(el.textContent);
  for (const c of el.children) visibleText(c, out);
  return out;
};

const START = 1792256400000; // 2026-10-17T17:00:00Z = 10:00 in Los Angeles

/** Compose, resolve and render one held kernel write as the drive held it. */
const cardFor = async (slug: string, step: string, args: Record<string, unknown>): Promise<FakeEl> => {
  const checkpoint: Checkpoint = {
    checkpoint_id: 'cp1', run_id: 'run1', recipe_id: 'calendar-invites', gated_step_id: step,
    step_state: { [step]: { input: args } }, created_at: 0,
    approved_target: { ingredient_slug: slug },
  } as Checkpoint;
  const member: BatchedApprovalItem = {
    member_id: 'm1', canonical_payload_hash: 'h1', summary: 's', args_preview: args,
  };
  const context: PreflightAskContext = {
    recipe_id: 'calendar-invites', gated_step_id: step, tool_slug: slug, risk_tier: 'write',
    reason: `op '${slug}' requires preflight approval under the active trust ceiling`,
    batch: { batch_id: 'b1', payload_version: 1, items: [member], unit: { kind: 'fire', id: 'run1' } },
  };
  const ask = buildPreflightAsk({ checkpoint, context });
  const details = await createAskCardDetailResolver({
    getCheckpoint: async () => checkpoint,
    getAnchor: async () => ({ commit_status: 'awaiting_approval', recipe_id: 'calendar-invites' } as never),
    resolveArgEditSchema: () => ({ fields: [] }),
    getBatch: async () => ({ members: [member] }),
    timeZone: 'America/Los_Angeles',
  })({
    ask_id: 'a1', handler_kind: ask.handler.kind, handler_payload: ask.handler.payload,
  } as never);
  const model: AskCardModel = {
    ask_id: 'a1',
    title: ask.message.title,
    text: ask.message.text,
    options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    ...(details !== null ? { details } : {}),
  };
  return renderAskCard(makeFakeDocument() as unknown as Document, model, { onAnswer: () => {} }) as unknown as FakeEl;
};

describe('a held built-in write, composer → resolver → card', () => {
  it('a booking: says it stays in Recued, and shows its slot as a time in a named zone', async () => {
    const card = await cardFor('booking-create', 'created', {
      title: 'Dental check-up — 1 Harbour Rd',
      idempotency_key: 'calendar-invite-booking:6a2e',
      lifecycle_state: 'pending',
      slot_start_at: START,
      slot_end_at: START + 3_600_000,
    });
    const visible = visibleText(card);
    expect(visible).toContain('Write actions change your data in Recued.');
    expect(visible.join(' ')).not.toContain('outside Recued');
    const summary = allText(collectByAttr(card, ASK_CARD_SUMMARY_ATTR)[0]!);
    expect(summary).toEqual(expect.arrayContaining([
      'Title', 'Dental check-up — 1 Harbour Rd',
      'Slot start', '17 Oct 2026, 10:00 GMT-7',
      'Slot end', '17 Oct 2026, 11:00 GMT-7',
    ]));
    // The technical bits keep every argument — readable, in UTC, and named so.
    expect(allText(collectByAttr(card, ASK_CARD_DETAILS_ATTR)[0]!))
      .toContain('17 Oct 2026, 17:00 UTC');
    // No millisecond count anywhere the owner can look.
    expect(allText(card).join(' ')).not.toContain(String(START));
  });

  it("a commitment: its statement heads the summary", async () => {
    const card = await cardFor('commitment-create', 'created', {
      direction: 'outbound',
      statement: "Answer Harbour Dental's invite",
      idempotency_key: 'calendar-invite-answer:6a2e',
      derivation: 'mail_extracted',
      promised_for_at: START,
      expiry_policy: 'strict_expire',
    });
    const summary = allText(collectByAttr(card, ASK_CARD_SUMMARY_ATTR)[0]!);
    // Action first, then the statement as the first resolved row.
    expect(summary.slice(0, 4)).toEqual(['Action', 'commitment-create', 'Statement', "Answer Harbour Dental's invite"]);
    expect(summary).toEqual(expect.arrayContaining(['Promised for', '17 Oct 2026, 10:00 GMT-7']));
  });

  it('an event: local calendar stays in Recued; Google does not', async () => {
    const event = (slug: string): Record<string, unknown> => ({
      slug, calendar_id: 'primary',
      event: { calendar_id: 'primary', summary: 'Dental check-up', start_at: START, end_at: START + 3_600_000 },
    });
    const local = await cardFor('calendar-create', 'created', event('local'));
    expect(visibleText(local)).toContain('Write actions change your data in Recued.');
    expect(allText(collectByAttr(local, ASK_CARD_SUMMARY_ATTR)[0]!).slice(0, 4))
      .toEqual(['Action', 'calendar-create', 'Summary', 'Dental check-up']);

    const google = await cardFor('calendar-create', 'created', event('work-google'));
    expect(visibleText(google)).toContain('Write actions change data outside Recued.');
  });
});
