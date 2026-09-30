/**
 * D-315 — the rules pass (§4, §4.1, §4.2): one template read over one email.
 *
 *   conditions → entrance variables → the other rules → facts
 *
 * The template's conditions must all hold, or nothing is read. Then its rules
 * read variables and data; a fact exists only when every entrance variable was
 * read FROM THE EMAIL (a constant the template sets does not count). A repeated
 * block yields one fact per block that meets the entrance.
 *
 * Pure: it takes a plain email shape (not the mail collection's message type)
 * and returns what it read. Identity, merging and events are the fact writer's.
 *
 * Every value is refused, never coerced, when it is not what its kind says; a
 * full card number is refused anywhere in the fact, data included; data over
 * 64 KB is dropped with the reason (§9).
 *
 * Spec: D-315 §4, §4.1, §4.2, §9.
 */

import {
  canonicalMailFactPattern,
  canonicalMailFactText,
  isMailFactDataPath,
  MAIL_TEMPLATE_LIMITS,
  mailFactTypeVariables,
  type MailFactPass,
  type MailFactRefusal,
  type MailFactTypeSpec,
  type MailFactValue,
  type MailFactVariableSpec,
  type MailTemplateCondition,
  type MailTemplateDefinition,
  type MailTemplateRule,
} from '@recued/contracts';

import { containsCardNumber, containsIban, normalizeValue } from './normalize.js';
import { runTemplatePattern, TemplatePatternTimeout } from './template-pattern.js';

/** A fact's data is capped (ruling 16): every event carries it. */
export const MAIL_FACT_DATA_MAX_BYTES = 64 * 1024;

export interface MailFactSourceAttachment {
  readonly file_id: string;
  readonly filename: string;
  readonly mime_type: string;
}

/** The email as the rules pass reads it. */
export interface MailFactSourceEmail {
  readonly subject: string;
  readonly body_text: string;
  /** The in-memory HTML at ingest, or a refetched copy; `null` when absent. */
  readonly html: string | null;
  /** Lower case. */
  readonly from_address: string;
  readonly from_name: string;
  /** Header names in lower case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly labels: readonly string[];
  /** The sender's relationships from the contact graph (`family`, `work`,
   *  `social`, `other`), none when the sender is not a known contact. A
   *  contact can hold several: a colleague who became a friend is both. */
  readonly relationships: readonly string[];
  readonly attachments: readonly MailFactSourceAttachment[];
}

export interface RulesPassFact {
  readonly position: number;
  /** Every variable of the type, `null` when unread. */
  readonly variables: Readonly<Record<string, MailFactValue | null>>;
  readonly passes: Readonly<Record<string, MailFactPass>>;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly refused: readonly MailFactRefusal[];
  /** Required variables left unread. */
  readonly missing: readonly string[];
  readonly complete: boolean;
}

/** Each outcome may carry warnings for the template's health: a pattern that
 *  ran too long and was stopped (§6.2). */
export type RulesPassOutcome =
  /** A condition did not hold: this is not the template's kind of email. */
  | { readonly kind: 'no_match'; readonly warnings?: readonly string[] }
  /** The conditions held but no fact met the entrance. Health counts it. */
  | { readonly kind: 'not_entered'; readonly unread: readonly string[]; readonly warnings?: readonly string[] }
  | { readonly kind: 'facts'; readonly facts: readonly RulesPassFact[]; readonly warnings?: readonly string[] };

// ────────────────────────────────────────────────────────────────
// The email as a template reads it (§9)
// ────────────────────────────────────────────────────────────────

/** Characters of each text a template reads. Canonical text grows where it
 *  holds compatibility characters — U+FDFA is eighteen — so a sender could
 *  make an email's text grow eighteenfold as it is read: each is read from at
 *  most this many, and cut to it — far past any email's text. */
export const RULES_TEXT_MAX_CHARS = 1_000_000;

const canonicalEmails = new WeakMap<MailFactSourceEmail, MailFactSourceEmail>();

