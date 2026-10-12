import type { Conn, ServerRpcRegistry, QuoteSignoffPrepareResult, QuoteSignoffSummary } from '@recued/contracts';
import { canRecordSignoffPayment, createQuoteSignoffPayment,
  type QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';

export type QuoteSignoffConn = Conn<Pick<ServerRpcRegistry,
  'reception.signoff.quotes' | 'reception.signoff.prepare' | 'reception.signoff.publish'
  | 'reception.signoff.prepare_addition' | 'reception.signoff.list' | 'reception.signoff.cancel'>>;

/** Customer acceptance and owner release are distinct decisions. All terms
 * and destinations come from the prepared server snapshot, never the DOM. */
export const mountQuoteSignoffPanel = (opts: {
  host: HTMLElement; conn: QuoteSignoffConn; document: Document;
  payment?: QuoteSignoffPaymentOptions;
}) => {
  const { document: doc, conn } = opts;
  const root = doc.createElement('section'); root.setAttribute('data-recued-quote-signoffs', '');
  opts.host.appendChild(root);
  const style = doc.createElement('style'); style.textContent = `
    [data-recued-quote-signoffs] { display:grid; gap:18px; max-width:850px; }
    [data-recued-quote-signoffs] h2, [data-recued-quote-signoffs] h3, [data-recued-quote-signoffs] p { margin:0; }
    [data-recued-quote-signoffs] form { display:grid; gap:12px; }
    [data-recued-quote-signoffs] label { display:grid; gap:5px; font-size:14px; }
    [data-recued-quote-signoffs] input, [data-recued-quote-signoffs] select,
    [data-recued-quote-signoffs] textarea { width:100%; padding:10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--fg); font:inherit; }
    [data-recued-quote-signoffs] textarea { min-height:130px; resize:vertical; }
    [data-recued-quote-signoffs] button { padding:9px 14px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--fg); cursor:pointer; width:fit-content; }
    [data-recued-quote-signoffs] button:disabled { opacity:.6; cursor:default; }
    [data-recued-quote-signoffs] pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; line-height:1.5; padding:16px; background:var(--surface-sunk); border-radius:10px; }
    [data-recued-quote-signoffs] article { display:grid; gap:8px; padding:16px; border:1px solid var(--border); border-radius:10px; }
    [data-recued-quote-signoffs] .signoff-actions { display:flex; flex-wrap:wrap; gap:10px; }
    [data-recued-quote-signoffs] :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  `; root.appendChild(style);
  const add = (tag: string, text: string, host: HTMLElement = root) => {
    const node = doc.createElement(tag); node.textContent = text; host.appendChild(node); return node;
  };
  add('h2', 'Customer sign-offs');
  add('p', 'Offer an exact quote and scope to your customer. After they accept, review the task and invoice in Reception Inbox before releasing work.');
  add('p', 'Install Quote Pipeline and Invoice Book from Packs to get started. This creates a local invoice with the quoted total; sending it and collecting payment are separate steps.');
  const message = add('p', 'Loading quotes…'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const form = doc.createElement('form'); root.appendChild(form);
  const additionDescription = add('p', '', form); additionDescription.hidden = true;
  const newQuote = doc.createElement('button'); newQuote.type = 'button'; newQuote.textContent = 'Start a new quote sign-off';
  newQuote.hidden = true; form.appendChild(newQuote);
  const quoteLabel = add('label', 'Open quote', form);
  const quote = doc.createElement('select'); quote.setAttribute('name', 'quote_id'); quote.required = true; quoteLabel.appendChild(quote);
  const fields: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
  const fieldHosts: Record<string, HTMLElement> = {};
  const field = (name: string, label: string, type = 'text', required = true, max?: number) => {
    const wrap = add('label', label, form);
    fieldHosts[name] = wrap;
    const control = type === 'textarea' ? doc.createElement('textarea') : doc.createElement('input');
    if (type !== 'textarea') (control as HTMLInputElement).type = type;
    control.setAttribute('name', name); control.required = required;
    if (max) control.maxLength = max;
    wrap.appendChild(control); fields[name] = control; return control;
  };
  field('display_name', 'Business name shown to the customer', 'text', true, 100);
  field('scope', 'Complete scope shown to the customer', 'textarea', true, 6000);
  add('p', 'Include deliverables, exclusions and any terms the customer must accept. Private quote notes are kept private.', form);
  field('task_title', 'Task to create after your approval', 'text', true, 200);
  field('amount', 'Added amount including VAT', 'text', false, 24);
  fieldHosts.amount!.hidden = true;
  field('invoice_ref', 'Invoice reference', 'text', true, 100);
  field('vat_amount', 'VAT included in the quoted total (blank means zero)', 'text', false, 24);
  field('issued_on', 'Invoice date (blank uses today)', 'date', false);
  field('due_on', 'Invoice due date (blank uses 30 days after issue)', 'date', false);
  const expiry = field('expiry_days', 'Link lifetime in days', 'number') as HTMLInputElement;
  expiry.min = '1'; expiry.max = '30'; expiry.step = '1'; expiry.value = '7';
  const prepare = doc.createElement('button'); prepare.type = 'submit'; prepare.textContent = 'Preview customer sign-off'; form.appendChild(prepare);
  const previewHost = doc.createElement('div'); previewHost.setAttribute('data-signoff-preview', ''); root.appendChild(previewHost);
  const shareHost = doc.createElement('div'); shareHost.setAttribute('data-signoff-share', ''); root.appendChild(shareHost);
  const historyHead = doc.createElement('div'); historyHead.className = 'signoff-actions'; root.appendChild(historyHead);
  add('h3', 'Requests and responses', historyHead);
  const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh'; historyHead.appendChild(refresh);
  const history = doc.createElement('div'); history.setAttribute('data-signoff-history', ''); root.appendChild(history);

  let disposed = false; let busy = false; let generation = 0;
  let prepared: QuoteSignoffPrepareResult | null = null;
  let additionBase: QuoteSignoffSummary | null = null;
  let publish: HTMLButtonElement | undefined;
  let historyButtons: HTMLButtonElement[] = [];
  const setBusy = (value: boolean) => {
    busy = value; quote.disabled = value; prepare.disabled = value; refresh.disabled = value; newQuote.disabled = value;
    Object.values(fields).forEach((control) => { control.disabled = value; });
    if (publish) publish.disabled = value;
    historyButtons.forEach((button) => { button.disabled = value; });
  };
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed. Try again.';
  const invalidate = () => { prepared = null; publish = undefined; previewHost.replaceChildren(); };
  const selectAgreement = (base: QuoteSignoffSummary | null) => {
    additionBase = base; invalidate(); shareHost.replaceChildren();
    quoteLabel.hidden = base !== null; quote.required = base === null;
    fieldHosts.task_title!.hidden = base !== null; fields.task_title!.required = base === null;
    fieldHosts.amount!.hidden = base === null; fields.amount!.required = base !== null;
    newQuote.hidden = base === null; additionDescription.hidden = base === null;
    fieldHosts.scope!.firstChild!.textContent = base ? 'Added scope shown to the customer' : 'Complete scope shown to the customer';
    fieldHosts.vat_amount!.firstChild!.textContent = base ? 'VAT included in the added amount (blank means zero)' : 'VAT included in the quoted total (blank means zero)';
    prepare.textContent = base ? 'Preview added work' : 'Preview customer sign-off';
    if (base) {
      const amount = base.addition?.total_amount ?? base.amount;
      additionDescription.textContent = `Add work to ${base.quote_label} for ${base.customer}. Already agreed: ${amount} ${base.currency}. Your approval will append the added scope to the existing task and create a separate invoice for the added amount.`;
      for (const name of ['scope', 'amount', 'invoice_ref', 'vat_amount', 'issued_on', 'due_on']) fields[name]!.value = '';
      message.textContent = 'Describe the added work and charge. The customer will see the previous agreement and the new total.';
    } else message.textContent = 'Choose an open quote to prepare a request.';
  };
  const payment = opts.payment ? createQuoteSignoffPayment({ ...opts.payment, document: doc, host: root,
    readOffer: async id => (await conn('reception.signoff.list', { limit: 50 })).signoffs.find(offer => offer.signoff_id === id),
    onChanged: () => { if (!disposed) void load(); },
    onMessage: text => { if (!disposed) message.textContent = text; },
  }) : null;
  newQuote.addEventListener('click', () => { if (!busy && !disposed) selectAgreement(null); });
  form.addEventListener('input', invalidate); form.addEventListener('change', invalidate);
  const states: Record<QuoteSignoffSummary['state'], string> = {
    draft: 'Draft', publishing: 'Publishing', waiting: 'Waiting for customer', accepted: 'Customer accepted',
    rejected: 'Customer declined', cancelled: 'Cancelled', superseded: 'Replaced by a newer offer', released: 'Work and invoice released',
  };
  const load = async () => {
    const current = ++generation;
    try {
      const [offers, open] = await Promise.all([conn('reception.signoff.list', { limit: 50 }), conn('reception.signoff.quotes')]);
      if (disposed || current !== generation) return;
      const selected = quote.value; quote.replaceChildren();
      const placeholder = doc.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a quote'; quote.appendChild(placeholder);
      open.quotes.forEach((q) => { const option = doc.createElement('option'); option.value = q.id;
        option.textContent = `${q.label} — ${q.customer} — ${q.amount} ${q.currency} (revision ${q.revision})`; quote.appendChild(option); });
      quote.value = open.quotes.some((q) => q.id === selected) ? selected : '';
      history.replaceChildren(); historyButtons = [];
      const amended = new Set(offers.signoffs.filter((offer) => offer.state === 'released' && offer.addition)
        .map((offer) => offer.addition!.parent_signoff_id));
      for (const offer of offers.signoffs) {
        const card = doc.createElement('article'); card.setAttribute('data-signoff-id', offer.signoff_id); history.appendChild(card);
        add('h3', `${offer.quote_label} — ${offer.customer}`, card);
        add('p', `${states[offer.state]} · revision ${offer.quote_revision} · ${offer.amount} ${offer.currency}`, card);
        if (offer.addition) add('p', `Added work ${offer.addition.revision} · previously ${offer.addition.base_amount} · new agreed total ${offer.addition.total_amount} ${offer.currency}.`, card);
        if (offer.availability !== 'current') add('p', `This offer is ${offer.availability}. Prepare a new request before releasing work.`, card);
        add('p', `Task: ${offer.task_title}. Invoice ${offer.invoice_ref}, due ${offer.due_on}.`, card);
        const details = doc.createElement('details'); card.appendChild(details); add('summary', 'Offered scope', details);
        add('pre', offer.scope, details);
        if (offer.state === 'accepted' && offer.availability === 'current' && offer.release_review === 'waiting') {
          const inbox = add('a', 'Review release in Reception Inbox', card); inbox.setAttribute('href', '#reception/inbox');
        }
        if (offer.state === 'accepted' && offer.release_review === 'not_queued') add('p', 'The response is recorded. Its release is waiting to be queued for owner review.', card);
        if (offer.state === 'accepted' && offer.release_review === 'running') add('p', 'The reviewed release is running.', card);
        if (offer.state === 'accepted' && offer.release_review === 'closed') {
          add('p', 'Owner review closed without releasing work. Review the run, or cancel this request and prepare a new one.', card);
          const runs = add('a', 'Review in Runs', card); runs.setAttribute('href', '#runs');
        }
        if (offer.state === 'waiting' && offer.endpoint_id) {
          const manage = add('a', 'Manage share link', card); manage.setAttribute('href', `#reception/endpoints/${encodeURIComponent(offer.endpoint_id)}`);
        }
        if (offer.state === 'released') {
          const follow = offer.follow_up;
          if (!follow) add('p', 'Current work and payment status is unavailable. Refresh to try again.', card);
          else {
            if (follow.task.availability === 'current') {
              const task = follow.task;
              add('p', `Work ${task.done ? 'complete' : 'unfinished'}: ${task.title}.`
                + (task.state !== undefined ? ` State: ${task.state}.` : '')
                + (task.progress !== undefined ? ` Progress: ${task.progress}%.` : ''), card);
              if (offer.task_id) {
                const openTask = add('a', 'Open task', card);
                openTask.setAttribute('href', `#data/task/${encodeURIComponent(offer.task_id)}`);
              }
            } else add('p', follow.task.availability === 'missing' ? 'Linked task is missing.'
              : follow.task.availability === 'changed' ? 'Linked task has changed. Review it in Tasks.'
                : 'Task status is unavailable. Refresh to try again.', card);
            if (follow.invoice.availability === 'current') {
              const invoice = follow.invoice;
              add('p', `Invoice ${offer.invoice_ref}: ` + (invoice.status === 'settled' ? 'recorded paid in full.'
                : invoice.status === 'carried_forward' ? `balance carried to ${invoice.carried_to}. Follow that invoice in Records.`
                  : `${invoice.outstanding} ${offer.currency} outstanding${invoice.overdue ? ' · overdue' : ''}. Due ${invoice.due_on}.`), card);
              add('p', `Recorded paid: ${invoice.amount_paid} ${offer.currency}.`, card);
              if (payment && canRecordSignoffPayment(offer)) {
                const recordPayment = doc.createElement('button'); recordPayment.type = 'button';
                recordPayment.textContent = 'Record payment'; recordPayment.disabled = busy;
                card.appendChild(recordPayment); historyButtons.push(recordPayment);
                recordPayment.addEventListener('click', () => { if (!busy && !disposed) void payment.open(offer); });
              }
            } else add('p', `Invoice ${offer.invoice_ref}: ` + (follow.invoice.availability === 'missing' ? 'record is missing.'
              : follow.invoice.availability === 'changed' ? 'terms or balance changed. Review it in Records.'
                : 'status is unavailable. Refresh to try again.'), card);
          }
          const records = add('a', 'Browse Records', card); records.setAttribute('href', '#data/records');
          if (!amended.has(offer.signoff_id) && (!follow || follow.task.availability === 'current' && !follow.task.done)) {
            const extra = doc.createElement('button'); extra.type = 'button'; extra.textContent = 'Add work'; extra.disabled = busy;
            card.appendChild(extra); historyButtons.push(extra);
            extra.addEventListener('click', () => { if (!busy && !disposed) { selectAgreement(offer); fields.scope!.focus(); } });
          }
        }
        if (['draft', 'publishing', 'waiting', 'accepted'].includes(offer.state)) {
          const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel request'; cancel.disabled = busy;
          card.appendChild(cancel); historyButtons.push(cancel);
          cancel.addEventListener('click', async () => {
            if (busy || disposed) return; setBusy(true);
            try { await conn('reception.signoff.cancel', { signoff_id: offer.signoff_id });
              if (disposed) return;
              if (prepared?.signoff.signoff_id === offer.signoff_id) invalidate();
              message.textContent = 'Request cancelled. Its link is closed and any queued release will be refused.'; await load();
            } catch (error) { if (!disposed) message.textContent = errorMessage(error); }
            finally { if (!disposed) setBusy(false); }
          });
        }
      }
      if (!offers.signoffs.length) add('p', 'No customer sign-offs yet.', history);
      if (offers.truncated) add('p', 'Showing the latest 50 requests.', history);
      if (open.truncated) add('p', 'Showing up to 100 open quotes.', history);
      if (message.textContent === 'Loading quotes…') message.textContent = open.quotes.length ? 'Choose an open quote to prepare a request.' : 'Record an open quote in Quote Pipeline to prepare a sign-off.';
    } catch (error) { if (!disposed && current === generation) message.textContent = errorMessage(error); }
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || disposed) return;
    if (form.reportValidity && !form.reportValidity()) return;
    setBusy(true); invalidate(); shareHost.replaceChildren();
    try {
      const common = { display_name: fields.display_name!.value, scope: fields.scope!.value,
        invoice_ref: fields.invoice_ref!.value, expiry_days: Number(expiry.value),
        ...(fields.vat_amount!.value ? { vat_amount: fields.vat_amount!.value } : {}),
        ...(fields.issued_on!.value ? { issued_on: fields.issued_on!.value } : {}),
        ...(fields.due_on!.value ? { due_on: fields.due_on!.value } : {}),
      };
      const result = additionBase
        ? await conn('reception.signoff.prepare_addition', { ...common, parent_signoff_id: additionBase.signoff_id, amount: fields.amount!.value })
        : await conn('reception.signoff.prepare', { ...common, quote_id: quote.value, task_title: fields.task_title!.value });
      if (disposed) return; prepared = result;
      add('h3', 'What the customer will see', previewHost); add('pre', result.customer_preview, previewHost);
      add('p', `After acceptance and your approval: ${result.signoff.addition ? 'append the added scope to' : 'create'} “${result.signoff.task_title}” and ${result.signoff.addition ? 'create an additional' : 'create'} invoice ${result.signoff.invoice_ref}, dated ${result.signoff.issued_on}, due ${result.signoff.due_on}.`, previewHost);
      publish = doc.createElement('button'); publish.type = 'button'; publish.textContent = 'Publish sign-off link';
      publish.disabled = busy; previewHost.appendChild(publish);
      publish.addEventListener('click', async () => {
        if (busy || disposed || !prepared) return; const snapshot = prepared; setBusy(true);
        try {
          const created = await conn('reception.signoff.publish', { signoff_id: snapshot.signoff.signoff_id, preview_hash: snapshot.preview_hash });
          if (disposed) return; invalidate();
          add('p', 'Share this link with your customer. It accepts one response.', shareHost);
          const label = add('label', 'Customer sign-off link', shareHost);
          const link = doc.createElement('input'); link.type = 'url'; link.readOnly = true; link.value = created.share_url; label.appendChild(link);
          link.addEventListener('focus', () => link.select());
          message.textContent = 'Sign-off link published. Customer acceptance will queue a release for your approval.'; await load();
        } catch (error) { if (!disposed) { message.textContent = `${errorMessage(error)} Preview again if the preview has expired.`; invalidate(); } }
        finally { if (!disposed) setBusy(false); }
      });
      message.textContent = result.signoff.addition
        ? 'Review the added work and new total, then publish its link. This replaces any pending amendment for this agreement.'
        : 'Review the exact quote and scope, then publish its link. This replaces any earlier offer for this quote.'; await load();
    } catch (error) { if (!disposed) message.textContent = errorMessage(error); }
    finally { if (!disposed) setBusy(false); }
  });
  refresh.addEventListener('click', () => { if (!busy && !disposed) void load(); });
  const interval = setInterval(() => { if (!busy && !disposed) void load(); }, 20_000);
  void load();
  return { update: () => { if (!disposed) void load(); }, hasInFlightWork: () => busy || payment?.hasInFlightWork() === true,
    dispose: () => { disposed = true; generation++; clearInterval(interval); payment?.dispose(); root.remove(); } };
};
