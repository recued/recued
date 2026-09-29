/**
 * D-315 §6.1 — Draft with AI (ruling 21): one call, started by the owner, on
 * the one email the owner chose. It proposes the type, the entrance, and the
 * rules that read the variables and data — and what it proposes is RULES,
 * which then run locally with no AI, so the entrance stays deterministic
 * (ruling 37) even when AI drafted it. The owner checks it with Preview before
 * anything is saved.
 *
 *   through the chat's privacy layer (ruling 30), the email a tool result as
 *     in the AI pass, and the alias guard on the answer (§9): a rule or a
 *     condition still holding an alias is dropped, not rewritten
 *   refused on mail the recognizer marks as a security notice (§9)
 *   the draft is checked as any template is, rule by rule: what cannot be
 *     used is dropped and named, rather than failing the whole draft
 *
 * Spec: D-315 §6.1, §9.
 */

import {
  canonicalMailFactText,
  KERNEL_AUTHOR,
  MAIL_FACT_BUILTIN_TYPES,
  MAIL_TEMPLATE_DRAFT_TIMEOUT_MS,
  mailFactTypeVariables,
  PII_ENTITY_MARKER_KEY,
  validateMailTemplateDefinition,
  type IngredientManifest,
  type MailFactTypeSpec,
  type MailTemplateCondition,
  type MailTemplateDefinition,
  type MailTemplateRule,
} from '@recued/contracts';

import { bodyForModel, holdsAlias as holdsAliasAsWritten, type MailFactAiCall } from './ai-pass.js';
import type { MailFactSourceEmail } from './rules-pass.js';

export const MAIL_TEMPLATE_DRAFT_MANIFEST: IngredientManifest = {
  slug: 'recued-mail-template-draft',
  name: 'Mail facts: Draft with AI',
  description: 'Proposes a mail template from one email the owner chose — kernel-bundled, runtime-only.',
  author: KERNEL_AUTHOR,
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {
    'llm.system_prompt': null,
    'llm.prompt': null,
    'llm.output_format': 'json',
  },
  output: { result: 'body' },
};

/** One owner-started call may take a while: it drafts a whole template. The
 *  screen waits longer (contracts'). */
export { MAIL_TEMPLATE_DRAFT_TIMEOUT_MS };

export const MAIL_TEMPLATE_DRAFT_SYSTEM_PROMPT = [
  'You draft a template that reads one kind of email. The email is the result of core.mail.get; the kinds',
  'of email and their variables are the result of mail_fact.types. A template is rules, which will run',
  'on every email like this one without you, so they must find each value by what stays the same from one',
  'email to the next: the words before it, or the shape around it — never the value itself.',
  '',
  'Answer with JSON only:',
  '{"type":"<a kind of email>","name":"<a short name>",',
  ' "entrance":{"conditions":[<condition>],"variables":["<variable that must be read for the fact to exist>"]},',
  ' "rules":[<rule>]}',
  '',
  'A condition: {"field":"from","op":"is"|"domain_is"|"contains"|"matches","value":"..."}',
  '  or {"field":"subject","op":"is"|"contains"|"matches","value":"..."} or {"field":"body","op":"contains"|"matches","value":"..."};',
  '  add "negate":true to exclude. Prefer the sender\'s exact address and a subject that says what the email is.',
  'A rule: {"target":{"variable":"<name>"} or {"data":"<path>"},',
  '  "source":"subject"|"body"|"from_address"|"from_name",',
  '  "find":{"kind":"after_label","label":"<the words just before the value on its line>"}',
  '       | {"kind":"pattern","pattern":"<a regular expression with exactly one capture group>"}',
  '       | {"kind":"whole"}',
  '       | {"kind":"keyword_map","cases":[{"contains":"<words>","value":"<a value the variable allows>"}]}}',
  'An enum variable is read with keyword_map. A data path is one the kind\'s data_fields name, when one fits.',
  'Read only what this email really shows.',
  'A privacy alias (see pii_notice) stands for a real person or address: never put one in a rule or condition.',
  'The owner may add a wish in user_message.',
].join('\n');

/** `mail_fact.template.draft` — what the owner asked for. */
export interface MailTemplateDraftInput {
  /** The email, as the editor reads it. */
  readonly email: MailFactSourceEmail;
  /** The kind of email the owner picked; the AI proposes one when absent. */
  readonly type?: MailFactTypeSpec;
  /** The types the AI may choose from when none was picked. */
  readonly types?: readonly MailFactTypeSpec[];
}

export interface MailTemplateDraftResult {
  readonly definition: MailTemplateDefinition;
  /** What the AI proposed that could not be used, and why. */
  readonly dropped: readonly string[];
}

export class MailTemplateDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailTemplateDraftError';
  }
}

