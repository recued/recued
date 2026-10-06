import { holdsPiiAliasToken } from '@recued/transforms';
import type { MailWorkEvidence } from './mail-work-evidence.js';
import { displayMailWorkSourceText, mailWorkPlanSources, mailWorkSourcePassages,
  type MailWorkQuoteSource } from './mail-work-source-recap.js';

export type MailWorkPlanTask = 'investigate' | 'propose' | 'refine';
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every(key => key in value);
const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= max && !value.includes('\u0000');
const array = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length <= max;
const obj = (properties: Record<string, unknown>): Record<string, unknown> =>
  ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: unknown, max: number): Record<string, unknown> => ({ type: 'array', items, maxItems: max });
const str = { type: 'string' };

// One operation determines presentation. The model cannot separately describe
// a draft and classify it as contact, or declare its own permission grant.
// This is a proposal vocabulary, never a dispatcher or an execution authority.
const operations = {
  draft: { verb: 'Draft', prefix: 'Private preparation' },
  outline: { verb: 'Outline', prefix: 'Private preparation' },
  compare: { verb: 'Compare', prefix: 'Private preparation' },
  analyze: { verb: 'Analyze', prefix: 'Private preparation' },
  calculate: { verb: 'Calculate', prefix: 'Private preparation' },
  prepare: { verb: 'Prepare', prefix: 'Private preparation' },
  report: { verb: 'Report on', prefix: 'Private preparation' },
  ask: { verb: 'Ask', prefix: 'After your approval' },
  send: { verb: 'Send', prefix: 'After your approval' },
  meet: { verb: 'Meet with', prefix: 'After your approval' },
  decide: { verb: 'Decide', prefix: 'Your decision' },
  wait: { verb: 'Wait for', prefix: 'Proposed step' },
} as const;

// Clarification is a request for owner input, not a place to invent a factual
// premise or a choice to bypass a source requirement. The model selects a
// category and its evidence; only the host supplies the question's wording.
const clarifications = {
  outcome: 'What outcome would be most useful now?',
  scope: 'What should the proposed work include or leave out?',
  timing: 'What timing would be useful for this work?',
  cost: 'What cost information or limits should we consider?',
  people: 'Who should the proposed work be for or involve?',
  resources: 'What materials or resources are available for this work?',
  status: 'Do you have an update on the situation described here?',
  constraints: 'What constraints should guide this work?',
  preferences: 'What preferences should guide the proposal?',
  other: 'What else should we know to refine this proposal?',
} as const;

/** The schema helps generation; the renderer independently validates every
 * bound after privacy restoration. Neither establishes semantic correctness. */
export const mailWorkPlanSchema = (evidence: MailWorkEvidence, task: MailWorkPlanTask): Record<string, unknown> => {
  return mailWorkSourcePlanSchema(mailWorkPlanSources(evidence), task);
};

export const mailWorkSourcePlanSchema = (
  sources: ReadonlyMap<string, MailWorkQuoteSource>, task: MailWorkPlanTask,
): Record<string, unknown> => {
  const ids = mailWorkSourcePassages(sources).map(row => row.id);
  // Only opaque handles enter the native schema. Private passage text crosses
  // the normal prompt privacy boundary, never schema descriptions or enums.
  const passage = ids.length ? { type: 'string', enum: ids } : { type: 'string', not: {} };
  const context = { ...arr(passage, 4), description: 'Passage IDs that motivate THIS item. Select the relevant passage including its qualifications, not every source read.' };
  const action = obj({
    operation: { type: 'string', enum: Object.keys(operations), description: 'The operation itself. Draft/outline/compare/analyze/calculate/prepare/report create private work. Ask/send/meet propose contact and always retain owner approval. Decide is an owner choice; wait is a dependency.' },
    target: { type: 'string', minLength: 1, maxLength: 160, pattern: '^[^\\r\\n]+$', description: 'Short noun phrase naming useful work for the current request: a proposed artifact, comparison, recipient/topic, decision or dependency. An artifact can introduce useful structure with unknowns left open; its contents need not already be agreed in a source. No leading operation verb, status recap, prerequisite, promise or approval prefix.' },
    context: { ...context, minItems: 1 },
    source_notes: { ...arr(passage, 4), description: 'Passage IDs containing requirements or qualifications governing THIS operation. A condition on sending is not a condition on drafting. Usually empty; do not invent requirements.' },
  });
  return obj({ task: { type: 'string', enum: [task] }, facts: { ...arr(passage, 12), minItems: 1 },
    actions: arr(action, task === 'investigate' ? 0 : 6),
    questions: arr(obj({ kind: { type: 'string', enum: Object.keys(clarifications),
      description: 'The type of missing owner input for the current proposed work. The host asks a neutral question about this category. Use status for updates to source-reported conditions, not a choice to bypass them. Do not write a topic, question or suggested answer.' }, context: { ...context, minItems: 1 } }),
      task === 'investigate' ? 0 : 6),
  });
};