/** The email with each of its texts canonical (`canonicalMailFactText`), as
 *  a template's conditions, labels, keywords and patterns read it: an email
 *  written in fullwidth letters, or with a zero-width space inside a word, is
 *  the email written plainly. Its HTML too — read here as text, never parsed.
 *  Once per email, however many templates read it. */
const canonicalEmail = (email: MailFactSourceEmail): MailFactSourceEmail => {
  const known = canonicalEmails.get(email);
  if (known !== undefined) return known;
  const read = (text: string): string => canonicalMailFactText(text.slice(0, RULES_TEXT_MAX_CHARS)).slice(0, RULES_TEXT_MAX_CHARS);
  const canonical: MailFactSourceEmail = {
    ...email,
    subject: read(email.subject),
    body_text: read(email.body_text),
    html: email.html === null ? null : read(email.html),
    from_address: read(email.from_address),
    from_name: read(email.from_name),
    headers: Object.fromEntries(Object.entries(email.headers).map(([name, value]) => [name, read(value)])),
    attachments: email.attachments.map((attachment) => ({ ...attachment, filename: read(attachment.filename) })),
  };
  canonicalEmails.set(email, canonical);
  return canonical;
};

// ────────────────────────────────────────────────────────────────
// Conditions (§4.1)
// ────────────────────────────────────────────────────────────────

const lower = (text: string): string => text.toLowerCase();

/** A label or a relationship as a template reads it — canonical, without case
 *  — the email's, and the one a condition names, alike (§4.1, §9). The writer
 *  reads them so too, to tell whether one a template tests came or went. */
export const labelAsRead = (label: string): string => lower(canonicalMailFactText(label));

const domainOf = (address: string): string => {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : '';
};

const conditionHolds = (
  condition: MailTemplateCondition,
  email: MailFactSourceEmail,
  readsHtml: boolean,
): boolean => {
  // A value read as the email is; a pattern is read so where it runs.
  const pattern = condition.value;
  const wanted = canonicalMailFactText(condition.value);
  // Nothing — spaces, or characters that show nothing — is in every email; the
  // check refuses it, and one a stored template carries unchecked holds for none.
  if (condition.op === 'contains' && wanted.trim().length === 0) return condition.negate === true;
  let holds: boolean;
  switch (condition.field) {
    case 'from': {
      const address = lower(email.from_address);
      if (condition.op === 'is') holds = address === lower(wanted);
      else if (condition.op === 'domain_is') {
        const domain = domainOf(address);
        const target = lower(wanted).replace(/^@/, '');
        holds = domain === target || domain.endsWith(`.${target}`);
      } else if (condition.op === 'contains') {
        holds = address.includes(lower(wanted)) || lower(email.from_name).includes(lower(wanted));
      } else holds = runTemplatePattern(pattern, 'i', `${email.from_name} <${email.from_address}>`) !== null;
      break;
    }
    case 'subject':
      if (condition.op === 'is') holds = lower(email.subject.trim()) === lower(wanted.trim());
      else if (condition.op === 'contains') holds = lower(email.subject).includes(lower(wanted));
      else holds = runTemplatePattern(pattern, 'i', email.subject) !== null;
      break;
    case 'body': {
      // The content is the body text, and the HTML too when the template asks
      // for it (§4.1): a sender whose text part is a stub still matches.
      const texts = readsHtml && email.html !== null ? [email.body_text, email.html] : [email.body_text];
      holds = texts.some((text) =>
        condition.op === 'contains'
          ? lower(text).includes(lower(wanted))
          : runTemplatePattern(pattern, 'i', text) !== null,
      );
      break;
    }
    case 'label':
      holds = email.labels.some((label) => labelAsRead(label) === labelAsRead(condition.value));
      break;
    case 'relationship':
      holds = email.relationships.some((relationship) => labelAsRead(relationship) === labelAsRead(condition.value));
      break;
    case 'attachment':
      holds = email.attachments.some((attachment) =>
        condition.op === 'type_is'
          ? mimeMatches(attachment.mime_type, wanted)
          : runTemplatePattern(pattern, 'i', attachment.filename) !== null,
      );
      break;
    default:
      holds = false;
  }
  return condition.negate === true ? !holds : holds;
};

