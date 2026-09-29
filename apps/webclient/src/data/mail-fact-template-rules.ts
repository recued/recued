/**
 * D-315 §6.1 — making a template's rules from the owner's clicks.
 *
 * The editor shows an email with its values clickable. A value is either the
 * text after a label on its line (`Tracking Number: 1Z…`), which becomes an
 * `after_label` rule, or a value-shaped token inside a line (a long number, a
 * code, an amount, a date), which becomes a `pattern` rule anchored on the
 * words before it. The subject and the sender can be taken whole. An enum
 * variable (a state, a notice) is read from words: the owner says what the
 * clicked words mean, and the rule is a `keyword_map`.
 *
 * Pure: the editor renders these and the rules pass runs what they produce.
 */

import {
  mailFactTypeVariables,
  type MailFactTypeSpec,
  type MailFactVariableKind,
  type MailFactVariableSpec,
  type MailTemplateCondition,
  type MailTemplateRule,
  type MailTemplateSource,
} from '@recued/contracts';

/** One piece of a line as the editor shows it. */
export type ValueSpan =
  | { readonly kind: 'text'; readonly text: string }
  /** Clickable. `label` when it is the text after a label; `context` (the
   *  words before it on its line) when it is a token inside the line. */
  | { readonly kind: 'value'; readonly text: string; readonly label?: string; readonly context?: string };

