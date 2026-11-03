/** D-336 slice E — the relationship on a held save's approval card, changed as part of
 *  approving it: no edit mode and no second step (D-336 §3.5, §3.6).
 *
 *  The card shows the save's summary and, below it, the relationship in the owner's memory
 *  form (`renderMemoryClaimFields`): a first part, a relation and a second part, each end
 *  words, "you", or a linked contact or thing they own. The owner may link a name, correct
 *  the relation or write their own, add one, or remove it. Saying yes saves what is showing;
 *  what is left as proposed is approved as the agent sent it.
 *
 *  The summary is a field too where the server takes a change to it: it is what recall
 *  returns, so a relationship corrected beside the agent's words would still be recalled
 *  as the agent wrote it (audit 2026-10-31).
 *
 *  Only a card whose server applies a change offers it (`editable_args`): a server that
 *  does not name an argument would ignore its change and run the original. */

import {
  normalizeClaimText,
  readMemoryClaim,
  type ApprovalValueLabels,
  type MemoryClaim,
  type MemoryClaimEnd,
} from '@recued/contracts';

import {
  MEMORY_CLAIM_TAKES_STYLES,
  MEMORY_FIELD_ATTR,
  renderMemoryClaimFields,
  type MemoryComposeClaim,
  type MemoryComposeLinking,
} from '../data/memory-lens.js';

/** The card's relationship while the owner looks at it. */
export interface PlanClaimDraft {
  /** What the card shows; absent when the save has none. */
  claim?: MemoryComposeClaim;
  /** The relationship as proposed (`planClaimKey`), to tell a change from none. */
  readonly proposed: string;
  /** The summary as the card shows it, where the card may change it. */
  summary?: string;
  /** The summary as proposed, trimmed, to tell a change from none. */
  readonly proposedSummary?: string;
  /** The contacts or things offered for linking one end. */
  linking?: MemoryComposeLinking;
  /** Why the last approval was refused, in the server's words. */
  error?: string;
}

/** The action on a control inside the card's relationship. */
export const PLAN_CLAIM_ACTION_ATTR = 'data-chat-plan-claim-action';
/** The relationship's host on the card, valued with its plan id. */
export const PLAN_CLAIM_ATTR = 'data-chat-plan-claim';

/** One end as a `memory.write` call writes it, as the owner's form holds it. A linked end
 *  is named as the card's labels name it (`value_labels.claim`). */
const endOfCall = (raw: unknown, names: Readonly<Record<string, string>> | undefined): MemoryClaimEnd | undefined => {
  if (typeof raw === 'string') {
    const words = raw.trim();
    if (words === '') return undefined;
    return normalizeClaimText(words) === 'owner' ? { owner: true } : { text: words };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const call = raw as Record<string, unknown>;
  const named = (id: string): string | undefined =>
    names !== undefined && Object.hasOwn(names, id) && typeof names[id] === 'string' ? names[id] : undefined;
  if (typeof call.contact === 'string' && call.contact.trim() !== '') {
    return { contact_id: call.contact.trim(), name: named(call.contact) ?? call.contact.trim() };
  }
  if (typeof call.asset === 'string' && call.asset.trim() !== '') {
    return { asset_id: call.asset.trim(), name: named(call.asset) ?? 'a thing you own' };
  }
  return undefined;
};

/** The relationship a held save proposes, as the card edits it: the call's `claim`, or one
 *  already changed on a card (stored as the owner's forms write it). */
export const planClaimOf = (args: unknown, labels?: ApprovalValueLabels): MemoryComposeClaim | undefined => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const raw = (args as { claim?: unknown }).claim;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const stored = readMemoryClaim(raw);
  if (stored !== undefined) return stored;
  const call = raw as { subject?: unknown; relation?: unknown; object?: unknown };
  const names = labels !== undefined && Object.hasOwn(labels, 'claim') ? labels.claim : undefined;
  const subject = endOfCall(call.subject, names);
  const object = endOfCall(call.object, names);
  const relation = typeof call.relation === 'string' ? call.relation.trim() : '';
  return subject !== undefined && object !== undefined && relation !== '' ? { subject, relation, object } : undefined;
};