/** A condition as `conditionHolds` reads it: its field, op, value and whether
 *  it is negated, the value read exactly as it is compared. Two conditions
 *  with one reading hold for the same emails. */
export const conditionAsRead = (condition: MailTemplateCondition): string => {
  const wanted = canonicalMailFactText(condition.value);
  let value: string;
  if (condition.op === 'matches' || condition.op === 'name_matches') value = canonicalMailFactPattern(condition.value);
  else if (condition.field === 'label' || condition.field === 'relationship') value = labelAsRead(condition.value);
  else if (condition.op === 'domain_is') value = lower(wanted).replace(/^@/, '');
  else if (condition.field === 'subject' && condition.op === 'is') value = lower(wanted.trim());
  else value = lower(wanted);
  return JSON.stringify([condition.field, condition.op, value, condition.negate === true]);
};

/** A set of conditions as one comparable key (ruling 31): each read as it
 *  is compared, in no order, each once. */
export const conditionSetAsRead = (conditions: readonly MailTemplateCondition[]): string =>
  [...new Set(conditions.map(conditionAsRead))].sort().join('\n');

/** `application/pdf` matches exactly; `image/` matches any image. */
const mimeMatches = (mime: string, wanted: string): boolean => {
  const m = lower(mime);
  const w = lower(wanted);
  return w.endsWith('/') ? m.startsWith(w) : m === w;
};

// ────────────────────────────────────────────────────────────────
// Finders (§4.2)
// ────────────────────────────────────────────────────────────────

/** A rule's source text, or `null` when it has none on this email. */
const sourceText = (
  rule: MailTemplateRule,
  email: MailFactSourceEmail,
  template: MailTemplateDefinition,
  block: { readonly source: 'body' | 'html'; readonly text: string } | undefined,
): string | null => {
  if (block !== undefined && rule.source === block.source) return block.text;
  switch (rule.source) {
    case 'subject':
      return email.subject;
    case 'body':
      return email.body_text;
    case 'html':
      return template.html ? email.html : null;
    case 'from_address':
      return email.from_address;
    case 'from_name':
      return email.from_name;
    case 'header':
      return rule.header === undefined ? null : email.headers[rule.header.toLowerCase()] ?? null;
    case 'attachment':
      return null;
  }
};

/** The text after `label`, to the end of its line; the next non-empty line
 *  when the label ends its line (`Tracking number:\n1Z…`). */
const afterLabel = (text: string, label: string): string | null => {
  // A label of nothing is found nowhere, not at the start of every line.
  const written = canonicalMailFactText(label).trim();
  if (written.length === 0) return null;
  const lines = text.split(/\r?\n/);
  // Found in the line as written, without case: an index into a lower-cased
  // copy is off wherever lower-casing changes a length (`İ` becomes two).
  const needle = new RegExp(written.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const found = needle.exec(line);
    if (found === null) continue;
    // What separates the label from its value goes — spaces, a colon, a dash
    // — but not a minus sign: `Lot: -125` is -125.
    const rest = line.slice(found.index + found[0].length).replace(/^(?:[\s:–—]|-(?!\d))+/u, '').trim();
    if (rest.length > 0) return rest;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]!.trim();
      if (next.length > 0) return next;
    }
    return null;
  }
  return null;
};

type Found =
  | { readonly kind: 'text'; readonly text: string; readonly fromEmail: boolean }
  | { readonly kind: 'file'; readonly fileId: string }
  | null;

