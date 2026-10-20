import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { assetDateAt, calendarDayMs, dueSpan, evaluateAssetRuleClock, occasionNextDate,
  type AssetRule, type AssetRuleClock, type Commitment, type Occasion, type OccasionInput } from '@recued/contracts';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore, type AssetOccurrence } from '../storage/asset-occurrence-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { handleWorkEntityCommitmentClose } from '../work-entity-crud-handler.js';
import { classifyCommitmentDueStatus } from '../work-entity-due-status-sweep.js';
import type { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import type { AdditionalClockSubjects, ClockReminderSubject } from './asset-reminder-service.js';
import { ruleStatement } from './rule-titles.js';

/** `occasion` is only its id once it was deleted: its record is gone. */
export interface OccasionClockOutcome { occurrence: AssetOccurrence; occasion: Pick<Occasion, 'id'> & Partial<Occasion>; commitment: Commitment; rule?: AssetRule }
export interface OccasionClockDeps {
  db: Database.Database;
  work: WorkEntityStore;
  dispatchers: ReturnType<typeof createWorkEntityDispatchers>;
  timeZone(): string;
  now?(): number;
  isVaultUnlocked?(): boolean;
  /** Owner-local, exact declarations only: annual calendar rules/contact dates. */
  declared?(): readonly OccasionInput[];
  excludedPerson?(id: string): boolean;
  withdraw?(id: string): void;
  outcome?(outcome: OccasionClockOutcome): void | Promise<void>;
  emitRule?(input: { occurrence: AssetOccurrence; occasion: Occasion; rule: AssetRule; clock: AssetRuleClock }): void | Promise<void>;
  /** A cycle ended with no task close to report, once per cycle: a notice, which has
   * no task, when its day has passed or moved, or its occasion or rule is gone; and a
   * task whose occasion is gone, since a close is processed only for an occasion. */
  cycleEnded?(occurrence: AssetOccurrence): void | Promise<void>;
}

/** A private occasion projects only typed clock inputs. No asset record,
 * WorkEntity kind, duplicate commitment state or new delivery lifecycle. */
export const createOccasionClockService = (deps: OccasionClockDeps): AdditionalClockSubjects => {
  const now = deps.now ?? Date.now;
  const history = createProactiveHistoryStore(deps.db, createProactiveProposalStore(deps.db));
  const rows = createAssetOccurrenceStore(deps.db);
  const resolver = createWorkEntityResolver(deps.work);
  let running: Promise<void> | undefined;
  deps.db.exec('CREATE TABLE IF NOT EXISTS proactive_occasion_close_events (id TEXT PRIMARY KEY,payload TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0)');
  const all = (): Occasion[] => {
    const values: Occasion[] = [];
    for (let cursor = ''; ;) { const page = history.walkOccasions(cursor); if (!page.length) return values; values.push(...page); cursor = page.at(-1)!.id; }
  };
  const allowed = (occasion: Occasion): boolean => {
    const on = occasionNextDate(occasion, assetDateAt(now(), deps.timeZone()));
    const span = on ? dueSpan(calendarDayMs(on)!, deps.timeZone()) : undefined;
    return occasion.source_active !== false
    && !occasion.people.some(person => deps.excludedPerson?.(person))
    && !history.suppressed({ id: occasion.id, when: span ? { from: span.start, to: span.end - 1 } : { from: now(), to: now() }, people: occasion.people,
      ...(occasion.where ? { where: occasion.where } : {}), ...(occasion.class_id ? { class_id: occasion.class_id } : {}) });
  };
  const subject = (occasion: Occasion, on: string): ClockReminderSubject => ({ id: occasion.id, name: occasion.title,
    ...(occasion.class_id ? { class_id: occasion.class_id } : {}), status: 'active', audience: 'owner',
    // Occasions involving people are private even if their title is explicit.
    settings: { sensitive: occasion.people.length > 0 }, dates: { next_on: on }, readings: {}, observations: {} });
  const close = async (row: AssetOccurrence): Promise<void> => {
    const commitment = row.commitment_id ? deps.work.readCommitment(row.commitment_id) : null;
    if (commitment?.lifecycle_state === 'pending') await handleWorkEntityCommitmentClose({ store: deps.work, resolver, dispatchers: deps.dispatchers }, { id: commitment.id }, 'cancelled');
    deps.withdraw?.(row.id);
  };
  // `close_processed_at` records the end as it does a processed close. A rule event
  // publishes only a current cycle, so it never follows its end. A task's end comes
  // after `close` has settled the task.
  const endCycle = async (row: AssetOccurrence): Promise<void> => {
    if (row.close_processed_at !== null || !deps.cycleEnded) return;
    await deps.cycleEnded(row); rows.markCloseProcessed(row.id, now());
  };
  const read: AdditionalClockSubjects['read'] = row => {
    if (row.subject_kind !== 'occasion') return null;
    const occasion = history.occasion(row.asset_id); const rule = occasion?.rules.find(rule => rule.id === row.rule_id);
    if (!occasion || !allowed(occasion) || occasion.muted || !rule?.enabled || rule.muted) return null;
    if (Boolean(row.commitment_id) !== (rule.reaction.occurrence === 'action')) return null;
    const today = assetDateAt(now(), deps.timeZone());
    const on = occasionNextDate(occasion, today);
    if (!on || on !== row.cycle) return null;
    const value = subject(occasion, on); const clock = evaluateAssetRuleClock(value, rule, { now: now(), timeZone: deps.timeZone() });
    if (!clock.active || clock.due_on && clock.due_on < today) return null;
    return { subject: value, rule, due: clock.due_on, route: `#yours/occasions/occasion/${encodeURIComponent(occasion.id)}` };
  };
  const queueOutcome = (row: AssetOccurrence, occasion: OccasionClockOutcome['occasion']): void => {
    const commitment = row.commitment_id ? deps.work.readCommitment(row.commitment_id) : null;
    if (!commitment || commitment.lifecycle_state === 'pending' || row.close_processed_at !== null) return;
    deps.db.transaction(() => {
      const rule = occasion.rules?.find(rule => rule.id === row.rule_id);
      deps.db.prepare('INSERT OR IGNORE INTO proactive_occasion_close_events(id,payload) VALUES(?,?)')
        .run(row.id, JSON.stringify({ occurrence: row, occasion, commitment, ...(rule ? { rule } : {}) }));
      rows.markCloseProcessed(row.id, now());
    })();
  };
  const run = async (): Promise<void> => {
    if (deps.isVaultUnlocked?.() === false) return;
    if (deps.declared) {
      const active = new Set<string>();
      for (const input of deps.declared()) {
        if (!input.id || !input.source) throw new Error('A declared occasion needs its source identity');
        active.add(input.id); if (history.occasionDeleted(input.id)) continue;
        const old = history.occasion(input.id);
        if (!old) history.saveOccasion({ ...input, source_active: true }, now());
        else {
          const value = old.source_pinned ? { ...old, source_active: true,
            ...(old.source_next_on !== undefined ? { source: input.source, source_next_on: input.source_next_on } : {}) } : { ...old, title: input.title,
            month_day: input.month_day, people: input.people, where: input.where, sphere: input.sphere, source: input.source, source_next_on: input.source_next_on, source_active: true };
          if (JSON.stringify(value) !== JSON.stringify(old)) history.saveOccasion(value, now());
        }
      }
      for (const occasion of all()) if (occasion.source && occasion.source_active !== false && !active.has(occasion.id))
        history.saveOccasion({ ...occasion, source_active: false }, now());
    }
    const seen = new Set<string>(); const today = assetDateAt(now(), deps.timeZone());
    for (const occasion of all()) {
      seen.add(occasion.id); const previous = rows.byOccasion(occasion.id);
      for (const row of previous) {
        const rule = occasion.rules.find(rule => rule.id === row.rule_id);
        const nextOn = occasionNextDate(occasion, today);
        if (!allowed(occasion) || !rule?.enabled || Boolean(row.commitment_id) !== (rule.reaction.occurrence === 'action') || row.cycle >= today && row.cycle !== nextOn) await close(row);
        const commitment = row.commitment_id ? deps.work.readCommitment(row.commitment_id) : null;
        if (commitment?.lifecycle_state === 'pending' && commitment.expiry_policy === 'strict_expire'
          && classifyCommitmentDueStatus(commitment, now(), undefined, deps.timeZone()) === 'overdue') {
          const at = now(); const expired = deps.work.writeCommitment({ ...commitment, lifecycle_state: 'expired',
            lifecycle_changed_at: at, due_status: 'overdue', due_status_changed_at: at, state_changed_at: at }, at);
          deps.dispatchers.ruleCommitmentWritten(expired, commitment);
        }
        queueOutcome(row, occasion);
        if (!read(row) || commitment && commitment.lifecycle_state !== 'pending') deps.withdraw?.(row.id);
        if (!row.commitment_id && row.close_processed_at === null
          && (!allowed(occasion) || !rule?.enabled || rule.reaction.occurrence !== 'notice' || row.cycle !== nextOn)) await endCycle(row);
      }
      if (!allowed(occasion)) continue;
      const on = occasionNextDate(occasion, today); if (!on) continue;
      for (const rule of occasion.rules.filter(rule => rule.enabled)) {
        const clock = evaluateAssetRuleClock(subject(occasion, on), rule, { now: now(), timeZone: deps.timeZone() });
        if (!clock.active || !clock.due_on || clock.due_on < today) continue;
        const id = `occurrence-${createHash('sha256').update(JSON.stringify(['occasion', occasion.id, rule.id, clock.cycle, rule.reaction.occurrence === 'action' ? 'action' : 'notice'])).digest('hex')}`;
        const old = rows.get(id); const statement = ruleStatement(rule, occasion.title);
        let created: Commitment | undefined;
        deps.db.transaction(() => {
          let commitment_id = old?.commitment_id ?? null;
          if (!old && rule.reaction.occurrence === 'action') {
            const result = deps.work.ensureCommitment({ id: `commitment-${id}`, source_id: 'recued.commitment',
              direction: 'outbound', statement, derivation: 'rule_emitted', expiry_policy: 'strict_expire',
              promised_for_at: calendarDayMs(clock.due_on!)!, source_extension_blob: { occurrence_id: id },
            }, now());
            commitment_id = result.commitment.id; if (result.created) created = result.commitment;
          }
          rows.ensure({ id, asset_id: occasion.id, subject_kind: 'occasion', rule_id: rule.id, cycle: clock.cycle,
            commitment_id, question: false, trigger_kind: 'rule', created_at: old?.created_at ?? now() });
          if (rule.reaction.emit) rows.queueRuleEvent(id, now());
          const commitment = commitment_id ? deps.work.readCommitment(commitment_id) : null;
          if (commitment?.lifecycle_state === 'pending' && (commitment.promised_for_at !== calendarDayMs(clock.due_on!)! || commitment.statement !== statement)) {
            const updated = deps.work.writeCommitment({ ...commitment, statement,
              promised_for_at: calendarDayMs(clock.due_on!)! }, now());
            if (!created) deps.dispatchers.ruleCommitmentWritten(updated, commitment);
          }
        })();
        if (created) deps.dispatchers.ruleCommitmentWritten(created);
      }
    }
    // A deleted occasion's task close is counted too (`clock.closure`), under the
    // default class: the cycle's end marks the row processed, so it was never reported.
    for (const row of rows.all()) if (row.subject_kind === 'occasion' && !seen.has(row.asset_id)) { await close(row); queueOutcome(row, { id: row.asset_id }); await endCycle(row); }
    if (deps.emitRule) for (const pending of rows.pendingRuleEvents()) {
      const row = rows.get(pending.occurrence_id)!; if (row.subject_kind !== 'occasion') continue;
      const occasion = history.occasion(row.asset_id); const current = read(row);
      if (occasion && current?.rule.reaction.emit) await deps.emitRule({ occurrence: row, occasion, rule: current.rule,
        clock: evaluateAssetRuleClock(current.subject, current.rule, { now: now(), timeZone: deps.timeZone() }) });
      rows.acknowledgeRuleEvent(row.id);
    }
    if (deps.outcome) for (const row of deps.db.prepare('SELECT id,payload FROM proactive_occasion_close_events WHERE delivered=0 ORDER BY id').all() as { id: string; payload: string }[]) {
      await deps.outcome(JSON.parse(row.payload)); deps.db.prepare('UPDATE proactive_occasion_close_events SET delivered=1 WHERE id=?').run(row.id);
    }
  };
  return {
    read,
    tick() { return running ??= run().finally(() => { running = undefined; }); },
    hasEnabledClock: () => all().some(occasion => allowed(occasion) && occasion.rules.some(rule => rule.enabled && rule.reaction.notify)),
    mute(row, at) {
      const occasion = history.occasion(row.asset_id); if (!occasion) return;
      history.saveOccasion({ ...occasion, source_pinned: true,
        rules: occasion.rules.map(rule => rule.id === row.rule_id ? { ...rule, muted: true, pinned: true } : rule) }, at);
    },
    async complete(row, answered_at, owner_action = false) {
      if (!Number.isSafeInteger(answered_at) || answered_at > now()) throw new Error('Invalid occasion completion time');
      const current = rows.get(row.id); const occasion = current ? history.occasion(current.asset_id) : null;
      if (!current || current.subject_kind !== 'occasion' || !occasion || !allowed(occasion) || !current.commitment_id) return;
      const commitment = deps.work.readCommitment(current.commitment_id);
      if (commitment?.lifecycle_state !== 'pending') return;
      rows.recordCompletion(row.id, answered_at, null, true, owner_action);
      await handleWorkEntityCommitmentClose({ store: deps.work, resolver, dispatchers: deps.dispatchers }, { id: commitment.id }, 'fulfilled');
      queueOutcome(current, occasion); deps.withdraw?.(row.id);
    },
  };
};
