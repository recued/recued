import { createContactStore } from '../storage/contact-store.js';
import { createContactKnownValueIndexBuilder } from '../chat-recall-index.js';
/** Real queue, mail table/readers, dispatch and PII boundary; scripted answers
 * deliberately request no tools. These are mechanism tests, not AI scores. */
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { TIER1_TOOL_DESCRIPTORS, type InternalToolRegistry, type ToolEntry } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { createStorageGate } from '@recued/storage-gate';
import { createCollectionTable } from '../collections/table.js';
import { createCollectionRegistry } from '../collections/registry.js';
import type { Collection } from '../collections/types.js';
import { buildRecord, mailFtsText } from '../collections/mail/mail-collection.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createChatOrchestrator, type BroadcastChatEvent } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { handleSend } from '../chat-handler.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createReadGrantChecker } from '../read-grant-checker.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';
import { parseMailWorkReadRequest } from '../mail-work-fresh-read.js';
import { MAIL_WORK_PLAN_INVESTIGATION as MAIL_WORK_INVESTIGATION_GUIDANCE, MAIL_WORK_PLAN_OUTPUT_SHAPE as MAIL_WORK_OUTPUT_SHAPE,
  MAIL_WORK_PLAN_REFINEMENT as MAIL_WORK_REFINEMENT_GUIDANCE } from '../mail-work-chat-plan-guidance.js';
import { mailWorkOwnerRequest } from '../mail-work-evidence.js';
import { mailWorkChatPrompt } from '../../../../apps/webclient/src/mail/mail-work-investigation.js';
import { MAIL_WORK_PLANNING_CHOICE } from '../mail-work-turn-contract.js';

const observations = (packet: Record<string, any>): any[] => (packet.prior_tool_calls ?? []).flatMap((call: any) =>
  call.tool_name === 'context.mail_work_evidence' ? call.result.observations : [call]);

