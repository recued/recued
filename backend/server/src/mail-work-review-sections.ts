import { RpcError } from '@recued/contracts';
import { MAIL_WORK_SOURCE_ACTION_FORMAT } from './mail-work-linked-source-review.js';
import { MAIL_WORK_SOURCE_STATES } from './mail-work-source-recap.js';

export const MAIL_WORK_SECTION_FORMAT = 'source_sections_v1';
export const MAIL_WORK_CONDITION_REF_FORMAT = 'source_sections_v2';
export const MAIL_WORK_QUOTED_CONDITION_FORMAT = 'source_sections_v3';
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (field: string): never => { throw new RpcError('bad_request',
  'The AI returned an incomplete or unsupported review declaration. The previous review is unchanged.', 400,
  undefined, { field }); };
const shape = (v: unknown, keys: string[], field: string, optional: string[] = []): Record<string, unknown> => {
  if (!object(v) || keys.some(key => !Object.hasOwn(v, key))
    || Object.keys(v).some(key => !keys.includes(key) && !optional.includes(key))) return fail(field);
  return v;
};
const text = (v: unknown, max: number, field: string): string =>
  typeof v === 'string' && v.trim() && v.length <= max ? v : fail(field);
const list = (v: unknown, max: number, field: string): unknown[] => Array.isArray(v) && v.length <= max ? v : fail(field);
const mailSource = (v: unknown): v is string => typeof v === 'string' && /^mail_source_[1-9][0-9]*$/u.test(v);

/** Decode an explicitly versioned wire format, not a repair of a failed reply.
 * Each section declares its role once; citations come from declared fact IDs,
 * and an action's activity is its condition scope. Existing quote/state/action
 * guards still run afterwards. Neither decoder nor guards prove entailment.
 * Legacy objects keep their original validators and diagnostics. */
