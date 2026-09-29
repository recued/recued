/**
 * D-315 §6.2 — Preview: a template, before it is saved, run over the email it
 * is made from and the newest stored emails that meet its conditions, showing
 * whether each entered and every value or miss.
 *
 *   - **Nothing is stored and nothing fires.** It runs the rules pass, then the
 *     same §4 merge with the standards pass that the writer runs — so a
 *     template that reads a parcel's state and leaves the parcel to the
 *     standard markup previews as complete, as it will be.
 *   - **Each email is read as the ingest read it:** again from its provider
 *     (`stored-email.ts`), or, when it cannot be, from the stored copy — and
 *     the result says which, since the stored copy has no HTML, headers,
 *     sender name or attachments.
 *   - **Finding the matching emails is a cheap first cut, then the real read.**
 *     Stored mail is walked newest first across every mailbox; a condition the
 *     stored copy can decide is tested on it (`conditionsMayHold`), and only an
 *     email that may match is fetched again and run. The walk stops at
 *     `limit` matches or `SCAN_CAP` emails, whichever comes first.
 *   - Mail Recued itself sent, and drafts, are passed over, as the ingest
 *     passes them over — and so are security notices, which the writer skips:
 *     a preview never shows a sign-in code the template would read. One as the
 *     email the template is made from is refused (`MailPreviewSecurityNotice`).
 */

import {
  isMailReconciliationId,
  type CollectionRecord,
  type MailFactEmailRef,
  type MailFactEmailSummary,
  type MailFactTypeSpec,
  type MailTemplateDefinition,
  type MailTemplatePreviewEmail,
  type MailTemplatePreviewFact,
  type MailTemplatePreviewResult,
  type MailTemplateRead,
  type MailTemplateSample,
} from '@recued/contracts';

import type { MailCollection } from '../collections/mail/mail-collection.js';
import { mergeStandardsFacts } from './fact-writer.js';
import { conditionsMayHold, runRulesPass, type MailFactSourceEmail } from './rules-pass.js';
import { looksLikeSecurityNotice } from './security-notice.js';
import { readAsSent } from './owner-request.js';
import { runStandardsPass, type MailFactEnvelope } from './standards-pass.js';
import { readStoredEmail, storedCopyEmail, type StoredEmailDeps } from './stored-email.js';

const DAY_MS = 86_400_000;
/** At most this many stored emails are walked for one preview. */
export const PREVIEW_SCAN_CAP = 2_000;
const PAGE = 200;
const PREVIEW_TEMPLATE_ID = 'preview';

/** The email a preview was asked for is a security notice: Recued reads
 *  nothing from those, so nothing is shown from it either (§9). */
export class MailPreviewSecurityNotice extends Error {
  constructor() {
    super('This email looks like a security notice (a sign-in code or a password reset). Recued reads nothing from those.');
  }
}

export interface TemplatePreviewDeps extends StoredEmailDeps {
  /** Every mailbox. */
  readonly mailboxes: () => readonly MailCollection[];
  /** The days a mailbox keeps mail (§5.3); `null` when unknown. */
  readonly retentionDays?: (slug: string) => number | null;
  /** The standards types the owner switched off (ruling 10). */
  readonly standardsOff: () => ReadonlySet<string>;
}

export type PreviewSource =
  | { readonly email: MailFactEmailRef }
  | { readonly sample: MailTemplateSample };

const hotString = (record: CollectionRecord, key: string): string => {
  const value = record.hot_fields[key];
  return typeof value === 'string' ? value : '';
};

/** Skipped by the ingest, so skipped here: drafts, and mail Recued sent. */
const ingestSkips = (record: CollectionRecord): boolean =>
  record.hot_fields.direction === 'draft' || isMailReconciliationId(record.hot_fields.reconciliation_id);