const find = (
  rule: MailTemplateRule,
  email: MailFactSourceEmail,
  template: MailTemplateDefinition,
  block: { readonly source: 'body' | 'html'; readonly text: string } | undefined,
): Found => {
  const finder = rule.find;
  if (finder.kind === 'constant') return { kind: 'text', text: finder.value, fromEmail: false };
  if (finder.kind === 'attachment') {
    const picked = email.attachments.find((attachment) =>
      finder.by === 'type'
        ? mimeMatches(attachment.mime_type, finder.match)
        : lower(attachment.filename).includes(lower(canonicalMailFactText(finder.match))),
    );
    return picked === undefined ? null : { kind: 'file', fileId: picked.file_id };
  }
  const text = sourceText(rule, email, template, block);
  if (text === null || text.length === 0) return null;
  switch (finder.kind) {
    case 'whole':
      return { kind: 'text', text: text.trim(), fromEmail: true };
    case 'after_label': {
      const found = afterLabel(text, finder.label);
      return found === null ? null : { kind: 'text', text: found, fromEmail: true };
    }
    case 'pattern': {
      const match = runTemplatePattern(finder.pattern, finder.flags ?? '', text);
      const group = match?.[1];
      return group === undefined || group.trim().length === 0
        ? null
        : { kind: 'text', text: group.trim(), fromEmail: true };
    }
    case 'keyword_map': {
      const haystack = lower(text);
      const hit = finder.cases.find((c) => {
        // A case of nothing is found nowhere, not in every email.
        const wanted = lower(canonicalMailFactText(c.contains));
        return wanted.trim().length > 0 && haystack.includes(wanted);
      });
      return hit === undefined ? null : { kind: 'text', text: hit.value, fromEmail: true };
    }
  }
};

// ────────────────────────────────────────────────────────────────
// One fact
// ────────────────────────────────────────────────────────────────

/** Set a value at a dot path of a fact's data, making the objects on the way. */
export const setPath = (target: Record<string, unknown>, path: string, value: unknown): void => {
  // Never through what an object inherits: a `__proto__` part would write an
  // email's text onto every object in the server (the check refuses such a
  // path too, but a stored or imported template reaches here unchecked).
  if (!isMailFactDataPath(path)) return;
  const segments = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i]!;
    const next = Object.prototype.hasOwnProperty.call(cursor, key) ? cursor[key] : undefined;
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
};

/** Replace every data value holding a full card number or an IBAN with `null`,
 *  recording where (§9: refused wherever it appears in a fact) — a number as
 *  its digits, and a key holding one drops its entry. A number JSON could not
 *  hold (an AI's `1e400` reads as Infinity) is refused where it is too: it
 *  would be stored as nothing. */
const scrubCards = (value: unknown, path: string, refused: MailFactRefusal[]): unknown => {
  const holds = (text: string): string | null =>
    containsCardNumber(text) ? 'holds a full card number' : containsIban(text) ? 'holds a full account number (an IBAN)' : null;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    refused.push({ variable: path, reason: Number.isNaN(value) ? 'is not a number' : 'is too large a number' });
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const reason = holds(String(value));
    if (reason !== null) {
      refused.push({ variable: path, reason });
      return null;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, i) => scrubCards(item, `${path}[${i}]`, refused));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const reason = holds(key);
      if (reason !== null) {
        refused.push({ variable: path, reason: `a key ${reason}` });
        continue;
      }
      out[key] = scrubCards(item, `${path}.${key}`, refused);
    }
    return out;
  }
  return value;
};

