/** D-325 §5.3 — proof the owner forwards to their own `+done` address proposes
 * the close of an open occurrence: a renewed passport's new expiry, a service's
 * actual date. D-315 §7.4 is the entrance: only mail the account itself sent
 * becomes an owner request, so a stranger's email cannot close anything, and
 * nothing closes until the owner accepts the proposal. */
import type Database from 'better-sqlite3';
import { assetDateAt, isAssetDate, type Asset, type AssetRule, type MailFact, type SituationRef } from '@recued/contracts';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import type { ProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore, type AssetOccurrence } from '../storage/asset-occurrence-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { createAssetClassStore } from './asset-classes.js';

export const MAIL_PROOF_TAG = 'done';
/** A forward older than this is history, not proof for a cycle open today. */
const WINDOW_MS = 60 * 86_400_000;
/** More equally likely items than this and the forward names none of them. */
const MAX_CANDIDATES = 3;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAME = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const PATTERNS: Array<{ re: RegExp; parts: (m: RegExpExecArray) => [string, string, string] }> = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/gu, parts: m => [m[1]!, m[2]!, m[3]!] },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME}\\.?,?\\s+(\\d{4})\\b`, 'giu'), parts: m => [m[3]!, m[2]!, m[1]!] },
  { re: new RegExp(`\\b${MONTH_NAME}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'giu'), parts: m => [m[3]!, m[1]!, m[2]!] },
];
const EXPIRY_CUE = /(valid until|valid to|valid through|expir\w*|until)\W{0,3}$/iu;
const SERVICE_CUE = /(serviced|service date|completed|carried out|performed|done)( on)?\W{0,3}$/iu;
/** Words every forwarded proof shares; they tell one item from another not at all. */
const STOP = new Set(['the', 'and', 'for', 'your', 'you', 'new', 'has', 'have', 'been', 'this', 'that', 'with', 'from', 'renew', 'renewal', 'renewed',
  'service', 'fwd', 'forwarded', 'message', 'date', 'valid', 'until']);
const words = (value: string): Set<string> => new Set((value.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !STOP.has(word)));

/** Unambiguous written dates only: ISO, "12 March 2036" and "March 12, 2036".
 * A numeric 03/04/2036 reads two ways, so it stays unknown for the owner. */