export const summaryOf = (
  deps: Pick<TemplatePreviewDeps, 'retentionDays'>,
  slug: string,
  record: CollectionRecord,
): MailFactEmailSummary => {
  const days = deps.retentionDays?.(slug) ?? null;
  return {
    slug,
    record_id: record.record_id,
    from: hotString(record, 'from'),
    subject: hotString(record, 'subject'),
    at: record.received_at,
    ...(days !== null && days > 0 ? { goes_at: record.received_at + days * DAY_MS } : {}),
  };
};

/** `Name <address>`, or a bare address. */
export const parseSampleSender = (from: string): { readonly address: string; readonly name: string } => {
  const angled = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(from);
  if (angled !== null) {
    return { address: angled[2]!.trim().toLowerCase(), name: angled[1]!.replace(/^"|"$/g, '').trim() };
  }
  return { address: from.trim().toLowerCase(), name: '' };
};

export const sampleEmail = (
  deps: Pick<StoredEmailDeps, 'relationshipsOf'>,
  sample: MailTemplateSample,
): MailFactSourceEmail => {
  const sender = parseSampleSender(sample.from);
  return {
    subject: sample.subject,
    body_text: sample.body,
    html: sample.html !== undefined && sample.html.length > 0 ? sample.html : null,
    from_address: sender.address,
    from_name: sender.name,
    headers: {},
    labels: [],
    relationships: deps.relationshipsOf?.(sender.address) ?? [],
    attachments: [],
  };
};

/** A pasted email is never an owner request: nobody's provider sent it. */
const sampleEnvelope = (): MailFactEnvelope => ({
  slug: '',
  account_email: '',
  to: [],
  cc: [],
  sent_by_account: false,
  rfc_message_id: null,
  thread_id: '',
});