export const decodeMailWorkReview = (value: unknown): Record<string, unknown> => {
  if (!object(value)) return fail('review');
  const quotedConditions = value.review_format === MAIL_WORK_QUOTED_CONDITION_FORMAT;
  const conditionRefs = value.review_format === MAIL_WORK_CONDITION_REF_FORMAT || quotedConditions;
  if (value.review_format !== MAIL_WORK_SECTION_FORMAT && !conditionRefs) return value;
  const review = shape(value, ['review_format', 'facts', 'questions', 'actions', 'completion_conditions', 'search_queries'], 'review');
  const facts = list(review.facts, 24, 'facts'), questions = list(review.questions, 24, 'questions');
  const actions = list(review.actions, 24, 'actions'), endings = list(review.completion_conditions, 24, 'completion_conditions');
  if (facts.length + questions.length + actions.length + endings.length > 24) return fail('review');
  const queries = list(review.search_queries, 3, 'search_queries').map((q, i) => text(q, 240, `search_queries[${i}]`));
  const ids = new Set<string>();
  const id = (v: unknown, field: string): string => {
    if (typeof v !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/u.test(v) || ids.has(v)) return fail(field);
    ids.add(v); return v;
  };
  const factSources = new Map<string, string>();
  const selectedFacts = new Map<string, { kind: string; source: string; quote: string; state: string }>();
  const claims: Record<string, unknown>[] = facts.map((v, i) => {
    const field = `facts[${i}]`, f = shape(v, ['id', 'kind', 'source', 'quote', 'state'], field);
    if (!['request', 'agreement', 'progress', 'dependency'].includes(String(f.kind))
      || !(mailSource(f.source) || ['owner_notes', 'desired_outcome', 'resolution_note'].includes(String(f.source)))
      || !MAIL_WORK_SOURCE_STATES.includes(f.state as typeof MAIL_WORK_SOURCE_STATES[number])) return fail(field);
    const key = id(f.id, `${field}.id`), source = String(f.source);
    factSources.set(key, source);
    const quote = text(f.quote, 900, `${field}.quote`);
    selectedFacts.set(key, { kind: String(f.kind), source, quote, state: String(f.state) });
    return { id: key, kind: f.kind, basis: mailSource(source) ? 'email' : 'owner',
      sources: mailSource(source) ? [source] : [], excerpt: {
        source, quote, state: f.state,
      } };
  });
  const references = (v: unknown, field: string): { targets: string[]; sources: string[] } => {
    const targets = list(v, 6, field);
    if ((facts.length && !targets.length) || targets.some(t => typeof t !== 'string' || !factSources.has(t))
      || new Set(targets).size !== targets.length) return fail(field);
    return { targets: targets as string[], sources: [...new Set(targets.map(t => factSources.get(String(t))!).filter(mailSource))] };
  };
  for (const [section, kind, values] of [
    ['questions', 'question', questions], ['completion_conditions', 'completion_condition', endings],
  ] as const) {
    values.forEach((v, i) => {
      const field = `${section}[${i}]`, row = shape(v, ['id', 'text', 'targets'], field);
      claims.push({ id: id(row.id, `${field}.id`), kind, basis: 'inference',
        text: text(row.text, 1200, `${field}.text`), ...references(row.targets, `${field}.targets`) });
    });
  }
  actions.forEach((v, i) => {
    const field = `actions[${i}]`, row = shape(v, ['id', 'activity', 'mode', 'permission', 'targets', 'conditions'], field, ['target_use']);
    const activity = text(row.activity, 160, `${field}.activity`);
    if (!['private_preparation', 'contact', 'decision', 'wait'].includes(String(row.mode))) return fail(`${field}.mode`);
    const permission = shape(row.permission, ['kind'], `${field}.permission`, ['quote']);
    const explicit = permission.kind === 'explicitly_permitted';
    if (explicit ? row.mode !== 'contact' || Object.keys(permission).length !== 2
      : Object.keys(permission).length !== 1) return fail(`${field}.permission`);
    const allowed = row.mode === 'contact' ? ['requires_owner_approval', 'explicitly_permitted']
      : row.mode === 'wait' ? ['not_contact', 'requires_owner_approval'] : ['not_contact'];
    if (!allowed.includes(String(permission.kind))) return fail(`${field}.permission`);
    const permission_quote = explicit ? text(permission.quote, 500, `${field}.permission.quote`) : null;
    const conditions = list(row.conditions, 6, `${field}.conditions`).map((v, n) => {
      const where = `${field}.conditions[${n}]`;
      if (conditionRefs) {
        // Bind only the explicitly selected fact. Do not infer prerequisites,
        // copy every action target, change a state or repair the v1 declaration.
        const c = shape(v, quotedConditions ? ['target'] : ['text', 'target'], where);
        const fact = typeof c.target === 'string' ? selectedFacts.get(c.target) : undefined;
        if (!fact || !['current', 'uncertain'].includes(fact.state)
          || !(mailSource(fact.source) || fact.source === 'owner_notes')) return fail(`${where}.target`);
        // v3 deliberately has no authored condition wording. A matched quote
        // can still be irrelevant or misclassified; semantic review checks that.
        if (quotedConditions && fact.kind !== 'dependency') return fail(`${where}.target`);
        return { scope: activity, text: text(quotedConditions ? fact.quote : c.text, 300, `${where}.text`),
          ...(quotedConditions ? { source_quote: true } : {}),
          sources: mailSource(fact.source) ? [fact.source] : [],
          owner_quote: fact.source === 'owner_notes' ? fact.quote : null };
      }
      const c = shape(v, ['text', 'sources', 'owner_quote'], where);
      const sources = list(c.sources, 12, `${where}.sources`);
      if (sources.some(s => !mailSource(s)) || new Set(sources).size !== sources.length) return fail(`${where}.sources`);
      return { scope: activity, text: text(c.text, 300, `${where}.text`), sources,
        owner_quote: c.owner_quote === null ? null : text(c.owner_quote, 12000, `${where}.owner_quote`) };
    });
    if (Object.hasOwn(row, 'target_use') && !['current_work', 'historical_recap'].includes(String(row.target_use))) return fail(`${field}.target_use`);
    claims.push({ id: id(row.id, `${field}.id`), kind: 'next_action', basis: 'inference', text: activity,
      ...references(row.targets, `${field}.targets`), ...(Object.hasOwn(row, 'target_use') ? { target_use: row.target_use } : {}),
      action: { mode: row.mode, scope: activity, permission: permission.kind, permission_quote, conditions } });
  });
  return { review_format: MAIL_WORK_SOURCE_ACTION_FORMAT, claims, search_queries: queries };
};
