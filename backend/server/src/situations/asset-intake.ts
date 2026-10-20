import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import { isAssetDate, shiftAssetDate, type AssetPatch, type MailFact, type ProactiveProposalLane, type SituationRef } from '@recued/contracts';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import type { ProactiveProposalStore } from '../storage/proactive-proposal-store.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HEALTH = /\b(health|wellness|pharmac(?:y|ies|eutical)|medic(?:al|ine|ation)|prescription|pregnan(?:t|cy)|fertility|chemotherapy|hospital|clinic|vitamins?|supplements?|diabet(?:es|ic)|insulin|glucose|blood pressure|contracepti(?:on|ve))\b/iu;
const DURABLE = /\b(tv|television|laptop|computer|phone|tablet|camera|console|bicycle|bike|car|vehicle|boiler|alarm|fridge|refrigerator|washer|dryer|dishwasher|oven|furniture|sofa|chair|table|desk|bed|wardrobe|watch|jewel(?:lery|ry)|ring|piano|guitar|instrument|appliance|heirloom|keepsake|artwork|painting)\b/iu;
const classFor = (name: string): string | undefined => /\b(passport)\b/iu.test(name) ? 'passport'
  : /\b(insurance|policy)\b/iu.test(name) ? 'insurance_policy' : /\b(service contract|subscription)\b/iu.test(name) ? 'service_contract'
  : /\b(boiler)\b/iu.test(name) ? 'boiler' : /\b(smoke alarm|co alarm|carbon monoxide)\b/iu.test(name) ? 'smoke_alarm'
  : /\b(vehicle|car)\b/iu.test(name) ? 'vehicle' : undefined;
/** An offer is keyed by its purchase (an unpaired fact stands for one) and item.
 * Retention reads the purchase back: mail ids are never reused and carry no colon. */
export const intakeOfferKey = (source: string, identity: string): string => `intake:${source}:${identity}`;
export const intakeOfferSource = (key: string): string | null => /^intake:([^:]+):/u.exec(key)?.[1] ?? null;
/** A receipt records one item of one fact as it was read. */
export const intakeReceiptKey = (fact: Pick<MailFact, 'fact_id' | 'source_hash'>, identity: string): string => `${fact.fact_id}:${fact.source_hash}:${identity}`;
export const intakeReceiptFact = (key: string): Pick<MailFact, 'fact_id' | 'source_hash'> | null => {
  const match = /^([^:]+):([^:]+):/u.exec(key);
  return match ? { fact_id: match[1]!, source_hash: match[2]! } : null;
};