/** The relationship as approving saves it: trimmed, `null` when there is none (or its three
 *  parts are all blank), or what is still missing. */
export const planClaimToSave = (
  claim: MemoryComposeClaim | undefined,
): { claim: MemoryClaim | null } | { error: string } => {
  if (claim === undefined) return { claim: null };
  const end = (value: MemoryClaimEnd): MemoryClaimEnd | undefined =>
    'text' in value ? (value.text.trim() === '' ? undefined : { text: value.text.trim() }) : value;
  const subject = end(claim.subject);
  const object = end(claim.object);
  const relation = claim.relation.trim().replace(/\s+/g, ' ');
  if (subject === undefined && object === undefined && relation === '') return { claim: null };
  if (subject === undefined || object === undefined || relation === '') {
    return { error: 'A relationship needs a first part, a relation and a second part. Fill in all three, or remove it.' };
  }
  return { claim: { subject, relation, object } };
};

const planClaimKey = (claim: MemoryComposeClaim | undefined): string => {
  const saved = planClaimToSave(claim);
  return 'error' in saved ? '' : JSON.stringify(saved.claim);
};

/** A card's relationship, and its summary where `editable` names it, as they first show. */
export const planClaimDraft = (
  args: unknown,
  labels?: ApprovalValueLabels,
  editable?: readonly string[],
): PlanClaimDraft => {
  const claim = planClaimOf(args, labels);
  const raw = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? (args as { summary?: unknown }).summary : undefined;
  const summary = editable?.includes('summary') === true && typeof raw === 'string' ? raw : undefined;
  return {
    ...(claim !== undefined ? { claim } : {}),
    proposed: planClaimKey(claim),
    ...(summary !== undefined ? { summary, proposedSummary: summary.trim() } : {}),
  };
};

/** The relationship's part of approving: `undefined` when it is as proposed. */
const relationshipEdit = (draft: PlanClaimDraft): { claim: MemoryClaim | null } | { error: string } | undefined => {
  const saved = planClaimToSave(draft.claim);
  if ('error' in saved) return saved;
  return JSON.stringify(saved.claim) === draft.proposed ? undefined : saved;
};

/** Whether the owner changed the relationship on the card, a half-written one included. The
 *  notes the save meets were found for the one proposed (slice G); the summary is no part. */
export const planRelationshipChanged = (draft: PlanClaimDraft): boolean => relationshipEdit(draft) !== undefined;

/** What the card says when its summary is cleared. The server refuses it in the same words. */
export const PLAN_SUMMARY_EMPTY = 'Write what to remember, or say no to saving it.';

/** What approving sends as the card's change: only what differs from the proposal, nothing
 *  when the summary and the relationship are as proposed. */
export const planClaimEdit = (
  draft: PlanClaimDraft,
): { claim?: MemoryClaim | null; summary?: string } | { error: string } | undefined => {
  const relationship = relationshipEdit(draft);
  if (relationship !== undefined && 'error' in relationship) return relationship;
  const summary = draft.summary?.trim();
  if (summary === '') return { error: PLAN_SUMMARY_EMPTY };
  const changed = summary !== undefined && summary !== draft.proposedSummary ? summary : undefined;
  if (relationship === undefined && changed === undefined) return undefined;
  return { ...relationship, ...(changed !== undefined ? { summary: changed } : {}) };
};

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** What the card's relationship says before its fields. */
export const PLAN_CLAIM_NOTE = 'Change the relationship before you say yes, if it is not right. Saying yes saves it as shown here.';
/** The same, where the summary is a field too. */
export const PLAN_SUMMARY_NOTE = 'Change the summary or the relationship before you say yes, if either is not right. Saying yes saves them as shown here.';

/** Rows for a summary of `text`'s length: all of it in view on a phone's card, up to six. */
const summaryRows = (text: string): number => Math.min(6, Math.max(2, Math.ceil(text.length / 40)));

/** The card's summary and relationship: the owner's memory form, its fields read-only while
 *  approving. */
