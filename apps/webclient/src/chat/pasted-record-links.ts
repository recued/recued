import { parseRecordLinkQuery, RECORD_LINK_QUERY_LIMIT, type ExactRecordLinkMatch, type ExactRecordLinkState } from '../data/exact-record-link.js';
import { RECORD_LINK_SELECTION_LIMIT, type PreparedRecordLink } from '../data/record-link-insert.js';
import type { WorkReaderLink } from '../data/task-note-source.js';

export interface DraftRecordLink { key: string; target: WorkReaderLink }
export interface RecordLinkDraftOwner { key: string; scope: object }
export interface PastedRecordLinkView { owner: RecordLinkDraftOwner; candidate: DraftRecordLink; checking: boolean; error?: string }

/** Recognize complete, whitespace-separated links. Ordinary text and other
 * deployments stay ordinary text; detection never reads a saved record. */
export const draftRecordLinks = (text: string, href: string): DraftRecordLink[] => {
  const links: DraftRecordLink[] = [], seen = new Set<string>();
  for (const match of text.matchAll(/\S+/gu)) {
    if (match[0].length > RECORD_LINK_QUERY_LIMIT) continue;
    const parsed = parseRecordLinkQuery(match[0], href);
    if (parsed.kind !== 'link' || seen.has(parsed.target.hash)) continue;
    seen.add(parsed.target.hash); links.push({ key: parsed.target.hash, target: parsed.target });
    if (links.length === 64) break;
  }
  return links;
};

/** Keep stronger existing selections and refuse to replace a frozen lifetime. */
export const mergePastedRecord = (records: readonly PreparedRecordLink[], reference: ExactRecordLinkMatch): { records: readonly PreparedRecordLink[]; error?: string } => {
  const existing = records.find(row => row.reference.target.hash === reference.target.hash);
  if (existing) return { records, ...(existing.reference.identity !== reference.identity
    ? { error: 'That address now belongs to a different record. Remove the earlier selection, then attach it again.' } : {}) };
  return records.length >= RECORD_LINK_SELECTION_LIMIT ? { records, error: 'You can attach up to 20 records. Remove a record, then try again.' }
    : { records: [...records, { reference }] };
};

interface DraftHints { dismissed: Set<string>; aliases: Map<string, { hash: string; identity: string }> }
export const createPastedRecordLinks = (deps: {
  owner: () => RecordLinkDraftOwner | null; text: () => string; href: () => string; records: () => readonly PreparedRecordLink[];
  blocked: () => boolean; read: (target: WorkReaderLink) => Promise<Exclude<ExactRecordLinkState, { state: 'loading' | 'error' | 'invalid' }>>;
  commit: (records: readonly PreparedRecordLink[]) => string | null; changed: () => void;
}) => {
  const hints = new WeakMap<object, DraftHints>();
  let view: PastedRecordLinkView | null = null, disposed = false, cachedText: string | undefined, cachedHref = '', links: DraftRecordLink[] = [];
  const meta = (owner: RecordLinkDraftOwner) => {
    let value = hints.get(owner.scope); if (!value) { value = { dismissed: new Set(), aliases: new Map() }; hints.set(owner.scope, value); }
    return value;
  };
  const state = (): PastedRecordLinkView | null => {
    const owner = deps.owner(); if (disposed || !owner) { view = null; return null; }
    const text = deps.text(), href = deps.href();
    if (text !== cachedText || href !== cachedHref) { cachedText = text; cachedHref = href; links = draftRecordLinks(text, href); }
    const remembered = meta(owner), selected = deps.records(), keys = new Set(links.map(link => link.key));
    for (const key of remembered.dismissed) if (!keys.has(key)) remembered.dismissed.delete(key);
    const candidate = links.find(link => {
      if (remembered.dismissed.has(link.key)) return false;
      const alias = remembered.aliases.get(link.key);
      return !selected.some(row => row.reference.target.hash === link.key || row.reference.routeAliases?.includes(link.key)
        || alias && row.reference.target.hash === alias.hash && row.reference.identity === alias.identity);
    });
    if (!candidate) { view = null; return null; }
    if (!view || view.owner.key !== owner.key || view.owner.scope !== owner.scope || view.candidate.key !== candidate.key)
      view = { owner, candidate, checking: false };
    return view;
  };
  return {
    state,
    hasPending: () => state()?.checking === true,
    reset() { view = null; },
    dismiss(key: string) {
      const current = state(); if (!current || current.candidate.key !== key) return;
      const remembered = meta(current.owner); remembered.dismissed.add(key); view = null; state(); deps.changed();
    },
    async attach(key: string) {
      const current = state(); if (!current || current.candidate.key !== key || current.checking || deps.blocked()) return;
      const pending: PastedRecordLinkView = { ...current, checking: true }; view = pending; deps.changed();
      const valid = () => state() === pending && !deps.blocked();
      try {
        const result = await deps.read(pending.candidate.target);
        if (!valid()) return;
        if (result.state !== 'ready') { view = { ...pending, checking: false, error: result.message }; return; }
        const merged = mergePastedRecord(deps.records(), result.match);
        if (merged.error) { view = { ...pending, checking: false, error: merged.error }; return; }
        const remembered = meta(pending.owner);
        remembered.aliases.set(pending.candidate.key, { hash: result.match.target.hash, identity: result.match.identity });
        while (remembered.aliases.size > 64) remembered.aliases.delete(remembered.aliases.keys().next().value!);
        const error = deps.commit(merged.records);
        if (error && state() === pending) view = { ...pending, checking: false, error };
        else state();
      } catch {
        if (valid()) view = { ...pending, checking: false, error: 'This record could not be attached. Try again.' };
      } finally {
        if (view === pending) view = { ...pending, checking: false };
        if (!disposed) deps.changed();
      }
    },
    dispose() { disposed = true; view = null; },
  };
};