const readFact = (
  template: MailTemplateDefinition,
  spec: MailFactTypeSpec,
  variableSpecs: ReadonlyMap<string, MailFactVariableSpec>,
  email: MailFactSourceEmail,
  position: number,
  block: { readonly source: 'body' | 'html'; readonly text: string } | undefined,
): { readonly fact: RulesPassFact; readonly readFromEmail: ReadonlySet<string> } => {
  const variables: Record<string, MailFactValue | null> = {};
  for (const name of variableSpecs.keys()) variables[name] = null;
  const passes: Record<string, MailFactPass> = {};
  const data: Record<string, unknown> = {};
  const refused: MailFactRefusal[] = [];
  const readFromEmail = new Set<string>();
  const filled = new Set<string>();

  for (const rule of template.rules) {
    const key = 'variable' in rule.target ? rule.target.variable : `data.${rule.target.data}`;
    if (filled.has(key)) continue; // the first rule that reads a target wins
    let found: Found;
    try {
      found = find(rule, email, template, block);
    } catch (error) {
      if (!(error instanceof TemplatePatternTimeout)) throw error;
      refused.push({ variable: key, reason: error.message });
      continue;
    }
    if (found === null) continue;

    if ('variable' in rule.target) {
      const variable = variableSpecs.get(rule.target.variable);
      if (variable === undefined) continue;
      let result: ReturnType<typeof normalizeValue>;
      if (found.kind === 'file') {
        result = variable.kind === 'file'
          ? { ok: true, value: found.fileId }
          : { ok: false, reason: 'an attachment fills only a file variable' };
      } else {
        result = normalizeValue(found.text, variable.kind, {
          ...(rule.locale !== undefined ? { locale: rule.locale } : {}),
          ...(variable.values !== undefined ? { values: variable.values } : {}),
          variable: variable.name,
        });
      }
      if (!result.ok) {
        refused.push({ variable: variable.name, reason: result.reason });
        continue;
      }
      variables[variable.name] = result.value;
      passes[variable.name] = 'rule';
      filled.add(key);
      if (found.kind === 'file' || found.fromEmail) readFromEmail.add(variable.name);
    } else {
      let dataValue: unknown;
      if (found.kind === 'file') dataValue = found.fileId;
      else if (rule.normalize !== undefined) {
        const result = normalizeValue(found.text, rule.normalize, {
          ...(rule.locale !== undefined ? { locale: rule.locale } : {}),
        });
        if (!result.ok) {
          refused.push({ variable: key, reason: result.reason });
          continue;
        }
        dataValue = result.value;
      } else dataValue = found.text;
      setPath(data, rule.target.data, dataValue);
      passes[key] = 'rule';
      filled.add(key);
    }
  }

  return { fact: finishFact(spec, { position, variables, passes, data, refused }), readFromEmail };
};

/** The finishing every pass shares (§9): a full card number anywhere in the
 *  data is refused, data over the cap is dropped with the reason, and
 *  `missing` / `complete` follow from the variables. */
export const finishFact = (
  spec: MailFactTypeSpec,
  draft: {
    readonly position: number;
    readonly variables: Record<string, MailFactValue | null>;
    readonly passes: Record<string, MailFactPass>;
    readonly data: Record<string, unknown>;
    readonly refused: MailFactRefusal[];
  },
): RulesPassFact => {
  const refused = [...draft.refused];
  let finalData: Record<string, unknown> | null = scrubCards(draft.data, 'data', refused) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(finalData), 'utf8') > MAIL_FACT_DATA_MAX_BYTES) {
    refused.push({ variable: 'data', reason: `data over ${MAIL_FACT_DATA_MAX_BYTES / 1024} KB` });
    finalData = null;
  }
  // Not there at all is missing too: a variable its kind gained since.
  const missing = spec.variables
    .filter((variable) => variable.required && (draft.variables[variable.name] ?? null) === null)
    .map((variable) => variable.name);
  return {
    position: draft.position,
    variables: draft.variables,
    passes: draft.passes,
    data: finalData,
    refused,
    missing,
    complete: missing.length === 0,
  };
};

// ────────────────────────────────────────────────────────────────
// The pass
// ────────────────────────────────────────────────────────────────

/** Split a repeated block's source at each match of its pattern. Each block
 *  runs from one match to the next; text before the first match is not a block.
 *  At most `MAIL_TEMPLATE_LIMITS.maxBlocks`: the last one ends where the next
 *  would begin, and `truncated` says the rest was left. */