/** The template's reading of one email, merged with the standards pass. */
export const previewOne = (
  deps: Pick<TemplatePreviewDeps, 'standardsOff'>,
  definition: MailTemplateDefinition,
  spec: MailFactTypeSpec,
  email: MailFactSourceEmail,
  envelope: MailFactEnvelope,
  read: MailTemplateRead,
  summary?: MailFactEmailSummary,
): MailTemplatePreviewEmail => {
  // As the writer reads it: mail the account sent only when the template's
  // entrance names a label or folder.
  if (readAsSent(envelope) && !definition.entrance.conditions.some((c) => c.field === 'label' && c.negate !== true)) {
    return {
      ...(summary !== undefined ? { email: summary } : {}),
      read,
      warnings: ['you sent this email: a template reads mail you sent only when its entrance names a label or folder'],
      outcome: 'no_match',
      facts: [],
    };
  }
  const outcome = runRulesPass(definition, spec, email);
  const base = {
    ...(summary !== undefined ? { email: summary } : {}),
    read,
    ...(outcome.warnings !== undefined && outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
  };
  if (outcome.kind === 'no_match') return { ...base, outcome: 'no_match', facts: [] };
  if (outcome.kind === 'not_entered') return { ...base, outcome: 'not_entered', unread: outcome.unread, facts: [] };
  const off = deps.standardsOff();
  const standards = runStandardsPass(email, envelope, { isOn: (type) => !off.has(type) })
    .filter((fact) => fact.type === spec.id);
  const facts: MailTemplatePreviewFact[] = mergeStandardsFacts(spec, PREVIEW_TEMPLATE_ID, outcome.facts, standards)
    .filter((planned) => planned.template_id === PREVIEW_TEMPLATE_ID)
    .map(({ read: fact }) => ({
      position: fact.position,
      variables: fact.variables,
      passes: fact.passes,
      data: fact.data,
      missing: fact.missing,
      refused: fact.refused,
      complete: fact.complete,
    }));
  return { ...base, outcome: 'entered', facts };
};

interface Walker {
  readonly mailbox: MailCollection;
  buffer: CollectionRecord[];
  /** The last email read: the next page starts after it, by date and id. */
  before: { received_at: number; record_id: string } | undefined;
  done: boolean;
}

/** The next stored email across every mailbox, newest first. */
const nextRecord = (walkers: Walker[]): { walker: Walker; record: CollectionRecord } | null => {
  for (const walker of walkers) {
    while (walker.buffer.length === 0 && !walker.done) {
      // Paged by date and id: several emails can share a date, and a page
      // ending inside them must neither repeat them nor end the walk.
      const page = walker.mailbox.list({
        platform: 'mail',
        slug: walker.mailbox.slug,
        ...(walker.before !== undefined ? { before: walker.before } : {}),
        limit: PAGE,
      });
      if (page.length < PAGE) walker.done = true;
      const last = page[page.length - 1];
      if (last !== undefined) walker.before = { received_at: last.received_at, record_id: last.record_id };
      walker.buffer = page;
    }
  }
  let best: Walker | undefined;
  for (const walker of walkers) {
    const head = walker.buffer[0];
    if (head !== undefined && (best === undefined || head.received_at > best.buffer[0]!.received_at)) best = walker;
  }
  if (best === undefined) return null;
  return { walker: best, record: best.buffer.shift()! };
};

export const previewTemplate = async (
  deps: TemplatePreviewDeps,
  definition: MailTemplateDefinition,
  spec: MailFactTypeSpec,
  source: PreviewSource | undefined,
  limit: number,
): Promise<MailTemplatePreviewResult> => {
  const mailboxes = deps.mailboxes();
  let sourceResult: MailTemplatePreviewEmail | undefined;
  let skip: MailFactEmailRef | undefined;
  if (source !== undefined && 'sample' in source) {
    const email = sampleEmail(deps, source.sample);
    if (looksLikeSecurityNotice(email)) throw new MailPreviewSecurityNotice();
    sourceResult = previewOne(deps, definition, spec, email, sampleEnvelope(), 'sample');
  } else if (source !== undefined) {
    skip = source.email;
    const mailbox = mailboxes.find((candidate) => candidate.slug === source.email.slug);
    const stored = mailbox === undefined ? null : await readStoredEmail(deps, mailbox, source.email.record_id);
    if (stored !== null && looksLikeSecurityNotice(stored.email)) throw new MailPreviewSecurityNotice();
    if (stored !== null) {
      sourceResult = previewOne(
        deps, definition, spec, stored.email, stored.envelope, stored.read,
        summaryOf(deps, source.email.slug, stored.record),
      );
    }
  }

  const recent: MailTemplatePreviewEmail[] = [];
  let scanned = 0;
  const conditions = definition.entrance.conditions;
  const needsBody = conditions.some((condition) => condition.field === 'body') && !definition.html;
  const walkers: Walker[] = mailboxes.map((mailbox) => ({
    mailbox, buffer: [], before: undefined, done: false,
  }));
  while (recent.length < limit && scanned < PREVIEW_SCAN_CAP) {
    const next = nextRecord(walkers);
    if (next === null) break;
    scanned += 1;
    const { walker, record } = next;
    if (skip !== undefined && skip.slug === walker.mailbox.slug && skip.record_id === record.record_id) continue;
    if (ingestSkips(record)) continue;
    // First cut on the hot fields; the body is read only when a condition
    // on it can be decided from the stored text.
    const bodyless = conditions.filter((condition) => condition.field !== 'body');
    if (!conditionsMayHold(bodyless, await storedCopyEmail(deps, record, { withBody: false }), definition.html)) continue;
    if (needsBody && !conditionsMayHold(conditions, await storedCopyEmail(deps, record), definition.html)) continue;
    const stored = await readStoredEmail(deps, walker.mailbox, record.record_id);
    if (stored === null || looksLikeSecurityNotice(stored.email)) continue;
    const result = previewOne(
      deps, definition, spec, stored.email, stored.envelope, stored.read,
      summaryOf(deps, walker.mailbox.slug, stored.record),
    );
    if (result.outcome === 'no_match') continue;
    recent.push(result);
  }
  return { ...(sourceResult !== undefined ? { source: sourceResult } : {}), recent, scanned };
};