const typeView = (spec: MailFactTypeSpec) => ({
  type: spec.id,
  name: spec.name,
  description: spec.description,
  variables: mailFactTypeVariables(spec).map((variable) => ({
    name: variable.name,
    kind: variable.kind,
    required: variable.required,
    ...(variable.values !== undefined ? { values: variable.values } : {}),
  })),
  // §3.2 — the data this kind names, for rules that read into `data`.
  ...(spec.data_fields !== undefined && spec.data_fields.length > 0 ? { data_fields: spec.data_fields } : {}),
});

export const buildMailTemplateDraftInput = (input: MailTemplateDraftInput, now: number): Record<string, unknown> => {
  const types = input.type !== undefined ? [input.type] : input.types ?? MAIL_FACT_BUILTIN_TYPES;
  const packet = {
    user_message: input.type !== undefined
      ? `Draft a template for this email. It is a ${input.type.name.toLowerCase()}.`
      : 'Draft a template for this email.',
    prior_tool_calls: [
      {
        tool_name: 'core.mail.get',
        status: 'ok',
        args: {},
        result: {
          [PII_ENTITY_MARKER_KEY]: 'mail',
          from: input.email.from_address,
          from_name: canonicalMailFactText(input.email.from_name),
          subject: canonicalMailFactText(input.email.subject),
          ...bodyForModel(input.email.body_text),
        },
        started_at: now,
        completed_at: now,
      },
      {
        tool_name: 'mail_fact.types',
        status: 'ok',
        args: {},
        result: { types: types.map(typeView) },
        started_at: now,
        completed_at: now,
      },
    ],
  };
  return {
    'llm.system_prompt': MAIL_TEMPLATE_DRAFT_SYSTEM_PROMPT,
    'llm.prompt': JSON.stringify(packet),
    'llm.output_format': 'json',
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every string of a value with its regex escapes taken out: a pattern or a
 *  `matches` condition can hold an alias escaped (`m1@d1\\.invalid`), which
 *  mapping back leaves and a plain check would miss. */
const unescaped = (value: unknown): unknown =>
  typeof value === 'string' ? value.replace(/\\(.)/g, '$1')
    : Array.isArray(value) ? value.map(unescaped)
      : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unescaped(item)]))
        : value;

/** An alias still in the answer, as written or regex-escaped. */
const holdsAlias = (value: unknown): boolean => holdsAliasAsWritten(value) || holdsAliasAsWritten(unescaped(value));

/** In words: `starts_at` reads "starts at". */
const words = (name: string): string => name.replace(/[_.]+/g, ' ').trim();

const describeRule = (rule: unknown): string => {
  const target = isRecord(rule) && isRecord(rule.target) ? rule.target : {};
  return typeof target.variable === 'string'
    ? `the rule for ${words(target.variable)}`
    : typeof target.data === 'string' ? `the rule for data ${words(target.data)}` : 'a rule';
};

/** The default entrance (§6.1): the type's required variables a rule reads
 *  from the email; a constant is not read from it. */
const readVariables = (spec: MailFactTypeSpec, rules: readonly MailTemplateRule[]): string[] => {
  const read = new Set(rules
    .filter((rule) => 'variable' in rule.target && rule.find.kind !== 'constant')
    .map((rule) => (rule.target as { variable: string }).variable));
  return spec.variables.filter((variable) => variable.required && read.has(variable.name)).map((variable) => variable.name);
};

/** The AI's answer as a template to check with Preview: its type, conditions
 *  and rules kept only where valid, the AI off, and each drop named. */