/** Tools remain available for reading missing evidence. Ordinary follow-ups
 * may use plain Chat, extractions and its existing execution controls. */
export const mailWorkChatOutputSchema = (evidence: MailWorkEvidence, prepared: boolean, editSchema?: Record<string, unknown>): Record<string, unknown> => {
  const plan = !prepared && editSchema ? editSchema : mailWorkPlanSchema(evidence, prepared ? 'propose' : 'refine');
  const call = obj({ tool: str, args: { type: 'object', additionalProperties: true } });
  const events = arr({ type: 'object', additionalProperties: true }, prepared ? 0 : 32);
  const schema = obj({ response: str, events, tool_calls: arr(call, 32),
    mail_work_plan: { anyOf: [plan, { type: 'null' }] } });
  // A prepared turn must advance: read more evidence or return a plan. Null
  // with no tools is not a third valid outcome. Ordinary follow-ups can still
  // change purpose and answer through plain Chat with no work plan.
  return prepared ? { ...schema, anyOf: [
    obj({ response: str, events, tool_calls: arr(call, 0), mail_work_plan: plan }),
    obj({ response: str, events, tool_calls: { ...arr(call, 32), minItems: 1 }, mail_work_plan: { type: 'null' } }),
  ] } : schema;
};

/** Bind prepared Chat's callable vocabulary at the transport boundary, AFTER
 * privacy projection. Native schemas bypass prompt aliasing, so registry names
 * or pre-egress discovery results must never be copied here. This guides
 * generation only; the dispatcher still checks every requested operation. */
export const bindMailWorkChatTools = (schema: unknown, prompt: unknown): unknown => {
  if (!object(schema) || !object(schema.properties) || !schema.properties.mail_work_plan
    || !schema.properties.tool_calls || typeof prompt !== 'string') return schema;
  let packet: unknown;
  try { packet = JSON.parse(prompt); } catch { return schema; }
  if (!object(packet) || !Array.isArray(packet.available_tools)) return schema;
  const names = new Set<string>();
  const add = (row: unknown) => {
    if (object(row) && text(row.recipe_slug, 1024)) names.add(row.recipe_slug);
  };
  packet.available_tools.forEach(add);
  const calls: unknown[] = Array.isArray(packet.prior_tool_calls) ? packet.prior_tool_calls : [];
  for (const call of calls) {
    if (!object(call)) continue;
    // Discovery stays in this top-level lane, not inside source bodies or
    // host evidence observations. Failed calls do not declare new tools.
    if (call.tool_name === 'tools.search' && call.status === 'ok' && object(call.result)
      && Array.isArray(call.result.matches)) call.result.matches.forEach(add);
    // The executor's local slice reader is exposed by trim markers rather
    // than the registry. Preserve recovery without opening a context.* glob.
    const omitted = [call.args, call.result].some(value => object(value)
      && value.llm_gateway_context_omitted === true
      && typeof value.context_ref === 'string' && /^ctx_\d+$/u.test(value.context_ref));
    const sliced = call.tool_name === 'context.slice' && call.status === 'ok' && object(call.result)
      && typeof call.result.ref === 'string' && /^ctx_\d+$/u.test(call.result.ref);
    if (omitted || sliced) names.add('context.slice');
  }
  const tool = names.size ? { type: 'string', enum: [...names] } : { type: 'string', not: {} };
  const bind = (branch: unknown): unknown => {
    if (!object(branch) || !object(branch.properties)) return branch;
    const calls = branch.properties.tool_calls;
    if (!object(calls) || !object(calls.items) || !object(calls.items.properties)) return branch;
    return { ...branch, properties: { ...branch.properties,
      tool_calls: { ...calls, items: { ...calls.items, properties: { ...calls.items.properties, tool } } },
    } };
  };
  const bound = bind(schema);
  return object(bound) && Array.isArray(schema.anyOf)
    ? { ...bound, anyOf: schema.anyOf.map(bind) } : bound;
};

