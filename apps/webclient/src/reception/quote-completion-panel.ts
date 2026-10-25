import { receptionInboxTargetAddress } from './navigation.js';
import { QUOTE_COMPLETION_SCOPE_MAX, type QuoteCompletionPrepareResult, type QuoteCompletionSummary,
  type QuoteSignoffSummary } from '@recued/contracts';
import type { QuoteSignoffConn } from './quote-signoff-panel.js';
import type { CustomerCompletionBoardState } from './customer-request-board-state.js';
import { customerRequestExpiry, refreshCustomerRequestExpiries, customerPreviewExpired } from './customer-request-expiry.js';
import { mountCustomerLinkShare } from './customer-link-share.js';
import { focusCustomerWorkspace, restoreCustomerWorkspaceControl } from './customer-workspace-focus.js';
import { appendCustomerCorrections } from './customer-completion-corrections.js';
import { guardCustomerHistoryInteraction } from './customer-history-interaction.js';
import { keepCustomerReplySelection } from './customer-history-selection.js';
import { customerRequestClock, type CustomerRequestClock } from './customer-request-clock.js';
import { mountCustomerPreviewFreshness } from './customer-preview-freshness.js';

const labels: Record<QuoteCompletionSummary['state'],string> = {
  draft: 'Draft', publishing: 'Publishing', waiting: 'Waiting for customer', accepted: 'Reply processed',
  corrections_requested: 'Reply processed', superseded: 'Replaced or changed', cancelled: 'Cancelled',
  closed: 'Owner closed work', reopened: 'Owner reopened work',
};
export const mountQuoteCompletionPanel = (opts: {
  document: Document; host: HTMLElement; conn: QuoteSignoffConn; onChanged: () => void;
  editorOnly?: boolean;reminders?: boolean;
  boardState?: CustomerCompletionBoardState; restoreFocus?: () => boolean;
  onBoardChange?: (interaction?: boolean) => void;
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
  const recoverPublish = button('Resume saved completion preview'); recoverPublish.hidden = true;
  const resumeLocal = button('Resume completion draft'); resumeLocal.hidden = true;
  const editor = doc.createElement('form'); editor.hidden = true; editor.setAttribute('aria-label','Request customer completion'); root.appendChild(editor);
  const selectedLabel = add('p','',editor);
  const label = add('label','Delivered work shown to the customer',editor);
  const delivery = doc.createElement('textarea'); delivery.name = 'delivery_summary'; delivery.required = true; delivery.maxLength = QUOTE_COMPLETION_SCOPE_MAX; label.appendChild(delivery);
  const expiryLabel = add('label','Completion link life (days)',editor);
  const expiry = doc.createElement('input'); expiry.type = 'number'; expiry.min = '1'; expiry.max = '30'; expiry.step = '1'; expiry.value = '7'; expiry.required = true; expiryLabel.appendChild(expiry);
  add('p','Days are counted from preparation. Saved previews keep the deadline shown below.',editor);
  const notice = add('p','Preparing a preview saves this completion request and immediately replaces earlier pending completion requests for this agreement, including a customer response waiting for your review. Their links and queued work changes will stop working.',editor);
  notice.setAttribute('data-completion-replacement-notice',''); notice.className = 'signoff-replacement-notice';
  const preview = button('Prepare completion preview',editor); preview.type = 'submit';
  const close = button('Close completion editor',editor); const discard = button('Discard completion draft',editor);
  const previewHost = doc.createElement('div'); editor.appendChild(previewHost);
  const shareHost = doc.createElement('div'); root.appendChild(shareHost);
  const filterLabel = add('label','Completion requests');
  const filter = doc.createElement('select'); filter.id = 'recued-completion-filter';
  filterLabel.setAttribute('for',filter.id); root.appendChild(filter);
  for (const [value,text] of [['all','All requests'],['review','Needs owner review']]) { const option = doc.createElement('option'); option.value = value!; option.textContent = text!; filter.appendChild(option); }
  filter.value = opts.boardState?.filter ?? 'all';
  const refresh = button('Refresh completions');
  const loadMessage = add('p',''); loadMessage.setAttribute('role','status'); loadMessage.setAttribute('aria-live','polite');
  loadMessage.setAttribute('data-completion-load-status','');
  const history = doc.createElement('div'); history.setAttribute('data-completion-history',''); root.appendChild(history);
  history.setAttribute('role','region'); history.setAttribute('aria-label','Completion request results'); history.setAttribute('aria-busy','false');
  const newer = button('Newer completions'); const older = button('Older completions');
  if (opts.editorOnly) [filterLabel,filter,refresh,loadMessage,history,newer,older].forEach(node => { node.hidden = true; });
  type Agreement = Pick<QuoteSignoffSummary,'signoff_id' | 'quote_label' | 'customer'>;
  let selected: Agreement | null = null; let prepared: QuoteCompletionPrepareResult | null = null;
  let savedDraft: { id: string; terms: string } | undefined;
  const formSnapshot = () => JSON.stringify([selected?.signoff_id,delivery.value,expiry.value]);
  let share: ReturnType<typeof mountCustomerLinkShare> | undefined; let returnFocus: (() => void) | undefined;
  let sharedRequestId: string | undefined;
  let sharedJobId: string | undefined;
  let reviewFreshness: ReturnType<typeof mountCustomerPreviewFreshness>;
  const historyInteraction = guardCustomerHistoryInteraction(doc, history);
  const requestClocks = new Map<string, CustomerRequestClock>();
  let publishRecovery: { id: string; agreementId: string; terms: string; expiresAt: number } | undefined;
  const reconcile = (entry: QuoteCompletionSummary) => {
    if (entry.completion_id === sharedRequestId && (entry.state !== 'waiting' || entry.availability !== 'current' || entry.response.decision !== 'not_recorded')) share?.close();
    if (entry.completion_id === publishRecovery?.id && (entry.state !== 'draft' || entry.availability !== 'current')) publishRecovery = undefined;
  };
  let disposed = false; let busy = false; let loading = false; let started = false; let generation = 0;
  let cursor = opts.boardState?.cursor; let nextCursor: string | undefined; let previous = opts.boardState?.previous ?? [];
  let displayedFilter = filter.value as 'all' | 'review'; let restoring = !!opts.boardState;
  let returnId = opts.boardState?.returnId; let returnAction = opts.boardState?.returnAction;
  const disclosureKey = (node: HTMLElement) => JSON.stringify([node.closest('[data-completion-id]')?.getAttribute('data-completion-id'),node.getAttribute('data-completion-disclosure')]);
  const saveReturn = (event: Event) => {
    const target = (event.target as HTMLElement).closest?.<HTMLElement>('[data-completion-action]');
    if (target) { returnId = target.closest('[data-completion-id]')?.getAttribute('data-completion-id') ?? undefined; returnAction = target.getAttribute('data-completion-action') ?? undefined; }
    opts.onBoardChange?.(true);
  };
  history.addEventListener('click',saveReturn,true); history.addEventListener('focusin',saveReturn);
  history.addEventListener('toggle',() => opts.onBoardChange?.(),true);
  const hasDraft = () => !!selected && (delivery.value.length > 0 || expiry.value !== '7' || prepared !== null);
  const canRecoverPublish = () => !!publishRecovery && publishRecovery.terms === formSnapshot()
    && (requestClocks.get(publishRecovery.id)?.() ?? Date.now()) < publishRecovery.expiresAt;
  const controls = () => {
    root.querySelectorAll<HTMLInputElement>('[data-completion-link-setting]').forEach(node => { node.disabled = busy; });
    [delivery,expiry,preview,close,discard,resumeLocal,recoverPublish,filter,refresh].forEach(node => { node.disabled = busy; });
    recoverPublish.hidden = prepared !== null || !canRecoverPublish();
    root.querySelectorAll<HTMLButtonElement>('[data-completion-action]').forEach(node => { node.disabled = busy || node.getAttribute('data-completion-action') === 'publish' && reviewFreshness?.isExpired() === true; });
    reviewFreshness?.setBusy(busy);
    newer.disabled = busy || loading || previous.length === 0; older.disabled = busy || loading || !nextCursor;
    resumeLocal.hidden = !editor.hidden || !hasDraft();
  };
  const errorText = (error: unknown) => error instanceof Error ? error.message : 'The completion request could not be loaded. Try again.';
  const invalidate = () => { reviewFreshness?.dispose(); reviewFreshness = undefined; prepared = null; previewHost.replaceChildren(); };
  const invalidateTerms = (event: Event) => { if (event.target === delivery || event.target === expiry) { invalidate(); controls(); } };
  editor.addEventListener('input',invalidateTerms); editor.addEventListener('change',invalidateTerms);
  type Page = { cursor?: string; previous: Array<string | undefined> };
  let pendingPage: Page | undefined;
  const load = async (page: Page = pendingPage ?? { cursor,previous: [...previous] }, sourceControl?: HTMLButtonElement) => {
    if (opts.editorOnly || disposed || !started) return;
    const previousActive = doc.activeElement;
    const source = sourceControl ?? [refresh,newer,older].find(node => node === previousActive);
    const current = ++generation; const queryFilter = filter.value as 'all' | 'review'; pendingPage = page; loading = true; controls();
    history.setAttribute('aria-busy','true');
    const loadingText = (queryFilter === 'review' ? 'Loading requests needing owner review…' : 'Loading completion requests…')
      + (history.children.length ? ' Previous results are shown below.' : '');
    // A new status line can move a pressed control even when its node survives.
    void historyInteraction.ready().then(ready => {
      if (ready && !disposed && current === generation && loading) loadMessage.textContent = loadingText;
    });
    try {
      const result = await conn('reception.signoff.completion.list',{ limit: 50, ...(page.cursor ? { cursor: page.cursor } : {}), ...(queryFilter === 'review' ? { review_only: true } : {}) });
      if (disposed || current !== generation) return;
      const readClock = Number.isSafeInteger(result.server_now) ? customerRequestClock(doc,result.server_now) : undefined;
      result.completions.forEach(reconcile);
      if (!await historyInteraction.ready() || disposed || current !== generation) return;
      const key = (node: HTMLElement) => JSON.stringify([node.closest('[data-completion-id]')?.getAttribute('data-completion-id'), node.getAttribute('data-completion-action')]);
      const focused = [...history.querySelectorAll<HTMLElement>('[data-completion-action]')].find(node => node === doc.activeElement);
      const focusKey = focused ? key(focused) : undefined;
      const expanded = new Set(restoring ? opts.boardState?.expanded : [...history.querySelectorAll<HTMLDetailsElement>('details[open]')].map(disclosureKey));
      const pane = root.closest?.<HTMLElement>('[data-recued-webclient-content]'); const scrollTop = pane?.scrollTop;
      cursor = page.cursor; previous = [...page.previous]; displayedFilter = queryFilter; pendingPage = undefined;
      const restoreReplySelection = keepCustomerReplySelection(doc,history,'data-completion-id');
      nextCursor = result.next_cursor; history.replaceChildren();
      for (const entry of result.completions) {
        if (readClock) requestClocks.set(entry.completion_id,readClock);
        const card = doc.createElement('article'); card.setAttribute('data-completion-id',entry.completion_id); history.appendChild(card);
        add('h3',`${entry.quote_label} — ${entry.customer}`,card); add('p',labels[entry.state],card);
        add('p',entry.response.decision === 'accepted' ? 'Customer accepted completion.'
          : entry.response.decision === 'corrections_requested' ? 'Customer requested corrections.'
            : entry.response.decision === 'unavailable' ? 'Customer reply unavailable.' : 'No customer response recorded.',card);
        if (['draft','publishing','waiting','accepted','corrections_requested'].includes(entry.state)) card.appendChild(customerRequestExpiry(doc,entry.expires_at,requestClocks.get(entry.completion_id)));
        if (entry.review === 'waiting') {
          const link = add('a','Review completion in Reception Inbox',card); link.className = 'signoff-primary'; link.setAttribute('href',receptionInboxTargetAddress(entry.completion_id));
        }
        if (entry.response.corrections) {
          const reply = appendCustomerCorrections(doc,card,entry.response.corrections); reply.summary.setAttribute('data-completion-correction-summary','');
          if (reply.details) { reply.details.setAttribute('data-completion-disclosure','corrections'); reply.details.open = expanded.has(disclosureKey(reply.details)); }
        }
        const details = doc.createElement('details'); details.setAttribute('data-completion-disclosure','terms'); card.appendChild(details); details.open = expanded.has(disclosureKey(details));
        add('summary','Completion offered to the customer',details); add('pre',entry.customer_preview,details);
        if (entry.availability !== 'current') add('p',`This request is ${entry.availability}. Prepare a new request before applying work changes.`,card);
        if (entry.owner_action) add('p',`Owner ${entry.owner_action.action === 'close' ? 'closed' : 'reopened'} the work on ${new Date(entry.owner_action.recorded_at).toISOString()}.`,card);
        if (entry.review === 'closed') add('p','Owner review ended without applying this completion. Review the run, or prepare a new request.',card);
        else if (entry.review === 'not_queued') add('p','The response is waiting to be queued for owner review.',card);
        else if (entry.review === 'running') add('p','The approved completion review is running.',card);
        if (entry.state === 'waiting' && entry.endpoint_id) { const link = add('a','Manage completion link',card); link.setAttribute('href',`#reception/endpoints/${encodeURIComponent(entry.endpoint_id)}`); }
        if (entry.state === 'draft' && entry.availability === 'current') {
          const resume = button('Resume completion preview',card); resume.setAttribute('data-completion-action','resume');
          resume.addEventListener('click',() => { void resumeSaved(entry.completion_id,undefined,() => {
            const target = [...history.querySelectorAll<HTMLElement>('[data-completion-action]')].find(node => node.closest('[data-completion-id]')?.getAttribute('data-completion-id') === entry.completion_id && node.textContent === 'Resume completion preview'); (target ?? refresh).focus();
          }); });
        }
        if (['draft','publishing','waiting','accepted','corrections_requested'].includes(entry.state)) {
          const cancel = button('Cancel completion request',card); cancel.setAttribute('data-completion-action','cancel');
          cancel.addEventListener('click',async () => {
            if (busy || disposed) return; const previousActive = doc.activeElement; busy = true; controls(); share?.checking();
            try { await conn('reception.signoff.completion.cancel',{ completion_id: entry.completion_id });
              if (disposed) return; if (prepared?.completion.completion_id === entry.completion_id) invalidate();
              message.textContent = 'Completion cancelled. Its link and queued work changes are closed.'; opts.onChanged();
            } catch (error) { if (!disposed) message.textContent = errorText(error); }
            finally { if (!disposed) { await share?.check(); if (!disposed) await load(); if (!disposed) {
              busy = false; controls();
              const card = [...history.querySelectorAll<HTMLElement>('[data-completion-id]')]
                .find(node => node.getAttribute('data-completion-id') === entry.completion_id);
              const target = card?.querySelector<HTMLElement>('[data-completion-action="Cancel completion request"]') ?? card?.querySelector<HTMLElement>('summary');
              restoreCustomerWorkspaceControl(doc,cancel,target ? [target,refresh] : [refresh],previousActive);
            } } }
          });
        }
        for (const node of card.querySelectorAll<HTMLElement>('button,a,summary')) node.setAttribute('data-completion-action',node.getAttribute('href') ?? node.textContent ?? '');
      }
      if (!result.completions.length) add('p',filter.value === 'review' ? 'No completion responses need owner review on this page.' : 'No completion requests yet.',history);
      if (focusKey) ([...history.querySelectorAll<HTMLElement>('[data-completion-action]')].find(node => key(node) === focusKey) ?? refresh).focus({ preventScroll: true });
      if (restoring) {
        restoring = false;
        if (opts.restoreFocus?.()) {
          const target = [...history.querySelectorAll<HTMLElement>('[data-completion-action]')].find(node => node.closest('[data-completion-id]')?.getAttribute('data-completion-id') === returnId && node.getAttribute('data-completion-action') === returnAction);
          (target ?? refresh).focus({ preventScroll: true });
        }
      }
      restoreReplySelection?.();
      if (pane && scrollTop !== undefined) pane.scrollTop = scrollTop;
      loadMessage.textContent = '';
      opts.onBoardChange?.();
    } catch (error) {
      if (!disposed && current === generation && await historyInteraction.ready() && !disposed && current === generation) {
        const retained = history.children.length && displayedFilter !== queryFilter ? ` Previous results for ${displayedFilter === 'review' ? 'Needs owner review' : 'All requests'} are shown below.` : '';
        loadMessage.textContent = errorText(error) + retained;
      }
    }
    finally { if (!disposed && current === generation) { loading = false; history.setAttribute('aria-busy','false'); controls(); restoreCustomerWorkspaceControl(doc,source ?? null,[refresh],previousActive); } }
  };
  const describeSelection = () => { selectedLabel.textContent = selected ? `Completion for ${selected.quote_label} — ${selected.customer}. Describe the delivered work; the saved agreement and additions will accompany it.` : ''; };
  const resumeSaved = async (completionId: string, agreementId?: string, onReturn?: () => void) => {
    if (busy || disposed) return;
    const ownUnchangedDraft = savedDraft?.id === completionId && savedDraft.terms === formSnapshot();
    if (hasDraft() && !ownUnchangedDraft) { editor.hidden = false; message.textContent = 'Finish or discard the current completion draft before resuming another preview.'; delivery.focus(); controls(); return; }
    const keepPreview = ownUnchangedDraft && prepared?.completion.completion_id === completionId;
    if (keepPreview && reviewFreshness?.customerExpired()) { focusCustomerWorkspace(reviewFreshness.element); return; }
    const rememberLink = keepPreview && previewHost.querySelector<HTMLInputElement>('[data-completion-link-setting]')?.checked === true;
    let refreshFailed = false;
    started = true; root.hidden = false; busy = true; controls(); if (keepPreview) reviewFreshness?.invalidateReview(); else invalidate();
    try {
      const saved = await conn('reception.signoff.completion.resume',{ completion_id: completionId });
      if (disposed) return;
      if (saved.completion.completion_id !== completionId || agreementId && saved.completion.signoff_id !== agreementId) throw new Error('This completion no longer matches the selected agreement. Refresh the job before continuing.');
      selected = saved.completion; delivery.value = saved.completion.delivery_summary; expiry.value = String(saved.expiry_days);
      returnFocus = onReturn; editor.hidden = false; describeSelection(); showPrepared(saved,rememberLink);
    } catch (error) { if (!disposed) { message.textContent = errorText(error); if (keepPreview) { refreshFailed = true; reviewFreshness?.failed(); } } }
    finally { if (!disposed) { busy = false; controls(); focusCustomerWorkspace(refreshFailed && reviewFreshness ? reviewFreshness.element : prepared ? previewHost : message); } }
  };
  const open = (offer: QuoteSignoffSummary, onReturn?: () => void) => {
    if (disposed || busy) return;
    if (hasDraft()) {
      editor.hidden = false;
      if (selected!.signoff_id !== offer.signoff_id) message.textContent = 'Finish or discard the current completion draft before choosing another agreement.';
      delivery.focus(); controls(); return;
    }
    started = true; root.hidden = false; selected = offer; returnFocus = onReturn; editor.hidden = false;
    delivery.value = ''; expiry.value = '7'; invalidate(); savedDraft = undefined; describeSelection();
    message.textContent = ''; delivery.focus(); controls(); void load();
  };
  close.addEventListener('click',() => { editor.hidden = true; message.textContent = hasDraft() ? 'Completion draft kept in this view. Resume it or discard it explicitly.' : ''; controls(); returnFocus?.(); });
  recoverPublish.addEventListener('click',() => {
    const recovery = publishRecovery;
    if (busy || disposed || !recovery || !canRecoverPublish()) return;
    void resumeSaved(recovery.id,recovery.agreementId,returnFocus);
  });
  resumeLocal.addEventListener('click',() => { if (!busy && !disposed) { editor.hidden = false; controls(); delivery.focus(); } });
  discard.addEventListener('click',() => {
    if (busy || disposed) return;
    selected = null; delivery.value = ''; expiry.value = '7'; invalidate(); savedDraft = undefined; publishRecovery = undefined; editor.hidden = true; controls();
    message.textContent = 'Completion draft fields discarded. Prepared requests remain in completion history.'; returnFocus?.();
  });
  const showPrepared = (result: QuoteCompletionPrepareResult,rememberLink = false) => {
    publishRecovery = undefined;
    reviewFreshness?.dispose(); reviewFreshness = undefined;
    prepared = result; savedDraft = { id: result.completion.completion_id, terms: formSnapshot() }; previewHost.replaceChildren(); add('h3','What the customer will see',previewHost);
    const clock = customerRequestClock(doc,result.preview_server_now); requestClocks.set(result.completion.completion_id,clock);
    previewHost.appendChild(customerRequestExpiry(doc,result.completion.expires_at,clock)); add('pre',result.customer_preview,previewHost);
    add('p','Customer acceptance will queue closing the task for your review. A corrections request will queue reopening it.',previewHost);
    const keepLink = doc.createElement('input'); keepLink.type = 'checkbox'; keepLink.setAttribute('data-completion-link-setting','');
    keepLink.checked = rememberLink;
    if (opts.reminders) add('label','Save this link for follow-up emails',previewHost).appendChild(keepLink);
    reviewFreshness = mountCustomerPreviewFreshness({ document: doc,host: previewHost,expiresAt: result.preview_expires_at,serverNow: result.preview_server_now,customerExpiresAt: result.completion.expires_at,clock,
      refreshLabel: 'Refresh completion preview',onExpire: controls,onRefresh: () => { void resumeSaved(result.completion.completion_id,result.completion.signoff_id,returnFocus); } });
    const publish = button('Publish completion link',previewHost); publish.setAttribute('data-completion-action','publish'); controls();
    publish.addEventListener('click',async () => {
      if (busy || disposed || !prepared || reviewFreshness?.isExpired()) return; const snapshot = prepared; busy = true; controls();
      let published = false;
      try {
        const result = await conn('reception.signoff.completion.publish',{ completion_id: snapshot.completion.completion_id,preview_hash: snapshot.preview_hash,
          ...(opts.reminders && keepLink.checked ? { remember_link_for_reminders: true } : {}) });
        if (disposed) return; invalidate(); delivery.value = ''; expiry.value = '7'; editor.hidden = true; selected = null; savedDraft = undefined;
        share?.dispose(); sharedRequestId = result.completion.completion_id; sharedJobId = result.completion.root_signoff_id; share = mountCustomerLinkShare({ document: doc,host: shareHost,label: 'Customer completion link',heading: 'Completion link ready',
          url: result.share_url,expiresAt: result.completion.expires_at,now: requestClocks.get(result.completion.completion_id),
          customer: result.completion.customer,quoteLabel: result.completion.quote_label,
          check: async () => (await conn('reception.signoff.link.check',{ kind: 'completion',request_id: result.completion.completion_id,share_url: result.share_url })).current });
        published = true; message.textContent = 'Share this link with your customer. It accepts one completion response.'; await load(); opts.onChanged();
      } catch (error) { if (!disposed) {
        publishRecovery = { id: snapshot.completion.completion_id,agreementId: snapshot.completion.signoff_id,terms: formSnapshot(),expiresAt: snapshot.completion.expires_at };
        message.textContent = customerPreviewExpired(error)
          ? 'This preview expired. Choose Resume saved completion preview to review and publish the same saved request.'
          : `${errorText(error)} If the request is still a draft, choose Resume saved completion preview to try again.`;
        invalidate(); await load();
      } }
      finally { if (!disposed) { busy = false; controls(); focusCustomerWorkspace(published ? shareHost : message); } }
    });
    message.textContent = 'Saved completion preview ready. Review the exact delivery, then publish its link. Its expiry is unchanged.';
  };
  editor.addEventListener('submit',async event => {
    event.preventDefault(); if (busy || disposed || !selected || !editor.reportValidity()) return;
    busy = true; publishRecovery = undefined; controls(); invalidate(); share?.checking(); let saved = false;
    try {
      const result = await conn('reception.signoff.completion.prepare',{ signoff_id: selected.signoff_id,delivery_summary: delivery.value,expiry_days: Number(expiry.value) });
      if (disposed) return; saved = true; showPrepared(result);
      message.textContent = 'Completion preview prepared. Earlier pending completion requests have been replaced. Review the saved delivery, then publish its link.'; await load();
    } catch (error) { if (!disposed) { message.textContent = errorText(error); await load(); } }
    finally { await share?.check(); if (!disposed) { busy = false; controls(); if (saved) opts.onChanged(); if (prepared && previewHost.isConnected) focusCustomerWorkspace(previewHost); } }
  });
  filter.addEventListener('change',() => { pendingPage = undefined; opts.onBoardChange?.(true); void load({ previous: [] }); });
  refresh.addEventListener('click',() => { if (!busy) void load(undefined,refresh); });
  older.addEventListener('click',() => { if (!busy && !loading && nextCursor) void load({ cursor: nextCursor,previous: [...previous,cursor] },older); });
  newer.addEventListener('click',() => { if (!busy && !loading && previous.length) void load({ cursor: previous.at(-1),previous: previous.slice(0,-1) },newer); });
  controls();
  return { open,resume: resumeSaved,update: () => { refreshCustomerRequestExpiries(root); started = true; root.hidden = false; return load(); },
    reconcileJob: (jobId: string,latest: QuoteCompletionSummary | null) => {
      if (jobId !== sharedJobId) return;
      if (!latest || latest.completion_id !== sharedRequestId) share?.close(); else reconcile(latest);
    },
    getBoardState: (): CustomerCompletionBoardState => ({ filter: displayedFilter,cursor,previous: [...previous],returnId,returnAction,
      expanded: restoring ? [...opts.boardState!.expanded] : [...history.querySelectorAll<HTMLDetailsElement>('details[open]')].map(disclosureKey) }),
    hasUnsavedChanges: hasDraft, hasInFlightWork: () => busy,
    dispose: () => { disposed = true; generation++; historyInteraction.dispose(); reviewFreshness?.dispose(); share?.dispose(); root.remove(); } };
};