export const datesIn = (text: string): Array<{ date: string; at: number }> => {
  const found: Array<{ date: string; at: number }> = [];
  for (const { re, parts } of PATTERNS) {
    re.lastIndex = 0;
    for (let match = re.exec(text); match; match = re.exec(text)) {
      const [year, month, day] = parts(match);
      const monthNumber = /^\d+$/u.test(month) ? Number(month) : MONTHS.indexOf(month.slice(0, 3).toLocaleLowerCase('en')) + 1;
      const date = `${year}-${String(monthNumber).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
      if (isAssetDate(date)) found.push({ date, at: match.index });
    }
  }
  return found;
};

/** The date this proof gives the rule's field, or null for the owner to enter:
 * one candidate, or the one candidate written right after its cue. */
export const proofDate = (text: string, rule: AssetRule, current: string | null, today: string): string | null => {
  const expiry = rule.when.kind === 'expiry';
  const all = datesIn(text).filter(({ date }) => expiry ? !current || date > current : date <= today && (!current || date > current));
  const distinct = [...new Set(all.map(row => row.date))];
  if (distinct.length === 1) return distinct[0]!;
  const cue = expiry ? EXPIRY_CUE : SERVICE_CUE;
  const cued = [...new Set(all.filter(row => cue.test(text.slice(Math.max(0, row.at - 40), row.at))).map(row => row.date))];
  return cued.length === 1 ? cued[0]! : null;
};

/** The asset and rule a forwarded proof can close this occurrence for: an action
 * of an enabled expiry or interval rule, on an asset still in use. */
export const proofTarget = (row: Pick<AssetOccurrence, 'subject_kind' | 'question' | 'asset_id' | 'rule_id'>,
  readAsset: (id: string) => Asset | null): { asset: Asset; rule: AssetRule } | null => {
  if (row.subject_kind === 'occasion' || row.question) return null;
  const asset = readAsset(row.asset_id); const rule = asset?.rules.find(item => item.id === row.rule_id);
  if (!asset || asset.deleted_at != null || !['active', 'lent'].includes(asset.status) || !rule?.enabled
    || !['expiry', 'interval'].includes(rule.when.kind) || rule.reaction.occurrence !== 'action') return null;
  return { asset, rule };
};

export interface MailProofDeps {
  db: Database.Database;
  work: WorkEntityStore;
  proposals: ProactiveProposalStore;
  mailFacts?: MailFactStore;
  isVaultUnlocked?(): boolean;
  now?(): number;
  timeZone?(): string;
}
export const createMailProof = (deps: MailProofDeps) => {
  const now = deps.now ?? Date.now;
  const rows = createAssetOccurrenceStore(deps.db);
  const contacts = createContactStore(deps.db);
  const classes = createAssetClassStore(deps.db);
  /** Open action occurrences of expiry and interval rules: the ones a date closes. */
  const open = (): Array<{ asset: Asset; rule: AssetRule }> => {
    const found = new Map<string, { asset: Asset; rule: AssetRule }>();
    for (let offset = 0; ; offset += 500) {
      const page = deps.work.listByKind('commitment', { limit: 500, offset, commitment_lifecycle_states: ['pending'] });
      for (const commitment of page) {
        if (commitment._kind !== 'commitment') continue;
        const occurrenceId = commitment.source_extension_blob?.occurrence_id;
        const row = typeof occurrenceId === 'string' ? rows.get(occurrenceId) : null;
        const target = row ? proofTarget(row, id => deps.work.readAsset(id)) : null;
        if (target) found.set(`${target.asset.id}\0${target.rule.id}`, target);
      }
      if (page.length < 500) break;
    }
    return [...found.values()];
  };
  const names = (asset: Asset): Set<string> => {
    const holder = asset.holder_contact ? contacts.getByContactIdResolved(asset.holder_contact) ?? contacts.get(asset.holder_contact) : null;
    return words([asset.name, asset.class_id ? classes.get(asset.class_id)?.name ?? '' : '', holder?.name ?? ''].join(' '));
  };
  const propose = (fact: MailFact, candidates: Array<{ asset: Asset; rule: AssetRule }>): void => {
    const account = `mail:${fact.email.slug}`;
    if (!deps.proposals.sourceEnabled(account) || fact.created_at <= deps.proposals.setting('forget_through', -1)) return;
    const data = fact.data as Record<string, unknown>;
    const body = [typeof data.subject === 'string' ? data.subject : '', typeof data.request === 'string' ? data.request : ''].join('\n');
    const said = words(body);
    const scored = candidates.map(item => ({ ...item, score: [...names(item.asset)].filter(word => said.has(word)).length }));
    const best = Math.max(0, ...scored.map(item => item.score));
    const winners = best > 0 ? scored.filter(item => item.score === best) : [];
    if (!winners.length || winners.length > MAX_CANDIDATES) return;
    const today = assetDateAt(now(), deps.timeZone?.() ?? 'UTC');
    const mail: SituationRef = { collection: 'mail', id: `${fact.email.slug}:${fact.email.record_id}` };
    for (const { asset, rule } of winners) {
      const field = rule.when.field; const on = proofDate(body, rule, asset.dates[field] ?? null, today);
      const payload = { asset_id: asset.id, rule_id: rule.id, on: on ?? '', evidence_mail: mail.id, fact_id: fact.fact_id,
        source_account: account, proposal_class: 'mail-close' };
      if (!deps.proposals.allows({ kind: 'close', payload })) continue;
      deps.proposals.ensure({ key: `mail-close:${fact.fact_id}:${asset.id}:${rule.id}`, kind: 'close', title: `${rule.title} · proof for ${asset.name}`,
        explanation: `You forwarded this to your +${MAIL_PROOF_TAG} address.${on ? ` It gives ${field.replaceAll('_', ' ')} as ${on}; confirm it before the clock closes.`
          : ' Enter the date it shows, then accept.'}${winners.length > 1 ? ' It could also be for another item, so check which one it proves.' : ''}`,
        payload, sources: [mail, { collection: 'mail_fact', id: fact.thing_id ?? fact.fact_id, field: `facts.${fact.fact_id}` }],
        subject: { collection: 'asset', id: asset.id }, confidence: winners.length > 1 ? 'low' : on ? 'high' : 'medium', origin: 'intake' }, now());
    }
  };
  return {
    /** Idempotent: each proposal is keyed by the forward and the item it proves. */
    scan(): void {
      if (!deps.mailFacts || deps.isVaultUnlocked?.() === false) return;
      const facts = deps.mailFacts.listFacts({ type: 'owner_request', since: now() - WINDOW_MS, limit: 200 })
        .filter(fact => fact.variables.tag === MAIL_PROOF_TAG);
      if (!facts.length) return;
      const candidates = open(); if (!candidates.length) return;
      for (const fact of facts) propose(fact, candidates);
    },
  };
};
