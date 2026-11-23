import type { ServerPendingApproval, ServerPendingAsk } from '@recued/contracts';
import { ASK_CARD_AGE_ATTR, renderApprovalCard, renderAskCard, renderChatPlanCard } from '@recued/ui-shared/approval-card';
import { decisionReviewText, decisionSearchText, type DecisionKind } from './decision-search.js';
import { heldAskChatLink, pendingChatPlanHref, type PendingChatPlan } from './pending-chat-plans-store.js';
import { renderPreapprovalAsk } from './preapproval-route.js';
import { serializeShellRoute } from '../shell/route.js';

export interface DecisionSearchMatch {
  id: string; kind: DecisionKind; key: string; at: number;
  title: string; review: string; text: string; identity: string;
}
export const decisionSearchKey = (kind: DecisionKind, id: string) => kind + ':' + id;
export const readDecisionSearchKey = (key: string) => {
  const colon = key.indexOf(':'), kind = key.slice(0, colon), id = key.slice(colon + 1);
  return ['gate', 'ask', 'plan'].includes(kind) && id && colon > 0 ? { kind: kind as DecisionKind, id } : null;
};
export const decisionSearchHref = (id: string) => serializeShellRoute('approvals', id);
export interface DecisionSearchNames { recipes?: ReadonlyMap<string, string>; devices?: ReadonlyMap<string, string> }

/** Render detached, inert review cards with the same shared renderers used by
 * Approvals. Only readable text leaves this projection; no inputs or raw payload
 * fields enter a search snapshot. These handlers have no mutation callers. */
export const createDecisionSearchRecords = (doc: Document) => {
  const match = (kind: DecisionKind, id: string, at: number, card: HTMLElement): DecisionSearchMatch => {
    if (typeof id !== 'string' || !id || !Number.isFinite(at)) throw Error('The pending decision could not be confirmed.');
    const title = card.querySelector<HTMLElement>('.rx-approval-card-title, .rx-ask-card-title, h3');
    const review = decisionReviewText(card), text = decisionSearchText(card);
    // The elapsed waiting label is searchable, but the clock changing that
    // label does not change the request the owner selected.
    card.querySelector<HTMLElement>(`[${ASK_CARD_AGE_ATTR}]`)?.setAttribute('aria-hidden', 'true');
    return { id, kind, key: decisionSearchKey(kind, id), at,
      title: title ? decisionReviewText(title) : kind === 'ask' ? 'Question waiting for you' : 'Decision waiting for you',
      review, text, identity: decisionReviewText(card) };
  };
  return {
    gate: (row: ServerPendingApproval, names: DecisionSearchNames): DecisionSearchMatch => match('gate', row.approval_id, row.created_at,
      renderApprovalCard(doc, { ...row,
        ...(names.recipes?.has(row.recipe_id) ? { recipe_name: names.recipes.get(row.recipe_id) } : {}),
        ...(names.devices?.has(row.initiator_instance) ? { initiator_label: names.devices.get(row.initiator_instance) } : {}),
      }, { onResolve: () => {} }, { links: { recipeHref: serializeShellRoute('recipes', row.recipe_id),
        connectionHref: '#connections', ...(row.recipe_id.trim() ? { runHref: serializeShellRoute('logs', 'recipe', row.recipe_id) } : {}),
        runLabel: 'Recipe run history' } })),
    ask: (row: ServerPendingAsk): DecisionSearchMatch => match('ask', row.ask_id, row.created_at,
      renderPreapprovalAsk(doc, row) ?? renderAskCard(doc, row, { onAnswer: () => {} },
        { showSessionGrantTerms: true, ...heldAskChatLink(row) })),
    plan: (row: PendingChatPlan): DecisionSearchMatch => match('plan', row.plan_id, row.proposed_at,
      renderChatPlanCard(doc, row, { onResolve: () => {} }, { chatHref: pendingChatPlanHref(row) })),
  };
};
