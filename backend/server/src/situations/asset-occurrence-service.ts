import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  assetDateAt, calendarDayMs, COMMITMENT_STATEMENT_MAX, evaluateAssetRuleClock,
  type Asset, type AssetRule, type AssetRuleClock, type Commitment,
} from '@recued/contracts';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore, type AssetOccurrence } from '../storage/asset-occurrence-store.js';
import { createWorkEntityEdgeStore, ensureWorkEntityEdgeSchema } from '../storage/work-entity-edge-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { handleWorkEntityCommitmentClose } from '../work-entity-crud-handler.js';
import { classifyCommitmentDueStatus } from '../work-entity-due-status-sweep.js';
import type { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { assetIntervalCycle, assetObjectiveCycle, assetOccurrenceClock, objectiveCycleNumber } from './asset-interval-cycle.js';
import { createAssetClockStore } from '../storage/asset-clock-store.js';
import { assetClockRows, assetPlaceLabels, assetRuleTimings, isTravelDocument } from './asset-rule-timing.js';

const occurrenceId = (asset: string, rule: string, cycle: string): string =>
  `occurrence-${createHash('sha256').update(JSON.stringify([asset, rule, cycle])).digest('hex')}`;
const live = (asset: Asset | null): asset is Asset & { status: 'active' | 'lent' } => asset !== null && asset.deleted_at == null && ['active', 'lent'].includes(asset.status);
/** A long rule title and asset name are shortened to the commitment's limit
 * rather than failing the clock: a statement the store refuses stops nothing else. */
const statementFor = (rule: AssetRule, asset: Asset, question: boolean): string => {
  const text = question ? `Last done date needed: ${rule.title} · ${asset.name}` : `${rule.title} · ${asset.name}`;
  return text.length <= COMMITMENT_STATEMENT_MAX ? text : `${text.slice(0, COMMITMENT_STATEMENT_MAX - 1)}…`;
};
export interface AssetOccurrenceServiceDeps {
  db: Database.Database;
  work: WorkEntityStore;
  dispatchers: ReturnType<typeof createWorkEntityDispatchers>;
  timeZone: () => string;
  now?: () => number;
  isVaultUnlocked?: () => boolean;
  withdraw?: (occurrence_id: string) => Promise<void>;
  /** Idempotent downstream rule-event sink, keyed by occurrence id. */
  emitRule?: (input: { occurrence: AssetOccurrence; asset: Asset; rule: AssetRule; clock: AssetRuleClock }) => Promise<void>;
  outcome?: (input: { occurrence: AssetOccurrence; commitment: Commitment; asset: Asset; rule?: AssetRule }) => void | Promise<void>;
  /** A cycle ended with no task close to report, once per cycle: a notice, which has
   * no task, when its day has passed, its clock has left it, or its asset or rule is
   * gone; and a task whose asset is gone, since a close is processed only while the
   * asset is live. */
  cycleEnded?: (occurrence: AssetOccurrence) => void | Promise<void>;
  log?(error: unknown): void;
}
export interface AssetOccurrenceService {
  reconcileAsset(asset_id: string): Promise<void>;
  retireAsset(asset_id: string): Promise<void>;
  tick(): Promise<void>;
  /** Owner action, using its original durable answer time on recovery. */
  completeOccurrence(input: { occurrence_id: string; answered_at: number; actual_time_unknown?: boolean; owner_action?: boolean }): Promise<void>;
  confirmCompletion(input: { occurrence_id: string; on: string; reading?: { value: number; unit: string } }): Promise<void>;
  /** Confirmed evidence records its REAL date, including after strict lapse. */
  recordLastDone(input: { asset_id: string; rule_id: string; on: string; evidence_ref: string; confirmed: boolean }): Promise<void>;
  recordRenewal(input: { asset_id: string; rule_id: string; on: string; evidence_ref: string; confirmed: boolean }): Promise<void>;
}

export const createAssetOccurrenceService = (deps: AssetOccurrenceServiceDeps): AssetOccurrenceService => {
  const now = deps.now ?? Date.now;
  const rows = createAssetOccurrenceStore(deps.db);
  const clockIndex = createAssetClockStore(deps.db);
  ensureWorkEntityEdgeSchema(deps.db);
  const edges = createWorkEntityEdgeStore(deps.db);
  const resolver = createWorkEntityResolver(deps.work);
  const running = new Map<string, Promise<void>>();
  const identity = (asset: string, rule: AssetRule, cycle: string): string => {
    const base = occurrenceId(asset, rule.id, cycle); const old = rows.get(base);
    return old && Boolean(old.commitment_id) !== (rule.reaction.occurrence === 'action')
      ? `${base}-${rule.reaction.occurrence === 'action' ? 'action' : 'notice'}` : base;
  };
  const log = deps.log ?? (error => console.warn('[asset-occurrences] an asset’s clocks will retry', error));
  let ticking = false;
  const close = async (row: AssetOccurrence, to: 'fulfilled' | 'cancelled'): Promise<void> => {
    if (!row.commitment_id) { await deps.withdraw?.(row.id); return; }
    const commitment = deps.work.readCommitment(row.commitment_id);
    if (commitment?.lifecycle_state === 'pending') await handleWorkEntityCommitmentClose({ store: deps.work, resolver, dispatchers: deps.dispatchers }, { id: commitment.id }, to);
    await deps.withdraw?.(row.id);
  };
  // `close_processed_at` records the end as it does a processed close. An end waits
  // for its start: a rule event not yet published would follow it. A task's end comes
  // after `close` has settled the task.
  const endCycle = async (row: AssetOccurrence): Promise<void> => {
    if (row.close_processed_at !== null || !deps.cycleEnded || rows.undelivered(row.id)) return;
    await deps.cycleEnded(row); rows.markCloseProcessed(row.id, now());
  };
  // The clock of a disabled rule stands for no cycle, so turning the rule off ends it too.
  const noticeOver = (row: AssetOccurrence, asset: Asset): boolean => {
    const rule = asset.rules.find(item => item.id === row.rule_id);
    if (!rule || rule.reaction.occurrence !== 'notice') return true;
    const clock = assetOccurrenceClock({ asset, rule, row, now: now(), timeZone: deps.timeZone(),
      ...(rule.when.kind === 'objective' ? { readings: deps.work.assetReadingHistory(asset.id, rule.when.field) } : {}) });
    return !clock || clock.due_on !== null && clock.due_on < assetDateAt(now(), deps.timeZone());
  };
  const link = (row: AssetOccurrence, at: number): void => {
    if (!row.commitment_id) return;
    edges.reconcileRecordEdges({ source_id: 'recued.commitment', source_record_id: row.commitment_id,
      owner_kind: 'commitment', owner_local_id: row.commitment_id,
      desired: [{ local_field: 'asset', target_kind: 'asset', target_local_id: row.asset_id,
        target_scoped_key: `work:asset:local:${row.asset_id}` }] }, at);
  };
  const materialize = (asset: Asset, rule: AssetRule, clock: AssetRuleClock, at: number, trigger_kind: AssetOccurrence['trigger_kind'] = 'rule'): AssetOccurrence => {
    const id = identity(asset.id, rule, clock.cycle);
    const existing = rows.get(id);
    if (existing) { link(existing, at); if (rule.reaction.emit) rows.queueRuleEvent(existing.id, at); return existing; }
    let created: Commitment | undefined;
    const row = deps.db.transaction(() => {
      let commitment_id: string | null = null;
      if (rule.reaction.occurrence === 'action') {
        const result = deps.work.ensureCommitment({ id: `commitment-${id}`, source_id: 'recued.commitment', direction: 'outbound',
          statement: statementFor(rule, asset, clock.question),
          derivation: 'rule_emitted', expiry_policy: rule.expiry_policy,
          ...(clock.due_on ? { promised_for_at: calendarDayMs(clock.due_on)! } : {}),
          ...(asset.holder_contact ? { counterparty_contact_id: asset.holder_contact } : {}),
          source_extension_blob: { occurrence_id: id },
        }, at);
        commitment_id = result.commitment.id;
        if (result.created) created = result.commitment;
      }
      const saved = rows.ensure({ id, asset_id: asset.id, rule_id: rule.id, cycle: clock.cycle,
        commitment_id, question: clock.question, trigger_kind, created_at: at });
      link(saved, at);
      if (rule.reaction.emit) rows.queueRuleEvent(id, at);
      return saved;
    })();
    if (created) deps.dispatchers.ruleCommitmentWritten(created);
    return row;
  };
  const processClose = (row: AssetOccurrence, asset: Asset, rule?: AssetRule): Asset => {
    if (!row.commitment_id || row.close_processed_at !== null) return asset;
    const commitment = deps.work.readCommitment(row.commitment_id);
    if (!commitment || commitment.lifecycle_state === 'pending') return asset;
    return deps.db.transaction(() => {
      let next: Asset = asset;
      // A recipe, an MCP client or another non-owner close fulfilled it without
      // saying when. Keep the last-done fact and ask the owner for the actual date
      // or reading before the clock advances, as for a household Done.
      if (commitment.lifecycle_state === 'fulfilled' && rule && !row.question && rows.completion(row.id) === null
        && (rule.when.kind === 'interval' || (rule.when.kind === 'objective' && rule.when.mode === 'usage' && rule.when.every))) {
        rows.recordCompletion(row.id, commitment.lifecycle_changed_at, null, false, false);
      }
      if (commitment.lifecycle_state === 'fulfilled' && rule && !row.question && rows.completion(row.id)?.known !== false
        && rows.completion(row.id)?.owner_action === true) {
        const completion = rows.completion(row.id);
        const answeredAt = completion?.answered_at ?? commitment.lifecycle_changed_at;
        const when = rule.when;
        if (when.kind === 'interval') {
          const on = completion?.confirmed_on ?? assetDateAt(answeredAt, deps.timeZone());
          // Preserve a more recent confirmed last-done (late evidence may have
          // already advanced it). The owner's tap authorizes this fact update.
          if (!asset.dates[when.field] || asset.dates[when.field]! < on) next = deps.work.writeAsset({ id: asset.id,
            source_id: asset.source_id, source: { kind: 'owner', ref: `completion:${commitment.id}` }, dates: { [when.field]: on } }, now());
        } else if (when.kind === 'objective' && when.mode === 'usage' && when.every) {
          const reading = completion ? completion.reading : deps.work.assetReadingAt(asset.id, when.field, answeredAt);
          if (reading && reading.unit === when.unit && objectiveCycleNumber(rule, row.cycle) !== undefined) {
            const target = reading.value + (when.direction === 'rising' ? 1 : -1) * when.every;
            if (!Number.isFinite(target)) throw new Error('The next usage target is out of range');
            const rules = asset.rules.map(item => item.id === rule.id ? { ...item, when: { ...when, target } } : item);
            next = deps.work.writeAsset({ id: asset.id, source_id: asset.source_id,
              source: { kind: 'owner', ref: `completion:${commitment.id}` }, rules }, now());
          }
        }
      }
      rows.queueCloseOutcome({ occurrence: row, commitment, asset: next, ...(rule ? { rule } : {}) });
      rows.markCloseProcessed(row.id, now());
      return next;
    })();
  };
  // §6.3 — store the act-by a situation read selects by. It runs in one
  // synchronous step from a fresh read, so a write during the reconcile's
  // awaits is either in it or leaves the asset dirty.
  const index = (id: string): void => {
    const asset = deps.work.readAsset(id);
    if (!asset || asset.deleted_at != null || !['live', 'stale_unreachable'].includes(asset.sync_state)) { clockIndex.forget(id); return; }
    const at = now(); const timeZone = deps.timeZone();
    const tags = { zone: timeZone, class_id: asset.class_id ?? null, travel_document: isTravelDocument(asset), places: assetPlaceLabels(asset) };
    if (!live(asset)) { clockIndex.write(id, [], tags, at); return; }
    const occurrences = rows.byAsset(id);
    const view = (commitments: boolean) => assetRuleTimings(asset, { work: deps.work, occurrences, commitments, now: at, timeZone });
    clockIndex.write(id, assetClockRows(asset, view(true), view(false), at), tags, at);
  };
  // A task an asset's retirement or deletion closed, or one the owner closed just
  // before, is a close like any other: it is counted (`clock.closure`) and resolves its
  // situation. `processClose` never runs for an asset that left, and the cycle's end
  // marks the row processed, so these closes were never reported. Only the facts a
  // close would advance stay as they are: the asset keeps no clocks now.
  const queueLeftClose = (row: AssetOccurrence, asset: Asset | null): void => {
    if (!asset || !row.commitment_id || rows.get(row.id)?.close_processed_at != null) return;
    const commitment = deps.work.readCommitment(row.commitment_id);
    if (!commitment || commitment.lifecycle_state === 'pending') return;
    const rule = asset.rules.find(rule => rule.id === row.rule_id);
    rows.queueCloseOutcome({ occurrence: row, commitment, asset, ...(rule ? { rule } : {}) });
  };
  const reconcile = async (id: string): Promise<void> => {
    let asset = deps.work.readAssetEffective(id);
    const previous = rows.byAsset(id);
    if (!live(asset)) {
      for (const row of previous) { await close(row, 'cancelled'); queueLeftClose(row, asset); await endCycle(row); }
      index(id);
      return;
    }
    const at = now();
    for (const row of previous) {
      const before: Asset = asset;
      asset = processClose(row, asset, asset.rules.find(rule => rule.id === row.rule_id));
      if (asset !== before) deps.dispatchers.ruleAssetWritten(asset, before);
    }
    const enabled = new Map(asset.rules.filter(rule => rule.enabled).map(rule => [rule.id, rule]));
    for (const row of previous) {
      if (row.trigger_kind === 'rule' && !enabled.has(row.rule_id)) await close(row, 'cancelled');
      else if (row.commitment_id && deps.work.readCommitment(row.commitment_id)?.lifecycle_state !== 'pending') await deps.withdraw?.(row.id);
    }
    edges.reconcileRecordEdges({ source_id: asset.source_id, source_record_id: asset.id, owner_kind: 'asset', owner_local_id: asset.id,
      desired: asset.belongs_to ? [{ local_field: 'belongs_to', target_kind: 'asset', target_local_id: asset.belongs_to,
        target_scoped_key: `work:asset:local:${asset.belongs_to}` }] : [] }, at);
    for (const rule of enabled.values()) {
      const history = rule.when.kind === 'objective' ? deps.work.assetReadingHistory(asset.id, rule.when.field) : [];
      const priorRows = previous.filter(row => row.rule_id === rule.id && row.trigger_kind === 'rule');
      const objectiveCycle = assetObjectiveCycle({ rule, occurrences: priorRows, readCommitment: deps.work.readCommitment });
      let clock = evaluateAssetRuleClock(asset, rule, { now: at, timeZone: deps.timeZone(), readings: history,
        ...(objectiveCycle ? { cycle: objectiveCycle } : {}) });
      const latest = priorRows.find(row => Boolean(row.commitment_id) === (rule.reaction.occurrence === 'action'));
      if (rule.when.kind === 'condition' || (rule.when.kind === 'objective' && rule.when.mode === 'condition')) {
        if (clock.recovered) {
          for (const row of priorRows) { await close(row, 'fulfilled'); rows.rearm(row.id, at); }
          continue;
        }
        // §4.10 — the owner marked this state expected, so an open one was a false alarm.
        // It is not re-armed: as for any acknowledged condition, only a recovery is.
        if (clock.expected) { for (const row of priorRows) await close(row, 'cancelled'); continue; }
        if (!clock.active) continue;
        if (latest && latest.rearmed_at === null) {
          // An acknowledged condition stays acknowledged until recovery.
          if (!latest.commitment_id || deps.work.readCommitment(latest.commitment_id)?.lifecycle_state !== 'pending') continue;
          clock = { ...clock, cycle: latest.cycle };
        }
      }
      if (rule.when.kind === 'interval' && asset.dates[rule.when.field]) {
        const cycle = assetIntervalCycle({ asset, rule, occurrences: priorRows, readCommitment: deps.work.readCommitment, now: at, timeZone: deps.timeZone() });
        clock = evaluateAssetRuleClock(asset, rule, { now: at, timeZone: deps.timeZone(), cycle });
      }
      const targetId = identity(asset.id, rule, clock.cycle);
      // §5.1 — a later expiry with no reminder due yet renewed the open obligation,
      // which closes as done; a date that only moved within its reminders re-dates
      // it, and the replaced occurrence is retired.
      const renewed = (row: AssetOccurrence) => rule.when.kind === 'expiry' && !clock.active && !clock.question
        && calendarDayMs(row.cycle) !== null && calendarDayMs(clock.cycle) !== null && clock.cycle > row.cycle;
      for (const row of priorRows) if (row.id !== targetId && row.commitment_id && deps.work.readCommitment(row.commitment_id)?.lifecycle_state === 'pending') {
        await close(row, renewed(row) ? 'fulfilled' : 'cancelled');
      }
      const current = rows.get(targetId);
      if (!clock.active && !clock.question && !current) continue;
      const row = materialize(asset, rule, clock, at);
      if (row.commitment_id) {
        const existing = deps.work.readCommitment(row.commitment_id);
        if (existing?.lifecycle_state === 'pending') {
          let due = clock.due_on ? calendarDayMs(clock.due_on)! : undefined;
          if (rule.when.kind === 'objective' && rule.when.mode === 'usage') {
            const reading = asset.readings[rule.when.field]; const sign = rule.when.direction === 'rising' ? 1 : -1;
            if (reading && (reading.value - rule.when.target) * sign >= 0 && existing.promised_for_at !== undefined && due !== undefined) due = Math.min(due, existing.promised_for_at);
          }
          const statement = statementFor(rule, asset, clock.question);
          if (existing.promised_for_at !== due || existing.statement !== statement || existing.expiry_policy !== rule.expiry_policy) {
            const due_status = classifyCommitmentDueStatus({ ...existing, promised_for_at: due }, at, undefined, deps.timeZone());
            const updated = deps.work.writeCommitment({ ...existing, promised_for_at: due, statement, expiry_policy: rule.expiry_policy, due_status,
              ...(due_status !== existing.due_status ? { state_changed_at: at, due_status_changed_at: at } : {}) }, at);
            deps.dispatchers.ruleCommitmentWritten(updated, existing);
          }
        }
      }
    }
    if (deps.cycleEnded) for (const row of previous) if (!row.commitment_id && row.close_processed_at === null && noticeOver(row, asset)) await endCycle(row);
    index(id);
  };
  const reconcileAsset: AssetOccurrenceService['reconcileAsset'] = id => {
    const previous = running.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => reconcile(id)); running.set(id, next);
    void next.finally(() => { if (running.get(id) === next) running.delete(id); }).catch(() => {});
    return next;
  };
  const retireAsset: AssetOccurrenceService['retireAsset'] = async id => {
    await reconcileAsset(id);
    const parent = deps.work.readAsset(id);
    if (!parent || parent.deleted_at != null) { edges.deleteForTarget('asset', id); edges.tombstoneForRecord('recued.asset', id, now()); return; }
    if (live(parent)) return;
    for (const child of deps.work.listAssetChildren(id)) {
      if (!live(child)) continue;
      if (child.retirement === 'part') {
        const retired = deps.work.writeAsset({ id: child.id, source_id: child.source_id, source: { kind: 'owner', ref: `retirement:${id}` }, status: parent.status }, now());
        deps.dispatchers.ruleAssetWritten(retired, child);
        await retireAsset(child.id);
      } else {
        const clocks = child.rules.filter(rule => rule.enabled && rule.when.kind === 'expiry')
          .map(rule => ({ rule, clock: evaluateAssetRuleClock(child, rule, { now: now(), timeZone: deps.timeZone() }) }))
          .filter(plan => plan.clock.due_on !== null).sort((a, b) => a.clock.due_on!.localeCompare(b.clock.due_on!));
        const due = clocks[0]?.clock.due_on ?? assetDateAt(now(), deps.timeZone());
        const today = assetDateAt(now(), deps.timeZone());
        const daysUntilNotice = Math.max(0, (calendarDayMs(due)! - calendarDayMs(today)!) / 86_400_000);
        const schedule = clocks[0]?.rule.schedule ?? { before: [], on_day: true };
        const ruleId = `retirement_${createHash('sha256').update(JSON.stringify([id, parent.status, parent.field_sources.status?.at ?? parent.created_at])).digest('hex').slice(0, 24)}`;
        const rule: AssetRule = { id: ruleId,
          title: `Cancel or transfer ${child.name} after ${parent.name} was ${parent.status}`, enabled: true, muted: false, pinned: false,
          when: { kind: 'expiry', field: 'cancel_or_transfer_on' }, consequence: 'floor', reaction: { notify: true, occurrence: 'action', emit: false },
          expiry_policy: 'escalate_overdue', schedule: { ...schedule,
            before: [...schedule.before, { amount: daysUntilNotice, unit: 'days' }],
            after: schedule.after ?? { amount: 1, unit: 'weeks' } } };
        if (!child.rules.some(item => item.id === ruleId)) {
          const updated = deps.work.writeAsset({ id: child.id, source_id: child.source_id, source: { kind: 'owner', ref: `retirement:${id}` },
            dates: { cancel_or_transfer_on: due }, rules: [...child.rules, rule] }, now());
          deps.dispatchers.ruleAssetWritten(updated, child);
        }
        // This consequence is visible as an editable rule on the contract,
        // including its actual notice date and reminder schedule.
        await reconcileAsset(child.id);
      }
    }
    deps.work.acknowledgeAssetRetirement(id);
  };
  return {
    reconcileAsset, retireAsset,
    async completeOccurrence(input) {
      if (!Number.isFinite(input.answered_at) || input.answered_at > now()) throw new Error('Invalid completion time');
      const row = rows.get(input.occurrence_id);
      const asset = row ? deps.work.readAssetEffective(row.asset_id) : null;
      const rule = asset?.rules.find(item => item.id === row?.rule_id);
      if (!row?.commitment_id || row.question || !live(asset) || !rule?.enabled) return;
      const commitment = deps.work.readCommitment(row.commitment_id);
      if (!commitment || !['pending', 'fulfilled'].includes(commitment.lifecycle_state)) return;
      const usage = rule.when.kind === 'objective' && rule.when.mode === 'usage';
      const reading = usage
        ? deps.work.assetReadingAt(asset.id, rule.when.field, input.answered_at) : null;
      // Save the evidence before a semantic close or any downstream network
      // withdrawal. A retry cannot use tomorrow's odometer for today's service.
      const known = input.owner_action === true && !input.actual_time_unknown && (!usage || reading !== null);
      rows.recordCompletion(row.id, input.answered_at, input.actual_time_unknown ? null : reading, known, input.owner_action === true);
      if (commitment.lifecycle_state === 'pending') await close(row, 'fulfilled');
      await reconcileAsset(asset.id);
    },
    async confirmCompletion(input) {
      const row = rows.get(input.occurrence_id); const receipt = row ? rows.completion(row.id) : null;
      const asset = row ? deps.work.readAsset(row.asset_id) : null; const rule = asset?.rules.find(rule => rule.id === row?.rule_id);
      if (!row || row.subject_kind === 'occasion' || !live(asset) || !rule || !receipt) throw new Error('The original completed clock is unavailable');
      if (receipt.known !== false && receipt.owner_action === true) return;
      if (calendarDayMs(input.on) === null || input.on > assetDateAt(now(), deps.timeZone())) throw new Error('Choose the actual service date');
      let next: Asset = asset;
      deps.db.transaction(() => {
        if (rule.when.kind === 'interval') {
          if (!asset.dates[rule.when.field] || asset.dates[rule.when.field]! < input.on) next = deps.work.writeAsset({ id: asset.id, source_id: asset.source_id,
            source: { kind: 'owner', ref: `confirmed-completion:${row.id}` }, dates: { [rule.when.field]: input.on } }, now());
        } else if (rule.when.kind === 'objective' && rule.when.mode === 'usage' && rule.when.every) {
          const when = rule.when; const reading = input.reading;
          if (!reading || !Number.isFinite(reading.value) || reading.unit !== when.unit || objectiveCycleNumber(rule, row.cycle) === undefined) throw new Error('Confirm the actual service reading in the rule’s unit; a changed rule needs separate review');
          const target = reading.value + (when.direction === 'rising' ? 1 : -1) * when.every!;
          if (!Number.isFinite(target)) throw new Error('The next usage target is out of range');
          next = deps.work.writeAsset({ id: asset.id, source_id: asset.source_id, source: { kind: 'owner', ref: `confirmed-completion:${row.id}` },
            rules: asset.rules.map(item => item.id === rule.id ? { ...item, when: { ...when, target } } : item) }, now());
        } else throw new Error('This clock does not use a service date or reading');
        rows.confirmCompletion(row.id, input.on, input.reading ? { ...input.reading, as_of: calendarDayMs(input.on)!, evidence: [{ collection: 'asset', id: asset.id }] } : null);
      })();
      if (JSON.stringify(asset) !== JSON.stringify(next)) deps.dispatchers.ruleAssetWritten(next, asset);
      await reconcileAsset(asset.id);
    },
    async tick() {
      if (ticking || deps.isVaultUnlocked?.() === false) return;
      ticking = true;
      try {
        // One asset's failure is logged and retried next tick; it never stops another's clocks.
        for (const job of deps.work.pendingAssetRetirements()) await retireAsset(job.asset_id).catch(log);
        const seen = new Set<string>();
        for (let cursor = ''; ;) {
          const page = deps.work.walkByAssetId(cursor, 100); if (!page.length) break;
          for (const asset of page) { seen.add(asset.id); await reconcileAsset(asset.id).catch(log); }
          cursor = page.at(-1)!.id;
        }
        for (const row of rows.all()) if (row.subject_kind !== 'occasion' && !seen.has(row.asset_id)) { await close(row, 'cancelled'); await endCycle(row); }
        for (const pending of rows.pendingRuleEvents()) {
          if (!deps.emitRule) continue;
          const occurrence = rows.get(pending.occurrence_id)!;
          if (occurrence.subject_kind === 'occasion') continue;
          const asset = deps.work.readAssetEffective(occurrence.asset_id);
          const rule = asset?.rules.find(rule => rule.id === occurrence.rule_id);
          if (!live(asset) || !rule?.enabled || !rule.reaction.emit) { rows.acknowledgeRuleEvent(occurrence.id); continue; }
          const clock = evaluateAssetRuleClock(asset, rule, { now: now(), timeZone: deps.timeZone(),
            ...(rule.when.kind === 'objective' ? { readings: deps.work.assetReadingHistory(asset.id, rule.when.field) } : {}) });
          await deps.emitRule({ occurrence, asset, rule, clock }); rows.acknowledgeRuleEvent(occurrence.id);
        }
        for (const outcome of rows.pendingCloseOutcomes()) {
          if (!deps.outcome) continue;
          await deps.outcome(outcome); rows.acknowledgeCloseOutcome(outcome.occurrence.id);
        }
      } finally { ticking = false; }
    },
    async recordLastDone(input) {
      if (!input.confirmed || !input.evidence_ref.trim() || calendarDayMs(input.on) === null) throw new Error('Last-done evidence requires owner confirmation and a real date');
      const asset = deps.work.readAsset(input.asset_id);
      const rule = asset?.rules.find(rule => rule.id === input.rule_id);
      if (!live(asset) || rule?.when.kind !== 'interval') throw new Error('No live interval rule');
      if (input.on > assetDateAt(now(), deps.timeZone())) throw new Error('A last-done date cannot be in the future');
      rows.recordService({ id: createHash('sha256').update(JSON.stringify([asset.id, rule.id, input.on, input.evidence_ref])).digest('hex'),
        asset_id: asset.id, rule_id: rule.id, on: input.on, evidence_ref: input.evidence_ref, at: now() });
      if (asset.dates[rule.when.field] && input.on < asset.dates[rule.when.field]!) return;
      // Approval is an owner action; retain the evidence identity in provenance.
      const updated = deps.work.writeAsset({ id: asset.id, source_id: asset.source_id, source: { kind: 'owner', ref: input.evidence_ref }, dates: { [rule.when.field]: input.on } }, now());
      deps.dispatchers.ruleAssetWritten(updated, asset);
      for (const row of rows.byAsset(asset.id).filter(row => row.rule_id === rule.id && !row.cycle.startsWith(`${input.on}:`))) {
        if (row.commitment_id && deps.work.readCommitment(row.commitment_id)?.lifecycle_state === 'pending') await close(row, row.question ? 'cancelled' : 'fulfilled');
        const closed = row.commitment_id ? deps.work.readCommitment(row.commitment_id) : null;
        if (closed && closed.lifecycle_state !== 'pending' && row.close_processed_at === null) {
          deps.db.transaction(() => {
            rows.queueCloseOutcome({ occurrence: row, commitment: closed, asset: deps.work.readAsset(asset.id)!, rule });
            rows.markCloseProcessed(row.id, now());
          })();
        }
      }
      await reconcileAsset(asset.id);
    },
    async recordRenewal(input) {
      if (!input.confirmed || !input.evidence_ref.trim() || calendarDayMs(input.on) === null) throw new Error('Renewal evidence requires owner confirmation and a real date');
      const asset = deps.work.readAsset(input.asset_id); const rule = asset?.rules.find(rule => rule.id === input.rule_id);
      if (!live(asset) || rule?.when.kind !== 'expiry') throw new Error('No live expiry rule');
      const before = asset.dates[rule.when.field];
      const previousReceipt = asset.field_sources[`dates.${rule.when.field}`]?.ref;
      if (before && (input.on < before || input.on === before && previousReceipt !== input.evidence_ref)) throw new Error('A renewal needs a later date');
      // The owner explicitly accepts this replacement date. That action is
      // authoritative even when the old date was typed by the owner; a raw
      // lower-ranked document contribution still cannot overwrite it.
      const updated = deps.work.writeAsset({ id: asset.id, source_id: asset.source_id, source: { kind: 'owner', ref: input.evidence_ref },
        dates: { [rule.when.field]: input.on } }, now());
      for (const row of rows.byAsset(asset.id).filter(row => row.rule_id === rule.id && row.cycle !== input.on)) {
        if (row.commitment_id && deps.work.readCommitment(row.commitment_id)?.lifecycle_state === 'pending') await close(row, 'fulfilled');
        const closed = row.commitment_id ? deps.work.readCommitment(row.commitment_id) : null;
        if (closed && closed.lifecycle_state !== 'pending' && row.close_processed_at === null) deps.db.transaction(() => {
          rows.queueCloseOutcome({ occurrence: row, commitment: closed, asset: updated, rule }); rows.markCloseProcessed(row.id, now());
        })();
      }
      if (JSON.stringify(updated) !== JSON.stringify(asset)) deps.dispatchers.ruleAssetWritten(updated, asset);
      await reconcileAsset(asset.id);
    },
  };
};