const LABEL_LINE = /^(\s*)([^:#\n]{1,60}?[:#])(\s*)(\S.*?)\s*$/;
/** Tokens worth offering inside a line: amounts, dates, long numbers, codes. */
const TOKEN = /(?:[$€£¥]\s?\d[\d.,]*\d|\d[\d.,]*\d\s?(?:[$€£¥]|[A-Z]{3})\b|\d{1,4}[./-]\d{1,2}[./-]\d{1,4}|\b(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,}\b|\b\d{4,}\b)/g;

/** The words right before a token, as its anchor — only those since the
 *  value before it: an anchor holding another value breaks when that value
 *  changes in the next email. */
const contextBefore = (segment: string): string =>
  segment
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trimEnd()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(-3)
    .join(' ');

const tokenSpans = (line: string): ValueSpan[] => {
  const spans: ValueSpan[] = [];
  let at = 0;
  for (const match of line.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    const context = contextBefore(line.slice(at, index));
    if (context.length === 0) continue;
    if (index > at) spans.push({ kind: 'text', text: line.slice(at, index) });
    spans.push({ kind: 'value', text: match[0], context });
    at = index + match[0].length;
  }
  if (at < line.length) spans.push({ kind: 'text', text: line.slice(at) });
  return spans;
};

/** The spans of one line: a label's value, or its tokens. */
export const lineSpans = (line: string): ValueSpan[] => {
  const labelled = LABEL_LINE.exec(line);
  if (labelled !== null) {
    const [, lead = '', label = '', gap = '', value = ''] = labelled;
    const cleanLabel = label.trim();
    // A time (`10:30`) or a link is not a label.
    if (!/^\d{1,2}[:]$/.test(cleanLabel) && !/^https?:$/i.test(cleanLabel)) {
      return [
        { kind: 'text', text: `${lead}${label}${gap}` },
        { kind: 'value', text: value, label: cleanLabel },
      ];
    }
  }
  return tokenSpans(line);
};

/** Every line's spans, capped: a template is taught on the part of an email
 *  that carries its values, not on a newsletter's thousandth line. */
export const textSpans = (text: string, maxLines = 400): ValueSpan[][] =>
  text.replace(/\r\n?/g, '\n').split('\n').slice(0, maxLines).map(lineSpans);

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A value's shape as a pattern: runs of digits, of letters, of spaces, and
 *  the punctuation between them as it is — `1Z 999` → `\d[A-Za-z]\s+\d+`. */
export const shapeOf = (value: string): string => {
  let out = '';
  for (const run of value.match(/\d+|[A-Za-z]+|\s+|[^\dA-Za-z\s]/g) ?? []) {
    if (/^\d+$/.test(run)) out += run.length === 1 ? '\\d' : '\\d+';
    else if (/^[A-Za-z]+$/.test(run)) out += run.length === 1 ? '[A-Za-z]' : '[A-Za-z]+';
    else if (/^\s+$/.test(run)) out += '\\s+';
    else out += escapeRegex(run);
  }
  return out;
};

/** What the owner clicked. */
export interface ValuePick {
  readonly source: MailTemplateSource;
  readonly text: string;
  readonly label?: string;
  readonly context?: string;
}

/** Where a picked value goes. */
export type PickTarget =
  | { readonly variable: string; readonly means?: string }
  | { readonly data: string; readonly normalize?: MailFactVariableKind };

const targetOf = (target: PickTarget): MailTemplateRule['target'] =>
  'variable' in target ? { variable: target.variable } : { data: target.data };

/** The rule a pick makes. An enum variable reads WORDS: the clicked text is
 *  what the email says, and `means` which of its values that is — it joins the
 *  variable's keyword map on that source when there is one. */
export const ruleFromPick = (
  pick: ValuePick,
  target: PickTarget,
  rules: readonly MailTemplateRule[],
): MailTemplateRule[] => {
  if ('variable' in target && target.means !== undefined) {
    const words = pick.text.trim();
    const existing = rules.findIndex((rule) =>
      'variable' in rule.target
      && rule.target.variable === target.variable
      && rule.source === pick.source
      && rule.find.kind === 'keyword_map');
    if (existing >= 0) {
      const rule = rules[existing]!;
      if (rule.find.kind !== 'keyword_map') return [...rules];
      const cases = [...rule.find.cases.filter((c) => c.contains.toLowerCase() !== words.toLowerCase()),
        { contains: words, value: target.means }];
      return rules.map((candidate, i) => (i === existing ? { ...rule, find: { kind: 'keyword_map', cases } } : candidate));
    }
    return [...rules, {
      target: { variable: target.variable },
      source: pick.source,
      find: { kind: 'keyword_map', cases: [{ contains: words, value: target.means }] },
    }];
  }
  // One rule per target: a new pick replaces how that value was read.
  const others = rules.filter((rule) => !sameTarget(rule.target, targetOf(target)));
  const normalize = 'data' in target && target.normalize !== undefined ? { normalize: target.normalize } : {};
  if (pick.label !== undefined) {
    return [...others, { target: targetOf(target), source: pick.source, find: { kind: 'after_label', label: pick.label }, ...normalize }];
  }
  if (pick.context !== undefined) {
    return [...others, {
      target: targetOf(target),
      source: pick.source,
      find: { kind: 'pattern', pattern: `${escapeRegex(pick.context)}\\s*(${shapeOf(pick.text)})` },
      ...normalize,
    }];
  }
  return [...others, { target: targetOf(target), source: pick.source, find: { kind: 'whole' }, ...normalize }];
};

export const sameTarget = (a: MailTemplateRule['target'], b: MailTemplateRule['target']): boolean =>
  ('variable' in a && 'variable' in b && a.variable === b.variable) || ('data' in a && 'data' in b && a.data === b.data);

const SOURCE_WORDS: Readonly<Record<MailTemplateSource, string>> = {
  subject: 'the subject',
  body: 'the text',
  html: 'the HTML',
  from_address: "the sender's address",
  from_name: "the sender's name",
  header: 'a header',
  attachment: 'the attachments',
};

export const humanizeName = (value: string): string => {
  const spaced = value.replace(/[_.]/g, ' ').trim();
  return spaced.length === 0 ? value : spaced[0]!.toUpperCase() + spaced.slice(1);
};

/** A rule in the owner's words. */
export const describeRule = (rule: MailTemplateRule): { readonly target: string; readonly how: string } => {
  const target = 'variable' in rule.target ? humanizeName(rule.target.variable) : `Data: ${rule.target.data}`;
  const where = rule.source === 'header' && rule.header !== undefined ? `the ${rule.header} header` : SOURCE_WORDS[rule.source];
  const find = rule.find;
  switch (find.kind) {
    case 'after_label':
      return { target, how: `the text after “${find.label}” in ${where}` };
    case 'pattern':
      return { target, how: `the match of /${find.pattern}/ in ${where}` };
    case 'whole':
      return { target, how: `all of ${where}` };
    case 'constant':
      return { target, how: `always “${humanizeName(find.value)}”` };
    case 'keyword_map':
      return {
        target,
        how: find.cases.map((c) => `“${c.contains}” means ${humanizeName(c.value)}`).join('; ') + ` (in ${where})`,
      };
    case 'attachment':
      return { target, how: find.by === 'type' ? `the attached ${find.match} file` : `the attachment named like “${find.match}”` };
  }
};

/** The variables a template must read for a fact to exist, by default: the
 *  type's required ones that a rule reads from the email (a constant is not
 *  read from the email, so it cannot satisfy an entrance variable). */
export const defaultEntranceVariables = (spec: MailFactTypeSpec, rules: readonly MailTemplateRule[]): string[] => {
  const read = new Set(rules
    .filter((rule) => rule.find.kind !== 'constant' && 'variable' in rule.target)
    .map((rule) => ('variable' in rule.target ? rule.target.variable : '')));
  return spec.variables.filter((variable) => variable.required && read.has(variable.name)).map((variable) => variable.name);
};

/** The conditions suggested for an email: its sender's address. */
export const suggestConditions = (fromAddress: string): MailTemplateCondition[] =>
  fromAddress.includes('@') ? [{ field: 'from', op: 'is', value: fromAddress.trim().toLowerCase() }] : [];

/** Every variable of a type the editor offers, `state` and `notice` included. */
export const editorVariables = (spec: MailFactTypeSpec): readonly MailFactVariableSpec[] => mailFactTypeVariables(spec);