export interface AssetIntakeDeps {
  db: Database.Database;
  proposals: ProactiveProposalStore;
  mailFacts?: MailFactStore;
  isVaultUnlocked?(): boolean;
  now?(): number;
}
export const createAssetIntake = (deps: AssetIntakeDeps) => {
  const now = deps.now ?? Date.now;
  let running: Promise<void> | undefined;
  const proposeFact = (fact: MailFact, state: string | null) => {
    const account = `mail:${fact.email.slug}`;
    if (!deps.proposals.sourceEnabled(account) || fact.created_at <= deps.proposals.setting('forget_through', -1)) return;
    const data = object(fact.data); const merchant = string(fact.variables.merchant ?? fact.variables.issuer ?? fact.variables.provider);
    if (merchant && deps.proposals.suppressions().some(row => row.kind === 'merchant' && row.value?.toLocaleLowerCase('en') === merchant.toLocaleLowerCase('en'))) return;
    if (HEALTH.test([merchant ?? '', string(data.category) ?? ''].join(' '))) return;
    if (state === 'cancelled' || state === 'returned' || state === 'refund_issued') return;
    const rawItems = Array.isArray(data.items) ? data.items : data.item ? [data.item]
      : fact.type === 'bill' && data.contract ? [data.contract] : [];
    const identities = new Set<string>();
    for (const raw of rawItems.slice(0, 200)) {
      const item = typeof raw === 'string' ? { name: raw } : object(raw);
      const name = string(item.name ?? item.description ?? item.title); if (!name || name.length > 200) continue;
      const category = Array.isArray(item.category) ? item.category.filter(value => typeof value === 'string').join(' ') : string(item.category) ?? '';
      if (item.health === true || item.sensitive === true || HEALTH.test(`${name} ${category}`)) continue;
      const warranty = string(item.warranty_ends_on); const explicitWarranty = warranty && isAssetDate(warranty) ? warranty : undefined;
      const knownClass = classFor(`${category} ${name}`);
      const durable = item.durable === true || DURABLE.test(`${name} ${category}`) || knownClass !== undefined || explicitWarranty !== undefined;
      if (!durable) continue;
      const identity = hash([name.normalize('NFKC').toLocaleLowerCase('en'), item.sku ?? null, item.serial_number ?? null]);
      if (identities.has(identity)) continue; identities.add(identity);
      const key = intakeOfferKey(fact.thing_id ?? fact.fact_id, identity);
      const receipt = intakeReceiptKey(fact, identity);
      if (deps.proposals.receipt(receipt)) continue;
      const lane: ProactiveProposalLane = item.gift === true || /\bgift\b/iu.test(string(item.purpose) ?? '') ? 'gift'
        : fact.type === 'return_refund' || item.returning === true ? 'return' : item.pickup === true ? 'pickup'
        : item.bundle === true || Array.isArray(item.components) ? 'bundle' : 'likely_asset';
      const dates: Record<string, string | null> = {};
      if (explicitWarranty) dates.warranty_ends_on = explicitWarranty;
      const months = item.warranty_months; const ordered = string(fact.variables.ordered_at)?.slice(0, 10);
      if (!explicitWarranty && typeof months === 'number' && Number.isInteger(months) && months > 0 && months <= 120 && ordered && isAssetDate(ordered)) {
        try { dates.warranty_ends_on = shiftAssetDate(ordered, { amount: months, unit: 'months' }); }
        catch { /* An unrepresentable date remains unknown, with its source available. */ }
      }
      const expiry = string(item.expires_on); if (expiry && isAssetDate(expiry)) dates.expires_on = expiry;
      const asset: AssetPatch & { name: string } = { name, ...(knownClass || Object.keys(dates).length ? { class_id: knownClass ?? 'warranty_purchase' } : {}),
        dates, attributes: { ...(merchant ? { merchant } : {}), ...(string(item.model) ? { model: string(item.model) } : {}), intake_lane: lane },
        ...(string(item.serial_number) ? { serial_number: string(item.serial_number) } : {}) };
      const sources: SituationRef[] = [{ collection: 'mail', id: `${fact.email.slug}:${fact.email.record_id}` },
        { collection: 'mail_fact', id: fact.thing_id ?? fact.fact_id, field: `facts.${fact.fact_id}` }];
      const payload = { asset, fact_id: fact.fact_id, source_account: account, proposal_class: `asset:${asset.class_id ?? 'unclassified'}` };
      if (!deps.proposals.allows({ kind: 'asset', payload })) continue;
      deps.proposals.ensure({ key, kind: 'asset', title: name, explanation: `${merchant ? `${merchant}: ` : ''}a stored ${fact.type} names this item.${dates.warranty_ends_on ? ` Warranty ends ${dates.warranty_ends_on}.` : ''}`,
        payload, sources,
        confidence: explicitWarranty || string(item.serial_number) ? 'high' : item.durable === true || knownClass ? 'medium' : 'low',
        lane, ...(merchant ? { merchant } : {}), origin: 'intake' }, now());
      deps.proposals.recordReceipt(receipt, account, now());
    }
  };
  const run = async (): Promise<void> => {
    if (!deps.mailFacts || deps.isVaultUnlocked?.() === false) return;
    const cutoff = deps.proposals.setting('forget_through', -1);
    let cursor: { updated_at: number; thing_id: string } | undefined;
    let receipts = 0;
    const cancelled = new Set<string>();
    for (;;) {
      if (deps.isVaultUnlocked?.() === false) return;
      const page = deps.mailFacts.listThings({ limit: 200, ...(cursor ? { cursor_before: cursor } : {}) });
      for (const row of page) {
        if (!['purchase', 'bill', 'reservation', 'return_refund'].includes(row.type) || row.updated_at <= cutoff) continue;
        const facts = deps.mailFacts.factsForThing(row.thing_id).filter(fact => deps.proposals.sourceEnabled(`mail:${fact.email.slug}`))
          .sort((a, b) => b.email_at - a.email_at || b.revision - a.revision || a.fact_id.localeCompare(b.fact_id));
        const state = facts.find(fact => typeof fact.variables.state === 'string')?.variables.state;
        if (typeof state === 'string' && ['cancelled', 'returned', 'refund_issued'].includes(state)) { cancelled.add(row.thing_id); continue; }
        for (const fact of facts) {
          if (!deps.proposals.sourceEnabled(`mail:${fact.email.slug}`)) continue;
          receipts += 1; proposeFact(fact, typeof state === 'string' ? state : null);
        }
      }
      deps.proposals.setSetting('receipts_found', receipts);
      deps.proposals.setSetting('likely_assets', deps.proposals.list({ state: 'proposed', kind: 'asset', limit: 10000 }).length);
      await setImmediate();
      if (page.length < 200) break;
      const last = page.at(-1)!; cursor = { updated_at: last.updated_at, thing_id: last.thing_id };
    }
    // Retraction applies only to unaccepted proposals. The owner-confirmed
    // asset has become their record; deleting an email never deletes it.
    for (const proposal of deps.proposals.list({ state: 'proposed', limit: 10000 })) {
      if (proposal.origin !== 'intake') continue;
      const fact_id = proposal.payload.fact_id;
      const fact = typeof fact_id === 'string' ? deps.mailFacts.getFact(fact_id) : null;
      if (!fact || (fact.thing_id && cancelled.has(fact.thing_id))) deps.proposals.outcome(proposal.id, 'retracted', now());
    }
    deps.proposals.setSetting('last_scan_at', now());
  };
  return {
    scan(): Promise<void> { running ??= run().finally(() => { running = undefined; }); return running; },
    async drain(): Promise<void> { await running; },
    /** §4.9 — returns the forgotten proposal ids, whose situations the caller redacts. */
    forget(): string[] {
      return deps.db.transaction(() => {
        const ids = (deps.db.prepare("SELECT id FROM proactive_proposals WHERE origin='intake' AND state!='accepted'").all() as { id: string }[]).map(row => row.id);
        for (const id of ids) deps.proposals.forget(id, now());
        deps.proposals.setSetting('forget_through', now()); deps.proposals.setSetting('receipts_found', 0); deps.proposals.setSetting('likely_assets', 0);
        return ids;
      })();
    },
    sources(): Array<{ id: string; name: string; enabled: boolean; proposals: number }> {
      if (!deps.mailFacts) return [];
      const rows = deps.db.prepare('SELECT DISTINCT email_slug FROM mail_fact_email ORDER BY email_slug').all() as { email_slug: string }[];
      const proposals = deps.proposals.list({ state: 'proposed', limit: 10000 });
      return rows.map(row => { const id = `mail:${row.email_slug}`; return { id, name: row.email_slug, enabled: deps.proposals.sourceEnabled(id),
        proposals: proposals.filter(proposal => proposal.payload.source_account === id).length }; });
    },
    progress() {
      const emails_read = deps.mailFacts ? (deps.db.prepare('SELECT count(*) AS n FROM mail_fact_email WHERE read_at IS NOT NULL').get() as { n: number }).n : 0;
      return { emails_read, receipts_found: deps.proposals.setting('receipts_found', 0), likely_assets: deps.proposals.setting('likely_assets', 0),
        last_scan_at: deps.proposals.setting<number | null>('last_scan_at', null) };
    },
  };
};
export type AssetIntake = ReturnType<typeof createAssetIntake>;
