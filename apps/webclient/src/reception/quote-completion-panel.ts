import { QUOTE_COMPLETION_SCOPE_MAX, type QuoteCompletionPrepareResult, type QuoteCompletionSummary,
  type QuoteSignoffSummary } from '@recued/contracts';
import type { QuoteSignoffConn } from './quote-signoff-panel.js';

const labels: Record<QuoteCompletionSummary['state'],string> = {
  draft: 'Draft', publishing: 'Publishing', waiting: 'Waiting for customer', accepted: 'Reply processed',
  corrections_requested: 'Reply processed', superseded: 'Replaced or changed', cancelled: 'Cancelled',
  closed: 'Owner closed work', reopened: 'Owner reopened work',
};
export const mountQuoteCompletionPanel = (opts: {
  document: Document; host: HTMLElement; conn: QuoteSignoffConn; onChanged: () => void;
  editorOnly?: boolean;
}) => {
  const { document: doc,conn } = opts;
  const root = doc.createElement('section'); root.hidden = true; root.setAttribute('data-signoff-completions',''); opts.host.appendChild(root);
  const add = (tag: string,text: string,host: HTMLElement = root) => {
    const node = doc.createElement(tag); node.textContent = text; host.appendChild(node); return node;
  };
  const button = (text: string,host: HTMLElement = root) => { const node = doc.createElement('button'); node.type = 'button'; node.textContent = text; host.appendChild(node); return node; };
  add('h2','Customer completion');
  add('p','Share a saved delivery summary. Review the customer’s response in Reception Inbox before closing or reopening the task.');
  const message = add('p',''); message.setAttribute('role','status'); message.setAttribute('aria-live','polite');
  const editor = doc.createElement('form'); editor.hidden = true; editor.setAttribute('aria-label','Request customer completion'); root.appendChild(editor);
  const selectedLabel = add('p','',editor);
  const label = add('label','Delivered work shown to the customer',editor);
  const delivery = doc.createElement('textarea'); delivery.name = 'delivery_summary'; delivery.required = true; delivery.maxLength = QUOTE_COMPLETION_SCOPE_MAX; label.appendChild(delivery);
  const expiryLabel = add('label','Completion link life (days)',editor);
  const expiry = doc.createElement('input'); expiry.type = 'number'; expiry.min = '1'; expiry.max = '30'; expiry.step = '1'; expiry.value = '7'; expiry.required = true; expiryLabel.appendChild(expiry);
  const preview = button('Preview completion',editor); preview.type = 'submit'; const close = button('Close completion editor',editor);
  const previewHost = doc.createElement('div'); editor.appendChild(previewHost);
  const shareHost = doc.createElement('div'); root.appendChild(shareHost);
  const filterLabel = add('label','Completion requests');
  const filter = doc.createElement('select'); filter.id = 'recued-completion-filter';
  filterLabel.setAttribute('for',filter.id); root.appendChild(filter);
  for (const [value,text] of [['all','All requests'],['review','Needs owner review']]) { const option = doc.createElement('option'); option.value = value!; option.textContent = text!; filter.appendChild(option); }
  const refresh = button('Refresh completions'); const history = doc.createElement('div'); history.setAttribute('data-completion-history',''); root.appendChild(history);
  const newer = button('Newer completions'); const older = button('Older completions');
  if (opts.editorOnly) [filterLabel,filter,refresh,history,newer,older].forEach(node => { node.hidden = true; });
  let selected: QuoteSignoffSummary | null = null; let prepared: QuoteCompletionPrepareResult | null = null;
  let disposed = false; let busy = false; let loading = false; let started = false; let generation = 0;
  let cursor: string | undefined; let nextCursor: string | undefined; let previous: Array<string | undefined> = [];
  const controls = () => {
    [delivery,expiry,preview,close,filter,refresh].forEach(node => { node.disabled = busy; });
    root.querySelectorAll<HTMLButtonElement>('[data-completion-action]').forEach(node => { node.disabled = busy; });
    newer.disabled = busy || loading || previous.length === 0; older.disabled = busy || loading || !nextCursor;
  };
  const errorText = (error: unknown) => error instanceof Error ? error.message : 'The completion request could not be loaded. Try again.';
  const invalidate = () => { prepared = null; previewHost.replaceChildren(); };
  editor.addEventListener('input',invalidate); editor.addEventListener('change',invalidate);
  type Page = { cursor?: string; previous: Array<string | undefined> };
  let pendingPage: Page | undefined;
  const load = async (page: Page = pendingPage ?? { cursor,previous: [...previous] }) => {
    if (opts.editorOnly) return;
    if (disposed || !started) return;
    const current = ++generation; pendingPage = page; loading = true; controls();
    try {
      const result = await conn('reception.signoff.completion.list',{ limit: 50, ...(page.cursor ? { cursor: page.cursor } : {}), ...(filter.value === 'review' ? { review_only: true } : {}) });
      if (disposed || current !== generation) return;
      cursor = page.cursor; previous = [...page.previous]; pendingPage = undefined;
      nextCursor = result.next_cursor; history.replaceChildren();
      for (const entry of result.completions) {
        const card = doc.createElement('article'); card.setAttribute('data-completion-id',entry.completion_id); history.appendChild(card);
        add('h3',`${entry.quote_label} — ${entry.customer}`,card); add('p',labels[entry.state],card);
        add('p',entry.response.decision === 'accepted' ? 'Customer accepted completion.'
          : entry.response.decision === 'corrections_requested' ? 'Customer requested corrections.'
            : entry.response.decision === 'unavailable' ? 'Customer reply unavailable.' : 'No customer response recorded.',card);
        if (entry.response.corrections) { add('h4','Requested corrections',card); add('pre',entry.response.corrections,card); }
        const details = doc.createElement('details'); card.appendChild(details); add('summary','Completion offered to the customer',details); add('pre',entry.customer_preview,details);
        if (entry.availability !== 'current') add('p',`This request is ${entry.availability}. Prepare a new request before applying work changes.`,card);
        if (entry.owner_action) add('p',`Owner ${entry.owner_action.action === 'close' ? 'closed' : 'reopened'} the work on ${new Date(entry.owner_action.recorded_at).toISOString()}.`,card);
        if (entry.review === 'waiting') { const link = add('a','Review completion in Reception Inbox',card); link.setAttribute('href','#reception/inbox'); }
        else if (entry.review === 'closed') add('p','Owner review ended without applying this completion. Review the run, or prepare a new request.',card);
        else if (entry.review === 'not_queued') add('p','The response is waiting to be queued for owner review.',card);
        else if (entry.review === 'running') add('p','The approved completion review is running.',card);
        if (entry.state === 'waiting' && entry.endpoint_id) { const link = add('a','Manage completion link',card); link.setAttribute('href',`#reception/endpoints/${encodeURIComponent(entry.endpoint_id)}`); }
        if (['draft','publishing','waiting','accepted','corrections_requested'].includes(entry.state)) {
          const cancel = button('Cancel completion request',card); cancel.setAttribute('data-completion-action','');
          cancel.addEventListener('click',async () => {
            if (busy || disposed) return; busy = true; controls();
            try { await conn('reception.signoff.completion.cancel',{ completion_id: entry.completion_id });
              if (disposed) return; if (prepared?.completion.completion_id === entry.completion_id) invalidate();
              message.textContent = 'Completion cancelled. Its link and queued work changes are closed.'; await load(); opts.onChanged();
            } catch (error) { if (!disposed) message.textContent = errorText(error); }
            finally { if (!disposed) { busy = false; controls(); } }
          });
        }
      }
      if (!result.completions.length) add('p',filter.value === 'review' ? 'No completion responses need owner review on this page.' : 'No completion requests yet.',history);
    } catch (error) { if (!disposed && current === generation) message.textContent = errorText(error); }
    finally { if (!disposed && current === generation) { loading = false; controls(); } }
  };
  const open = (offer: QuoteSignoffSummary) => {
    if (disposed || busy) return;
    if (selected && !editor.hidden && delivery.value.trim()) {
      if (selected.signoff_id !== offer.signoff_id) message.textContent = 'Close the current completion editor before choosing another agreement.';
      delivery.focus(); return;
    }
    started = true; root.hidden = false; selected = offer; editor.hidden = false;
    delivery.value = ''; expiry.value = '7'; invalidate(); shareHost.replaceChildren();
    selectedLabel.textContent = `Completion for ${offer.quote_label} — ${offer.customer}. Describe the delivered work; the saved agreement and additions will accompany it.`;
    message.textContent = ''; delivery.focus(); void load();
  };
  close.addEventListener('click',() => { selected = null; editor.hidden = true; delivery.value = ''; invalidate(); });
  editor.addEventListener('submit',async event => {
    event.preventDefault(); if (busy || disposed || !selected || !editor.reportValidity()) return;
    busy = true; controls(); invalidate(); shareHost.replaceChildren();
    try {
      const result = await conn('reception.signoff.completion.prepare',{ signoff_id: selected.signoff_id,delivery_summary: delivery.value,expiry_days: Number(expiry.value) });
      if (disposed) return; prepared = result; add('h3','What the customer will see',previewHost); add('pre',result.customer_preview,previewHost);
      add('p','Customer acceptance will queue closing the task for your review. A corrections request will queue reopening it.',previewHost);
      const publish = button('Publish completion link',previewHost); publish.setAttribute('data-completion-action','');
      publish.addEventListener('click',async () => {
        if (busy || disposed || !prepared) return; const snapshot = prepared; busy = true; controls();
        try {
          const result = await conn('reception.signoff.completion.publish',{ completion_id: snapshot.completion.completion_id,preview_hash: snapshot.preview_hash });
          if (disposed) return; invalidate(); delivery.value = ''; editor.hidden = true; selected = null;
          const shareLabel = add('label','Customer completion link',shareHost); const share = doc.createElement('input'); share.type = 'url'; share.readOnly = true; share.value = result.share_url; shareLabel.appendChild(share); share.addEventListener('focus',() => share.select());
          message.textContent = 'Share this link with your customer. It accepts one completion response.'; await load(); opts.onChanged();
        } catch (error) { if (!disposed) { message.textContent = errorText(error); invalidate(); } }
        finally { if (!disposed) { busy = false; controls(); } }
      });
      message.textContent = 'Review the exact delivery, then publish its link. This replaces earlier pending completion requests for this agreement.'; await load();
    } catch (error) { if (!disposed) message.textContent = errorText(error); }
    finally { if (!disposed) { busy = false; controls(); } }
  });
  filter.addEventListener('change',() => { cursor = undefined; nextCursor = undefined; previous = []; pendingPage = undefined; void load({ previous: [] }); });
  refresh.addEventListener('click',() => { if (!busy) void load(); });
  older.addEventListener('click',() => { if (!busy && !loading && nextCursor) void load({ cursor: nextCursor,previous: [...previous,cursor] }); });
  newer.addEventListener('click',() => { if (!busy && !loading && previous.length) void load({ cursor: previous.at(-1),previous: previous.slice(0,-1) }); });
  controls();
  return { open,update: () => { started = true; root.hidden = false; void load(); },
    hasUnsavedChanges: () => !editor.hidden && delivery.value.trim().length > 0,
    hasInFlightWork: () => busy,
    dispose: () => { disposed = true; generation++; root.remove(); } };
};
