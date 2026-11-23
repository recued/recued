import type { QuoteSignoffSummary, QuoteCompletionSummary, QuoteSignoffReceipt } from '@recued/contracts';

/** Full-app transport fixture; install after installCustomerWorkFixture in the
 * same init script. Components, router, leave guards and server tracker are real. */
export const installSignoffWorkspaceFixture = () => {
  type Reply = { result?: unknown; error?: { code: string; message: string } };
  const view = window as Window & {
    __receptionFixture?: (method: string, args: unknown) => Promise<Reply | undefined>;
    __signoffWorkspace?: { calls: Array<{ method: string; args: Record<string, unknown> }>; hold?: string; release?: () => void; fail?: string };
    __app?: { fireMessage(message: unknown): void };
  };
  const original = view.__receptionFixture!;
  const fixture = view.__signoffWorkspace = { calls: [] } as NonNullable<typeof view.__signoffWorkspace>;
  const params = new URLSearchParams(location.search);
  const now = Date.now(); const hash = 'b'.repeat(64);
  let offers: QuoteSignoffSummary[];
  let completions: QuoteCompletionSummary[] = [];
  const seed = async () => {
    if (offers) return;
    const initial = (await original('reception.signoff.list', {}))!.result as { signoffs: QuoteSignoffSummary[] };
    offers = initial.signoffs.filter(entry => entry.signoff_id !== 'offer-100').slice(0, 6).map((entry, i) => ({ ...entry, created_at: now, expires_at: now + 7 * 86400000,
      state: params.get('signoff_state') as QuoteSignoffSummary['state'] || (['waiting','accepted','released','draft','cancelled','superseded'] as const)[i % 6]!,
      ...(i === 2 ? {} : { task_id: null, invoice_id: null, released_at: null, can_request_completion: false }),
    }));
    if (params.has('completion_rows')) completions = [{ completion_id: 'completion-review',signoff_id: 'offer-3',root_signoff_id: 'offer-3',business_name: 'Studio',customer: 'Morgan Studio',quote_label: 'Drawings 3',agreed_scope: 'Three drawings.',delivery_summary: 'Delivered three drawings.',customer_preview: 'Saved completion for Drawings 3.\nThree drawings delivered.',state: 'corrections_requested',availability: 'current',created_at: now,expires_at: now + 7 * 86400000,endpoint_id: 'completion-endpoint',response: { decision: 'corrections_requested',received_at: now,recorded_at: now,corrections: 'Please revise the entrance drawing.\nKeep the remaining drawings.' },owner_action: null,review: 'waiting' }];
  };
  const preview = (offer: QuoteSignoffSummary) => ({ signoff: structuredClone(offer),display_name: 'Studio',expiry_days: 7,preview_hash: hash,preview_server_now: now,preview_expires_at: now + 600000,
    customer_preview: `Quote ${offer.quote_reference} — ${offer.customer}\n${offer.amount} ${offer.currency} total\n\n${offer.scope}` });
  view.__receptionFixture = async (method, raw) => {
    if (!method.startsWith('reception.signoff.')) return original(method, raw);
    const args = (raw ?? {}) as Record<string, any>;
    fixture.calls.push({ method,args: structuredClone(args) });
    await seed();
    if (fixture.hold === method) { fixture.hold = undefined; await new Promise<void>(resolve => { fixture.release = resolve; }); }
    if (fixture.fail === method || params.get('signoff_fail') === method) return { error: { code: 'UNAVAILABLE',message: 'Sign-off service unavailable. Try again.' } };
    let result: unknown;
    if (method === 'reception.signoff.quotes') result = { quotes: [{ id: 'QNEW',label: 'New studio drawings',customer: 'Morgan Studio',amount: '120.0000',currency: 'GBP',revision: 1 }],truncated: false };
    else if (method === 'reception.signoff.list') result = { signoffs: structuredClone(offers.filter(o => (!args.signoff_id || o.signoff_id === args.signoff_id) && (!args.state || o.state === args.state) && (!args.search || `${o.customer} ${o.quote_label} ${o.invoice_ref}`.toLowerCase().includes(args.search.toLowerCase())))),truncated: false,server_now: now };
    else if (method === 'reception.signoff.prepare' || method === 'reception.signoff.prepare_addition') {
      const parent = offers.find(o => o.signoff_id === args.parent_signoff_id);
      const saved: QuoteSignoffSummary = { ...offers[2]!,signoff_id: 'workspace-offer',quote_id: 'QNEW',quote_label: 'New studio drawings',quote_reference: 'Q-NEW',quote_revision: 1,
        state: 'draft',scope: args.scope,task_title: args.task_title ?? parent!.task_title,invoice_ref: args.invoice_ref,amount: args.amount ?? '120.0000',
        vat_amount: args.vat_amount ?? '0.0000',net: args.amount ?? '120.0000',task_id: null,invoice_id: null,endpoint_id: null,released_at: null,responded_at: null,
        ...(parent ? { addition: { root_signoff_id: parent.signoff_id,parent_signoff_id: parent.signoff_id,revision: 1,base_scope: parent.scope,base_amount: parent.amount,total_amount: '150.0000' } } : {}) };
      offers.push(saved); result = preview(saved);
    } else if (method === 'reception.signoff.resume') result = preview(offers.find(o => o.signoff_id === args.signoff_id)!);
    else if (method === 'reception.signoff.publish' || method === 'reception.signoff.cancel') {
      const saved = offers.find(o => o.signoff_id === args.signoff_id)!; saved.state = method.endsWith('.cancel') ? 'cancelled' : 'waiting'; saved.endpoint_id = 'workspace-signoff-endpoint';
      result = method.endsWith('.cancel') ? structuredClone(saved) : { signoff: structuredClone(saved),share_url: 'https://studio.example.test/r/signoff/workspace-token' };
    } else if (method === 'reception.signoff.link.check') result = { current: true };
    else if (method === 'reception.signoff.completion.list') result = { completions: structuredClone(completions.filter(c => !args.review_only || c.review === 'waiting')),server_now: now };
    else if (method === 'reception.signoff.completion.prepare') {
      const agreement = offers.find(o => o.signoff_id === args.signoff_id)!;
      const completion: QuoteCompletionSummary = { completion_id: 'workspace-completion',signoff_id: agreement.signoff_id,root_signoff_id: agreement.signoff_id,business_name: 'Studio',customer: agreement.customer,quote_label: agreement.quote_label,agreed_scope: agreement.scope,delivery_summary: args.delivery_summary,customer_preview: `Saved completion for ${agreement.quote_label}\n\n${args.delivery_summary}`,state: 'draft',availability: 'current',created_at: now,expires_at: now + 7 * 86400000,endpoint_id: null,response: { decision: 'not_recorded',received_at: null,recorded_at: null },owner_action: null };
      completions.push(completion); result = { completion: structuredClone(completion),preview_hash: hash,preview_server_now: now,preview_expires_at: now + 600000,customer_preview: completion.customer_preview };
    } else if (method === 'reception.signoff.completion.resume') {
      const completion = completions.find(c => c.completion_id === args.completion_id)!;result = { completion: structuredClone(completion),expiry_days: 7,preview_hash: hash,preview_server_now: now,preview_expires_at: now + 600000,customer_preview: completion.customer_preview };
    } else if (method === 'reception.signoff.completion.publish' || method === 'reception.signoff.completion.cancel') {
      const completion = completions.find(c => c.completion_id === args.completion_id)!;completion.state = method.endsWith('.cancel') ? 'cancelled' : 'waiting';completion.endpoint_id = 'workspace-completion-endpoint';
      result = method.endsWith('.cancel') ? structuredClone(completion) : { completion: structuredClone(completion),share_url: 'https://studio.example.test/r/completion/workspace-token' };
    } else if (method === 'reception.signoff.receipt') {
      const saved = offers.find(o => o.signoff_id === args.signoff_id)!;
      result = { format: 'recued.customer-signoff-receipt',version: 1,captured_at: now,selected_signoff_id: saved.signoff_id,root_signoff_id: saved.signoff_id,requests: [{ signoff_id: saved.signoff_id,parent_signoff_id: null,revision: 0,business_name: 'Studio',customer: saved.customer,quote_label: saved.quote_label,quote_reference: saved.quote_reference ?? '',quote_revision: saved.quote_revision,amount: saved.amount,net: saved.net,vat_amount: saved.vat_amount,currency: saved.currency,scope: saved.scope,customer_preview: preview(saved).customer_preview,offer_text_source: 'saved',state: saved.state,prepared_at: saved.created_at,expires_at: saved.expires_at,response: { decision: 'not_recorded',received_at: null,recorded_at: null },release: null }] } satisfies QuoteSignoffReceipt;
    } else if (method.endsWith('.reminders.get') || method.endsWith('.reminders.set')) result = { signoff_id: args.signoff_id,completion_id: args.completion_id,revision: method.endsWith('.set') ? args.expected_revision + 1 : 0,due_at: args.due_at ?? null,...(args.recipient_email ? {recipient_email: args.recipient_email} : {}),has_saved_link: false,notified_at: null,drafted_at: null,delivery: 'not_prepared',status: args.due_at ? 'scheduled' : 'unscheduled' };
    else if (method.endsWith('.reminders.list')) result = { reminders: [] };
    else return original(method, raw);
    return { result };
  };
  setInterval(() => view.__app?.fireMessage({ type: 'server_heartbeat',payload: { server_id: 'fixture-server',last_seen_at: Date.now(),lifecycle_state: 'running',uptime_s: 120,supervisor_mode: 'systemd' } }), 1000);
};