export const renderPlanClaimEditor = (draft: PlanClaimDraft, idPrefix: string, busy: boolean): string => {
  const readonly = busy ? ' readonly' : '';
  const summary = draft.summary === undefined ? '' : `<div class="memory-field">
    <label class="memory-field-label" for="${idPrefix}-summary">Summary</label>
    <textarea id="${idPrefix}-summary" class="memory-textarea" rows="${summaryRows(draft.summary)}" ${MEMORY_FIELD_ATTR}="summary"${readonly}>${escape(draft.summary)}</textarea>
  </div>`;
  return `<p class="chat-plan-claim-note">${escape(draft.summary === undefined ? PLAN_CLAIM_NOTE : PLAN_SUMMARY_NOTE)}</p>`
    + summary
    + renderMemoryClaimFields(draft, PLAN_CLAIM_ACTION_ATTR, readonly, idPrefix)
    + (draft.error !== undefined ? `<p class="chat-plan-claim-error" role="alert">${escape(draft.error)}</p>` : '');
};

/** The memory form's look, in the card's terms. */
export const PLAN_CLAIM_STYLES = `
[${PLAN_CLAIM_ATTR}] { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
[${PLAN_CLAIM_ATTR}] .chat-plan-claim-note { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.4; }
[${PLAN_CLAIM_ATTR}] .chat-plan-claim-error { margin: 0; color: var(--danger); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
[${PLAN_CLAIM_ATTR}] .memory-claim { display: flex; flex-direction: column; gap: 8px; min-width: 0; margin: 0; padding: 10px;
  border: 1px solid var(--border-subtle); border-radius: var(--chat-radius-control); background: var(--surface); }
[${PLAN_CLAIM_ATTR}] .memory-claim > legend { padding: 0 4px; }
[${PLAN_CLAIM_ATTR}] .memory-claim-empty { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
[${PLAN_CLAIM_ATTR}] .memory-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
[${PLAN_CLAIM_ATTR}] .memory-field-label { font-size: 12px; font-weight: 650; color: var(--muted); }
[${PLAN_CLAIM_ATTR}] .memory-field-hint { font-weight: 400; color: var(--muted); }
[${PLAN_CLAIM_ATTR}] .memory-input, [${PLAN_CLAIM_ATTR}] .memory-textarea { box-sizing: border-box; width: 100%; min-width: 0;
  min-height: var(--wc-control-h, 38px); font: inherit; font-size: 13px; padding: 6px 10px; border: 1px solid var(--border);
  border-radius: var(--chat-radius-control); background: var(--surface); color: var(--fg); }
[${PLAN_CLAIM_ATTR}] .memory-textarea { line-height: 1.4; resize: vertical; }
[${PLAN_CLAIM_ATTR}] .memory-btn { box-sizing: border-box; min-height: var(--wc-control-h, 38px); display: inline-flex; align-items: center;
  justify-content: center; font: inherit; font-size: 12px; padding: 6px 12px; border: 1px solid var(--border);
  border-radius: var(--chat-radius-control); background: var(--surface); color: var(--fg); cursor: pointer; }
[${PLAN_CLAIM_ATTR}] .memory-claim > .memory-btn, [${PLAN_CLAIM_ATTR}] .memory-claim-empty > .memory-btn,
[${PLAN_CLAIM_ATTR}] .memory-claim-end > .memory-btn { align-self: flex-start; }
[${PLAN_CLAIM_ATTR}] .memory-claim-offers, [${PLAN_CLAIM_ATTR}] .memory-claim-matches { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
[${PLAN_CLAIM_ATTR}] .memory-claim-matches > .memory-btn { flex-wrap: wrap; gap: 6px; }
[${PLAN_CLAIM_ATTR}] .memory-claim-linked { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px; font-size: 13px;
  color: var(--fg); overflow-wrap: anywhere; }
[${PLAN_CLAIM_ATTR}] .memory-compose-error { margin: 0; color: var(--danger); font-size: 12px; overflow-wrap: anywhere; }
${MEMORY_CLAIM_TAKES_STYLES}
@media (max-width: 520px) {
  [${PLAN_CLAIM_ATTR}] .memory-btn, [${PLAN_CLAIM_ATTR}] .memory-input { min-height: 44px; }
  [${PLAN_CLAIM_ATTR}] .memory-claim-offers > .memory-btn, [${PLAN_CLAIM_ATTR}] .memory-claim-matches > .memory-btn { flex: 1 1 auto; }
}
`;
