import { holdsPiiAliasToken } from '@recued/transforms';
import { createHash } from 'node:crypto';
import type { MailWorkEvidence } from './mail-work-evidence.js';
import { mailEvidenceMetadata } from './mail-evidence.js';

export const MAIL_WORK_SOURCE_STATES = ['current', 'historical', 'withdrawn', 'superseded', 'uncertain'] as const;
export type MailWorkSourceState = typeof MAIL_WORK_SOURCE_STATES[number];
export interface MailWorkQuoteSource {
  readonly text: string; readonly label: string; readonly href?: string;
  readonly file_ref?: string; readonly content_hash?: string; readonly read_version?: string;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const normalized = (text: string): string => text.replace(/\s+/gu, ' ').trim();
// Prevent source-authored Markdown from manufacturing additional record links.
export const displayMailWorkSourceText = (text: string): string => normalized(text).replace(/\[/gu, '\\[');

/** Verify a contiguous excerpt against ONE actual source after PII restoration.
 * This checks attribution and exact wording, not its relevance or declared state.
 * The status is explicitly labelled AI interpretation, not part of the quote. */
export const matchMailWorkSourceQuote = (
  value: unknown, sources: ReadonlyMap<string, MailWorkQuoteSource>, allowQuotationWrapper = false,
): { source: string; quote: string; rendered: string } | null => {
  if (!object(value) || typeof value.source !== 'string' || typeof value.quote !== 'string'
    || !value.quote.trim() || value.quote.includes('\u0000') || value.quote.length > 900 || holdsPiiAliasToken(value.quote)) return null;
  const source = sources.get(value.source);
  if (!source) return null;
  const observed = normalized(source.text);
  let quote = normalized(value.quote);
  // Some JSON providers include quotation punctuation inside the quote value.
  // Decode one enclosing pair only when its unchanged interior matches this
  // exact source. Never remove words, join spans, choose another source or
  // change the historical recap contract. Prefer the complete literal match.
  if (allowQuotationWrapper && !observed.includes(quote)
    && [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']].some(([start, end]) => quote.startsWith(start!) && quote.endsWith(end!))) {
    const interior = quote.slice(1, -1).trim();
    if (interior && observed.includes(interior)) quote = interior;
  }
  if (!observed.includes(quote) || (quote.length < 8 && quote !== observed)) return null;
  const label = source.href ? `[${source.label}](${source.href})` : source.label;
  return { source: value.source, quote, rendered: `${label}: “${displayMailWorkSourceText(quote)}”` };
};

/** Compatibility for saved recap declarations. New source plans quote a
 * source without assigning one business state to everything in its excerpt. */
export const matchMailWorkQuote = (
  value: unknown, sources: ReadonlyMap<string, MailWorkQuoteSource>,
): { source: string; quote: string; state: MailWorkSourceState; rendered: string } | null => {
  if (!object(value) || !MAIL_WORK_SOURCE_STATES.some(state => state === value.state)) return null;
  const matched = matchMailWorkSourceQuote(value, sources);
  if (!matched) return null;
  const source = sources.get(matched.source)!;
  const label = source.href ? `[${source.label}](${source.href})` : source.label;
  const state = value.state as MailWorkSourceState;
  return { ...matched, state, rendered: `${label} (AI status: ${state}): “${displayMailWorkSourceText(matched.quote)}”` };
};

export const mailWorkQuoteSources = (evidence: MailWorkEvidence): Map<string, MailWorkQuoteSource> => {
  const sources = new Map<string, MailWorkQuoteSource>([
    ['owner_request', { label: 'Your investigation request', text: evidence.investigation_request }],
    ...evidence.owner_updates.map((text, i): [string, MailWorkQuoteSource] =>
      [`owner_update_${i + 1}`, { label: `Your follow-up ${i + 1}`, text }]),
  ]);
  for (const call of evidence.observations) {
    if (call.tool_name === 'document.read' && object(call.args) && typeof call.args.file_ref === 'string'
      && /^file:[0-9a-f]{32}$/u.test(call.args.file_ref)) {
      const href = `#data/files/record/received/${encodeURIComponent(call.args.file_ref)}`;
      if (call.status !== 'ok' || !object(call.result) || call.result.status !== 'read'
        || call.result.file_ref !== call.args.file_ref || typeof call.result.body !== 'string'
        || typeof call.result.content_hash !== 'string' || !/^[0-9a-f]{64}$/u.test(call.result.content_hash)
        || typeof call.result.read_version !== 'string' || !/^[0-9a-f]{64}$/u.test(call.result.read_version)) {
        sources.delete(href); continue;
      }
      const previous = sources.get(href);
      sources.set(href, { label: `Document (content ${call.result.content_hash})`, href,
        file_ref: call.result.file_ref, content_hash: call.result.content_hash, read_version: call.result.read_version,
        text: previous?.read_version === call.result.read_version ? `${previous.text}\n\u0000\n${call.result.body}` : call.result.body });
      continue;
    }
    if (call.tool_name !== 'mail.read' || call.status !== 'ok' || !object(call.args) || !object(call.result)
      || typeof call.args.slug !== 'string' || typeof call.args.record_id !== 'string'
      || typeof call.result.body !== 'string') continue;
    const url = mailEvidenceMetadata(call.args.slug, call.args.record_id, undefined).source_url;
    if (call.result.source_url !== url) continue;
    // Keep pages separate: a quote cannot cross an unread gap between pages.
    // Multiple pages use the same link; match against each actual page below.
    const previous = sources.get(url);
    sources.set(url, { label: 'Email', href: url,
      ...(typeof call.result.read_version === 'string' ? { read_version: call.result.read_version } : {}),
      text: previous ? `${previous.text}\n\u0000\n${call.result.body}` : call.result.body });
  }
  return sources;
};

/** Bind only an exact record id observed in one readable mailbox. A record id
 * is not globally unique. Never choose a mailbox from quote similarity or use
 * search results, denied reads, partial ids or owner-source names as aliases. */
const mailWorkRecordReferences = (
  evidence: MailWorkEvidence, sources: ReadonlyMap<string, MailWorkQuoteSource>,
): Map<string, string> => {
  const references = new Map<string, Set<string>>();
  for (const call of evidence.observations) {
    if (call.tool_name !== 'mail.read' || call.status !== 'ok' || !object(call.args) || !object(call.result)
      || typeof call.args.slug !== 'string' || typeof call.args.record_id !== 'string' || !call.args.record_id.trim()
      || typeof call.result.body !== 'string') continue;
    const id = call.args.record_id, url = mailEvidenceMetadata(call.args.slug, id, undefined).source_url;
    if (call.result.source_url !== url || !sources.has(url) || sources.has(id) || id.startsWith('owner_')) continue;
    const urls = references.get(id) ?? new Set<string>();
    urls.add(url); references.set(id, urls);
  }
  return new Map([...references].flatMap(([id, urls]) => urls.size === 1 ? [[id, [...urls][0]!] as const] : []));
};

/** Short references are derived from exact readable mailbox URLs, never model
 * text. The same locator keeps its handle across rereads, pagination, additions
 * and Chat carry. Collisions are omitted, not resolved by matching the quote. */
const sourceReferences = (evidence: MailWorkEvidence, sources: ReadonlyMap<string, MailWorkQuoteSource>) => {
  const ids = new Set(evidence.observations.flatMap(call => object(call.args) && typeof call.args.record_id === 'string'
    ? [call.args.record_id] : []));
  const handles = new Map<string, string[]>();
  for (const source of sources.values()) {
    if (!source.href) continue;
    const handle = source.file_ref
      ? `document_${createHash('sha256').update(`${source.href}\u0000${source.read_version}`).digest('hex').slice(0, 12)}`
      : `mail_${createHash('sha256').update(source.href).digest('hex').slice(0, 12)}`;
    handles.set(handle, [...(handles.get(handle) ?? []), source.href]);
  }
  const catalog = [...handles].flatMap(([source, urls]) => urls.length === 1 && !ids.has(source) && !sources.has(source)
    ? [{ source, source_url: urls[0]!, ...(sources.get(urls[0]!)!.file_ref ? {
      file_ref: sources.get(urls[0]!)!.file_ref, content_hash: sources.get(urls[0]!)!.content_hash,
      read_version: sources.get(urls[0]!)!.read_version,
    } : {}) }] : []);
  return { catalog, reserved: new Set(handles.keys()) };
};

export const mailWorkSourceCatalog = (evidence: MailWorkEvidence): Array<{ source: string; source_url: string }> =>
  sourceReferences(evidence, mailWorkQuoteSources(evidence)).catalog;

/** The plan's directory must contain every source accepted by its schema.
 * Owner text has no mailbox URL; keep its source ID and exact text together so
 * the model need not infer an ID from a prose convention or treat owner notes
 * as missing evidence. These values still cross the ordinary privacy boundary. */
export type MailWorkPlanSource = { source: string; source_url: string; scope_role?: 'work_anchor' | 'context_candidate' }
  | { source: string; source_text: string };
export const mailWorkPlanSourceCatalog = (evidence: MailWorkEvidence): MailWorkPlanSource[] => {
  const selected = evidence.selected_mail && new Set(evidence.selected_mail.map(ref =>
    mailEvidenceMetadata(ref.slug, ref.record_id, undefined).source_url));
  return [
    ...mailWorkSourceCatalog(evidence).map(row => ({ ...row,
      // Selection identifies the matter, not the truth/currentness of a mail.
      // Other reads remain available, including related cross-sender mail.
      ...(selected && row.source.startsWith('mail_')
        ? { scope_role: selected.has(row.source_url) ? 'work_anchor' as const : 'context_candidate' as const } : {}),
    })),
    ...[...mailWorkQuoteSources(evidence)].flatMap(([source, value]) => value.href ? [] : [{ source, source_text: value.text }]),
  ];
};

/** Current plan bindings, including ephemeral document reads. */
export const mailWorkPlanSources = (evidence: MailWorkEvidence): Map<string, MailWorkQuoteSource> => {
  const original = mailWorkQuoteSources(evidence);
  return new Map([
    ...[...original].filter(([, source]) => !source.href),
    ...mailWorkSourceCatalog(evidence).map(row => [row.source, original.get(row.source_url)!] as const),
  ]);
};

export interface MailWorkPassage { readonly id: string; readonly source: string; readonly text: string }

/** Selection handles bind the text AND source. The model never copies a quote
 * or pairs it with a second ID. Split only within a read page/owner field; keep
 * all text and prefer paragraph/sentence boundaries for long pages. A passage
 * is not a complete assertion: its neighbours can still qualify it. */
export const mailWorkSourcePassages = (sources: ReadonlyMap<string, MailWorkQuoteSource>): MailWorkPassage[] => {
  const rows: MailWorkPassage[] = [];
  for (const [source, value] of sources) {
    const version = createHash('sha256').update(JSON.stringify([source, value.read_version, value.text])).digest('hex');
    let index = 0;
    for (const page of value.text.split('\u0000')) {
      let rest = page.trim();
      while (rest) {
        let end = Math.min(900, rest.length);
        if (end < rest.length) {
          // Prefer a complete paragraph, then sentence, then word. Do not
          // discard text, join separated spans or split a surrogate pair.
          const head = rest.slice(0, end);
          const boundary = (pattern: RegExp) => [...head.matchAll(pattern)].at(-1)?.index;
          const paragraph = boundary(/\r?\n[\t ]*\r?\n/gu);
          const sentence = boundary(/(?<=[.!?。！？])\s+/gu);
          const word = boundary(/\s+/gu);
          end = [paragraph, sentence, word].find(n => n !== undefined && n >= 450) ?? end;
          if (/[\uD800-\uDBFF]/u.test(rest.charAt(end - 1))) end--;
        }
        const text = rest.slice(0, end).trim();
        const id = `passage_${createHash('sha256').update(`${version}:${index++}`).digest('hex').slice(0, 16)}`;
        rows.push({ id, source, text });
        rest = rest.slice(end).trimStart();
      }
    }
  }
  // Never resolve a collision through content similarity or source order.
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  return rows.filter(row => counts.get(row.id) === 1);
};

export const mailWorkPassageCatalog = (evidence: MailWorkEvidence): MailWorkPassage[] =>
  mailWorkSourcePassages(mailWorkPlanSources(evidence));

export const renderMailWorkSourceRecap = (value: unknown, evidence: MailWorkEvidence): {
  text: string; outcome: 'matched' | 'missing' | 'invalid'; excerpts: number;
} => {
  const sources = mailWorkQuoteSources(evidence);
  const references = mailWorkRecordReferences(evidence, sources);
  const { catalog, reserved } = sourceReferences(evidence, sources);
  // A record ID or collision cannot hijack a host source handle.
  for (const handle of reserved) references.delete(handle);
  for (const row of catalog) references.set(row.source, row.source_url);
  const matches = Array.isArray(value) && value.length > 0 && value.length <= 6
    ? value.map(row => matchMailWorkQuote(object(row) && typeof row.source === 'string' && references.has(row.source)
      ? { ...row, source: references.get(row.source) } : row, sources)) : [];
  const matched = matches.filter(row => row !== null);
  const renderMatches = (): string => `Selected source excerpts\n${matched.map(row => `• ${row.rendered}`).join('\n')}`;
  if (matches.length && matches.every(row => row !== null)) return {
    text: renderMatches(),
    outcome: 'matched', excerpts: matches.length,
  };
  const links = [...sources.values()].filter(source => source.href).slice(0, 8)
    .map((source, i) => `[Email ${i + 1}](${source.href})`);
  return {
    text: (matched.length ? `${renderMatches()}\n\nSome AI-selected excerpts could not be matched to their declared sources and were omitted. Check the sources before relying on this proposal.`
      : 'The AI did not supply a source recap that could be matched to the records. Check the sources before relying on this proposal.')
      + (links.length ? `\nSources read: ${links.join(' · ')}` : ''),
    outcome: value === undefined ? 'missing' : 'invalid', excerpts: matched.length,
  };
};