const splitBlocks = (text: string, split: string): { blocks: string[]; truncated: boolean } => {
  const starts: number[] = [];
  let from = 0;
  let end = text.length;
  let truncated = false;
  while (from <= text.length) {
    const match = runTemplatePattern(split, 'i', text.slice(from));
    if (match === null) break;
    const at = from + match.index;
    if (starts.length === MAIL_TEMPLATE_LIMITS.maxBlocks) {
      end = at;
      truncated = true;
      break;
    }
    starts.push(at);
    from = at + Math.max(match[0].length, 1);
  }
  return { blocks: starts.map((start, i) => text.slice(start, starts[i + 1] ?? end)), truncated };
};

/** Read one template over one email. */
/** Whether a template's conditions may hold for an email the STORED COPY
 *  shows only in part (§6.2): the copy has no sender name, no HTML and no
 *  attachments, so a condition that needs one is left to the full read, and
 *  a pattern that runs too long counts as a maybe. A cheap first cut before
 *  an email is fetched again. */
export const conditionsMayHold = (
  conditions: readonly MailTemplateCondition[],
  stored: MailFactSourceEmail,
  readsHtml: boolean,
): boolean =>
  conditions.every((condition) => {
    const decidable =
      condition.field === 'subject'
      || condition.field === 'label'
      || condition.field === 'relationship'
      || (condition.field === 'from' && (condition.op === 'is' || condition.op === 'domain_is'))
      || (condition.field === 'body' && !readsHtml);
    if (!decidable) return true;
    try {
      return conditionHolds(condition, canonicalEmail(stored), readsHtml);
    } catch (error) {
      if (error instanceof TemplatePatternTimeout) return true;
      throw error;
    }
  });

export const runRulesPass = (
  template: MailTemplateDefinition,
  spec: MailFactTypeSpec,
  source: MailFactSourceEmail,
): RulesPassOutcome => {
  const email = canonicalEmail(source);
  const warnings: string[] = [];
  const withWarnings = <T extends object>(outcome: T): T =>
    warnings.length === 0 ? outcome : { ...outcome, warnings };
  const holds = (condition: MailTemplateCondition): boolean => {
    try {
      return conditionHolds(condition, email, template.html);
    } catch (error) {
      if (!(error instanceof TemplatePatternTimeout)) throw error;
      warnings.push(`the ${condition.field} condition: ${error.message}`);
      return false;
    }
  };
  if (!template.entrance.conditions.every(holds)) {
    return withWarnings({ kind: 'no_match' as const });
  }
  const variableSpecs = new Map(mailFactTypeVariables(spec).map((variable) => [variable.name, variable]));

  let blocks: ({ readonly source: 'body' | 'html'; readonly text: string } | undefined)[] = [undefined];
  if (template.repeat !== undefined) {
    const text = template.repeat.source === 'body' ? email.body_text : template.html ? email.html : null;
    let found: string[] = [];
    try {
      const split = text === null ? { blocks: [], truncated: false } : splitBlocks(text, template.repeat.split);
      found = split.blocks;
      if (split.truncated) {
        warnings.push(`the repeated block: more than ${MAIL_TEMPLATE_LIMITS.maxBlocks} blocks; the rest were not read`);
      }
    } catch (error) {
      if (!(error instanceof TemplatePatternTimeout)) throw error;
      warnings.push(`the repeated block: ${error.message}`);
    }
    blocks = found.map((blockText) => ({ source: template.repeat!.source, text: blockText }));
  }

  const facts: RulesPassFact[] = [];
  const unread = new Set<string>();
  blocks.forEach((block, i) => {
    const { fact, readFromEmail } = readFact(template, spec, variableSpecs, email, i, block);
    const lacking = template.entrance.variables.filter((name) => !readFromEmail.has(name));
    if (lacking.length > 0) {
      for (const name of lacking) unread.add(name);
      return;
    }
    facts.push({ ...fact, position: facts.length });
  });
  if (facts.length === 0) return withWarnings({ kind: 'not_entered' as const, unread: [...unread] });
  return withWarnings({ kind: 'facts' as const, facts });
};