const NOW = Date.parse('2026-09-30T12:00:00Z');
const SENDER = 'customer@private.example';
const request = { seeds: [{ slug: 'work', record_id: 'seed' }] };
const fixture = (db = new Database(':memory:'), names: string[] = []) => {
  ensureChatSchema(db);
  const store = createChatStore(db);
  if (!store.getSession('s')) store.createSession({ id: 's', model_routing: { current: 'byok' } });
  store.setRollingBriefEnabled(true);
  const table = createCollectionTable({ db, platform: 'mail', slug: 'work', ftsTextFor: mailFtsText });
  const collection: Collection = {
    platform: 'mail', slug: 'work', gate: createStorageGate({ quota: 10_000_000, reservePct: 0, surface: 'test:mail' }),
    get: table.get, list: table.list, search: table.search, upsert: table.upsert, delete: id => table.delete(id) !== null,
    health: () => ({ platform: 'mail', slug: 'work', last_indexed_at: NOW, pending_queue_size: 0, error_count_24h: 0, state: 'idle' }),
    sync: { start: async () => {}, stop: async () => {} }, close: async () => {},
    runRetention: async () => { throw new Error('Unexpected retention'); },
  };
  const collections = createCollectionRegistry(); collections.register(collection);
  const add = (id: string, body: string, date = NOW, thread = 'client-thread', from = SENDER, subject = 'Cobalt request') => {
    const { record } = buildRecord({ source_id: id, rfc_message_id: `<${id}@fixture.test>`, thread_id: thread,
      subject, from, to: ['owner@private.example'], cc: [], direction: 'inbound', folder_or_label: 'INBOX',
      is_read: true, is_flagged: false, has_attachments: false, received_at: date, body_text: body }, () => NOW);
    table.upsert({ ...record, record_id: id, body_inline: body });
  };
  add('seed', 'Please consider 23 October. Internal review is pending.');
  const control = { allowed: true, beforeRead: undefined as (() => Promise<void>) | undefined,
    afterSearch: undefined as ((args: unknown) => void) | undefined, requestWrite: false, searchQuery: '', extraSearches: false,
    response: undefined as string | undefined, operation: 'draft', target: undefined as string | undefined,
    useShortReferences: false, nativeRefinement: false, omitPlan: false, documentRead: false, discoverReader: false,
    twoStepPlan: false, invalidEdit: false,
    recap: undefined as unknown, omitRecap: false, malformedOnCall: 0,
    summary: { intent: 'Read current work', constraints: [] as string[], pending: [] as string[], findings: [] as string[], completed: [] as string[] } };
  const checker = () => createReadGrantChecker({ isGranted: () => control.allowed }, 'owner');
  const handlers = buildChatTier1Handlers({ getCollectionRegistry: () => collections,
    getContactStore: () => undefined, getAuditLog: () => undefined, getEnrichmentStore: () => undefined,
    getRecipeStore: () => { throw new Error('Unexpected recipe'); }, getExecutorConfig: () => { throw new Error('Unexpected execution'); },
    getExecuteRecipe: () => undefined, getReadGrantResolver: () => ({ resolveForSource: checker, resolveForContract: checker }),
    readMailBody: async record => { await control.beforeRead?.(); return record.body_inline ?? null; }, now: () => NOW });
  const catalog: ToolEntry[] = (['mail.read', 'mail.search', 'document.read', 'memory.write', 'calendar.search', 'deal.search'] as const).map(name => ({ ...TIER1_TOOL_DESCRIPTORS[name], tier: 1 }));
  catalog.push({ ...catalog[0]!, name: 'tools.search', description: 'Discover readers' });
  const discovered = { ...catalog[0]!, name: 'private-lookup', tier: 2 as const };
  const dispatched: Array<{ name: string; args: unknown }> = [];
  const registry: InternalToolRegistry = { list: () => catalog, listByTier: () => catalog,
    getByName: name => catalog.find(entry => entry.name === name) ?? (name === discovered.name ? discovered : null), subscribeRefresh: () => () => {},
    dispatch: async (name, args, context) => {
      dispatched.push({ name, args });
      if (name === 'tools.search') return { ok: true, result: { matches: [{ recipe_slug: discovered.name,
        description: `Read the private note for ${SENDER}.`, args_schema: { type: 'object', properties: {} } }] } };
      if (name === discovered.name) return { ok: true, result: { note: 'Supplemental context remains uncertain.' } };
      if (name === 'document.read') return { ok: true, result: { status: 'read', file_ref: 'file:' + 'a'.repeat(32),
        content_hash: 'b'.repeat(64), read_version: 'c'.repeat(64), body: `Prepare a glossary for ${SENDER}.` } };
      if (name === 'calendar.search') return { ok: true, result: { matches: [{ title: 'owner handover preparation' }] } };
      if (name === 'deal.search') return { ok: true, result: { candidates: [], envelope: { shape: { measures: { candidate_count: 0 } } } } };
      if (name !== 'mail.read' && name !== 'mail.search') throw new Error('Write reached dispatch');
      const result = await handlers[name]!(args, context);
      if (name === 'mail.search') control.afterSearch?.(args);
      return result;
    } };
  const events: BroadcastChatEvent[] = [];
  const packets: Array<Record<string, any>> = [];
  const schemas: any[] = [];
  const prompts: Array<{ system: string; packet: Record<string, any> }> = [];
  let briefCalls = 0;
  const selfSignature = { server_kind: 'recued' as const, version: 'test', instance_id: 'fresh-test' };
  const broadcast = { emit: (event: BroadcastChatEvent) => { events.push(event); } };
  const contacts = createContactStore(db);
  names.forEach((name, i) => contacts.upsertManual({ email: `known-${i}@fixture.test`, name }, NOW));
  const raw = createChatOrchestrator({ chatStore: store, registry, selfSignature, broadcast,
    piiLedgerStore: piiEgress.createSessionLedgerStore(),
    getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
    fieldPrivacyResolver: createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
      CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS),
    executeAiCall: async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      prompts.push({ system: String(input['llm.system_prompt']), packet });
      if (!Array.isArray(packet.available_tools)) {
        briefCalls++;
        return { body: control.summary };
      }
      packets.push(packet);
      schemas.push(input['llm.output_schema']);
      if (packets.length === control.malformedOnCall) return { body: 7 };
      // Both automatically gathered and later model-requested tool results use
      // the real privacy boundary. The owner message contains locators only.
      expect(JSON.stringify(packet)).not.toContain(SENDER);
      expect(JSON.stringify(input['llm.output_schema']) ?? '').not.toContain(SENDER);
      const reads = observations(packet).filter((call: any) => call.tool_name === 'mail.read');
      const current = reads.find((call: any) => typeof call.result?.body === 'string' && call.result.body.includes('WITHDRAWN'));
      const excerptSource = current ?? reads.find((call: any) => typeof call.result?.body === 'string');
      const shortSource = excerptSource?.recap_source;
      const recap = control.recap ?? (excerptSource ? [{ source: control.useShortReferences ? shortSource : excerptSource.result.source_url,
        quote: excerptSource.result.body.slice(0, 800), state: 'current' }] : undefined);
      const response = control.response ?? (current ? `${current.result.hot_fields.from}: WITHDRAWN; explore documentation only.` : 'Older option is pending.');
      const taskShape = (input['llm.output_schema'] as any)?.properties.mail_work_plan.anyOf[0].properties.task;
      const task = taskShape?.const ?? taskShape?.enum[0];
      const evidence = (packet.prior_tool_calls ?? []).find((call: any) =>
        call.tool_name === 'context.mail_work_evidence' || call.tool_name === 'context.mail_work_source_catalog')?.result;
      const document = observations(packet).find((call: any) => call.tool_name === 'document.read' && call.result?.status === 'read');
      const selected = document ? [{ source: evidence.source_catalog.find((row: any) => row.file_ref === document.result.file_ref).source,
        quote: document.result.body }] : recap;
      const facts = ((selected as any[]) ?? [{ source: 'owner_request', quote: evidence?.investigation_request ?? packet.user_message }])
        .map(({ source, quote }) => {
          const key = reads.find((call: any) => call.result?.source_url === source || call.args?.record_id === source)?.recap_source
            ?? evidence?.source_catalog?.find((row: any) => row.source_url === source)?.source ?? source;
          return evidence?.passage_catalog?.find((row: any) => row.source === key && row.text.includes(quote))?.id ?? 'passage_invalid';
        });
      return { body: { ...(control.omitRecap ? {} : { mail_work_recap: recap }),
        mail_work_plan: !control.omitPlan && (task === 'propose' || control.nativeRefinement) ? packet.mail_work_edit_target ? { task, base: packet.mail_work_edit_target.base, facts: null,
          action_edits: [{ kind: 'update', id: control.invalidEdit ? 'action_missing' : 'action_1', after: null, value: { operation: control.operation,
            target: control.target ?? response, context: [facts[0]], source_notes: [] } }], question_edits: [],
        } : { task, facts, actions: [{
          operation: control.operation, target: control.target ?? response,
          context: [facts[0]], source_notes: [],
        }, ...(control.twoStepPlan ? [{ operation: 'outline', target: 'the internal outline', context: [facts[0]], source_notes: [] }] : [])],
          questions: control.twoStepPlan ? [{ kind: 'cost', context: [facts[0]] }, { kind: 'timing', context: [facts[0]] }] : [] } : null,
        response, events: [],
        tool_calls: control.discoverReader && packets.length === 1 ? [{ tool: 'tools.search', args: { query: 'private notes' } }]
          : control.discoverReader && packets.length === 2 ? [{ tool: packet.prior_tool_calls.find((call: any) => call.tool_name === 'tools.search').result.matches[0].recipe_slug, args: {} }]
          : control.requestWrite && packets.length === 1 ? [{ tool: 'memory.write', args: { text: 'Save this work' } }]
          : control.documentRead && packets.length === 1 ? [{ tool: 'document.read', args: { file_ref: 'file:' + 'a'.repeat(32) } }]
          : control.searchQuery && packets.length === 1 ? [{ tool: 'mail.search', args: { query: control.searchQuery } }]
          : control.extraSearches && packets.length === 1 ? [{ tool: 'calendar.search', args: { query: 'handover' } },
            { tool: 'deal.search', args: { query: 'handover' } }] : [] } };
    } });
  const orchestrator = withQueuedChatTurns(raw, { db, store, broadcast, pollMs: 5 });
  const deps = { store, orchestrator, selfSignature };
  const send = async (message = 'Investigate seed in work. Save this work only if permitted.', prepared = true) => {
    const ack = await handleSend(deps, { session_id: 's', message,
      picker_state: { current: 'self' }, ...(prepared ? { mail_work: request } : {}), repeat: true });
    await vi.waitFor(async () => expect((await orchestrator.turnQueue!.snapshot('s')).turns.find(t => t.turn_id === ack.turn_id)?.status).toBe('completed'));
    return (await store.listMessages('s')).filter(message => message.role === 'assistant').at(-1)!;
  };
  return { db, add, table, control, events, packets, schemas, prompts, dispatched, send, store, orchestrator, deps, briefCalls: () => briefCalls,
    close: (closeDb = true) => { orchestrator.turnQueue!.close(); if (closeDb) db.close(); } };
};