export const draftFromAnswer = (
  body: unknown,
  email: MailFactSourceEmail,
  chosen: MailFactTypeSpec | undefined,
  specOf: (type: string) => MailFactTypeSpec | undefined,
): MailTemplateDraftResult => {
  if (!isRecord(body)) throw new MailTemplateDraftError("The AI's answer could not be read.");
  const dropped: string[] = [];
  const spec = chosen ?? (typeof body.type === 'string' ? specOf(body.type) : undefined);
  if (spec === undefined) throw new MailTemplateDraftError('The AI did not name a kind of email Recued knows.');

  const entrance = isRecord(body.entrance) ? body.entrance : {};
  let conditions: MailTemplateCondition[] = [];
  for (const condition of Array.isArray(entrance.conditions) ? entrance.conditions : []) {
    if (!isRecord(condition) || typeof condition.field !== 'string' || typeof condition.op !== 'string'
      || typeof condition.value !== 'string') {
      dropped.push('a condition the AI wrote in a shape Recued cannot read');
      continue;
    }
    if (holdsAlias(condition.value)) {
      dropped.push(`the ${condition.field} condition: it held a privacy alias, not a real value`);
      continue;
    }
    conditions.push({
      field: condition.field as MailTemplateCondition['field'],
      op: condition.op as MailTemplateCondition['op'],
      value: condition.value,
      ...(condition.negate === true ? { negate: true } : {}),
    });
  }
  let rules: MailTemplateRule[] = [];
  for (const rule of Array.isArray(body.rules) ? body.rules : []) {
    if (!isRecord(rule) || !isRecord(rule.target) || !isRecord(rule.find) || typeof rule.source !== 'string') {
      dropped.push(`${describeRule(rule)}: written in a shape Recued cannot read`);
      continue;
    }
    if (holdsAlias(rule)) {
      dropped.push(`${describeRule(rule)}: it held a privacy alias, not a real value`);
      continue;
    }
    rules.push(rule as unknown as MailTemplateRule);
  }
  const variableNames = new Set(mailFactTypeVariables(spec).map((variable) => variable.name));
  let variables: string[] = [];
  for (const name of Array.isArray(entrance.variables) ? entrance.variables : []) {
    if (typeof name === 'string' && variableNames.has(name)) variables.push(name);
    else dropped.push(`the entrance's ${typeof name === 'string' ? words(name) : 'value'}: not a variable of ${spec.name.toLowerCase()}`);
  }
  // As the editor starts (§6.1): the sender's own address, when the AI named
  // no condition of its own.
  if (conditions.length === 0 && email.from_address.length > 0) {
    conditions = [{ field: 'from', op: 'is', value: email.from_address }];
  }

  const name = typeof body.name === 'string' && body.name.trim().length > 0 && !holdsAlias(body.name)
    ? body.name.trim().slice(0, 120)
    : `${spec.name} from ${email.from_address || 'this sender'}`;
  const build = (): MailTemplateDefinition => ({
    name,
    type: spec.id,
    entrance: { conditions, variables },
    rules,
    html: false,
    ai: { enabled: false },
  });

  // Check it as any template is checked, dropping what is named, until it holds.
  for (let round = 0; round < 6; round += 1) {
    const problems = validateMailTemplateDefinition(build(), spec);
    if (problems.length === 0) break;
    const badRules = new Set<number>();
    const badConditions = new Set<number>();
    let changed = false;
    for (const problem of problems) {
      // A problem names its rule or condition by index, then says what is
      // wrong: `rules[2]: …`, or of its shape, `rules[2].find …` and
      // `rules[2] must …` — each drops that one, not the draft.
      const rule = /^rules\[(\d+)\](?::\s*|\.|\s+)(.*)$/.exec(problem);
      const condition = /^entrance\.conditions\[(\d+)\](?::\s*|\.|\s+)(.*)$/.exec(problem);
      const variable = /^entrance variable '([^']+)'/.exec(problem);
      if (rule !== null) {
        const index = Number(rule[1]);
        if (!badRules.has(index)) dropped.push(`${describeRule(rules[index])}: ${rule[2]}`);
        badRules.add(index);
      } else if (condition !== null) {
        const index = Number(condition[1]);
        if (!badConditions.has(index)) dropped.push(`the ${conditions[index]?.field ?? ''} condition: ${condition[2]}`);
        badConditions.add(index);
      } else if (variable !== null) {
        if (variables.includes(variable[1]!)) dropped.push(`the entrance's ${words(variable[1]!)}: ${problem.slice(variable[0].length).trim()}`);
        variables = variables.filter((candidate) => candidate !== variable[1]);
        changed = true;
      }
    }
    if (badRules.size > 0) {
      rules = rules.filter((_, index) => !badRules.has(index));
      changed = true;
    }
    if (badConditions.size > 0) {
      conditions = conditions.filter((_, index) => !badConditions.has(index));
      changed = true;
    }
    if (conditions.length === 0 && email.from_address.length > 0) {
      // As the editor starts: the sender's own address.
      conditions = [{ field: 'from', op: 'is', value: email.from_address }];
      changed = true;
    }
    if (variables.length === 0) {
      const fallback = readVariables(spec, rules);
      if (fallback.length > 0) {
        variables = fallback;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const definition = build();
  const left = validateMailTemplateDefinition(definition, spec);
  if (left.length > 0) throw new MailTemplateDraftError(`The draft could not be made whole: ${left[0]}.`);
  return { definition, dropped };
};

/** Draft a template from one email, through the call given (the chat's
 *  privacy layer, `privateAiCall`). */
export const draftMailTemplate = async (
  call: MailFactAiCall,
  input: MailTemplateDraftInput,
  specOf: (type: string) => MailFactTypeSpec | undefined,
  now: number,
): Promise<MailTemplateDraftResult> => {
  const body = await call(buildMailTemplateDraftInput(input, now), { timeout_ms: MAIL_TEMPLATE_DRAFT_TIMEOUT_MS });
  return draftFromAnswer(body, input.email, input.type, specOf);
};