export interface MailWorkPlanItem {
  readonly kind: 'progress' | 'next_action' | 'question';
  readonly basis: 'source' | 'owner' | 'inference';
  readonly text: string;
  readonly source_ids: string[];
}
export interface MailWorkRenderedPlan {
  readonly ok: boolean; readonly text: string; readonly facts: number; readonly items: MailWorkPlanItem[];
  /** Validated declaration, still an untrusted proposal rather than evidence. */
  readonly declaration?: Record<string, unknown>;
}

/** Bind a declaration only to host-known sources and exact excerpts. No
 * invented cross-item IDs, quote repair, source substitution or semantic retry.
 * Missing/invalid plans remain visible failures; previous work is not changed. */
export const renderMailWorkChatPlan = (
  value: unknown, evidence: MailWorkEvidence, task: MailWorkPlanTask = 'propose',
): MailWorkRenderedPlan => {
  return renderMailWorkSourcePlan(value, mailWorkPlanSources(evidence), task);
};

/** Also used by the linked review with its own host-issued source map. Both
 * paths validate the same source and action contract before saving anything. */
export const renderMailWorkSourcePlan = (
  value: unknown, sources: ReadonlyMap<string, MailWorkQuoteSource>, task: MailWorkPlanTask,
): MailWorkRenderedPlan => {
  const unavailable = (): MailWorkRenderedPlan => {
    const links = [...sources.values()].filter(source => source.href).slice(0, 8)
      .map((source, i) => `[Email ${i + 1}](${source.href})`);
    return { ok: false, facts: 0, items: [],
      text: 'I could not assemble a plan with valid source and action references. You can refine the request or investigate again.'
        + (links.length ? `\nSources read: ${links.join(' · ')}` : '') };
  };
  const passages = new Map(mailWorkSourcePassages(sources).map(row => [row.id, row]));
  const quote = (value: unknown) => {
    const row = typeof value === 'string' ? passages.get(value) : undefined;
    if (!row || holdsPiiAliasToken(row.text)) return null;
    const source = sources.get(row.source)!;
    const label = source.href ? `[${source.label}](${source.href})` : source.label;
    return { id: row.id, source: row.source, quote: row.text.replace(/\s+/gu, ' ').trim(),
      rendered: `${label}: “${displayMailWorkSourceText(row.text)}”` };
  };
  const excerpts = (value: unknown, required: boolean) => {
    if (!array(value, 4) || (required && !value.length)) return null;
    const result = [...new Set(value)].map(quote);
    if (result.some(item => !item)) return null;
    return result.filter((item): item is NonNullable<typeof item> => item !== null);
  };
  // Quote a passage once per answer. Subsequent local references retain its
  // source and number; equal text from distinct sources is never conflated.
  const shown = new Map<string, number>();
  const present = (values: NonNullable<ReturnType<typeof excerpts>>) => values.map(item => {
    const existing = shown.get(item.id);
    const number = existing ?? shown.size + 1;
    shown.set(item.id, number);
    const source = sources.get(item.source)!;
    const label = source.href ? `[${source.label}](${source.href})` : source.label;
    return {
      rendered: `Source ${number} — ${existing ? label : item.rendered}`,
      plain: `Source ${number} — ${source.label}${existing ? '' : `: “${item.quote}”`}`,
    };
  });
  try {
    if (!object(value) || !keys(value, ['task', 'facts', 'actions', 'questions']) || value.task !== task
      || holdsPiiAliasToken(value) || !array(value.facts, 12) || !value.facts.length
      || !array(value.actions, task === 'investigate' ? 0 : 6)
      || !array(value.questions, task === 'investigate' ? 0 : 6)) return unavailable();
    const facts = [...new Set(value.facts)].map(quote);
    if (facts.some(fact => !fact)) return unavailable();
    const displayedFacts = present(facts as NonNullable<ReturnType<typeof excerpts>>);
    const items: MailWorkPlanItem[] = facts.map((fact, i) => ({ kind: 'progress',
      basis: sources.get(fact!.source)!.href ? 'source' : 'owner',
      text: displayedFacts[i]!.plain, source_ids: [fact!.source] }));
    const lines = [`Selected source excerpts\n${displayedFacts.map(fact => `• ${fact.rendered}`).join('\n')}`];
    for (const [index, raw] of value.actions.entries()) {
      if (!object(raw) || !keys(raw, ['operation', 'target', 'context', 'source_notes'])
        || typeof raw.operation !== 'string' || !Object.hasOwn(operations, raw.operation)
        || !text(raw.target, 160) || /[\r\n]/.test(raw.target)) return unavailable();
      const context = excerpts(raw.context, true), notes = excerpts(raw.source_notes, false);
      if (!context || !notes) return unavailable();
      const operation = operations[raw.operation as keyof typeof operations];
      const activity = `${operation.prefix}: ${operation.verb} ${raw.target.trim()}`;
      const displayedContext = present(context), displayedNotes = present(notes);
      // The generated target is an inference. Links bind to the exact context
      // below it, never to a free-form factual narrative or a bare source ID.
      lines.push(`${index + 1}. ${displayMailWorkSourceText(activity)}\nSource context:\n${displayedContext.map(item => `• ${item.rendered}`).join('\n')}`
        + (notes.length ? `\nSource notes for this step:\n${displayedNotes.map(note => `• ${note.rendered}`).join('\n')}` : ''));
      items.push({ kind: 'next_action', basis: 'inference',
        source_ids: [...new Set([...context, ...notes].map(item => item.source))],
        text: `${activity}\nSource context:\n${displayedContext.map(item => item.plain).join('\n')}`
          + (notes.length ? `\nSource notes for this step:\n${displayedNotes.map(item => item.plain).join('\n')}` : '') });
    }
    for (const raw of value.questions) {
      if (!object(raw) || !keys(raw, ['kind', 'context']) || typeof raw.kind !== 'string'
        || !Object.hasOwn(clarifications, raw.kind)) return unavailable();
      const context = excerpts(raw.context, true);
      if (!context) return unavailable();
      const question = clarifications[raw.kind as keyof typeof clarifications];
      const displayedContext = present(context);
      lines.push(`Open question: ${displayMailWorkSourceText(question)}`
        + (context.length ? `\nSource context:\n${displayedContext.map(item => `• ${item.rendered}`).join('\n')}` : ''));
      items.push({ kind: 'question', basis: 'inference', source_ids: [...new Set(context.map(item => item.source))],
        text: question + (context.length ? `\nSource context:\n${displayedContext.map(item => item.plain).join('\n')}` : '') });
    }
    return { ok: true, text: lines.join('\n\n'), facts: facts.length, items, declaration: structuredClone(value) };
  } catch { return unavailable(); }
};
