import { ASSET_DOCUMENT_DETAILS_ATTRIBUTE, type Asset, type AssetClassPreset, type AssetRule, type Commitment, type ContactRecord, type Episode, type EpisodeInput, type FileAttachmentSelection, type Link, type Occasion, type ProactiveProposal, type ProactiveSuppression, type ProactiveToday, type SituationCluster, type SituationDeliveryStatus, type YoursAssetSummary, type YoursCommand, type YoursReadRequest, type YoursSnapshot } from '@recued/contracts';
import type { ChatQueuedTurn } from '@recued/contracts';

/** UI fixture only. The independent server drive uses the real SQLite stores. */
declare global {
  interface Window { __householdFixture?: { setGroup(on: boolean): void } }
}
export const createYoursFixture = () => {
  const ruleWrites: YoursCommand[] = [];
  (globalThis as { __assetRuleWrites?: YoursCommand[] }).__assetRuleWrites = ruleWrites;
  const renewals: YoursCommand[] = [];
  (globalThis as { __occurrenceRenewals?: YoursCommand[] }).__occurrenceRenewals = renewals;
  // §15.7 (2026-10-24) — Today's Done on the passport acknowledges its latest reminder.
  let acknowledged = false;
  const factWrites: YoursCommand[] = [];
  const relationshipWrites: YoursCommand[] = [];
  const enrolledWriters: NonNullable<YoursSnapshot['observation_bindings']> = [];
  (globalThis as { __assetRelationshipWrites?: YoursCommand[] }).__assetRelationshipWrites = relationshipWrites;
  (globalThis as { __assetFactWrites?: YoursCommand[] }).__assetFactWrites = factWrites;
  const navigationOpens: YoursCommand[] = [];
  (globalThis as { __navigationOpens?: YoursCommand[] }).__navigationOpens = navigationOpens;
  const handoffWrites: YoursCommand[] = [];
  (globalThis as { __assetHandoffWrites?: YoursCommand[] }).__assetHandoffWrites = handoffWrites;
  const handoffs: NonNullable<YoursSnapshot['observation_handoffs']> = [];
  let factRevision = 0;
  let handoffFailures = new URLSearchParams(location.search).has('yours_handoff_fail_once') ? 1 : 0;
  let handoffStale = new URLSearchParams(location.search).has('yours_handoff_stale') ? 1 : 0;
  const chatCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
  (globalThis as { __assetChatCalls?: typeof chatCalls }).__assetChatCalls = chatCalls;
  // UI-only withdrawal state; the independent queue harness proves durable admission.
  const assetQueue = new URLSearchParams(location.search).has('yours_asset_queue');
  let queuedAssetQuestion: ChatQueuedTurn | undefined;
  let queueRevision = 0;
  const time = Date.parse('2026-10-17T12:00Z');
  const ana: ContactRecord = { _id: 'ana@example.test', _collection: 'contact', email: 'ana@example.test', contact_id: 'ana', name: 'Ana',
    first_seen: time, last_interaction: time, interaction_count: 0, source: 'manual', created_at: time, updated_at: time };
  const rule: AssetRule = { id: 'renew', title: 'Renew', enabled: true, muted: false, pinned: false, consequence: 'floor',
    expiry_policy: 'escalate_overdue', when: { kind: 'expiry', field: 'expires_on' }, reaction: { notify: true, occurrence: 'action', emit: false },
    schedule: { before: [{ amount: 6, unit: 'months' }, { amount: 3, unit: 'months' }, { amount: 1, unit: 'months' }], on_day: true, after: { amount: 1, unit: 'months' } } };
  const classes: AssetClassPreset[] = [{ id: 'passport', name: 'Passport', version: 1, origin: 'builtin', fields: { dates: { expires_on: null, issued_on: null }, readings: {}, observations: {}, settings: {} },
    rules: [rule], audience: 'owner', retirement: 'part' }, { id: 'warranty_purchase', name: 'Warranty-bearing purchase', version: 1, origin: 'builtin',
    fields: { dates: { warranty_ends_on: null }, readings: {}, observations: {}, settings: {} }, rules: [], audience: 'owner', retirement: 'part' },
    { id: 'boiler', name: 'Boiler', version: 1, origin: 'builtin', fields: { dates: { last_serviced_on: null }, readings: {}, observations: {}, settings: {} },
      rules: [], audience: 'household', retirement: 'part' },
    { id: 'visa', name: 'Visa', version: 1, origin: 'builtin', fields: { dates: { expires_on: null, issued_on: null }, readings: {}, observations: {}, settings: { sensitive: true } },
      rules: [], audience: 'owner', retirement: 'part' }];
  const make = (id: string, input: Partial<Asset> & { name: string }): Asset => ({ id, source_id: 'recued.asset',
    status: input.status ?? 'active', dates: input.dates ?? {}, readings: {}, observations: {}, values: [], anchors: [], attributes: {}, settings: {}, rules: [],
    retirement: 'part', created_at: time, updated_at: time, last_seen_at: time, sync_state: 'live', conflict_policy: 'recued_wins', field_sources: {}, ...input });
  const assets = new Map<string, Asset>();
  // Authoritative UI responses only; native projection tests exercise the clocks.
  const summaryRows: YoursAssetSummary[] = [];
  (globalThis as { __assetSummaries?: YoursAssetSummary[] }).__assetSummaries = summaryRows;
  if (new URLSearchParams(location.search).get('yours') === 'summaries') {
    for (const [id, name, status, sync_state] of [
      ['card-renewal', 'Home cover', 'active', 'live'], ['card-missing', 'Boiler', 'active', 'live'],
      ['card-empty', 'Spare key', 'active', 'live'], ['card-estimate', 'Bike', 'active', 'live'],
      ['card-retired', 'Old light', 'retired', 'live'], ['card-stale', 'Remote monitor', 'active', 'stale_unreachable'],
    ] as const) assets.set(id, make(id, { name, status, sync_state }));
    Object.assign(assets.get('card-missing')!, {
      dates: { last_serviced_on: null, inspected_on: null, purchased_on: '2020-03-01' },
      readings: { battery: { value: 15, unit: '%', as_of: time + 86_400_000, evidence: [] }, counter: { value: 7, unit: 'cycles', as_of: time, evidence: [] } },
      observations: { leak: { active: true, certainty: 'conditional', source: 'owner', as_of: time, evidence: [] } },
      rules: [
        { ...rule, id: 'service', when: { kind: 'interval', field: 'last_serviced_on', every: { amount: 12, unit: 'months' } } },
        { ...rule, id: 'inspect', when: { kind: 'expiry', field: 'inspected_on' } },
        { ...rule, id: 'battery', when: { kind: 'objective', field: 'battery', target: 20, unit: '%', direction: 'falling', mode: 'condition', lead_days: 0 } },
        { ...rule, id: 'leak', when: { kind: 'condition', field: 'leak', certainty: 'confirmed' } },
      ],
    } satisfies Partial<Asset>);
    assets.get('card-stale')!.dates.reviewed_on = null;
    assets.get('card-retired')!.dates.reviewed_on = null;
    summaryRows.push(
      { asset_id: 'card-renewal', open_tasks: 2, active_rules: 1, missing: [], next_due: {
        on: '2026-10-16', title: 'Renew cover', rule_id: 'renew', commitment_id: 'renew-task', state: 'overdue', estimated: false } },
      { asset_id: 'card-missing', open_tasks: 1, active_rules: 4, next_due: null, missing: [
        { path: 'dates.last_serviced_on', reason: 'unknown' }, { path: 'readings.battery', reason: 'future' },
        { path: 'observations.leak', reason: 'unconfirmed' }, { path: 'dates.inspected_on', reason: 'unknown' },
      ] },
      { asset_id: 'card-empty', open_tasks: 0, active_rules: 0, missing: [], next_due: null },
      { asset_id: 'card-estimate', open_tasks: 1, active_rules: 1, missing: [], next_due: {
        on: '2026-10-22', title: 'Service by distance', rule_id: 'service', state: 'upcoming', estimated: true } },
      { asset_id: 'card-retired', open_tasks: 0, active_rules: 0, missing: [], next_due: null },
      { asset_id: 'card-stale', open_tasks: 0, active_rules: 1, missing: [], next_due: {
        on: '2026-10-17', title: 'Review monitor', rule_id: 'review', state: 'today', estimated: false } },
    );
  }
  if (new URLSearchParams(location.search).has('yours_asset_filter_pages')) {
    const count = new URLSearchParams(location.search).has('yours_asset_filter_last_page') ? 51 : 55;
    for (let index = 0; index < count; index++) {
      const suffix = String(index).padStart(2, '0');
      for (const kind of ['missing', 'overdue', 'clear'] as const) {
        const id = `filter-${kind}-${suffix}`;
        assets.set(id, make(id, { name: kind === 'missing' ? `Workshop / meter #${suffix}` : `${kind} cover ${suffix}`,
          updated_at: time + (kind === 'clear' ? 1000 : kind === 'missing' ? 100 : 1) + index,
          dates: kind === 'missing' ? { inspected_on: null } : {}, rules: kind === 'missing' ? [{ ...rule, when: { kind: 'expiry', field: 'inspected_on' } }] : [] }));
        summaryRows.push({ asset_id: id, open_tasks: 0, active_rules: kind === 'clear' ? 0 : 1,
          missing: kind === 'missing' ? [{ path: 'dates.inspected_on', reason: 'unknown' }] : [],
          next_due: kind === 'overdue' ? { on: '2026-10-16', title: 'Renew cover', rule_id: 'renew', state: 'overdue', estimated: false } : null });
      }
    }
  }
  // UI-only authoritative snapshot update; native store tests enforce admission.
  (globalThis as { __assetSetAttributes?: (id: string, attributes: Asset['attributes']) => void }).__assetSetAttributes = (id, attributes) => {
    // Previously returned snapshots retain their old values, like a wire read.
    assets.set(id, { ...assets.get(id)!, attributes: structuredClone(attributes) });
  };
  (globalThis as { __assetReportReading?: (id: string, field: string, value: number, unit: string, asOf: number) => void }).__assetReportReading = (id, field, value, unit, asOf) => {
    const asset = assets.get(id)!;
    asset.readings[field] = { value, unit, as_of: asOf, evidence: [] };
    asset.field_sources[`readings.${field}`] = { kind: 'observation', ref: 'device:monitor', at: asOf };
    if (asset.automatic_updates) delete asset.automatic_updates[`readings.${field}`];
  };
  const occasions = new Map<string, Occasion>();
  const episodes = new Map<string, Episode>(); const suppressions: ProactiveSuppression[] = []; let lastTime: 'on' | 'off' | 'unasked' = 'unasked';
  // `&yours_last_time_ready=1` — a kind of "last time" offer has cleared the owner's rate;
  // `&yours_last_time_asked=1` — and the once-only question waits in the bell (D-325 P21).
  const recallRates = new URLSearchParams(location.search).has('yours_last_time_ready')
    ? [{ class_id: 'flowers', scored: 6, relevant: 5, rate: 5 / 6, minimum_rate: 0.8, qualified: true }]
    : [{ class_id: 'flowers', scored: 4, relevant: 3, rate: 0.75, minimum_rate: null, qualified: false }];
  const derived: EpisodeInput = { id: 'vegas-episode', title: 'Las Vegas trip', when: { from: Date.parse('2025-10-17'), to: Date.parse('2025-10-20') },
    people: ['ana'], where: { key: 'label:las vegas', name: 'Las Vegas' }, subjects: [], evidence: [{ collection: 'mail', id: 'personal:flowers' }],
    notes: 'Flowers · Bloom & Co · 45.00 USD', basis: 'derived', assembly_rule: 'plan_trace.v1', sensitive: [], storage_reason: 'proposal_citation' };
  const demo = new URLSearchParams(location.search).get('yours') === 'demo';
  // `?yours=absent` plays a server older than D-325: every `yours.*` method is unknown.
  // `&yours_absent=1` does the same over the demo records.
  const absent = new URLSearchParams(location.search).get('yours') === 'absent' || new URLSearchParams(location.search).has('yours_absent');
  if (new URLSearchParams(location.search).has('contact_history')) {
    occasions.set('ana-birthday', { id: 'ana-birthday', title: 'Ana birthday', month_day: '10-24', people: ['ana'], rules: [], muted: false, created_at: time, updated_at: time });
    episodes.set('museum', { ...derived, id: 'museum', title: 'Museum afternoon', storage_reason: 'owner_record', created_at: time, updated_at: time });
  }
  if (demo) assets.set('passport', make('passport', { name: 'Ana’s passport', class_id: 'passport', holder_contact: 'ana', dates: { expires_on: '2027-04-17' }, rules: [structuredClone(rule)] }));
  // `&yours_provenance=1` — facts from several sources, and a condition a recipe
  // reported with its evidence (D-325 §15.3).
  const provenance = demo && new URLSearchParams(location.search).has('yours_provenance');
  if (provenance) Object.assign(assets.get('passport')!, {
    document_number: 'X1234', settings: { radius_km: 5 }, attributes: { cover: new URLSearchParams(location.search).has('yours_crlf_fact') ? 'Blue\r\nSecond line' : 'Blue' },
    observations: { flickering: { active: true, certainty: 'conditional', as_of: time, source: 'recipe:fixture/porch#hash',
      evidence: [{ collection: 'home-assistant', id: 'light.porch', field: 'transitions', value: 'on and off 14 times in two minutes, not from an automation' }] } },
    field_sources: { 'dates.expires_on': { kind: 'extracted', ref: 'reception:request-1', at: time }, document_number: { kind: 'owner', ref: 'paired-owner', at: time },
      'settings.radius_km': { kind: 'confirmed_document', ref: 'file:policy', at: time }, 'attributes.cover': { kind: 'ai_guess', ref: 'guess', at: time },
      holder_contact: { kind: 'owner', ref: 'paired-owner', at: time }, 'observations.flickering': { kind: 'observation', ref: 'recipe:fixture/porch#hash', at: time } },
  } satisfies Partial<Asset>);
  const ruleFields = new URLSearchParams(location.search).has('yours_rule_fields');
  if (demo && ruleFields) {
    const passport = assets.get('passport')!;
    assets.set('passport', { ...passport, dates: { ...passport.dates, issued_on: null, last_serviced_on: null },
      readings: { odometer: { value: 9000, unit: 'km', as_of: time, evidence: [] }, battery: null,
        pressure: { value: 2, unit: 'bar', as_of: time, evidence: [{ collection: 'file', id: 'pressure-certificate' }] } }, observations: { damage: null },
      rules: [...passport.rules, { ...rule, id: 'meter_service', title: 'Service by distance', consequence: 'routine', muted: true,
        verified_as_of: '2026-10-01', reaction: { notify: false, occurrence: null, emit: true }, schedule: { before: [], on_day: false },
        when: { kind: 'objective', field: 'odometer', target: 10000, unit: 'km', direction: 'rising', mode: 'usage', lead_days: 9, lead_value: 250, every: 5000 } }] });
    if (new URLSearchParams(location.search).has('yours_missing_rule')) assets.get('passport')!.rules = assets.get('passport')!.rules.filter(rule => rule.id !== 'renew');
    if (new URLSearchParams(location.search).has('yours_handoff_unknown')) assets.get('passport')!.field_sources['readings.battery'] = { kind: 'owner', ref: 'owner', at: time, revision: 'manual-unknown' };
  }
  // `?yours=parts`: a boiler that belongs to a house and sets none of the house's facts itself.
  if (new URLSearchParams(location.search).get('yours') === 'parts') {
    assets.set('house', make('house', { name: 'House', audience: 'household', exact_address: '1 Main Street', anchors: [{ kind: 'place', name: 'Home' }] }));
    assets.set('boiler', make('boiler', { name: 'Boiler', class_id: 'boiler', belongs_to: 'house' }));
  }
  const relationships = new URLSearchParams(location.search).get('yours') === 'relations';
  if (relationships) {
    for (let index = 0; index < 55; index++) { const id = `asset-${String(index).padStart(2, '0')}`; assets.set(id, make(id, { name: `Stored asset ${index}` })); }
    assets.set('house-a', make('house-a', { name: 'Main house', audience: 'household', anchors: [{ kind: 'place', name: 'Home' }] }));
    assets.set('flat-b', make('flat-b', { name: 'Garden flat', anchors: [{ kind: 'place', name: 'Garden' }] }));
    assets.set('boiler-current', make('boiler-current', { name: 'Kitchen boiler', class_id: 'boiler', serial_number: 'CUR001', belongs_to: 'house-a' }));
    assets.set('boiler-duplicate', make('boiler-duplicate', { name: 'Kitchen boiler', class_id: 'boiler', serial_number: 'ALT002', belongs_to: 'house-a' }));
    assets.set('sensor', make('sensor', { name: 'Boiler sensor', belongs_to: 'boiler-current' }));
    assets.set('probe', make('probe', { name: 'Boiler probe', belongs_to: 'sensor' }));
    assets.set('zz-cabin', make('zz-cabin', { name: 'Mountain cabin', audience: 'owner', anchors: [{ kind: 'place', name: 'Mountains' }] }));
  }
  // The server's effective read: a part inherits what it does not set itself.
  const effective = (asset: Asset): Asset => {
    const parent = asset.belongs_to ? assets.get(asset.belongs_to) : undefined; if (!parent) return asset;
    const view = structuredClone(asset); const inherited: Record<string, string> = {};
    if (view.audience === undefined && parent.audience !== undefined) { view.audience = parent.audience; inherited.audience = parent.id; }
    if (!view.anchors.some(anchor => anchor.kind === 'place')) {
      const places = parent.anchors.filter(anchor => anchor.kind === 'place'); if (places.length) { view.anchors.push(...places); inherited.anchors = parent.id; }
      if (view.exact_address === undefined && parent.exact_address !== undefined) { view.exact_address = parent.exact_address; inherited.exact_address = parent.id; }
    }
    return Object.keys(inherited).length ? { ...view, inherited_fields: inherited } : view;
  };
  const commitment: Commitment = { id: 'passport-commitment', source_id: 'recued.commitment', direction: 'outbound', statement: 'Renew · Ana’s passport', derivation: 'rule_emitted',
    promised_at: time, promised_for_at: Date.parse('2027-04-17'), expiry_policy: 'escalate_overdue', lifecycle_state: 'pending', due_status: 'not_due',
    lifecycle_changed_at: time, due_status_changed_at: time, state_changed_at: time, created_at: time, updated_at: time, last_seen_at: time,
    sync_state: 'live', conflict_policy: 'recued_wins', blocks_task_ids: [], blocks_project_ids: [] };
  const proposals = new Map<string, ProactiveProposal>();
  // `&occasion_history=1` (with contact_history) — Ana's birthday has a history of two
  // episodes and a suggestion that would change its reminder (D-325 §15.2, P44).
  if (new URLSearchParams(location.search).has('occasion_history')) {
    occasions.set('ana-birthday', { ...occasions.get('ana-birthday')!, rules: [{ ...rule, id: 'date', title: 'Ana birthday', consequence: 'routine', expiry_policy: 'strict_expire',
      when: { kind: 'expiry', field: 'next_on' }, reaction: { notify: true, occurrence: 'notice', emit: false }, schedule: { before: [{ amount: 1, unit: 'weeks' }], on_day: true } }] });
    episodes.set('museum', { ...episodes.get('museum')!, occasion_id: 'ana-birthday' });
    episodes.set('dinner', { ...derived, id: 'dinner', title: 'Birthday dinner', occasion_id: 'ana-birthday', evidence: [{ collection: 'mail', id: 'personal:dinner' }],
      basis: 'declared', storage_reason: 'owner_record', created_at: time, updated_at: time });
    proposals.set('occasion-timing', { id: 'occasion-timing', key: 'occasion-timing', kind: 'schedule', title: 'Review reminder timing · Ana birthday',
      explanation: 'You bought flowers about ten days ahead each year. Start the reminder two weeks before?', state: 'proposed', confidence: 'medium', origin: 'learner',
      sources: [{ collection: 'occasion', id: 'ana-birthday' }], subject: { collection: 'occasion', id: 'ana-birthday' },
      payload: { occasion_id: 'ana-birthday', rule_id: 'date', schedule: { before: [{ amount: 2, unit: 'weeks' }], on_day: true } }, created_at: time, updated_at: time });
  }
  if (ruleFields) proposals.set('rule-review', { id: 'rule-review', key: 'rule-review', kind: 'rule', title: 'Review issue-date check',
    explanation: 'Review this proposed rule before enabling it.', state: 'proposed', confidence: 'medium', origin: 'owner', sources: [],
    payload: { asset_id: 'passport', rule: { ...rule, id: 'issue_check', title: 'Check issue date', enabled: false, consequence: 'routine',
      when: { kind: 'expiry', field: 'issued_on' }, schedule: { before: [], on_day: true } } }, created_at: time, updated_at: time });
  if (ruleFields) proposals.set('schedule-review', { id: 'schedule-review', key: 'schedule-review', kind: 'schedule', title: 'Review renewal reminders',
    explanation: 'Review a proposed change to renewal reminder times.', state: 'proposed', confidence: 'medium', origin: 'owner', sources: [],
    payload: { asset_id: 'passport', rule_id: 'renew', schedule: { before: [{ amount: 2, unit: 'weeks' }], on_day: true } }, created_at: time, updated_at: time });
  if (relationships) proposals.set('link-review', { id: 'link-review', key: 'link-review', kind: 'link', title: 'Boiler belongs to a home',
    explanation: 'Choose the home this boiler belongs to.', state: 'proposed', confidence: 'high', origin: 'owner', sources: [],
    payload: { asset_id: 'boiler-current', parent_id: 'zz-cabin' }, created_at: time, updated_at: time });
  if (demo) proposals.set('receipt', { id: 'receipt', key: 'receipt', kind: 'asset', title: 'LG television', explanation: 'A stored Store receipt names this television. Warranty ends 2027-10-10.',
    confidence: 'high', state: 'proposed', origin: 'intake', lane: 'likely_asset', merchant: 'Store', sources: [{ collection: 'mail', id: 'personal:receipt' }],
    payload: { asset: { name: 'LG television', class_id: 'warranty_purchase', dates: { warranty_ends_on: '2027-10-10' } } }, created_at: time, updated_at: time });
  if (demo && new URLSearchParams(location.search).has('yours_focus_corrections')) {
    for (const id of ['passport-review-a', 'passport-review-b']) proposals.set(id, { ...proposals.get('receipt')!, id, key: id,
      title: 'Review passport', explanation: 'Check this proposed passport update.', merchant: undefined, sources: [],
      subject: { collection: 'asset', id: 'passport' }, payload: { asset: { name: 'Ana’s passport', class_id: 'passport' } } });
  }
  if (new URLSearchParams(location.search).has('learning')) {
    const base = { confidence: 'medium' as const, state: 'proposed' as const, origin: 'learner' as const, sources: [], created_at: time, updated_at: time };
    proposals.set('ranking', { ...base, id: 'ranking', key: 'ranking', kind: 'ranking', title: 'Review passport ranking', explanation: 'Three owner completions support this ranking.', payload: { ranking_factor: 1.3 } });
    proposals.set('relation', { ...base, id: 'relation', key: 'relation', kind: 'relation', title: 'Relate trips to travel documents', explanation: 'Three distinct trip openings.', payload: { relation: { target_class: 'passport', sphere: 'personal', evidence: [] } } });
    proposals.set('habit', { ...base, id: 'habit', key: 'habit', kind: 'habit', title: 'An annual task? · Buy flowers', explanation: 'Three consecutive years of owner acceptance.', payload: {
      occasion: { title: 'Ana birthday', month_day: '10-24', people: ['ana'], muted: false, rules: [] },
      rule: { ...rule, id: 'habit_flowers', title: 'Buy flowers', enabled: false, consequence: 'routine', expiry_policy: 'strict_expire', when: { kind: 'expiry', field: 'next_on', offset: { amount: 2, unit: 'days' } }, schedule: { before: [{ amount: 1, unit: 'weeks' }], on_day: true } } } });
  }
  let failures = new URLSearchParams(location.search).has('yours_fail_once') ? 1 : 0;
  let number = 0;
  const fileLinks: Link[] = [];
  const identityLinks = new Map<string, Set<string>>();
  let assetSearchFailures = new URLSearchParams(location.search).has('yours_asset_search_fail_once') ? 1 : 0;
  const receipt: FileAttachmentSelection = { file_id: 'file:received:receipt', filename: 'Passport receipt.txt', mime_type: 'text/plain', media_class: 'document', size: 16, selection_revision: 'fixture-v1' };
  const pagedFiles = new URLSearchParams(location.search).has('yours_file_pages');
  const retainedFiles = [receipt, ...(pagedFiles ? [{ ...receipt, file_id: 'file:received:certificate', filename: 'Boiler certificate.txt' }] : [])];
  const fileDetailsMode = new URLSearchParams(location.search).get('yours_file_details');
  let metadataFailures = fileDetailsMode === 'retry' ? 1 : 0;
  if (fileDetailsMode) fileLinks.push({ _id: 'existing-file', _collection: 'link', from_collection: 'asset', from_id: 'passport', to_collection: 'file', to_id: receipt.file_id, role: 'attachment', authored_by_recipe_id: 'owner', created_at: time });
  const spherePlacements = new Map<string, { sphere?: 'personal' | 'professional'; reason: string; pinned: boolean; source?: string }>();
  if (new URLSearchParams(location.search).has('yours_asset_spheres')) for (const asset of assets.values()) {
    const sphere = asset.id.startsWith('filter-missing-') ? 'professional' : asset.id.startsWith('filter-overdue-') ? 'personal' : undefined;
    if (sphere) spherePlacements.set(JSON.stringify(['asset', asset.id]), { sphere, reason: 'placed by you', pinned: true });
  }
  const placementFor = (ref: { collection: string; id: string }): Omit<YoursSnapshot['sphere_placements'][number], 'ref'> => spherePlacements.get(JSON.stringify([ref.collection, ref.id])) ?? { reason: 'unsorted', pinned: false };
  const sourceSpheres = new Map<string, 'personal' | 'professional'>([['mail:personal', 'personal'], ['calendar:work', 'professional']]);
  let delivery: SituationDeliveryStatus = { settings: { frequency: 'weekly', weekday: 1, time: '08:00', day_of: true }, last_run: null, last_sent: null };
  let householdTelegram: NonNullable<YoursSnapshot['household']>['telegram'] = null;
  let householdHA: import('@recued/contracts').HouseholdHomeAssistantSelection | null = null;
  const familyGroup = () => ({ connection_name: 'Family', connection_enrolled_at: 200, recipient: '-100123', selected_at: time });
  // The group chosen, or switched off, on another device while Settings was away.
  if (typeof window !== 'undefined') window.__householdFixture = { setGroup: on => { householdTelegram = on ? familyGroup() : null; } };
  // `?household=group`: the household's Telegram group is already chosen.
  if (new URLSearchParams(location.search).get('household') === 'group') householdTelegram = familyGroup();
  const today = (input: { now: number; before: number }): ProactiveToday => {
    const when = { from: input.now + 2 * 86_400_000, to: input.now + 2 * 86_400_000 + 3600_000 };
    const evidence = [{ collection: 'asset', id: 'passport' }];
    const dimension = <T>(value: T | null, verdict: 'match' | 'outside' | 'unknown') => ({ value, verdict, basis: 'declared' as const, evidence });
    // `?today_bill`: a bill, which Today links to its own facts (D-325 Option A).
    const bills: SituationCluster[] = new URLSearchParams(location.search).has('today_bill') ? [{ id: 'bills', subjects: [], span: null, omitted: 0, items: [
      { ref: { collection: 'mail_fact', id: 'mthing_bill' }, kind: 'bill', what: dimension('Bill: Acme Power', 'match'), when: dimension(null, 'unknown'),
        where: dimension(null, 'unknown'), who: dimension(null, 'unknown'), reasons: ['due'], basis: 'derived', evidence: [], consequence: 'routine', updated_at: time },
    ] }] : [];
    const trip: SituationCluster[] = demo ? [{ id: 'lisbon-trip', subjects: [{ collection: 'booking', id: 'trip' }], span: when, omitted: 0, items: [
      { ref: { collection: 'booking', id: 'trip' }, kind: 'booking', what: dimension('Lisbon trip', 'match'), when: dimension(when, 'match'),
        where: dimension({ key: 'city:lisbon', name: 'Lisbon' }, 'match'), who: dimension(['contact-ana'], 'match'), reasons: ['due'], basis: 'declared', evidence: [], consequence: 'routine', updated_at: time },
      { ref: { collection: 'asset', id: 'passport' }, kind: 'asset_rule', what: dimension('Passport expiry', 'outside'),
        when: dimension({ from: commitment.promised_for_at!, to: commitment.promised_for_at! }, 'outside'), where: dimension(null, 'unknown'), who: dimension(['contact-ana'], 'match'),
        reasons: ['related'], basis: 'declared', evidence, consequence: 'floor', updated_at: time },
    ] }] : [];
    return { situations: { clusters: [...trip, ...bills], omitted: 0, ambiguous: [] }, ...(demo ? { people: { 'contact-ana': 'Ana Lima' } } : {}),
      occurrences: demo && commitment.lifecycle_state === 'pending' ? [{ id: 'passport-occurrence', asset_id: 'passport', asset_name: 'Ana’s passport', question: false, reminders_started: true, commitment,
        renewal: { field: 'expires_on', current: '2027-04-17' }, ...(acknowledged ? { acknowledged: true as const } : {}) }] : [],
      proposal_count: proposals.size, newest_proposal: proposals.size ? { id: 'receipt', title: 'LG television' } : null, phone_ready: false,
      unmatched_replies: demo ? [{ id: 'unmatched', text: 'done', reason: 'no_item_number', created_at: time }] : [] };
  };
  const snapshot = (input: YoursReadRequest): YoursSnapshot => {
    const term = input.search?.trim().toLowerCase() ?? '';
    const legacyFilters = new URLSearchParams(location.search).has('yours_without_asset_filters');
    const legacySpheres = new URLSearchParams(location.search).has('yours_without_asset_sphere');
    const unavailable = new URLSearchParams(location.search).has('yours_asset_filter_unavailable') ? 1 : 0;
    const summaryFor = (asset: Asset): YoursAssetSummary => summaryRows.find(row => row.asset_id === asset.id) ?? {
      asset_id: asset.id, open_tasks: demo && asset.id === 'passport' && commitment.lifecycle_state === 'pending' ? 1 : 0,
      active_rules: ['active', 'lent'].includes(asset.status) ? asset.rules.filter(rule => rule.enabled).length : 0, missing: [],
      next_due: demo && asset.id === 'passport' && commitment.lifecycle_state === 'pending' ? {
        on: '2027-04-17', title: commitment.statement, rule_id: 'renew', commitment_id: commitment.id, state: 'upcoming', estimated: false } : null,
    };
    const matching = [...assets.values()].filter(asset => !asset.deleted_at && (!term || asset.name.toLowerCase().includes(term) || asset.class_id?.toLowerCase().includes(term)))
      .filter(asset => !input.asset_sphere || legacySpheres || (placementFor({ collection: 'asset', id: asset.id }).sphere ?? 'unsorted') === input.asset_sphere)
      .filter(asset => !input.asset_filter || legacyFilters || (input.asset_filter === 'missing_facts' ? summaryFor(asset).missing.length > 0 : summaryFor(asset).next_due?.state === 'overdue'));
    const ordered = matching.sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
    const selected = (input.asset_id ? [...assets.values()].filter(asset => input.asset_id === asset.id && !asset.deleted_at)
      : ordered.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50))).map(effective);
    const parent = input.asset_id && selected[0]?.belongs_to ? assets.get(selected[0].belongs_to) : undefined;
    const related = new Map<string, Asset>(parent ? [[parent.id, effective(parent)]] : []);
    const queue = input.asset_id ? [...assets.values()].filter(asset => asset.belongs_to === input.asset_id) : [];
    while (queue.length) { const asset = queue.shift()!; if (related.has(asset.id)) continue; related.set(asset.id, effective(asset));
      if (asset.retirement === 'part') queue.push(...[...assets.values()].filter(row => row.belongs_to === asset.id)); }
    for (const id of identityLinks.get(input.asset_id ?? '') ?? []) { const asset = assets.get(id); if (asset) related.set(id, effective(asset)); }
    // As the server reads them: an occasion's page gets the suggestions that would change
    // it (§15.2), and no list but an episode's own address shows one the owner hid (P44).
    const hidden = (id: string) => suppressions.some(row => row.kind === 'episode' && !row.of && row.value === id);
    return { assets: selected, related_assets: [...related.values()], total_assets: matching.length, classes,
      proposals: input.asset_id ? [] : input.occasion_id ? [...proposals.values()].filter(row => row.subject?.collection === 'occasion' && row.subject.id === input.occasion_id)
        : [...proposals.values()].filter(row => !input.proposal_kind || row.kind === input.proposal_kind), total_proposals: proposals.size, matching_proposals: [...proposals.values()].filter(row => !input.proposal_kind || row.kind === input.proposal_kind).length,
      ...(input.asset_filter && !legacyFilters ? { asset_filter: { kind: input.asset_filter, unavailable } } : {}),
      ...(input.asset_sphere && !legacySpheres ? { asset_sphere: input.asset_sphere } : {}),
      ...(input.include_asset_summaries === true && !new URLSearchParams(location.search).has('yours_without_asset_summaries') ? { asset_summaries: selected.map(summaryFor) } : {}),
      occurrences: demo && (!input.asset_id || input.asset_id === 'passport') && commitment.lifecycle_state === 'pending' ? [{ id: 'passport-occurrence', asset_id: 'passport', rule_id: 'renew', title: commitment.statement, due_on: '2027-04-17', question: false, commitment, current_ask_id: null, later_until: null, closes_by_proof: true,
        renewal: { field: 'expires_on', current: '2027-04-17' } }] : [],
      // `&yours_proof=1` — a mailbox takes forwarded proof (D-325 §5.3).
      ...(new URLSearchParams(location.search).has('yours_proof') ? { proof_addresses: ['ana+done@example.test'] } : {}),
      occasions: [...occasions.values()].filter(row => !input.occasion_id || row.id === input.occasion_id),
      episodes: [...episodes.values()].filter(row => input.episode_id ? row.id === input.episode_id : !hidden(row.id) && (!input.occasion_id || row.occasion_id === input.occasion_id)),
      ...(input.include_derived && demo && !suppressions.some(row => row.kind === 'episode' && row.value === derived.id) ? { derived_episodes: [derived] } : {}),
      recall_rates: recallRates,
      sources: [{ id: 'mail:personal', name: 'Personal mail', enabled: true, proposals: proposals.size }], suppressions,
      observation_handoffs: input.asset_id ? handoffs.filter(row => row.id.startsWith(`${input.asset_id}:`)) : [],
      ...(new URLSearchParams(location.search).has('yours_handoff_writer') ? {
        observation_recipes: [{ id: 'health', name: 'Asset monitor', publisher: 'Fixture', hash: 'fixture' },
          ...(new URLSearchParams(location.search).has('yours_multiple_writers') ? [{ id: 'second', name: 'Second monitor', publisher: 'Fixture', hash: 'second-fixture' }] : [])],
        observation_bindings: [{ id: 'monitor', asset_id: 'passport', actor_ref: 'recipe:health', source_ref: 'device:monitor', fields: ['readings.odometer', 'observations.damage'], enabled: true, available: true }],
      } : provenance ? {
        observation_recipes: [{ id: 'porch', name: 'Porch light check', publisher: 'Fixture', hash: 'hash' }],
        observation_bindings: [{ id: 'porch', asset_id: 'passport', actor_ref: 'recipe:porch', source_ref: 'recipe:fixture/porch#hash', fields: ['observations.flickering'], enabled: true, available: true }],
      } : {}),
      ...(enrolledWriters.length ? { observation_bindings: enrolledWriters } : {}),
      // `&yours_holder_gone=1` — the server says the holder's contact is no longer on file.
      ...(input.asset_id === 'passport' && new URLSearchParams(location.search).has('yours_holder_gone') ? { holder: { contact_id: 'ana', name: null } } : {}),
      intake: { emails_read: 42, receipts_found: 3, likely_assets: proposals.size, last_scan_at: time }, unmatched_replies: [], phone_ready: false,
      settings: { digest: 'weekly', last_time: lastTime, measures: false }, sphere_placements: [
        ...selected.map(row => ({ collection: 'asset', id: row.id })), ...[...occasions.values()].map(row => ({ collection: 'occasion', id: row.id })),
        ...[...episodes.values(), derived].map(row => ({ collection: 'episode', id: row.id! })), { collection: 'commitment', id: commitment.id },
      ].map(ref => ({ ref, ...placementFor(ref) })),
      sphere_sources: ['mail:personal', 'calendar:work'].map(source => ({ source, name: source, ...(sourceSpheres.has(source) ? { sphere: sourceSpheres.get(source)! } : {}) })),
      household: { telegram: householdTelegram, telegram_connections: [{ name: 'Family', enrolled_at: 200, recipient: '-100123' }],
        home_assistant: { selection: householdHA, connections: [{ name: 'house', enrolled_at: 300 }], issue: null, uncertain: 0 },
        // The server's list for Settings, from each asset's own audience (the fixture has no inheritance).
        shared_assets: (shared => ({ assets: shared.slice(0, 6).map(({ id, name }) => ({ id, name })), total: shared.length }))([...assets.values()]
          .filter(row => row.audience === 'household' && ['active', 'lent'].includes(row.status) && row.deleted_at == null).sort((a, b) => a.name.localeCompare(b.name))) },
      ...(input.asset_id ? { retirement_impact: { parts: 0, contracts: 0, open_occurrences: commitment.lifecycle_state === 'pending' ? 1 : 0 } } : {}) };
  };
  const change = (input: YoursCommand): { result?: unknown; error?: { code: string; message: string } } => {
    // §15.7 (2026-10-24) — as the server: the passport's renewal is done by its new date.
    if (input.action === 'occurrence.acknowledge') {
      renewals.push(structuredClone(input)); acknowledged = true;
      return { result: { message: 'Noted. It stays open until its new date is entered under Yours → Due, and Today shows it again at its next reminder.' } };
    }
    if (input.action === 'occurrence.renewed') {
      renewals.push(structuredClone(input));
      if (!(input.on > '2027-04-17')) return { error: { code: 'bad_request', message: 'Enter a date after 2027-04-17' } };
      commitment.lifecycle_state = 'fulfilled';
      return { result: { message: 'New date saved. This task is done, and the next reminders follow the new date.' } };
    }
    if (input.action === 'asset.automatic_updates') {
      handoffWrites.push(structuredClone(input));
      if (handoffFailures-- > 0) return { error: { code: 'UNAVAILABLE', message: 'The fixture handoff is unavailable. Try again.' } };
      const asset = assets.get(input.id)!; const [kind, field] = input.path.split('.') as ['readings' | 'observations', string];
      if (handoffStale-- > 0) {
        asset.field_sources[input.path] = { kind: 'owner', ref: 'owner', at: time, revision: `changed-${++factRevision}` };
        if (kind === 'readings') asset.readings[field] = { value: 9800, unit: 'km', as_of: time, evidence: [] };
      }
      const value = asset[kind][field]!; const source = asset.field_sources[input.path]!;
      if (JSON.stringify(input.expected) !== JSON.stringify({ value, source })) return { error: { code: 'CONFLICT', message: 'This field changed. Refresh the asset before allowing automatic updates.' } };
      if (asset.automatic_updates?.[input.path] === undefined) {
        asset.automatic_updates = { ...asset.automatic_updates, [input.path]: Math.max(time, source.at, value?.as_of ?? 0) };
        handoffs.push({ id: `${asset.id}:${handoffs.length + 1}`, path: input.path, at: time, value: structuredClone(value), source: structuredClone(source) });
      }
      return { result: { message: 'Automatic updates allowed. Your entry stays until a fresh authorized observation arrives.' } };
    }
    if (input.action === 'binding.disable') {
      relationshipWrites.push(structuredClone(input));
      const binding = enrolledWriters.find(row => row.id === input.id); if (binding) binding.enabled = false;
      return { result: { message: 'Writer disabled.' } };
    }
    if (input.action === 'binding.save') {
      relationshipWrites.push(structuredClone(input));
      enrolledWriters.push({ id: `writer-${input.recipe_id}`, asset_id: input.asset_id, actor_ref: `recipe:${input.recipe_id}`, source_ref: `recipe:${input.recipe_id}`, fields: input.fields, enabled: true, available: true });
      return { result: { message: 'Writer enrolled for the reviewed fields.' } };
    }
    if (input.action === 'asset.add_evidence') {
      relationshipWrites.push(structuredClone(input));
      const [group, field] = input.path.split('.') as ['readings' | 'observations', string];
      assets.get(input.id)![group][field]!.evidence.push(input.evidence);
      return { result: { message: 'Evidence added. The observation and its writer keep their existing authority.' } };
    }
    if (input.action === 'asset.record_attribute_reading') {
      factWrites.push(structuredClone(input));
      if (new URLSearchParams(location.search).has('yours_copy_conflict')) return { error: { code: 'bad_request', message: 'This text or its source changed. Refresh and review it before recording a reading.' } };
      const asset = assets.get(input.id)!;
      asset.readings[input.field] = { ...input.reading, evidence: [{ collection: 'asset', id: asset.id, field: `attributes.${input.attribute}`, value: input.expected_source.value }] };
      asset.field_sources[`readings.${input.field}`] = { kind: 'owner', ref: 'paired-owner', at: Date.now(), revision: `copy:${input.request_id}` };
      return { result: { id: asset.id, message: 'Reading recorded. The original text is unchanged.' } };
    }
    if (input.action === 'asset.update') factWrites.push(structuredClone(input));
    if (input.action === 'navigation.open') navigationOpens.push(structuredClone(input));
    if (input.action === 'rule.save' || input.action === 'proposal.edit' || input.action === 'class.save') ruleWrites.push(structuredClone(input));
    if (input.action === 'household.telegram') householdTelegram = input.connection_name === null ? null : {
      connection_name: input.connection_name, connection_enrolled_at: input.connection_enrolled_at!, recipient: '-100123', selected_at: time };
    if (input.action === 'household.home_assistant') householdHA = input.connection_name === null ? null : {
      connection_name: input.connection_name, connection_enrolled_at: input.connection_enrolled_at!, entity_id: input.entity_id!, base_url: 'http://ha.local:8123', selected_at: time };
    if (input.action === 'delivery.update') delivery = { ...delivery, settings: { ...delivery.settings, ...input.settings } };
    if (input.action === 'occasion.save') { const id = input.occasion.id ?? `occasion-${++number}`; const old = occasions.get(id);
      occasions.set(id, { ...input.occasion, id, created_at: old?.created_at ?? time, updated_at: time, rules: input.occasion.rules.length || old ? input.occasion.rules : [{ ...rule, id: 'date', title: input.occasion.title,
        when: { kind: 'expiry', field: 'next_on' }, consequence: 'routine', expiry_policy: 'strict_expire', reaction: { notify: true, occurrence: 'notice', emit: false }, schedule: { before: [{ amount: 1, unit: 'weeks' }], on_day: true } }] }); }
    if (input.action === 'occasion.delete') occasions.delete(input.id);
    if (input.action === 'episode.save') { const id = input.episode.id ?? `episode-${++number}`; episodes.set(id, { ...input.episode, id, basis: 'declared', storage_reason: input.episode.id ? 'owner_correction' : 'owner_record', created_at: time, updated_at: time }); }
    if (input.action === 'episode.delete') { episodes.delete(input.id); suppressions.push({ id: `suppression-${++number}`, kind: 'episode', value: input.id, created_at: time }); }
    if (input.action === 'suppression.save') suppressions.push({ ...input.suppression, id: `suppression-${++number}`, created_at: time });
    if (input.action === 'suppression.delete') { const index = suppressions.findIndex(row => row.id === input.id); if (index >= 0) suppressions.splice(index, 1); }
    if (input.action === 'episode.hide') {
      const episode = episodes.get(input.id) ?? (input.id === derived.id ? derived : undefined);
      if (!episode) return { error: { code: 'bad_request', message: 'Episode not found' } };
      suppressions.push({ id: `suppression-${++number}`, kind: 'episode', value: input.id, label: episode.title, created_at: time });
      // As the server does, one more row per item of its evidence, belonging to it.
      for (const ref of episode.evidence) suppressions.push({ id: `suppression-${++number}`, kind: 'episode', value: `episode-evidence-${ref.id}`, of: input.id, created_at: time });
      return { result: { message: 'Hidden. Recued will not show it again or suggest anything from it. Undo it under Memory exclusions in Episodes.' } };
    }
    if (input.action === 'settings.update' && input.last_time) lastTime = input.last_time;
    if (input.action === 'place.save') return { result: { id: 'place-las-vegas', message: 'Place names saved.' } };
    if (input.action === 'delivery.send_now') { const row = { at: time, mode: 'manual', state: 'sent', text: 'Lisbon trip · Passport expiry', delivered_to: ['in_app'] }; delivery = { ...delivery, last_run: row, last_sent: row }; }
    if (input.action === 'asset.update' && failures-- > 0) return { error: { code: 'UNAVAILABLE', message: 'The fixture write is unavailable. Try again.' } };
    if (input.action === 'asset.create') {
      const id = `new-${++number}`; const preset = classes.find(preset => preset.id === input.class_id);
      // The wire patch uses null to clear optional top-level facts. A stored
      // Asset omits those fields; null values inside its date map stay unknown.
      const facts = { ...Object.fromEntries(Object.entries(input.input).filter(([, value]) => value !== null)), name: input.input.name } as Partial<Asset> & { name: string };
      assets.set(id, make(id, { ...(preset ? { dates: preset.fields.dates, rules: structuredClone(preset.rules), class_id: preset.id, audience: preset.audience } : {}), ...facts }));
      return { result: { id, message: 'Asset created.' } };
    }
    if (input.action === 'asset.update') {
      // As on the server, null clears a fact the asset set itself.
      const current = assets.get(input.id)!;
      // Another owner updates the document after this browser opened its asset
      // editor. The server merges attribute keys rather than replacing the map.
      if (new URLSearchParams(location.search).has('yours_concurrent_document')) {
        assets.set(current.id, { ...current, attributes: { ...current.attributes,
          [ASSET_DOCUMENT_DETAILS_ATTRIBUTE]: { [receipt.file_id]: { purpose: 'Updated elsewhere', revision: 'Edition 2026' } } } });
      }
      const latest = assets.get(input.id)!;
      const automatic = { ...latest.automatic_updates };
      for (const kind of ['readings', 'observations'] as const) for (const key of Object.keys(input.patch[kind] ?? {})) delete automatic[`${kind}.${key}`];
      // Typed as an Asset throughout: a whole-object `as Asset` here hid that the
      // spread of an untyped copy supplied none of its fields (check:object-casts).
      const next: Asset = { ...latest }; const fields = next as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(input.patch)) if (value === null) delete fields[key]; else fields[key] = value;
      assets.set(input.id, { ...next, dates: { ...latest.dates, ...input.patch.dates },
        readings: { ...latest.readings, ...input.patch.readings }, observations: { ...latest.observations, ...input.patch.observations },
        field_sources: { ...latest.field_sources, ...Object.fromEntries(['readings', 'observations'].flatMap(kind =>
          Object.keys(input.patch[kind as 'readings' | 'observations'] ?? {}).map(key => [`${kind}.${key}`, { kind: 'owner' as const, ref: 'owner', at: time, revision: `manual-${++factRevision}` }]))) },
        automatic_updates: automatic,
        attributes: { ...latest.attributes, ...input.patch.attributes }, settings: { ...latest.settings, ...input.patch.settings } });
      // Acknowledge only the submitted facts. Native tests prove the independent
      // clock/task projection; this UI fixture does not calculate those clocks.
      const summary = summaryRows.find(row => row.asset_id === input.id);
      if (summary) summary.missing = summary.missing.filter(fact => {
        const [kind, key] = fact.path.split('.');
        if (kind === 'dates') return !input.patch.dates?.[key!];
        if (kind === 'readings') return !input.patch.readings?.[key!];
        const condition = input.patch.observations?.[key!];
        return !condition || condition.active && condition.certainty !== 'confirmed';
      });
    } else if (input.action === 'asset.link') {
      const asset = assets.get(input.id); if (!asset) return { error: { code: 'bad_request', message: 'Asset not found' } };
      let parent = input.parent_id; const seen = new Set([asset.id]);
      while (parent) {
        if (seen.has(parent)) return { error: { code: 'bad_request', message: 'belongs_to would create a cycle' } };
        seen.add(parent); const next = assets.get(parent); if (!next) return { error: { code: 'bad_request', message: 'Parent asset not found' } }; parent = next.belongs_to ?? null;
      }
      const next = { ...asset }; if (input.parent_id) next.belongs_to = input.parent_id; else delete next.belongs_to;
      assets.set(asset.id, next);
    } else if (input.action === 'asset.same_thing') {
      if (input.id === input.other_id || !assets.has(input.id) || !assets.has(input.other_id)) return { error: { code: 'bad_request', message: 'Choose two different assets' } };
      for (const [left, right] of [[input.id, input.other_id], [input.other_id, input.id]]) {
        const links = identityLinks.get(left!) ?? new Set<string>(); links.add(right!); identityLinks.set(left!, links);
      }
    } else if (input.action === 'asset.delete') assets.delete(input.id);
    else if (input.action === 'class.save') { const index = classes.findIndex(row => row.id === input.preset.id); if (input.create && index >= 0) throw new Error('This class id already exists. Choose a different id or edit the existing class.'); if (index < 0) classes.push(input.preset); else classes[index] = { ...input.preset, version: classes[index]!.version + 1 }; }
    else if (input.action === 'class.delete') { const index = classes.findIndex(row => row.id === input.id); if (index >= 0) classes.splice(index, 1); }
    else if (input.action === 'sphere.item') spherePlacements.set(JSON.stringify([input.ref.collection, input.ref.id]), { ...(input.sphere ? { sphere: input.sphere } : {}), reason: input.sphere ? 'placed by you' : 'unsorted', pinned: !!input.sphere, source: 'mail:personal' });
    else if (input.action === 'sphere.source') { if (input.sphere) sourceSpheres.set(input.source, input.sphere); else sourceSpheres.delete(input.source); }
    else if (input.action === 'file.attach') { if (!fileLinks.some(row => row.from_id === input.asset_id && row.to_id === input.record_id)) fileLinks.push({ _id: `file-link-${++number}`, _collection: 'link', from_collection: 'asset', from_id: input.asset_id, to_collection: 'file', to_id: input.record_id, role: 'attachment', authored_by_recipe_id: 'owner', created_at: time }); }
    else if (input.action === 'file.details' || input.action === 'file.detach') {
      const current = assets.get(input.asset_id)!;
      const documents = { ...current.attributes[ASSET_DOCUMENT_DETAILS_ATTRIBUTE] as Record<string, unknown> | undefined };
      if (input.action === 'file.details') documents[input.record_id] = Object.fromEntries(Object.entries(input.details).filter(([, value]) => value?.trim()).map(([key, value]) => [key, value.trim()]));
      else { delete documents[input.record_id]; const index = fileLinks.findIndex(row => row._id === input.link_id); if (index >= 0) fileLinks.splice(index, 1); }
      assets.set(current.id, { ...current, attributes: { ...current.attributes, [ASSET_DOCUMENT_DETAILS_ATTRIBUTE]: documents } });
    }
    else if (input.action === 'class.apply') { const old = assets.get(input.asset_id)!; const preset = classes.find(preset => preset.id === input.class_id)!; assets.set(old.id, { ...old, class_id: preset.id, rules: structuredClone(preset.rules), dates: { ...preset.fields.dates, ...old.dates } }); }
    else if (input.action === 'rule.save') { const old = assets.get(input.asset_id)!; assets.set(old.id, { ...old, rules: [...old.rules.filter(rule => rule.id !== input.rule.id), input.rule] }); }
    else if (input.action === 'proposal.edit') { const proposal = proposals.get(input.id)!; proposals.set(input.id, { ...proposal,
      ...(input.title !== undefined ? { title: input.title } : {}), ...(input.payload ? { payload: input.payload } : {}) }); }
    else if (input.action === 'proposal.accept') { for (const id of input.ids) { const proposal = proposals.get(id); if (!proposal) continue;
      if (proposal.kind === 'asset') { const data = proposal.payload.asset as Partial<Asset> & { name: string }; assets.set(`accepted-${id}`, make(`accepted-${id}`, data)); }
      if (proposal.kind === 'habit') { const data = proposal.payload.occasion as Occasion; occasions.set(`accepted-${id}`, { ...data, id: `accepted-${id}`, rules: [{ ...(proposal.payload.rule as AssetRule), enabled: true, pinned: true }], created_at: time, updated_at: time }); }
      proposals.delete(id); } }
    else if (input.action === 'proposal.dismiss' || input.action === 'proposal.delete') proposals.delete(input.id);
    return { result: { message: 'Change saved.' } };
  };
  return (method: string, raw: unknown): { result?: unknown; error?: { code: string; message: string } } | null => {
    if (method === 'chat.send' || method === 'chat.session.create') chatCalls.push({ method, args: structuredClone(raw as Record<string, unknown>) });
    if (assetQueue && method === 'chat.send') {
      const input = raw as { session_id: string; message: string };
      queuedAssetQuestion = { session_id: input.session_id, turn_id: 'asset-question-turn', message: input.message,
        status: 'queued', position: 0, created_at: time, duplicate_count: 0, withdraw_to_edit_available: true };
      queueRevision++;
    }
    if (assetQueue && method === 'chat.turns.list') return { result: { generation: 'gen_fixture_1', revision: queueRevision,
      turns: queuedAssetQuestion?.session_id === (raw as { session_id: string }).session_id ? [structuredClone(queuedAssetQuestion)] : [] } };
    if (assetQueue && method === 'chat.turn.withdraw' && queuedAssetQuestion) {
      const input = raw as { session_id: string; turn_id: string };
      if (input.session_id !== queuedAssetQuestion.session_id || input.turn_id !== queuedAssetQuestion.turn_id) return { error: { code: 'not_found', message: 'Queued question not found.' } };
      queuedAssetQuestion.status = 'withdrawn'; queueRevision++;
      return { result: { ...input, message: queuedAssetQuestion.message } };
    }
    if (absent && method.startsWith('yours.')) return { error: { code: 'unknown_method', message: 'Unknown method' } };
    // §15.7 amendment — `?household_lists=1`: the Home Assistant connection's lists, read live.
    // Otherwise a server before the menu, which keeps the typed list id.
    if (method === 'yours.household_lists') {
      const input = raw as { connection_name: string; connection_enrolled_at: number };
      if (!new URLSearchParams(location.search).has('household_lists')) return { error: { code: 'unknown_method', message: 'Unknown method' } };
      if (input.connection_name !== 'house' || input.connection_enrolled_at !== 300) return { error: { code: 'bad_request', message: 'Choose an enrolled Home Assistant connection' } };
      return { result: { lists: [{ entity_id: 'todo.chores', name: 'Chores', usable: true },
        { entity_id: 'todo.household', name: 'Household', usable: true }] } };
    }
    if (method === 'yours.today') return { result: today(raw as { now: number; before: number }) };
    if (method === 'yours.delivery') return { result: delivery };
    if (method === 'yours.learning') return { result: { last_time: lastTime, classes: recallRates,
      asked: lastTime === 'unasked' && new URLSearchParams(location.search).has('yours_last_time_asked') } };
    if (method === 'yours.context') {
      const { root } = raw as import('@recued/contracts').AssetFactContextRequest;
      const asset = assets.get(root.asset_id)!;
      const rule = root.kind === 'rule' ? asset.rules.find(value => value.id === root.rule_id)! : undefined;
      const field: import('@recued/contracts').AssetFieldRef = root.kind === 'field' ? root : { kind: 'field', asset_id: asset.id,
        group: rule!.when.kind === 'objective' ? 'readings' : rule!.when.kind === 'condition' ? 'observations' : 'dates', field: rule!.when.field };
      const value = asset[field.group][field.field] ?? null;
      const fieldNode: import('@recued/contracts').AssetFactContextNode = { kind: 'field', ref: field, label: field.field.replaceAll('_', ' '), value, known: value !== null,
        source: asset.field_sources[`${field.group}.${field.field}`] ?? null };
      const rules: import('@recued/contracts').AssetFactContextNode[] = asset.rules.filter(row => row.when.field === field.field).map(row => ({ kind: 'rule', ref: { kind: 'rule', asset_id: asset.id, rule_id: row.id }, title: row.title, rule: row }));
      const packet: import('@recued/contracts').AssetFactContext = { root, asset: { id: asset.id, name: asset.name, status: new URLSearchParams(location.search).has('yours_retired_context') ? 'retired' : asset.status }, nodes: [fieldNode, ...rules],
        edges: rules.map(node => ({ from: node.ref, to: field, kind: 'uses' })), read_at: Date.now(), freshness: 'current', completeness: 'complete', omitted: [], missing: value === null ? [field] : [] };
      return { result: packet };
    }
    if (method === 'yours.read') {
      if ((raw as YoursReadRequest).search !== undefined && assetSearchFailures-- > 0) return { error: { code: 'unavailable', message: 'Asset search unavailable. Try again.' } };
      // P44: a list read must never ask the server to assemble derived episodes.
      if ((raw as YoursReadRequest).include_derived && !(raw as YoursReadRequest).episode_id) {
        (globalThis as { __yoursDerivedListReads?: number }).__yoursDerivedListReads = ((globalThis as { __yoursDerivedListReads?: number }).__yoursDerivedListReads ?? 0) + 1;
      }
      return { result: snapshot(raw as YoursReadRequest) };
    }
    if (method === 'yours.change') return change(raw as YoursCommand);
    if (method === 'yours.sphere') { const ref = (raw as { ref: { collection: string; id: string } }).ref; return { result: spherePlacements.get(JSON.stringify([ref.collection, ref.id])) ?? { reason: 'unsorted', pinned: false, source: 'mail:personal' } }; }
    if (method === 'yours.spheres') return { result: { placements: (raw as { refs: Array<{ collection: string; id: string }> }).refs.map(ref => ({ ref,
      ...(spherePlacements.get(JSON.stringify([ref.collection, ref.id])) ?? { sphere: 'personal', reason: 'from: personal source', pinned: false }) })) } };
    if (!location.hash.startsWith('#yours') && !demo) return null;
    if (demo && method === 'work_entity.list') {
      const kind = (raw as { kind: string }).kind;
      const entities = kind === 'commitment' && commitment.lifecycle_state === 'pending' ? [{ ...commitment, _kind: 'commitment' }] : [];
      return { result: { entities, total: entities.length } };
    }
    if (demo && method === 'work_entity.source.list') return { result: { sources: [{ id: 'recued.commitment', top_tier_kind: 'commitment', source_kind: 'builtin', source_label: 'My commitments', write_capable: true, registered_at: time }] } };
    if (method === 'contact.list') return { result: { contacts: [ana], total: 1 } };
    if (demo && method === 'contact.get') return { result: { contact: ana } };
    if (method === 'link.forRecord') return { result: { links: fileLinks.filter(row => row.from_id === (raw as { id: string }).id) } };
    if (method === 'data.file.attachments.list') {
      const args = raw as { query?: string; cursor?: string }; const query = args.query?.trim().toLowerCase() ?? '';
      const matching = retainedFiles.filter(file => file.filename.toLowerCase().includes(query));
      const offset = args.cursor === 'fixture-next' ? 1 : 0;
      return { result: { files: pagedFiles ? matching.slice(offset, offset + 1) : matching,
        ...(pagedFiles && matching.length > offset + 1 ? { next_cursor: 'fixture-next' } : {}) } };
    }
    if (method === 'data.file.attachments.get') {
      if (fileDetailsMode === 'missing' || metadataFailures-- > 0) return { error: { code: 'file_not_found', message: 'File is unavailable' } };
      const selected = retainedFiles.find(file => file.file_id === (raw as { record_id: string }).record_id) ?? receipt;
      return { result: { ...selected, ...(fileDetailsMode === 'mismatch' ? { file_id: 'file:received:wrong', filename: 'Unrelated private file.txt' } : {}) } };
    }
    if (method === 'data.file.attachments.preview') return { result: { record_id: 'file:received:receipt', filename: 'Passport receipt.txt', mime_type: 'text/plain', size_bytes: 16, transient: false, can_download: false, content: { kind: 'text', bytes_b64: btoa('Passport receipt') } } };
    if (method === 'data.timeline') return { result: { entries: [] } };
    if (method === 'work_entity.commitment.fulfill' || method === 'work_entity.commitment.cancel') {
      // §15.7 (2026-10-24) — as the server: Done alone does not renew the passport.
      if (method.endsWith('fulfill')) return { error: { code: 'bad_request', message: `“${commitment.statement}” is done once its new date is entered. Enter it under Yours → Due.` } };
      commitment.lifecycle_state = 'cancelled'; return { result: { entity: { ...commitment, _kind: 'commitment' } } };
    }
    return null;
  };
};
