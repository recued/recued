import { createTripDetailsStore, tripFromSource } from '../storage/trip-details-store.js';
import { createHash } from 'node:crypto';
import { canonicalRecipeDefinition, canonicalJsonString } from '@recued/recipes';
import type Database from 'better-sqlite3';
import { ASSET_DOCUMENT_DETAILS_ATTRIBUTE, normalizeAssetDocumentDetails, isAssetDate, assetDateAt, calendarDayMs, kernelOpForBackingSlug, occasionNextDate, PROACTIVE_PROPOSAL_KINDS, shiftAssetDate, zonedWallClockToEpochMs, type Asset, type AssetCreateInput, type AssetPatch, type AssetRule, type ExecutionSource,
  type ProactiveProposal, type SituationRef, type YoursAssetSummary, type YoursCommand, type YoursCommandResult, type YoursReadRequest, type YoursSnapshot } from '@recued/contracts';
import type { ConnectionRow } from '@recued/contracts';
import type { NotificationBlock } from '@recued/notification';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore, type AssetOccurrence } from '../storage/asset-occurrence-store.js';
import { createSituationDismissalStore, situationItemKey, situationKindKey } from '../storage/situation-dismissal-store.js';
import { createOccurrenceReminderStore } from '../storage/occurrence-reminder-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createSphereStore, type SphereStore } from '../storage/sphere-store.js';
import type { SituationStore } from '../storage/situation-store.js';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import type { AnnotationStore } from '../storage/annotation-store.js';
import type { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetClassStore, assetClassPatch } from './asset-classes.js';
import { createAssetIntake } from './asset-intake.js';
import { createMailProof, MAIL_PROOF_TAG, proofTarget } from './mail-proof.js';
import type { AssetOccurrenceService } from './asset-occurrence-service.js';
import { assetOccurrenceClock } from './asset-interval-cycle.js';
import { summarizeYoursAsset } from './asset-summary.js';
import type { AssetReminderService } from './asset-reminder-service.js';
import type { EpisodeRuntime } from './episode-runtime.js';
import { createHouseholdDeliveryStore, telegramHouseholdRoute } from '../storage/household-delivery-store.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import { kindLearningPool, kindRankingFloor, kindWords, learningDigest, learningPool } from './learning.js';
import { publishProposalEvents } from './proposal-events.js';
import { recordDigestResponse } from './measures.js';
import { completionQuestionKey, lastDoneQuestionKey } from './owner-completion.js';
import type { ProactiveLearning } from './learning-runtime.js';
import { ruleNotice } from './rule-titles.js';

/** "Never this kind" names what stops, in the owner's words; a mail fact kind as the learner names it. */
const DISMISSED_KINDS: Record<string, string> = { travel_validity: 'travel document checks', episode: 'last-time suggestions',
  asset_rule: 'asset clocks', occasion: 'occasion suggestions', booking: 'booking suggestions' };
const definitionDigest = (recipe: import('@recued/contracts').RecipeDefinition): string => createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(recipe))).digest('hex');
const observationRecipe = (recipe: import('@recued/contracts').RecipeDefinition): boolean => {
  const visit = (steps: unknown[]): boolean => steps.some(value => {
    if (!value || typeof value !== 'object') return false;
    const step = value as Record<string, unknown>;
    return step.op === 'core.work-entity.asset.observe' || (typeof step.ingredient === 'string' && kernelOpForBackingSlug(step.ingredient.replace(/^core-/u, '')) === 'core.work-entity.asset.observe')
      || (Array.isArray(step.steps) && visit(step.steps));
  });
  return visit(recipe.steps);
};
const record = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
const text = (raw: unknown, field: string): string => {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) throw new Error(`${field} is required`); return raw;
};
export interface YoursServiceDeps {
  db: Database.Database;
  work: WorkEntityStore;
  dispatchers: ReturnType<typeof createWorkEntityDispatchers>;
  occurrences: AssetOccurrenceService;
  reminders?: AssetReminderService;
  situations: SituationStore;
  spheres?: SphereStore;
  mailFacts?: MailFactStore;
  annotations?: AnnotationStore;
  episodeRuntime?: EpisodeRuntime;
  connections?(): readonly ConnectionRow[];
  homeAssistant?: import('./household-home-assistant.js').HouseholdHomeAssistant;
  learning?: ProactiveLearning;
  sphereSources?(): Array<{ source: string; name: string }>;
  /** The mailboxes whose mail is read for facts, each with its own address:
   *  with `+done` it takes forwarded proof (§5.3). */
  mailboxes?(): ReadonlyArray<{ slug: string; address: string }>;
  isVaultUnlocked?(): boolean;
  now?(): number;
  timeZone?(): string;
}
/** Where the owner forwards proof: the address with `+done` of each mailbox whose
 * mail can propose (`mail:<slug>` on). An address already carrying a tag cannot
 * take another. */
const proofAddresses = (mailboxes: ReadonlyArray<{ slug: string; address: string }>, proposes: (source: string) => boolean): string[] =>
  [...new Set(mailboxes.flatMap(({ slug, address }) => {
    const at = address.lastIndexOf('@'); const local = address.slice(0, at);
    return at > 0 && at < address.length - 1 && !local.includes('+') && proposes(`mail:${slug}`)
      ? [`${local}+${MAIL_PROOF_TAG}@${address.slice(at + 1)}`] : [];
  }))];
