import type { QuoteSignoffReceipt, QuoteSignoffReceiptEntry, QuoteSignoffState, QuoteCompletionReceiptEntry } from '@recued/contracts';

const states: Record<QuoteSignoffState, string> = {
  draft: 'Draft', publishing: 'Publishing', waiting: 'Request not released', accepted: 'Reply processed',
  rejected: 'Reply processed', superseded: 'Superseded', cancelled: 'Cancelled', released: 'Work and invoice released',
};
const stamp = (value: number): string => new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC');
const escape = (value: string): string => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const heading = (entry: QuoteSignoffReceiptEntry) => entry.revision === 0 ? 'Original offer' : `Added work ${entry.revision}`;
const offerHeading = (entry: QuoteSignoffReceiptEntry) => entry.offer_text_source === 'saved'
  ? 'Offered terms' : 'Offered terms (rebuilt from saved terms)';
const responseText = (entry: QuoteSignoffReceiptEntry): string => {
  const reply = entry.response;
  const label = reply.decision === 'accepted' ? 'Customer accepted' : reply.decision === 'declined' ? 'Customer declined'
    : reply.decision === 'not_recorded' ? 'No customer reply recorded' : 'Customer reply unavailable';
  return label + (reply.received_at === null ? '' : ` · received ${stamp(reply.received_at)}`)
    + (reply.recorded_at === null ? '' : ` · processed ${stamp(reply.recorded_at)}`);
};
const lines = (entry: QuoteSignoffReceiptEntry): string[] => [
  `${entry.business_name} · ${entry.customer}`,
  `Quote ${entry.quote_reference || entry.quote_label} · revision ${entry.quote_revision}`,
  `${states[entry.state]} · ${entry.amount} ${entry.currency} total`,
  `Net ${entry.net} · VAT included ${entry.vat_amount} ${entry.currency}`,
  `Prepared ${stamp(entry.prepared_at)} · link expires ${stamp(entry.expires_at)}`,
  responseText(entry),
  entry.release === null ? 'Owner release not recorded'
    : `Owner released work and invoice ${entry.release.invoice_ref} · ${stamp(entry.release.recorded_at)}`,
  ...(entry.release === null ? [] : [`Invoice dated ${entry.release.issued_on} · due ${entry.release.due_on}`]),
  `Request reference: ${entry.signoff_id}`,
];

const completionLines = (entry: QuoteCompletionReceiptEntry): string[] => [
  `${entry.business_name} · ${entry.customer}`,
  `Prepared ${stamp(entry.created_at)} · link expires ${stamp(entry.expires_at)}`,
  (entry.response.decision === 'accepted' ? 'Customer accepted completion'
    : entry.response.decision === 'corrections_requested' ? 'Customer requested corrections'
      : entry.response.decision === 'unavailable' ? 'Customer completion reply unavailable' : 'No customer completion reply recorded')
    + (entry.response.received_at === null ? '' : ` · received ${stamp(entry.response.received_at)}`)
    + (entry.response.recorded_at === null ? '' : ` · processed ${stamp(entry.response.recorded_at)}`),
  entry.owner_action === null ? 'Owner completion action not recorded'
    : `Owner ${entry.owner_action.action === 'close' ? 'closed' : 'reopened'} work · ${stamp(entry.owner_action.recorded_at)}`,
  ...(entry.state === 'cancelled' ? ['Completion request cancelled'] : entry.state === 'superseded' ? ['Completion request replaced or changed'] : []),
  `Completion reference: ${entry.completion_id}`,
];

/** Static offline document. All saved text is escaped, with no scripts, links,
 * external resources or raw server objects embedded into the customer copy. */
