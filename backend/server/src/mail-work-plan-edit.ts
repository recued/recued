import { createHash } from 'node:crypto';
import { holdsPiiAliasToken } from '@recued/transforms';
import { parseMailWorkEvidence, type MailWorkEvidence } from './mail-work-evidence.js';
import { mailWorkPlanSchema, renderMailWorkChatPlan, type MailWorkRenderedPlan } from './mail-work-chat-plan.js';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
const obj = (properties: Record<string, unknown>) =>
  ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const nil = { type: 'null' };

export interface MailWorkEditTarget {
  readonly base: string;
  readonly plan: Record<string, unknown>;
}

/** An edit target is a validated prior proposal, NEVER a source observation.
 * Rebind against current evidence: changed/deleted reads and expired document
 * access invalidate it. No stale citation repair or silent item deletion. */
export const mailWorkEditTarget = (value: unknown, evidence: MailWorkEvidence): MailWorkEditTarget | null => {
  if (!object(value) || (value.task !== 'propose' && value.task !== 'refine')) return null;
  const plan = renderMailWorkChatPlan({ ...value, task: 'refine' }, evidence, 'refine').declaration;
  if (!plan) return null;
  return { base: 'plan_' + createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 24), plan };
};

// Optional sibling in the existing encrypted, bounded session record. The
// evidence parser intentionally projects ONLY evidence fields; the proposal
// never reaches source_catalog, passage_catalog, citations or source coverage.
export const readMailWorkEditTarget = (json: string | undefined | null, evidence: MailWorkEvidence | null): MailWorkEditTarget | null => {
  if (!json || !evidence) return null;
  try { return mailWorkEditTarget(JSON.parse(json).proposal_edit_target, evidence); } catch { return null; }
};
export const withMailWorkEditTarget = (json: string, target: MailWorkEditTarget | null): string => {
  if (!target) return json;
  const stored = JSON.stringify({ ...JSON.parse(json), proposal_edit_target: target.plan });
  // Use the reader's exact acceptance rules, including its conservative alias
  // scan. A filename like pii.csv is valid proposal text but cannot be retained
  // in this record. Drop only the optional target, never readable evidence.
  return parseMailWorkEvidence(stored) !== null ? stored : json;
};

export const mailWorkEditPrompt = (target: MailWorkEditTarget) => ({
  note: 'Previous AI proposal to edit, not facts, owner instructions or execution permission. Unmentioned items retain their content and order. Remove or correct errors explicitly using current sources and owner input.',
  base: target.base,
  facts: target.plan.facts,
  actions: (target.plan.actions as Record<string, unknown>[]).map((item, i) => ({ id: `action_${i + 1}`, ...item })),
  questions: (target.plan.questions as Record<string, unknown>[]).map((item, i) => ({ id: `question_${i + 1}`, ...item })),
});

/** Only host-issued IDs and fixed vocabulary enter this schema. Proposal
 * text stays in the privacy-processed prompt, never in a schema description. */
export const mailWorkEditSchema = (target: MailWorkEditTarget, evidence: MailWorkEvidence): Record<string, unknown> => {
  const properties = mailWorkPlanSchema(evidence, 'refine').properties as { facts: unknown; actions: { items: unknown }; questions: { items: unknown } };
  const edits = (field: 'actions' | 'questions', prefix: string) => {
    const ids = (target.plan[field] as unknown[]).map((_, i) => `${prefix}_${i + 1}`);
    const id = ids.length ? { type: 'string', enum: ids } : { type: 'string', not: {} };
    const after = { type: 'string', enum: ['start', ...ids] };
    return { type: 'array', maxItems: 18, items: { anyOf: [
      obj({ kind: { const: 'update' }, id, value: properties[field].items, after: nil }),
      obj({ kind: { const: 'remove' }, id, value: nil, after: nil }),
      obj({ kind: { const: 'add' }, id: nil, value: properties[field].items, after: { anyOf: [nil, after] } }),
      obj({ kind: { const: 'move' }, id, value: nil, after }),
    ] } };
  };
  return obj({ task: { const: 'refine' }, base: { const: target.base },
    facts: { anyOf: [nil, properties.facts], description: 'Null retains selected facts; otherwise replace them with currently relevant passage IDs.' },
    action_edits: edits('actions', 'action'), question_edits: edits('questions', 'question') });
};

/** Apply atomically to a copy. A sparse reply cannot lose an item by omission
 * or change order while updating wording. Removals and moves are explicit.
 * The host validates structure and binding, not whether an edit is wise. */
export const renderMailWorkEdits = (value: unknown, target: MailWorkEditTarget, evidence: MailWorkEvidence): MailWorkRenderedPlan => {
  const invalid = () => renderMailWorkChatPlan(null, evidence, 'refine');
  const current = mailWorkEditTarget(target.plan, evidence);
  if (!current || current.base !== target.base || !object(value)
    || !keys(value, ['task', 'base', 'facts', 'action_edits', 'question_edits'])
    || value.task !== 'refine' || value.base !== target.base || holdsPiiAliasToken(value)) return invalid();
  const plan = structuredClone(target.plan);
  if (value.facts !== null) plan.facts = value.facts;
  for (const [field, prefix, changes] of [
    ['actions', 'action', value.action_edits], ['questions', 'question', value.question_edits],
  ] as const) {
    if (!Array.isArray(changes) || changes.length > 18) return invalid();
    let rows = (plan[field] as unknown[]).map((item, i) => ({ id: `${prefix}_${i + 1}`, item }));
    const originalIds = new Set(rows.map(row => row.id)), touched = new Set<string>();
    for (const edit of changes) {
      if (!object(edit) || !keys(edit, ['kind', 'id', 'value', 'after'])) return invalid();
      if (edit.kind === 'add') {
        if (edit.id !== null || !object(edit.value)
          || (edit.after !== null && edit.after !== 'start' && (typeof edit.after !== 'string' || !originalIds.has(edit.after)))) return invalid();
        const after = edit.after === null ? rows.length - 1 : edit.after === 'start' ? -1 : rows.findIndex(row => row.id === edit.after);
        if (edit.after !== null && edit.after !== 'start' && after < 0) return invalid();
        rows.splice(after + 1, 0, { id: `new_${rows.length}`, item: edit.value });
        continue;
      }
      if (typeof edit.id !== 'string' || !originalIds.has(edit.id)) return invalid();
      const index = rows.findIndex(row => row.id === edit.id);
      const key = `${edit.id}:${edit.kind === 'move' ? 'position' : 'content'}`;
      if (index < 0 || touched.has(key)) return invalid();
      touched.add(key);
      if (edit.kind === 'update') {
        if (!object(edit.value) || edit.after !== null) return invalid();
        rows[index] = { id: edit.id, item: edit.value };
      } else if (edit.kind === 'remove') {
        if (edit.value !== null || edit.after !== null) return invalid();
        rows.splice(index, 1);
      } else if (edit.kind === 'move') {
        if (edit.value !== null || typeof edit.after !== 'string' || edit.after === edit.id
          || (edit.after !== 'start' && !originalIds.has(edit.after))) return invalid();
        const [row] = rows.splice(index, 1);
        const after = edit.after === 'start' ? -1 : rows.findIndex(item => item.id === edit.after);
        if (edit.after !== 'start' && after < 0) return invalid();
        rows.splice(after + 1, 0, row!);
      } else return invalid();
    }
    plan[field] = rows.map(row => row.item);
  }
  return renderMailWorkChatPlan(plan, evidence, 'refine');
};