export const createYoursService = (deps: YoursServiceDeps) => {
  const now = deps.now ?? Date.now;
  const proposals = createProactiveProposalStore(deps.db);
  const history = createProactiveHistoryStore(deps.db, proposals);
  const classes = createAssetClassStore(deps.db);
  const trips = createTripDetailsStore(deps.db);
  const household = createHouseholdDeliveryStore(deps.db);
  const spheres = deps.spheres ?? createSphereStore(deps.db, deps.work);
  const rows = createAssetOccurrenceStore(deps.db);
  const points = createOccurrenceReminderStore(deps.db);
  const intake = createAssetIntake({ db: deps.db, proposals, ...(deps.mailFacts ? { mailFacts: deps.mailFacts } : {}),
    ...(deps.isVaultUnlocked ? { isVaultUnlocked: deps.isVaultUnlocked } : {}), now });
  const mailProof = createMailProof({ db: deps.db, work: deps.work, proposals, ...(deps.mailFacts ? { mailFacts: deps.mailFacts } : {}),
    ...(deps.isVaultUnlocked ? { isVaultUnlocked: deps.isVaultUnlocked } : {}), ...(deps.timeZone ? { timeZone: deps.timeZone } : {}), now });
  const dismissals = createSituationDismissalStore(deps.db);
  const mutations = new Map<string, Promise<unknown>>();
  let notifier: NotificationBlock | undefined;
  let recipes: import('../recipe-store.js').RecipeStore | undefined;
  let scheduled: import('./scheduled-situations.js').ScheduledSituations | undefined;
  let subscribers: { store: import('../triggers/store.js').EventTriggersStore; contracts: import('../storage/contract-definition-store.js').ContractDefinitionStore; changed(): void } | undefined;
  deps.db.exec(`CREATE TABLE IF NOT EXISTS asset_identity_links (
    left_id TEXT NOT NULL, right_id TEXT NOT NULL, merged INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL,
    PRIMARY KEY(left_id,right_id)
  );`);
  const requireOpen = () => { if (deps.isVaultUnlocked?.() === false) throw new Error('Unlock the vault to open Yours'); };
  const asset = (id: string): Asset => {
    const value = deps.work.readAsset(id); if (!value || value.deleted_at != null) throw new Error('Asset not found'); return value;
  };
  // §15.3 — the asset page names its holder. The picker stores a contact id, or an
  // email for a contact without one, as mail-proof reads it.
  let contactStore: ContactStore | undefined;
  const holderOf = (id: string): NonNullable<YoursSnapshot['holder']> => {
    const contact = (contactStore ??= createContactStore(deps.db)).getByContactIdResolved(id) ?? contactStore.get(id);
    return { contact_id: id, name: contact ? contact.name ?? contact.email : null };
  };
  const ownerArgs = (owner: ExecutionSource) => ({ origin_execution_source: owner, source: { kind: 'owner' as const, ref: 'paired-owner' } });
  const silencesClock = (rule: AssetRule | undefined): boolean => !rule?.enabled || rule.muted || !rule.reaction.notify || rule.consequence !== 'floor'
    || rule.when.kind !== 'condition' && !rule.schedule.before.length && !rule.schedule.on_day;
  const update = (id: string, patch: AssetPatch, owner: ExecutionSource) => deps.dispatchers.assetUpdate({ ...patch, id, ...ownerArgs(owner) });
  const saveRule = async (asset_id: string, rule: AssetRule, owner: ExecutionSource, confirmFloor = false) => {
    const current = asset(asset_id); const previous = current.rules.find(row => row.id === rule.id);
    if (previous?.consequence === 'floor' && previous.enabled && !previous.muted
      && silencesClock(rule) && !confirmFloor) {
      throw new Error('Confirm stopping this safety, legal or travel clock');
    }
    const rules = [...current.rules.filter(row => row.id !== rule.id), { ...rule, pinned: true }];
    await update(asset_id, { rules }, owner);
  };
  const applyClass = async (asset_id: string, class_id: string, owner: ExecutionSource) => {
    const current = asset(asset_id); const preset = classes.get(class_id); if (!preset) throw new Error('Class not found');
    const source = deps.work.getSource(current.source_id);
    if (current.sync_state !== 'live' || !source?.write_capable || source.source_kind !== 'builtin') throw new Error('This asset source cannot confirm a preset update');
    const previousIds = Array.isArray(current.settings.class_rule_ids) ? current.settings.class_rule_ids : [];
    // Every asset holds a retirement, so only one that differs from what its
    // previous class (or the store's 'part') gave is the owner's to keep.
    const previous = current.class_id ? classes.get(current.class_id) : null;
    const own = { ...current, ...(current.retirement === (previous?.retirement ?? 'part') ? { retirement: undefined } : {}),
      rules: current.rules.filter(rule => rule.pinned || !previousIds.includes(rule.id)) };
    const patch = assetClassPatch(preset, own);
    for (const rule of current.rules.filter(rule => rule.enabled && !rule.muted && rule.consequence === 'floor')) {
      const next = patch.rules.find(row => row.id === rule.id);
      if (silencesClock(next)) {
        throw new Error('This preset would stop a safety, legal or travel clock. Review that rule and confirm its change first.');
      }
    }
    const updated = deps.work.writeAsset({ ...patch, id: current.id, source_id: current.source_id,
      source: { kind: 'owner', ref: `owner:${owner.channel === 'user' ? owner.user_id : 'local'}` }, preset_application: true }, now());
    if (JSON.stringify(updated) !== JSON.stringify(current)) deps.dispatchers.ruleAssetWritten(updated, current);
    await deps.occurrences.reconcileAsset(updated.id);
    return { asset: updated };
  };
  const create = async (input: Omit<AssetCreateInput, 'source'>, class_id: string | undefined, owner: ExecutionSource, evidence?: string) => {
    const chosen = class_id ?? input.class_id ?? undefined;
    const preset = chosen ? classes.get(chosen) : null;
    if (chosen && !preset) throw new Error('Class not found');
    if (chosen && (['passport', 'id_card', 'visa', 'driving_licence'].includes(chosen) || preset?.fields.settings.holder_required === true) && !input.holder_contact) throw new Error('Choose the contact who holds this document');
    const patch = preset ? { ...assetClassPatch(preset), ...input,
      dates: { ...preset.fields.dates, ...input.dates }, readings: { ...preset.fields.readings, ...input.readings },
      observations: { ...preset.fields.observations, ...input.observations }, settings: { ...preset.fields.settings, ...input.settings,
        class_version: preset.version, class_rule_ids: preset.rules.map(rule => rule.id) }, rules: input.rules ?? structuredClone(preset.rules) } : input;
    return deps.dispatchers.assetCreate({ ...patch, ...ownerArgs(owner),
      ...(evidence ? { source: { kind: 'confirmed_document', ref: evidence } } : {}) });
  };
  const refreshQuestions = () => {
    for (const row of rows.all()) {
      if (row.subject_kind === 'occasion') continue;
      const completion = rows.completion(row.id); const keyCompletion = completionQuestionKey(row.id);
      const completedAsset = deps.work.readAsset(row.asset_id); const completedRule = completedAsset?.rules.find(rule => rule.id === row.rule_id);
      const needsDetails = completion && (completion.known === false || completion.owner_action !== true) && completedAsset && ['active', 'lent'].includes(completedAsset.status)
        && (completedRule?.when.kind === 'interval' || completedRule?.when.kind === 'objective' && completedRule.when.mode === 'usage' && completedRule.when.every);
      if (needsDetails) proposals.ensure({ key: keyCompletion, kind: 'completion', title: `Confirm service details · ${completedAsset.name}`,
        explanation: 'Done closed the original task. Confirm the actual service date and, for a usage clock, its service reading before the clock advances.',
        confidence: 'high', origin: 'owner', subject: { collection: 'asset', id: completedAsset.id }, sources: [{ collection: 'asset', id: completedAsset.id }],
        payload: { occurrence_id: row.id, asset_id: completedAsset.id, rule_id: row.rule_id,
          ...(completedRule.when.kind === 'objective' ? { unit: completedRule.when.unit } : {}) } }, now());
      else { const old = proposals.byKey(keyCompletion); if (old?.state === 'proposed') proposals.outcome(old.id, 'retracted', now()); }
      if (!row.question) continue;
      const commitment = row.commitment_id ? deps.work.readCommitment(row.commitment_id) : null;
      const current = deps.work.readAsset(row.asset_id);
      const key = lastDoneQuestionKey(row.id);
      if (!current || (commitment && commitment.lifecycle_state !== 'pending')) {
        const old = proposals.byKey(key); if (old?.state === 'proposed') proposals.outcome(old.id, 'retracted', now()); continue;
      }
      proposals.ensure({ key, kind: 'last_done', title: `When was ${current.name} last done?`, explanation: 'The date is unknown. This clock has no deadline until you choose one.',
        payload: { occurrence_id: row.id }, sources: [{ collection: 'asset', id: current.id }], subject: { collection: 'asset', id: current.id },
        confidence: 'high', origin: 'pack' }, now());
    }
  };
  const refreshEvidence = async () => {
    for (let cursor = ''; ;) {
      const page = deps.work.walkAssetsForEvidenceRefresh(cursor, 500); if (!page.assets.length) break;
      const candidates = page.assets;
      let prefetched: ReturnType<WorkEntityStore['listAssetObservationBindingsForAssets']> | undefined = deps.work.listAssetObservationBindingsForAssets(candidates.map(current => current.id));
      for (const current of candidates) {
        const bindings = prefetched?.get(current.id) ?? deps.work.listAssetObservationBindings(current.id);
        for (const [field, observation] of Object.entries(current.observations)) {
          if (!observation?.active || current.field_sources[`observations.${field}`]?.kind !== 'observation') continue;
          const binding = bindings.find(row => row.enabled && row.source_ref === observation.source && row.fields.includes(`observations.${field}`) && row.recipe_hash?.length === 64);
          if (!binding) continue;
          for (const evidence of observation.evidence) {
            if (evidence.collection !== 'file' || !evidence.id.startsWith('file:') || !evidence.field?.startsWith('dates.') || !isAssetDate(evidence.value)) continue;
            const dateField = evidence.field.slice(6); const on = evidence.value;
            if (!Object.hasOwn(current.dates, dateField) || (current.dates[dateField] && on <= current.dates[dateField]!)) continue;
            for (const rule of current.rules) {
              if (!rule.enabled || !['expiry', 'interval'].includes(rule.when.kind) || rule.when.field !== dateField || rule.reaction.occurrence !== 'action') continue;
              if (rule.when.kind === 'interval' && on > assetDateAt(now(), 'UTC')) continue;
              const payload = { asset_id: current.id, rule_id: rule.id, on, evidence_file: evidence.id, observation_source: observation.source, proposal_class: 'document-close' };
              if (!proposals.allows({ kind: 'close', payload })) continue;
              const proposal = proposals.ensure({ key: `document-close:${current.id}:${rule.id}:${on}`, kind: 'close', title: `${rule.title} · evidence for ${current.name}`,
                explanation: `A bound source reports ${dateField.replaceAll('_', ' ')} as ${on}. Open the attached document and confirm its actual date.`, payload,
                sources: [{ collection: 'file', id: evidence.id, field: evidence.field }], subject: { collection: 'asset', id: current.id }, confidence: 'medium', origin: 'pack' }, now());
              if (proposal.state === 'proposed' && deps.annotations) {
                const input = { from_collection: 'asset', from_id: current.id, to_collection: 'file', to_id: evidence.id, role: 'attachment', authored_by_recipe_id: binding.actor_ref.slice('recipe:'.length), origin_actor: 'system' as const, origin_surface: 'engine' as const };
                if (deps.annotations.upsertLink) await deps.annotations.upsertLink(input);
                else if (!(await deps.annotations.listLinks({ from_collection: 'asset', from_id: current.id, to_collection: 'file', to_id: evidence.id, role: 'attachment' })).length) await deps.annotations.link(input);
                // An owner can change bindings during either annotation await.
                // Keep this asset's original read, but read later assets afresh.
                // Falling back avoids repeatedly prefetching the remaining page.
                prefetched = undefined;
              }
            }
          }
        }
      }
      cursor = page.cursor;
    }
  };
  const refreshTrips = () => {
    if (!classes.list().some(row => row.travel_validity?.length)) return;
    const inspect = (ref: SituationRef, title: string, raw: unknown) => {
      const trip = trips.get(ref) ?? tripFromSource(ref, raw); if (!trip) return;
      const previous = proposals.byKey(`trip-details:${ref.collection}:${ref.id}`);
      if (trip.travellers.length && trip.destination_country && trip.entry_on && trip.exit_on) {
        if (previous?.state === 'proposed') proposals.outcome(previous.id, 'retracted', now());
        return;
      }
      const payload = { trip, proposal_class: 'trip-details' };
      if (proposals.allows({ kind: 'trip', payload })) proposals.ensure({ key: `trip-details:${ref.collection}:${ref.id}`, kind: 'trip', title: `Who is travelling? · ${title}`,
        explanation: 'Choose each traveller and the trip dates so each holder’s passport can be checked. The booking counterparty is not assumed to be travelling.',
        payload, subject: ref, sources: [ref], confidence: 'high', origin: 'pack' }, now());
    };
    // A reservation tracked as a booking is asked about once, on the booking.
    const booked = new Set<string>();
    for (let offset = 0; offset < 20000; offset += 500) {
      const rows = deps.work.listByKind('booking', { limit: 500, offset, sync_states: ['live', 'stale_unreachable'] });
      for (const row of rows) if (row._kind === 'booking' && ['pending', 'confirmed'].includes(row.lifecycle_state)) {
        const blob = row.source_extension_blob as { fact_type?: unknown; thing_id?: unknown } | undefined;
        if (blob?.fact_type === 'reservation' && typeof blob.thing_id === 'string') booked.add(blob.thing_id);
        inspect({ collection: 'booking', id: row.id }, row.title, row.source_extension_blob);
      }
      if (rows.length < 500) break;
    }
    if (deps.mailFacts) {
      let cursor: { updated_at: number; thing_id: string } | undefined;
      for (let scanned = 0; scanned < 20000; scanned += 500) {
        const page = deps.mailFacts.listThings({ limit: 500, ...(cursor ? { cursor_before: cursor } : {}) });
        for (const row of page) if (row.type === 'reservation' && row.variables.state !== 'cancelled' && !booked.has(row.thing_id)) inspect({ collection: 'mail_fact', id: row.thing_id }, String(row.variables.provider ?? 'Reservation'), row.variables);
        if (page.length < 500) break;
        const last = page.at(-1)!; cursor = { updated_at: last.updated_at, thing_id: last.thing_id };
      }
    }
  };
  // An offer belongs to the asset's current class and live lifecycle. Recheck
  // when accepting too: an owner need not open another snapshot after editing.
  const classUpdateApplies = (current: Asset | null, class_id: string, version: number): boolean => !!current
    && current.deleted_at == null && current.class_id === class_id && ['active', 'lent'].includes(current.status)
    && ['live', 'stale_unreachable'].includes(current.sync_state) && !(Number(current.settings.class_version ?? 0) >= version);
  const refreshClassUpdates = () => {
    for (let cursor = ''; ;) {
      const page = deps.work.walkAssetsForClassUpdates(cursor, 100); if (!page.length) break;
      for (const current of page) {
        if (!current.class_id || !['active', 'lent'].includes(current.status)) continue;
        const preset = classes.get(current.class_id); if (!preset || !classUpdateApplies(current, preset.id, preset.version)) continue;
        const payload = { asset_id: current.id, class_id: preset.id, preset_version: preset.version, apply_class: true, proposal_class: `class-update:${preset.id}` };
        if (!proposals.allows({ kind: 'rule', payload })) continue;
        const pinned = current.rules.filter(rule => rule.pinned).length;
        const changes = preset.rules.slice(0, 12).map(rule => `${rule.title}: ${rule.when.field}; remind ${rule.schedule.before.map(point => `${point.amount} ${point.unit}`).join(', ')}${rule.schedule.on_day ? ', on the day' : ''}`).join('\n');
        proposals.ensure({ key: `class-update:${current.id}:${preset.id}:${preset.version}`, kind: 'rule', title: `${preset.name} preset update · ${current.name}`,
          explanation: `Version ${preset.version} is available. ${pinned} edited rows stay pinned.\n${changes}${preset.rules.length > 12 ? '\nSee Classes for the remaining rows.' : ''}`.slice(0, 4000),
          payload,
          subject: { collection: 'asset', id: current.id }, sources: [{ collection: 'asset', id: current.id }], confidence: 'high', origin: preset.origin === 'owner' ? 'owner' : 'pack' }, now());
      }
      cursor = page.at(-1)!.id;
    }
    for (const proposal of proposals.list({ state: 'proposed', kind: 'rule', limit: 10000 })) {
      if (proposal.payload.apply_class !== true) continue;
      const current = deps.work.readAsset(String(proposal.payload.asset_id)); const preset = classes.get(String(proposal.payload.class_id));
      if (!preset || preset.version !== proposal.payload.preset_version || !classUpdateApplies(current, preset.id, preset.version)) proposals.outcome(proposal.id, 'retracted', now());
    }
  };
  const lastDone = async (id: string, on: string | null): Promise<void> => {
    const row = rows.get(id); if (!row) throw new Error('Occurrence not found');
    if (on === null) {
      points.consumeQuestion(id, now()); deps.reminders?.withdraw(id); await deps.reminders?.reconcileClosedAsks();
      const proposal = proposals.byKey(lastDoneQuestionKey(id)); if (proposal?.state === 'proposed') proposals.outcome(proposal.id, 'not_this_one', now());
      return;
    }
    await deps.occurrences.recordLastDone({ asset_id: row.asset_id, rule_id: row.rule_id, on,
      confirmed: true, evidence_ref: `owner-last-done:${id}` });
    const proposal = proposals.byKey(lastDoneQuestionKey(id)); if (proposal?.state === 'proposed') proposals.outcome(proposal.id, 'accepted', now(), { collection: 'asset', id: row.asset_id });
  };
  const sameThing = async (id: string, other_id: string, merge: boolean, owner: ExecutionSource): Promise<void> => {
    if (id === other_id) throw new Error('Choose two different assets');
    const current = asset(id); const other = asset(other_id);
    if (merge) {
      const hasLinks = !!deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='link'").get();
      if (hasLinks && !deps.annotations) throw new Error('The attachment store is unavailable; retry the merge when it is ready');
      // Re-point references, keeping both source rows and their history. The
      // duplicate is retired only after those writes, so a retry can finish.
      for (const child of deps.work.listAssetChildren(other.id)) if (child.id !== id) await update(child.id, { belongs_to: id }, owner);
      if (current.belongs_to === other.id) await update(id, { belongs_to: other.belongs_to ?? null }, owner);
      // The duplicate's clocks and the fact slots they and its device feed use move
      // too, without overwriting the kept asset's own; then its bindings and reading
      // history, since a binding could never write to the retired duplicate. A
      // reading or observation slot moves empty: an owner write of its value would
      // outrank the device for good, and the history keeps what it measured.
      const missing = <T>(from: Record<string, T>, into: Record<string, T>) => Object.fromEntries(Object.entries(from).filter(([key]) => !Object.hasOwn(into, key)));
      const slots = (from: Record<string, unknown>, into: Record<string, unknown>) => Object.fromEntries(Object.keys(missing(from, into)).map(key => [key, null]));
      // Only references still on the duplicate can bring their context. Its
      // retained source row must not restore cleared details on a merge retry.
      const incomingFiles = new Set((await deps.annotations?.outboundLinks('asset', other_id) ?? [])
        .filter(link => link.role === 'attachment' && link.to_collection === 'file').map(link => link.to_id));
      const keptDocuments = record(asset(id).attributes[ASSET_DOCUMENT_DETAILS_ATTRIBUTE]);
      const movedDocuments = Object.fromEntries(Object.entries(missing(record(other.attributes[ASSET_DOCUMENT_DETAILS_ATTRIBUTE]), keptDocuments))
        .filter(([recordId]) => incomingFiles.has(recordId)));
      const carried = { dates: missing(other.dates, current.dates), readings: slots(other.readings, current.readings),
        observations: slots(other.observations, current.observations),
        attributes: Object.keys(movedDocuments).length ? { [ASSET_DOCUMENT_DETAILS_ATTRIBUTE]: { ...keptDocuments, ...movedDocuments } } : {} };
      const rules = other.rules.filter(rule => !current.rules.some(row => row.id === rule.id));
      if (rules.length || Object.values(carried).some(map => Object.keys(map).length)) {
        await update(id, { ...carried, ...(rules.length ? { rules: [...asset(id).rules, ...rules] } : {}) }, owner);
      }
      deps.work.moveAssetObservations(other_id, id);
      await deps.annotations?.rewriteRecordId('asset', other_id, id);
      deps.db.transaction(() => {
        const has = (name: string) => !!deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
        if (has('work_entity_edge')) {
          deps.db.prepare("UPDATE OR IGNORE work_entity_edge SET target_local_id=?,target_scoped_key=?,target_source_id=?,target_remote_entity=NULL,target_remote_id=NULL WHERE target_kind='asset' AND target_local_id=? AND deleted_at IS NULL")
            .run(id, `work:asset:local:${id}`, current.source_id, other_id);
          // An already-existing canonical edge wins a tuple collision. Retire
          // only that duplicate edge, preserving its history.
          deps.db.prepare("UPDATE work_entity_edge SET deleted_at=? WHERE target_kind='asset' AND target_local_id=? AND deleted_at IS NULL").run(now(), other_id);
        }
        deps.db.prepare('INSERT INTO asset_identity_links(left_id,right_id,merged,at) VALUES(?,?,1,?) ON CONFLICT(left_id,right_id) DO UPDATE SET merged=1')
          .run(id, other_id, now());
      })();
      await update(other_id, { status: 'retired' }, owner);
    } else deps.db.prepare('INSERT OR IGNORE INTO asset_identity_links(left_id,right_id,merged,at) VALUES(?,?,0,?)')
      .run(...[id, other_id].sort(), now());
  };
  const accept = async (proposal: ProactiveProposal, owner: ExecutionSource): Promise<SituationRef | undefined> => {
    if (proposal.state !== 'proposed') return proposal.result;
    const payload = proposal.payload;
    if (proposal.origin === 'intake' && (typeof payload.fact_id !== 'string' || !deps.mailFacts?.getFact(payload.fact_id))) throw new Error('The source was removed; this proposal needs fresh evidence');
    if (proposal.kind === 'asset') {
      const input = record(payload.asset) as Omit<AssetCreateInput, 'source'>;
      if (proposal.lane === 'gift' && !input.holder_contact) throw new Error('Choose the recipient before tracking a gift');
      const proposedRules = proposal.origin !== 'owner' ? input.rules ?? [] : [];
      if (!Array.isArray(proposedRules) || proposedRules.length > 100) throw new Error('Invalid proposed rules');
      for (const rule of proposedRules) { text(rule?.id, 'Proposed rule id'); text(rule?.title, 'Proposed rule title'); }
      const created = await create({ ...input, ...(proposal.origin !== 'owner' ? { rules: undefined } : {}),
        name: text(input.name, 'Asset name'), idempotency_key: `proposal:${proposal.id}` }, input.class_id ?? undefined, owner,
        proposal.sources.length ? `proposal:${proposal.id}` : undefined);
      // Accepting a thing does not enable rules invented for it. Known preset
      // rows are the declared defaults; guessed rows get their own owner choice.
      for (const rule of proposedRules) {
        const childPayload = { asset_id: created.asset.id, rule: { ...rule, enabled: false, pinned: false }, proposal_class: `asset-rule:${input.class_id ?? 'unclassified'}` };
        if (!proposals.allows({ kind: 'rule', payload: childPayload })) continue;
        proposals.ensure({ key: `asset-rule:${proposal.id}:${rule.id}`, kind: 'rule', title: rule.title,
          explanation: `Proposed rule for ${created.asset.name}. Review its field, condition and schedule before switching it on.`,
          payload: childPayload, sources: proposal.sources, subject: { collection: 'asset', id: created.asset.id }, confidence: proposal.confidence, origin: proposal.origin }, now());
      }
      return { collection: 'asset', id: created.asset.id };
    }
    if (proposal.kind === 'link' || proposal.kind === 'merge') {
      const id = text(payload.asset_id, 'Asset'); const other = text(payload.other_id ?? payload.parent_id, 'Related asset');
      if (proposal.kind === 'merge' || payload.same_thing === true) await sameThing(id, other, proposal.kind === 'merge', owner);
      else await update(id, { belongs_to: other }, owner);
      return { collection: 'asset', id };
    }
    if (proposal.kind === 'rule' || proposal.kind === 'schedule') {
      if (proposal.origin === 'learner' && payload.learning_pool) {
        const ref = typeof payload.asset_id === 'string' ? { collection: 'asset', id: payload.asset_id } : { collection: 'occasion', id: text(payload.occasion_id, 'Occasion') };
        const target = deps.learning?.targetOf(ref, text(payload.rule_id, 'Rule'));
        if (!target || learningDigest(target.rule) !== payload.baseline_rule_hash || learningPool(target.class_id, target.sphere, target.rule) !== payload.learning_pool)
          throw new Error('This rule changed. Review a current suggestion before applying it.');
        const next = { ...(proposal.kind === 'rule' ? record(payload.rule) as unknown as AssetRule : { ...target.rule, schedule: payload.schedule as AssetRule['schedule'] }), enabled: true, pinned: true };
        if (next.id !== target.rule.id) throw new Error('A learning suggestion changes its original rule only');
        if (target.rule.consequence === 'floor' && (next.consequence !== 'floor' || !next.reaction.notify || next.muted
          || next.when.kind !== 'condition' && !next.schedule.before.length && !next.schedule.on_day)) throw new Error('A learning suggestion cannot silence a safety, legal or travel clock');
        if (ref.collection === 'asset') {
          const current = asset(ref.id); const source = deps.work.getSource(current.source_id);
          if (!source?.write_capable || source.source_kind !== 'builtin' || current.sync_state !== 'live') throw new Error('This source cannot confirm a learned rule change');
          const updated = deps.db.transaction(() => {
            const after = deps.work.writeAsset({ id: current.id, source_id: current.source_id, source: { kind: 'owner', ref: `accepted-proposal:${proposal.id}` },
              rules: current.rules.map(rule => rule.id === next.id ? next : rule) }, now());
            proposals.outcome(proposal.id, 'accepted', now(), ref); return after;
          })();
          deps.dispatchers.ruleAssetWritten(updated, current); await deps.occurrences.reconcileAsset(current.id);
        } else {
          const current = history.occasion(ref.id)!;
          deps.db.transaction(() => { history.saveOccasion({ ...current, source_pinned: true, rules: current.rules.map(rule => rule.id === next.id ? next : rule) }, now());
            proposals.outcome(proposal.id, 'accepted', now(), ref); })();
          await deps.reminders?.tick();
        }
        return ref;
      }
      const id = text(payload.asset_id, 'Asset'); const current = asset(id);
      if (payload.apply_class === true) {
        const preset = classes.get(text(payload.class_id, 'Class'));
        if (!preset || preset.version !== payload.preset_version || !classUpdateApplies(current, preset.id, preset.version)) throw new Error('This preset offer has changed; review the current version');
        await applyClass(id, preset.id, owner); return { collection: 'asset', id };
      }
      const next = proposal.kind === 'rule' ? record(payload.rule) as unknown as AssetRule
        : { ...current.rules.find(rule => rule.id === payload.rule_id), schedule: payload.schedule } as AssetRule;
      if (!next.id) throw new Error('Choose the rule');
      await saveRule(id, { ...next, ...(proposal.kind === 'rule' ? { enabled: true } : {}) }, owner, false); return { collection: 'asset', id };
    }
    if (proposal.kind === 'ranking' && typeof payload.item_kind === 'string') {
      // A kind of Today item (§8): no rule, so its pool and weight are the whole check.
      if (!deps.learning) throw new Error('The learner is unavailable');
      const pool = kindLearningPool(payload.item_kind);
      if (payload.learning_pool !== pool || deps.learning.store.weight(pool) !== payload.baseline_weight) throw new Error('This ranking suggestion changed. Refresh it before accepting.');
      // A reservation or a tax form never ranks below where it starts, edited or not.
      const floor = kindRankingFloor(payload.item_kind);
      if (typeof payload.ranking_factor !== 'number' || !Number.isFinite(payload.ranking_factor) || payload.ranking_factor < floor || payload.ranking_factor > 1.5)
        throw new Error(`Choose a ranking factor from ${floor} to 1.5`);
      deps.db.transaction(() => { deps.learning!.store.setWeight(pool, payload.ranking_factor as number); proposals.outcome(proposal.id, 'accepted', now()); })(); return undefined;
    }
    if (proposal.kind === 'ranking') {
      if (!deps.learning) throw new Error('The learner is unavailable');
      const ref = typeof payload.asset_id === 'string' ? { collection: 'asset', id: payload.asset_id } : { collection: 'occasion', id: text(payload.occasion_id, 'Occasion') };
      const target = deps.learning.targetOf(ref, text(payload.rule_id, 'Rule')); const pool = String(payload.learning_pool);
      if (!target || learningDigest(target.rule) !== payload.baseline_rule_hash || learningPool(target.class_id, target.sphere, target.rule) !== pool
        || deps.learning.store.weight(pool) !== payload.baseline_weight) throw new Error('This ranking suggestion changed. Refresh it before accepting.');
      if (typeof payload.ranking_factor !== 'number' || !Number.isFinite(payload.ranking_factor) || payload.ranking_factor < (target.rule.consequence === 'floor' ? 1 : 0.5) || payload.ranking_factor > 1.5)
        throw new Error('Choose a ranking factor from 0.5 to 1.5; a consequence floor cannot be reduced');
      deps.db.transaction(() => { deps.learning!.store.setWeight(pool, payload.ranking_factor as number); proposals.outcome(proposal.id, 'accepted', now(), ref); })(); return ref;
    }
    if (proposal.kind === 'relation') {
      if (!deps.learning) throw new Error('The learner is unavailable'); const raw = record(payload.relation); const target_class = text(raw.target_class, 'Asset class');
      const subject = proposal.subject?.collection === 'asset' ? deps.work.readAssetEffective(proposal.subject.id) : null;
      if (!classes.get(target_class) && subject?.class_id !== target_class) throw new Error('Choose an existing asset class');
      const sphere = raw.sphere === undefined || raw.sphere === null ? undefined : raw.sphere;
      if (sphere !== undefined && sphere !== 'personal' && sphere !== 'professional') throw new Error('Choose a sphere');
      const evidence = Array.isArray(raw.evidence) ? raw.evidence as SituationRef[] : [];
      if (new Set(evidence.map(ref => JSON.stringify(ref))).size < 3 || evidence.length > 10 || evidence.some(ref => !ref || typeof ref.id !== 'string'
        || !deps.learning!.tripExists(ref) || spheres.resolve(ref).sphere !== sphere)) throw new Error('This trip evidence is no longer available in the selected sphere');
      const key = learningDigest(['trip', target_class, sphere]); const result = proposal.subject ?? evidence[0]!;
      deps.db.transaction(() => { deps.learning!.store.setRelation({ key, from: 'trip', target_class, ...(sphere ? { sphere } : {}), evidence });
        proposals.outcome(proposal.id, 'accepted', now(), result); })(); return result;
    }
    if (proposal.kind === 'completion') {
      if (!isAssetDate(payload.on)) throw new Error('Confirm the actual service date');
      if (payload.unit && (typeof payload.reading !== 'number' || !Number.isFinite(payload.reading))) throw new Error('Confirm the actual service reading');
      await deps.occurrences.confirmCompletion({ occurrence_id: text(payload.occurrence_id, 'Occurrence'), on: payload.on,
        ...(payload.unit ? { reading: { value: Number(payload.reading), unit: String(payload.unit) } } : {}) });
      return proposal.subject;
    }
    if (proposal.kind === 'last_done') {
      if (!isAssetDate(payload.on)) throw new Error('Choose the actual last-done date, or use I don’t know');
      await lastDone(text(payload.occurrence_id, 'Occurrence'), payload.on);
      const row = rows.get(String(payload.occurrence_id)); return row ? { collection: 'asset', id: row.asset_id } : undefined;
    }
    if (proposal.kind === 'close') {
      const id = text(payload.asset_id, 'Asset'); const current = asset(id); const rule = current.rules.find(rule => rule.id === payload.rule_id);
      if (!rule || !isAssetDate(payload.on)) throw new Error('Confirm the actual evidence date');
      if (rule.when.kind === 'interval') await deps.occurrences.recordLastDone({ asset_id: id, rule_id: rule.id, on: payload.on,
        confirmed: true, evidence_ref: `proposal:${proposal.id}` });
      else if (rule.when.kind === 'expiry') {
        await deps.occurrences.recordRenewal({ asset_id: id, rule_id: rule.id, on: payload.on, confirmed: true, evidence_ref: `proposal:${proposal.id}` });
      } else throw new Error('This close needs a matching service reading or condition evidence');
      return { collection: 'asset', id };
    }
    if (proposal.kind === 'trip') {
      const trip = record(payload.trip) as unknown as import('@recued/contracts').TripDetails;
      if (!trip.travellers?.length || !trip.destination_country || !trip.entry_on || !trip.exit_on) throw new Error('Choose the travellers, destination and real trip dates');
      trips.save(trip); return trip.subject;
    }
    if (proposal.kind === 'occasion') {
      const input = record(payload.occasion) as unknown as import('@recued/contracts').OccasionInput;
      const episodeIds = Array.isArray(payload.episode_ids) ? payload.episode_ids as string[] : [];
      if (proposal.origin === 'learner' && !deps.learning?.memoryEvidenceAllowed(episodeIds)) throw new Error('This episode evidence is no longer available');
      return deps.db.transaction(() => {
        const occasion = history.saveOccasion({ ...input, id: input.id ?? `occasion-${proposal.id}` }, now());
        for (const id of episodeIds) { const episode = history.episode(id); if (episode) history.saveEpisode({ ...episode, occasion_id: occasion.id, storage_reason: 'recurrence' }, now()); }
        const result = { collection: 'occasion', id: occasion.id }; proposals.outcome(proposal.id, 'accepted', now(), result); return result;
      })();
    }
    if (proposal.kind === 'habit') {
      const episodeIds = Array.isArray(payload.episode_ids) ? payload.episode_ids as string[] : [];
      if (!deps.learning?.habitEvidenceAllowed(proposal)) throw new Error('This standing-task offer needs its original owner-accepted episodes in the same season and sphere');
      const accepted = proposals.list({ kind: 'recall', state: 'accepted', limit: 10000 }).filter(row => episodeIds.includes(String(row.payload.episode_id)));
      const years = new Set(accepted.map(row => Number(String(row.payload.on).slice(0, 4)))); const last = Math.max(...years);
      if (!years.has(last - 1) || !years.has(last - 2)) throw new Error('This standing-task offer needs three consecutive years of owner acceptance');
      const rule = { ...record(payload.rule), enabled: true, pinned: true } as unknown as AssetRule;
      if (rule.when?.kind !== 'expiry' || rule.when.field !== 'next_on' || rule.expiry_policy !== 'strict_expire' || rule.reaction?.occurrence !== 'action' || rule.consequence !== 'routine') throw new Error('An occasion habit is a low-stakes task that expires after its due day');
      let current = typeof payload.occasion_id === 'string' ? history.occasion(payload.occasion_id) : null;
      if (typeof payload.occasion_id === 'string' && (!current || learningDigest(current.rules) !== payload.baseline_occasion_hash)) throw new Error('This occasion changed. Review a new standing-task offer.');
      const proposed = record(payload.occasion) as unknown as import('@recued/contracts').OccasionInput;
      const input = current ?? { ...proposed, id: `occasion-${proposal.id}`, rules: [] };
      const result = deps.db.transaction(() => {
        current ??= history.saveOccasion(input, now());
        if (!deps.learning?.allowsOccasion(current)) throw new Error('This occasion is excluded from memory suggestions');
        const occasion = history.saveOccasion({ ...current, source_pinned: true, rules: [...current.rules.filter(row => row.id !== rule.id), rule] }, now());
        for (const id of episodeIds) { const episode = history.episode(id)!; history.saveEpisode({ ...episode, occasion_id: occasion.id, storage_reason: 'recurrence' }, now()); }
        const result = { collection: 'occasion', id: occasion.id }; proposals.outcome(proposal.id, 'accepted', now(), result); return result;
      })();
      await deps.reminders?.tick(); return result;
    }
    if (proposal.kind === 'recall') {
      if (proposal.origin === 'learner' && deps.situations.readSetting<'on' | 'off' | 'unasked'>('last_time.choice', 'unasked') !== 'on') throw new Error('Last-time suggestions are off');
      const episode = history.episode(text(payload.episode_id, 'Precedent'));
      if (!episode || history.suppressed(episode) || episode.sensitive.length) throw new Error('This precedent is no longer available');
      if (deps.episodeRuntime && !deps.episodeRuntime.episodeAllowed(episode.id)) throw new Error('This precedent is excluded from memory suggestions');
      if (!isAssetDate(payload.on) || payload.on < assetDateAt(now(), deps.timeZone?.() ?? 'UTC')) throw new Error('Review the future date for this task');
      const on = payload.on;
      const statement = text(payload.statement, 'Task');
      const result = deps.db.transaction(() => {
        const value = deps.work.ensureCommitment({ id: `commitment-${proposal.id}`, source_id: 'recued.commitment', direction: 'outbound',
          statement, derivation: 'user_declared', expiry_policy: 'strict_expire', promised_for_at: calendarDayMs(on)!,
          source_extension_blob: { recall_proposal_id: proposal.id, episode_id: episode.id },
        }, now());
        proposals.outcome(proposal.id, 'accepted', now(), { collection: 'commitment', id: value.commitment.id }); return value;
      })();
      if (result.created) deps.dispatchers.ownerCommitmentWritten(result.commitment, owner);
      return { collection: 'commitment', id: result.commitment.id };
    }
    throw new Error('Unknown proposal kind');
  };
  const runOne = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn); mutations.set(key, next);
    void next.finally(() => { if (mutations.get(key) === next) mutations.delete(key); }).catch(() => {}); return next;
  };
  const command = async (input: YoursCommand, owner: ExecutionSource): Promise<YoursCommandResult> => {
    requireOpen();
    if (!owner || owner.channel !== 'user' || owner.actor !== 'user_self') throw new Error('Yours changes require the owner');
    if (!input || JSON.stringify(input).length > 256000) throw new Error('Invalid or oversized Yours change');
    switch (input.action) {
      case 'asset.create': { const result = await create(input.input, input.class_id, owner); return { id: result.asset.id, message: 'Asset created.' }; }
      case 'asset.update': {
        const previous = asset(input.id);
        if (input.patch.status && ['sold', 'lost', 'retired'].includes(input.patch.status) && input.patch.status !== previous.status && !input.confirm_retirement) throw new Error('Review the parts, contracts and open occurrences before retiring this asset');
        await update(input.id, input.patch, owner); return { id: input.id, message: 'Asset updated.' };
      }
      case 'asset.delete': if (!input.confirmed) throw new Error('Confirm removing the asset and its open clocks');
        await deps.dispatchers.assetDelete({ id: input.id }); return { message: 'Asset removed.' };
      case 'asset.automatic_updates': {
        const { asset } = await deps.dispatchers.assetAllowAutomaticUpdates({ id: input.id, path: input.path, expected: input.expected }, owner);
        return { message: asset.field_sources[input.path]?.kind === 'observation'
          ? 'Automatic updates are already active for this field.'
          : 'Automatic updates allowed. Your entry stays until a fresh authorized observation arrives.' };
      }
      case 'asset.link': await update(input.id, { belongs_to: input.parent_id }, owner); return { message: 'Parent updated.' };
      case 'asset.same_thing': await sameThing(input.id, input.other_id, input.merge, owner); return { message: input.merge ? 'References now point to the kept asset. Both source records remain in history.' : 'The two source records are linked.' };
      case 'class.save': classes.saveOwner(input.preset); return { id: input.preset.id, message: 'Class saved. Existing assets keep their edited rows.' };
      case 'class.delete': classes.deleteOwner(input.id); return { message: 'Class removed. Existing assets keep their rules.' };
      case 'class.apply': await applyClass(input.asset_id, input.class_id, owner); return { message: 'Class applied; pinned rules and known facts kept.' };
      case 'proposal.create': { const proposal = proposals.ensure({ ...input.proposal, origin: 'owner' }, now()); return { id: proposal.id, message: 'Proposal saved for review.' }; }
      case 'proposal.edit': proposals.edit(input.id, { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.payload !== undefined ? { payload: input.payload } : {}) }, now()); return { message: 'Proposal updated.' };
      case 'proposal.accept': {
        if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 || input.ids.some(id => typeof id !== 'string')) throw new Error('Choose up to 100 proposals');
        let changed = 0; const failed: NonNullable<YoursCommandResult['failed']> = [];
        for (const id of new Set(input.ids)) {
          try { await runOne(id, async () => { const proposal = proposals.read(id); if (!proposal) throw new Error('Proposal not found');
            const result = await accept(proposal, owner); proposals.outcome(id, 'accepted', now(), result); }); changed += 1; }
          catch (error) { failed.push({ id, reason: error instanceof Error ? error.message : String(error) }); }
        }
        return { changed, ...(failed.length ? { failed } : {}), message: `${changed} proposal${changed === 1 ? '' : 's'} accepted.${failed.length ? ` ${failed.length} need more information.` : ''}` };
      }
      case 'proposal.dismiss': {
        if (!['not_now', 'not_this_one', 'never_this_kind', 'wrong', 'not_an_asset'].includes(input.code)) throw new Error('Choose a dismissal reason');
        const proposal = proposals.read(input.id); if (!proposal) throw new Error('Proposal not found');
        if (input.code === 'wrong') {
          if (proposal.kind === 'recall' && input.episode_correction) {
            const id = text(input.episode_correction.id, 'Episode');
            if (id !== proposal.payload.episode_id) throw new Error('Correct this proposal’s own episode');
            const previous = history.episode(id);
            history.saveEpisode({ ...input.episode_correction, basis: 'declared', storage_reason: 'owner_correction' }, now());
            history.recordOwnerCorrection(id, now(), previous?.assembly_rule);
            deps.situations.measure('episode.correction', 1, { basis: previous?.basis ?? 'inferred' }, now(), `episode-correction:${id}:${now()}`);
          } else {
            if (!input.correction) throw new Error('Choose the underlying fact to correct');
            await update(input.correction.asset_id, input.correction.patch, owner);
          }
        }
        if (input.code === 'never_this_kind') proposals.saveSuppression({ kind: 'proposal_kind', value: String(proposal.payload.proposal_class ?? proposal.kind) }, now());
        if (proposal.kind === 'recall' && input.code === 'not_this_one' && typeof proposal.payload.episode_id === 'string') history.suppressEpisode(proposal.payload.episode_id, now());
        proposals.outcome(input.id, input.code, now()); return { message: input.code === 'not_now' ? 'Put aside for this window.' : input.code === 'never_this_kind' ? 'Stopped suggestions of this kind.' : input.code === 'wrong' ? 'Fact corrected and proposal dismissed.' : 'This proposal was dismissed.' };
      }
      case 'proposal.delete': proposals.delete(input.id); return { message: 'Proposal removed.' };
      case 'source.set': proposals.setSource(input.id, input.enabled); return { message: input.enabled ? 'Proposals enabled for this source.' : 'New proposals stopped for this source.' };
      case 'merchant.stop': proposals.saveSuppression({ kind: 'merchant', value: text(input.merchant, 'Merchant') }, now()); return { message: 'New proposals stopped for this merchant.' };
      case 'intake.forget': if (!input.confirmed) throw new Error('Confirm forgetting unaccepted extractions');
        { const forgotten = intake.forget(); for (const id of forgotten) deps.situations.forget(`proposal:${id}`);
          return { changed: forgotten.length, message: 'Unaccepted extractions forgotten. Emails and assets you accepted remain yours.' }; }
      case 'intake.scan': await intake.scan(); return { message: 'Local receipts checked.' };
      case 'occurrence.last_done': await lastDone(input.id, input.on); return { message: input.on ? 'Actual date recorded; next cycle updated.' : 'Left unknown. This question will not repeat.' };
      case 'occurrence.later': if (!deps.reminders) throw new Error('Reminder delivery is unavailable');
        await deps.reminders.setLater(input.id, input.until); return { message: 'Next reminder moved. The deadline and schedule stay the same.' };
      case 'rule.save': await saveRule(input.asset_id, input.rule, owner, input.confirm_floor_mute); return { message: 'Rule saved.' };
      case 'rule.delete': {
        const current = asset(input.asset_id); const rule = current.rules.find(rule => rule.id === input.rule_id);
        if (rule?.consequence === 'floor' && !input.confirm_floor_delete) throw new Error('Confirm removing this safety, legal or travel clock');
        await update(current.id, { rules: current.rules.filter(rule => rule.id !== input.rule_id) }, owner); return { message: 'Rule removed; its open occurrence is cancelled.' };
      }
      case 'suppression.save': return { id: proposals.saveSuppression(input.suppression, now()).id, message: 'Suppression saved for all memory suggestions.' };
      case 'suppression.delete': proposals.deleteSuppression(input.id); return { message: 'Suppression removed.' };
      case 'sphere.source': { const result = spheres.setSource(input.source, input.sphere); return { message: `Source placement updated. ${result.retained} items keep the placement you pinned.` }; }
      case 'sphere.item':
        if (input.ref.collection === 'asset') {
          const prior = asset(input.ref.id); const source = deps.work.getSource(prior.source_id);
          if (prior.sync_state !== 'live' || !source?.write_capable || source.source_kind !== 'builtin') throw new Error('This asset source cannot confirm a placement change');
          const updated = deps.db.transaction(() => {
            spheres.setItem(input.ref, input.sphere);
            return deps.work.writeAsset({ id: prior.id, source_id: prior.source_id, source: { kind: 'owner', ref: `owner:${owner.user_id}` }, sphere_override: input.sphere }, now());
          })();
          deps.dispatchers.ruleAssetWritten(updated, prior);
        } else spheres.setItem(input.ref, input.sphere);
        return { message: 'Item placement updated. You can apply it to its source separately.' };
      case 'unmatched.dismiss': await notifier?.dismissUnmatchedAskReply(input.id); return { message: 'Unmatched reply dismissed; no item changed.' };
      case 'occasion.save': {
        const previous = input.occasion.id ? history.occasion(input.occasion.id) : null;
        if (previous && !input.confirm_floor_mute && previous.rules.some(rule => rule.enabled && !rule.muted && rule.consequence === 'floor' && (() => {
          const next = input.occasion.rules.find(value => value.id === rule.id);
          return input.occasion.muted || silencesClock(next);
        })())) throw new Error('Confirm stopping this safety, legal or travel clock');
        const occasion = history.saveOccasion({ ...input.occasion,
          ...(previous?.source ? { source_pinned: true, ...(previous.month_day !== input.occasion.month_day ? { source_next_on: undefined } : {}) } : {}) }, now());
        await deps.reminders?.tick(); return { id: occasion.id, message: 'Occasion saved with its annual clock.' };
      }
      case 'occasion.delete':
        if (!input.confirm_floor_delete && history.occasion(input.id)?.rules.some(rule => rule.enabled && rule.consequence === 'floor')) throw new Error('Confirm removing this safety, legal or travel clock');
        history.deleteOccasion(input.id); await deps.reminders?.tick(); return { message: 'Occasion removed; its open clocks will be withdrawn.' };
      case 'episode.save': {
        const previous = input.episode.id ? history.episode(input.episode.id) ?? (await deps.episodeRuntime?.ownerEpisodes())?.find(row => row.id === input.episode.id) : null;
        const episode = history.saveEpisode({ ...input.episode, ...(input.episode.where ? { where: history.place(input.episode.where.name) } : {}),
          basis: 'declared', storage_reason: previous ? 'owner_correction' : 'owner_record' }, now());
        if (previous?.basis !== 'declared' && previous) {
          history.recordOwnerCorrection(episode.id, now(), previous.assembly_rule);
          deps.situations.measure('episode.correction', 1, { basis: previous.basis }, now(), `episode-correction:${episode.id}:${now()}`);
        }
        return { id: episode.id, message: 'Episode saved from your record.' };
      }
      case 'episode.delete': {
        // An assembled episode is not stored, so its evidence comes from the assembly.
        const assembled = history.episode(input.id) ? undefined : (await deps.episodeRuntime?.ownerEpisodes())?.find(row => row.id === input.id);
        history.deleteEpisode(input.id, now(), input.suppress !== false, assembled?.evidence, assembled?.title);
        return { message: 'Episode removed. It will not be suggested again.' };
      }
      case 'episode.hide': {
        const id = text(input.id, 'Episode');
        const found = history.episode(id) ?? (await deps.episodeRuntime?.ownerEpisodes())?.find(row => row.id === id);
        if (!found) throw new Error('Episode not found');
        history.suppressEpisode(id, now(), found.evidence, found.title);
        return { message: 'Hidden. Recued will not show it again or suggest anything from it. Undo it under Memory exclusions in Episodes.' };
      }
      case 'recall.class': if (!deps.episodeRuntime) throw new Error('Recall is unavailable');
        deps.episodeRuntime.setClassBar(input.class_id, input.minimum_rate); await deps.episodeRuntime.tick(); return { message: 'Your measured recall rate is saved. Surfacing still needs your separate opt-in.' };
      case 'history.forget': if (!input.confirmed) throw new Error('Confirm forgetting retained memory evidence');
        deps.episodeRuntime?.forget(); return { message: 'Retained memory evidence and dark scores forgotten. Your own records remain.' };
      case 'household.telegram': {
        if (input.connection_name === null) { household.setTelegram(null); return { message: 'Household Telegram reminders stopped.' }; }
        const row = deps.connections?.().find(row => row.kind === 'notification' && row.name === input.connection_name && row.enrolled_at === input.connection_enrolled_at);
        if (!row) throw new Error('Choose the currently enrolled Telegram group');
        household.setTelegram(row, input.members ?? [], now()); return { message: 'Only household items will reach this group. Only its selected members can answer.' };
      }
      case 'household.home_assistant': {
        if (!deps.homeAssistant) throw new Error('Home Assistant household delivery is unavailable');
        await deps.homeAssistant.configure(input); return { message: input.connection_name === null ? 'Home Assistant projection stopped.' : 'Home Assistant list saved. Only household tasks reach it.' };
      }
      case 'trip.save': trips.save(input.trip); return { message: 'Trip details saved. Each traveller’s own passport is checked.' };
      case 'binding.save': {
        const current = asset(input.asset_id); const row = recipes?.getStored(input.recipe_id);
        if (!['active', 'lent'].includes(current.status) || current.sync_state !== 'live') throw new Error('Choose an active local asset before enrolling its writer');
        if (!row) throw new Error('Select an installed recipe');
        const recipe = recipes!.get(input.recipe_id);
        if (!recipe || definitionDigest(recipe) !== definitionDigest(JSON.parse(row.recipe_json))) throw new Error('The effective recipe differs from its installed version. Review that version first');
        if (!observationRecipe(recipe)) throw new Error('This installed recipe has no asset observation write');
        const recipe_hash = definitionDigest(recipe); const actor_ref = `recipe:${input.recipe_id}`;
        const source_ref = `recipe:${row.publisher_id}/${input.recipe_id}#${recipe_hash}`;
        const id = `binding-${createHash('sha256').update(JSON.stringify([current.id, actor_ref, source_ref])).digest('hex')}`;
        deps.db.transaction(() => {
          for (const old of deps.work.listAssetObservationBindings(current.id)) if (old.actor_ref === actor_ref && old.id !== id && old.enabled) deps.work.bindAssetObservations({ ...old, enabled: false });
          deps.work.bindAssetObservations({ id, asset_id: current.id, actor_ref, source_ref, recipe_hash, fields: input.fields, enabled: true });
        })();
        return { id, message: 'This recipe version can write only the selected readings and conditions. Copy its binding id into the recipe settings.' };
      }
      case 'binding.disable': {
        const old = deps.work.listAssetObservationBindings(input.asset_id).find(row => row.id === input.id); if (!old) throw new Error('Binding not found');
        deps.work.bindAssetObservations({ ...old, enabled: false }); return { message: 'Observation writer disabled.' };
      }
      case 'file.attach': {
        asset(input.asset_id); if (!deps.annotations) throw new Error('File links are unavailable');
        const id = text(input.record_id, 'File');
        if (!id.startsWith('file:')) throw new Error('Choose a file from the file browser');
        const old = (await deps.annotations.listLinks({ from_collection: 'asset', from_id: input.asset_id, role: 'attachment', to_collection: 'file', to_id: id })).find(row => row.to_collection === 'file' && row.to_id === id);
        const link = old ?? await deps.annotations.link({ from_collection: 'asset', from_id: input.asset_id, to_collection: 'file', to_id: id,
          role: 'attachment', authored_by_recipe_id: 'owner', origin_actor: 'user_self', origin_surface: 'client_rpc' });
        return { id: link._id, message: 'File attached by reference.' };
      }
      case 'file.detach': {
        const current = asset(input.asset_id); if (!deps.annotations) throw new Error('File links are unavailable');
        const links = await deps.annotations.listLinks({ from_collection: 'asset', from_id: input.asset_id, role: 'attachment', to_collection: 'file', to_id: text(input.record_id, 'File') });
        const link = links.find(row => row._id === input.link_id);
        if (!link) throw new Error('Attachment not found');
        const documents = { ...record(current.attributes[ASSET_DOCUMENT_DETAILS_ATTRIBUTE]) };
        if (links.length === 1 && Object.hasOwn(documents, link.to_id)) {
          delete documents[link.to_id];
          await update(current.id, { attributes: { [ASSET_DOCUMENT_DETAILS_ATTRIBUTE]: documents } }, owner);
        }
        await deps.annotations.deleteLink(link._id); return { message: 'Attachment removed.' };
      }
      case 'file.details': {
        const current = asset(input.asset_id); if (!deps.annotations) throw new Error('File links are unavailable');
        const details = normalizeAssetDocumentDetails(input.details);
        const link = (await deps.annotations.listLinks({ from_collection: 'asset', from_id: current.id, role: 'attachment', to_collection: 'file', to_id: text(input.record_id, 'File') })).find(row => row._id === input.link_id);
        if (!link) throw new Error('Attachment not found');
        const documents = { ...record(current.attributes[ASSET_DOCUMENT_DETAILS_ATTRIBUTE]) };
        if (Object.keys(details).length) documents[link.to_id] = details; else delete documents[link.to_id];
        await update(current.id, { attributes: { [ASSET_DOCUMENT_DETAILS_ATTRIBUTE]: documents } }, owner);
        return { message: 'Document details saved.' };
      }
      case 'place.save': {
        const known = history.place(input.name);
        return { id: history.savePlace({ ...input, ...(!input.key && !known.key.startsWith('label:') ? { key: known.key, name: known.name } : {}) }).key, message: 'Place names now refer to the same place.' };
      }
      case 'delivery.update': if (!scheduled) throw new Error('The overview service is unavailable'); scheduled.setSettings(input.settings); return { message: 'Overview schedule saved.' };
      case 'delivery.send_now': if (!scheduled) throw new Error('The overview service is unavailable'); await scheduled.sendNow(); return { message: 'Overview checked. It sends only when something changed.' };
      case 'subscriber.reconciled': {
        const receipt = deps.situations.subscriberRun(input.subscriber_id, input.revision);
        if (!receipt || receipt.run_id !== input.run_id || receipt.state === 'completed') throw new Error('This subscriber receipt changed. Refresh before reconciling it.');
        deps.situations.finishSubscriberRun(input.subscriber_id, input.revision, 'completed', now());
        return { message: 'The reconciled revision will be acknowledged. Its run will not be repeated.' };
      }
      case 'subscriber.contract': {
        if (!subscribers || !subscribers.store.get(input.trigger_id)) throw new Error('Subscriber not found');
        if (input.contract_id !== null) {
          const contract = subscribers.contracts.get(input.contract_id);
          if (!contract || (contract.grant_kind ?? 'standing') !== 'standing' || contract.revoked_at != null || (contract.expiry_at != null && contract.expiry_at <= now())) throw new Error('Select a live standing contract');
        }
        subscribers.store.update(input.trigger_id, { read_contract_id: input.contract_id }); subscribers.changed();
        return { message: 'Subscriber contract saved. Its reads and event values use that contract; changing it invalidates an earlier execution review.' };
      }
      case 'settings.update':
        if (input.digest !== undefined) { if (!['daily', 'weekly', 'off'].includes(input.digest)) throw new Error('Invalid delivery schedule'); deps.situations.writeSetting('digest.frequency', input.digest); }
        if (input.last_time !== undefined) { if (!['on', 'off'].includes(input.last_time)) throw new Error('Invalid last-time choice');
          deps.situations.writeSetting('last_time.choice', input.last_time); await deps.episodeRuntime?.settleChoice(); }
        if (input.measures !== undefined) { if (typeof input.measures !== 'boolean') throw new Error('Invalid measures choice');
          if (input.measures && !deps.situations.readSetting('metrics.opt_in', false)) deps.situations.writeSetting('metrics.enabled_at', now());
          deps.situations.writeSetting('metrics.opt_in', input.measures); }
        return { message: 'Proactive settings saved.' };
      case 'navigation.open': {
        if (!input.ref || !['asset', 'booking', 'calendar', 'mail_fact'].includes(input.ref.collection) || typeof input.ref.id !== 'string' || !input.ref.id || input.ref.id.length > 2000)
          throw new Error('Choose a record to open');
        if (owner.channel === 'user' && owner.actor === 'user_self') {
          deps.learning?.recordOpened(input.ref, learningDigest(owner.client_token_id ?? owner.user_id));
          // Option A — a bill or a delivery opened from Today counts as acting on its kind (§8).
          const kind = input.from === 'today' && input.ref.collection === 'mail_fact' ? deps.mailFacts?.getThing(input.ref.id)?.type : undefined;
          if (kind) deps.learning?.recordKindSignal({ id: `opened:${input.ref.id}`, kind, ref: input.ref, outcome: 'opened' });
        }
        return { message: 'Context recorded.' };
      }
      case 'situation.dismiss': {
        const ref = input.ref as SituationRef | undefined;
        if (!ref || typeof ref.collection !== 'string' || !ref.collection || typeof ref.id !== 'string' || !ref.id || ref.id.length > 2000
          || (ref.field !== undefined && (typeof ref.field !== 'string' || ref.field.length > 2000)) || typeof input.kind !== 'string'
          || !/^[a-z][a-z0-9_]{0,63}$/u.test(input.kind) || !['not_now', 'not_this_one', 'never_this_kind', 'wrong'].includes(input.code)) throw new Error('Choose an item and an answer');
        const label = text(input.label, 'Item').slice(0, 200); const at = now();
        if (deps.situations.readSetting('metrics.opt_in', false)) {
          deps.situations.measure('situation.dismissal', 1, { code: input.code, kind: input.kind }, at);
          recordDigestResponse(deps.situations, [ref], at);
        }
        // "That's wrong" corrects the record itself; the item then follows the record.
        if (input.code === 'wrong') return { message: 'Correct it on its page; this item follows the record.' };
        const zone = deps.timeZone?.() ?? 'UTC'; const scope = input.code === 'never_this_kind' ? 'kind' as const : 'item' as const;
        const key = scope === 'kind' ? situationKindKey(input.kind) : situationItemKey(ref);
        dismissals.dismiss({ key, scope, code: input.code, label, kind: input.kind, at,
          ref: scope === 'item' ? { collection: ref.collection, id: ref.id, ...(ref.field ? { field: ref.field } : {}) } : null,
          until: input.code === 'not_now' ? zonedWallClockToEpochMs(shiftAssetDate(assetDateAt(at, zone), { amount: 1, unit: 'days' }), zone) : null });
        // Option A — setting a bill or a delivery aside teaches the learner; "Not now" is only
        // timing (§8). Its kind is the item's own, read here, not the one the page sent.
        const itemKind = input.code !== 'not_now' && ref.collection === 'mail_fact' ? deps.mailFacts?.getThing(ref.id)?.type : undefined;
        if (itemKind) deps.learning?.recordKindSignal({ id: `dismissal:${key}`, kind: itemKind, ref, outcome: 'dismissed', at });
        return { id: key, message: input.code === 'not_now' ? `Hidden until tomorrow: ${label}.` : input.code === 'not_this_one' ? `Won't show this again: ${label}.`
          : `Won't show ${DISMISSED_KINDS[input.kind] ?? kindWords(input.kind, deps.mailFacts?.getCustomType(input.kind)?.name)} again.` };
      }
      case 'situation.restore':
        if (typeof input.key !== 'string' || !input.key || input.key.length > 4200) throw new Error('Choose what to show again');
        deps.learning?.forgetKindSignal(`dismissal:${input.key}`);
        return { message: dismissals.restore(input.key) ? 'Shown again.' : 'That was already showing.' };
      default: throw new Error('Unknown Yours change');
    }
  };
  const sphereSources = () => {
    const sources = new Map<string, NonNullable<YoursSnapshot['sphere_sources']>[number]>();
    for (const row of deps.sphereSources?.() ?? []) sources.set(row.source, { ...row });
    // Stored sources keep their label precedence and the descriptor's position.
    for (const { source, sphere } of spheres.sources()) sources.set(source, { source, name: source, ...(sphere ? { sphere } : {}) });
    return [...sources.values()];
  };
  const snapshot = async (input: YoursReadRequest = {}): Promise<YoursSnapshot> => {
    requireOpen(); deps.episodeRuntime?.refreshSuppressed(); deps.learning?.refreshPending(); refreshQuestions(); refreshClassUpdates(); refreshTrips(); await refreshEvidence(); mailProof.scan();
    publishProposalEvents(proposals, deps.situations, spheres);
    const limit = input.limit ?? 50; const offset = input.offset ?? 0;
    if (input.contact_id !== undefined && (typeof input.contact_id !== 'string' || !input.contact_id || input.contact_id.length > 2000)) throw new Error('Choose the contact for this history');
    if (input.proposal_kind !== undefined && !PROACTIVE_PROPOSAL_KINDS.includes(input.proposal_kind)) throw new Error('Unknown proposal kind');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid Yours page');
    if (input.asset_filter !== undefined && !['missing_facts', 'overdue'].includes(input.asset_filter)) throw new Error('Unknown asset filter');
    if (input.asset_sphere !== undefined && !['personal', 'professional', 'unsorted'].includes(input.asset_sphere)) throw new Error('Unknown asset sphere');
    if (input.asset_id && (input.asset_filter || input.asset_sphere)) throw new Error('Asset filters apply to the asset list');
    const searchQuery = input.search ? { search: input.search } : {};
    const summaryAt = now(); const summaryZone = deps.timeZone?.() ?? 'UTC';
    const summarize = (asset: Asset, occurrences?: readonly AssetOccurrence[], summaryWork?: Pick<WorkEntityStore, 'readCommitment' | 'assetReadingHistory'>): YoursAssetSummary | undefined => {
      try { return summarizeYoursAsset(asset, { work: summaryWork ?? deps.work, occurrences: occurrences ?? rows.byAsset(asset.id), now: summaryAt, timeZone: summaryZone }); }
      catch (error) { console.warn('[yours] Asset summary unavailable', asset.id, error); return undefined; }
    };
    let assets: Asset[]; let total_assets: number; let unavailable = 0;
    const asset_summaries: YoursAssetSummary[] | undefined = input.include_asset_summaries === true ? [] : undefined;
    const assetPlacements = new Map<string, ReturnType<typeof spheres.resolve>>();
    if (input.asset_filter || input.asset_sphere) {
      assets = []; total_assets = 0;
      // Only a filtered read scans beyond the requested page. Keep the ordinary
      // list's ordering and search, and retain at most one page of projections.
      for (let scanOffset = 0; ; scanOffset += 200) {
        const batch = deps.work.listByKind('asset', { ...searchQuery, limit: 200, offset: scanOffset });
        const placements = input.asset_sphere ? spheres.resolveAssets(batch.filter(asset => asset._kind === 'asset').map(asset => asset.id)) : undefined;
        const candidates = batch.filter((asset): asset is Asset & { _kind: 'asset' } => asset._kind === 'asset'
          && (!input.asset_sphere || (placements?.get(asset.id)?.sphere ?? 'unsorted') === input.asset_sphere));
        let occurrenceBatch: ReturnType<typeof rows.byAssets> | undefined;
        let summaryWork: Pick<WorkEntityStore, 'readCommitment' | 'assetReadingHistory'> | undefined;
        if (input.asset_filter) {
          try { occurrenceBatch = rows.byAssets(candidates.map(asset => asset.id)); }
          catch { /* Keep the guarded individual reads and per-asset unavailable counts. */ }
          try {
            const histories = deps.work.assetReadingHistories(candidates.flatMap(asset => asset.deleted_at == null
              && ['live', 'stale_unreachable'].includes(asset.sync_state) && ['active', 'lent'].includes(asset.status)
              ? asset.rules.flatMap(rule => rule.enabled && rule.when.kind === 'objective' ? [{ asset_id: asset.id, field: rule.when.field }] : []) : []));
            summaryWork = { readCommitment: deps.work.readCommitment, assetReadingHistory: (id, field, limit) =>
              (limit === undefined || limit === 100 ? histories.get(id)?.get(field) : undefined) ?? deps.work.assetReadingHistory(id, field, limit) };
          } catch { /* Preserve individual history errors within the guarded summary. */ }
        }
        // No await between this page's receipt/history reads and its summaries.
        for (const asset of candidates) {
          const placement = placements?.get(asset.id);
          let summary: YoursAssetSummary | undefined;
          if (input.asset_filter) {
            summary = summarize(asset, occurrenceBatch?.get(asset.id), summaryWork);
            if (!summary) { unavailable++; continue; }
            if (!(input.asset_filter === 'missing_facts' ? summary.missing.length > 0 : summary.next_due?.state === 'overdue')) continue;
          }
          const index = total_assets++;
          if (index >= offset && assets.length < limit) {
            const effective = deps.work.readAssetEffective(asset.id);
            if (effective) {
              assets.push(effective);
              if (placement) assetPlacements.set(asset.id, placement);
              if (asset_summaries) { const pageSummary = summary ?? summarize(effective); if (pageSummary) asset_summaries.push(pageSummary); }
            }
          }
        }
        if (batch.length < 200) break;
      }
    } else {
      assets = input.asset_id ? [deps.work.readAssetEffective(input.asset_id)].filter((row): row is Asset => !!row && row.deleted_at == null)
        : deps.work.listByKind('asset', { limit, offset, ...searchQuery }).flatMap(row => row._kind === 'asset' ? [deps.work.readAssetEffective(row.id)!] : []);
      total_assets = deps.work.countByKind('asset', searchQuery);
      if (asset_summaries) for (const asset of assets) { const summary = summarize(asset); if (summary) asset_summaries.push(summary); }
    }
    if (input.proposal_offset !== undefined && (!Number.isSafeInteger(input.proposal_offset) || input.proposal_offset < 0)) throw new Error('Invalid proposal page');
    // §15.2 — a suggestion also shows on the asset or occasion it would change (P42).
    const subject = input.asset_id ? { collection: 'asset', id: input.asset_id } : input.occasion_id ? { collection: 'occasion', id: input.occasion_id } : undefined;
    const shown = proposals.list({ state: 'proposed', ...(subject ? { subject } : {}), ...(input.proposal_kind ? { kind: input.proposal_kind } : {}), limit, offset: input.proposal_offset ?? 0 });
    if (input.mark_shown === true) for (const proposal of shown) proposals.markShown(proposal.id, now());
    const today = assetDateAt(now(), deps.timeZone?.() ?? 'UTC');
    // A notice has no commitment to close, so it stays listed only while its
    // clock still stands at that cycle; a past birthday or renewed date drops out.
    const notice = (row: AssetOccurrence): { title: string; due_on: string | null } | null => {
      if (row.subject_kind === 'occasion') {
        const occasion = history.occasion(row.asset_id); const rule = occasion?.rules.find(rule => rule.id === row.rule_id);
        return occasion && (input.include_closed || occasionNextDate(occasion, today) === row.cycle) ? { title: ruleNotice(occasion.title, rule), due_on: row.cycle } : null;
      }
      const asset = deps.work.readAssetEffective(row.asset_id); const rule = asset?.rules.find(rule => rule.id === row.rule_id);
      if (!asset || asset.deleted_at != null || !rule) return null;
      const title = `${asset.name}: ${rule.title}`;
      try {
        const clock = assetOccurrenceClock({ asset, rule, row, now: now(), timeZone: deps.timeZone?.() ?? 'UTC',
          ...(rule.when.kind === 'objective' ? { readings: deps.work.assetReadingHistory(asset.id, rule.when.field) } : {}) });
        return clock || input.include_closed ? { title, due_on: clock?.due_on ?? null } : null;
      } catch (error) {
        console.warn('[yours] Asset notice clock unavailable', row.id, error);
        return input.include_closed ? { title, due_on: null } : null;
      }
    };
    const occurrences = rows.all().filter(row => (!input.asset_id || row.subject_kind !== 'occasion' && row.asset_id === input.asset_id)
      && (!input.occasion_id || row.subject_kind === 'occasion' && row.asset_id === input.occasion_id)).flatMap(row => {
      const commitment = row.commitment_id ? deps.work.readCommitment(row.commitment_id) : null;
      if (!input.include_closed && commitment && commitment.lifecycle_state !== 'pending') return [];
      const label = commitment ? { title: commitment.statement, due_on: commitment.promised_for_at === undefined ? null : new Date(commitment.promised_for_at).toISOString().slice(0, 10) } : notice(row);
      if (!label) return [];
      const control = points.control(row.id); return [{ id: row.id, asset_id: row.asset_id, ...(row.subject_kind ? { subject_kind: row.subject_kind } : {}), rule_id: row.rule_id,
        ...label, question: row.question, commitment, current_ask_id: control.current_ask_id, later_until: control.later_until,
        ...(commitment?.lifecycle_state === 'pending' && proofTarget(row, id => deps.work.readAsset(id)) ? { closes_by_proof: true as const } : {}) }];
    }).sort((a, b) => (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999'));
    const destinations = await notifier?.getReminderDestinations();
    const children = input.asset_id ? deps.work.listAssetChildren(input.asset_id) : [];
    const descendants: Asset[] = []; const seen = new Set<string>(input.asset_id ? [input.asset_id] : []);
    const queue = [...children];
    while (queue.length) {
      const row = queue.shift()!; if (seen.has(row.id)) continue; seen.add(row.id); descendants.push(row);
      if (row.retirement === 'part') queue.push(...deps.work.listAssetChildren(row.id));
    }
    const retiring = new Set([...(input.asset_id ? [input.asset_id] : []), ...descendants.filter(row => row.retirement === 'part').map(row => row.id)]);
    const affectedOpen = rows.all().filter(row => retiring.has(row.asset_id) && row.commitment_id && deps.work.readCommitment(row.commitment_id)?.lifecycle_state === 'pending').length;
    const parent = input.asset_id && assets[0]?.belongs_to ? deps.work.readAssetEffective(assets[0].belongs_to) : null;
    const linked = input.asset_id ? (deps.db.prepare('SELECT left_id,right_id FROM asset_identity_links WHERE left_id=? OR right_id=?').all(input.asset_id, input.asset_id) as { left_id: string; right_id: string }[])
      .flatMap(row => { const linked = deps.work.readAssetEffective(row.left_id === input.asset_id ? row.right_id : row.left_id); return linked ? [linked] : []; }) : [];
    // P44 — an occasion's page lists its own history, and no list shows an episode the
    // owner hid; at its own address it still opens.
    let episodes = input.episode_id ? [history.episode(input.episode_id)].filter((value): value is NonNullable<typeof value> => !!value)
      : history.listedEpisodes({ ...(input.contact_id ? { person: input.contact_id } : {}), ...(input.occasion_id ? { occasion: input.occasion_id } : {}) }, limit, offset);
    let derived: import('@recued/contracts').EpisodeInput[] | undefined;
    if (input.include_derived && deps.episodeRuntime) {
      const computed = await deps.episodeRuntime.ownerEpisodes(); const kept = new Map<string, import('@recued/contracts').Episode>();
      if (input.episode_id) { const value = history.episode(input.episode_id); if (value) kept.set(value.id, value); }
      else for (let skip = 0; ;) { const page = history.episodes(500, skip); if (!page.length) break; for (const row of page) kept.set(row.id, row); skip += page.length; }
      const combined = new Map(computed.filter(row => row.id && (!input.episode_id || row.id === input.episode_id)).map(row => [row.id!, row]));
      for (const [id, row] of kept) combined.set(id, row);
      const page = [...combined.values()].sort((a, b) => b.when.from - a.when.from || a.id!.localeCompare(b.id!)).slice(offset, offset + limit);
      episodes = page.flatMap(row => kept.has(row.id!) ? [kept.get(row.id!)!] : []); derived = page.filter(row => !kept.has(row.id!));
    }
    if (input.contact_id) { episodes = episodes.filter(row => row.people.includes(input.contact_id!)); derived = derived?.filter(row => row.people.includes(input.contact_id!)); }
    for (const episode of derived ?? []) history.recordShown(episode, now());
    const occasions = (input.occasion_id ? [history.occasion(input.occasion_id)].filter((value): value is NonNullable<typeof value> => !!value)
      : input.contact_id ? history.forPerson('occasion', input.contact_id, limit, offset) : history.occasions(limit, offset)).filter(row => !input.contact_id || row.people.includes(input.contact_id));
    const placementRefs: SituationRef[] = [...assets.map(row => ({ collection: 'asset', id: row.id })),
      ...occurrences.map(row => row.commitment ? { collection: 'commitment', id: row.commitment.id } : { collection: row.subject_kind === 'occasion' ? 'occasion' : 'asset', id: row.asset_id }),
      ...occasions.map(row => ({ collection: 'occasion', id: row.id })), ...episodes.map(row => ({ collection: 'episode', id: row.id })),
      ...(derived ?? []).flatMap(row => row.id ? [{ collection: 'episode', id: row.id }] : []),
      ...shown.flatMap(row => row.subject ?? row.sources[0] ? [row.subject ?? row.sources[0]!] : [])];
    // Delivery reads above can yield to an owner placement change. Keep the
    // displayed asset's placement from the same selection that counted it.
    const uniquePlacementRefs = [...new Map(placementRefs.map(ref => [JSON.stringify(ref), ref])).values()];
    const remainingAssetIds = uniquePlacementRefs.flatMap(ref => ref.collection === 'asset' && !assetPlacements.has(ref.id) ? [ref.id] : []);
    if (remainingAssetIds.length) {
      try {
        const current = spheres.resolveAssets(remainingAssetIds);
        for (const [id, placement] of current) assetPlacements.set(id, placement);
      } catch { /* Keep ordinary resolution and its error behavior if the batch fails. */ }
    }
    const placements = uniquePlacementRefs.map(ref => ({ ref,
      ...((ref.collection === 'asset' ? assetPlacements.get(ref.id) : undefined) ?? spheres.resolve(ref, undefined,
        ref.collection === 'episode' ? derived?.find(row => row.id === ref.id)?.sphere : undefined)) }));
    return { assets, ...(input.asset_id && assets[0]?.holder_contact ? { holder: holderOf(assets[0].holder_contact) } : {}),
      related_assets: [...new Map([...(parent ? [parent] : []), ...descendants, ...linked].map(asset => [asset.id, asset])).values()], total_assets,
      ...(input.asset_filter ? { asset_filter: { kind: input.asset_filter, unavailable } } : {}), classes: classes.list(), proposals: shown,
      ...(input.asset_sphere ? { asset_sphere: input.asset_sphere } : {}),
      ...(asset_summaries ? { asset_summaries } : {}), total_proposals: proposals.count(), matching_proposals: proposals.count(input.proposal_kind), occurrences,
      household: { telegram: household.telegram(), ...(deps.homeAssistant ? { home_assistant: deps.homeAssistant.read() } : {}), telegram_connections: (deps.connections?.() ?? []).flatMap(row => {
        const route = telegramHouseholdRoute(row); return route ? [{ name: row.name, enrolled_at: row.enrolled_at, recipient: route.recipient, owner_sender: route.expected_sender }] : [];
      }) },
      ...(deps.mailboxes ? { proof_addresses: proofAddresses(deps.mailboxes(), source => proposals.sourceEnabled(source)) } : {}),
      occasions,
      episodes,
      ...(deps.episodeRuntime ? { recall_rates: deps.episodeRuntime.rates(), history_receipts: deps.episodeRuntime.receipts(),
        history_evidence: input.trace_id ? [deps.episodeRuntime.trace(input.trace_id)].filter((value): value is NonNullable<typeof value> => !!value) : [],
        ...(derived ? { derived_episodes: derived } : {}) } : {}),
      sources: intake.sources(), situation_dismissals: dismissals.list(now()).map(({ ref: _ref, ...row }) => row), suppressions: proposals.suppressions(), intake: intake.progress(),
      sphere_sources: sphereSources(),
      unmatched_replies: (await notifier?.listUnmatchedAskReplies() ?? []).map(({ id, text, reason, created_at }) => ({ id, text, reason, created_at })),
      subscriber_issues: deps.db.prepare("SELECT subscriber_id,revision,run_id,state,at FROM situation_subscriber_runs WHERE state IN ('started','in_doubt') ORDER BY at,subscriber_id LIMIT 200").all() as NonNullable<YoursSnapshot['subscriber_issues']>,
      ...(subscribers ? {
        subscribers: subscribers.store.list().map(row => ({ trigger_id: row.trigger_id, recipe_id: row.recipe_id, pattern: row.pattern, ...(row.read_contract_id ? { contract_id: row.read_contract_id } : {}) })),
        subscriber_contracts: subscribers.contracts.list().filter(row => (row.grant_kind ?? 'standing') === 'standing' && row.revoked_at == null && (row.expiry_at == null || row.expiry_at > now())).map(row => ({ id: row.contract_id, name: row.display_name })),
      } : {}),
      observation_recipes: recipes?.listStored().flatMap(row => { const recipe = recipes!.get(row.recipe_id);
        return recipe && definitionDigest(recipe) === definitionDigest(JSON.parse(row.recipe_json)) && observationRecipe(recipe)
          ? [{ id: row.recipe_id, name: recipe.metadata.name, publisher: row.publisher_id, hash: definitionDigest(recipe) }] : []; }) ?? [],
      observation_bindings: assets.flatMap(current => deps.work.listAssetObservationBindings(current.id).map(binding => {
        const row = recipes?.getStored(binding.actor_ref.slice('recipe:'.length));
        return { ...binding, available: ['active', 'lent'].includes(current.status) && (!binding.recipe_hash || !!row && definitionDigest(JSON.parse(row.recipe_json)) === binding.recipe_hash) };
      })),
      observation_handoffs: input.asset_id && assets.length ? deps.work.assetObservationHandoffs(input.asset_id) : [],
      phone_ready: destinations?.destinations.some(destination => destination.channel !== 'ui' && destination.channel !== 'bridge') ?? false,
      ...(scheduled ? { delivery: scheduled.status() } : {}),
      settings: { digest: deps.situations.readSetting('digest.frequency', 'weekly'), last_time: deps.situations.readSetting('last_time.choice', 'unasked'),
        measures: deps.situations.readSetting('metrics.opt_in', false) },
      sphere_placements: placements,
      ...(input.asset_id ? { retirement_impact: { parts: descendants.filter(row => row.retirement === 'part').length,
        contracts: descendants.filter(row => row.retirement === 'cancel_or_transfer').length, open_occurrences: affectedOpen } } : {}),
    };
  };
  return {
    proposals, classes, spheres, history, intake, command: (input: YoursCommand, owner: ExecutionSource) => runOne('yours-command', async () => {
      const result = await command(input, owner); deps.learning?.refreshPending(); publishProposalEvents(proposals, deps.situations, spheres); return result;
    }), snapshot,
    placement(ref: SituationRef) {
      requireOpen();
      if (!ref || !['asset', 'task', 'note', 'commitment', 'project', 'booking', 'contact', 'calendar', 'mail', 'mail_fact', 'occasion', 'episode', 'reminder'].includes(ref.collection)
        || typeof ref.id !== 'string' || !ref.id.trim() || ref.id.length > 2000) throw new Error('Choose a record to place');
      return spheres.resolve(ref);
    },
    deliveryStatus() { requireOpen(); if (!scheduled) throw new Error('Overview service unavailable'); return scheduled.status(); },
    async learningStatus(): Promise<import('@recued/contracts').YoursLearningStatus> {
      requireOpen(); if (!deps.episodeRuntime) throw new Error('Last time is unavailable');
      return { last_time: deps.situations.readSetting('last_time.choice', 'unasked'), asked: await deps.episodeRuntime.optInOpen(), classes: deps.episodeRuntime.rates() };
    },
    bindScheduled(service: import('./scheduled-situations.js').ScheduledSituations) { scheduled = service; },
    bindSubscribers(value: NonNullable<typeof subscribers>) { subscribers = value; },
    bindRecipes(value: import('../recipe-store.js').RecipeStore) { recipes = value; },
    isHouseholdConnection(name: string): boolean { const row = deps.connections?.().find(row => row.name === name); return !!row && household.isHousehold(row); },
    async today(input: { now: number; before: number }) { requireOpen(); refreshQuestions(); refreshClassUpdates(); refreshTrips(); await refreshEvidence(); mailProof.scan(); if (!scheduled) throw new Error('Today situations unavailable'); return scheduled.today(input); },
    async overview(): Promise<Omit<import('@recued/contracts').ProactiveToday, 'situations' | 'occurrences'>> {
      requireOpen();
      deps.episodeRuntime?.refreshSuppressed();
      const newest = proposals.list({ state: 'proposed', limit: 1 })[0];
      const destinations = await notifier?.getReminderDestinations();
      return { proposal_count: proposals.count(), newest_proposal: newest ? { id: newest.id, title: newest.title } : null,
        phone_ready: destinations?.destinations.some(destination => destination.channel !== 'ui' && destination.channel !== 'bridge') ?? false,
        unmatched_replies: (await notifier?.listUnmatchedAskReplies() ?? []).map(({ id, text, reason, created_at }) => ({ id, text, reason, created_at })) };
    },
    bind(block: NotificationBlock) { notifier = block; },
    async tick() { if (deps.isVaultUnlocked?.() === false) return; await intake.scan(); deps.learning?.refreshPending(); refreshQuestions(); refreshClassUpdates(); refreshTrips(); await refreshEvidence(); mailProof.scan(); publishProposalEvents(proposals, deps.situations, spheres); },
    async stop() { await intake.drain(); await Promise.allSettled([...mutations.values()]); },
  };
};
export type YoursService = ReturnType<typeof createYoursService>;