export const signoffReceiptHtml = (receipt: QuoteSignoffReceipt): string => {
  const sections = receipt.requests.map(entry => `<section><h2>${escape(heading(entry))}</h2>
    ${lines(entry).map(line => `<p>${escape(line)}</p>`).join('\n')}
    <h3>${offerHeading(entry)}</h3><pre>${escape(entry.customer_preview)}</pre></section>`).join('\n');
  const completions = (receipt.completions ?? []).map(entry => `<section><h2>Delivery completion</h2>
    ${completionLines(entry).map(line => `<p>${escape(line)}</p>`).join('\n')}
    <h3>Completion offered to the customer</h3><pre>${escape(entry.customer_preview)}</pre></section>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Customer sign-off receipt</title>
<style>
  body { font:16px/1.5 system-ui,sans-serif; color:#17212b; background:white; max-width:850px; margin:32px auto; padding:0 24px; }
  h1,h2,h3 { line-height:1.2; } p { margin:8px 0; overflow-wrap:anywhere; }
  section { border-top:1px solid #bbb; padding:20px 0; }
  pre { font:inherit; white-space:pre-wrap; overflow-wrap:anywhere; }
  @media print { body { margin:0; padding:0; } h2,h3 { break-after:avoid; } }
</style></head><body><h1>Customer sign-off receipt</h1>
<p>Snapshot captured ${escape(stamp(receipt.captured_at))}.</p>
<p>Customer replies and owner releases are recorded separately.</p>
${sections}${completions}</body></html>`;
};

const downloadHtml = (doc: Document, host: HTMLElement, filename: string, html: string): void => {
  const view = doc.defaultView;
  if (!view || typeof view.URL?.createObjectURL !== 'function') throw new Error('Downloads are unavailable in this browser.');
  const url = view.URL.createObjectURL(new view.Blob([html], { type: 'text/html;charset=utf-8' }));
  const link = doc.createElement('a');
  try {
    link.href = url; link.download = filename; link.hidden = true; host.appendChild(link); link.click();
  } finally { link.remove(); view.setTimeout(() => view.URL.revokeObjectURL(url), 1_000); }
};

export const mountQuoteSignoffReceipt = (opts: {
  document: Document; host: HTMLElement;
  read: (id: string) => Promise<QuoteSignoffReceipt>;
  returnFocus: (id: string) => void;
}) => {
  const doc = opts.document;
  const root = doc.createElement('section'); root.hidden = true;
  root.setAttribute('data-signoff-receipt', ''); root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Sign-off receipt'); root.tabIndex = -1; opts.host.appendChild(root);
  const add = (tag: string, text: string, host: HTMLElement = root) => {
    const node = doc.createElement(tag); node.textContent = text; host.appendChild(node); return node;
  };
  add('h2', 'Customer sign-off receipt');
  const message = add('p', ''); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const actions = doc.createElement('div'); actions.className = 'signoff-actions'; root.appendChild(actions);
  const button = (label: string) => {
    const node = doc.createElement('button'); node.type = 'button'; node.textContent = label; actions.appendChild(node); return node;
  };
  const print = button('Print / save PDF'); const download = button('Download receipt');
  const refresh = button('Refresh receipt'); const close = button('Close receipt');
  const content = doc.createElement('div'); content.setAttribute('data-signoff-receipt-requests', ''); root.appendChild(content);
  let receipt: QuoteSignoffReceipt | null = null; let selected = ''; let generation = 0; let disposed = false;
  let printFrame: HTMLIFrameElement | null = null; let printTimer: ReturnType<typeof setTimeout> | undefined;
  const clearPrint = () => { if (printTimer !== undefined) clearTimeout(printTimer); printTimer = undefined; printFrame?.remove(); printFrame = null; };
  const enabled = () => { download.disabled = receipt === null; print.disabled = receipt === null || printFrame !== null; };
  const open = async (id: string) => {
    if (disposed) return;
    const current = ++generation; selected = id; receipt = null; clearPrint(); enabled();
    root.hidden = false; content.replaceChildren(); message.textContent = 'Loading receipt…'; refresh.disabled = true; root.focus();
    try {
      const result = await opts.read(id);
      if (disposed || current !== generation) return;
      if (result.format !== 'recued.customer-signoff-receipt' || (result.version !== 1 && result.version !== 2)) {
        throw new Error('This receipt format is not supported. Update Recued and try again.');
      }
      if (result.selected_signoff_id !== id || result.requests.at(-1)?.signoff_id !== id || result.requests.length === 0) {
        throw new Error('This receipt does not match the selected request.');
      }
      if (result.version === 2 && (!Array.isArray(result.completions) || result.completions.length === 0)
        || result.version === 1 && result.completions?.length
        || result.completions?.some(entry => entry.root_signoff_id !== result.root_signoff_id
          || !result.requests.some(request => request.signoff_id === entry.signoff_id))) {
        throw new Error('The completion receipt does not match the selected agreement.');
      }
      // Format before enabling either action, so invalid timestamps cannot produce a partial export.
      signoffReceiptHtml(result);
      receipt = result;
      message.textContent = `Snapshot captured ${stamp(result.captured_at)}. Customer replies and owner releases are recorded separately.`;
      for (const entry of result.requests) {
        const article = doc.createElement('article'); content.appendChild(article);
        add('h3', heading(entry), article); lines(entry).forEach(line => add('p', line, article));
        const details = doc.createElement('details'); details.open = true; article.appendChild(details);
        add('summary', offerHeading(entry), details); add('pre', entry.customer_preview, details);
      }
      for (const entry of result.completions ?? []) {
        const article = doc.createElement('article'); content.appendChild(article);
        add('h3','Delivery completion',article); completionLines(entry).forEach(line => add('p',line,article));
        add('pre',entry.customer_preview,article);
      }
    } catch (error) {
      if (!disposed && current === generation) message.textContent = error instanceof Error ? error.message : 'Could not load this receipt. Try again.';
    } finally { if (!disposed && current === generation) { refresh.disabled = false; enabled(); } }
  };
  const closeReceipt = () => {
    generation++; receipt = null; clearPrint(); root.hidden = true; content.replaceChildren(); enabled(); opts.returnFocus(selected);
  };
  close.addEventListener('click', closeReceipt);
  root.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeReceipt(); } });
  refresh.addEventListener('click', () => { if (!disposed && !refresh.disabled) void open(selected); });
  download.addEventListener('click', () => {
    if (!receipt || disposed) return;
    try { downloadHtml(doc, root, `signoff-${receipt.selected_signoff_id}.html`, signoffReceiptHtml(receipt)); }
    catch (error) { message.textContent = error instanceof Error ? error.message : 'Could not download the receipt.'; }
  });
  print.addEventListener('click', () => {
    if (!receipt || disposed || printFrame) return;
    const frame = doc.createElement('iframe'); printFrame = frame; enabled();
    frame.setAttribute('data-signoff-receipt-print', ''); frame.title = 'Receipt print view';
    frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;bottom:0;left:0;';
    frame.addEventListener('load', () => {
      if (disposed || printFrame !== frame) return;
      const view = frame.contentWindow;
      if (!view) { clearPrint(); enabled(); message.textContent = 'Printing is unavailable in this browser.'; return; }
      if (printTimer !== undefined) clearTimeout(printTimer);
      printTimer = undefined;
      view.addEventListener('afterprint', () => { if (printFrame === frame) { clearPrint(); enabled(); } }, { once: true });
      try { view.focus(); view.print(); }
      catch { clearPrint(); enabled(); message.textContent = 'Could not print. Download the receipt and print it from your browser.'; }
    });
    printTimer = setTimeout(() => { if (printFrame === frame) { clearPrint(); enabled(); message.textContent = 'The print view could not load. Try again.'; } }, 10_000);
    frame.srcdoc = signoffReceiptHtml(receipt); root.appendChild(frame);
  });
  enabled();
  return { open, dispose: () => { disposed = true; generation++; clearPrint(); receipt = null; root.remove(); } };
};