it('binds prepared tool names after privacy and preserves discovery and ordinary Chat', async () => {
  const f = fixture();
  try {
    f.control.discoverReader = true;
    await f.send('Investigate the missing context privately.');
    expect(f.packets).toHaveLength(3);
    for (let i = 0; i < f.packets.length; i++) {
      const packet = f.packets[i]!;
      const declared = packet.available_tools.map((row: any) => row.recipe_slug);
      const discoveries = packet.prior_tool_calls.filter((call: any) => call.tool_name === 'tools.search' && call.status === 'ok')
        .flatMap((call: any) => call.result.matches.map((row: any) => row.recipe_slug));
      for (const branch of [f.schemas[i], ...f.schemas[i].anyOf]) {
        const names = branch.properties.tool_calls.items.properties.tool.enum;
        expect(names).toEqual([...new Set([...declared, ...discoveries])]);
        expect(names).not.toContain('context.mail_work_evidence');
        expect(names).not.toContain('memory.write');
      }
      expect(JSON.stringify(packet)).not.toContain(SENDER);
      expect(JSON.stringify(f.schemas[i])).not.toContain(SENDER);
    }
    const discovery = f.packets[1]!.prior_tool_calls.find((call: any) => call.tool_name === 'tools.search').result;
    expect(discovery.matches[0].description).not.toContain(SENDER);
    const wireName = discovery.matches[0].recipe_slug;
    expect(f.schemas[0].properties.tool_calls.items.properties.tool.enum).not.toContain(wireName);
    expect(f.schemas[1].properties.tool_calls.items.properties.tool.enum).toContain(wireName);
    expect(f.dispatched).toContainEqual({ name: 'private-lookup', args: {} });
    await f.send('Continue normally.', false);
    expect(f.schemas.at(-1).properties.tool_calls.items.properties.tool).toEqual({ type: 'string' });
  } finally { f.close(); }
});

it('renders and persists the prepared proposal breakpoint once, without imposing it on a later ordinary reply', async () => {
  const f = fixture();
  try {
    f.control.response = 'Prepare a private outline; the scope is open.';
    const saved = await f.send();
    expect(saved.content).toContain(f.control.response);
    expect(saved.content).toContain('This is a proposal.');
    expect(saved.content.endsWith(MAIL_WORK_PLANNING_CHOICE)).toBe(true);
    expect(saved.content.split(MAIL_WORK_PLANNING_CHOICE)).toHaveLength(2);
    const preview = f.events.filter((e: any) => e.kind === 'chat.token_streamed' && e.turn_id === saved.turn_id) as any[];
    expect(preview.map(e => e.delta).join('')).toBe(saved.content);
    f.control.response = 'The document contains three sections.';
    f.control.omitRecap = true;
    const ordinary = await f.send('How many sections does the document contain?', false);
    expect(ordinary.content).toBe(f.control.response);
    expect(ordinary.provenance ?? []).toEqual([]);
    expect(ordinary.content).not.toContain(MAIL_WORK_PLANNING_CHOICE);
    expect(f.packets).toHaveLength(2);
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it('carries short references through privacy, persistence, refinement and a fresh source read', async () => {
  const f = fixture();
  try {
    f.control.useShortReferences = true;
    f.add('seed', `Please draft an outline for ${SENDER}.`);
    const first = await f.send('Explore this privately.');
    expect(first.content).toContain('[Email](#data/mail/record/work/seed)');
    expect(first.content).toContain(SENDER);
    const catalog = () => f.packets.at(-1)!.prior_tool_calls.find((c: any) => c.tool_name === 'context.mail_work_evidence').result.source_catalog;
    const external = () => catalog().filter((row: any) => typeof row.source_url === 'string');
    const original = external();
    expect(original).toEqual([{ source: expect.stringMatching(/^mail_[a-f0-9]{12}$/u), source_url: '#data/mail/record/work/seed', scope_role: 'work_anchor' }]);
    expect(catalog()).toContainEqual({ source: 'owner_request', source_text: 'Explore this privately.' });
    expect(first.content).not.toContain(original[0].source);
    expect(await f.store.readMailWorkEvidence!('s')).not.toContain('source_catalog');
    expect(await f.store.readMailWorkEvidence!('s')).not.toContain('recap_source');
    const checkAnnotation = () => {
      const reads = observations(f.packets.at(-1)!).filter((c: any) => c.tool_name === 'mail.read' && c.status === 'ok');
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) expect(read.recap_source).toBe(catalog().find((r: any) => r.source_url === read.result.source_url)?.source);
    };
    checkAnnotation();
    const refined = await f.send('Refine the private outline.', false);
    expect(external()).toEqual(original);
    expect(catalog()).toContainEqual({ source: 'owner_update_1', source_text: 'Refine the private outline.' });
    checkAnnotation();
    expect(refined.content).toContain('[Email](#data/mail/record/work/seed)');
    f.add('seed', `The first idea is WITHDRAWN. Prepare a private report for ${SENDER} instead.`);
    const refreshed = await f.send('Read the current source again.');
    expect(external()).toEqual(original);
    expect(catalog()).toContainEqual({ source: 'owner_request', source_text: 'Read the current source again.' });
    checkAnnotation();
    expect(refreshed.content).toContain('The first idea is WITHDRAWN.');
    expect(refreshed.content).not.toContain('Please draft an outline');
    expect(f.packets).toHaveLength(3);
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it('keeps source carry independent of AI summaries and retains planning guidance for refinement', async () => {
  const f = fixture();
  try {
    const message = mailWorkChatPrompt({ work: { id: 'mw_test', revision: 1, title: 'Cobalt request', goal: 'Explore scope',
      owner_notes: 'I heard by phone that the first option was withdrawn. Do not contact anyone.',
      status: 'active', resolution_note: '', brief: null, reviewed_fingerprint: null, created_at: NOW, updated_at: NOW,
      threads: [{ slug: 'work', seed_record_id: 'seed', thread_id: 'client-thread', subject: 'Cobalt request' }] },
      chat_session_id: 's', needs_review: true, sources: [], warnings: [] });
    await f.send(message);
    expect(f.prompts[0]!.system).toContain(MAIL_WORK_INVESTIGATION_GUIDANCE);
    expect(f.prompts[0]!.packet.user_message).toBe(message);
    expect(f.prompts.some(p => 'tool_results_since' in p.packet)).toBe(false);
    const evidence = JSON.parse((await f.store.readMailWorkEvidence!('s'))!);
    expect(evidence.investigation_request).toBe(mailWorkOwnerRequest(message));
    expect(JSON.stringify(evidence)).not.toContain(MAIL_WORK_INVESTIGATION_GUIDANCE);
    await f.send('Continue refining the plan.', false);
    expect(f.prompts.at(-1)!.system).not.toContain(MAIL_WORK_INVESTIGATION_GUIDANCE);
    expect(f.prompts.at(-1)!.system).toContain(MAIL_WORK_REFINEMENT_GUIDANCE);
    expect(f.prompts.at(-1)!.packet.user_message).toBe('Continue refining the plan.');
    for (const { system } of f.prompts) {
      expect(system).toContain(MAIL_WORK_OUTPUT_SHAPE);
      expect(system).not.toContain('AIOutput shape:\n');
      expect(system).not.toContain('AIOutput shape ({"response", "events", "tool_calls"})');
      expect(system).toContain('"mail_work_plan":null');
    }
  } finally { f.close(); }
});

it('closes mixed mail, calendar and CRM searches without a summary call and carries their exact results into refinement', async () => {
  const f = fixture(undefined, ['owner']);
  try {
    f.control.extraSearches = true;
    await f.send('Explore the handover.');
    expect(f.packets).toHaveLength(2);
    expect(f.briefCalls()).toBe(0);
    const saved = JSON.parse((await f.store.readMailWorkEvidence!('s'))!);
    expect(saved.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool_name: 'calendar.search', result: { matches: [{ title: 'owner handover preparation' }] } }),
      expect.objectContaining({ tool_name: 'deal.search', result: expect.objectContaining({ candidates: [] }) }),
    ]));
    await f.send('Refine privately.', false);
    const evidence = f.packets.at(-1)!.prior_tool_calls.find((c: any) => c.tool_name === 'context.mail_work_evidence').result;
    expect(evidence.owner_updates).toEqual(['Refine privately.']);
    expect(evidence.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool_name: 'calendar.search', result: { matches: [{ title: expect.stringContaining('pii.Person') }] } }),
      expect.objectContaining({ tool_name: 'deal.search' }),
    ]));
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it.each([true, false])('keeps the Follow envelope and exact evidence during malformed-output repair (prepared: %s)', async prepared => {
  const f = fixture();
  try {
    if (!prepared) await f.send('Explore the selected work.');
    f.control.malformedOnCall = f.packets.length + 1;
    const before = f.packets.length;
    const answer = await f.send('Keep exploring privately.', prepared);
    expect(f.packets).toHaveLength(before + 2);
    const repair = f.packets.at(-1)!;
    expect(repair.output_feedback).toContain('mail_work_plan');
    expect(repair.output_feedback).not.toContain('Re-emit it as {"response"');
    expect(observations(repair)).toContainEqual(expect.objectContaining({ tool_name: 'mail.read',
      result: expect.objectContaining({ body: expect.stringContaining('23 October') }) }));
    expect(answer.content).toContain('Selected source excerpts');
    expect(answer.content).toContain('#data/mail/record/work/seed');
  } finally { f.close(); }
});

