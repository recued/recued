import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  assetDateAt, planAssetReminderPoints, shiftAssetDate,
  zonedWallClockToEpochMs, type Asset, type AssetRule,
} from '@recued/contracts';
import { mintAskId, type Answer, type AskDeliveryDestination, type AskDeliveryInput, type AskOption, type NotificationBlock } from '@recued/notification';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore, type AssetOccurrence } from '../storage/asset-occurrence-store.js';
import { createOccurrenceReminderStore, type OccurrenceReminderAnswer, type OccurrenceReminderPlan } from '../storage/occurrence-reminder-store.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { handleWorkEntityCommitmentClose } from '../work-entity-crud-handler.js';
import type { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import type { AssetOccurrenceService } from './asset-occurrence-service.js';
import { assetOccurrenceClock } from './asset-interval-cycle.js';
import { assetRenewal } from './asset-rule-timing.js';
import { ruleStatement } from './rule-titles.js';
import { reachesPhone } from './reminder-destinations.js';
import { releasedAtStop, settleWithin, STOP_GRACE_MS } from '../lifecycle/settle-within.js';

export const ASSET_REMINDER_HANDLER = 'asset-clock-reminder';
const DAY = 86_400_000;
type Mode = 'action' | 'question' | 'notice' | 'confirm_stop' | 'later_choice';
export type ClockReminderSubject = Pick<Asset, 'id' | 'name' | 'class_id' | 'status' | 'settings' | 'dates' | 'readings' | 'observations' | 'audience'>;
export interface AdditionalClockSubjects {
  read(row: AssetOccurrence): { subject: ClockReminderSubject; rule: AssetRule; due: string | null; route: string } | null;
  tick(): Promise<void>;
  mute(row: AssetOccurrence, at: number): void;
  complete(row: AssetOccurrence, answered_at: number, owner_action?: boolean): Promise<void>;
  hasEnabledClock(): boolean;
}
type Context = { row: AssetOccurrence; asset: ClockReminderSubject; rule: AssetRule; due: string | null; route?: string };
export interface AssetReminderServiceDeps {
  db: Database.Database;
  work: WorkEntityStore;
  dispatchers: ReturnType<typeof createWorkEntityDispatchers>;
  occurrences: AssetOccurrenceService;
  timeZone(): string;
  isQuiet(at: number): boolean;
  isVaultUnlocked?(): boolean;
  publicBaseUrl?(): string | null;
  householdDestinations?(): Promise<AskDeliveryDestination[]>;
  projectHousehold?(): Promise<void>;
  /** Stops what `projectHousehold` reaches, with this service's own `stop`. */
  stopHousehold?(): Promise<void>;
  additionalSubjects?: AdditionalClockSubjects;
  measure?(name: string, value: number, dimensions: Record<string, string>, at: number, receipt: string): void;
  ownerResponse?(refs: import('@recued/contracts').SituationRef[], at: number): void;
  now?(): number;
  log?(error: unknown): void;
}
export interface AssetReminderService {
  bind(notifier: NotificationBlock, options?: { publicBaseUrl(): string | null }): void;
  /** Source reconciliation holds its own lock. Queue locally and return;
   * never wait for an ask lock while holding an asset reconciliation lock. */
  withdraw(occurrence_id: string): void;
  reconcileClosedAsks(): Promise<void>;
  tick(): Promise<void>;
  stop(): Promise<void>;
  setLater(occurrence_id: string, until: number): Promise<void>;
}

export const createAssetReminderService = (deps: AssetReminderServiceDeps): AssetReminderService => {
  const now = deps.now ?? Date.now;
  const rows = createAssetOccurrenceStore(deps.db);
  const points = createOccurrenceReminderStore(deps.db);
  const reminders = createReminderStore(deps.db);
  deps.db.exec('CREATE TABLE IF NOT EXISTS clock_notification_enrollment (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)');
  const resolver = createWorkEntityResolver(deps.work);
  let notifier: NotificationBlock | undefined;
  let running: Promise<void> | undefined;
  let requested = false;
  let stopped = false;
  const stops = new AbortController();
  let publicBaseUrl = deps.publicBaseUrl;
  const log = deps.log ?? (error => console.warn('[asset-reminders] pending work will retry', error));
  const today = () => assetDateAt(now(), deps.timeZone());
  const requestTick = () => {
    if (stopped) return;
    requested = true;
    queueMicrotask(() => { if (!running) void tick().catch(log); });
  };
  const context = (id: string): Context | null => {
    const row = rows.get(id);
    if (row?.subject_kind === 'occasion') {
      const value = deps.additionalSubjects?.read(row);
      const commitment = row.commitment_id ? deps.work.readCommitment(row.commitment_id) : null;
      if (!value || !value.rule.enabled || value.rule.muted || !value.rule.reaction.notify
        || row.commitment_id && (!commitment || commitment.deleted_at != null || commitment.lifecycle_state !== 'pending')) return null;
      return { row, asset: value.subject, rule: value.rule, due: value.due, route: value.route };
    }
    const asset = row ? deps.work.readAssetEffective(row.asset_id) : null;
    const rule = asset?.rules.find(item => item.id === row?.rule_id);
    if (!row || !asset || asset.deleted_at != null || !['active', 'lent'].includes(asset.status)
      || !rule?.enabled || rule.muted || !rule.reaction.notify) return null;
    if (Boolean(row.commitment_id) !== (rule.reaction.occurrence === 'action')) return null;
    const commitment = row.commitment_id ? deps.work.readCommitment(row.commitment_id) : null;
    if (row.commitment_id && (!commitment || commitment.deleted_at != null || commitment.lifecycle_state !== 'pending')) return null;
    const clock = assetOccurrenceClock({ asset, rule, row, now: now(), timeZone: deps.timeZone(),
      ...(rule.when.kind === 'objective' ? { readings: deps.work.assetReadingHistory(asset.id, rule.when.field) } : {}) });
    if (!clock) return null;
    // WorkEntity date-only anchors are stored at UTC midnight. Converting that
    // instant into the owner's zone would silently move a west-coast due date.
    return { row, asset, rule, due: commitment?.promised_for_at === undefined ? clock.due_on
      : new Date(commitment.promised_for_at).toISOString().slice(0, 10) };
  };
  const withdraw = deps.db.transaction((id: string): void => {
    const current = points.control(id).current_ask_id;
    if (current) { points.requestCancellation(id, current, now()); points.clearCurrent(id, current); }
  });
  const drainCancellations = async (): Promise<void> => {
    if (!notifier) return;
    for (const job of points.pendingCancellations()) {
      const ask = await notifier.getAsk(job.ask_id);
      // A winning owner answer must finish before its replacement is released.
      if (ask?.status === 'answered') continue;
      if (ask?.status === 'open') await notifier.cancelAsk(job.ask_id);
      const after = await notifier.getAsk(job.ask_id);
      if (!after || after.status === 'handled') points.acknowledgeReplacement(job.ask_id, now());
    }
  };
  const reconcileClosedAsks = async (): Promise<void> => {
    if (!notifier || deps.isVaultUnlocked?.() === false) return;
    for (const control of points.controls()) {
      const current = context(control.occurrence_id);
      const ask = await notifier.getAsk(control.current_ask_id!);
      if (!current) { withdraw(control.occurrence_id); continue; }
      if (ask?.handler_payload.mode === 'notice' && ask.delivery_group_id) {
        const notice = reminders.clockForAsk(ask.ask_id);
        if (notice?.state === 'cancelled') { withdraw(control.occurrence_id); continue; }
        const group = await notifier.getAskDelivery(ask.delivery_group_id);
        const firstAttempt = group?.attempts[0];
        if (firstAttempt && assetDateAt(firstAttempt.started_at, deps.timeZone()) < today()) {
          withdraw(control.occurrence_id);
          const reminder = reminders.clockForAsk(ask.ask_id);
          if (reminder) reminders.cancel(reminder.reminder_id, now());
        }
      }
    }
    await drainCancellations();
  };
  const beforeAnswer = async (ask_id: string): Promise<void> => {
    if (!notifier || deps.isVaultUnlocked?.() === false) return;
    const occurrence = points.occurrenceForAsk(ask_id);
    if (!occurrence) return;
    if (points.control(occurrence).current_ask_id !== ask_id || !context(occurrence)) {
      points.requestCancellation(occurrence, ask_id, now());
    }
    await reconcileClosedAsks();
  };
  const options = (mode: Mode, item: Context): AskOption[] => {
    if (mode === 'question') return [
      { id: 'last_done_today', label: 'Today' }, { id: 'choose_last_done_date', label: 'Choose date' },
      { id: 'unknown_last_done', label: 'I don’t know' },
    ];
    if (mode === 'confirm_stop') return [{ id: 'muted', label: 'Stop reminding' }, { id: 'kept', label: 'Keep reminding' }];
    if (mode === 'later_choice') return [
      { id: 'later_tomorrow', label: 'Tomorrow' }, { id: 'later_week', label: 'A week' },
      { id: 'later_month', label: 'A month' }, { id: 'later_custom', label: 'Choose time' },
    ];
    if (mode === 'notice') return [{ id: 'stop_notices', label: 'Stop these' }];
    // D-325 §15.7 (2026-10-24) — a reminder is a notification, so it offers no Done:
    // pressed to clear a passport's first reminder, it closed the renewal with nothing
    // renewed. A task is marked done in Recued, a renewal by its new date. A reminder
    // sent before still carries Done; `completeOccurrence` leaves a renewal open.
    return [{ id: 'later', label: 'Later' },
      { id: 'not_needed', label: item.asset.settings.travel_document === true || ['passport', 'id_card', 'visa', 'driving_licence'].includes(item.asset.class_id ?? '') ? 'Not renewing' : 'Not needed' },
      { id: 'stop_requested', label: 'Stop reminding' }];
  };
  const ask = (item: Context, ask_id: string, mode: Mode): AskDeliveryInput['asks'][number] => {
    const route = item.route ?? `#yours/asset/${encodeURIComponent(item.asset.id)}`;
    const sensitive = item.asset.settings.sensitive === true;
    const title = sensitive ? 'Private reminder' : item.asset.name;
    const clock = item.rule.when;
    const fact = clock.kind === 'expiry' ? `${clock.field.replaceAll('_', ' ')}: ${item.asset.dates[clock.field] ?? 'unknown'}`
      : clock.kind === 'interval' ? `last ${clock.field.replaceAll('_', ' ')}: ${item.asset.dates[clock.field] ?? 'unknown'}`
      : clock.kind === 'objective' ? `${clock.field.replaceAll('_', ' ')}: ${item.asset.readings[clock.field]?.value ?? 'unknown'} ${clock.unit}; target ${clock.target} ${clock.unit}`
      : `${clock.field.replaceAll('_', ' ')} is ${item.asset.observations[clock.field]?.certainty ?? 'unknown'}`;
    const text = sensitive ? 'An item you track needs attention. Open Yours for the details.'
      : mode === 'question' ? `When was ${item.asset.name} last done? ${item.rule.title}. The date is unknown; no deadline has been assumed. To choose another date, open this item in Yours.`
      : mode === 'confirm_stop' ? `Stop reminders for ${ruleStatement(item.rule, item.asset.name)}? This is a safety, legal or travel clock. Its obligation stays open.`
      : mode === 'later_choice' ? `The next reminder for ${item.rule.title} is in a week. Choose another time, or open the item to set one.`
      : `${ruleStatement(item.rule, item.asset.name)}. ${fact}.${item.due ? ` Due ${item.due}.` : ' No deadline can be established yet.'}${mode !== 'action' ? ''
        : assetRenewal(item.asset, item.rule) ? ' Once renewed, enter the new date in Recued.' : ' Mark it done in Recued.'}`;
    const base = publicBaseUrl?.();
    return { ask_id, message: { title, text, ...(base ? { link_url: `${base.replace(/\/$/, '')}/${route}` } : {}) },
      ui_link_url: route, options: options(mode, item), handler: { kind: ASSET_REMINDER_HANDLER,
        payload: { occurrence_id: item.row.id, ask_id, mode } } };
  };
  /** P31 — an item whose asset is no longer the household's leaves every household
   * copy: a retry does not post it there and a member's answer to it is refused. */
  const householdWithheld = (ask: { handler_kind: string; handler_payload: Record<string, unknown> }): boolean => {
    if (ask.handler_kind !== ASSET_REMINDER_HANDLER) return false;
    const row = typeof ask.handler_payload.occurrence_id === 'string' ? rows.get(ask.handler_payload.occurrence_id) : null;
    if (!row || row.subject_kind === 'occasion') return true;
    const asset = deps.work.readAssetEffective(row.asset_id);
    return !asset || asset.deleted_at != null || asset.audience !== 'household';
  };
  const reserveAuxiliary = async (item: Context, originalAsk: string, mode: 'confirm_stop' | 'later_choice'): Promise<void> => {
    if (!notifier) return;
    const key = `${mode}:${originalAsk}`;
    if (points.point(item.row.id, key)) return;
    const original = await notifier.getAsk(originalAsk);
    if (!original?.delivery_group_id) throw new Error('Missing original reminder destinations');
    const destinations = await notifier.getAskDeliveryDestinations(original.delivery_group_id);
    const ask_id = mintAskId();
    points.reserve({ delivery: { group_id: randomUUID(), asks: [ask(item, ask_id, mode)], destinations },
      points: [{ occurrence_id: item.row.id, point_key: key, on: today(), ask_id, skipped_keys: [] }] }, now());
    requestTick();
  };
  const snoozeUntil = (at: number, amount: number, unit: 'days' | 'months'): number => {
    const zone = deps.timeZone();
    const date = shiftAssetDate(assetDateAt(at, zone), { amount, unit });
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
    const until = zonedWallClockToEpochMs(`${date}T${time}`, zone);
    if (until === null) throw new Error('The reminder time cannot be represented in this time zone');
    return until;
  };
  const mute = (item: Context, answer_id: string): void => {
    if (item.row.subject_kind === 'occasion') { deps.additionalSubjects?.mute(item.row, now()); withdraw(item.row.id); return; }
    const current = deps.work.readAsset(item.asset.id);
    if (!current) return;
    const updated = deps.work.writeAsset({ id: current.id, source_id: current.source_id,
      source: { kind: 'owner', ref: `reminder-answer:${answer_id}` },
      rules: current.rules.map(rule => rule.id === item.rule.id ? { ...rule, muted: true, pinned: true } : rule) }, now());
    deps.dispatchers.ruleAssetWritten(updated, current);
    withdraw(item.row.id);
  };
  const handleAnswer = async (payload: Record<string, unknown>, answer: Answer): Promise<void> => {
    if (!notifier || deps.isVaultUnlocked?.() === false) throw new Error('The vault must be unlocked to apply the reminder answer');
    if (typeof payload.ask_id !== 'string' || typeof payload.occurrence_id !== 'string') throw new Error('Invalid reminder identity');
    const actual = await notifier.getAsk(payload.ask_id);
    if (actual?.handler_kind !== ASSET_REMINDER_HANDLER || actual.answer?.option !== answer.option
      || actual.answer.answered_at !== answer.answered_at || points.occurrenceForAsk(payload.ask_id) !== payload.occurrence_id
      || actual.handler_payload.mode !== payload.mode) throw new Error('Unbound reminder answer');
    const receipt = points.answer({ ask_id: payload.ask_id, occurrence_id: payload.occurrence_id,
      outcome: answer.option as OccurrenceReminderAnswer['outcome'], answered_at: answer.answered_at, owner_action: actual.owner_answer === true });
    if (receipt.applied_at !== null) return;
    const item = context(payload.occurrence_id);
    if (item) {
      if (answer.option === 'done') {
        if (item.row.subject_kind === 'occasion') await deps.additionalSubjects?.complete(item.row, answer.answered_at, actual.owner_answer === true);
        else await deps.occurrences.completeOccurrence({ occurrence_id: item.row.id, answered_at: answer.answered_at, owner_action: actual.owner_answer === true });
      }
      else if (answer.option === 'not_needed' && item.row.commitment_id) {
        await handleWorkEntityCommitmentClose({ store: deps.work, resolver, dispatchers: deps.dispatchers }, { id: item.row.commitment_id }, 'cancelled');
        withdraw(item.row.id);
      } else if (answer.option === 'last_done_today') await deps.occurrences.recordLastDone({ asset_id: item.asset.id,
        rule_id: item.rule.id, on: assetDateAt(answer.answered_at, deps.timeZone()), evidence_ref: `reminder-answer:${payload.ask_id}`, confirmed: true });
      else if (answer.option === 'later') {
        points.later(item.row.id, snoozeUntil(answer.answered_at, 7, 'days'));
        await reserveAuxiliary(item, payload.ask_id, 'later_choice');
      } else if (answer.option === 'stop_requested' || answer.option === 'stop_notices') {
        if (item.rule.consequence === 'floor') await reserveAuxiliary(item, payload.ask_id, 'confirm_stop');
        else mute(item, payload.ask_id);
      } else if (answer.option === 'muted') mute(item, payload.ask_id);
      else if (answer.option === 'later_tomorrow' || answer.option === 'later_week' || answer.option === 'later_month') {
        points.later(item.row.id, snoozeUntil(answer.answered_at, answer.option === 'later_tomorrow' ? 1 : answer.option === 'later_week' ? 7 : 1,
          answer.option === 'later_month' ? 'months' : 'days'));
      }
      deps.measure?.('clock.answer', 1, { outcome: answer.option, class: item.asset.class_id ?? 'unclassified',
        rule_kind: item.rule.when.kind, channel: actual.answered_via ?? 'unknown',
        point: points.pointForAsk(payload.ask_id)?.point_key.split(':')[0] ?? String(payload.mode ?? 'auxiliary') }, answer.answered_at, `clock-answer:${payload.ask_id}`);
      if (actual.owner_answer === true) deps.ownerResponse?.([{ collection: item.row.subject_kind === 'occasion' ? 'occasion' : 'asset', id: item.row.asset_id },
        ...(item.row.commitment_id ? [{ collection: 'commitment', id: item.row.commitment_id }] : [])], answer.answered_at);
    }
    points.clearCurrent(payload.occurrence_id, payload.ask_id);
    points.applied(payload.ask_id, now());
    requestTick();
  };
  const syncNoticeReceipts = async (): Promise<void> => {
    if (!notifier) return;
    for (const reminder of reminders.listPending(10000)) {
      if (!reminder.clock) continue;
      const point = points.point(reminder.clock.occurrence_id, reminder.clock.point_key);
      const group = point ? await notifier.getAskDelivery(point.group_id) : null;
      const accepted = group?.destinations.filter(destination => destination.channel !== 'ui' && group.attempts.some(attempt =>
        attempt.destination_id === destination.id && attempt.result?.outcome === 'delivered')).map(destination => destination.id) ?? [];
      if (accepted.length) reminders.markDelivered(reminder.reminder_id, now(), accepted);
    }
  };
  const offerPhoneChannel = async (destinations: readonly AskDeliveryDestination[]): Promise<void> => {
    if (!notifier || reachesPhone(destinations)) return;
    let hasClock = deps.additionalSubjects?.hasEnabledClock() === true;
    for (let cursor = ''; !hasClock;) {
      const page = deps.work.walkByAssetId(cursor, 100); if (!page.length) break;
      hasClock = page.some(asset => ['active', 'lent'].includes(asset.status) && asset.rules.some(rule => rule.enabled && rule.reaction.notify));
      cursor = page.at(-1)!.id;
    }
    if (!hasClock) return;
    const saved = deps.db.prepare('SELECT payload FROM clock_notification_enrollment WHERE id=1').get() as { payload: string } | undefined;
    let input: AskDeliveryInput;
    if (saved) input = JSON.parse(saved.payload) as AskDeliveryInput;
    else {
      input = { group_id: randomUUID(), destinations: [{ id: 'owner:ui', channel: 'ui' }], asks: [{ ask_id: mintAskId(),
        message: { title: 'Let reminders reach your phone', text: 'Your first clock is running. Choose a messenger or email connection in Approval & notifications so reminders can reach you when the app is closed.' },
        ui_link_url: '#settings/notifications', options: [{ id: 'choose', label: 'I’ll choose a channel' }, { id: 'later', label: 'Later' }],
        handler: { kind: 'asset-clock-phone-enrollment', payload: {} } }] };
      deps.db.prepare('INSERT INTO clock_notification_enrollment(id,payload) VALUES(1,?)').run(JSON.stringify(input));
    }
    await notifier.askBundle(input);
  };
  const releasePending = async (): Promise<void> => {
    if (!notifier) return;
    for (const row of points.pending()) {
      // A stop releases nothing more: the rest stay pending for the next start.
      if (stopped) return;
      try {
        if (deps.isQuiet(now()) || deps.isVaultUnlocked?.() === false) return;
        await drainCancellations();
        if (points.replacements(row.group_id).length) continue;
        points.activate(row.group_id, now());
        await notifier.prepareAskBundle(row.plan.delivery);
        // prepare performs no provider I/O. Re-read AFTER every await before
        // releasing. Closed bundle members keep their original item numbers.
        for (const point of row.plan.points) {
          const notice = reminders.clockForAsk(point.ask_id);
          if (!context(point.occurrence_id) || notice?.state === 'cancelled' || points.control(point.occurrence_id).current_ask_id !== point.ask_id) {
            await notifier.cancelAsk(point.ask_id); points.clearCurrent(point.occurrence_id, point.ask_id);
          }
        }
        points.ready(row.group_id, today(), now());
        await notifier.releaseAskBundle(row.group_id);
        points.released(row.group_id, now());
      } catch (error) { log(error); }
    }
  };
  /** ⛔ A STOP ENDS A PASS AT ITS NEXT STEP (`stop`), never inside one. Every
   *  step is one the next pass repeats or finishes: a plan reserved but not
   *  released is released by the next pass's `releasePending`, and a clock not
   *  yet planned is planned then. */
  const run = async (): Promise<void> => {
    if (deps.isVaultUnlocked?.() === false) return;
    await deps.occurrences.tick();
    if (stopped) return;
    await deps.additionalSubjects?.tick();
    if (stopped) return;
    await deps.projectHousehold?.();
    if (!notifier || stopped) return;
    await reconcileClosedAsks();
    if (stopped) return;
    await notifier.recoverReminderAsks();
    await releasePending();
    if (stopped || deps.isQuiet(now())) return;
    const owner = await notifier.getReminderDestinations();
    if (stopped) return;
    await offerPhoneChannel(owner.destinations);
    const candidates = new Map<string, { item: Context; key: string; skipped: string[] }[]>();
    for (const row of rows.all()) {
      const item = context(row.id); if (!item) continue;
      if (points.pending().some(plan => plan.plan.points.some(point => point.occurrence_id === row.id))) continue;
      const control = points.control(row.id);
      if (control.later_until !== null && control.later_until > now()) continue;
      let key: string; let skipped: string[] = [];
      if (control.later_until !== null) {
        key = `later:${control.later_until}`;
        // P47 — Later moves only the next reminder: it stands in for every point it
        // slept through, or the latest of them is sent again the day after.
        if (item.due) skipped = planAssetReminderPoints(item.due, item.rule, today()).past_keys;
      } else if (row.question) key = 'last_done_question';
      else if (item.due) {
        const plan = planAssetReminderPoints(item.due, item.rule, today());
        if (!plan.due) continue;
        key = plan.due.key; skipped = plan.past_keys.filter(key => key !== plan.due!.key);
      } else key = 'active';
      if (points.point(row.id, key) || control.last_notified_on === today()) continue;
      // §5.1 re-dating — a clock whose date was corrected today was already reminded
      // today under its old date, so it waits for its next day rather than ask twice.
      if (control.last_notified_on === null && rows.byAsset(row.asset_id).some(other => other.id !== row.id
        && other.rule_id === row.rule_id && (other.subject_kind ?? 'asset') === (row.subject_kind ?? 'asset')
        && points.control(other.id).last_notified_on === today())) continue;
      const audience = item.asset.audience ?? 'owner';
      const batch = candidates.get(audience) ?? []; batch.push({ item, key, skipped }); candidates.set(audience, batch);
    }
    for (const [audience, batch] of candidates) {
      if (stopped) return;
      const household = audience === 'household' ? (await deps.householdDestinations?.() ?? []).filter(destination => notifier!.supportsReminderChannel(destination.channel)) : [];
      const destinations = [...new Map([...owner.destinations, ...household].map(destination => [destination.id, destination])).values()];
      // Bounded envelopes do not bound the clocks: every remaining item gets a
      // following envelope in this pass, including every consequence-floor item.
      for (let index = 0; index < batch.length; index += 20) {
        const chunk = batch.slice(index, index + 20);
        const plan: OccurrenceReminderPlan = { delivery: { group_id: randomUUID(), asks: [], destinations }, points: [] };
        const asks: AskDeliveryInput['asks'][number][] = [];
        for (const candidate of chunk) {
          const ask_id = mintAskId();
          const mode: Mode = candidate.item.row.question ? 'question' : candidate.item.row.commitment_id ? 'action' : 'notice';
          asks.push(ask(candidate.item, ask_id, mode));
          plan.points.push({ occurrence_id: candidate.item.row.id, point_key: candidate.key, on: today(), ask_id, skipped_keys: candidate.skipped });
        }
        plan.delivery = { ...plan.delivery, asks };
        deps.db.transaction(() => {
          points.reserve(plan, now());
          for (const point of plan.points) {
            const item = context(point.occurrence_id)!;
            if (!item.row.commitment_id && !item.row.question) reminders.ensureClock({ text: asks.find(ask => ask.ask_id === point.ask_id)!.message.text,
              at: now(), time_zone: deps.timeZone(), origin: {}, clock: { occurrence_id: point.occurrence_id, point_key: point.point_key, ask_id: point.ask_id } }, now());
            const later = points.control(point.occurrence_id).later_until;
            if (later !== null && later <= now()) points.clearLater(point.occurrence_id, later);
          }
        })();
      }
    }
    await releasePending();
    if (stopped) return;
    await syncNoticeReceipts();
  };
  /** A pass, settled no later than `STOP_GRACE_MS` after `stop`: the minute
   *  interval waits for what this returns, in the same drain step as `stop`. */
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    running ??= (async () => {
      do { requested = false; await run(); } while (requested && !stopped);
    })().finally(() => { running = undefined; });
    return releasedAtStop(running, stops.signal, undefined);
  };
  return {
    bind(block, options) {
      if (notifier) throw new Error('The asset reminder service is already bound');
      notifier = block;
      if (options) publicBaseUrl = options.publicBaseUrl;
      block.registerAskHandler(ASSET_REMINDER_HANDLER, handleAnswer);
      block.registerAskHandler('asset-clock-phone-enrollment', async () => {});
      block.registerReminderReconciler({ beforeRecovery: reconcileClosedAsks, beforeAnswer, householdWithheld });
    },
    withdraw, reconcileClosedAsks, tick,
    /** ⛔ BOUNDED: a drain step awaits this, with 5 s, and a pass sends through
     *  every channel (a messenger 30 s, an email longer) while the process
     *  exits right after the drain anyway. What a stop cuts short the next pass
     *  repeats or finishes (`run`); Home Assistant stops with it. */
    async stop() {
      stopped = true; stops.abort();
      const pass = running;
      await Promise.all([pass ? settleWithin(pass, STOP_GRACE_MS) : undefined, deps.stopHousehold?.()]);
    },
    async setLater(id, until) {
      if (!context(id) || !Number.isFinite(until) || until <= now() || until > now() + 366 * DAY) throw new Error('Choose a future reminder time within a year');
      points.later(id, until); withdraw(id); await drainCancellations();
    },
  };
};