it('carries exact sources and owner steering past an incorrect AI proposal through a real queued refinement', async () => {
  const f = fixture();
  try {
    const context = { work: { id: 'mw_continuity', revision: 1, title: 'Cobalt request', goal: 'Explore feasibility',
      owner_notes: '', status: 'active' as const, resolution_note: '', brief: null, reviewed_fingerprint: null,
      created_at: NOW, updated_at: NOW,
      threads: [{ slug: 'work', seed_record_id: 'seed', thread_id: 'client-thread', subject: 'Cobalt request' }] },
      chat_session_id: 's', needs_review: true, sources: [], warnings: [] };
    await f.send(mailWorkChatPrompt(context));
    const notes = 'Phone correction: the client withdrew the 9 October request. Do not contact anyone without my approval.';
    const sourceUrl = '#data/mail/record/work/arrival';
    f.add('arrival', '23 October is WITHDRAWN. Please explore a documentation-only handover instead.', NOW + 1);
    // Deliberately wrong prior prose must stay separate from the source facts.
    // This proves input continuity, not live interpretation quality.
    f.control.summary = { intent: 'Explore a documentation-only handover', constraints: [notes],
      findings: [`23 October is withdrawn according to ${sourceUrl}.`], pending: ['Handover format is unknown.'], completed: [] };
    f.control.response = 'The old option is still available. Ask the client first.';
    const updated = mailWorkChatPrompt({ ...context, work: { ...context.work, owner_notes: notes, owner_notes_recorded_at: NOW, revision: 2 } });
    await f.send(updated);
    const refreshed = f.packets.at(-1)!;
    expect(refreshed.user_message).toBe(updated);
    expect(observations(refreshed)).toContainEqual(expect.objectContaining({ tool_name: 'mail.read',
      result: expect.objectContaining({ source_url: sourceUrl, body: expect.stringContaining('23 October is WITHDRAWN') }) }));
    const steering = 'Continue refining the plan. Make it shorter, prioritize the first private preparation step, and keep the remaining uncertainties visible.';
    await f.send(steering, false);
    const refined = f.packets.at(-1)!;
    expect(refined.user_message).toBe(steering);
    expect(refined.chat_tail).toContainEqual(expect.objectContaining({ role: 'user', content: updated }));
    expect(refined.chat_tail).toContainEqual(expect.objectContaining({ role: 'assistant', content: expect.stringContaining(f.control.response) }));
    const carried = refined.prior_tool_calls.find((call: any) => call.tool_name === 'context.mail_work_evidence');
    expect(carried.result.investigation_request).toBe(mailWorkOwnerRequest(updated));
    expect(carried.result.investigation_request).toContain('Notes saved at: 2026-09-30T12:00:00.000Z');
    expect(carried.result.owner_updates).toContain(steering);
    expect(carried.result.observations).toContainEqual(expect.objectContaining({ tool_name: 'mail.read',
      result: expect.objectContaining({ source_url: sourceUrl, body: expect.stringContaining('23 October is WITHDRAWN') }) }));
    expect(JSON.stringify(carried)).not.toContain(f.control.response);
    expect(f.briefCalls()).toBe(0);
    expect(JSON.stringify(refined)).not.toContain(SENDER);
    expect(f.prompts.at(-1)!.system).not.toContain(MAIL_WORK_INVESTIGATION_GUIDANCE);
    expect(f.prompts.at(-1)!.system).toContain(MAIL_WORK_REFINEMENT_GUIDANCE);
  } finally { f.close(); }
});

it('retains owner constraints and exact mail after the recent tail ages out and the orchestrator restarts', async () => {
  let f = fixture();
  try {
    const owner = 'Phone: first option withdrawn. Do not contact anyone without my approval.';
    f.add('arrival', '23 October is WITHDRAWN. Explore a documentation-only handover.', NOW + 1);
    await f.send(owner);
    for (let i = 0; i < 4; i++) await f.send(`Refine privately, round ${i}.`, false);
    expect(f.packets.at(-1)!.chat_tail.some((x: any) => x.content === owner)).toBe(false);
    const db = f.db; f.close(false); f = fixture(db);
    await f.send('Make the first step shorter.', false);
    const packet = f.packets.at(-1)!;
    const evidence = (packet.prior_tool_calls ?? []).find((x: any) => x.tool_name === 'context.mail_work_evidence').result;
    expect(evidence.investigation_request).toBe(owner);
    expect(evidence.source_catalog).toContainEqual(expect.objectContaining({
      source_url: '#data/mail/record/work/seed', scope_role: 'work_anchor' }));
    expect(evidence.source_catalog).toContainEqual(expect.objectContaining({
      source_url: '#data/mail/record/work/arrival', scope_role: 'context_candidate' }));
    expect(evidence.owner_updates).toContain('Refine privately, round 0.');
    expect(observations(packet)).toContainEqual(expect.objectContaining({ tool_name: 'mail.read', result: expect.objectContaining({
      source_url: '#data/mail/record/work/arrival', received_at_iso: new Date(NOW + 1).toISOString(),
      body: expect.stringContaining('23 October is WITHDRAWN'),
    }) }));
    expect(JSON.stringify(packet)).not.toContain(SENDER);
    expect((await f.store.readMailWorkEvidence!('s'))!).toContain(SENDER);
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it('uses normal closing summarization when the exact source record would exceed its bound', async () => {
  const f = fixture();
  try {
    f.add('arrival', 'Detailed source '.repeat(4000) + 'WITHDRAWN', NOW + 1);
    await f.send();
    expect(f.briefCalls()).toBeGreaterThanOrEqual(1);
    expect(await f.store.readMailWorkEvidence!('s')).toBeNull();
    expect(f.prompts.some(p => 'tool_results_since' in p.packet)).toBe(true);
    expect(await f.store.readSessionBrief('s')).not.toBeNull();
  } finally { f.close(); }
});

it('does not skip the closing fold for a tool outside exact source retention', async () => {
  const f = fixture();
  try {
    f.control.requestWrite = true;
    await f.send();
    expect(f.briefCalls()).toBeGreaterThanOrEqual(1);
    expect(f.dispatched.every(c => c.name !== 'memory.write')).toBe(true);
    expect(await f.store.readMailWorkEvidence!('s')).not.toBeNull();
  } finally { f.close(); }
});

it('does not retain or inject exact source carry when the owner disables running notes', async () => {
  const f = fixture();
  try {
    f.store.setRollingBriefEnabled(false);
    const saved = await f.send();
    expect(f.packets[0]!.prior_tool_calls.some((x: any) => x.tool_name === 'context.mail_work_evidence')).toBe(false);
    const catalog = f.packets[0]!.prior_tool_calls.find((x: any) => x.tool_name === 'context.mail_work_source_catalog').result;
    expect(catalog.source_catalog).toContainEqual(expect.objectContaining({
      source_url: '#data/mail/record/work/seed', scope_role: 'work_anchor' }));
    expect(catalog.passage_catalog.length).toBeGreaterThan(0);
    expect(saved.content).toContain('This is a proposal.');
    expect(saved.content).toContain('#data/mail/record/work/seed');
    expect(await f.store.readMailWorkEvidence!('s')).toBeNull();
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it('invalidates an older exact snapshot when an explicit refresh loses mail access', async () => {
  const f = fixture();
  try {
    await f.send();
    expect(await f.store.readMailWorkEvidence!('s')).not.toBeNull();
    f.control.allowed = false;
    expect((await f.send('Refresh current sources.')).content).toContain('could not finish rereading');
    expect(await f.store.readMailWorkEvidence!('s')).toBeNull();
    expect(f.packets).toHaveLength(1);
  } finally { f.close(); }
});

it('supplies cross-sender evidence before the first answer even when the model requests no discovery', async () => {
  const f = fixture();
  try {
    const coworker = 'engineer@private.example';
    f.add('seed', 'Please explore a Cobalt pilot.', NOW, 'client-thread', SENDER, 'Cobalt pilot request');
    f.add('internal', 'The Cobalt pilot date is WITHDRAWN. Explore documentation only.', NOW + 1,
      'different-thread', coworker, 'Capacity review');
    f.add('unrelated', 'A separate contract is agreed.', NOW + 2, 'elsewhere', SENDER, 'Quartz annual contract');
    const answer = await f.send();
    expect(f.packets).toHaveLength(1);
    expect(f.dispatched).toContainEqual({ name: 'mail.search', args: { query: 'Cobalt pilot', limit: 8 } });
    const reads = observations(f.packets[0]!).filter((c: any) => c.tool_name === 'mail.read');
    expect(reads.map((c: any) => c.args.record_id)).toEqual(['seed', 'internal']);
    const scope = f.packets[0]!.prior_tool_calls.find((c: any) => c.tool_name === 'context.mail_work_evidence').result.source_catalog;
    expect(scope).toContainEqual(expect.objectContaining({ source_url: '#data/mail/record/work/seed', scope_role: 'work_anchor' }));
    expect(scope).toContainEqual(expect.objectContaining({ source_url: '#data/mail/record/work/internal', scope_role: 'context_candidate' }));
    expect(JSON.stringify(f.packets[0])).not.toContain(coworker);
    expect(answer.content).toContain(coworker);
    expect(answer.provenance).toContainEqual(expect.objectContaining({ record_id: 'internal' }));
    expect(JSON.parse((await f.store.readMailWorkEvidence!('s'))!).observations.some((c: any) => c.args.record_id === 'internal')).toBe(true);
    expect(f.briefCalls()).toBe(0);
    const dispatches = f.dispatched.length;
    await f.send('Make that plan shorter.', false);
    expect(f.dispatched).toHaveLength(dispatches);
  } finally { f.close(); }
});

it('supplies cross-sender search bodies through privacy and does not duplicate them on a model-requested search', async () => {
  const f = fixture();
  try {
    const coworker = 'engineer@private.example';
    f.add('internal', 'Cobalt option WITHDRAWN. Explore documentation only.', NOW + 1, 'other-thread', coworker);
    f.control.searchQuery = 'Cobalt';
    const answer = await f.send();
    expect(f.packets).toHaveLength(2);
    const call = observations(f.packets[1]!).find((c: any) => c.tool_name === 'mail.read' && c.result.record_id === 'internal');
    expect(call.result.body).toContain('WITHDRAWN');
    expect(call.result.source_url).toBe('#data/mail/record/work/internal');
    expect(JSON.stringify(f.packets)).not.toContain(coworker);
    expect(answer.content).toContain(coworker);
    expect(f.dispatched.filter(c => c.name === 'mail.read')).toEqual([
      { name: 'mail.read', args: { slug: 'work', record_id: 'seed', offset: 0 } },
      { name: 'mail.read', args: { slug: 'work', record_id: 'internal' } },
    ]);
    expect(answer.provenance).toContainEqual(expect.objectContaining({ collection_slug: 'work', record_id: 'internal' }));
    expect((await f.store.listMessages('s')).some(m => m.role === 'tool' && m.content.includes('documentation only'))).toBe(true);
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it('does not automatically read matches on an ordinary Chat turn', async () => {
  const f = fixture();
  try {
    f.control.searchQuery = 'Cobalt';
    await f.send('Find Cobalt messages.', false);
    expect(f.packets).toHaveLength(2);
    expect(f.dispatched.map(c => c.name)).toEqual(['mail.search']);
  } finally { f.close(); }
});

it('keeps partial discovery pages explicit and requires the model to choose continuation', async () => {
  const f = fixture();
  try {
    f.add('long', 'Cobalt detail. '.repeat(3000) + 'WITHDRAWN', NOW + 1, 'other-thread');
    f.control.searchQuery = 'Cobalt';
    await f.send();
    const call = observations(f.packets[1]!).find((c: any) => c.tool_name === 'mail.read' && c.result.record_id === 'long');
    expect(call.result).toMatchObject({ body_incomplete: true, next_offset: 24000, read_version: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(call.result.body).not.toContain('WITHDRAWN');
    expect(f.dispatched.filter(c => c.name === 'mail.read')).toHaveLength(2);
  } finally { f.close(); }
});

it('honours a read grant revoked after discovery without supplying the body', async () => {
  const f = fixture();
  try {
    f.add('internal', 'Cobalt restricted body.', NOW + 1, 'other-thread');
    f.control.searchQuery = 'Cobalt';
    f.control.afterSearch = args => { if ((args as { query?: string }).query) f.control.allowed = false; };
    await f.send();
    const reads = observations(f.packets[1]!).filter((c: any) => c.tool_name === 'mail.read' && c.args.record_id === 'internal');
    expect(reads).toHaveLength(1);
    expect(reads[0].result.body).toBeUndefined();
    expect(observations(f.packets[1]!).some((c: any) => c.result?.body === 'Cobalt restricted body.')).toBe(false);
  } finally { f.close(); }
});

it('cancels during initial discovery before a model call or final answer', async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  try {
    f.add('internal', 'Cobalt evidence.', NOW + 1, 'other-thread');
    f.control.searchQuery = 'Cobalt';
    f.control.afterSearch = args => { if ((args as { query?: string }).query) f.control.beforeRead = () => blocked; };
    const ack = await handleSend(f.deps, { session_id: 's', message: 'Investigate Cobalt.', picker_state: { current: 'self' }, mail_work: request });
    await vi.waitFor(() => expect(f.dispatched).toContainEqual({ name: 'mail.read', args: { slug: 'work', record_id: 'internal' } }));
    await f.orchestrator.turnQueue!.cancel('s', ack.turn_id);
    release();
    await vi.waitFor(() => expect(f.events.filter(e => e.kind === 'chat.tool_call_completed' && e.tool_name === 'mail.read')).toHaveLength(2));
    // The cancelled worker still owns the in-flight read until it settles.
    await new Promise(resolve => setImmediate(resolve));
    expect(f.packets).toHaveLength(0);
    expect((await f.store.listMessages('s')).some(m => m.role === 'assistant')).toBe(false);
    expect(f.briefCalls()).toBe(0);
  } finally { release(); f.close(); }
});

it('rereads newly arrived mail in the same queued Chat even when the model asks for no tools', async () => {
  const f = fixture();
  try {
    expect((await f.send()).content).toContain('Older option is pending.');
    f.add('arrival', 'Internal review is complete. 23 October is WITHDRAWN. Explore documentation only.', NOW + 1);
    const answer = await f.send();
    expect(answer.content).toContain(`${SENDER}: WITHDRAWN`);
    expect(f.packets).toHaveLength(2);
    expect(observations(f.packets[1]!).some((call: any) => call.tool_name === 'mail.read' && call.result.record_id === 'arrival')).toBe(true);
    expect(answer.tool_calls?.map(call => call.tool_name)).toContain('mail.read');
    expect(answer.provenance).toContainEqual(expect.objectContaining({ collection_slug: 'work', record_id: 'arrival' }));
    expect(f.briefCalls()).toBe(0);
    expect(f.events.filter(event => event.kind === 'chat.tool_call_started')).not.toHaveLength(0);
    expect((await f.store.listMessages('s')).some(message => message.role === 'tool' && message.content.includes('WITHDRAWN'))).toBe(true);
  } finally { f.close(); }
});

it('reads continuation pages with the exact version before the first model packet', async () => {
  const f = fixture();
  try {
    f.add('arrival', 'Earlier detail. '.repeat(2000) + 'WITHDRAWN; documentation only.', NOW + 1);
    expect((await f.send()).content).toContain('WITHDRAWN');
    expect(f.dispatched).toContainEqual({ name: 'mail.read', args: expect.objectContaining({ record_id: 'arrival', offset: 24000, read_version: expect.stringMatching(/^[0-9a-f]{64}$/) }) });
    expect(f.packets).toHaveLength(1);
  } finally { f.close(); }
});

it.each(['revoked', 'changed', 'too-large'] as const)('refuses stale synthesis when fresh reading is %s', async kind => {
  const f = fixture();
  try {
    if (kind === 'revoked') f.control.beforeRead = async () => { f.control.allowed = false; };
    if (kind === 'changed') f.control.beforeRead = async () => { f.add('seed', 'Changed during the read'); };
    if (kind === 'too-large') for (let i = 0; i < 3; i++) f.add(`large-${i}`, 'x'.repeat(60_000), NOW + i + 1);
    const answer = await f.send();
    expect(answer.content).toMatch(/could not finish rereading|exceeded this investigation/);
    expect(answer.content).not.toContain('Older option is pending');
    expect(f.packets).toHaveLength(0);
  } finally { f.close(); }
});

it('the queued mail_work request implies read-only even without the separate flag', async () => {
  const f = fixture();
  try {
    f.control.requestWrite = true;
    await f.send();
    expect(f.dispatched.every(call => call.name === 'mail.read' || call.name === 'mail.search')).toBe(true);
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'chat.tool_call_completed', tool_name: 'memory.write', reason: 'classification_blocked' }));
  } finally { f.close(); }
});

it('duplicate protection still suppresses the same investigation copied into ordinary Chat', async () => {
  const f = fixture();
  try {
    await f.send();
    const ack = await handleSend(f.deps, { session_id: 's', message: 'Investigate seed in work. Save this work only if permitted.', picker_state: { current: 'self' } });
    expect(ack.disposition).toBe('duplicate');
    expect(f.packets).toHaveLength(1);
  } finally { f.close(); }
});

it('a moved anchor cannot silently switch an investigation to another conversation', async () => {
  const f = fixture();
  try {
    f.add('arrival', 'WITHDRAWN', NOW + 1);
    const input = { session_id: 's', message: 'Read the saved work', picker_state: { current: 'self' as const },
      mail_work: { seeds: [{ slug: 'work', record_id: 'seed', thread_id: 'previous-thread' }] } };
    const ack = await handleSend(f.deps, input);
    await vi.waitFor(async () => expect((await f.orchestrator.turnQueue!.snapshot('s')).turns.find(turn => turn.turn_id === ack.turn_id)?.status).toBe('completed'));
    expect(f.packets).toHaveLength(0);
    expect((await f.store.listMessages('s')).find(message => message.role === 'assistant')?.content).toContain('could not finish rereading');
  } finally { f.close(); }
});

it('a message moved after search cannot become current evidence for the old conversation', async () => {
  const f = fixture();
  try {
    f.add('arrival', 'WITHDRAWN', NOW + 1);
    f.control.afterSearch = () => f.add('arrival', 'WITHDRAWN', NOW + 1, 'other-project');
    expect((await f.send()).content).toContain('could not finish rereading');
    expect(f.packets).toHaveLength(0);
  } finally { f.close(); }
});

it('discloses a capped conversation window in both the preview and durable answer', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 41; i++) f.add(`reply-${i}`, 'WITHDRAWN', NOW + i + 1);
    const answer = await f.send();
    expect(answer.content).toMatch(/^I reread a bounded window of linked mail\./);
    expect(f.events.some(event => event.kind === 'chat.token_streamed' && event.delta === answer.content)).toBe(true);
  } finally { f.close(); }
});

it('the browser mail fixture supplies actual current mail through the same queue path', async () => {
  const { createMailWorkFixture } = await import('../../../../apps/webclient/e2e/harness/mail-work-backend.js');
  const f = createMailWorkFixture({ holdClosingBrief: true, answer: 'Current sources were read.' });
  try {
    const detail = await f.service.create({ request_id: 'fresh-browser-fixture', email: { slug: 'work', record_id: 'seed' } });
    await f.rpc('chat.session.create', { creation_id: detail.chat_session_id });
    f.addMail('arrival', 'client', 'The old option is WITHDRAWN.');
    const ack = await f.rpc('chat.send', { session_id: detail.chat_session_id, message: 'Read current work',
      picker_state: { current: 'self' }, mail_work: request }) as { turn_id: string };
    f.releaseChat();
    await vi.waitFor(async () => {
      const history = await f.rpc('chat.session.get', { session_id: detail.chat_session_id }) as { messages: Array<{ role: string; content: string; tool_calls?: unknown[] }> };
      expect(history.messages.some(message => message.role === 'tool' && message.content.includes('WITHDRAWN'))).toBe(true);
      expect(history.messages.find(message => message.role === 'assistant')?.content).toContain('Current sources were read.');
    });
    expect(ack.turn_id).toBeTruthy();
  } finally { f.releaseChat(); f.close(); }
});

it('cancellation during a read makes no model call; retry retains the fresh-read requirement', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    f.control.beforeRead = () => gate;
    const ack = await handleSend(f.deps, { session_id: 's', message: 'Investigate now', picker_state: { current: 'self' }, mail_work: request });
    await vi.waitFor(() => expect(f.dispatched).toHaveLength(1));
    await f.orchestrator.turnQueue!.cancel('s', ack.turn_id);
    release();
    await vi.waitFor(async () => expect((await f.orchestrator.turnQueue!.snapshot('s')).turns[0]?.status).toBe('cancelled'));
    expect(f.packets).toHaveLength(0);
    f.control.beforeRead = undefined;
    f.add('arrival', 'WITHDRAWN; explore documentation only.', NOW + 1);
    const retry = await f.orchestrator.turnQueue!.retry('s', ack.turn_id, 'fresh-retry');
    await vi.waitFor(async () => expect((await f.orchestrator.turnQueue!.snapshot('s')).turns.find(turn => turn.turn_id === retry.turn_id)?.status).toBe('completed'));
    expect(f.packets).toHaveLength(1);
    expect(observations(f.packets[0]!).some((call: any) => call.tool_name === 'mail.read' && call.result.record_id === 'arrival')).toBe(true);
  } finally { release(); f.close(); }
});

it.each([null, {}, { seeds: [] }, { seeds: Array(9).fill(request.seeds[0]) }, { seeds: [{ slug: '', record_id: 'seed' }] }])(
  'rejects malformed or unbounded automatic read requests %j', value => {
    expect(() => parseMailWorkReadRequest(value)).toThrow(/one to eight/);
  },
);

it('preserves host field names through the warehouse privacy scan while protecting nested data keys', async () => {
  const f = fixture(new Database(':memory:'), ['owner']);
  try {
    f.add('seed', 'The person owner requested a private outline.');
    const source = f.table.get('seed')!;
    f.table.upsert({ ...source, hot_fields: { ...source.hot_fields, owner_private_key: 'owner' } });
    await f.send('Investigate the selected mail.');
    await f.send('Make the plan shorter.', false);
    for (const packet of f.packets) {
      const evidence = (packet.prior_tool_calls ?? []).find((c: any) => c.tool_name === 'context.mail_work_evidence').result;
      expect(evidence).toHaveProperty('owner_updates');
      expect(evidence).toHaveProperty('owner_updates_before_request', 0);
      expect(evidence.note).toContain('entries in owner_updates');
      expect(evidence.observations[0]).toHaveProperty('tool_name', 'mail.read');
      const read = evidence.observations.find((c: any) => c.tool_name === 'mail.read').result;
      expect(read.body).not.toContain('person owner');
      expect(read.body).toContain('pii.Person');
      expect(JSON.stringify(read)).not.toContain('owner_private_key');
    }
    expect(f.packets.at(-1)!.prior_tool_calls[0].result.owner_updates).toContain('Make the plan shorter.');
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it('keeps matched source links and locator provenance in a tool-free refinement and previews the saved text once', async () => {
  const f = fixture();
  try {
    f.add('seed', 'A private outline is requested. Contact customer@private.example only after approval.');
    await f.send();
    const before = f.dispatched.length;
    const saved = await f.send('Make the first private step shorter.', false);
    expect(f.dispatched).toHaveLength(before);
    expect(saved.content).toContain('[Email](#data/mail/record/work/seed)');
    expect(saved.content).toContain('customer@private.example only after approval.');
    expect(saved.provenance).toContainEqual(expect.objectContaining({ collection_platform: 'mail', collection_slug: 'work', record_id: 'seed' }));
    const previews = f.events.filter((e: any) => e.kind === 'chat.token_streamed' && e.turn_id === saved.turn_id) as any[];
    expect(previews.map(e => e.delta).join('')).toBe(saved.content);
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it('binds an observed record id in both investigation and ordinary refinement without a second model pass', async () => {
  const f = fixture();
  try {
    f.control.recap = [{ source: 'seed', quote: 'Please consider 23 October. Internal review is pending.', state: 'current' }];
    const initial = await f.send();
    const before = f.dispatched.length;
    const refined = await f.send('Keep the first private step and shorten it.', false);
    expect(f.dispatched).toHaveLength(before);
    expect(f.packets).toHaveLength(2);
    for (const saved of [initial, refined]) {
      expect(saved.content).toContain('[Email](#data/mail/record/work/seed)');
      expect(saved.content).toContain('Please consider 23 October. Internal review is pending.');
      expect(saved.content).not.toContain('could not be matched');
      expect(saved.content).not.toContain('did not supply a source recap');
      const previews = f.events.filter((e: any) => e.kind === 'chat.token_streamed' && e.turn_id === saved.turn_id) as any[];
      expect(previews.map(e => e.delta).join('')).toBe(saved.content);
      expect(saved.provenance).toContainEqual(expect.objectContaining({ collection_platform: 'mail', collection_slug: 'work', record_id: 'seed' }));
    }
    expect(f.events.filter((e: any) => e.kind === 'chat.transparency' && e.event.kind === 'recued.mail_work.recap'))
      .toHaveLength(2);
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it.each([false, true])('rejects an invalid plan visibly without a second pass or partial acceptance: %s', async partial => {
  const f = fixture();
  try {
    f.control.recap = [{ source: '#data/mail/record/work/seed', quote: 'Both dates were withdrawn by email.', state: 'current' }];
    if (partial) (f.control.recap as unknown[]).push({ source: '#data/mail/record/work/seed',
      quote: 'Please consider 23 October. Internal review is pending.', state: 'current' });
    f.control.response = '1. Draft a private outline for your review.';
    const saved = await f.send();
    expect(saved.content).toContain('could not assemble a plan');
    expect(saved.content).not.toContain('Selected source excerpts');
    expect(saved.content).toContain('[Email 1](#data/mail/record/work/seed)');
    expect(saved.content).not.toContain('Draft a private outline');
    expect(saved.content).not.toContain('Both dates');
    expect(f.packets).toHaveLength(1);
    expect(f.briefCalls()).toBe(0);
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'chat.transparency', event: expect.objectContaining({
      kind: 'recued.mail_work.recap', outcome: 'invalid', excerpts: 0,
    }) }));
  } finally { f.close(); }
});

it('renders structured refinements through privacy and permits a later ordinary Chat response', async () => {
  const f = fixture();
  try {
    await f.send();
    f.control.nativeRefinement = true;
    f.control.operation = 'prepare';
    f.control.target = 'the internal outline first.';
    const refined = await f.send('Prioritize the internal outline.', false);
    expect(refined.content).toContain('Private preparation: Prepare the internal outline first.');
    expect(refined.content).toContain('[Email](#data/mail/record/work/seed)');
    f.control.nativeRefinement = false;
    f.control.response = 'We can create that commitment through the normal approval controls.';
    const ordinary = await f.send('Turn this into a commitment.', false);
    expect(ordinary.content).toContain(f.control.response);
    expect(f.packets).toHaveLength(3);
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it('keeps the full plan through restart and failed edits, with the edit target in the privacy boundary only', async () => {
  let f = fixture();
  try {
    f.control.twoStepPlan = true;
    f.control.target = `the response for ${SENDER}`;
    await f.send();
    const before = JSON.parse((await f.store.readMailWorkEvidence!('s'))!).proposal_edit_target;
    expect(before.actions).toHaveLength(2);
    const db = f.db; f.close(false); f = fixture(db);
    f.control.nativeRefinement = true;
    f.control.invalidEdit = true;
    const rejected = await f.send('Shorten the first step.', false);
    expect(rejected.content).toContain('could not assemble a plan');
    expect(JSON.parse((await f.store.readMailWorkEvidence!('s'))!).proposal_edit_target).toEqual(before);
    const editTarget = f.packets.at(-1)!.mail_work_edit_target;
    expect(editTarget.actions[0].target).not.toContain(SENDER);
    expect(editTarget.actions[0].target).toMatch(/m\d+@d\d+\.invalid/);
    const evidence = f.packets.at(-1)!.prior_tool_calls.find((c: any) => c.tool_name === 'context.mail_work_evidence').result;
    expect(JSON.stringify(evidence)).not.toContain('the response for');
    expect(evidence.proposal_edit_target).toBeUndefined();
    f.control.invalidEdit = false;
    f.control.target = 'a brief response';
    const refined = await f.send('Keep the other steps and shorten the first.', false);
    expect(refined.content).toContain('1. Private preparation: Draft a brief response');
    expect(refined.content).toContain('2. Private preparation: Outline the internal outline');
    expect(refined.content).toContain('What cost information');
    expect(refined.content).toContain('What timing');
    expect(f.packets).toHaveLength(2);
    expect(f.briefCalls()).toBe(0);
    f.control.nativeRefinement = false;
    await f.send('Discuss something else.', false);
    expect(JSON.parse((await f.store.readMailWorkEvidence!('s'))!).proposal_edit_target).toBeUndefined();
    await f.send('Read the work again.');
    expect(f.packets.at(-1)!.mail_work_edit_target).toBeUndefined();
  } finally { f.close(); }
});

it('retains source carry and full-plan refinement when a proposal cannot be cached safely', async () => {
  const f = fixture();
  try {
    f.control.target = 'the pii.csv export';
    const initial = await f.send();
    expect(initial.content).toContain('Private preparation: Draft the pii.csv export');
    const stored = JSON.parse((await f.store.readMailWorkEvidence!('s'))!);
    expect(stored.proposal_edit_target).toBeUndefined();
    expect(stored.observations.some((call: any) => call.tool_name === 'mail.read')).toBe(true);
    f.control.nativeRefinement = true;
    f.control.target = 'a shorter export outline';
    const refined = await f.send('Make it shorter.', false);
    expect(refined.content).toContain('Private preparation: Draft a shorter export outline');
    expect(f.packets.at(-1)!.mail_work_edit_target).toBeUndefined();
    expect(f.packets.at(-1)!.prior_tool_calls.some((call: any) => call.tool_name === 'context.mail_work_evidence')).toBe(true);
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it('a missing structured plan is a visible failure, never a repaired plan or extra model pass', async () => {
  const f = fixture();
  try {
    f.control.omitPlan = true;
    f.control.response = 'Unsupported text must not become the plan.';
    const saved = await f.send();
    expect(saved.content).toContain('could not assemble a plan');
    expect(saved.content).not.toContain(f.control.response);
    expect(saved.content).not.toContain(MAIL_WORK_PLANNING_CHOICE);
    expect(f.packets).toHaveLength(1);
    expect(f.briefCalls()).toBe(0);
  } finally { f.close(); }
});

it('can read and quote the attachment in a prepared Chat through ordinary document privacy and carry', async () => {
  const f = fixture();
  try {
    f.control.documentRead = true;
    f.control.response = 'Draft the glossary privately.';
    const answer = await f.send('Investigate the attached requirements.');
    expect(f.packets).toHaveLength(2);
    expect(f.dispatched.some(call => call.name === 'document.read')).toBe(true);
    expect(JSON.stringify(f.packets)).not.toContain(SENDER);
    expect(answer.content).toContain(`Prepare a glossary for ${SENDER}.`);
    expect(answer.content).toContain('#data/files/record/received/file%3A' + 'a'.repeat(32));
    expect(answer.content).toContain('b'.repeat(64));
    expect(answer.content).toContain('Draft the glossary privately.');
    expect(await f.store.readMailWorkEvidence!('s')).not.toContain('glossary');
    expect(f.briefCalls()).toBeGreaterThan(0);
  } finally { f.close(); }
});
